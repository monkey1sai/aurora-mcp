// 雨天 Lo-fi — Lo-fi Rain · lo-fi hip hop, 80 BPM, A minor pentatonic for play-along (C major / A minor harmony).
//
// Form (46 bars ≈ 2:18, one pass, ends on a ringing Fmaj9):
//   Intro 窗邊 (4) — muffled tape keys + rain, the filter opens into the beat
//   A 細雨 (8)     — the hook on vibraphone over Fmaj9 · E7b9 · Am9 · Gm9 C13
//   B 街燈 (8)     — circle of fifths (Dm9 G13 Cmaj9 Fmaj9 Bø E7b9 Am9 Gm9 C13), rising-arpeggio melody
//   A' 白日夢 (8)  — hook again, busier comping, motor vibrato on the vibes, tape echo throws
//   滴答 (4)       — breakdown: rain alone with wobbling keys, the kick comes back "through the wall"
//   霓虹 (8)       — climax: circle of fifths with harmonised vibes, everything open
//   雨停 (6)       — the hook one last time while the tape fades into rain
//
// Parts: tape e-piano (Faded Summer) · upright bass (Walnut Upright) · kick · snare · shaker that doubles as the rain ·
// vibraphone lead (Midnight Vibraphone). Every section rides macros: Age (muffled tape ↔ open), Wow, Echo throws,
// Space swells, kick Muffle, vibraphone Tremolo / Pedal / Mallet.
import { midi, parseChord, melody, drums, merge, humanize, rngOf, macroRamp, macro, automate, sortEvents } from '../songlib.js';

const BAR = 4;
const b = n => n * BAR; // bar index → beat
const r4 = x => Math.round(x * 1e6) / 1e6;

// ───────────── harmony ─────────────
// Rootless voicings (the upright plays the roots); each chord moves by a half or whole step into the next.
const VOX = {
  Fmaj9: 'A3 C4 E4 G4', E7b9: 'G#3 B3 D4 F4', Am9: 'G3 B3 C4 E4', Gm9: 'F3 A3 Bb3 D4', C13: 'E3 A3 Bb3 D4',
  Dm9: 'F3 A3 C4 E4', G13: 'F3 A3 B3 E4', Cmaj9: 'E3 G3 B3 D4', 'Fmaj9/lo': 'E3 G3 A3 C4', Bm7b5: 'F3 A3 B3 D4',
  'E7b9/lo': 'F3 G#3 B3 D4', 'Am9/lo': 'E3 G3 B3 C4', 'Fmaj9/top': 'A3 C4 E4 G4 A4',
};
const notesOf = v => VOX[v].split(' ').map(midi);
// [chord symbol, voicing, beats]
const PA = [['Fmaj9', 'Fmaj9', 4], ['E7b9', 'E7b9', 4], ['Am9', 'Am9', 4], ['Gm9', 'Gm9', 2], ['C13', 'C13', 2]];
const PB = [['Dm9', 'Dm9', 4], ['G13', 'G13', 4], ['Cmaj9', 'Cmaj9', 4], ['Fmaj9', 'Fmaj9/lo', 4],
  ['Bm7b5', 'Bm7b5', 4], ['E7b9', 'E7b9/lo', 4], ['Am9', 'Am9/lo', 4], ['Gm9', 'Gm9', 2], ['C13', 'C13', 2]];

// Song map: section → progression (bars)
const S = { intro: 0, a: 4, b: 12, a2: 20, brk: 28, climax: 32, outro: 40, end: 46 };
const LEN = b(S.end);

/** Chord timeline [{beat, sym, vox, beats}] for a progression starting at bar `bar`. */
function timeline(prog, bar) {
  let beat = b(bar);
  return prog.map(([sym, vox, beats]) => { const c = { beat, sym, vox, beats }; beat += beats; return c; });
}
const TL = [
  ...timeline(PA, S.intro), ...timeline(PA, S.a), ...timeline(PA, S.a + 4), ...timeline(PB, S.b),
  ...timeline(PA, S.a2), ...timeline(PA, S.a2 + 4), ...timeline(PA, S.brk), ...timeline(PB, S.climax),
  ...timeline(PA, S.outro), { beat: b(S.outro + 4), sym: 'Fmaj9', vox: 'Fmaj9/top', beats: 8 },
];
const chordAt = beat => { let c = TL[0]; for (const x of TL) if (x.beat <= beat + 1e-6) c = x; return c; };

