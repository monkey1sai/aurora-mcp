// 極光之夢 Aurora Dreams — ambient, D major, 88 BPM, 56 bars (≈2:33), one pass that rings out.
//
// Form: 夜空 Night Sky (pad swells in, the bell motif is born) → 極光初現 First Glow (harp + motif + sub) →
// 光之河 River of Light (vi–IV–I–V, choir and stars enter) → 靜夜 Still Night (breakdown, echoes) →
// 極光綻放 Aurora Bloom (everything, 16th harp cascades) → 餘暉 Afterglow (I ↔ IV/I, the motif is left hanging on the 9th).
// Motif (bells): F♯–A–E rising (3–5–9 of D), then falling back through each chord in dotted steps. Voicings keep every
// 9th below-or-away from the 3rd/root above it, so the long bell and harp rings never rub (no ♭9 / semitone clashes).
// Auto-tweaking: every part rides its macros per section (pad Glow/Motion/Space/Swell, harp Stardust/Echo,
// bells Aurora/Echo, choir Vowel/Heaven, stars Twinkle/Shimmer, sub Harmonics).
import { midi, melody, merge, humanize, velocity, automate } from '../songlib.js';

// Hand-voiced spread chords (lowest note = bass). The harp, choir, stars and sub are all derived from these.
const V = Object.fromEntries(Object.entries({
  'Dmaj9': ['D3', 'A3', 'E4', 'F#4', 'C#5'],
  'Bm7': ['B2', 'A3', 'D4', 'F#4', 'B4'],
  'Gmaj9': ['G2', 'A3', 'D4', 'F#4', 'B4'],
  'A9sus4': ['A2', 'G3', 'D4', 'E4', 'B4'],
  'Gmaj7#11': ['G2', 'B3', 'D4', 'F#4', 'C#5'],
  'Aadd9': ['A2', 'E3', 'C#4', 'E4', 'B4'],
  'Em9': ['E3', 'G3', 'D4', 'F#4', 'B4'],
  'F#m11': ['F#2', 'A3', 'C#4', 'E4', 'B4'],
  'D/F#': ['F#2', 'A3', 'D4', 'E4', 'A4'],
  'Gmaj9/D': ['D3', 'G3', 'B3', 'F#4', 'A4'],
}).map(([k, v]) => [k, v.map(midi)]));

const PROG_A = [['Dmaj9', 4], ['Bm7', 4], ['Gmaj9', 4], ['A9sus4', 4], ['Dmaj9', 4], ['Bm7', 4], ['Gmaj7#11', 4], ['A9sus4', 4]];
const PROG_B = [['Bm7', 4], ['Gmaj9', 4], ['D/F#', 4], ['Aadd9', 4], ['Bm7', 4], ['Gmaj9', 4], ['Em9', 4], ['A9sus4', 4]];

const SECTIONS = [
  { name: 'Night Sky', zh: '夜空', prog: [['Dmaj9', 8], ['Gmaj9', 8], ['Bm7', 8], ['A9sus4', 8]] },
  { name: 'First Glow', zh: '極光初現', prog: PROG_A },
  { name: 'River of Light', zh: '光之河', prog: PROG_B },
  { name: 'Still Night', zh: '靜夜', prog: [['Gmaj7#11', 8], ['F#m11', 8], ['Em9', 8], ['A9sus4', 4], ['Aadd9', 4]] },
  { name: 'Aurora Bloom', zh: '極光綻放', prog: [...PROG_A, ...PROG_B] },
  { name: 'Afterglow', zh: '餘暉', prog: [['Dmaj9', 4], ['Gmaj9/D', 4], ['Dmaj9', 4], ['Gmaj9/D', 4], ['Dmaj9', 16]] },
];

// Absolute timeline: sections[i].beat, chords [{sym, beat, beats, sec}]
let at = 0;
const CH = [];
SECTIONS.forEach((s, i) => {
  s.beat = at;
  for (const [sym, beats] of s.prog) { CH.push({ sym, beat: at, beats, sec: i }); at += beats; }
  s.end = at;
});
const LEN = at; // 224 beats = 56 bars
const S = Object.fromEntries(SECTIONS.map((s, i) => [['intro', 'a', 'b', 'still', 'bloom', 'outro'][i], s.beat]));
const inSec = (i, fn) => merge(CH.filter(c => c.sec === i).map(fn));
const on = (beat, note, vel, dur) => ({ beat, type: 'on', note, vel, dur });

