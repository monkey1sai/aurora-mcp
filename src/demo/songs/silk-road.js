// 絲路 Silk Road — East-Asian pentatonic, 90 BPM, D major pentatonic (D E F♯ A B: the guzheng's own tuning).
//
// Form (46 bars ≈ 2:03, one pass, ends on a ringing D chord):
//   Intro 大漠晨曦 (4) — sunrise pad swell, a guzheng glissando, distant taiko
//   A 駝鈴 (8)        — tabla keherwa groove; the guzheng states the theme (Bm7 · Gmaj7 · Dadd9 · Asus2)
//   B 綠洲 (8)        — the pan flute sings the second theme (Em7 · Gmaj7 · Dadd9 · A6sus2), koto cascades
//   A' 絲綢 (8)       — flute takes the theme, guzheng answers with flowing broken chords, taiko joins
//   月牙泉 (4)        — breakdown: flute alone in a canyon of echoes, shimmer pad, shime-daiko roll
//   飛天 (8)          — climax: theme on flute + guzheng tremolo, taiko + tabla at full tilt, sunrise fully open
//   夕陽 (6)          — the theme once more, slow; falling glissando onto D
//
// Parts: guzheng (Jade Guzheng) · koto cascade (Paper Lantern Echoes, arp) · pan flute (Andes Pan Flute) ·
// sunrise pad (First Light) · tabla (Varanasi Tabla) · taiko (Thunder Taiko).
import { midi, melody, drums, merge, humanize, macro, macroRamp, automate, sortEvents } from '../songlib.js';

const BAR = 4;
const b = n => n * BAR; // bar index → beat
const r4 = x => Math.round(x * 1e6) / 1e6;
const S = { intro: 0, a: 4, b: 12, a2: 20, brk: 28, climax: 32, outro: 40, end: 46 };
const LEN = b(S.end);

// D major pentatonic strings of a guzheng, D2 … D7
const PENT = [];
for (let n = midi('D2'); n <= midi('D7'); n++) if ([2, 4, 6, 9, 11].includes(n % 12)) PENT.push(n);
/** Guzheng glissando (刮奏) from → to (note names, inclusive) with `step` beats per string, crescendo to `vel`. */
function gliss(from, to, start, { step = 0.055, vel = 0.62, dur = 1.5 } = {}) {
  const a = midi(from), z = midi(to), up = z >= a;
  const strings = PENT.filter(n => (up ? n >= a && n <= z : n <= a && n >= z));
  if (!up) strings.reverse();
  return strings.map((n, i) => ({ beat: r4(start + i * step), type: 'on', note: n, vel: Math.round((0.3 + (vel - 0.3) * (i / Math.max(1, strings.length - 1))) * 1000) / 1000, dur }));
}
/** Guzheng tremolo (搖指): a note re-plucked every `rate` beats, alternating strong/soft. */
function tremolo(note, start, beats, { rate = 0.25, vel = 0.5 } = {}) {
  const ev = [];
  const n = Math.max(1, Math.round(beats / rate));
  for (let i = 0; i < n; i++) ev.push({ beat: r4(start + i * rate), type: 'on', note: midi(note), vel: Math.round((i ? (i % 2 ? 0.55 : 0.75) : 1) * vel * 1000) / 1000, dur: rate * 0.8 });
  return ev;
}
/** Melody with every note longer than `min` beats played as a tremolo (for the climax guzheng). */
function tremoloMelody(ev, { min = 1.4, rate = 0.25 } = {}) {
  return ev.flatMap(e => (e.type === 'on' && e.dur >= min ? tremolo(e.note, e.beat, e.dur, { rate, vel: e.vel * 0.9 }) : [e]));
}

