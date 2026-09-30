// Musical phrases for rendering / auditioning presets and for the UI "▶ Demo" button.
// Pure ES module (no Node or browser APIs) — importable from the UI as '/tools/phrases.mjs'.
//
// Each phrase uses the synth sequencer's song format (docs/ARCHITECTURE.md §6):
//   { bpm, lengthBeats, loop, events: [ { beat, type: 'on', note, vel, dur /*beats*/ } ] }
// plus metadata (id, label, zh, description).
//
//   import { PHRASES, getPhrase, phraseToTimedEvents } from './phrases.mjs';
//   synth.sequencer.load(getPhrase('keys'));                 // realtime demo
//   const ev = phraseToTimedEvents(getPhrase('bass'));       // [{time, type:'on'|'off', note, vel}] seconds

// Deterministic humanisation (no Math.random): tiny velocity variation from a hash of the index.
const jitter = (i, amt) => amt * Math.sin(i * 12.9898 + 78.233 * Math.sin(i * 4.1414));
const clampVel = v => Math.max(0.05, Math.min(1, Math.round(v * 1000) / 1000));
const r = x => Math.round(x * 10000) / 10000;

function build(meta, bpm, lengthBeats, events, loop = true) {
  const ev = events
    .map((e, i) => ({ beat: r(e.beat), type: 'on', note: e.note, vel: clampVel(e.vel + jitter(i, 0.025)), dur: r(e.dur) }))
    .sort((a, b) => a.beat - b.beat || a.note - b.note);
  return { ...meta, bpm, lengthBeats, loop, events: ev };
}

/** Chord helper: notes struck at `beat` with an optional upward strum (beats between notes). */
function chord(beat, notes, dur, vel, strum = 0) {
  return notes.map((note, i) => ({ beat: beat + i * strum, note, vel: vel - i * 0.015, dur: dur - i * strum }));
}

// ───────────────────────── keys ─────────────────────────
// Cmaj9 – Am7 – Fmaj7 – G6 → Cmaj9, left-hand root+5th, syncopated right-hand comp, lyrical top melody.
const KEYS = (() => {
  const prog = [
    { lh: [48, 55], rh: [64, 71, 74] }, // Cmaj9  (C3 G3 | E4 B4 D5)
    { lh: [45, 52], rh: [64, 67, 72] }, // Am7    (A2 E3 | E4 G4 C5)
    { lh: [41, 48], rh: [64, 69, 72] }, // Fmaj7  (F2 C3 | E4 A4 C5)
    { lh: [43, 50], rh: [64, 67, 71] }, // G6     (G2 D3 | E4 G4 B4)
  ];
  const ev = [];
  prog.forEach((c, bar) => {
    const b = bar * 4;
    ev.push(...chord(b, c.lh, 3.9, 0.7));
    ev.push(...chord(b, c.rh, 1.8, 0.62, 0.012));
    ev.push(...chord(b + 2.5, c.rh, 1.4, 0.56, 0.012));
  });
  ev.push(...chord(16, [48, 55], 3.8, 0.68), ...chord(16, [64, 71, 74], 3.6, 0.58, 0.03));
  // melody: [beat, note, dur, vel]
  const mel = [
    [0, 79, 1.4, 0.8], [1.5, 76, 0.45, 0.66], [2, 79, 0.9, 0.74], [3, 81, 0.9, 0.78],
    [4, 76, 1.4, 0.8], [5.5, 74, 0.45, 0.64], [6, 76, 0.9, 0.72], [7, 79, 0.9, 0.78],
    [8, 81, 1.4, 0.84], [9.5, 79, 0.45, 0.68], [10, 77, 0.9, 0.74], [11, 76, 0.9, 0.72],
    [12, 74, 1.4, 0.76], [13.5, 76, 0.45, 0.64], [14, 79, 0.9, 0.74], [15, 74, 0.9, 0.7],
    [16, 76, 3.5, 0.78],
  ];
  for (const [beat, note, dur, vel] of mel) ev.push({ beat, note, dur, vel });
  return build({ id: 'keys', label: 'Keys', zh: '鍵盤和弦', description: 'Cmaj9–Am7–Fmaj7–G6 和弦進行，左手根音、切分和弦與上方旋律' }, 92, 20, ev);
})();