// ── Pad (Aurora Pad): four-note spread voicings (root–5–3–7 style; the harp and bells carry the 9ths) ──
const PAD = Object.fromEntries(Object.entries({
  'Dmaj9': ['D3', 'A3', 'F#4', 'C#5'], 'Bm7': ['B2', 'F#3', 'D4', 'A4'], 'Gmaj9': ['G2', 'A3', 'F#4', 'B4'],
  'A9sus4': ['A2', 'G3', 'D4', 'B4'], 'Gmaj7#11': ['G2', 'B3', 'F#4', 'C#5'], 'Aadd9': ['A2', 'E3', 'C#4', 'B4'],
  'Em9': ['E3', 'G3', 'D4', 'F#4'], 'F#m11': ['F#2', 'A3', 'E4', 'B4'], 'D/F#': ['F#2', 'D3', 'A3', 'E4'],
  'Gmaj9/D': ['D3', 'B3', 'F#4', 'A4'],
}).map(([k, v]) => [k, v.map(midi)]));
const PAD_VEL = [0.6, 0.66, 0.7, 0.56, 0.8, 0.62];
const pad = merge(
  CH.map(c => PAD[c.sym].map(n => on(c.beat, n, PAD_VEL[c.sec], c.beats + 0.05))),
  // Glow opens like dawn, dips for the breakdown, blooms at the climax, fades for the afterglow
  automate({ macro: 0 }, [[0, 0], [30, 0.45], [64, 0.55], [96, 0.6], [104, 0.12], [120, 0.15], [128, 0.9], [176, 1], [192, 0.75], [208, 0.25], [224, 0.12]]),
  // Motion: the bed starts to flow in "River of Light" and at the climax
  automate({ macro: 1 }, [[0, 0.2], [32, 0.35], [64, 0.4], [88, 0.85], [96, 0.55], [128, 0.7], [192, 0.5], [224, 0.3]]),
  // Space: wide and deep in the breakdown and the afterglow
  automate({ macro: 2 }, [[0, 0.8], [32, 0.3], [96, 0.35], [104, 0.8], [124, 0.8], [128, 0.45], [192, 0.5], [224, 0.9]]),
  // Swell: slow attacks in the intro and the outro
  automate({ macro: 3 }, [[0, 0.75], [24, 0.75], [32, 0.25], [96, 0.25], [100, 0.55], [124, 0.55], [128, 0.1], [192, 0.2], [208, 0.8]]),
);

// ── Harp (Starlight Harp): arpeggios through each chord's voicing, extended upward to 8 notes by chord tones
// (skipping any tone a semitone above one already there, so a 9th never rubs against the 3rd or root above it) ──
const pool = sym => {
  const v = V[sym], pcs = new Set(v.map(n => n % 12)), out = v.slice();
  for (let n = v[v.length - 1] + 1; out.length < 8; n++) if (pcs.has(n % 12) && !out.includes(n - 1)) out.push(n);
  return out;
};
const FLOW = [[0, 1, 2, 3, 4, 3, 2, 1], [0, 2, 3, 4, 5, 4, 3, 2]];
const WAVE = [[0, 1, 2, 3, 4, 5, 4, 3], [0, 2, 4, 5, 6, 7, 6, 4]];
const CASCADE = [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 3, 4, 5];
const arpBar = (sym, beat, pattern, rate, vel, accent, gate = 1.6) => pattern.map((k, i) =>
  on(beat + i * rate, pool(sym)[k], i === 0 ? accent : vel, rate * gate));
const harpBars = (c, fn) => { const out = []; for (let b = 0; b < c.beats; b += 4) out.push(fn(c.beat + b, (c.beat + b) / 4)); return out.flat(); };
const harp = merge(
  // Night Sky: one rising gliss into the first glow
  arpBar('A9sus4', S.a - 2, [0, 1, 2, 3, 4, 5, 6, 7], 0.25, 0.42, 0.4, 2),
  inSec(1, c => harpBars(c, (b, bar) => arpBar(c.sym, b, FLOW[bar % 2], 0.5, 0.48, 0.6))),
  inSec(2, c => harpBars(c, (b, bar) => arpBar(c.sym, b, WAVE[bar % 2], 0.5, 0.52, 0.64))),
  // Still Night: silent until two gathering 16th sweeps (crescendo) into the bloom
  velocity(merge(
    arpBar('A9sus4', S.bloom - 8, [...CASCADE.slice(0, 8), ...CASCADE.slice(0, 8)], 0.25, 0.5, 0.55),
    arpBar('Aadd9', S.bloom - 4, [0, 1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7, 7], 0.25, 0.6, 0.65),
  ), (v, e) => Math.min(1, v * (0.55 + 0.5 * (e.beat - (S.bloom - 8)) / 8))),
  inSec(4, c => harpBars(c, b => arpBar(c.sym, b, CASCADE, 0.25, 0.46, 0.62, 1.8))),
  // Afterglow: gentle flow, then one last slow ascent over the final chord
  CH.filter(c => c.sec === 5 && c.beats === 4).map(c => arpBar(c.sym, c.beat, FLOW[0], 0.5, 0.4, 0.5)),
  arpBar('Dmaj9', S.outro + 16, [0, 1, 2, 3, 4, 5, 6, 7], 1, 0.38, 0.45, 3),
);
const harpAuto = merge(
  automate({ macro: 0 }, [[0, 0.1], [32, 0.15], [64, 0.3], [128, 0.55], [192, 0.2]]), // Bright
  automate({ macro: 1 }, [[0, 0.4], [32, 0.2], [64, 0.2], [96, 0.55], [128, 0.6], [184, 0.9], [224, 0.5]]), // Stardust (shimmer)
  automate({ macro: 2 }, [[0, 0.35], [32, 0.15], [64, 0.25], [118, 0.7], [128, 0.3], [192, 0.55]]), // Echo
  automate({ macro: 3 }, [[0, 0.4], [32, 0.2], [192, 0.2], [208, 0.7], [224, 0.45]]), // Ring
);