// ───────────── harmony ─────────────
const VOX = {
  Bm7: 'B2 F#3 A3 D4', Gmaj7: 'G2 F#3 B3 D4', Dadd9: 'D3 F#3 A3 E4', Asus2: 'A2 E3 B3 E4',
  Em7: 'E2 B2 G3 D4', A: 'A2 E3 B3 F#4' /* A6sus2: stays inside the pentatonic */, Asus4: 'A2 E3 A3 D4', Dfinal: 'D2 A2 F#3 E4 A4',
};
// koto: chord tones held for the arpeggiator (down, 1/8, two octaves → one cascade per bar)
const KOTO = {
  Bm7: 'B3 D4 F#4 A4', Gmaj7: 'B3 D4 E4 F#4', Dadd9: 'A3 D4 E4 F#4', Asus2: 'A3 B3 D4 E4',
  Em7: 'B3 D4 E4 F#4', A: 'A3 B3 E4 F#4', Asus4: 'A3 B3 D4 E4',
};
const PA = [['Bm7', 4], ['Gmaj7', 4], ['Dadd9', 4], ['Asus2', 4]];
const PB = [['Em7', 4], ['Gmaj7', 4], ['Dadd9', 4], ['A', 4], ['Em7', 4], ['Gmaj7', 4], ['Asus4', 4], ['A', 4]];
function timeline(prog, bar) {
  let beat = b(bar);
  return prog.map(([sym, beats]) => { const c = { beat, sym, beats }; beat += beats; return c; });
}
const TL = [
  ...timeline(PA, S.intro), ...timeline(PA, S.a), ...timeline(PA, S.a + 4), ...timeline(PB, S.b),
  ...timeline(PA, S.a2), ...timeline(PA, S.a2 + 4), ...timeline(PA, S.brk), ...timeline(PA, S.climax), ...timeline(PA, S.climax + 4),
  ...timeline(PA, S.outro), { beat: b(S.outro + 4), sym: 'Dfinal', beats: 8 },
];
const inBars = (from, to) => TL.filter(c => c.beat >= b(from) - 1e-6 && c.beat < b(to) - 1e-6);
const notes = s => s.split(' ').map(midi);

// ───────────── themes ─────────────
const THEME_A = 'F#5 - - E5 F#5 A5 B5 - | A5 - F#5 - E5 - D5 E5 | F#5 - - - - - E5 D5 | E5 - - - B4 - - - |' +
  'F#5 - - E5 F#5 A5 B5 - | D6 - B5 - A5 - F#5 A5 | B5 - - A5 F#5 - E5 - | D5 - E5 - B4 - - -';
const THEME_B = 'E5 - - - D5 E5 F#5 A5 | B5 - - - - - A5 B5 | A5 - F#5 - E5 - D5 - | E5 - - - - - - - |' +
  'E5 - - - D5 E5 F#5 A5 | D6 - - - B5 - A5 B5 | A5 - B5 A5 F#5 - E5 - | E5 - - - - - . .';

// ───────────── guzheng (Jade Guzheng) ─────────────
// answers in B (16ths): bar 2, 4, 6, 8 — under the flute's long notes
const ZHENG_B = '. . . . . . . . . . . . . . . . | . . . . . . D6! B5 A5 F#5 . . . . . . |' +
  '. . . . . . . . . . . . . . . . | . . . . B5! A5 F#5 E5 D5 B4 A4 - . . . . |' +
  '. . . . . . . . . . . . . . . . | . . F#5 A5 B5 D6! - - . . . . . . . . |' +
  '. . . . . . . . . . . . . . . . | . . . . E5 F#5 A5 B5! A5 F#5 E5 - . . . .';
