/* global firebase, firebaseConfig */

const COUNTDOWN_SECONDS = 10; // fixed, non-variable
const SESSION_PATH = "syncSession";

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---- Elements ----
const numberEl = document.getElementById("number");
const statusEl = document.getElementById("status");
const armBtn = document.getElementById("armBtn");
const testToneBtn = document.getElementById("testToneBtn");
const flashEl = document.getElementById("flash");
const clockStateEl = document.getElementById("clockState");
const volumeInput = document.getElementById("volume");
const timecodeEl = document.getElementById("timecode");

// ---- Clock sync (Firebase server-time offset) ----
// offsetMs = (true server time) - (this device's Date.now())
let offsetMs = 0;
let clockSynced = false;

db.ref(".info/serverTimeOffset").on("value", (snap) => {
  offsetMs = snap.val() || 0;
  clockSynced = true;
  clockStateEl.textContent = `Clock synced (offset ${offsetMs.toFixed(0)} ms)`;
});

function syncedNow() {
  return Date.now() + offsetMs;
}

// ---- Audio ----
let audioCtx = null;

function unlockAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

// Sound is mandatory, so unlock the audio context automatically on the very
// first user interaction with the page (browsers require a user gesture
// before audio can play; there is no way around this without one). This
// covers people who open the page but click something other than "Arm".
["pointerdown", "keydown", "touchstart"].forEach((evt) => {
  document.addEventListener(
    evt,
    () => {
      unlockAudio();
    },
    { once: true, passive: true }
  );
});

function formatTimecode(ms) {
  const d = new Date(ms);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Schedules a short sync tone so it starts at an exact future instant,
// measured against the audio hardware clock (sub-millisecond accuracy),
// independent of UI frame timing (rAF/setTimeout jitter).
//
// The tone combines a low and a high frequency simultaneously (rather than
// one mid-range sine) so it's tonally and visually distinct: it sits outside
// the frequency range where dialog/room tone lives (roughly 300Hz-3kHz), so
// it won't get masked, and the superposition of a slow low-frequency wave
// with a fast high-frequency one produces a very recognizable, non-generic
// shape when you look at the waveform in editing software.
function scheduleTone(
  delaySeconds,
  { lowFrequency = 60, highFrequency = 9000, duration = 0.2 } = {}
) {
  const ctx = unlockAudio();
  const startAt = ctx.currentTime + Math.max(0, delaySeconds);
  const volume = parseFloat(volumeInput.value || "0.8");

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.005);
  gain.gain.setValueAtTime(volume, startAt + duration - 0.02);
  gain.gain.linearRampToValueAtTime(0, startAt + duration);
  gain.connect(ctx.destination);

  // Split the tone's energy between the two oscillators so the combined
  // peak level is similar to a single-tone version at the same volume.
  [lowFrequency, highFrequency].forEach((freq) => {
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    oscGain.gain.value = 0.5;
    osc.connect(oscGain);
    oscGain.connect(gain);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.05);
  });

  return startAt;
}

function flashScreen() {
  flashEl.classList.add("active");
  setTimeout(() => flashEl.classList.remove("active"), 150);
}

// ---- Countdown engine ----
let rafId = null;
let armedTarget = null; // epoch ms (synced clock) this device is currently counting down to
let toneArmedForTarget = null;

function startCountdownTo(targetMs) {
  if (rafId) {
    cancelAnimationFrame(rafId);
    clearTimeout(rafId);
  }
  // Only reset the "has the tone been scheduled" flag when this is actually
  // a new target; a visibility-driven re-entry for the same target must not
  // cause the tone to be scheduled twice.
  if (armedTarget !== targetMs) {
    toneArmedForTarget = null;
  }
  armedTarget = targetMs;
  statusEl.textContent = "Armed — counting down";
  timecodeEl.textContent = "";
  armBtn.disabled = true;

  // Pre-schedule the tone against the audio hardware clock as soon as we
  // know the target, so delivery latency of this message doesn't matter.
  const scheduleNow = () => {
    const remainingSec = (targetMs - syncedNow()) / 1000;
    if (toneArmedForTarget !== targetMs && remainingSec <= 5) {
      // (Re)confirm scheduling once we're close enough that hardware clock
      // drift since arming is negligible.
      scheduleTone(remainingSec);
      toneArmedForTarget = targetMs;
    }
  };

  function tick() {
    const remainingMs = targetMs - syncedNow();
    scheduleNow();

    if (remainingMs <= 0) {
      numberEl.textContent = "0";
      numberEl.classList.add("zero");
      flashScreen();
      statusEl.textContent = "Tone played";
      timecodeEl.textContent = `Synced at ${formatTimecode(syncedNow())}`;
      armBtn.disabled = false;
      rafId = null;
      return;
    }

    const secondsLeft = Math.ceil(remainingMs / 1000);
    numberEl.textContent = String(Math.min(COUNTDOWN_SECONDS, secondsLeft));
    numberEl.classList.remove("zero");

    // requestAnimationFrame is throttled/paused in background tabs, so the
    // on-screen number can freeze there. setTimeout is also clamped in
    // background tabs but keeps the display (loosely) updating; the tone
    // itself is unaffected either way since it was already scheduled above
    // against the independent Web Audio hardware clock.
    if (document.visibilityState === "visible") {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = setTimeout(tick, 200);
    }
  }

  tick();
}

// When a backgrounded tab regains focus, immediately resync the displayed
// number instead of waiting for the throttled loop to catch up.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && armedTarget !== null) {
    if (rafId) {
      clearTimeout(rafId);
      cancelAnimationFrame(rafId);
    }
    startCountdownTo(armedTarget);
  }
});

// If the tone never got a chance to pre-schedule early (e.g. very short
// remaining time when joining mid-countdown), make sure it still fires.
function ensureToneScheduled(targetMs) {
  if (toneArmedForTarget === targetMs) return;
  const remainingSec = (targetMs - syncedNow()) / 1000;
  if (remainingSec > 0) {
    scheduleTone(remainingSec);
    toneArmedForTarget = targetMs;
  }
}

// ---- Director: arm the countdown for everyone ----
armBtn.addEventListener("click", () => {
  unlockAudio();
  const target = syncedNow() + COUNTDOWN_SECONDS * 1000;
  db.ref(SESSION_PATH).set({
    target,
    armedAt: syncedNow(),
  });
});

testToneBtn.addEventListener("click", () => {
  unlockAudio();
  scheduleTone(0.05);
  flashScreen();
});

// ---- Viewer: listen for an armed session from any browser (director) ----
let lastHandledTarget = null;

db.ref(SESSION_PATH).on("value", (snap) => {
  const data = snap.val();
  if (!data || !data.target) return;
  if (data.target === lastHandledTarget) return;
  lastHandledTarget = data.target;

  unlockAudio(); // best-effort; may be blocked without a user gesture
  startCountdownTo(data.target);
  ensureToneScheduled(data.target);
});