// ───────────── keys (Faded Summer) ─────────────
// Comping styles: hits [beat-in-chord, dur, vel] for 4-beat and 2-beat chords. Negative beats = "pushed" chords,
// struck an 8th (or a 16th) before the bar line like a neo-soul player — they also keep the keys' attack off the
// kick + bass downbeat.
const COMP = {
  pad: { 4: [[0, 3.45, 0.52]], 2: [[0, 1.45, 0.48]] },
  push: { 4: [[-0.5, 2.1, 0.6], [2.75, 0.6, 0.45]], 2: [[-0.5, 1.9, 0.56]] },
  lazy: { 4: [[-0.25, 1.9, 0.58], [2.75, 0.9, 0.44]], 2: [[-0.25, 1.65, 0.55]] },
  busy: { 4: [[-0.5, 1.6, 0.62], [1.5, 0.45, 0.44], [3, 0.4, 0.5]], 2: [[-0.5, 1.2, 0.58], [1, 0.4, 0.4]] },
  final: { 8: [[-0.5, 8, 0.66]] },
};
const velocityOf = (ev, k) => ev.map(e => ({ ...e, vel: Math.round(e.vel * k * 1000) / 1000 }));
function comp(fromBar, toBar, style, strum = 0.022) {
  const ev = [];
  for (const c of TL) {
    if (c.beat < b(fromBar) - 1e-6 || c.beat >= b(toBar) - 1e-6) continue;
    const hits = COMP[style][c.beats] || COMP[style][4];
    const notes = notesOf(c.vox);
    for (const [t, dur, vel] of hits) {
      if (c.beat + t < 0) continue;
      notes.forEach((n, i) => ev.push({ beat: r4(c.beat + t + i * strum), type: 'on', note: n, vel: Math.max(0.05, vel - i * 0.015), dur: r4(dur - i * strum) }));
    }
  }
  return ev;
}
const keysNotes = humanize(merge(
  velocityOf(comp(S.intro, S.a, 'pad', 0.03), 1.15).map(e => (e.beat >= b(S.a) - 2 ? { ...e, dur: r4(Math.min(e.dur, b(S.a) - 0.6 - e.beat)) } : e)),
  comp(S.a, S.b, 'push'),
  comp(S.b, S.a2, 'lazy'),
  comp(S.a2, S.brk, 'push'),
  velocityOf(comp(S.brk, S.climax, 'pad'), 0.88),
  comp(S.climax, S.outro, 'busy'),
  comp(S.outro, S.outro + 4, 'push'),
  comp(S.outro + 4, S.end, 'final', 0.03),
), { timing: 0.012, velocity: 0.05, seed: 101, swing: 0.28 });
// Macros: 0 Wow · 1 Age (darker + tape hiss) · 2 Echo · 3 Space
const keysAuto = merge(
  automate({ macro: 1 }, [[0, 1], [b(2), 1], [b(S.a) - 0.5, 0.15], [b(S.a2), 0.1], [b(S.brk), 0.1], [b(S.brk) + 2, 0.6], [b(S.climax) - 1, 0.6], [b(S.climax), 0], [b(S.outro), 0.1], [b(S.end) - 2, 0.9]]),
  automate({ macro: 0 }, [[0, 0.35], [b(S.a), 0.2], [b(S.b), 0.2], [b(S.a2), 0.45], [b(S.brk), 0.85], [b(S.climax) - 1, 0.85], [b(S.climax), 0.25], [b(S.outro), 0.5], [b(S.end), 0.85]]),
  automate({ macro: 3 }, [[0, 0.6], [b(S.a), 0.15], [b(S.brk), 0.15], [b(S.brk + 2), 0.8], [b(S.climax), 0.3], [b(S.outro), 0.3], [b(S.end) - 2, 0.9]]),
  // echo throws at phrase ends (A', climax, outro)
  ...[S.a + 7, S.a2 + 3, S.a2 + 7, S.climax + 7, S.outro + 3].map(bar => macroRamp(2, 0, 0.85, b(bar) + 2, 1.5)),
  ...[S.a + 7, S.a2 + 3, S.a2 + 7, S.climax + 7, S.outro + 3].map(bar => macroRamp(2, null, 0, b(bar + 1), 2)),
);