/** Flowing broken chords (left-hand root + right-hand pattern) in 8ths, one bar per chord. */
function brokenChords(from, to, vel = 0.5) {
  const ev = [];
  for (const c of inBars(from, to)) {
    const v = notes(VOX[c.sym]);
    const root = v[0] < midi('C3') ? v[0] : v[0] - 12;
    const up = [root, v[1], v[2], v[3], v[2] + 12, v[3], v[2], v[1]];
    up.forEach((n, i) => ev.push({ beat: r4(c.beat + i * 0.5), type: 'on', note: n, vel: i === 0 ? vel + 0.05 : i === 4 ? vel + 0.04 : vel, dur: 0.45 }));
  }
  return ev;
}
const zhengNotes = humanize(merge(
  gliss('D4', 'D6', 0, { vel: 0.5 }),
  melody('. . . . . . . . | B5 - - - - - A5 - | F#5 - - - - - - - | E5 - - - . . . .', { start: b(S.intro), vel: 0.55 }),
  gliss('A4', 'E6', b(S.a) - 0.7, { step: 0.05, vel: 0.5, dur: 1 }),
  melody(THEME_A, { start: b(S.a), vel: 0.85, accent: 0.95 }),
  // left hand: low root on each downbeat under the theme
  ...inBars(S.a, S.b).map(c => ({ beat: c.beat, type: 'on', note: notes(VOX[c.sym])[0] - (notes(VOX[c.sym])[0] >= midi('C3') ? 12 : 0), vel: 0.55, dur: 3.5 })),
  // B: low roots + little answering runs while the flute holds its long notes
  ...inBars(S.b, S.a2).map(c => ({ beat: c.beat, type: 'on', note: notes(VOX[c.sym])[0] - (notes(VOX[c.sym])[0] >= midi('C3') ? 12 : 0), vel: 0.5, dur: 3.5 })),
  melody(ZHENG_B, { start: b(S.b), step: 0.25, vel: 0.5, accent: 0.6 }),
  gliss('D5', 'D4', b(S.a2) - 0.5, { step: 0.06, vel: 0.36, dur: 1 }),
  brokenChords(S.a2, S.brk, 0.46),
  // breakdown: a few ringing harmonics
  melody('D6 - - - - - - - | . . . . B5 - - - | A5 - - - - - - - | . . . . E6 - - -', { start: b(S.brk), vel: 0.4 }),
  gliss('D4', 'B6', b(S.climax) - 1.1, { step: 0.045, vel: 0.42, dur: 0.6 }),
  tremoloMelody(melody(THEME_A, { start: b(S.climax), vel: 0.62 }).map(e => ({ ...e, note: e.note - 12 }))),
  ...inBars(S.climax, S.outro).map(c => ({ beat: c.beat, type: 'on', note: notes(VOX[c.sym])[0] - (notes(VOX[c.sym])[0] >= midi('C3') ? 12 : 0), vel: 0.65, dur: 3.5 })),
  melody('F#5 - - E5 F#5 A5 B5 - | A5 - F#5 - E5 - D5 E5 | F#5 - - - - - E5 D5 | E5 - - - B4 - - -', { start: b(S.outro), vel: 0.52 }),
  gliss('D6', 'D3', b(S.outro + 4), { step: 0.07, vel: 0.42, dur: 3 }),
  { beat: b(S.outro + 4) + 1.5, type: 'on', note: midi('D2'), vel: 0.6, dur: 6 },
  { beat: b(S.outro + 4) + 1.5, type: 'on', note: midi('A2'), vel: 0.5, dur: 6 },
), { timing: 0.008, velocity: 0.05, seed: 201 });
// Macros: 0 Bright · 1 Slide (上滑音 scoop) · 2 Vibrato · 3 Space
const zhengAuto = merge(
  macro(3, 0.5, 0), macro(0, 0.2, 0),
  // scoops into the long theme notes (A section and outro)
  ...[S.a, S.a + 4, S.outro].flatMap(bar => [macro(1, 0.9, b(bar)), macroRamp(1, null, 0.2, b(bar) + 1.5, 2), macroRamp(1, null, 0.9, b(bar + 2) - 0.5, 0.5), macroRamp(1, null, 0, b(bar + 3), 2)]),
  automate({ macro: 2 }, [[b(S.a), 0.2], [b(S.a + 2), 0.7], [b(S.a + 4), 0.2], [b(S.a + 6), 0.7], [b(S.b), 0.3]]),
  automate({ macro: 3 }, [[b(S.a), 0.3], [b(S.brk), 0.3], [b(S.brk + 1), 0.9], [b(S.climax), 0.35], [b(S.outro + 4), 0.4], [b(S.end), 1]]),
  automate({ macro: 0 }, [[b(S.climax), 0.2], [b(S.climax + 8), 0.75], [b(S.outro), 0.3]]),
);

// ───────────── koto cascade (Paper Lantern Echoes: arp down 1/8 over two octaves) ─────────────
const kotoHold = (from, to, vel = 0.55) => inBars(from, to).filter(c => KOTO[c.sym]).flatMap(c => notes(KOTO[c.sym]).map(n => ({ beat: c.beat, type: 'on', note: n, vel, dur: c.beats - 0.05 })));
const kotoNotes = merge(
  kotoHold(S.intro + 2, S.a, 0.4),
  kotoHold(S.a, S.a + 4, 0.36),
  kotoHold(S.a + 4, S.b, 0.45),
  kotoHold(S.b, S.a2, 0.55),
  kotoHold(S.a2 + 4, S.brk, 0.5),
  kotoHold(S.climax, S.outro, 0.62),
);
// Macros: 0 Tone · 1 Sustain · 2 Echo · 3 Swing
const kotoAuto = merge(
  macro(2, 0.3, 0), macro(0, 0.2, 0),
  automate({ macro: 2 }, [[b(S.intro + 2), 0.8], [b(S.a), 0.25], [b(S.b), 0.35], [b(S.b + 8), 0.7], [b(S.a2), 0.3], [b(S.climax), 0.3], [b(S.climax + 8), 0.8]]),
  automate({ macro: 3 }, [[b(S.b), 0], [b(S.b + 4), 0.45], [b(S.a2), 0]]),
  automate({ macro: 0 }, [[b(S.climax), 0.2], [b(S.climax + 8), 0.8]]),
);

