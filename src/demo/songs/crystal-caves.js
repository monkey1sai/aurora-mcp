// 水晶洞窟 Crystal Caves — cinematic, E minor, 100 BPM, 56 bars (≈2:15), one pass ending in E major.
//
// Form: 洞口 Cave Mouth (glass drips, low strings, distant ō-daiko, the celesta motif appears) →
// 水晶迴廊 Crystal Corridor (i–VI–III–VII, heartbeat taiko) → 共鳴 Resonance (ostinato + horn call, bII colour) →
// 地底湖 Underground Lake (breakdown) → 甦醒 Awakening (the build: taiko roll, ostinato bite, strings crescendo) →
// 水晶之心 Heart of Crystal (full theme) → 重見天光 Into the Light (deceptive C, then C–D–E: the heroic Picardy ending).
// Hook: the celesta alternates a stepwise four-note cell with a ringing B5 pedal — the crystal "drip" of the caves;
// at the heart it opens into chord arpeggios under the horn + violin theme (so the pedal never rubs the melody).
// Auto-tweaking: strings Dynamics/Aurora, ostinato Bite/Range, taiko Tension/Hall, celesta Hall/Steel,
// glass Downpour + arp rate, horn Bite/Section ride every section.
import { midi, melody, merge, humanize, velocity, transpose, automate, param, macro } from '../songlib.js';

const SECTIONS = [
  { key: 'intro', name: 'Cave Mouth', zh: '洞口', prog: [['Emadd9', 8], ['Cmaj7', 8], ['Emadd9', 8], ['Cmaj7', 4], ['B7sus4', 4]] },
  { key: 'a', name: 'Crystal Corridor', zh: '水晶迴廊', prog: [['Em', 4], ['Cmaj7', 4], ['G', 4], ['D/F#', 4], ['Em', 4], ['Cmaj7', 4], ['Am7', 4], ['B7sus4', 2], ['B7', 2]] },
  { key: 'b', name: 'Resonance', zh: '共鳴', prog: [['Am', 4], ['Em/G', 4], ['Cmaj7', 4], ['D', 4], ['Am', 4], ['Em/G', 4], ['F', 4], ['B7', 4]] },
  { key: 'lake', name: 'Underground Lake', zh: '地底湖', prog: [['Cmaj7', 8], ['Emadd9', 8]] },
  { key: 'build', name: 'Awakening', zh: '甦醒', prog: [['Am', 4], ['C', 4], ['D', 4], ['B7sus4', 2], ['B7', 2]] },
  { key: 'climax', name: 'Heart of Crystal', zh: '水晶之心', prog: [['Em', 4], ['C', 4], ['G', 4], ['D', 4], ['Em', 4], ['C', 4], ['Am', 4], ['B7', 4],
    ['Em', 4], ['C', 4], ['G', 4], ['D/F#', 4], ['Am', 4], ['F', 4], ['B7sus4', 4], ['B7', 4]] },
  { key: 'outro', name: 'Into the Light', zh: '重見天光', prog: [['Cmaj7', 8], ['D', 8], ['E', 16]] },
];
let at = 0;
const CH = [];
SECTIONS.forEach(s => {
  s.beat = at;
  for (const [sym, beats] of s.prog) { CH.push({ sym, beat: at, beats, sec: s.key }); at += beats; }
  s.end = at;
});
const LEN = at; // 224 beats = 56 bars
const S = Object.fromEntries(SECTIONS.map(s => [s.key, s.beat]));
const on = (beat, note, vel, dur) => ({ beat, type: 'on', note, vel, dur });
const notes = list => list.split(' ').map(midi);
const chordsIn = (...keys) => CH.filter(c => keys.includes(c.sec));

// Horn call (Resonance) and the theme (Heart of Crystal), quarter-note grid
const CALL = 'C5 - - B4 | G4 - - E4 | E5 - - D5 | F#5 - - - | C5 - - B4 | G4 - E4 G4 | A4 - - C5 | B4 - - .';
const THEME_1 = 'E4 - - B4 | C5 - B4 A4 | B4 - - D5 | A4 - - - | E4 - - B4 | C5 - D5 E5 | E5 - D5 C5 | B4 - - .';
const THEME_2 = 'G5 - - F#5 | E5 - - C5 | D5 - B4 D5 | A5 - - F#5 | A5 - G5 E5 | A5 - G5 F5 | E5 - - - | D#5 - - .';