// ───────────────────────── pad ─────────────────────────
const PAD = (() => {
  const chords = [
    [48, 55, 64, 71, 74], // Cmaj9
    [45, 52, 60, 67, 71], // Am9
    [41, 48, 57, 64, 71], // Fmaj7♯11
    [43, 50, 57, 64, 71], // G6/9
  ];
  const ev = [];
  chords.forEach((c, i) => ev.push(...chord(i * 4, c, 3.9, 0.66 + (i === 2 ? 0.05 : 0), 0.02)));
  return build({ id: 'pad', label: 'Pad', zh: '鋪底長和弦', description: '緩慢延續的開放和弦，留出長釋放尾音' }, 72, 16, ev);
})();

// ───────────────────────── bass ─────────────────────────
// Syncopated 16ths in C minor, C1–C2 range. Steps are 16ths: [step, note, lengthInSteps, vel]
const BASS = (() => {
  const C1 = 24, Eb1 = 27, F1 = 29, G1 = 31, Ab1 = 32, Bb1 = 34, B1 = 35, C2 = 36, D1 = 26;
  const bars = [
    [[0, C1, 3, 0.95], [3, C1, 1, 0.6], [6, C2, 1, 0.75], [8, C1, 2, 0.85], [10, G1, 1, 0.62], [11, Bb1, 1, 0.66], [12, C2, 2, 0.8], [14, G1, 2, 0.7]],
    [[0, Ab1, 3, 0.92], [3, Ab1, 1, 0.58], [6, Eb1, 1, 0.72], [8, Ab1, 2, 0.84], [10, C2, 1, 0.66], [11, Ab1, 1, 0.6], [12, Bb1, 2, 0.8], [14, Bb1, 1, 0.62], [15, C2, 1, 0.7]],
    [[0, C1, 3, 0.95], [3, C1, 1, 0.6], [6, C2, 1, 0.75], [8, C1, 2, 0.85], [10, G1, 1, 0.62], [11, Bb1, 1, 0.66], [12, C2, 1, 0.8], [13, Bb1, 1, 0.64], [14, G1, 2, 0.72]],
    [[0, Bb1, 3, 0.92], [3, Bb1, 1, 0.58], [6, F1, 1, 0.72], [8, G1, 2, 0.86], [10, G1, 1, 0.6], [11, D1, 1, 0.64], [12, G1, 1, 0.78], [13, Bb1, 1, 0.66], [14, B1, 2, 0.8]],
  ];
  const ev = [];
  bars.forEach((bar, bi) => {
    for (const [step, note, len, vel] of bar) {
      const gate = len === 1 ? 0.2 : len * 0.25 - 0.06;
      ev.push({ beat: bi * 4 + step / 4, note, dur: gate, vel });
    }
  });
  return build({ id: 'bass', label: 'Bass', zh: '切分貝斯', description: 'C1–C2 音域的十六分音符切分低音線' }, 118, 16, ev);
})();

