// 脈動城市 Pulse City — house / acid house, F minor, 124 BPM, 72 bars (≈ 2:19), loops seamlessly (DJ-style:
// the outro strips back to kick + hats and re-muffles the kick, the intro opens it again).
//
//   Intro 點火 (8) → Groove 倉庫律動 (16) → Acid 酸性線條 (16) → Breakdown 失重 (8) → Peak 高峰 (16) → Outro 散場 (8)
//
// Harmony: deep-house minor-9 cycle Fm9 – D♭maj9 – E♭add9 – Cm7 with rootless voicings whose top line falls
// G4 – F4 – F4 – E♭4. Hook: the two-bar 303 line (F–F–F'–F … C–B♭–A♭) whose filter is the star of the show.
// Auto-tweaking: the acid's filter cutoff + envelope amount (plus its Resonance/Env Mod/Drive macros) ride
// through every section — a muted thud blooms into a squelch, sweeps up in the breakdown and breathes in 4-bar
// waves at the peak; the stabs' filter opens across the groove and the stab synth switches its own chord
// arpeggiator on for the breakdown (Swing ride); the kick's Muffle macro does the DJ filter intro/outro; the
// bass filter opens in the intro and ducks under the acid; the hats get metallic and open up at the peak.

import { drums, melody, merge, repeat, shift, humanize, macroRamp, macro, param, ramp, automate, bars } from '../songlib.js';

const S = { intro: 0, groove: bars(8), acid: bars(24), brk: bars(40), peak: bars(48), outro: bars(64), end: bars(72) };
const at = (ev, beat) => shift(ev, beat);

// ───────────── harmony: one bar per chord ─────────────
const CYCLE = [
  { bass: 41, stab: [56, 60, 63, 67] }, // Fm9      (bass F2 · A♭3 C4 E♭4 G4)
  { bass: 37, stab: [56, 60, 63, 65] }, // D♭maj9   (bass D♭2 · A♭3 C4 E♭4 F4)
  { bass: 39, stab: [55, 58, 63, 65] }, // E♭add9   (bass E♭2 · G3 B♭3 E♭4 F4)
  { bass: 36, stab: [55, 58, 60, 63] }, // Cm7      (bass C2 · G3 B♭3 C4 E♭4)
];
const chordAt = bar => CYCLE[((bar % 4) + 4) % 4];

/** Hits from a 16-step pattern ('x' hit, 'X' accent, '.' rest) for one bar, one note list per hit. */
function hitsBar(pattern, bar, notes, { vel = 0.8, accent = 1, dur = 0.3, start = 0 } = {}) {
  const ev = [];
  [...pattern.replace(/[\s|]/g, '')].forEach((c, i) => {
    if (c !== 'x' && c !== 'X') return;
    for (const n of notes) ev.push({ beat: start + bar * 4 + i * 0.25, type: 'on', note: n, vel: c === 'X' ? accent : vel, dur });
  });
  return ev;
}
/** `count` bars of chord-following hits, starting at song bar `bar0`; patterns = one per bar of the 4-bar cycle. */
function perBar(bar0, count, fn) {
  const ev = [];
  for (let b = bar0; b < bar0 + count; b++) ev.push(...fn(b, chordAt(b), (b - bar0) % 4));
  return ev;
}
const barOf = beat => beat / 4;

// ───────────── drums ─────────────
const FLOOR = 'x...x...x...x...';
const kick = merge(
  at(repeat(drums({ kick: FLOOR }, { vel: 0.95 }), 40, 4), S.intro),            // intro → end of the acid section
  at(repeat(drums({ kick: FLOOR }, { vel: 1 }), 16, 4), S.peak),
  at(repeat(drums({ kick: FLOOR }, { vel: 0.95 }), 8, 4), S.outro),
  // Muffle (2): DJ low-pass intro that opens up … and closes again at the end so the loop is seamless
  macroRamp(2, 0.8, 0.0, S.intro, bars(8)),
  macroRamp(2, 0.0, 0.8, S.outro + bars(4), bars(4)),
  // Punch (0) / Room (3)
  macro(0, 0.2, S.intro), macroRamp(0, 0.2, 0.45, S.peak, bars(16)), macro(0, 0.2, S.outro),
  macro(3, 0, S.intro),
);