// ── Strings (Aurora Symphony): hand-voiced; its −1 oct contrabass layer doubles the lowest note ──
const STR = {
  Emadd9: 'E3 B3 F#4 G4', Em: 'E3 B3 E4 G4', Cmaj7: 'C3 G3 E4 B4', C: 'C3 G3 C4 E4', G: 'G2 D3 B3 G4',
  'D/F#': 'F#2 D3 A3 F#4', D: 'D3 A3 D4 F#4', Am7: 'A2 E3 C4 G4', Am: 'A2 E3 C4 A4', B7sus4: 'B2 F#3 A3 E4',
  B7: 'B2 F#3 A3 D#4', 'Em/G': 'G2 E3 B3 G4', F: 'F2 C3 A3 F4', E: 'E3 B3 E4 G#4',
};
const STR_VEL = { intro: 0.56, a: 0.68, b: 0.66, lake: 0.5, build: 0.7, climax: 0.8, outro: 0.8 };
const strings = merge(
  CH.filter(c => c.sec !== 'outro' || c.sym !== 'E').map(c => notes(STR[c.sym]).map(n => on(c.beat, n, STR_VEL[c.sec], c.beats + 0.05))),
  // the final chord: wide E major with the open fifth on top
  notes('E2 B2 E3 G#3 B3 E4').map(n => on(S.outro + 16, n, 0.85, 14)),
  // the violins join the horn on the theme: an octave above it first, then in unison when it climbs
  transpose(melody(THEME_1, { step: 1, start: S.climax, vel: 0.62, gate: 1 }), 12),
  melody(THEME_2, { step: 1, start: S.climax + 32, vel: 0.62, gate: 1 }),
  automate({ macro: 0 }, [[0, 0.3], [30, 0.4], [32, 0.45], [64, 0.5], [96, 0.2], [112, 0.25], [127, 0.88], [176, 0.92], [192, 0.65], [208, 0.85]]), // Dynamics
  automate({ macro: 1 }, [[0, 0], [112, 0], [128, 0.45], [192, 0.1]]), // Bowing (bite of the attacks)
  automate({ macro: 2 }, [[0, 0.2], [64, 0.4], [128, 0.7], [192, 0.5]]), // Ensemble
  automate({ macro: 3 }, [[0, 0.85], [32, 0.2], [96, 0.85], [112, 0.5], [128, 0.3], [192, 0.45], [208, 0.9]]), // Aurora (shimmer)
);

// ── Ostinato (Storm Ostinato): its arp plays 16ths through root–5–8–10 held in octave 3 ──
const ROOT_PC = { E: 4, C: 0, G: 7, D: 2, A: 9, B: 11, F: 5 };
const ostVoicing = sym => {
  const r = 48 + ROOT_PC[sym[0]], third = /sus4/.test(sym) ? 5 : /^[A-G]m(?!aj)/.test(sym) ? 3 : 4;
  return [r, r + 7, r + 12, r + 12 + third];
};
const OST_VEL = { b: 0.62, build: 0.7, climax: 0.68, outro: 0.66 };
const ostinato = merge(
  CH.filter(c => c.sec === 'b' || c.sec === 'build' || c.sec === 'climax' || (c.sec === 'outro' && c.sym !== 'E'))
    .map(c => ostVoicing(c.sym).map(n => on(c.beat, n, OST_VEL[c.sec], c.beats - 0.02))),
  automate({ macro: 1 }, [[64, 0.1], [92, 0.35], [112, 0.1], [127.5, 0.95], [128, 0.45], [176, 0.7], [192, 0.35]]), // Bite (filter/drive)
  automate({ macro: 0 }, [[64, 0.25], [112, 0], [128, 0.3], [192, 0.6]]), // Length
  [macro(2, 0, 64), macro(2, 1, 160), macro(2, 0, 192)], // Range: three octaves for the second half of the climax
  automate({ macro: 3 }, [[64, 0.2], [128, 0.3], [192, 0.6]]), // Hall
);