// ───────────────────────── lead ─────────────────────────
// Expressive melody; `leg` notes overlap the next note (legato → glide in mono/legato modes).
const LEAD = (() => {
  // [beat, note, len, vel, legato]
  const m = [
    [0, 69, 1, 0.8, true], [1, 72, 0.5, 0.72, true], [1.5, 74, 0.5, 0.74, true], [2, 76, 2, 0.86, false],
    [4, 79, 0.75, 0.84, true], [4.75, 76, 0.25, 0.66, true], [5, 74, 0.5, 0.72, false], [5.5, 72, 0.5, 0.7, true], [6, 74, 2, 0.8, false],
    [8, 76, 0.5, 0.78, true], [8.5, 79, 0.5, 0.8, true], [9, 81, 0.5, 0.84, true], [9.5, 84, 1.5, 0.92, true],
    [11, 88, 0.5, 0.95, true], [11.5, 86, 0.5, 0.86, true],
    [12, 84, 0.5, 0.84, true], [12.5, 81, 0.5, 0.78, true], [13, 79, 1, 0.8, true], [14, 81, 2, 0.88, false],
  ];
  const ev = m.map(([beat, note, len, vel, leg]) => ({ beat, note, vel, dur: leg ? len + 0.06 : len * 0.92 }));
  return build({ id: 'lead', label: 'Lead', zh: '主奏旋律', description: '含連奏滑音與高音區的表情旋律' }, 100, 16, ev);
})();

// ───────────────────────── pluck ─────────────────────────
const PLUCK = (() => {
  const bars = [
    { root: 45, arp: [57, 64, 69, 72, 76, 72, 69, 64] }, // Am
    { root: 41, arp: [53, 60, 65, 69, 72, 69, 65, 60] }, // F
    { root: 48, arp: [60, 67, 72, 76, 79, 76, 72, 67] }, // C
    { root: 43, arp: [55, 62, 67, 71, 74, 71, 67, 62] }, // G
  ];
  const ev = [];
  bars.forEach((b, bi) => {
    ev.push({ beat: bi * 4, note: b.root, dur: 3.6, vel: 0.7 });
    b.arp.forEach((note, i) => ev.push({ beat: bi * 4 + i * 0.5, note, dur: 0.45, vel: i % 2 ? 0.64 : i === 0 ? 0.88 : 0.78 }));
  });
  return build({ id: 'pluck', label: 'Pluck', zh: '八分琶音', description: 'Am–F–C–G 八分音符分解和弦' }, 112, 16, ev);
})();

// ───────────────────────── bell ─────────────────────────
const BELL = build({ id: 'bell', label: 'Bell', zh: '稀疏鐘聲', description: '橫跨三個八度的稀疏音符，保留長尾音' }, 80, 16, [
  { beat: 0, note: 72, dur: 2, vel: 0.8 }, { beat: 1.5, note: 79, dur: 1.5, vel: 0.68 }, { beat: 3, note: 88, dur: 1, vel: 0.62 },
  { beat: 4, note: 69, dur: 2, vel: 0.76 }, { beat: 4, note: 76, dur: 2, vel: 0.62 }, { beat: 6, note: 86, dur: 1, vel: 0.6 },
  { beat: 7, note: 83, dur: 1, vel: 0.56 }, { beat: 8, note: 65, dur: 2, vel: 0.78 }, { beat: 8, note: 72, dur: 2, vel: 0.62 },
  { beat: 9.5, note: 81, dur: 1.5, vel: 0.66 }, { beat: 11, note: 91, dur: 1, vel: 0.55 }, { beat: 12, note: 60, dur: 2, vel: 0.84 },
  { beat: 12, note: 67, dur: 2, vel: 0.66 }, { beat: 13, note: 76, dur: 1, vel: 0.68 }, { beat: 14, note: 96, dur: 1, vel: 0.5 },
  { beat: 14.5, note: 79, dur: 1, vel: 0.6 }, { beat: 15, note: 84, dur: 1, vel: 0.64 },
]);

// ───────────────────────── arp ─────────────────────────
// Held chords for arpeggiator presets (Am7 8 beats, Fmaj7 4, G 4).
const ARP = build({ id: 'arp', label: 'Arp', zh: '琶音持續和弦', description: '供琶音器使用的持續和弦：Am7 → Fmaj7 → G' }, 120, 16, [
  ...chord(0, [57, 60, 64, 67], 7.98, 0.8),
  ...chord(8, [53, 57, 60, 64], 3.98, 0.8),
  ...chord(12, [55, 59, 62, 67], 3.98, 0.8),
]);