// ── Bells (Frost Lantern): the motif ──
// 8th-note grid (8 tokens per bar); the dotted figures give the line its lilt
const MOTIF = 'F#5 - A5 - E6 - - - | D6 - - C#6 A5 - - - | B5 - A5 - F#5 - - - | E5 - - - - - . . |' +
  'F#5 - A5 - E6 - - - | F#6 - - E6 D6 - - - | C#6 - - B5 A5 - - - | B5 - - A5 - - - -';
const ANSWER = 'D6 - - - C#6 - - - | B5 - - - - - A5 - | A5 - - - F#5 - E5 - | E5 - - - - - . . |' +
  'D6 - - - E6 - F#6 - | F#6 - - E6 D6 - - - | B5 - - - - - D6 - | E6 - - - - - . .';
const BLOOM2 = 'F#6 - - E6 D6 - - - | B5 - - D6 F#6 - - - | E6 - - D6 C#6 - - - | C#6 - - - - - B5 - |' +
  'F#6 - - E6 D6 - - - | D6 - - B5 D6 - - - | F#6 - - E6 B5 - - - | E6 - - - - - . .';
const bells = merge(
  humanize(merge(
    // Night Sky: the motif is born, slowly
    melody('. . . . A5 - - - | E6 - - - - - - - | F#5 - - - A5 - - - | E6 - - - - - - - | . . . . . . . . | . . . . . . . . | D6 - - - B5 - - - | A5 - - - - - - -', { step: 0.5, start: S.intro, vel: 0.5, gate: 1.4 }),
    melody(MOTIF, { step: 0.5, start: S.a, vel: 0.62, accent: 0.72 }),
    melody(ANSWER, { step: 0.5, start: S.b, vel: 0.58 }),
    melody('F#5 A5 E6 - | - - . . | . . . . | C#6 - A5 - | B5 - - - | . . . . | . . . . | E5 - - .', { step: 1, start: S.still, vel: 0.5 }),
    melody(MOTIF, { step: 0.5, start: S.bloom, vel: 0.74 }),
    melody(BLOOM2, { step: 0.5, start: S.bloom + 32, vel: 0.72 }),
    melody('F#5 - A5 - E6 - - - | D6 - - C#6 A5 - - - | . . . . . . . . | . . . . . . . . | F#5 - A5 - E6 - - - - - - - - - - - - - - - - - - - -', { step: 0.5, start: S.outro, vel: 0.56 }),
  ), { timing: 0.012, velocity: 0.04, seed: 11 }),
  automate({ macro: 0 }, [[0, 0], [32, 0.15], [128, 0.45], [192, 0.2]]), // Crystal
  automate({ macro: 1 }, [[0, 0.5], [32, 0.1], [64, 0.3], [128, 0.4], [192, 0.55]]), // Halo
  automate({ macro: 2 }, [[0, 0.5], [32, 0.15], [96, 0.75], [128, 0.25], [192, 0.6]]), // Echo
  automate({ macro: 3 }, [[0, 0.9], [32, 0.3], [96, 0.8], [128, 0.45], [192, 0.7], [224, 0.95]]), // Aurora (shimmer)
);

// ── Choir (Seraphim Voices): the upper three notes of each chord, from "River of Light" on ──
const CHOIR_VEL = [0, 0, 0.58, 0.5, 0.72, 0.5];
const choir = merge(
  CH.filter(c => c.sec >= 2 && !(c.sec === 5 && c.beat >= S.outro + 8)).map(c => V[c.sym].slice(2).map(n => on(c.beat, n, CHOIR_VEL[c.sec], c.beats + 0.1))),
  V.Dmaj9.slice(2).map(n => on(S.outro + 16, n, 0.42, 12)),
  automate({ macro: 0 }, [[64, 0], [92, 0.8], [128, 0.15], [192, 0.6]]), // Vowel: "ah" → "oo" → open for the bloom
  automate({ macro: 1 }, [[64, 0.1], [96, 0.35], [128, 0.1]]), // Breath
  automate({ macro: 2 }, [[64, 0.2], [128, 0.6], [192, 0.3]]), // Voices
  automate({ macro: 3 }, [[64, 0.15], [96, 0.4], [128, 0.65], [224, 0.9]]), // Heaven
);