// ───────────── pan flute (Andes Pan Flute) ─────────────
const fluteNotes = humanize(merge(
  melody(THEME_B, { start: b(S.b), vel: 0.72 }),
  melody(THEME_A, { start: b(S.a2), vel: 0.74 }),
  melody('B5 - - - - - A5 B5 | D6 - - - - - - - | B5 - A5 - F#5 - E5 - | F#5 - - - - - - -', { start: b(S.brk), vel: 0.6 }),
  melody(THEME_A, { start: b(S.climax), vel: 0.8 }),
  melody('. . . . . . . . | . . . . . . . . | . . . . . . . . | . . . . A5 - B5 - | F#5 - - - - - - - | - - - - . . . .', { start: b(S.outro), vel: 0.62 }),
), { timing: 0.01, velocity: 0.04, seed: 202 });
// Macros: 0 Breath · 1 Vibrato · 2 Echo · 3 Canyon
const fluteAuto = merge(
  macro(1, 0.2, 0), macro(2, 0.15, 0), macro(3, 0.3, 0),
  // vibrato blooms on the long notes of theme B
  ...[1, 3, 5, 7].map(k => macroRamp(1, 0.15, 0.7, b(S.b + k), 3)),
  automate({ macro: 0 }, [[b(S.b), 0.4], [b(S.b + 1), 0.1], [b(S.a2), 0.1], [b(S.brk), 0.5], [b(S.climax), 0.15]]),
  automate({ macro: 2 }, [[b(S.a2), 0.15], [b(S.brk), 0.15], [b(S.brk) + 1, 0.75], [b(S.climax) - 1, 0.75], [b(S.climax), 0.2], [b(S.outro + 3), 0.3], [b(S.end), 0.8]]),
  automate({ macro: 3 }, [[b(S.brk), 0.3], [b(S.brk + 2), 0.8], [b(S.climax), 0.3], [b(S.outro + 4), 0.3], [b(S.end), 0.9]]),
);

// ───────────── sunrise pad (First Light) ─────────────
const padNotes = merge(inBars(S.intro, S.end).map(c => {
  const inBrk = c.beat >= b(S.brk) && c.beat < b(S.climax);
  const vel = c.beat < b(S.a) ? 0.55 : inBrk ? 0.42 : c.beat >= b(S.climax) && c.beat < b(S.outro) ? 0.6 : 0.5;
  return notes(VOX[c.sym]).map(n => ({ beat: c.beat, type: 'on', note: n, vel, dur: c.beats - 0.1 }));
}));
// Macros: 0 Sunrise (filter + harmonics + shimmer) · 1 Attack · 2 Warmth · 3 Space
const padAuto = merge(
  automate({ macro: 0 }, [[0, 0], [b(S.a), 0.75], [b(S.a) + 2, 0.35], [b(S.b), 0.35], [b(S.a2), 0.7], [b(S.brk), 0.5], [b(S.climax), 0.6], [b(S.climax + 8), 1], [b(S.outro), 0.6], [b(S.end), 0.9]]),
  automate({ macro: 2 }, [[b(S.b), 0], [b(S.b + 8), 0.6], [b(S.a2), 0.3]]),
  automate({ macro: 3 }, [[0, 0.4], [b(S.a), 0.2], [b(S.brk), 0.2], [b(S.brk + 2), 0.7], [b(S.climax), 0.3], [b(S.outro), 0.4], [b(S.end), 0.9]]),
  macro(1, 0.3, 0), macro(1, 0.6, b(S.climax)), macro(1, 0.3, b(S.outro)),
);