// ───────────────────────── fx ─────────────────────────
const FX = build({ id: 'fx', label: 'FX', zh: '音效長音', description: '寬音域長音，用於質感與音效' }, 90, 16, [
  { beat: 0, note: 36, dur: 12, vel: 0.8 }, { beat: 2, note: 79, dur: 8, vel: 0.6 }, { beat: 4, note: 96, dur: 4, vel: 0.5 },
  { beat: 8, note: 54, dur: 7, vel: 0.7 }, { beat: 10, note: 84, dur: 5, vel: 0.55 }, { beat: 12, note: 24, dur: 4, vel: 0.8 },
]);

// ───────────────────────── drum ─────────────────────────
// GM-ish: 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash.
const DRUM = (() => {
  const K = 36, S = 38, CH = 42, OH = 46, CR = 49;
  const ev = [];
  const hit = (beat, note, vel, dur) => ev.push({ beat, note, vel, dur: dur ?? (note === CR ? 1 : note === OH ? 0.45 : note === CH ? 0.2 : 0.5) });
  for (let bar = 0; bar < 4; bar++) {
    const b = bar * 4;
    if (bar === 0) hit(b, CR, 0.8);
    const kicks = bar === 1 ? [0, 0.75, 2, 2.75] : [0, 2, 2.5];
    for (const k of kicks) hit(b + k, K, k === 0 ? 1 : 0.86);
    hit(b + 1, S, 0.9);
    if (bar === 3) [3, 3.25, 3.5, 3.75].forEach((s, i) => hit(b + s, S, 0.6 + i * 0.1, 0.22));
    else hit(b + 3, S, 0.92);
    if (bar === 1) hit(b + 3.75, S, 0.35);
    const openAt = bar === 0 ? 3.5 : bar === 2 ? 1.5 : -1;
    const hatEnd = bar === 3 ? 3 : 4;
    for (let h = 0; h < hatEnd; h += 0.5) {
      if (h === openAt) hit(b + h, OH, 0.62);
      else if (!(bar === 0 && h === 0)) hit(b + h, CH, h % 1 === 0 ? 0.68 : 0.5);
    }
  }
  return build({ id: 'drum', label: 'Drum', zh: '鼓組節奏', description: '大鼓/小鼓/鈸的節奏型（音符 36/38/42/46/49）' }, 120, 16, ev);
})();

// ───────────────────────── scale / single / strings ─────────────────────────
const SCALE = build({ id: 'scale', label: 'Scale', zh: '音域掃描', description: 'C2 到 C7 的八度與三全音跳進，用於混疊與音準檢查' }, 100, 11,
  [36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96].map((note, i) => ({ beat: i, note, dur: 0.85, vel: 0.8 })), false);

const SINGLE = build({ id: 'single', label: 'Single', zh: '單音', description: '單一中央 C 長音' }, 120, 4, [{ beat: 0, note: 60, dur: 4, vel: 0.8 }], false);

const STRINGS = build({ id: 'strings', label: 'Strings', zh: '弦樂聲部', description: 'Am – Am/G – Fmaj7 – E 的連奏聲部進行' }, 76, 16, [
  { beat: 0, note: 45, dur: 4.05, vel: 0.72 }, { beat: 4, note: 43, dur: 4.05, vel: 0.7 }, { beat: 8, note: 41, dur: 4.05, vel: 0.74 }, { beat: 12, note: 40, dur: 3.9, vel: 0.76 },
  { beat: 0, note: 57, dur: 12.05, vel: 0.62 }, { beat: 12, note: 56, dur: 3.9, vel: 0.66 },
  { beat: 0, note: 60, dur: 12.05, vel: 0.6 }, { beat: 12, note: 59, dur: 3.9, vel: 0.64 },
  { beat: 0, note: 64, dur: 15.9, vel: 0.6 },
  { beat: 0, note: 69, dur: 4.05, vel: 0.74 }, { beat: 4, note: 71, dur: 4.05, vel: 0.76 }, { beat: 8, note: 72, dur: 2.05, vel: 0.8 },
  { beat: 10, note: 74, dur: 2.05, vel: 0.78 }, { beat: 12, note: 71, dur: 3.9, vel: 0.76 },
]);