// ── Celesta (Sugar Plum Celesta): stepwise cell against a ringing B5 pedal, in 8ths ──
const CELL = {
  Emadd9: 'E5 F#5 G5 F#5', Em: 'E5 F#5 G5 F#5', Cmaj7: 'G5 E5 D5 E5', C: 'G5 E5 D5 E5', G: 'D5 E5 G5 E5',
  'D/F#': 'F#5 E5 D5 E5', D: 'F#5 E5 D5 E5', Am7: 'A4 B4 C5 B4', Am: 'A4 B4 C5 B4', B7sus4: 'E5 F#5 A5 F#5',
  B7: 'D#5 F#5 A5 F#5', 'Em/G': 'E5 F#5 G5 F#5', F: 'F5 G5 A5 G5', E: 'E5 F#5 G#5 F#5',
};
const ARP = {
  Em: 'E5 G5 B5 E6', C: 'C5 E5 G5 E5', G: 'D5 G5 B5 G5', D: 'D5 F#5 A5 F#5', 'D/F#': 'D5 F#5 A5 F#5',
  Am: 'C5 E5 A5 E5', B7: 'D#5 F#5 A5 F#5', F: 'C5 F5 A5 F5', B7sus4: 'E5 F#5 B5 F#5',
};
const PEDAL = midi('B5');
const celestaBar = (sym, beat, beats, vel) => {
  const cell = notes(CELL[sym]), out = [];
  for (let i = 0; i < beats * 2; i++) {
    const b = beat + i * 0.5, even = i % 2 === 0;
    out.push(on(b, even ? cell[(i >> 1) % 4] : PEDAL, even ? vel : vel * 0.72, 0.45));
  }
  return out;
};
const CEL_VEL = { intro: 0.6, a: 0.72, b: 0.5, lake: 0.7, build: 0.64, climax: 0.6, outro: 0.58 };
const celesta = merge(
  humanize(merge(
    CH.filter(c => (c.sec === 'intro' && c.beat >= 16) || ['a', 'lake', 'build'].includes(c.sec) || (c.sec === 'outro' && c.sym !== 'E'))
      .map(c => celestaBar(c.sym, c.beat, c.beats, CEL_VEL[c.sec])),
    // Heart of Crystal: the cell opens into chord arpeggios under the theme (no pedal against the melody)
    chordsIn('climax').map(c => { const a = notes(ARP[c.sym]); return Array.from({ length: c.beats * 2 }, (_, i) =>
      on(c.beat + i * 0.5, a[i % 4], CEL_VEL.climax * (i % 4 ? 0.8 : 1), 0.45)); }),
    // Resonance: the cell alone in quarters (no pedal), leaving room for the horn call
    chordsIn('b').map(c => notes(CELL[c.sym]).map((n, i) => on(c.beat + i, n + 12, CEL_VEL.b * (i ? 0.8 : 1), 0.9))),
    // the last word: one rising E-major arpeggio that rings into the silence
    melody('E5 G#5 B5 E6 - - - -', { step: 0.5, start: S.outro + 16, vel: 0.6, gate: 3 }),
  ), { timing: 0.006, velocity: 0.05, seed: 3 }),
  automate({ macro: 3 }, [[0, 0.8], [32, 0.4], [96, 0.9], [112, 0.5], [128, 0.3], [192, 0.8]]), // Hall
  automate({ macro: 0 }, [[0, 0.2], [32, 0.4], [128, 0.6], [192, 0.3]]), // Sweetness
  automate({ macro: 1 }, [[0, 0], [96, 0.1], [112, 0.4], [128, 0.5], [192, 0.2]]), // Steel
  automate({ macro: 2 }, [[0, 0.5], [32, 0.2], [96, 0.6], [128, 0.2], [192, 0.7]]), // Sustain
);