const clap = merge(
  at(repeat(drums({ clap: '....x.......x...' }, { vel: 0.85 }), 32, 4), S.groove),
  at(drums({ clap: '....x.......x..x' }, { vel: 0.85, accent: 1 }), S.groove + bars(15)),
  // breakdown build: 8ths then 16ths, crescendo
  Array.from({ length: 8 }, (_, i) => ({ beat: S.brk + bars(6) + i * 0.5, type: 'on', note: 39, vel: 0.3 + i * 0.05, dur: 0.1 })),
  Array.from({ length: 16 }, (_, i) => ({ beat: S.brk + bars(7) + i * 0.25, type: 'on', note: 39, vel: 0.5 + i * 0.033, dur: 0.1 })),
  at(repeat(drums({ clap: '....x.......x...' }, { vel: 0.9 }), 16, 4), S.peak),
  at(repeat(drums({ clap: '....x.......x...' }, { vel: 0.85 }), 6, 4), S.outro),
  // Tail (2) / Space (3): the clap gets roomier in the breakdown build and at the peak
  macro(2, 0.2, S.groove), macro(3, 0.1, S.groove), macroRamp(3, 0.1, 0.6, S.brk + bars(6), bars(2)),
  macroRamp(3, 0.35, 0.2, S.peak, bars(4)), macro(3, 0.1, S.outro),
);

// hats: F#2 closed (16ths, velocity-shaped), A#2 open on the off-beats (Quicksilver Hats)
const HAT_CLOSED = { hat: 'xo.oxo.oxo.oxo.o' };
const HAT_OPEN = { openHat: '..x...x...x...x.' };
const hv = { hat: 0.55, openHat: 0.62 };
const hatBar = drums({ ...HAT_CLOSED, ...HAT_OPEN }, { vel: hv, ghost: 0.28 });
const hats = humanize(merge(
  at(repeat(drums({ hat: 'xoxoxoxoxoxoxoxo' }, { vel: 0.5, ghost: 0.26 }), 4, 4), S.intro),
  at(repeat(hatBar, 4, 4), S.intro + bars(4)),
  at(repeat(hatBar, 32, 4), S.groove),
  at(repeat(drums(HAT_OPEN, { vel: 0.5 }), 4, 4), S.brk),
  at(repeat(drums({ hat: 'x.x.x.x.x.x.x.x.' }, { vel: 0.45 }), 2, 4), S.brk + bars(4)),
  at(repeat(drums({ hat: 'xoxoxoxoxoxoxoxo' }, { vel: 0.55, ghost: 0.35 }), 2, 4), S.brk + bars(6)),
  at(repeat(hatBar, 16, 4), S.peak),
  at(repeat(hatBar, 6, 4), S.outro),
  at(repeat(drums({ hat: 'xoxoxoxoxoxoxoxo' }, { vel: 0.5, ghost: 0.26 }), 2, 4), S.outro + bars(6)),
  // Open (0) and Metal (1) rides; Tone (2) stays at the preset's 0.5
  macro(0, 0, S.intro), macro(1, 0, S.intro),
  macroRamp(1, 0, 0.2, S.groove + bars(8), bars(8)), macroRamp(1, 0.2, 0.4, S.acid, bars(16)), macro(1, 0.1, S.brk),
  macroRamp(0, 0, 0.3, S.peak, bars(8)), macroRamp(0, 0.3, 0.1, S.peak + bars(8), bars(8)), macroRamp(1, 0.2, 0.45, S.peak, bars(16)),
  macro(0, 0, S.outro), macroRamp(1, 0.45, 0, S.outro, bars(8)),
), { timing: 0.005, velocity: 0.05, seed: 7 });