// ───────────── upright bass (Walnut Upright) ─────────────
const BASS_A = 'F2 - - . . C3 . F2 | E2 - - . . B1 . G#1 | A1 - - . . E2 . A1 | G1 - - D2 C2 - . E2';
const BASS_A_TO_B = 'F2 - - . . C3 . F2 | E2 - - . . B1 . G#1 | A1 - - . . E2 . A1 | G1 - - D2 C2 - . C#2';
const BASS_B = 'D2 - - . . A2 . A1 | G1 - - . . D2 . B1 | C2 - - . . G2 . E2 | F2 - - . . C3 . C2 |' +
  'B1 - - . . F2 . F2 | E2 - - . . B1 . G#1 | A1 - - . . E2 . A1 | G1 - - D2 C2 - . E2';
const BASS_B_HOT = 'D2 - - D3 . A2 . A1 | G1 - - G2 . D2 . B1 | C2 - - C3 . G2 . E2 | F2 - - F2 . C3 . C2 |' +
  'B1 - - B2 . F2 . F2 | E2 - - E3 . B1 . G#1 | A1 - - A2 . E2 G2 A1 | G1 - - D2 C2 - C3 E2';
const bassNotes = humanize(merge(
  melody('. . . . . . . E2', { start: b(S.a - 1), vel: 0.5, gate: 0.9 }),
  melody(BASS_A, { start: b(S.a), vel: 0.78, gate: 0.9 }),
  melody(BASS_A_TO_B, { start: b(S.a + 4), vel: 0.78, gate: 0.9 }),
  melody(BASS_B, { start: b(S.b), vel: 0.78, gate: 0.9 }),
  melody(BASS_A, { start: b(S.a2), vel: 0.8, gate: 0.9 }),
  melody(BASS_A_TO_B.replace('C2 - . C#2', 'C2 - - -'), { start: b(S.a2 + 4), vel: 0.8, gate: 0.9 }),
  melody('. . . . . . . . | . . . . . . . . | . . A1 - - - - - | G1 - - - C2 - - C#2', { start: b(S.brk), vel: 0.6, gate: 0.95 }),
  melody(BASS_B_HOT, { start: b(S.climax), vel: 0.82, gate: 0.88 }),
  melody(BASS_A, { start: b(S.outro), vel: 0.72, gate: 0.9 }),
  melody('F2 - - - - - - - | - - - - - - - -', { start: b(S.outro + 4), vel: 0.7, gate: 0.95 }),
), { timing: 0.01, velocity: 0.05, seed: 102, swing: 0.28 }).map(e => ({ ...e, beat: r4(e.beat + 0.035) })); // laid back behind the kick
// Macros: 0 Pluck · 1 Tone · 2 Sustain · 3 Room
const bassAuto = merge(
  macro(0, 0.25, 0), macro(1, 0.2, 0),
  automate({ macro: 1 }, [[b(S.climax), 0.2], [b(S.climax + 8), 0.55], [b(S.outro), 0.25]]),
  automate({ macro: 3 }, [[b(S.brk), 0], [b(S.brk + 2), 0.7], [b(S.climax), 0.1]]),
);

// ───────────── drums (one part per instrument, same swing) ─────────────
const KICK_A = 'x......x..x.....', KICK_B = 'x......x..xx....', KICK_FILL = 'x......x.xx.....';
const SNARE_A = '....x.......x...', SNARE_G = '....x..o....x..o', SNARE_FILL = '....x.......xoxx';
const HAT_A = '6.4.6.4.6.4.6.42', HAT_B = '6242624262426242';
/** Pattern per bar: patterns[i % patterns.length] for bars [from, to). */
function beat(inst, from, to, patterns, vel = 0.85) {
  const ev = [];
  for (let bar = from; bar < to; bar++) ev.push(...drums({ [inst]: patterns[(bar - from) % patterns.length] }, { start: b(bar), vel, ghost: 0.24 }));
  return ev;
}
const groove = (ev, seed) => humanize(ev, { timing: 0.012, velocity: 0.07, seed, swing: 0.28 });