// ── Glass (Glass Rain): held crystal notes; its random arp drips — rate and Downpour ride the form ──
const drip = (beat, beats, list, vel) => notes(list).map(n => on(beat, n, vel, beats));
const glass = merge(
  drip(S.intro, 32, 'E5 B5', 0.5),
  drip(S.lake, 16, 'E5 B5', 0.48),
  drip(S.build, 14, 'E5 B5', 0.42),
  drip(S.climax + 32, 20, 'B5 E6', 0.26),
  drip(S.outro + 16, 12, 'E5 G#5 B5', 0.45),
  [param('arp.rate', '1/8', 0), param('arp.rate', '1/16', S.build), param('arp.rate', '1/32', S.build + 12),
    param('arp.rate', '1/16', S.climax), param('arp.rate', '1/8', S.outro)],
  automate({ macro: 3 }, [[0, 0.7], [96, 0.8], [112, 0.5], [160, 0.4], [192, 0.8]]), // Space
  automate({ macro: 0 }, [[0, 0], [112, 0], [128, 0.8], [160, 0.3], [192, 0]]), // Downpour
);

// ── Taiko (Thunder Taiko): ō-daiko C2 · nagado G2/D3 · shime C4 ──
const O = midi('C2'), M = midi('G2'), N = midi('D3'), SH = midi('C4');
const grid = (beat, pat, note, vel, ghost = vel * 0.45) => [...pat].flatMap((ch, i) =>
  ch === 'x' ? [on(beat + i * 0.25, note, vel, 0.2)] : ch === 'o' ? [on(beat + i * 0.25, note, ghost, 0.2)] : []);
const bars = (from, n, fn) => { const out = []; for (let k = 0; k < n; k++) out.push(fn(from + k * 4, k)); return out.flat(); };
const taiko = merge(
  // Cave Mouth: distant ō-daiko, shime crescendo into the corridor
  on(S.intro, O, 0.9, 0.3), on(S.intro + 16, O, 0.8, 0.3),
  velocity(grid(S.intro + 30, 'xxxxxxxx', SH, 0.6), (v, e) => 0.25 + 0.45 * (e.beat - (S.intro + 30)) / 2),
  // Crystal Corridor: heartbeat
  bars(S.a, 8, (b, k) => merge(grid(b, 'x.......o.......', O, 0.86), k % 4 === 3 ? grid(b, '............x.xx', N, 0.6) : [])),
  // Resonance: half-time groove
  bars(S.b, 8, (b, k) => merge(
    grid(b, 'x.....x...x.....', O, 0.85), grid(b, '....x.......x...', N, 0.7),
    grid(b, k % 4 === 3 ? '..o...o...o.xxxx' : '..o...o...o...o.', SH, 0.55),
  )),
  // Awakening: quarters → 8ths → 16ths, crescendo
  grid(S.build, 'x...x...x...x...', O, 0.6),
  grid(S.build + 4, 'x.x.x.x.x.x.x.x.', O, 0.68),
  merge(grid(S.build + 8, 'x...x...x...x...', O, 0.8), grid(S.build + 8, '..x...x...x.x.x.', N, 0.7)),
  velocity(merge(grid(S.build + 12, 'xxxxxxxxxxxxxxxx', N, 1), grid(S.build + 12, 'x...x...x...xxxx', O, 1)),
    (v, e) => v * (0.5 + 0.5 * (e.beat - (S.build + 12)) / 4)),
  // Heart of Crystal: full groove, fills every fourth bar
  bars(S.climax, 16, (b, k) => merge(
    grid(b, k % 4 === 3 ? 'x.....x...x.x.x.' : 'x.....x...x.....', O, 0.82),
    grid(b, k % 4 === 3 ? '....x.......xxxx' : '....x.......x..o', N, 0.74),
    grid(b, 'x...x.o.x...x.o.', SH, 0.6),
  )),
  // Into the Light: three big strokes, the last one ringing
  on(S.outro, O, 1, 0.3), on(S.outro, N, 0.8, 0.3),
  on(S.outro + 8, O, 1, 0.3), on(S.outro + 8, N, 0.8, 0.3),
  grid(S.outro + 14, 'x.xxxxxx', N, 0.75),
  on(S.outro + 16, O, 1, 0.3), on(S.outro + 16, M, 0.9, 0.3),
  // ring: full 3 s for the lone strokes, 1.6 s inside the grooves so the ō-daiko doesn't turn into a drone
  [param('aenv.d', 1.6, S.a), param('aenv.r', 1.6, S.a), param('aenv.d', 3, S.outro), param('aenv.r', 3, S.outro)],
  automate({ macro: 2 }, [[0, 0.8], [32, 0.4], [64, 0.3], [112, 0.2], [128, 0.35], [192, 0.8]]), // Hall
  automate({ macro: 1 }, [[0, 0], [64, 0.2], [112, 0.1], [128, 0.35], [192, 0.35]]), // Stick
  automate({ macro: 0 }, [[112, 0], [127.5, 0.6], [128, 0]]), // Tension: the roll rises in pitch
);

