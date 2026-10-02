/**
 * Alert sounds, synthesised in the browser.
 *
 * No audio files: the host has no route to the internet, every byte shipped is a byte in
 * the backup, and a two-tone chime is a dozen lines of WebAudio. It also means the sound
 * can be shaped to the message — a new job and a breached P1 must not sound alike, or the
 * store stops hearing either.
 *
 * Two things browsers enforce that shape this whole file:
 *  - Audio cannot start until the person has interacted with the page. The context stays
 *    suspended until then, so the first sound after a fresh load is silently dropped
 *    rather than throwing.
 *  - There is no autoplay exemption for a background tab, so this is a nudge for someone
 *    at the desk, never a substitute for the notification bell or the job board itself.
 */
export type Alert = 'notify' | 'urgent' | 'done';

const KEY = 'ff-sound';

/** Per device, not per account: the store's tablet wants sound, the HOD's laptop may not. */
export function soundOn(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    // Default on. Somebody who does not want it turns it off once and it stays off.
    return v === null ? true : v === 'on';
  } catch {
    return false;
  }
}

export function setSoundOn(on: boolean): void {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
}

/**
 * A stable name for this browser, so two devices do not overwrite each other's state on
 * the host. It identifies a browser profile and nothing else — not a person, not a
 * machine — and it never leaves the property.
 */
let ctx: AudioContext | null = null;

const DEVICE_KEY = 'ff-device-id';
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const made = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    // Private mode, or storage blocked: a per-session name is still better than none.
    return 'd-ephemeral-' + Math.random().toString(36).slice(2);
  }
}

/**
 * Whether this browser could actually make a sound right now.
 *
 * Browsers refuse audio until the page has been interacted with, so a tablet propped on a
 * shelf since this morning is silent no matter what the toggle says. Reporting this
 * separately is the difference between "they turned it off" and "nobody has touched it",
 * which are different problems with different fixes.
 */
export function audioReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}

type Ctor = typeof AudioContext;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC: Ctor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { return null; }
  return ctx;
}

interface Tone { hz: number; at: number; ms: number; gain: number }

/** Distinct shapes, not just distinct pitches — a rising pair reads differently from a fall. */
const VOICES: Record<Alert, Tone[]> = {
  // Two soft rising notes. Something arrived; look when you can.
  notify: [
    { hz: 660, at: 0, ms: 110, gain: 0.16 },
    { hz: 880, at: 0.1, ms: 150, gain: 0.16 },
  ],
  // Three insistent falls. A P1 has breached and somebody has to move.
  urgent: [
    { hz: 880, at: 0, ms: 130, gain: 0.24 },
    { hz: 660, at: 0.17, ms: 130, gain: 0.24 },
    { hz: 880, at: 0.34, ms: 130, gain: 0.24 },
    { hz: 660, at: 0.51, ms: 220, gain: 0.24 },
  ],
  // One low, settled note. Something closed cleanly.
  done: [{ hz: 520, at: 0, ms: 180, gain: 0.13 }],
};

export function play(alert: Alert): void {
  if (!soundOn()) return;
  const ac = context();
  if (!ac) return;

  // Suspended means the person has not interacted with the page yet. Resume is a promise
  // that rejects on a locked context; a dropped sound must never surface as an error.
  if (ac.state === 'suspended') { void ac.resume().catch(() => undefined); }
  if (ac.state !== 'running') return;

  const now = ac.currentTime;
  for (const t of VOICES[alert]) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    // A triangle wave carries across a plant room without the harshness of a square.
    osc.type = 'triangle';
    osc.frequency.value = t.hz;

    const start = now + t.at;
    const end = start + t.ms / 1000;
    // Ramped rather than switched: an instant gain change clicks on most speakers.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(t.gain, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/** Lets the settings toggle demonstrate what it just switched on. */
export function preview(alert: Alert = 'notify'): void {
  const ac = context();
  if (ac?.state === 'suspended') void ac.resume().catch(() => undefined);
  const was = soundOn();
  setSoundOn(true);
  play(alert);
  setSoundOn(was);
}