// ───────────── tabla (Varanasi Tabla: low keys bayan, high keys dayan) ─────────────
// keherwa: Dha Ge Na Ti | Na Ka Dhi Na (8ths)
const KEHERWA = { D2: 'X.x.........x...', C2: '..........o.....', D4: 'x.....o.....x...', A4: '....x...x.....x.' };
const KEHERWA_FILL = { D2: 'X.x.........x...', C2: '..........o.....', D4: 'x.....o.....xox.', A4: '....x...x.x.x.xx', D5: '.............x.x' };
const KEHERWA_LIGHT = { D2: 'x...........x...', D4: '......o.........', A4: '....x...x.....x.' };
const KEHERWA_HOT = { D2: 'X.x...x.x...x.x.', C2: '..........o.....', D4: 'x..o..o.x...x.o.', A4: '.x..x.x..xx..x.x', D5: '...x.......x....' };
function taal(from, to, pats, vel, accent = 0.88) {
  const ev = [];
  for (let bar = from; bar < to; bar++) ev.push(...drums(pats[(bar - from) % pats.length], { start: b(bar), vel, ghost: 0.28, accent }));
  return ev;
}
const tablaNotes = humanize(merge(
  taal(S.a, S.b, [KEHERWA, KEHERWA, KEHERWA, KEHERWA_FILL], { D2: 0.8, C2: 0.3, D4: 0.62, A4: 0.55, D5: 0.45 }),
  taal(S.b, S.a2, [KEHERWA, KEHERWA_LIGHT, KEHERWA, KEHERWA_FILL], { D2: 0.78, C2: 0.3, D4: 0.6, A4: 0.52, D5: 0.45 }),
  taal(S.a2, S.brk, [KEHERWA, KEHERWA, KEHERWA, KEHERWA_FILL], { D2: 0.8, C2: 0.3, D4: 0.62, A4: 0.56, D5: 0.48 }),
  taal(S.climax, S.outro, [KEHERWA_HOT, KEHERWA_HOT, KEHERWA_HOT, KEHERWA_FILL], { D2: 0.85, C2: 0.32, D4: 0.66, A4: 0.6, D5: 0.5 }),
  taal(S.outro, S.outro + 3, [KEHERWA_LIGHT], { D2: 0.7, D4: 0.5, A4: 0.45 }),
), { timing: 0.01, velocity: 0.08, seed: 203, swing: 0.12 });
// Macros: 0 Tune (ge glide) · 1 Stroke · 2 Ring · 3 Room
const tablaAuto = merge(
  macro(2, 0.2, 0), macro(3, 0.15, 0),
  automate({ macro: 1 }, [[b(S.a), 0], [b(S.b), 0.35], [b(S.a2), 0.1], [b(S.climax), 0.5], [b(S.outro), 0.2]]),
  // bayan "ge" pitch glides at the end of fill bars
  ...[S.a + 3, S.a + 7, S.b + 7, S.a2 + 7, S.climax + 3, S.climax + 7].flatMap(bar => [macroRamp(0, 0, 0.45, b(bar) + 3, 0.75), macroRamp(0, null, 0, b(bar + 1), 0.25)]),
  automate({ macro: 3 }, [[b(S.outro), 0.15], [b(S.outro + 3), 0.6]]),
);

// ───────────── taiko (Thunder Taiko: C2 ō-daiko, G2 nagado, C4 shime) ─────────────
const taikoNotes = humanize(merge(
  { beat: 0, type: 'on', note: midi('C2'), vel: 0.7, dur: 1 },
  { beat: b(2), type: 'on', note: midi('C2'), vel: 0.55, dur: 1 },
  ...[0, 2, 4, 6].map(k => ({ beat: b(S.b + k), type: 'on', note: midi('C2'), vel: 0.6, dur: 1 })),
  taal(S.a2, S.brk, [{ C2: 'x.......x.x.....', G2: '............x...' }], { C2: 0.7, G2: 0.5 }),
  // shime-daiko roll into the climax: 16ths → 32nds, crescendo
  ...Array.from({ length: 8 }, (_, i) => ({ beat: b(S.brk + 3) + i * 0.25, type: 'on', note: midi('C4'), vel: 0.25 + i * 0.04, dur: 0.2 })),
  ...Array.from({ length: 8 }, (_, i) => ({ beat: b(S.brk + 3) + 2 + i * 0.125, type: 'on', note: midi('C4'), vel: 0.45 + i * 0.05, dur: 0.1 })),
  taal(S.climax, S.outro, [{ C2: 'X.....x.x.x.....', G2: '....x.......x.x.', C4: '..o...o...o...oo' }, { C2: 'X.....x.x.......', G2: '....x.......x...', C4: '..o...o...o.oooo' }], { C2: 0.76, G2: 0.58, C4: 0.4 }),
  { beat: b(S.outro), type: 'on', note: midi('C2'), vel: 0.62, dur: 1 },
  { beat: b(S.outro + 4) + 1.5, type: 'on', note: midi('C2'), vel: 0.75, dur: 1 },
), { timing: 0.006, velocity: 0.04, seed: 204 });
// Macros: 0 Tension · 1 Stick · 2 Hall · 3 Ring
const taikoAuto = merge(
  macro(2, 0.9, 0), macro(2, 0.3, b(S.a2)),
  macroRamp(0, 0, 0.5, b(S.brk + 3), 4), macro(0, 0, b(S.climax)),
  macroRamp(2, 0.3, 0.8, b(S.outro), 4),
);