// ───────────── offbeat bass (Deep Bass) ─────────────
const BASS_BAR = '..x...x...x...x.';
const BASS_TURN = '..x...x...x..xx.';
function bassBars(bar0, count, { vel = 0.85 } = {}) {
  return perBar(bar0, count, (b, c, k) => {
    const p = k === 3 ? BASS_TURN : BASS_BAR;
    const ev = hitsBar(p, b, [c.bass], { vel, dur: 0.32 });
    if (k === 3) ev[ev.length - 1].note += 12; // octave pop at the end of the cycle
    return ev;
  });
}
const bass = merge(
  bassBars(4, 4, { vel: 0.75 }),                                  // intro bars 5–8
  bassBars(barOf(S.groove), 32),                                  // groove + acid
  // breakdown: bass drops out; returns for the last bar under the build
  hitsBar('x...............', barOf(S.brk) + 7, [36], { vel: 0.8, dur: 3.5 }),
  bassBars(barOf(S.peak), 16, { vel: 0.9 }),
  bassBars(barOf(S.outro), 6, { vel: 0.85 }),
  // Cutoff (0) / Punch (1) / Drive (2): the DJ intro opens the bass filter; the outro closes it again
  macroRamp(0, 0.0, 0.3, S.intro + bars(4), bars(4)), macro(1, 0.3, S.intro), macro(2, 0.1, S.intro),
  macroRamp(0, 0.3, 0.4, S.groove, bars(16)), macroRamp(0, 0.4, 0.25, S.acid, bars(4)),   // make room for the acid line
  macroRamp(0, 0.25, 0.5, S.peak, bars(16)), macroRamp(2, 0.1, 0.35, S.peak, bars(16)),
  macroRamp(0, 0.5, 0.0, S.outro, bars(6)), macro(2, 0.1, S.outro),
);

// ───────────── chord stabs (Velvet Dub Stabs, its chord arp switched off except in the breakdown) ─────────────
const STAB = '..x..x....x..x..';
const STAB_TURN = '..x..x....x..x.x'; // pushes into the next bar (stays off the kick)
const STAB_BUSY = '..x..x.x..x..x.x'; // lift before the drop / second half of the peak
const stabs = merge(
  param('arp.on', false, S.intro),
  perBar(barOf(S.groove), 12, (b, c, k) => hitsBar(k === 3 ? STAB_TURN : STAB, b, c.stab, { vel: 0.74, dur: 0.42 })),
  perBar(barOf(S.groove) + 12, 4, (b, c) => hitsBar(STAB_BUSY, b, c.stab, { vel: 0.76, dur: 0.4 })),
  // acid section: one pushed stab per bar, the dub echo does the rest
  perBar(barOf(S.acid), 16, (b, c, k) => hitsBar(k === 3 ? '..x.......x.....' : '..x.............', b, c.stab, { vel: 0.8, dur: 0.35 })),
  // breakdown: held chords, the preset's own swung 1/8 chord arpeggiator plays them
  param('arp.on', true, S.brk),
  perBar(barOf(S.brk), 8, (b, c) => c.stab.map(n => ({ beat: b * 4, type: 'on', note: n, vel: 0.72, dur: 3.9 }))),
  param('arp.on', false, S.peak - 0.01),
  perBar(barOf(S.peak), 8, (b, c, k) => hitsBar(k === 3 ? STAB_TURN : STAB, b, c.stab, { vel: 0.8, dur: 0.42 })),
  perBar(barOf(S.peak) + 8, 8, (b, c, k) => hitsBar(k === 3 ? STAB_TURN : STAB_BUSY, b, c.stab, { vel: 0.8, dur: 0.4 })),
  perBar(barOf(S.outro), 4, (b, c) => hitsBar('..x.............', b, c.stab, { vel: 0.75, dur: 0.35 })),
  // Filter (0) · Swing (1) · Length (2) · Dub (3)
  macroRamp(0, 0.1, 0.5, S.groove, bars(16)), macro(1, 0, S.groove), macroRamp(2, 0.2, 0.4, S.groove, bars(16)), macro(3, 0.25, S.groove),
  macro(0, 0.35, S.acid), macroRamp(3, 0.35, 0.7, S.acid, bars(16)),
  macro(0, 0.25, S.brk), macroRamp(1, 0.0, 0.6, S.brk, bars(6)), macroRamp(2, 0.5, 0.8, S.brk, bars(8)), macroRamp(0, 0.25, 0.7, S.brk + bars(4), bars(4)),
  macroRamp(0, 0.6, 0.8, S.peak, bars(16)), macro(1, 0, S.peak), macro(2, 0.25, S.peak), macroRamp(3, 0.3, 0.45, S.peak, bars(16)),
  macroRamp(3, 0.45, 0.9, S.outro, bars(4)), macroRamp(0, 0.7, 0.3, S.outro, bars(4)),
);