// ── Stars (Firefly Constellation): its random arp twinkles over the top two chord tones ──
const starsFrom = (c, vel) => V[c.sym].slice(3).map(n => on(c.beat, n, vel, c.beats));
const stars = merge(
  CH.filter(c => (c.sec === 0 && c.beat >= 16) || (c.sec === 2 && c.beat >= S.b + 16) || c.sec === 3 || c.sec === 4 || (c.sec === 5 && c.beat < S.outro + 16))
    .map(c => starsFrom(c, [0.36, 0, 0.45, 0.5, 0.6, 0.42][c.sec])),
  automate({ macro: 0 }, [[16, 0], [80, 0.2], [128, 0.8], [192, 0.4]]), // Twinkle
  automate({ macro: 1 }, [[16, 0], [80, 0.1], [128, 0.5], [192, 0.2]]), // Bright
  automate({ macro: 2 }, [[16, 0.6], [32, 0.3], [80, 0.2], [100, 0.8], [128, 0.5], [192, 0.8]]), // Shimmer
);

// ── Sub (Abyssal Sub): chord bass in G1–F♯2, out for the breakdown ──
const subNote = sym => { let n = V[sym][0]; while (n > 42) n -= 12; while (n < 31) n += 12; return n; };
const sub = merge(
  CH.filter(c => c.sec === 1 || c.sec === 2 || c.sec === 4).map(c => on(c.beat, subNote(c.sym), c.sec === 4 ? 0.8 : 0.7, c.beats - 0.1)),
  CH.filter(c => c.sec === 5).map(c => on(c.beat, midi('D2'), 0.66, c.beats === 16 ? 10 : c.beats - 0.1)),
  automate({ macro: 0 }, [[32, 0.15], [128, 0.45], [192, 0.2]]), // Harmonics (audible on small speakers)
);

export default {
  id: 'aurora-dreams',
  title: 'Aurora Dreams',
  zh: '極光之夢',
  genre: 'Ambient',
  zhGenre: '氛圍音樂',
  description: 'D 大調的氛圍樂：鋪底像極光一樣緩緩亮起，冰晶鐘聲唱出主題，豎琴琶音如光河流動，天使合唱與星光在高潮一起綻放。每個段落的巨集都會自動轉動：光芒、流動、空間、微光。',
  descriptionEn: 'Ambient in D major: the pad glows in like the aurora, ice-crystal bells sing the theme, harp arpeggios flow like a river of light, and choir and stars bloom together at the climax. The macros turn by themselves in every section: glow, motion, space and shimmer.',
  bpm: 88,
  key: { root: 'D', scale: 'major' },
  lengthBeats: LEN,
  loop: false,
  cover: { colors: ['#39f5a2', '#1fc8b8', '#9d7cff'] },
  sections: SECTIONS.map(s => ({ beat: s.beat, name: s.name, zh: s.zh })),
  parts: [
    // Pad: 6 voices + a shorter release keep the bed within the voice budget; its FM glint is inaudible under the
    // harp and bells here (≤ 0.3 dB in any band) and costs half of the pad's CPU, so it is switched off.
    // −1 dB: with voice stealing fixed (new chord notes are no longer the ones stolen at voice.poly 6) the pad reads ≈ 1 LU louder
    { name: 'Pad', zh: '極光鋪底', role: 'pad', preset: 'Aurora Pad', params: { 'voice.poly': 6, 'aenv.r': 2.6, 'fm.on': false }, gain: -1, pan: 0, events: pad },
    { name: 'Harp', zh: '星光豎琴', role: 'arp', preset: 'Starlight Harp', params: { 'voice.poly': 4 }, gain: -1.5, pan: -0.3, events: merge(humanize(harp, { timing: 0.008, velocity: 0.05, seed: 5 }), harpAuto) },
    { name: 'Bells', zh: '冰晶鐘', role: 'lead', preset: 'Frost Lantern', params: { 'voice.poly': 5 }, gain: 3.5, pan: 0.22, events: bells },
    { name: 'Choir', zh: '天使合唱', role: 'pad', preset: 'Seraphim Voices', params: { 'voice.poly': 4 }, gain: -4, pan: 0, events: choir },
    { name: 'Stars', zh: '螢火星空', role: 'fx', preset: 'Firefly Constellation', params: { 'voice.poly': 3, 'arp.oct': 2 }, gain: -6, pan: 0.1, events: stars },
    { name: 'Sub', zh: '低音', role: 'bass', preset: 'Abyssal Sub', gain: -6.5, pan: 0, events: sub },
  ],
};