// ── Horn (Gilded Fanfare): the call in "Resonance", the full theme at the heart, the Picardy ending ──
const horn = merge(
  melody(CALL, { step: 1, start: S.b, vel: 0.58, gate: 0.97 }),
  melody(`${THEME_1} | ${THEME_2}`, { step: 1, start: S.climax, vel: 0.82, gate: 0.97 }),
  melody('E5 - - - | - - D5 E5 | F#5 - - - | - - E5 F#5 | G#5 - - - - - - - - - - -', { step: 1, start: S.outro, vel: 0.8, gate: 0.97 }),
  automate({ macro: 1 }, [[64, 0.5], [128, 0.1], [192, 0.25]]), // Swell (soft attacks for the call)
  automate({ macro: 0 }, [[64, 0], [128, 0.4], [176, 0.7], [192, 0.45]]), // Bite
  automate({ macro: 2 }, [[64, 0.3], [128, 0.7], [192, 0.8]]), // Section
  automate({ macro: 3 }, [[64, 0.45], [128, 0.25], [192, 0.6]]), // Hall
);

export default {
  id: 'crystal-caves',
  title: 'Crystal Caves',
  zh: '水晶洞窟',
  genre: 'Cinematic',
  zhGenre: '電影配樂',
  description: 'E 小調的電影配樂：玻璃水滴與鋼片琴的水晶動機把你帶進地底，弦樂與琶音層層堆疊，太鼓一路推進到「水晶之心」，最後轉進 E 大調重見天光。巨集跟著劇情自動轉動：力度、咬勁、殿堂與微光。',
  descriptionEn: 'A cinematic score in E minor: glass droplets and a celesta motif lead you underground, strings and arpeggios build layer by layer, and taiko drums drive on to the Heart of Crystal before it turns to E major and daylight. The macros follow the story: dynamics, bite, hall and shimmer.',
  bpm: 100,
  key: { root: 'E', scale: 'minor' },
  lengthBeats: LEN,
  loop: false,
  cover: { colors: ['#5cf2ff', '#7b8cff', '#d7f7ff'] },
  sections: SECTIONS.map(s => ({ beat: s.beat, name: s.name, zh: s.zh })),
  parts: [
    // strings −1 dB / glass −1.5 dB: with voice stealing fixed (new chord notes are no longer the ones stolen) and the phys
    // glide fix (Glass Rain), both read 1–2 LU louder than they were mixed; this keeps the horn on top
    { name: 'Strings', zh: '弦樂', role: 'pad', preset: 'Aurora Symphony', params: { 'voice.poly': 6 }, gain: -1.5, pan: -0.05, events: strings },
    { name: 'Ostinato', zh: '跳弓', role: 'arp', preset: 'Storm Ostinato', params: { 'filter2.type': 'hp', 'filter2.cutoff': 120 }, gain: -3, pan: 0.25, events: ostinato },
    { name: 'Celesta', zh: '鋼片琴', role: 'lead', preset: 'Sugar Plum Celesta', params: { 'voice.poly': 3 }, gain: -3.5, pan: -0.3, events: celesta },
    { name: 'Glass', zh: '玻璃雨', role: 'fx', preset: 'Glass Rain', params: { 'voice.poly': 6 }, gain: -5, pan: 0.35, events: glass },
    { name: 'Taiko', zh: '太鼓', role: 'drums', preset: 'Thunder Taiko', params: { 'voice.poly': 5 }, gain: -2.5, pan: 0, events: taiko },
    { name: 'Horn', zh: '銅管', role: 'lead', preset: 'Gilded Fanfare', params: { 'voice.poly': 4 }, gain: 5.5, pan: 0.1, events: horn },
  ],
};