// ───────────── acid line (Acid Serpent) ─────────────
// 16ths; '!' accent (opens the filter envelope harder), '~' slide into the next note
const ACID_A = 'F2! F2 F3 F2 . Ab2 C3! F2 Eb3 . F3! F2 . C3 ~Bb2 Ab2 |' +
  'F2! F2 F3 F2 . C3 Eb3! F3 G3 . F3! Eb3 C3 . ~Ab2! G2';
const ACID_B = 'F2! F3 F2 F3! . Ab3 G3 F3 Eb3! . C3 Eb3 . F3! ~G3 Ab3 |' +
  'F3! . F2 F3 C4 . Bb3! Ab3 G3! . F3 Eb3 C3! . ~Eb3 F3';
const ACID_BRK = 'F2! . F3 . Ab2 . C3 . | Eb3! . F2 . C3 . Bb2 . |';
const acidLine = (str, start, opts = {}) => melody(str, { step: 0.25, start, vel: 0.7, accent: 0.98, gate: 0.6, ...opts });
const acid = merge(
  at(repeat(acidLine(ACID_A, 0), 4, 8), S.acid),
  at(repeat(acidLine(ACID_B, 0), 4, 8), S.acid + bars(8)),
  at(repeat(melody(ACID_BRK, { step: 0.5, vel: 0.65, accent: 0.9, gate: 0.5 }), 3, 8), S.brk),
  at(acidLine(ACID_A, 0), S.brk + bars(6)),
  at(repeat(acidLine(ACID_A, 0), 4, 8), S.peak),
  at(repeat(acidLine(ACID_B, 0), 4, 8), S.peak + bars(8)),
  at(acidLine(ACID_A, 0), S.outro),
  // The acid-house filter ride: the filter's cutoff and envelope amount are automated directly (the envelope is
  // what makes a 303 line bright, so a muted thud can bloom into a squelch), the macros Cutoff (0) · Resonance (1)
  // · Env Mod (2) · Drive (3) ride on top.
  macro(0, 0, S.intro), macro(1, 0, S.intro), macro(2, 0, S.intro), macro(3, 0, S.intro),
  // acid section: 8 bars from a muted thud to the preset's own squelch, then 8 bars beyond it
  ramp('filter.env', 0.05, 0.55, S.acid, bars(8)), ramp('filter.cutoff', 170, 380, S.acid, bars(8)),
  ramp('filter.env', null, 0.8, S.acid + bars(8), bars(8)), ramp('filter.cutoff', null, 750, S.acid + bars(8), bars(8)),
  macroRamp(2, 0.1, 0.4, S.acid, bars(16)), macroRamp(1, 0.15, 0.6, S.acid + bars(8), bars(8)),
  // breakdown: dark and resonant, then the riser sweep
  param('filter.env', 0.3, S.brk), param('filter.cutoff', 240, S.brk), macro(1, 0.85, S.brk), macro(2, 0.3, S.brk),
  ramp('filter.cutoff', 240, 1400, S.brk + bars(4), bars(4)), ramp('filter.env', 0.3, 0.9, S.brk + bars(4), bars(4)),
  // peak: open, driven, the cutoff breathes in 4-bar waves
  param('filter.env', 0.7, S.peak), macro(1, 0.5, S.peak),
  automate('filter.cutoff', [[S.peak, 500], [S.peak + bars(4), 1300], [S.peak + bars(8), 450], [S.peak + bars(12), 1600], [S.peak + bars(16), 700]]),
  macro(2, 0.25, S.peak), macroRamp(3, 0.1, 0.45, S.peak, bars(16)),   // (Drive thickens and darkens: keep it moderate)
  // outro: closes and leaves
  ramp('filter.cutoff', 700, 160, S.outro, bars(2)), ramp('filter.env', 0.7, 0.1, S.outro, bars(2)), macroRamp(3, 0.45, 0, S.outro, bars(2)),
);