const kickNotes = groove(merge(
  beat('kick', S.a, S.b, [KICK_A, KICK_A, KICK_A, KICK_FILL]),
  beat('kick', S.b, S.a2, [KICK_A, KICK_B, KICK_A, KICK_FILL]),
  beat('kick', S.a2, S.brk, [KICK_A, KICK_B, KICK_A, KICK_B, KICK_A, KICK_B, KICK_A, 'x......x........']),
  beat('kick', S.brk + 2, S.climax, [KICK_A, 'x......x..x.x.x.'], 0.8),
  beat('kick', S.climax, S.outro, [KICK_B, KICK_A, KICK_B, KICK_FILL]),
  beat('kick', S.outro, S.outro + 2, [KICK_A, 'x...............'], 0.75),
), 103);
// Macros: 0 Punch · 1 Body · 2 Muffle · 3 Room — dusty by default, "through the wall" in the breakdown
const kickAuto = merge(
  macro(1, 0.35, 0), macro(2, 0.2, 0),
  automate({ macro: 2 }, [[b(S.brk + 2), 1], [b(S.climax) - 0.5, 0.2], [b(S.outro), 0.3], [b(S.outro + 2), 0.8]]),
);

const snareNotes = groove(merge(
  beat('snare', S.a, S.b, [SNARE_A, SNARE_A, SNARE_A, SNARE_G]),
  beat('snare', S.b, S.a2, [SNARE_A, SNARE_G, SNARE_A, SNARE_G, SNARE_A, SNARE_G, SNARE_A, SNARE_FILL]),
  beat('snare', S.a2, S.brk, [SNARE_A, SNARE_G, SNARE_A, SNARE_G, SNARE_A, SNARE_G, SNARE_A, '....x...........']),
  beat('snare', S.brk + 3, S.climax, ['............xoxx'], 0.7),
  beat('snare', S.climax, S.outro, [SNARE_G, SNARE_A, SNARE_G, SNARE_A, SNARE_G, SNARE_A, SNARE_G, SNARE_FILL]),
  beat('snare', S.outro, S.outro + 2, [SNARE_A, '....x...........'], 0.7),
), 104);
// Macros: 0 Snares · 1 Tune · 2 Fat · 3 Space
const snareAuto = merge(
  macro(2, 0.45, 0), macro(3, 0.2, 0),
  automate({ macro: 3 }, [[b(S.climax + 7), 0.2], [b(S.outro), 0.6], [b(S.outro + 2), 0.9]]),
);

/** Rain on the window: soft random grains (32nd grid) over the whole keyboard; density ramps from → to. */
function rain(start, beats, { from = 0.4, to = from, seed = 7, lo = 60, hi = 96, vmin = 0.12, vmax = 0.7 } = {}) {
  const rnd = rngOf(seed), ev = [], slot = 0.125, n = Math.round(beats / slot);
  for (let i = 0; i < n; i++) {
    const d = from + (to - from) * (i / n);
    if (rnd() >= d) continue;
    const note = lo + Math.floor(rnd() * (hi - lo + 1));
    const vel = vmin + (vmax - vmin) * rnd() ** 2;
    ev.push({ beat: r4(start + (i + rnd() * 0.7) * slot), type: 'on', note, vel: Math.round(vel * 1000) / 1000, dur: 0.1 });
  }
  return ev;
}
const shakerNotes = merge(
  rain(0, b(S.a) - 1, { from: 0.4, to: 0.7, seed: 11 }),
  rain(b(S.a) - 1, 1, { from: 0.55, to: 0.1, seed: 12 }),
  groove(beat('shaker', S.a, S.brk, [HAT_A]), 105),
  rain(b(S.brk), b(4), { from: 0.45, to: 0.75, seed: 13 }),
  groove(beat('shaker', S.climax, S.outro + 2, [HAT_B, HAT_B, HAT_B, HAT_A]), 106),
  rain(b(S.outro + 1), b(S.end - S.outro - 1), { from: 0.05, to: 0.7, seed: 14 }),
);
// Macros: 0 Grain · 1 Length · 2 Tone · 3 Space — long, washy grains for the rain, tight for the groove
const shakerAuto = merge(
  automate({ macro: 3 }, [[0, 0.85], [b(S.a) - 1, 0.85], [b(S.a), 0.15], [b(S.brk), 0.8], [b(S.climax), 0.2], [b(S.outro + 1), 0.25], [b(S.end), 0.9]]),
  automate({ macro: 1 }, [[0, 0.7], [b(S.a) - 1, 0.7], [b(S.a), 0.15], [b(S.brk), 0.7], [b(S.climax), 0.25], [b(S.outro + 1), 0.25], [b(S.end), 0.7]]),
  automate({ macro: 0 }, [[0, 0.6], [b(S.a), 0.2], [b(S.brk), 0.6], [b(S.climax), 0.3]]),
);