export default {
  id: 'silk-road',
  title: 'Silk Road',
  zh: '絲路',
  genre: 'East-Asian Pentatonic',
  zhGenre: '東方五聲音階',
  description: 'D 宮五聲音階的旅程：古箏刮奏迎來大漠晨曦，塔布拉鼓踏出駝隊的步伐，排笛在綠洲與月牙泉邊歌唱，太鼓一響，飛天在敦煌的夕陽裡起舞。',
  descriptionEn: "A journey in D gong pentatonic: guzheng glissandi greet the desert dawn, tabla sets the camel caravan's pace, the pan flute sings by the oasis and Crescent Lake, and with a taiko strike the apsaras dance in the Dunhuang sunset.",
  bpm: 90,
  key: { root: 'D', scale: 'pentMajor' },
  lengthBeats: LEN,
  loop: false,
  cover: { colors: ['#ffc46b', '#ff7a59', '#3ec9b0'] },
  sections: [
    { beat: b(S.intro), name: 'Desert Dawn', zh: '大漠晨曦' },
    { beat: b(S.a), name: 'Caravan', zh: '駝鈴' },
    { beat: b(S.b), name: 'Oasis', zh: '綠洲' },
    { beat: b(S.a2), name: 'Silk', zh: '絲綢' },
    { beat: b(S.brk), name: 'Crescent Spring', zh: '月牙泉' },
    { beat: b(S.climax), name: 'Flying Apsaras', zh: '飛天' },
    { beat: b(S.outro), name: 'Sunset', zh: '夕陽' },
  ],
  parts: [
    { name: 'Guzheng', zh: '古箏', role: 'lead', preset: 'Jade Guzheng',
      // parallel soft clip: rounds off the pluck and glissando peaks (≈ −2 dB crest) without changing the tone
      params: { 'voice.poly': 6, 'drive.on': true, 'drive.type': 'soft', 'drive.amount': 0.4, 'drive.mix': 0.5, 'drive.tone': 0.45 }, gain: 2.1, pan: -0.2, events: sortEvents([...zhengNotes, ...zhengAuto]) },
    { name: 'Koto', zh: '迴聲箏', role: 'arp', preset: 'Paper Lantern Echoes', params: { 'voice.poly': 4 }, gain: -5.4, pan: 0.3, events: sortEvents([...kotoNotes, ...kotoAuto]) },
    { name: 'Flute', zh: '排笛', role: 'lead', preset: 'Andes Pan Flute', gain: -0.4, pan: 0.12, events: sortEvents([...fluteNotes, ...fluteAuto]) },
    { name: 'Pad', zh: '晨光', role: 'pad', preset: 'First Light',
      // shorter wash so the chord changes stay clear under the flute; SVF instead of the 2× oversampled ladder (CPU)
      params: { 'voice.poly': 6, 'aenv.r': 2.5, 'reverb.decay': 5, 'filter.type': 'lp' },
      gain: -5, pan: 0, events: sortEvents([...padNotes, ...padAuto]) },
    { name: 'Tabla', zh: '塔布拉鼓', role: 'drums', preset: 'Varanasi Tabla', params: { 'voice.poly': 4 }, gain: -2.4, pan: 0.08, events: sortEvents([...tablaNotes, ...tablaAuto]) },
    { name: 'Taiko', zh: '太鼓', role: 'drums', preset: 'Thunder Taiko', params: { 'voice.poly': 4 }, gain: -3.8, pan: -0.05, events: sortEvents([...taikoNotes, ...taikoAuto]) },
  ],
};