export default {
  id: 'pulse-city',
  title: 'Pulse City',
  zh: '脈動城市',
  genre: 'House',
  zhGenre: '浩室舞曲',
  description: 'F 小調城市浩室：四拍大鼓、反拍貝斯與深浩室九和弦刺擊；303 酸性線的濾波器從悶響一路綻放成尖嘯，崩落段由琶音器自動彈奏搖擺和弦，可無縫循環。',
  descriptionEn: 'City house in F minor: four-on-the-floor kick, off-beat bass and deep-house ninth-chord stabs; a 303 acid line opens from a muffled growl to a scream, and in the breakdown the arpeggiator plays swinging chords. Loops seamlessly.',
  bpm: 124,
  key: { root: 'F', scale: 'minor' },
  lengthBeats: S.end,
  loop: true,
  cover: { colors: ['#c6ff3d', '#ff9f1c', '#ff2e88'] },
  sections: [
    { beat: S.intro, name: 'Ignition', zh: '點火' },
    { beat: S.groove, name: 'Warehouse', zh: '倉庫律動' },
    { beat: S.acid, name: 'Acid Line', zh: '酸性線條' },
    { beat: S.brk, name: 'Zero Gravity', zh: '失重' },
    { beat: S.peak, name: 'Peak Time', zh: '高峰時刻' },
    { beat: S.outro, name: 'Afterhours', zh: '散場' },
  ],
  parts: [
    // kick −3 dB (was −4): the phys retune fix (no +dB burst while the pitch envelope drops) left Anvil Kick ≈ 3 LU
    // quieter and thinner; the preset's low shelf (eq.low 3 → 6) and this +1 dB bring it back to ≈ −23.7 LUFS
    // (acid −0.5 dB for it: kick + clap + acid on the same downbeats stay ≤ −1 dBFS before the safety limiter)
    { name: 'Kick', zh: '大鼓', role: 'drums', preset: 'Anvil Kick', gain: -3, pan: 0, events: kick },
    { name: 'Clap', zh: '拍手', role: 'drums', preset: 'Stadium Clap', gain: -3, pan: 0, events: clap },
    { name: 'Hats', zh: '腳踏鈸', role: 'drums', preset: 'Quicksilver Hats', macros: [0, 0, 0.5, 0], gain: -9, pan: 0.25, events: hats },
    { name: 'Bass', zh: '反拍貝斯', role: 'bass', preset: 'Deep Bass', gain: -1, pan: 0, events: bass },
    { name: 'Stabs', zh: '和弦刺擊', role: 'keys', preset: 'Velvet Dub Stabs', params: { 'arp.on': false, 'voice.poly': 8 }, gain: -4, pan: -0.2, events: stabs },
    { name: 'Acid', zh: '酸性貝斯', role: 'lead', preset: 'Acid Serpent', params: { 'filter2.type': 'hp', 'filter2.cutoff': 110 }, gain: 0, pan: 0.1, events: acid },
  ],
};