// ───────────── vibraphone lead (Midnight Vibraphone) ─────────────
const HOOK_1 = '. E5 G5 A5 - - G5 E5 | F5 - E5 - D5 - B4 - | . E5 G5 A5 - - G5 E5 | D5 - - - C5 D5 E5 -';
const HOOK_2 = '. E5 G5 A5 - - C6 A5 | B5 - G#5 - F5 - E5 - | . E5 G5 A5 - - G5 E5 | F5 - - E5 D5 - C5 -';
const TUNE_B = '. D5 E5 F5 A5 - - - | G5 - F5 - E5 - - - | . C5 D5 E5 G5 - - - | F5 - E5 - D5 - - - |' +
  '. B4 C5 D5 F5 - - - | F5 - E5 - D5 - B4 - | . A4 B4 C5 E5 - - - | D5 - - Bb4 A4 - G4 -';
/** Close harmony under a melody: the highest chord tone 3–9 semitones below each note. */
function harmonize(ev, vel = 0.8) {
  const out = [];
  for (const e of ev) {
    if (e.type !== 'on' || e.dur < 0.9) continue; // only the long notes get a second mallet
    const c = parseChord(chordAt(e.beat).sym);
    const pcs = c.intervals.map(i => (c.root + i) % 12);
    // a hair after the melody note, like a player rolling a double stop (and the two strikes don't peak together)
    for (let d = 3; d <= 9; d++) if (pcs.includes(((e.note - d) % 12 + 12) % 12)) { out.push({ ...e, beat: r4(e.beat + 0.03), note: e.note - d, vel: Math.round(e.vel * vel * 1000) / 1000 }); break; }
  }
  return out;
}
const tuneClimax = melody(TUNE_B, { start: b(S.climax), vel: 0.78, accent: 0.9 });
const leadNotes = humanize(merge(
  melody('. . . . . . . . | . . . . . . . . | . E5? G5? A5? - - - - | . . . . . . . .', { start: b(S.intro), vel: 0.5, soft: 0.38 }),
  melody(HOOK_1, { start: b(S.a), vel: 0.72 }),
  melody(HOOK_2, { start: b(S.a + 4), vel: 0.74 }),
  melody(TUNE_B, { start: b(S.b), vel: 0.7 }),
  melody(HOOK_1, { start: b(S.a2), vel: 0.74 }),
  melody(HOOK_2, { start: b(S.a2 + 4), vel: 0.76 }),
  melody('. E5 G5 A5 - - - - | . . . . . . . . | . E5 G5 A5 - - C6 - | - - - - . . . .', { start: b(S.brk), vel: 0.7 }),
  tuneClimax, harmonize(tuneClimax, 0.6),
  melody(HOOK_1, { start: b(S.outro), vel: 0.68 }),
  melody('. E5 G5 A5 - - - - | - - - - - - - -', { start: b(S.outro + 4), vel: 0.66 }),
), { timing: 0.012, velocity: 0.06, seed: 107, swing: 0.28 }).map(e => (e.type === 'on' && e.note < 69 ? { ...e, vel: Math.round(e.vel * 800) / 1000 } : e)); // low bars ring louder
// Macros: 0 Mallet · 1 Tremolo · 2 Pedal · 3 Room
const leadAuto = merge(
  macro(1, 0.15, 0), macro(3, 0.3, 0),
  // the vibraphone's motor speeds up through B and A', full swirl in the breakdown
  automate({ macro: 1 }, [[b(S.b), 0.15], [b(S.b + 7), 0.6], [b(S.a2), 0.2], [b(S.a2 + 4), 0.7], [b(S.brk), 0.9], [b(S.climax), 0.35], [b(S.outro), 0.6], [b(S.end), 0.9]]),
  automate({ macro: 2 }, [[b(S.brk), 0], [b(S.brk + 1), 0.8], [b(S.climax), 0.2], [b(S.outro + 4), 0.2], [b(S.outro + 5), 1]]),
  automate({ macro: 0 }, [[b(S.climax), 0], [b(S.climax + 6), 0.55], [b(S.outro), 0]]),
  automate({ macro: 3 }, [[b(S.brk), 0.3], [b(S.brk + 2), 0.75], [b(S.climax), 0.3], [b(S.outro + 4), 0.3], [b(S.end), 0.8]]),
);

