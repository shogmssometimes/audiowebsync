# Audio Sync Countdown

A tiny static web app that lets one person ("director") arm a 10-second
countdown that fires an audible sync tone (and screen flash) at the exact
same instant on every open browser/device — useful as a clapperboard-style
audio sync reference for multi-camera/multi-recorder shoots.

## How it stays accurate

1. **Clock sync, not signal timing.** Every open page continuously syncs its
   clock against Firebase's server clock via `.info/serverTimeOffset`. This
   corrects for local device clock drift, similar in spirit to NTP.
2. **Future timestamp, not a "play now" push.** Clicking **Arm Countdown**
   computes `target = syncedNow() + 10s` and writes just that timestamp to
   Firebase Realtime Database. Every connected browser (including the
   director's) is listening for that value.
3. **Each device counts down independently** against its own synced clock —
   normal network delivery latency for the timestamp itself (milliseconds to
   low seconds) doesn't matter, because it only has to arrive before the
   10-second window elapses.
4. **The tone is pre-scheduled on the Web Audio hardware clock**
   (`AudioContext.currentTime`) as soon as the target is known, so it isn't
   subject to UI thread/`requestAnimationFrame` jitter or background-tab
   throttling — only the on-screen number display uses `rAF`/`setTimeout`
   for visual feedback.

## Files

- `index.html` — page markup
- `styles.css` — styling
- `firebase-config.js` — public Firebase client config (safe to commit —
  these are client identifiers, not secrets; access is controlled by
  Realtime Database security rules, not by hiding this file)
- `app.js` — all the sync/countdown/audio logic

## Using it

1. Open the deployed page on every device you want to sync.
2. On **each** device, tap **"🔈 Enable Sound"** once (required by browser
   autoplay policies — without this, that device's tone may be silently
   blocked).
3. Have one person (the "director") click **"Arm Countdown (10s)"**. All open
   pages — including other tabs/devices that never clicked anything — will
   count down and play the tone at the same instant.
4. **"Test Tone"** plays an immediate local tone to check your volume/output
   device without affecting the shared countdown.

## Deploying to GitHub Pages

```bash
cd "/Users/sho/Desktop/WEB SYNC"
git init
git add .
git commit -m "Audio sync countdown"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then in the GitHub repo: **Settings → Pages → Source: Deploy from branch →
Branch: main / (root)**. Your site will be live at
`https://<your-username>.github.io/<your-repo>/`.

## Important: tighten Firebase security rules

The Realtime Database was created in **test mode**, which allows anyone with
your database URL to read/write the *entire* database, and automatically
locks down (denies all access) after **30 days**. Since this app only needs
one small path (`/syncSession`), go to **Firebase Console → Realtime
Database → Rules** before the 30 days are up and replace the rules with:

```json
{
  "rules": {
    "syncSession": {
      ".read": true,
      ".write": true
    },
    "$other": {
      ".read": false,
      ".write": false
    }
  }
}
```

This keeps the app working indefinitely while preventing reads/writes to
anything outside the one path it uses. (Write access to `/syncSession` is
still open to anyone with the URL, so only share the deployed page link with
people you trust not to spam-arm the countdown — there's no sensitive data at
stake either way.)