/** All phrases by id. */
export const PHRASES = {
  keys: KEYS, pad: PAD, bass: BASS, lead: LEAD, pluck: PLUCK, bell: BELL, arp: ARP, fx: FX, drum: DRUM,
  scale: SCALE, single: SINGLE, strings: STRINGS,
};

/** Display list for UI pickers. */
export const PHRASE_LIST = Object.values(PHRASES).map(({ id, label, zh, description }) => ({ id, label, zh, description }));

/** Default demo phrase per preset category. */
export const DEMO_FOR_CATEGORY = {
  keys: 'keys', pad: 'pad', bass: 'bass', lead: 'lead', pluck: 'pluck', bell: 'bell', strings: 'strings', arp: 'arp', fx: 'fx', drum: 'drum',
};

/** Phrase by id (falls back to 'keys'). Returns a deep copy, safe to mutate. */
export function getPhrase(id) {
  const p = PHRASES[id] || PHRASES.keys;
  return { ...p, events: p.events.map(e => ({ ...e })) };
}

/** Copy of `phrase` transposed by `semitones` (notes clamped to 0..127). */
export function transposePhrase(phrase, semitones = 0) {
  return {
    ...phrase,
    events: phrase.events.map(e => (e.type === 'on' || e.type === undefined ? { ...e, note: Math.max(0, Math.min(127, e.note + semitones)) } : { ...e })),
  };
}

/** Seconds per beat for a phrase. */
export const beatSec = phrase => 60 / (phrase.bpm || 120);

/** Loop length in seconds. */
export const phraseDuration = phrase => phrase.lengthBeats * beatSec(phrase);

/** Time (s) of the last note-off in the phrase. */
export function phraseEnd(phrase) {
  let end = 0;
  for (const e of phrase.events) if (e.type === 'on' || e.type === undefined) end = Math.max(end, (e.beat + (e.dur ?? 0)) * beatSec(phrase));
  return end;
}

/**
 * Convert a phrase to a time-sorted list of note events in seconds.
 * opts: { transpose = 0, bpm = phrase.bpm, loops = 1, offset = 0 (s) }
 * At equal times, note-offs come before note-ons (so repeated notes retrigger cleanly).
 * @returns {{time:number, type:'on'|'off', note:number, vel:number}[]}
 */
export function phraseToTimedEvents(phrase, { transpose = 0, bpm = phrase.bpm || 120, loops = 1, offset = 0 } = {}) {
  const spb = 60 / bpm;
  const loopLen = phrase.lengthBeats * spb;
  const out = [];
  for (let l = 0; l < loops; l++) {
    for (const e of phrase.events) {
      if (e.type !== 'on' && e.type !== undefined) continue;
      const note = Math.max(0, Math.min(127, e.note + transpose));
      const t = offset + l * loopLen + e.beat * spb;
      // Times rounded to microseconds (before sorting) so float noise can't reorder simultaneous events.
      const us = x => Math.round(x * 1e6) / 1e6;
      out.push({ time: us(t), type: 'on', note, vel: e.vel ?? 0.8 });
      out.push({ time: us(t + Math.max(0.001, (e.dur ?? 0.5) * spb)), type: 'off', note, vel: 0 });
    }
  }
  out.sort((a, b) => a.time - b.time || (a.type === b.type ? a.note - b.note : a.type === 'off' ? -1 : 1));
  return out;
}