export default {
  id: 'lofi-rain',
  title: 'Lo-fi Rain',
  zh: '雨天 Lo-fi',
  genre: 'Lo-fi Hip Hop',
  zhGenre: 'Lo-fi 嘻哈',
  description: '雨夜窗邊的 Lo-fi：磁帶質感的電鋼琴彈著九和弦，木頭貝斯與慵懶搖擺的鼓，顫音琴哼著一段小旋律；雨聲在前奏與間奏淅瀝落下，磁帶的歲月、抖動與回音隨段落慢慢變化。',
  descriptionEn: 'Lo-fi by a rainy window: a tape-worn electric piano playing ninth chords, upright bass and lazy swung drums, and a vibraphone humming a little tune. Rain patters through the intro and breakdown while tape age, wobble and echo drift from section to section.',
  bpm: 80,
  key: { root: 'A', scale: 'pentMinor' },
  lengthBeats: LEN,
  loop: false,
  cover: { colors: ['#ffb86b', '#7a8cff', '#2d3561'] },
  sections: [
    { beat: b(S.intro), name: 'Window', zh: '窗邊' },
    { beat: b(S.a), name: 'Drizzle', zh: '細雨' },
    { beat: b(S.b), name: 'Streetlights', zh: '街燈' },
    { beat: b(S.a2), name: 'Daydream', zh: '白日夢' },
    { beat: b(S.brk), name: 'Pitter-Patter', zh: '滴答' },
    { beat: b(S.climax), name: 'Neon Glow', zh: '霓虹' },
    { beat: b(S.outro), name: 'Clearing', zh: '雨停' },
  ],
  parts: [
    { name: 'Keys', zh: '電鋼琴', role: 'keys', preset: 'Faded Summer',
      // chords hold a little longer under the melody; −1.5 dB: the preset's phase-locked osc/FM layers no longer
      // cancel at random, so the part reads ≈ 0.5 LU louder (and chords peak higher) than before
      params: { 'voice.poly': 8, 'aenv.d': 4, 'aenv.s': 0.45 },
      gain: -1.5, pan: -0.12, events: sortEvents([...keysNotes, ...keysAuto]) },
    { name: 'Bass', zh: '木貝斯', role: 'bass', preset: 'Walnut Upright',
      // a little more sustain (the preset's parallel soft clip keeps the pluck from spiking over its loudness)
      params: { 'voice.poly': 4, 'phys.decay': 4 }, gain: -1.5, pan: 0, events: sortEvents([...bassNotes, ...bassAuto]) },
    // kick −2.5 dB (was −3): the phys retune fix (no +dB burst while the pitch envelope drops) left Anvil Kick ≈ 3 LU
    // quieter and thinner; with the preset's low shelf (eq.low 3 → 6) it is back to ≈ −23 LUFS (more would push
    // kick + bass + vibes on the downbeat at 0:27 above −1 dBFS before the safety limiter)
    { name: 'Kick', zh: '大鼓', role: 'drums', preset: 'Anvil Kick', params: { 'drive.amount': 0.5 }, gain: -2.5, pan: 0, events: sortEvents([...kickNotes, ...kickAuto]) },
    { name: 'Snare', zh: '小鼓', role: 'drums', preset: 'Cobalt Snare', gain: 0, pan: 0.06, events: sortEvents([...snareNotes, ...snareAuto]) },
    { name: 'Shaker', zh: '沙鈴・雨聲', role: 'drums', preset: 'Sandstorm Shaker', gain: -1, pan: 0.18, events: sortEvents([...shakerNotes, ...shakerAuto]) },
    { name: 'Vibes', zh: '顫音琴', role: 'lead', preset: 'Midnight Vibraphone', params: { 'voice.poly': 8 }, gain: 4, pan: 0.1, events: sortEvents([...leadNotes, ...leadAuto]) },
  ],
};
