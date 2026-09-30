// AURORA 極光 — generative auto-play ("自動演奏 Jam").
// Pure ES module (no DOM, no Node APIs, no Math.random): the same inputs always give the same song, in the
// browser and in Node (tools/render-jam.mjs renders and checks it offline).
//
//   import { generateJam, STYLES, checkJam } from './generator.js';
//   const song = generateJam({ style: 'lofi', key: 5, scale: 'dorian', bpm: 80, bars: 8, seed: 42,
//     lead: { patch: store.toPatch(), role: 'keys' },
//     backing: { drums: true, bass: bassPatch, pad: padPatch, extra: { patch, role: 'pluck' } },
//     intensity: 0.7, variation: 0 });
//   audio.songLoad(song); audio.songPlay();
//
// Output = engine-ready song for the ensemble engine:
//   { bpm, lengthBeats, loop, sections:[{name, zh, beat, beats, energy}],
//     parts:[{ name, zh, role, slot, color, patch:{params, macros}, gain /*dB*/, pan, events:[sequencer events] }],
//     meta:{ style, key, scale, keyName, chords:[{beat, beats, symbol, root, pcs}], rides:[…], slots:{…}, … } }
// parts[0] is always the user's current preset (the "lead" part, whatever role it plays).
//
// Musical design (per style): a curated chord-progression library filtered to the chosen scale (diatonic chords
// only, built by stacking thirds in the harmony mode), voice-led pad/comp voicings in a comfortable register
// (minimal total movement), motif-based melodies (2-bar call/response phrases, repeated and varied, chord tones on
// strong beats, avoid-notes kept off long notes, rests to breathe), idiomatic bass lines and drum grooves,
// seeded humanisation (timing, velocity, swing), a dynamic arc across the segment (build-up → peak) and macro
// "rides" on the lead part so its timbre evolves audibly. Endless mode = variation 0, 1, 2 … of the same seed:
// same progression family and theme, evolving melody / arrangement / energy.

import { SCALES } from '../dsp/params.js';

// ───────────────────────── seeded RNG ─────────────────────────
/** 32-bit FNV-1a hash of any values (strings/numbers) → uint32 seed. */
export function hashSeed(...xs) {
  let h = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0xff; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG with helpers. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    /** roughly gaussian in −1..1 (triangular sum) */
    tri: () => next() + next() - 1,
    weighted(items, weightOf) {
      let total = 0;
      for (const it of items) total += Math.max(0, weightOf(it));
      if (total <= 0) return items[0];
      let x = next() * total;
      for (const it of items) { x -= Math.max(0, weightOf(it)); if (x <= 0) return it; }
      return items[items.length - 1];
    },
  };
  return r;
}
const rngFor = (...xs) => makeRng(hashSeed(...xs));

// ───────────────────────── theory ─────────────────────────
const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], harmMinor: [0, 2, 3, 5, 7, 8, 11], phrygian: [0, 1, 3, 5, 7, 8, 10],
};
const MODE_FAMILY = { major: 'major', minor: 'minor', dorian: 'dorian', mixolydian: 'mixo', harmMinor: 'harm', phrygian: 'phryg' };
// families that can borrow each other's progressions (validity is still checked chord by chord)
const RELATED = { major: ['mixo'], mixo: ['major'], minor: ['dorian', 'harm'], dorian: ['minor'], harm: ['minor'], phryg: ['minor'] };

/**
 * Scales offered by the jam (ids = params.js SCALES keys, so the play-along scale lock matches exactly).
 * harm: 7-note mode used to build chords; mel: melody pitch classes; passing: notes allowed only as short passing tones.
 */
export const JAM_SCALES = {
  major: { harm: 'major', zh: '大調', en: 'Major' },
  minor: { harm: 'minor', zh: '小調', en: 'Minor' },
  dorian: { harm: 'dorian', zh: '多利安', en: 'Dorian' },
  mixolydian: { harm: 'mixolydian', zh: '混合利底亞', en: 'Mixolydian' },
  pentMajor: { harm: 'major', zh: '大調五聲', en: 'Major Pentatonic', penta: true },
  pentMinor: { harm: 'minor', zh: '小調五聲', en: 'Minor Pentatonic', penta: true },
  blues: { harm: 'dorian', zh: '藍調', en: 'Blues', penta: true, passing: [6] },
  harmMinor: { harm: 'harmMinor', zh: '和聲小調', en: 'Harmonic Minor' },
  inSen: { harm: 'phrygian', zh: '日本陰音階', en: 'In Sen', penta: true },
};
export const JAM_SCALE_IDS = Object.keys(JAM_SCALES);

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const REL_MAJOR_OFFSET = { major: 0, minor: 3, dorian: -2, mixolydian: 5, harmMinor: 3, phrygian: -4 };

const mod12 = x => ((x % 12) + 12) % 12;

function spellingFor(key, harm) {
  const rel = mod12(key + (REL_MAJOR_OFFSET[harm] || 0));
  return [5, 10, 3, 8, 1].includes(rel) ? FLAT_NAMES : SHARP_NAMES;
}

function scaleInfo(scaleId) {
  const id = JAM_SCALES[scaleId] ? scaleId : scaleId === 'wholeTone' ? 'major' : 'minor';
  const s = JAM_SCALES[id];
  const harmPcs = MODES[s.harm];
  const mel = (SCALES[id] || harmPcs).slice();
  return { id, harm: s.harm, family: MODE_FAMILY[s.harm], harmPcs, mel, penta: !!s.penta, passing: s.passing || [] };
}

// chord-type naming from the interval set (relative to the root; 14 = 9th)
const CHORD_NAMES = {
  '0,4,7': '', '0,3,7': 'm', '0,3,6': 'dim', '0,4,8': 'aug', '0,2,7': 'sus2', '0,5,7': 'sus4', '0,7': '5',
  '0,4,7,11': 'maj7', '0,3,7,10': 'm7', '0,4,7,10': '7', '0,3,6,10': 'm7♭5', '0,3,7,11': 'm(maj7)',
  '0,4,7,14': 'add9', '0,3,7,14': 'm(add9)', '0,4,7,9': '6', '0,3,7,9': 'm6', '0,4,7,9,14': '6/9', '0,3,7,9,14': 'm6/9',
  '0,4,7,11,14': 'maj9', '0,3,7,10,14': 'm9', '0,4,7,10,14': '9', '0,2,7,10': '7sus2', '0,5,7,10': '7sus4',
  '0,2,7,11': 'maj7sus2', '0,4,11': 'maj7', '0,3,10': 'm7', '0,4,10': '7', '0,2,7,14': 'sus2', '0,2,7,9': '6sus2',
  '0,2,5,7': 'sus', '0,5,7,14': 'sus4(9)', '0,3,10,14': 'm9', '0,4,11,14': 'maj9', '0,2,10': '7sus2', '0,5,10': '7sus4',
  '0,2,9': '6sus2', '0,4,9': '6', '0,3,9': 'm6', '0,4,14': 'add9', '0,3,14': 'm(add9)', '0,7,14': 'sus2',
};
function chordSuffix(iv) {
  const k = iv.join(',');
  if (k in CHORD_NAMES) return CHORD_NAMES[k];
  const has = x => iv.includes(x);
  if (has(3) && has(10)) return 'm7';
  if (has(4) && has(11)) return 'maj7';
  if (has(4) && has(10)) return '7';
  if (has(3)) return 'm';
  return '';
}

/**
 * Build a diatonic chord on scale degree d (0-based) of the harmony mode.
 * q: undefined (triad + style extensions) | 'sus2' | 'sus4' | '5' | '7' | 'add9' | '6' | '6/9' | '9' | 'triad'
 * ext: { seventh: bool, ninth: bool, six: bool, sus: 'sus2'|'sus4'|null }
 * Returns null if the requested colour is not diatonic here (caller falls back to the triad).
 */
function buildChord(M, d, q, ext = {}) {
  const r = M[d % 7];
  const at = k => mod12(M[(d + k) % 7] - r);
  const third = at(2), fifth = at(4), seventh = at(6), ninth = at(1), eleventh = at(3), sixth = at(5);
  let quality = third === 4 && fifth === 7 ? 'M' : third === 3 && fifth === 7 ? 'm' : third === 3 && fifth === 6 ? 'dim' : third === 4 && fifth === 8 ? 'aug' : '?';
  let iv = [0, third, fifth];
  const want = q || '';
  const addSeventh = want === '7' || want === '9' || (!q && ext.seventh);
  const addNinth = want === '9' || want === 'add9' || want === '6/9' || (!q && ext.ninth);
  const addSix = want === '6' || want === '6/9' || (!q && ext.six && !ext.seventh);
  if (want === 'sus2' || (!q && ext.sus === 'sus2')) { if (ninth !== 2 || quality === 'dim') return q ? null : buildChord(M, d, 'triad'); iv = [0, 2, fifth]; }
  if (want === 'sus4' || (!q && ext.sus === 'sus4')) { if (eleventh !== 5 || fifth !== 7) return q ? null : buildChord(M, d, 'triad'); iv = [0, 5, 7]; }
  if (want === '5') { if (fifth !== 7) return null; iv = [0, 7]; }
  if (addSeventh) {
    // no m(maj7) or augmented colours in a jam; half-diminished only if explicitly allowed
    if (quality === 'm' && seventh === 11) { /* skip the 7th */ } else if (quality !== 'aug') iv.push(seventh);
  }
  if (addSix && sixth === 9 && !iv.includes(9) && quality !== 'dim') iv.push(9);
  if (addNinth && ninth === 2 && quality !== 'dim' && !iv.includes(2)) iv.push(14);
  iv = [...new Set(iv)].sort((a, b) => a - b);
  return { rootOff: r, iv, quality, suffix: chordSuffix(iv) };
}

// ───────────────────────── styles ─────────────────────────
/*
  Progression tokens: degree 1..7 of the harmony mode, optional ".q" colour (sus2, sus4, 7, 9, add9, 6, 6/9, 5).
  fam: harmony-mode family the progression is written for (related families may borrow it if every chord is valid).
*/
const P = (fam, seq, w = 1) => ({ fam, seq, w });

export const STYLES = {
  ambient: {
    id: 'ambient', zh: '氛圍', en: 'Ambient', color: '#8fd8ff', bpm: 70, bpmRange: [56, 92], key: 2, scale: 'major',
    desc: { zh: '緩慢、稀疏、寬廣的長和弦與長音', en: 'Slow, sparse, lush chords & long notes' },
    barsPerChord: 2, swing8: 0, swing16: 0, humanize: 0.018, legato: true,
    ext: { seventh: 0.45, ninth: 0.75, six: 0.15, sus: 0.2 },
    progs: [
      P('major', '1 5 6 4'), P('major', '4 1 5 6'), P('major', '1 3 6 4'), P('major', '6 4 1 5'), P('major', '1 4 6 5'), P('major', '4 5 3 6'),
      P('minor', '1 6 3 7'), P('minor', '1 7 6 7'), P('minor', '6 7 1 1'), P('minor', '1 4 6 7'), P('minor', '1 6 4 7'),
      P('dorian', '1 4 1 4'), P('dorian', '1 7 4 1'), P('dorian', '1 2 4 1'),
      P('mixo', '1 7 4 1'), P('mixo', '1 7 1 4'),
      P('harm', '1 6 4 5'), P('phryg', '1 2 1 2'), P('phryg', '1 2 3 2'),
    ],
    pad: { n: 5, lo: 46, hi: 77, top: 71, maxSpan: 26, open: true },
    melody: { phraseBars: 4, density: 0.35, restEnd: 1.5, cells: 'ambient', leapiness: 0.35 },
    chordRhythm: 'sustain', bassStyle: 'drone', arpStyle: 'ambient', drumStyle: 'ambient',
    kit: [{ id: 'Kick', zh: '大鼓', patch: 'softKick', slots: ['kick'] }, { id: 'Shaker', zh: '沙鈴', patch: 'shaker', slots: ['hat'] }],
    pluckAs: 'arp', bellAs: 'melody',
    energy: [0.55, 0.9],
    enter: { kick: 0.6, snare: 1, hat: 0.5, bass: 0.3, counter: 0.5 },
    mix: { trim: 0.5, bass: -6 }, // dB: whole-jam trim (≈ −16 LUFS) and bass part gain
  },
  lofi: {
    id: 'lofi', zh: '低傳真', en: 'Lo-fi', color: '#ffb38a', bpm: 80, bpmRange: [68, 92], key: 5, scale: 'major',
    desc: { zh: '爵士七和弦與九和弦、搖擺鼓點、慵懶的午後', en: 'Jazzy 7th/9th chords, swung drums, lazy afternoon' },
    barsPerChord: 1, swing8: 0.09, swing16: 0.045, humanize: 0.016, laidBack: 0.018, legato: false,
    ext: { seventh: 1, ninth: 0.65, six: 0, sus: 0 }, allowHalfDim: true,
    progs: [
      P('major', '2 5 1 1', 1.4), P('major', '4 3 2 1'), P('major', '1 6 2 5', 1.2), P('major', '4 5 3 6'), P('major', '2 5 3 6'), P('major', '4 4 3 6'),
      P('minor', '1 4 7 3', 1.3), P('minor', '6 2 5 1'), P('minor', '1 7 6 5'), P('minor', '4 5 1 1'),
      P('dorian', '1 4 1 4'), P('dorian', '1 4 7 1'), P('dorian', '2 1 4 1'),
      P('mixo', '1 7 4 1'), P('harm', '4 5 1 1'), P('phryg', '1 2 1 2'),
    ],
    pad: { n: 4, lo: 50, hi: 74, top: 69, maxSpan: 16, rootless: true },
    melody: { phraseBars: 2, density: 0.55, restEnd: 1.5, cells: 'lofi', leapiness: 0.3 },
    chordRhythm: 'lofiComp', bassStyle: 'lofi', arpStyle: 'lofi', drumStyle: 'lofi',
    kit: [{ id: 'Kick', zh: '大鼓', patch: 'lofiKick', slots: ['kick'] }, { id: 'Snare+Hats', zh: '小鼓＋鈸', patch: 'lofiTop', slots: ['snare', 'hat'] }],
    pluckAs: 'melody', bellAs: 'melody',
    energy: [0.6, 0.85],
    enter: { kick: 0.4, snare: 0.5, hat: 0.3, bass: 0.4, counter: 0.62 },
    mix: { trim: 2, bass: -3.5 }, // dB: whole-jam trim (≈ −17 LUFS; 2.5 pushed the safety limiter > 1 dB) and bass part gain
  },
  synthwave: {
    id: 'synthwave', zh: '合成器浪潮', en: 'Synthwave', color: '#ff6bd6', bpm: 100, bpmRange: [84, 118], key: 9, scale: 'minor',
    desc: { zh: '八分音符貝斯推進、閘門軍鼓、i–VI–III–VII 霓虹夜色', en: 'Driving 8th bass, gated snare, i–VI–III–VII neon night' },
    barsPerChord: 1, swing8: 0, swing16: 0, humanize: 0.005, legato: true,
    ext: { seventh: 0.15, ninth: 0.25, six: 0, sus: 0.08 },
    progs: [
      P('minor', '1 6 3 7', 2), P('minor', '1 7 6 7'), P('minor', '6 7 1 1'), P('minor', '1 6 7 7'), P('minor', '1 4 6 7'),
      P('major', '1 5 6 4'), P('major', '6 4 1 5'), P('major', '4 5 6 6'), P('major', '1 6 4 5'),
      P('dorian', '1 7 4 1'), P('dorian', '1 4 1 7'), P('mixo', '1 7 4 1'), P('harm', '1 6 4 5'), P('phryg', '1 2 1 2'),
    ],
    pad: { n: 4, lo: 48, hi: 74, top: 69, maxSpan: 17 },
    melody: { phraseBars: 2, density: 0.5, restEnd: 1, cells: 'synthwave', leapiness: 0.35 },
    chordRhythm: 'sustain', bassStyle: 'synthwave', arpStyle: 'synthwave', drumStyle: 'synthwave',
    kit: [{ id: 'Kick', zh: '大鼓', patch: 'punchKick', slots: ['kick'] }, { id: 'Snare+Hats', zh: '小鼓＋鈸', patch: 'synthTop', slots: ['snare', 'hat'] }],
    pluckAs: 'arp', bellAs: 'arp',
    energy: [0.65, 1],
    enter: { kick: 0.42, snare: 0.52, hat: 0.35, bass: 0.3, counter: 0.6 },
    mix: { trim: 0, bass: -4 }, // dB: whole-jam trim (≈ −16 LUFS) and bass part gain
  },
  house: {
    id: 'house', zh: '浩室', en: 'House', color: '#6bffd2', bpm: 122, bpmRange: [114, 128], key: 2, scale: 'dorian',
    desc: { zh: '四拍大鼓、反拍貝斯與和弦 stab', en: 'Four-on-the-floor, offbeat bass & chord stabs' },
    barsPerChord: 2, swing8: 0, swing16: 0.018, humanize: 0.004, legato: false,
    ext: { seventh: 0.9, ninth: 0.55, six: 0, sus: 0 },
    progs: [
      P('dorian', '1 4 1 4', 1.5), P('dorian', '1 2 1 2'), P('dorian', '1 4 7 4'),
      P('minor', '1 7 6 7'), P('minor', '1 4 1 4'), P('minor', '1 6 7 1'),
      P('major', '4 5 6 6'), P('major', '2 5 1 1'), P('major', '1 4 6 5'), P('major', '4 5 3 6'),
      P('mixo', '1 7 4 1'), P('harm', '1 4 5 1'), P('phryg', '1 2 1 2'),
    ],
    pad: { n: 4, lo: 53, hi: 75, top: 70, maxSpan: 14 },
    melody: { phraseBars: 2, density: 0.45, restEnd: 1.5, cells: 'house', leapiness: 0.3 },
    chordRhythm: 'houseStab', bassStyle: 'house', arpStyle: 'house', drumStyle: 'house',
    kit: [{ id: 'Kick', zh: '大鼓', patch: 'houseKick', slots: ['kick'] }, { id: 'Clap+Hats', zh: '拍手＋鈸', patch: 'houseTop', slots: ['snare', 'hat'] }],
    pluckAs: 'arp', bellAs: 'arp',
    energy: [0.6, 1],
    enter: { kick: 0.3, snare: 0.5, hat: 0.3, bass: 0.5, counter: 0.6 },
    mix: { trim: 0.5, bass: -3 }, // dB: whole-jam trim (≈ −16 LUFS) and bass part gain
  },
  cinematic: {
    id: 'cinematic', zh: '電影感', en: 'Cinematic', color: '#ffc46b', bpm: 84, bpmRange: [64, 100], key: 2, scale: 'minor',
    desc: { zh: '緩慢鋪陳、固定音型、巨大的漸強', en: 'Slow build, ostinatos, big swells' },
    barsPerChord: 2, swing8: 0, swing16: 0, humanize: 0.008, legato: true,
    ext: { seventh: 0.1, ninth: 0.3, six: 0, sus: 0.12 },
    progs: [
      P('minor', '1 6 3 7', 1.6), P('minor', '1 7 6 7'), P('minor', '6 7 1 1'), P('minor', '1 4 6 7'), P('minor', '1 3 7 4'),
      P('harm', '1 6 4 5', 1.2), P('harm', '1 4 5 1'), P('harm', '6 4 5 5'),
      P('major', '1 5 6 4'), P('major', '6 4 1 5'), P('major', '4 1 5 6'),
      P('dorian', '1 7 4 1'), P('mixo', '1 7 4 1'), P('phryg', '1 2 1 2'), P('phryg', '1 6 7 1'),
    ],
    pad: { n: 5, lo: 43, hi: 76, top: 70, maxSpan: 26, open: true },
    melody: { phraseBars: 2, density: 0.38, restEnd: 1, cells: 'cinematic', leapiness: 0.45 },
    chordRhythm: 'swell', bassStyle: 'cinematic', arpStyle: 'ostinato', drumStyle: 'cinematic',
    kit: [{ id: 'Taiko', zh: '太鼓', patch: 'taiko', slots: ['kick', 'snare'], membrane: true }, { id: 'Tick', zh: '滴答', patch: 'tick', slots: ['hat'] }],
    pluckAs: 'arp', bellAs: 'melody',
    energy: [0.45, 1],
    enter: { kick: 0.45, snare: 0.58, hat: 0.62, bass: 0.35, counter: 0.42 },
    mix: { trim: 0.5, bass: -6 }, // dB: whole-jam trim (≈ −16 LUFS) and bass part gain
  },
  pentatonic: {
    id: 'pentatonic', zh: '東方', en: 'Pentatonic', color: '#3ef0b0', bpm: 88, bpmRange: [66, 104], key: 7, scale: 'pentMajor',
    desc: { zh: '古箏與笛的五聲音階樂句、手鼓律動', en: 'Koto / flute pentatonic phrases, tabla-ish groove' },
    barsPerChord: 2, swing8: 0.03, swing16: 0.02, humanize: 0.012, legato: true, pentaChords: true, grace: true,
    ext: { seventh: 0.35, ninth: 0.3, six: 0.3, sus: 0 },
    progs: [
      P('major', '1 6 2 5', 1.4), P('major', '1 2 6 5'), P('major', '6 5 1 1'), P('major', '1 3 6 5'), P('major', '1 5 6 1'),
      P('minor', '1 7 4 1', 1.2), P('minor', '1 3 7 1'), P('minor', '1 4 5 1'), P('minor', '1 3 4 5'),
      P('dorian', '1 4 1 4'), P('dorian', '1 7 4 1'), P('mixo', '1 7 1 5'), P('harm', '1 4 5 1'), P('phryg', '1 2 1 2'), P('phryg', '1 4 2 1'),
    ],
    pad: { n: 4, lo: 48, hi: 76, top: 71, maxSpan: 22, open: true },
    melody: { phraseBars: 2, density: 0.45, restEnd: 1.5, cells: 'pentatonic', leapiness: 0.4 },
    chordRhythm: 'roll', bassStyle: 'pentatonic', arpStyle: 'koto', drumStyle: 'pentatonic',
    kit: [{ id: 'Tabla', zh: '手鼓', patch: 'tabla', slots: ['kick', 'snare'], membrane: true }, { id: 'Shaker', zh: '沙鈴', patch: 'shaker', slots: ['hat'] }],
    pluckAs: 'melody', bellAs: 'melody',
    energy: [0.5, 0.95],
    enter: { kick: 0.45, snare: 0.4, hat: 0.55, bass: 0.4, counter: 0.6 },
    mix: { trim: 1, bass: -4 }, // dB: whole-jam trim (≈ −16 LUFS) and bass part gain
  },
  chiptune: {
    id: 'chiptune', zh: '8-bit', en: 'Chiptune', color: '#ffe36b', bpm: 140, bpmRange: [120, 168], key: 0, scale: 'major',
    desc: { zh: '快速琶音、方波旋律、電玩冒險', en: 'Fast arps, square-wave hero tunes' },
    barsPerChord: 1, swing8: 0, swing16: 0, humanize: 0, legato: false,
    ext: { seventh: 0, ninth: 0, six: 0, sus: 0 },
    progs: [
      P('major', '1 5 6 4', 1.4), P('major', '1 6 4 5'), P('major', '4 5 3 6'), P('major', '6 4 1 5'), P('major', '1 4 5 1'),
      P('minor', '1 6 7 1', 1.2), P('minor', '1 6 3 7'), P('minor', '1 7 6 7'), P('minor', '6 7 1 1'),
      P('dorian', '1 4 1 4'), P('mixo', '1 7 4 1'), P('harm', '1 4 5 1'), P('phryg', '1 2 1 2'),
    ],
    pad: { n: 3, lo: 53, hi: 74, top: 69, maxSpan: 12 },
    melody: { phraseBars: 2, density: 0.7, restEnd: 1, cells: 'chiptune', leapiness: 0.4 },
    chordRhythm: 'chipArp', bassStyle: 'chiptune', arpStyle: 'chip', drumStyle: 'chiptune',
    kit: [{ id: 'Kick', zh: '大鼓', patch: 'chipKick', slots: ['kick'] }, { id: 'Noise', zh: '噪音鼓', patch: 'chipTop', slots: ['snare', 'hat'] }],
    pluckAs: 'arp', bellAs: 'arp',
    energy: [0.6, 1],
    enter: { kick: 0.35, snare: 0.45, hat: 0.3, bass: 0.3, counter: 0.55 },
    mix: { trim: -1.5, bass: -4 }, // dB: whole-jam trim (≈ −16 LUFS) and bass part gain
  },
};
export const STYLE_IDS = Object.keys(STYLES);

const FALLBACK_PROGS = [P('any', '1 4 5 1'), P('any', '1 6 4 5'), P('any', '1 4 1 4'), P('any', '1 7 4 1'), P('any', '1 2 1 2'), P('any', '1 1 1 1')];

// ───────────────────────── roles & registers ─────────────────────────
/** Categories → the role the current preset plays in the jam. */
export const ROLE_FOR_CATEGORY = { keys: 'keys', pad: 'pad', bass: 'bass', lead: 'lead', pluck: 'pluck', bell: 'bell', strings: 'strings', arp: 'arp', fx: 'fx', drum: 'drum' };
export const ROLE_LABELS = {
  melody: { zh: '旋律', en: 'Melody' }, chords: { zh: '和弦', en: 'Chords' }, comp: { zh: '伴奏和弦＋旋律', en: 'Comping + melody' },
  bass: { zh: '貝斯線', en: 'Bassline' }, arp: { zh: '琶音', en: 'Arpeggio' }, held: { zh: '琶音器和弦', en: 'Arp chords' },
  drums: { zh: '節奏', en: 'Groove' }, texture: { zh: '音景', en: 'Texture' },
};

// melody registers per instrument role (MIDI), matching the factory demo phrases' registers
const MEL_RANGE = {
  lead: { lo: 65, hi: 87, center: 76 }, strings: { lo: 58, hi: 82, center: 71 }, keys: { lo: 67, hi: 86, center: 76 },
  bell: { lo: 67, hi: 91, center: 79 }, pluck: { lo: 60, hi: 84, center: 72 }, arp: { lo: 60, hi: 84, center: 72 },
  pad: { lo: 60, hi: 81, center: 70 }, fx: { lo: 60, hi: 84, center: 72 }, bass: { lo: 36, hi: 55, center: 45 },
};
const BASS_RANGE = { lo: 28, hi: 43 };

/** How a patch wants to be fed: arpeggiator on → hold chords; chord memory → single notes; mono → single line. */
export function patchTraits(patch) {
  const p = (patch && patch.params) || {};
  const mode = p['voice.mode'];
  return {
    arp: p['arp.on'] === true || p['arp.on'] === 1,
    chordMem: !!(p['chord.type'] && p['chord.type'] !== 'off' && p['chord.type'] !== 0),
    mono: mode === 'mono' || mode === 'legato' || mode === 1 || mode === 2,
    glide: Number(p['voice.glide']) > 0.01,
    poly: Number(p['voice.poly']) || 12,
  };
}

// ───────────────────────── built-in drum kit patches ─────────────────────────
// Small, cheap patches (few voices, no heavy FX) — each kit piece is its own ensemble part.
const PITCH_ENV = amt => ({ 'mod1.src': 'menv', 'mod1.dst': 'voice.pitch', 'mod1.amt': amt });
const SINE_BODY = { 'osc1.shape': 0, 'osc1.level': 1, 'osc1.phase': 'reset', 'osc1.drift': 0, 'osc1.filt': 0 };
const NOISE_ONLY = { 'osc1.on': false, 'noise.on': true, 'noise.width': 0.6 };

function topParams({ body = 0, cut = 1000, color = -0.35, lp = 0, crush = 0, clip = 0, reverb = null, comp = 0, decay = 0.28, level = 5 }) {
  const p = {
    'voice.poly': 6, 'osc1.on': body > 0, 'osc1.shape': 0.33, 'osc1.level': body, 'osc1.phase': 'reset', 'osc1.drift': 0, 'osc1.filt': 0,
    'noise.on': true, 'noise.level': 0.9, 'noise.color': color, 'noise.decay': 0, 'noise.width': 0.6, 'noise.filt': 1,
    'filter.type': 'hp', 'filter.cutoff': cut, 'filter.res': 0.12, 'filter.key': 1,
    'aenv.a': 0, 'aenv.d': decay, 'aenv.s': 0, 'aenv.r': 0.035, 'aenv.curve': 0.4,
    'menv.a': 0, 'menv.d': 0.04, 'menv.s': 0, 'menv.r': 0.03, ...PITCH_ENV(0.06),
    'mod2.src': 'note', 'mod2.dst': 'osc1.level', 'mod2.amt': -1,
    'mod3.src': 'note', 'mod3.dst': 'noise.color', 'mod3.amt': 0.8,   // darker (fuller) snare, brighter hats
    'mod4.src': 'note', 'mod4.dst': 'amp.level', 'mod4.amt': -0.28,   // hats sit ≈10 dB under the snare
    'amp.vel': 0.6, 'amp.level': level,
  };
  if (lp) Object.assign(p, { 'filter2.type': 'lp', 'filter2.cutoff': lp });
  if (crush) Object.assign(p, { 'drive.on': true, 'drive.type': 'crush', 'drive.amount': crush, 'drive.mix': crush > 0.5 ? 1 : 0.4, 'drive.tone': 0.45 });
  else if (clip) Object.assign(p, { 'drive.on': true, 'drive.type': 'soft', 'drive.amount': 0, 'drive.mix': clip }); // peak soft clip (unity gain)
  if (reverb) Object.assign(p, { 'reverb.on': true, 'reverb.size': reverb[0], 'reverb.decay': reverb[1], 'reverb.mix': reverb[2], 'reverb.damp': 0.4 });
  if (comp) p['comp.amount'] = comp;
  return p;
}

export const KIT = {
  // kicks
  punchKick: {
    zh: '重拍大鼓', params: {
      'voice.poly': 3, ...SINE_BODY, 'noise.on': true, 'noise.level': 0.22, 'noise.color': 0.3, 'noise.decay': 0.01, 'noise.filt': 1,
      'filter.type': 'lp', 'filter.cutoff': 4000, 'filter.key': 0,
      'aenv.a': 0, 'aenv.d': 0.42, 'aenv.s': 0, 'aenv.r': 0.1, 'aenv.curve': 0.55,
      'menv.a': 0, 'menv.d': 0.07, 'menv.s': 0, 'menv.r': 0.05, 'menv.curve': 0.3, ...PITCH_ENV(0.36),
      'amp.vel': 0.45, 'drive.on': true, 'drive.type': 'soft', 'drive.amount': 0.3, 'drive.tone': 0.4, 'amp.level': 6,
    },
  },
  houseKick: {
    zh: '浩室大鼓', params: {
      'voice.poly': 3, ...SINE_BODY, 'noise.on': true, 'noise.level': 0.16, 'noise.color': 0.2, 'noise.decay': 0.008, 'noise.filt': 1,
      'filter.type': 'lp', 'filter.cutoff': 3500, 'filter.key': 0,
      'aenv.a': 0, 'aenv.d': 0.3, 'aenv.s': 0, 'aenv.r': 0.08, 'aenv.curve': 0.5,
      'menv.a': 0, 'menv.d': 0.05, 'menv.s': 0, 'menv.r': 0.04, 'menv.curve': 0.3, ...PITCH_ENV(0.4),
      'amp.vel': 0.35, 'drive.on': true, 'drive.type': 'tube', 'drive.amount': 0.25, 'drive.tone': 0.45, 'amp.level': 6,
    },
  },
  softKick: {
    zh: '柔和大鼓', params: {
      'voice.poly': 2, ...SINE_BODY, 'filter.type': 'lp', 'filter.cutoff': 1200, 'filter.key': 0,
      'aenv.a': 0.002, 'aenv.d': 0.5, 'aenv.s': 0, 'aenv.r': 0.2, 'aenv.curve': 0.6,
      'menv.a': 0, 'menv.d': 0.09, 'menv.s': 0, 'menv.r': 0.05, 'menv.curve': 0.35, ...PITCH_ENV(0.22),
      'amp.vel': 0.6, 'reverb.on': true, 'reverb.size': 0.7, 'reverb.decay': 2.5, 'reverb.mix': 0.12, 'amp.level': 6,
    },
  },
  lofiKick: {
    zh: '低傳真大鼓', params: {
      'voice.poly': 2, ...SINE_BODY, 'noise.on': true, 'noise.level': 0.12, 'noise.color': -0.2, 'noise.decay': 0.02, 'noise.filt': 1,
      'filter.type': 'lp', 'filter.cutoff': 1600, 'filter.key': 0,
      'aenv.a': 0.001, 'aenv.d': 0.32, 'aenv.s': 0, 'aenv.r': 0.1, 'aenv.curve': 0.5,
      'menv.a': 0, 'menv.d': 0.06, 'menv.s': 0, 'menv.r': 0.05, 'menv.curve': 0.35, ...PITCH_ENV(0.3),
      'amp.vel': 0.55, 'drive.on': true, 'drive.type': 'tube', 'drive.amount': 0.35, 'drive.tone': 0.3, 'amp.level': 6,
    },
  },
  chipKick: {
    zh: '8-bit 大鼓', params: {
      'voice.poly': 2, 'osc1.shape': 1, 'osc1.pw': 0.5, 'osc1.level': 0.75, 'osc1.phase': 'reset', 'osc1.drift': 0, 'osc1.filt': 0,
      'aenv.a': 0, 'aenv.d': 0.14, 'aenv.s': 0, 'aenv.r': 0.03, 'aenv.curve': 0.4,
      'menv.a': 0, 'menv.d': 0.06, 'menv.s': 0, 'menv.r': 0.03, 'menv.curve': 0.2, ...PITCH_ENV(0.42),
      'amp.vel': 0.4, 'drive.on': true, 'drive.type': 'crush', 'drive.amount': 0.55, 'drive.mix': 1, 'drive.tone': 0.5, 'amp.level': 6,
    },
  },
  taiko: {
    zh: '太鼓', params: {
      'voice.poly': 4, 'osc1.shape': 0, 'osc1.level': 0.55, 'osc1.oct': -1, 'osc1.phase': 'reset', 'osc1.drift': 0, 'osc1.filt': 0,
      'phys.on': true, 'phys.level': 1, 'phys.model': 'membrane', 'phys.exciter': 'mallet', 'phys.hardness': 0.55, 'phys.position': 0.65,
      'phys.decay': 0.9, 'phys.brightness': 0.42, 'phys.inharm': 0.85, 'phys.body': 0.8, 'phys.damp': 0.15, 'phys.spread': 0.4,
      'noise.on': true, 'noise.level': 0.3, 'noise.color': -0.3, 'noise.decay': 0.04, 'noise.filt': 0,
      'filter.on': false,
      'aenv.a': 0, 'aenv.d': 1.4, 'aenv.s': 0, 'aenv.r': 0.8, 'aenv.curve': 0.45,
      'menv.a': 0, 'menv.d': 0.18, 'menv.s': 0, 'menv.r': 0.1, ...PITCH_ENV(0.05),
      'amp.vel': 0.85, 'amp.level': 3, 'comp.amount': 0.25,
      'reverb.on': true, 'reverb.size': 0.9, 'reverb.decay': 2.8, 'reverb.damp': 0.5, 'reverb.mix': 0.24,
    },
  },
  tabla: {
    zh: '手鼓', params: { // membrane follows pitch: low notes = bayan (with a little upward "ghe" glide), high = dayan
      'voice.poly': 5, 'phys.on': true, 'phys.level': 1, 'phys.model': 'membrane', 'phys.exciter': 'mallet', 'phys.hardness': 0.74,
      'phys.position': 0.24, 'phys.decay': 0.62, 'phys.brightness': 0.6, 'phys.inharm': 0.18, 'phys.body': 0.45, 'phys.damp': 0.3, 'phys.spread': 0.3,
      'osc1.on': false, 'filter.on': false, 'aenv.a': 0, 'aenv.d': 0.8, 'aenv.s': 0, 'aenv.r': 0.3,
      'menv.a': 0, 'menv.d': 0.26, 'menv.s': 0, 'menv.r': 0.2, 'menv.curve': 0.6, ...PITCH_ENV(-0.022),
      'mod2.src': 'note', 'mod2.dst': 'amp.level', 'mod2.amt': -0.2, // the low drum is weaker: lift it
      // level 3 → 1: the hard membrane strike peaks ≈ 21 dB over its loudness and pushed the jam's safety limiter
      'amp.vel': 0.7, 'amp.level': 1, 'reverb.on': true, 'reverb.size': 0.5, 'reverb.decay': 1.3, 'reverb.mix': 0.14,
    },
  },
  // "top" kits: one patch plays snare/clap (low notes, ≈50) and hats (high notes, ≈96). The noise runs through a
  // key-tracked high-pass (≈500 Hz for the snare, ≈8 kHz for the hats); the snare body (triangle) fades out
  // with the note number; closed vs open hat = note length (release is short, decay ≈0.3 s). The hats' noise turns
  // blue (note → colour), so the synth/lo-fi/house kits get a 12–13 kHz low-pass: without it 25–37 % of the hat
  // energy sat above 16 kHz (fizz that also ate the mix headroom). The 8-bit kit's crusher is meant to fizz.
  // synthTop: the gated snare peaks ≈ 21 dB over its loudness → soft-clip its strike (kept the jam limiter under 1 dB)
  synthTop: { zh: '閘門軍鼓＋鈸', params: topParams({ body: 0.3, cut: 900, color: -0.3, lp: 13000, clip: 1, reverb: [0.55, 1.1, 0.3], comp: 0.3, level: 4 }) },
  lofiTop: { zh: '低傳真小鼓＋鈸', params: topParams({ body: 0.25, cut: 760, color: -0.45, lp: 12000, crush: 0.32, reverb: [0.35, 0.8, 0.14], decay: 0.24, level: 6 }) },
  houseTop: { zh: '拍手＋鈸', params: topParams({ body: 0, cut: 1150, color: -0.4, lp: 13000, reverb: [0.45, 0.9, 0.22], decay: 0.26, level: 5 }) },
  chipTop: { zh: '8-bit 噪音鼓', params: topParams({ body: 0, cut: 700, color: -0.2, crush: 0.6, decay: 0.2, level: 6 }) },
  shaker: {
    zh: '沙鈴', params: {
      'voice.poly': 4, ...NOISE_ONLY, 'noise.level': 0.8, 'noise.color': 0.45, 'noise.decay': 0,
      'filter.type': 'bp', 'filter.cutoff': 5200, 'filter.res': 0.18, 'filter.key': 0,
      'aenv.a': 0.012, 'aenv.d': 0.09, 'aenv.s': 0, 'aenv.r': 0.05, 'aenv.curve': 0.5, 'amp.vel': 0.7, 'amp.level': 4,
      'reverb.on': true, 'reverb.size': 0.6, 'reverb.decay': 1.5, 'reverb.mix': 0.15,
    },
  },
  tick: {
    zh: '滴答', params: {
      'voice.poly': 4, ...NOISE_ONLY, 'noise.level': 0.8, 'noise.color': 0.55, 'noise.decay': 0,
      'filter.type': 'bp', 'filter.cutoff': 6500, 'filter.res': 0.35, 'filter.key': 0,
      'aenv.a': 0, 'aenv.d': 0.06, 'aenv.s': 0, 'aenv.r': 0.03, 'amp.vel': 0.7, 'amp.level': 6,
      'reverb.on': true, 'reverb.size': 0.8, 'reverb.decay': 2, 'reverb.mix': 0.2,
    },
  },
};
const kitPatch = id => ({ params: { ...KIT[id].params }, macros: [] });

// ───────────────────────── rhythm vocabularies (16th grid) ─────────────────────────
// 'x' onset, '-' hold, '.' rest. Cells are 1 or 2 beats (4 or 8 chars). w = weight, e = [minEnergy, maxEnergy].
const C = (pat, w = 1, e0 = 0, e1 = 1) => ({ pat, len: pat.length / 4, w, e0, e1 });
const CELLS = {
  ambient: [C('x-------', 3), C('x-----------', 2), C('x---x---', 1.5), C('x-------x---', 1.2), C('x---', 0.8), C('........', 1.2, 0, 0.7), C('x-x-----', 0.6, 0.5)],
  lofi: [C('x-x-', 1.2), C('x--x', 1), C('..x-', 1.2), C('x---', 1), C('x-.x', 0.8), C('x--x--x-', 1, 0.3), C('....', 0.8, 0, 0.8), C('xxx-', 0.5, 0.6), C('x-------', 0.8)],
  synthwave: [C('x-x-', 1.3), C('x---', 1), C('x-------', 1.2), C('x-----x-', 1), C('..x-x-x-', 0.9, 0.3), C('x-xx', 0.6, 0.6), C('....', 0.5, 0, 0.7)],
  house: [C('x-.x', 1), C('..x.', 1.2), C('x.x.', 1), C('.x.x', 0.6, 0.5), C('x---', 0.8), C('x--x--x-', 1.1), C('....', 0.8, 0, 0.8)],
  cinematic: [C('x-----------', 1.5), C('x-------', 2), C('x---x---', 1.2), C('x-----x-', 1.2), C('x---', 0.8), C('x-x-x-x-', 0.7, 0.55), C('xxxx', 0.35, 0.8)],
  pentatonic: [C('x--x', 1.3), C('x-------', 1.2), C('x-----x-', 1.2), C('x-x-', 1), C('x---', 1), C('xx--', 0.6), C('....', 0.5, 0, 0.7)],
  chiptune: [C('x-x-', 1.5), C('xxxx', 1, 0.3), C('x---', 1), C('x-xx', 1), C('xx-x', 0.7), C('x-------', 0.6), C('....', 0.3, 0, 0.6)],
};

// ───────────────────────── groove patterns ─────────────────────────
// Drum strings are 16 steps. Upper-case = accent, lower-case = normal, 'g' = ghost, '.' = none.
// hat: c = closed, o = open. perc: h/m/l = high/mid/low pitch.
const GROOVES = {
  ambient: {
    kick: [['k...............', 0.35], ['k.........k.....', 0.7]],
    hat: [['................', 0], ['c.c.c.c.c.c.c.c.', 0.45], ['c.ccc.ccc.ccc.cc', 0.8]],
    snare: null,
  },
  lofi: {
    kick: [['K.........K.....', 0], ['K......k..K...k.', 0.55], ['K..k...k..K..k..', 0.85]],
    snare: [['....S.......S...', 0], ['....S.......S..g', 0.5], ['....S..g....S.g.', 0.8]],
    hat: [['c.c.c.c.c.c.c.c.', 0], ['C.c.C.c.C.c.C.cc', 0.55], ['C.ccC.c.C.ccC.co', 0.8]],
  },
  synthwave: {
    kick: [['K.......K.......', 0], ['K...K...K...K...', 0.55]],
    snare: [['....S.......S...', 0], ['....S.......S...', 0.6]],
    hat: [['c.c.c.c.c.c.c.c.', 0], ['c.C.c.C.c.C.c.C.', 0.4], ['cccCcccCcccCcccC', 0.75]],
  },
  house: {
    kick: [['K...K...K...K...', 0]],
    snare: [['................', 0], ['....S.......S...', 0.35]],
    hat: [['..o...o...o...o.', 0], ['c.o.c.o.c.o.c.o.', 0.5], ['ccocccoccco.ccoc', 0.8]],
  },
  cinematic: {
    kick: [['K...............', 0], ['K.......K.......', 0.4], ['K.....k.K.......', 0.6], ['K..kK...K..kK.kk', 0.85]],
    snare: [['................', 0], ['........h.......', 0.5], ['....h.......h.hh', 0.72], ['h.h.h.hhh.h.hhhh', 0.9]],
    hat: [['................', 0], ['c...c...c...c...', 0.55], ['c.c.c.c.c.c.c.c.', 0.75], ['cccccccccccccccc', 0.9]],
  },
  pentatonic: {
    kick: [['L.......L.......', 0], ['L.....L.L.......', 0.45], ['L..l..L.L..l....', 0.8]],
    snare: [['....h.......h...', 0], ['..h.H..h..h.H..h', 0.45], ['.hh.H.hh.hh.Hhhh', 0.8]],
    hat: [['................', 0], ['c.c.c.c.c.c.c.c.', 0.5], ['c.ccc.ccc.ccc.cc', 0.85]],
  },
  chiptune: {
    kick: [['K.......K.......', 0], ['K...K...K...K...', 0.5], ['K..kK...K.k.K...', 0.8]],
    snare: [['....S.......S...', 0], ['....S.......S..s', 0.6]],
    hat: [['c.c.c.c.c.c.c.c.', 0], ['cccccccccccccccc', 0.6]],
  },
};
const FILLS = {
  lofi: { snare: '........S..g.gSg', hat: '....c.c.c.......' },
  synthwave: { snare: '........s.s.SsSS', hat: 'c.c.c.c.........' },
  house: { snare: '....S...s.s.SsSS', hat: 'ccoccco.........' },
  cinematic: { kick: 'K...K...KkKkKKKK', snare: 'h.h.hhhhhhhhHHHH' },
  pentatonic: { snare: '..h.H.hhHhhhHHHH', kick: 'L.......L.l.L...' },
  chiptune: { snare: '........ssssSSSS', hat: 'cccccccc........' },
  ambient: {},
};

// Bass patterns per bar: [start16, len16, token]; R root, O octave, 5 fifth, 3 third, A approach to next root, b7 seventh.
const BASS = {
  drone: [[[[0, 32, 'R']], 0], [[[0, 24, 'R'], [24, 8, '5']], 0.7]],
  lofi: [[[[0, 7, 'R'], [10, 4, '5'], [14, 2, 'A']], 0], [[[0, 5, 'R'], [6, 2, 'R'], [10, 3, '5'], [13, 1, 'O'], [14, 2, 'A']], 0.55]],
  synthwave: [[[[0, 2, 'R'], [2, 2, 'R'], [4, 2, 'R'], [6, 2, 'R'], [8, 2, 'R'], [10, 2, 'R'], [12, 2, 'R'], [14, 2, 'R']], 0],
    [[[0, 2, 'R'], [2, 2, 'O'], [4, 2, 'R'], [6, 2, 'O'], [8, 2, 'R'], [10, 2, 'O'], [12, 2, 'R'], [14, 2, 'A']], 0.8]],
  house: [[[[2, 2, 'R'], [6, 2, 'R'], [10, 2, 'R'], [14, 2, 'R']], 0], [[[2, 1, 'R'], [3, 1, 'O'], [6, 2, 'R'], [9, 1, '5'], [10, 2, 'R'], [14, 1, 'R'], [15, 1, 'O']], 0.6]],
  cinematic: [[[[0, 16, 'R']], 0], [[[0, 6, 'R'], [6, 2, 'R'], [8, 6, 'R'], [14, 2, '5']], 0.5], [[[0, 2, 'R'], [2, 2, 'R'], [4, 2, 'R'], [6, 2, 'R'], [8, 2, 'R'], [10, 2, 'R'], [12, 2, 'R'], [14, 2, 'R']], 0.8]],
  pentatonic: [[[[0, 6, 'R'], [6, 2, '5'], [8, 8, 'R']], 0], [[[0, 4, 'R'], [6, 2, '5'], [8, 4, 'O'], [12, 2, '5'], [14, 2, 'A']], 0.6]],
  chiptune: [[[[0, 2, 'R'], [2, 2, 'O'], [4, 2, 'R'], [6, 2, 'O'], [8, 2, 'R'], [10, 2, 'O'], [12, 2, 'R'], [14, 2, 'O']], 0]],
};

// Arpeggio index patterns into the chord-tone ladder (per bar). step = beats per note, len = note length (beats).
const ARPS = {
  ambient: { step: 0.5, len: 1.6, pat: [0, 2, 4, 5, 3, 4, 2, 1] },
  lofi: { step: 0.5, len: 0.45, pat: [0, 2, 3, 1, 4, 2, 3, 5] },
  synthwave: { step: 0.25, len: 0.22, pat: [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1] },
  house: { step: 0.25, len: 0.18, pat: [-1, -1, 2, -1, 0, -1, 3, -1, -1, 1, -1, 2, 4, -1, 2, -1] },
  ostinato: { step: 0.25, len: 0.22, pat: [0, 2, 0, 3, 0, 2, 0, 4, 0, 2, 0, 3, 0, 5, 0, 4] },
  koto: { step: 0.5, len: 1.2, pat: [0, 1, 2, 4, 3, 2, 4, 5] },
  chip: { step: 0.125, len: 0.11, pat: [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1] },
};

// Section names for the display
/** Parts the ensemble engine can play at once (src/dsp/ensemble.js ENSEMBLE_MAX_PARTS). */
export const MAX_PARTS = 6;

const SECTION_NAMES = {
  intro: { zh: '前奏', en: 'Intro' }, build: { zh: '鋪陳', en: 'Build' }, groove: { zh: '律動', en: 'Groove' },
  peak: { zh: '高潮', en: 'Peak' }, breakdown: { zh: '間奏', en: 'Breakdown' }, lift: { zh: '推升', en: 'Lift' },
};

// Part display colours (piano roll)
const PART_COLORS = { lead: '#5cf2ff', chords: '#a78bfa', bass: '#ff6bd6', extra: '#3ef0b0', kick: '#ff6b81', snare: '#ffc46b', hat: '#8e97b8', perc: '#ffb38a', fx: '#ff8fe0' };

// ───────────────────────── helpers ─────────────────────────
const r4 = x => Math.round(x * 10000) / 10000;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clampVel = v => Math.round(clamp(v, 0.05, 1) * 1000) / 1000;

function parseSeq(seq) {
  return seq.trim().split(/\s+/).map(tok => {
    const [d, q] = tok.split('.');
    return { d: Math.max(1, Math.min(7, Number(d) || 1)) - 1, q: q || null };
  });
}

/** Nearest MIDI note with pitch class pc to `target`. */
function nearestPc(pc, target) {
  const base = target - mod12(target - pc);
  return target - base <= 6 ? base : base + 12;
}

/** MIDI notes in [lo, hi] whose pitch class is in pcs (absolute pcs). */
function notesIn(pcs, lo, hi) {
  const out = [];
  for (let n = lo; n <= hi; n++) if (pcs.includes(mod12(n))) out.push(n);
  return out;
}

// ───────────────────────── harmony ─────────────────────────
function chooseProgressions(style, sc, rng, allowHalfDim) {
  const fam = sc.family;
  const ok = prog => parseSeq(prog.seq).every(({ d, q }) => {
    const ch = buildChord(sc.harmPcs, d, q) || buildChord(sc.harmPcs, d, null);
    if (!ch) return false;
    if (ch.quality === 'aug') return false;
    if (ch.quality === 'dim' && !allowHalfDim) return false;
    if (style.pentaChords && sc.penta && !sc.mel.includes(mod12(ch.rootOff))) return false;
    return true;
  });
  let pool = style.progs.filter(p => p.fam === fam && ok(p));
  const borrowed = style.progs.filter(p => (RELATED[fam] || []).includes(p.fam) && ok(p) && !pool.includes(p));
  if (pool.length < 2) pool = pool.concat(borrowed);
  if (!pool.length) pool = FALLBACK_PROGS.filter(ok);
  if (!pool.length) pool = [P('any', '1 1 1 1')];
  const a = rng.weighted(pool, p => p.w);
  const rest = pool.filter(p => p !== a && p.seq !== a.seq);
  // B section: prefer a progression starting on a different chord for contrast
  const b = rest.length ? rng.weighted(rest, p => p.w * (p.seq[0] !== a.seq[0] ? 1.6 : 1)) : a;
  return { a, b };
}

/** Chord colours for a style (seeded per progression slot so repeats sound the same). */
function colourChord(style, sc, d, q, rng) {
  const e = style.ext;
  if (q) return buildChord(sc.harmPcs, d, q) || buildChord(sc.harmPcs, d, null);
  const ext = {
    seventh: rng.chance(e.seventh), ninth: rng.chance(e.ninth), six: rng.chance(e.six),
    sus: e.sus && rng.chance(e.sus) ? (rng.chance(0.6) ? 'sus2' : 'sus4') : null,
  };
  let ch = buildChord(sc.harmPcs, d, null, ext);
  if (ch && ch.quality === 'dim' && !style.allowHalfDim) ch = buildChord(sc.harmPcs, d, 'triad');
  return ch;
}

/** Pentatonic style: keep chord tones inside the melody scale (3rd → sus2/sus4, 5th dropped if needed). */
function pentaFix(ch, sc) {
  const mel = sc.mel.map(mod12);
  const inMel = iv => mel.includes(mod12(ch.rootOff + iv));
  const out = [0];
  const third = ch.iv.find(x => x === 3 || x === 4);
  if (third !== undefined && inMel(third)) out.push(third);
  else if (inMel(2)) out.push(2);
  else if (inMel(5)) out.push(5);
  if (inMel(7)) out.push(7);
  for (const x of ch.iv) if ((x === 9 || x === 10 || x === 11 || x === 14) && inMel(x)) out.push(x);
  const iv = [...new Set(out)].sort((a, b) => a - b);
  if (iv.length < 3) { // too thin: add the 9th/6th if they are in the scale
    for (const x of [14, 9, 10]) if (iv.length < 3 && inMel(x) && !iv.includes(x)) iv.push(x);
    iv.sort((a, b) => a - b);
  }
  return { ...ch, iv, suffix: chordSuffix(iv) };
}

function makeTimeline(style, sc, key, bars, progs, sectionPlan, rng, names) {
  const bpc = style.barsPerChord;
  const tl = [];
  const colourCache = new Map();
  let bar = 0;
  while (bar < bars) {
    const useB = sectionPlan.progAt(bar) === 'B';
    const prog = useB ? progs.b : progs.a;
    const toks = parseSeq(prog.seq);
    const cycleBars = toks.length * bpc;
    const inCycle = bar % cycleBars;
    const slot = Math.floor(inCycle / bpc);
    const { d, q } = toks[slot];
    const cacheKey = `${useB ? 'B' : 'A'}${slot}`;
    let ch = colourCache.get(cacheKey);
    if (!ch) {
      ch = colourChord(style, sc, d, q, rngFor(rng.seed, 'colour', cacheKey, prog.seq));
      if (style.pentaChords && sc.penta) ch = pentaFix(ch, sc);
      colourCache.set(cacheKey, ch);
    }
    const root = mod12(key + ch.rootOff);
    const pcs = ch.iv.map(x => mod12(root + x));
    const beats = bpc * 4;
    const prev = tl[tl.length - 1];
    if (prev && prev.root === root && prev.symbol === names[root] + ch.suffix && prev.beat + prev.beats === bar * 4) prev.beats += beats;
    else tl.push({ beat: bar * 4, beats, root, pcs, iv: ch.iv, degree: d, quality: ch.quality, symbol: names[root] + ch.suffix, prog: useB ? 'B' : 'A' });
    bar += bpc;
  }
  // clip the last chord to the segment
  const last = tl[tl.length - 1];
  if (last.beat + last.beats > bars * 4) last.beats = bars * 4 - last.beat;
  return tl;
}

function chordAt(tl, beat) {
  for (let i = tl.length - 1; i >= 0; i--) if (beat >= tl[i].beat - 1e-6) return tl[i];
  return tl[0];
}

// ───────────────────────── voicing ─────────────────────────
/**
 * Voice-led chord voicing. Picks the chord tones by priority (3rd, 7th, 9th, 5th; the root unless `rootless`)
 * and searches every placement in [lo, hi] (any doubling allowed, doubled 3rds/7ths penalised) for the one with
 * the least total movement from `prev`, a smooth top line near `top`, and open spacing in the low register.
 */
function voiceChord(ch, prev, opt, depth = 0) {
  const { lo, hi, n, top, maxSpan = 19, rootless = false, open = false } = opt;
  const root = ch.root;
  const ivs = [...new Set(ch.iv.map(x => mod12(x)))];
  const has = x => ivs.includes(x);
  const third = has(4) ? 4 : has(3) ? 3 : has(2) ? 2 : has(5) ? 5 : null;
  const sev = has(11) ? 11 : has(10) ? 10 : has(9) ? 9 : null;
  const nine = ch.iv.includes(14) && third !== 2 ? 2 : null;
  const order = [];
  if (!rootless) order.push(0);
  if (third !== null) order.push(third);
  if (sev !== null) order.push(sev);
  if (nine !== null) order.push(nine);
  if (has(7)) order.push(7);
  if (rootless) order.push(0);
  const distinct = [...new Set(order)];
  const want = Math.max(2, Math.min(n, 6));
  const mustIv = distinct.slice(0, Math.min(want, distinct.length));
  const must = mustIv.map(x => mod12(root + x));
  const dblCost = pc => { const iv = mod12(pc - root); return iv === 0 || iv === 7 ? 0.4 : iv === third ? 2.5 : 4; };
  const cand = notesIn(must, lo, hi);
  let best = null, bestScore = Infinity;
  const pick = [];
  const score = v => {
    const span = v[v.length - 1] - v[0];
    let s = 0;
    // every required tone present; doublings cost
    const cnt = new Map();
    for (const x of v) cnt.set(mod12(x), (cnt.get(mod12(x)) || 0) + 1);
    for (const pc of must) if (!cnt.has(pc)) return Infinity;
    for (const [pc, c] of cnt) if (c > 1) s += dblCost(pc) * (c - 1);
    if (prev && prev.length) {
      if (prev.length === v.length) for (let i = 0; i < v.length; i++) s += Math.abs(v[i] - prev[i]);
      else { for (const x of v) { let m = 99; for (const y of prev) m = Math.min(m, Math.abs(x - y)); s += m; } s += 2; }
      s += Math.abs(v[v.length - 1] - prev[prev.length - 1]) * 0.5; // smooth top line
    } else {
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      s += Math.abs(mean - (top - (open ? 9 : 5))) * 1.5;
    }
    s += Math.abs(v[v.length - 1] - top) * 0.3;
    for (let i = 1; i < v.length; i++) {
      const gap = v[i] - v[i - 1], mid = (v[i] + v[i - 1]) / 2;
      if (mid < 50 && gap < 7) s += 9;
      else if (mid < 55 && gap < 4) s += 6;
      if (gap === 1) s += open ? 5 : 2.5; // minor-2nd rub between adjacent voices
      if (open && gap > 9 && i > 1) s += 1.5;
    }
    if (!open && span > 14) s += (span - 14) * 0.8;
    if (open && span < 12) s += 3;
    if (mod12(v[v.length - 1]) === root && v.length > 3) s += 1.2; // root on top is plain
    return s;
  };
  const rec = (start) => {
    if (pick.length === want) {
      const sc = score(pick);
      if (sc < bestScore - 1e-9 || (Math.abs(sc - bestScore) < 1e-9 && best && pick.join() < best.join())) { bestScore = sc; best = pick.slice(); }
      return;
    }
    for (let i = start; i < cand.length; i++) {
      if (pick.length && cand[i] - pick[0] > maxSpan) break;
      if (cand.length - i < want - pick.length) break;
      pick.push(cand[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  if (!best) { // relax the span limit / widen the range
    if (depth > 4) return must.slice(0, 3).map((pc, i) => nearestPc(pc, top - 7 + i * 4)).sort((a, b) => a - b);
    return voiceChord(ch, prev, { ...opt, maxSpan: maxSpan + 12, n: Math.max(3, n - 1), lo: lo - 2, hi: hi + 2 }, depth + 1);
  }
  return best;
}

// ───────────────────────── humanisation ─────────────────────────
function makeFeel(style, rng) {
  const h = style.humanize;
  return (beat, amt = 1, laid = 0) => {
    let b = beat;
    const frac = b - Math.floor(b);
    if (style.swing8 && Math.abs(frac - 0.5) < 1e-6) b += style.swing8;
    else if (style.swing16 && (Math.abs(frac - 0.25) < 1e-6 || Math.abs(frac - 0.75) < 1e-6)) b += style.swing16 + (Math.abs(frac - 0.75) < 1e-6 ? style.swing8 * 0.5 : 0);
    if (h) b += rng.tri() * h * amt;
    b += laid;
    return b;
  };
}

// ───────────────────────── energy plan ─────────────────────────
const VARIATION_ARC = [
  { kind: 'build', e0: 0.55, e1: 0.8, prog: 'A' },
  { kind: 'groove', e0: 0.75, e1: 0.88, prog: 'A' },
  { kind: 'peak', e0: 0.88, e1: 1, prog: 'B' },
  { kind: 'breakdown', e0: 0.45, e1: 0.75, prog: 'A' },
];

function planSections(style, bars, variation, intensity, endless) {
  const arc = VARIATION_ARC[((variation % 4) + 4) % 4];
  const [s0, s1] = style.energy;
  const lerp = (a, b, t) => a + (b - a) * t;
  const energy = [];
  const sections = [];
  if (!endless && variation === 0) {
    // standalone loop: intro → groove → peak within the segment
    const plan = bars >= 16
      ? [['intro', 4, 0.5, 0.62], ['groove', 4, 0.72, 0.8], ['build', 4, 0.8, 0.9], ['peak', 4, 0.95, 1]]
      : [['intro', 2, 0.5, 0.6], ['groove', 2, 0.72, 0.8], ['build', 2, 0.82, 0.9], ['peak', 2, 0.95, 1]];
    let b = 0;
    for (const [name, n, a, z] of plan) {
      sections.push({ name, zh: SECTION_NAMES[name].zh, en: SECTION_NAMES[name].en, beat: b * 4, beats: n * 4, prog: bars >= 16 && b >= 8 ? 'B' : 'A' });
      for (let i = 0; i < n; i++) energy.push(lerp(a, z, n > 1 ? i / (n - 1) : 1));
      b += n;
    }
  } else {
    const half = bars / 2;
    const names = { build: ['build', 'lift'], groove: ['groove', 'lift'], peak: ['peak', 'peak'], breakdown: ['breakdown', 'build'] }[arc.kind];
    sections.push({ name: names[0], zh: SECTION_NAMES[names[0]].zh, en: SECTION_NAMES[names[0]].en, beat: 0, beats: half * 4, prog: arc.prog });
    sections.push({ name: names[1], zh: SECTION_NAMES[names[1]].zh, en: SECTION_NAMES[names[1]].en, beat: half * 4, beats: half * 4, prog: arc.prog === 'B' && bars >= 16 ? 'A' : arc.prog });
    for (let i = 0; i < bars; i++) energy.push(lerp(arc.e0, arc.e1, bars > 1 ? i / (bars - 1) : 1));
  }
  // intensity scales the arc (0 → sparse & soft, 1 → full); the style's range nudges it (ambient never gets busy)
  const E = energy.map(e => clamp(e * (0.5 + 0.55 * intensity) * (0.75 + 0.25 * s1) + (s0 - 0.55) * 0.3, 0.08, 1));
  for (const s of sections) {
    const b0 = s.beat / 4, b1 = b0 + s.beats / 4;
    let sum = 0;
    for (let i = b0; i < b1; i++) sum += E[i];
    s.energy = r4(sum / (b1 - b0));
  }
  return { sections, energy: E, kind: arc.kind, progAt: bar => (sections.find(s => bar * 4 >= s.beat && bar * 4 < s.beat + s.beats) || sections[0]).prog };
}

// ───────────────────────── melody ─────────────────────────
function melodyScale(sc, key) { return sc.mel.map(x => mod12(key + x)); }

/** Pitch classes a melody may sustain over this chord: melody scale minus notes a semitone above a chord tone (b9). */
function chordScale(melPcs, ch, passing) {
  return melPcs.filter(pc => !ch.pcs.some(t => mod12(pc - t) === 1) && !passing.includes(pc));
}

function genRhythm(rng, style, energy, phraseBeats, kind) {
  const cells = CELLS[style.melody.cells];
  const out = [];
  const restEnd = kind === 'end' ? 0 : style.melody.restEnd;
  let pos = 0;
  const endAt = phraseBeats - restEnd;
  const density = style.melody.density * (0.75 + 0.5 * energy);
  while (pos < endAt - 1e-6) {
    const room = endAt - pos;
    const cands = cells.filter(c => c.len <= room + 1e-6 && energy >= c.e0 - 1e-6 && energy <= c.e1 + 1e-6);
    if (!cands.length) break;
    const cell = rng.weighted(cands, c => {
      const notes = (c.pat.match(/x/g) || []).length / c.len; // notes per beat
      const dens = notes === 0 ? 0 : notes;
      const fit = 1 / (0.35 + Math.abs(dens - density * 2.2));
      return c.w * fit * (pos === 0 && notes === 0 ? 0.15 : 1);
    });
    const pat = cell.pat;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i] !== 'x') continue;
      let j = i + 1;
      while (j < pat.length && pat[j] === '-') j++;
      out.push({ t: pos + i / 4, d: (j - i) / 4 });
    }
    pos += cell.len;
  }
  if (!out.length) out.push({ t: 0, d: Math.min(2, phraseBeats - restEnd) });
  // phrase ending: stretch the last note (a landing), or for the final phrase hold to the end
  const last = out[out.length - 1];
  if (kind === 'end') {
    // land on the downbeat of the phrase's last bar and hold
    const landing = phraseBeats - 4;
    while (out.length > 1 && out[out.length - 1].t > landing + 1e-6) out.pop();
    const l = out[out.length - 1];
    if (l.t < landing - 1e-6) out.push({ t: landing, d: 3.5 });
    else l.d = 3.5;
  } else {
    last.d = Math.max(last.d, Math.min(2, endAt - last.t + 0.5));
  }
  return out;
}

function isStrong(beat, d) {
  const inBar = beat % 4;
  if (Math.abs(inBar) < 1e-6 || Math.abs(inBar - 2) < 1e-6) return true;
  if (d >= 1.5) return true;
  // anticipation: starts on an off-beat and ties over a strong beat
  const next = Math.ceil(beat / 2 - 1e-6) * 2;
  return d >= 0.5 && beat + d > next + 0.25 && next - beat <= 0.5;
}

/**
 * Melody for the whole segment: 2-bar (or 4-bar) phrases, motif A/B with repetition & variation.
 * Returns [{beat, note, dur, vel, strong, chordBeat}] (before humanisation).
 */
function genMelody(ctx, opt) {
  const { style, tl, sc, key, bars, energy, seed, variation } = ctx;
  const { lo, hi, center } = opt.range;
  const mel = melodyScale(sc, key);
  const passing = sc.passing.map(x => mod12(key + x));
  const phraseBars = style.melody.phraseBars;
  const nPhr = Math.max(1, Math.floor(bars / phraseBars));
  const phraseBeats = phraseBars * 4;
  const L = bars * 4;
  // phrase plan: A (call) A2 (response) B (contrast) end (cadence); 16 bars add B2 and a climax C
  const plans = { 1: ['end'], 2: ['A', 'end'], 4: ['A', 'A2', 'B', 'end'], 8: ['A', 'A2', 'B', 'B2', 'A', 'A2', 'C', 'end'] };
  let plan = plans[nPhr] || Array.from({ length: nPhr }, (_, i) => (i === nPhr - 1 ? 'end' : ['A', 'A2', 'B', 'B2'][i % 4]));
  const vk = ((variation % 4) + 4) % 4;
  if (variation > 0 && vk === 1 && nPhr >= 4) plan = plan.map(p => (p === 'B' ? 'B' : p === 'end' ? 'A2' : p)).map((p, i, a) => (i === a.length - 1 ? 'end' : p));
  if (vk === 2 && nPhr >= 4) plan = plan.map(p => (p === 'A' ? 'B' : p === 'A2' ? 'B2' : p === 'B' ? 'C' : p)); // peak: contrasting material, climax
  if (vk === 3 && nPhr >= 4) plan = plan.map((p, i) => (i === 0 ? 'rest' : p)); // breakdown: first phrase breathes
  const themeRng = rngFor(seed, 'theme', style.id); // motif A = the song's theme: identical in every variation
  const varRng = rngFor(seed, 'mel', variation);
  const velRng = rngFor(seed, 'mvel', variation);
  const motifs = {};
  const out = [];
  const ladder = notesIn(mel, lo - 12, hi + 12);
  let prevNote = nearestPc(mod12(key), center);
  const stepFrom = (n, steps) => {
    let i = ladder.indexOf(n);
    if (i < 0) { i = 0; while (i < ladder.length - 1 && ladder[i] < n) i++; }
    return ladder[clamp(i + steps, 0, ladder.length - 1)];
  };
  const fold = n => { while (n > hi) n -= 12; while (n < lo) n += 12; return n; };
  // chord tones a melody may sit on: in the melody scale, and not a semitone above another chord tone (no b9 rub)
  const stableTones = ch => {
    let pcs = ch.pcs.filter(pc => mel.includes(pc) && !passing.includes(pc));
    const noB9 = pcs.filter(pc => !ch.pcs.some(t => mod12(pc - t) === 1));
    if (noB9.length) pcs = noB9;
    return pcs.length ? pcs : ch.pcs;
  };
  const toneNear = (pcs, target) => {
    let best = null, bd = 99;
    for (const pc of pcs) {
      const c = nearestPc(pc, target);
      for (const n of [c, c - 12, c + 12]) {
        if (n < lo || n > hi) continue;
        const d = Math.abs(n - target);
        if (d < bd || (d === bd && n < best)) { bd = d; best = n; }
      }
    }
    return best ?? fold(nearestPc(pcs[0], target));
  };
  const chordToneNear = (ch, target, avoidRoot = false) => {
    let pcs = stableTones(ch);
    if (avoidRoot && pcs.length > 1) pcs = pcs.filter(pc => pc !== ch.root);
    return toneNear(pcs, target);
  };
  // chord tone near `target` that keeps the melodic direction (dir > 0 up, < 0 down) and does not stall on `from`
  const dirToneNear = (ch, target, dir, from) => {
    let best = null, bd = 1e9;
    for (const pc of stableTones(ch)) {
      const c = nearestPc(pc, target);
      for (const n of [c - 12, c, c + 12]) {
        if (n < lo || n > hi) continue;
        let d = Math.abs(n - target);
        if (dir > 0 && n < from) d += 6;
        if (dir < 0 && n > from) d += 6;
        if (dir !== 0 && n === from) d += 3.5;
        if (Math.abs(n - from) > 9) d += 4;
        if (d < bd || (d === bd && n < best)) { bd = d; best = n; }
      }
    }
    return best ?? chordToneNear(ch, target);
  };
  const safeScaleNear = (ch, n, dur) => {
    if (dur <= 0.26) return n; // short passing tones may be anything in the scale
    const ok = chordScale(mel, ch, passing);
    if (ok.includes(mod12(n))) return n;
    const up = stepFrom(n, 1), dn = stepFrom(n, -1);
    return fold(ok.includes(mod12(dn)) ? dn : ok.includes(mod12(up)) ? up : chordToneNear(ch, n));
  };

  for (let p = 0; p < nPhr; p++) {
    const kind = plan[p];
    if (kind === 'rest') continue;
    const b0 = p * phraseBeats;
    const e = energy[Math.min(bars - 1, p * phraseBars)];
    const base = kind.replace(/\d$/, '');
    const src = motifs[base === 'end' ? 'A' : base];
    let rhythm, contour;
    if (src && (kind !== base || base === 'end' || kind === 'A' || kind === 'B')) {
      rhythm = src.rhythm.map(x => ({ ...x }));
      contour = src.contour.slice();
      const vr = rngFor(seed, 'var', variation, p);
      // variation: split a long note (ornament) or change the tail, keeping the motif recognisable
      if (rhythm.length > 2 && vr.chance(kind === base ? 0.35 : 0.55)) {
        const i = vr.int(0, rhythm.length - 2);
        if (rhythm[i].d >= 1) { const d = rhythm[i].d / 2; rhythm.splice(i + 1, 0, { t: rhythm[i].t + d, d }); rhythm[i].d = d; contour.splice(i + 1, 0, vr.pick([-1, 1])); }
      }
      if (kind !== base && contour.length > 2 && vr.chance(0.5)) contour[contour.length - 1] = -contour[contour.length - 1] || 1;
      if (base === 'end') {
        const landing = phraseBeats - 4;
        rhythm = rhythm.filter(x => x.t < landing - 1e-6);
        rhythm.push({ t: landing, d: 3.5 });
        contour = contour.slice(0, rhythm.length - 1).concat([-1]);
      }
    } else {
      const r = base === 'A' ? themeRng : varRng;
      rhythm = genRhythm(r, style, base === 'A' ? 0.75 : e, phraseBeats, base === 'end' ? 'end' : 'call');
      contour = [];
      const n = rhythm.length;
      const shape = base === 'A' ? 'arch' : base === 'B' ? r.pick(['climb', 'wave']) : base === 'C' ? 'climb' : 'fall';
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        let dir = shape === 'arch' ? (t < 0.55 ? 1 : -1) : shape === 'climb' ? (t < 0.8 ? 1 : -1) : shape === 'fall' ? -1 : (i % 3 === 2 ? -1 : 1);
        if (r.chance(0.22)) dir = -dir;
        const leap = r.chance(style.melody.leapiness * 0.45) ? 2 : 1;
        contour.push(i === 0 ? 0 : dir * (r.chance(0.1) ? 0 : leap));
      }
      if (base !== 'end') motifs[base] = { rhythm: rhythm.map(x => ({ ...x })), contour: contour.slice() };
    }
    // register: B a little higher, the climax C higher still; energy lifts the line
    const regShift = base === 'B' ? 3 : base === 'C' ? 6 : 0;
    const eShift = Math.round((e - 0.7) * 6);
    const target = clamp(center + regShift + eShift, lo + 3, hi - 3);
    let prev = null;
    let lastLeap = 0;
    for (let i = 0; i < rhythm.length; i++) {
      const { t, d } = rhythm[i];
      const beat = b0 + t;
      if (beat >= L - 1e-6) break;
      let dur = Math.min(d, L - beat);
      const strong = isStrong(beat, dur);
      // an anticipation (off-beat note tied over the next strong beat) belongs to the chord of that beat
      const tiedTo = Math.ceil(beat / 2 - 1e-6) * 2;
      const chordBeat = strong && Math.abs(beat % 2) > 1e-6 && tiedTo < L ? tiedTo : beat;
      const ch = chordAt(tl, chordBeat);
      let note;
      if (i === 0) {
        note = chordToneNear(ch, prev ?? Math.round((prevNote + target) / 2), base === 'A' || base === 'B');
      } else {
        let steps = contour[i] || 0;
        if (Math.abs(lastLeap) >= 3) steps = -Math.sign(lastLeap) * Math.max(1, Math.abs(steps)); // gap fill
        if (prev > target + 7 && steps > 0) steps = -steps;
        if (prev < target - 7 && steps < 0) steps = -steps;
        // no more than two repeats of the same pitch in a row
        if (steps === 0 && out.length && out[out.length - 1].note === prev && out.length > 1 && out[out.length - 2].note === prev) steps = prev > target ? -1 : 1;
        note = stepFrom(prev, steps);
        note = strong ? dirToneNear(ch, note, steps, prev) : safeScaleNear(ch, note, dur);
      }
      note = fold(note);
      const lastOfPhrase = i === rhythm.length - 1;
      if (lastOfPhrase) { // cadences: responses & endings land on stable tones, calls stay open
        const st = stableTones(ch);
        if (base === 'end') note = toneNear(st.includes(mod12(key)) ? [mod12(key)] : st.includes(ch.root) ? [ch.root] : st, note);
        else if (kind === 'A2' || kind === 'B2') note = toneNear(st.filter(pc => pc === ch.root || pc === ch.pcs[1]).length ? st.filter(pc => pc === ch.root || pc === ch.pcs[1]) : st, note);
        else note = chordToneNear(ch, note, true);
      }
      if (prev !== null) { // no tritone or > octave leaps
        const iv = Math.abs(note - prev);
        if (iv === 6 || iv > 12) note = strong || lastOfPhrase ? chordToneNear(ch, prev + Math.sign(note - prev) * 3) : safeScaleNear(ch, stepFrom(prev, Math.sign(note - prev)), dur);
        lastLeap = note - prev;
        if (Math.abs(lastLeap) < 3) lastLeap = 0;
      }
      // a long note that runs into the next chord: keep it only if it also fits there, else cut it at the change
      const end = beat + dur;
      const nx = chordAt(tl, Math.min(L - 1e-3, end - 1e-3));
      if (nx !== ch && end - nx.beat > 0.5 && !stableTones(nx).includes(mod12(note))) dur = Math.max(0.25, nx.beat - beat);
      const accent = strong ? 0.07 : 0;
      const vel = 0.7 + accent + (base === 'C' ? 0.06 : 0) + (e - 0.7) * 0.25 + velRng.tri() * 0.035;
      out.push({ beat, note, dur, vel, strong, chordBeat, phrase: p });
      prev = note;
    }
    if (prev !== null) prevNote = prev;
  }
  return out;
}

// ───────────────────────── parts ─────────────────────────
function pushNote(events, beat, note, dur, vel, lengthBeats) {
  if (!(note >= 0 && note <= 127)) return;
  let b = Math.max(0, beat);
  if (b >= lengthBeats - 0.01) return;
  let d = Math.max(0.03, Math.min(dur, lengthBeats - b - 0.01));
  events.push({ beat: r4(b), type: 'on', note, vel: clampVel(vel), dur: r4(d) });
}

function chordPart(ctx, how, opt) {
  const { style, tl, bars, energy, feel, rng, lengthBeats } = ctx;
  const ev = [];
  const voicings = [];
  let prev = null;
  const vopt = { ...style.pad, ...(opt.voicing || {}) };
  for (const ch of tl) {
    const v = voiceChord(ch, prev, vopt);
    voicings.push({ beat: ch.beat, beats: ch.beats, notes: v });
    prev = v;
  }
  const single = opt.traits && (opt.traits.chordMem || opt.traits.mono);
  const pickNotes = v => (single ? [opt.traits.chordMem ? v[0] : v[v.length - 1]] : v);
  const eAt = b => energy[Math.min(bars - 1, Math.floor(b / 4))];
  for (const vc of voicings) {
    const notes = pickNotes(vc.notes);
    const end = vc.beat + vc.beats;
    const e = eAt(vc.beat);
    if (how === 'held') { // arpeggiator patches: hold the chord, the synth arpeggiates
      for (const n of notes) pushNote(ev, vc.beat, n, vc.beats - 0.04, 0.78, lengthBeats);
      continue;
    }
    if (how === 'sustain' || how === 'swell') {
      const strum = style.id === 'ambient' ? 0.06 : 0.015;
      const legato = 0.08; // overlap into the next chord for pads
      for (let i = 0; i < notes.length; i++) {
        const v = (how === 'swell' ? 0.55 + 0.35 * e : 0.6 + 0.2 * e) - i * 0.015;
        pushNote(ev, feel(vc.beat + i * strum, 0.5), notes[i], vc.beats - i * strum + legato, v, lengthBeats);
      }
      continue;
    }
    // rhythmic comping: per bar patterns (16th grid) [start16, len16, velMul]
    for (let b = vc.beat; b < end - 1e-6; b += 4) {
      const eb = eAt(b);
      let pat;
      if (how === 'lofiComp') pat = eb < 0.6 ? [[0, 10, 1], [10, 5, 0.8]] : rng.pick([[[0, 6, 1], [6, 2, 0.75], [10, 5, 0.85]], [[0, 3, 1], [3, 6, 0.8], [11, 4, 0.85]], [[0, 10, 1], [10, 5, 0.8]]]);
      else if (how === 'houseStab') pat = eb < 0.55 ? [[2, 1.5, 1], [10, 1.5, 0.9]] : rng.pick([[[2, 1.5, 1], [6, 1.5, 0.85], [10, 1.5, 0.95], [14, 1.5, 0.85]], [[0, 1.5, 0.9], [3, 1.5, 1], [6, 1.5, 0.8], [10, 2, 0.95]]]);
      else if (how === 'roll') pat = [[0, 14, 1]];
      else if (how === 'chipArp') pat = null;
      else pat = [[0, 15, 1]];
      if (how === 'chipArp') { // 16th-note chord arpeggio (classic chip "fake chord")
        for (let s = 0; s < 16; s++) {
          const n = notes[s % notes.length];
          pushNote(ev, b + s / 4, n, 0.22, 0.55 + (s % 4 === 0 ? 0.15 : 0) + 0.15 * eb, lengthBeats);
        }
        continue;
      }
      for (const [s16, l16, vm] of pat) {
        const at = b + s16 / 4;
        if (at >= end - 1e-6) continue;
        const len = Math.min(l16 / 4, end - at);
        if (how === 'roll') { // koto/guzheng-style rolled chord
          notes.forEach((n, i) => pushNote(ev, feel(at + i * 0.09, 0.5), n, len - i * 0.09, (0.62 + 0.2 * eb) * vm - i * 0.02, lengthBeats));
        } else {
          notes.forEach((n, i) => pushNote(ev, feel(at + i * 0.008, 0.6, style.laidBack || 0), n, len * 0.95, (0.58 + 0.24 * eb) * vm - i * 0.012, lengthBeats));
        }
      }
    }
  }
  return { events: ev, voicings };
}

function bassPart(ctx, opt) {
  const { style, tl, sc, key, bars, energy, feel, lengthBeats } = ctx;
  const ev = [];
  const pats = BASS[opt.style || style.bassStyle];
  const harm = sc.harmPcs.map(x => mod12(key + x));
  const lo = opt.lo ?? BASS_RANGE.lo, hi = opt.hi ?? BASS_RANGE.hi;
  let prev = null;
  const rootNote = pc => {
    const center = prev ?? (lo + hi) / 2;
    let n = nearestPc(pc, center);
    while (n < lo) n += 12;
    while (n > hi) n -= 12;
    return n;
  };
  const barCount = bars;
  const enter = opt.always ? 0 : (style.enter && style.enter.bass) ?? 0;
  for (let bar = 0; bar < barCount; bar++) {
    const e = energy[bar];
    if (e < enter - 1e-6) continue;
    const opts = pats.filter(([, emin]) => e >= emin - 1e-6);
    const pat = opts[opts.length - 1][0];
    for (const [s16, l16, tok] of pat) {
      const beat = bar * 4 + s16 / 4;
      if (beat >= lengthBeats - 1e-6) continue;
      const ch = chordAt(tl, beat);
      const root = rootNote(ch.root);
      let n = root;
      if (tok === 'O') n = root + 12 <= hi + 9 ? root + 12 : root;
      else if (tok === '5') { const f = ch.pcs.includes(mod12(ch.root + 7)) ? mod12(ch.root + 7) : ch.pcs[ch.pcs.length > 2 ? 2 : 0]; n = nearestPc(f, root + 5); if (n > hi + 5) n -= 12; }
      else if (tok === 'A') {
        const nb = beat + l16 / 4;
        const nx = chordAt(tl, nb >= lengthBeats ? 0 : nb);
        if (nx === ch && nb < lengthBeats) { n = nearestPc(ch.pcs[ch.pcs.length > 2 ? 2 : 0], root + 5); if (n > hi + 5) n -= 12; }
        else { // approach the next root by a scale step from below/above
          const target = rootNote(nx.root);
          const below = harm.map(pc => nearestPc(pc, target - 1)).filter(x => x < target).sort((a, b) => b - a)[0];
          n = below ?? target - 1;
          if (n < lo - 2) n += 12;
        }
      } else if (tok === 'b7') n = root + 10;
      else if (tok === '3') n = nearestPc(ch.pcs[1] ?? ch.root, root + 4);
      const long = l16 >= 8;
      const vel = (tok === 'R' && s16 % 8 === 0 ? 0.9 : 0.74) * (0.82 + 0.2 * e);
      const gate = style.id === 'synthwave' || style.id === 'chiptune' ? 0.8 : style.id === 'house' ? 0.7 : long ? 0.97 : 0.88;
      pushNote(ev, feel(beat, 0.6), n, (l16 / 4) * gate, vel, lengthBeats);
      if (tok === 'R') prev = n;
    }
  }
  return ev;
}

function arpPart(ctx, opt) {
  const { style, tl, bars, energy, feel, lengthBeats } = ctx;
  const ev = [];
  const A = ARPS[opt.arpStyle || style.arpStyle];
  const lo = opt.lo ?? 55, hi = opt.hi ?? 84;
  let base = null;
  for (let bar = 0; bar < bars; bar++) {
    const e = energy[bar];
    if (e < (opt.minEnergy ?? 0)) continue;
    const barBeat = bar * 4;
    const pattern = A.pat;
    const step = A.step;
    const perBar = Math.round(4 / step);
    for (let s = 0; s < perBar; s++) {
      const beat = barBeat + s * step;
      const ch = chordAt(tl, beat);
      // chord-tone ladder from a base near the previous base (smooth register)
      const pcs = [...new Set(ch.iv.map(x => mod12(ch.root + x)))];
      const start = nearestPc(ch.root, base ?? lo + 5);
      const b0 = start < lo ? start + 12 : start > lo + 11 ? start - 12 : start;
      if (s === 0) base = b0;
      const ladder = notesIn(pcs, b0, hi + 12).filter(n => n >= b0);
      const idx = pattern[s % pattern.length];
      if (idx < 0) continue;
      if (e < 0.55 && s % 2 === 1 && step <= 0.25) continue; // thinner at low energy
      let n = ladder[Math.min(ladder.length - 1, idx)];
      while (n > hi) n -= 12;
      const accent = s % Math.round(1 / step) === 0 ? 0.12 : 0;
      pushNote(ev, feel(beat, 0.4), n, A.len, (0.56 + accent) * (0.8 + 0.3 * e), lengthBeats);
    }
  }
  return ev;
}

function texturePart(ctx) {
  const { tl, key, bars, energy, lengthBeats } = ctx;
  const ev = [];
  // tonic drone + slow swells on chord tones, high and airy
  pushNote(ev, 0, nearestPc(key, 48), Math.min(lengthBeats, 16) - 0.1, 0.62, lengthBeats);
  if (bars > 4) pushNote(ev, 16, nearestPc(key, 48), lengthBeats - 16.1, 0.6, lengthBeats);
  for (const ch of tl) {
    const e = energy[Math.min(bars - 1, ch.beat / 4)];
    const top = nearestPc(ch.pcs[Math.min(ch.pcs.length - 1, 1)], 76);
    pushNote(ev, ch.beat + 0.5, top, ch.beats - 0.6, 0.45 + 0.3 * e, lengthBeats);
    if (e > 0.75) pushNote(ev, ch.beat + 1, nearestPc(ch.root, 67), ch.beats - 1.2, 0.4 + 0.2 * e, lengthBeats);
  }
  return ev;
}

function drumSlot(ctx, slot, opt) {
  const { style, bars, energy, feel, lengthBeats, key, endless, variation } = ctx;
  const g = GROOVES[style.drumStyle] || GROOVES.synthwave;
  const pats = g[slot];
  if (!pats) return [];
  const ev = [];
  const fill = (FILLS[style.drumStyle] || {})[slot];
  const tuned = opt.note;
  const hatRng = rngFor(ctx.seed, 'hat', variation);
  const grooveRng = rngFor(ctx.seed, 'groove', slot, variation);
  const enter = (style.enter && style.enter[slot]) ?? 0;
  for (let bar = 0; bar < bars; bar++) {
    const e = energy[bar];
    if (e < enter - 1e-6 && !opt.always) continue; // the arrangement builds: parts enter with the energy
    let pat = null;
    for (const [p, emin] of pats) if (e >= emin - 1e-6) pat = p;
    if (!pat) continue;
    const lastBar = bar === bars - 1;
    if (lastBar && fill && e >= 0.5) pat = fill;
    else if (e > 0.5 && slot !== 'hat' && grooveRng.chance(0.18 + 0.25 * (e - 0.5))) {
      // seeded groove flavour: a pickup kick / ghost note on a free off-beat 16th
      const free = [];
      for (let s = 1; s < 16; s += 2) if (pat[s] === '.' && pat[s - 1] === '.') free.push(s);
      if (free.length) {
        const at = grooveRng.pick(free);
        const ch = slot === 'kick' ? (pat.includes('L') ? 'l' : 'k') : pat.includes('h') || pat.includes('H') ? 'h' : 'g';
        pat = pat.slice(0, at) + ch + pat.slice(at + 1);
      }
    }
    for (let s = 0; s < 16; s++) {
      const ch = pat[s];
      if (ch === '.' || !ch) continue;
      const accent = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
      const low = ch.toLowerCase();
      let vel = low === 'g' ? 0.32 : accent ? 0.95 : 0.7;
      let note = tuned, dur = 0.2;
      if (slot === 'hat') {
        dur = low === 'o' ? 0.45 : 0.06;
        vel *= (s % 4 === 0 ? 1 : s % 2 === 0 ? 0.82 : 0.66) * (0.9 + 0.1 * hatRng.next());
      } else if (slot === 'kick') {
        note = low === 'l' ? tuned : tuned;
        dur = 0.4;
      } else if (slot === 'snare') {
        if (low === 'h') { note = opt.hiNote ?? tuned; } // hand drum hits
        dur = 0.25;
      }
      vel *= 0.78 + 0.26 * e;
      const laid = slot === 'snare' ? (style.laidBack || 0) : 0;
      pushNote(ev, feel(bar * 4 + s / 4, slot === 'kick' ? 0.3 : 0.7, laid), note, dur, vel, lengthBeats);
    }
  }
  // tabla-style pitch variety: alternate high drum between tonic and fifth
  if (opt.alternate) for (let i = 0; i < ev.length; i++) if (i % 3 === 2) ev[i].note = opt.alternate;
  return ev;
}

// ───────────────────────── automation ("auto tone") ─────────────────────────
const RIDE_KEYS = {
  bright: /亮|明|bright|tone|cutoff|filter|open|音色|光|sparkle|air|clar|泛音|overtone|glow|shimmer|閃/i,
  space: /空間|space|reverb|殘響|hall|殿堂|room|ambience|遠|wet|echo|回音|回聲|迴響|dub|halo|天堂|heaven|canyon|山谷|temple/i,
  motion: /流動|motion|drift|漂移|wobble|lfo|vibrato|顫|呼吸|movement|swirl|旋轉|chorus|合唱|動|ensemble|tremolo|phaser|rotor|wow|morph|變/i,
  drive: /drive|失真|grit|dirt|crunch|推|saturat|燒|bite|咬|growl|咆哮|scream|bark|tear|撕/i,
};
// what a macro target does to the sound (parameter id patterns → kind, weight)
const TARGET_KINDS = [
  [/^(filter\.cutoff|filter2\.cutoff|filter\.env|filter\.vowel|phys\.brightness|phys\.hardness|eq\.high|fm\.feedback)$/, 'bright', 1],
  [/^(osc[12]\.(shape|sync|pw|blend)|fm\.op[234]\.level|noise\.level|filter\.res)$/, 'bright', 0.6],
  [/^(reverb\.|delay\.(mix|feedback))/, 'space', 1],
  [/^(mod\d\.amt|lfo[12]\.rate|chorus\.|phaser\.|vib\.depth|osc[12]\.(detune|drift)|voice\.spread)/, 'motion', 0.8],
  [/^(drive\.|filter\.drive|comp\.amount)/, 'drive', 1],
];
// macros that move pitch, timing or the arpeggiator are never ridden (they would fight the composition)
const RIDE_UNSAFE = /^(voice\.pitch|voice\.glide|osc[12]\.(oct|semi|fine)|fm\.(oct|fine)|phys\.(oct|fine)|fm\.op\d\.ratio|aenv\.[ad]|arp\.|chord\.|scale\.|global\.|amp\.level)$/;

/** Classify a macro: { kind, score } or null when it is unsafe to automate. */
export function macroKind(m) {
  if (!m || !Array.isArray(m.targets) || !m.targets.length) return null;
  const score = { bright: 0, space: 0, motion: 0, drive: 0 };
  for (const t of m.targets) {
    if (RIDE_UNSAFE.test(t.id)) return null;
    for (const [re, kind, w] of TARGET_KINDS) if (re.test(t.id)) { score[kind] += Math.abs(Number(t.amount) || 0) * w; break; }
  }
  for (const k in RIDE_KEYS) if (RIDE_KEYS[k].test(m.name || '')) score[k] += 0.25;
  let kind = null, best = 0;
  for (const k in score) if (score[k] > best + 1e-9) { best = score[k]; kind = k; }
  return kind ? { kind, score: best } : null;
}

/** Pick macro rides for a patch: [{index, kind, name, base, peak}] — the timbre evolves with the arrangement. */
export function pickRides(patch, style, intensity = 0.7) {
  const macros = (patch && patch.macros) || [];
  const params = (patch && patch.params) || {};
  const info = macros.slice(0, 4).map((m, i) => ({ i, m, k: macroKind(m) })).filter(x => x.k);
  const used = new Set();
  const rides = [];
  const amt = { bright: 0.45, space: 0.3, motion: 0.35, drive: 0.3 };
  const want = style.id === 'ambient' || style.id === 'cinematic' ? ['bright', 'space', 'motion'] : style.id === 'synthwave' || style.id === 'chiptune' ? ['bright', 'drive', 'motion'] : ['bright', 'motion', 'space'];
  const add = (x, kind) => {
    used.add(x.i);
    const base = clamp(Number(params[`macro${x.i + 1}`]) || 0, 0, 1);
    const up = amt[kind] * (0.6 + 0.6 * intensity);
    const peak = base + up <= 1 ? base + up : Math.max(0, base - up); // ride the other way if already near the top
    rides.push({ index: x.i, kind, name: x.m.name, base: r4(base), peak: r4(clamp(peak, 0, 1)) });
  };
  for (const kind of want) {
    const c = info.filter(x => !used.has(x.i) && x.k.kind === kind).sort((a, b) => b.k.score - a.k.score)[0];
    if (c && rides.length < 2) add(c, kind);
  }
  if (!rides.length && info.length) add(info.sort((a, b) => b.k.score - a.k.score)[0], info[0].k.kind);
  return rides;
}

function rideEvents(rides, ctx) {
  const { lengthBeats, sections, kind } = ctx;
  const ev = [];
  for (const r of rides) {
    ev.push({ beat: 0, type: 'macro', index: r.index, value: r.base });
    if (r.kind === 'bright' || r.kind === 'drive') {
      // rise across the build to the peak, fall back over the last bar so the loop / next segment is seamless
      const peakStart = (sections.find(s => s.name === 'peak') || { beat: lengthBeats * 0.75 }).beat;
      const up = Math.max(4, Math.min(peakStart, lengthBeats - 4));
      const to = kind === 'breakdown' ? r4(r.base + (r.peak - r.base) * 0.5) : r.peak;
      ev.push({ beat: 0, type: 'ramp-macro', index: r.index, to, beats: up });
      ev.push({ beat: lengthBeats - 4, type: 'ramp-macro', index: r.index, to: r.base, beats: 3.9 });
    } else if (r.kind === 'space') {
      // bloom at the end of the segment
      ev.push({ beat: lengthBeats * 0.5, type: 'ramp-macro', index: r.index, to: r.peak, beats: lengthBeats * 0.35 });
      ev.push({ beat: lengthBeats - 2, type: 'ramp-macro', index: r.index, to: r.base, beats: 1.9 });
    } else { // motion: slow wave
      const q = lengthBeats / 4;
      ev.push({ beat: 0, type: 'ramp-macro', index: r.index, to: r.peak, beats: q * 1.5 });
      ev.push({ beat: q * 1.5, type: 'ramp-macro', index: r.index, to: r4((r.base + r.peak) / 2), beats: q });
      ev.push({ beat: q * 2.5, type: 'ramp-macro', index: r.index, to: r.peak, beats: q });
      ev.push({ beat: q * 3.5, type: 'ramp-macro', index: r.index, to: r.base, beats: q * 0.5 - 0.1 });
    }
  }
  return ev;
}

// ───────────────────────── drum slot mapping for user drum presets ─────────────────────────
function drumSlotForPatch(patch) {
  const tags = ((patch && patch.tags) || []).join(' ').toLowerCase() + ' ' + String((patch && patch.name) || '').toLowerCase();
  if (/kick|808|大鼓|bd\b/.test(tags)) return 'kick';
  if (/snare|clap|軍鼓|拍手|rim/.test(tags)) return 'snare';
  if (/hat|cymbal|shaker|鈸|沙鈴|ride/.test(tags)) return 'hat';
  return 'perc';
}

// ───────────────────────── main ─────────────────────────
/**
 * Generate a jam segment. See the header comment for the options and the output format.
 * @param {object} o
 * @returns {object} engine-ready song
 */
export function generateJam(o = {}) {
  const style = STYLES[o.style] || STYLES.ambient;
  const bars = o.bars === 16 ? 16 : o.bars === 4 ? 4 : 8;
  const scaleId = JAM_SCALES[o.scale] ? o.scale : o.scale === 'wholeTone' ? 'major' : style.scale;
  const sc = scaleInfo(scaleId);
  const key = Number.isFinite(o.key) ? mod12(Math.round(o.key)) : style.key;
  const bpm = clamp(Number(o.bpm) || style.bpm, 40, 240);
  const seed = (Number(o.seed) >>> 0) || 1;
  const variation = Math.max(0, Math.floor(Number(o.variation) || 0));
  const intensity = clamp(o.intensity ?? 0.7, 0, 1);
  const endless = !!o.endless;
  const lengthBeats = bars * 4;
  const names = spellingFor(key, sc.harm);
  const rng = rngFor(seed, style.id, 'main');
  rng.seed = seed;

  const lead = o.lead || {};
  const leadPatch = lead.patch || { params: {}, macros: [] };
  const leadRole = lead.role || 'lead';
  const leadTraits = patchTraits(leadPatch);
  const backing = o.backing || {};

  // harmony (progressions depend on the seed only → every variation shares the family)
  const progs = chooseProgressions(style, sc, rngFor(seed, style.id, scaleId, 'prog'), !!style.allowHalfDim);
  const plan = planSections(style, bars, variation, intensity, endless);
  const tl = makeTimeline(style, sc, key, bars, progs, plan, rng, names);
  const ctx = {
    style, sc, key, bars, bpm, seed, variation, intensity, endless, lengthBeats, tl, energy: plan.energy,
    sections: plan.sections, kind: plan.kind, feel: makeFeel(style, rngFor(seed, 'feel', variation)), rng: rngFor(seed, 'comp', variation),
  };

  // what the lead does
  const plays = (() => {
    if (leadTraits.chordMem && leadRole !== 'bass' && leadRole !== 'drum') return 'chords'; // chord-memory presets: stabs
    switch (leadRole) {
      case 'pad': return leadTraits.arp ? 'held' : 'chords';
      case 'keys': return leadTraits.arp ? 'held' : leadTraits.mono ? 'melody' : 'comp';
      case 'bass': return 'bass';
      case 'arp': return leadTraits.arp ? 'held' : 'arp';
      case 'pluck': return leadTraits.arp ? 'held' : style.pluckAs;
      case 'bell': return leadTraits.arp ? 'held' : style.bellAs;
      case 'drum': return 'drums';
      case 'fx': return 'texture';
      case 'strings': return leadTraits.arp ? 'held' : 'melody';
      default: return leadTraits.arp ? 'held' : 'melody';
    }
  })();

  const slots = {};
  // chord-memory patches expand every note into their chord shape: lock them to the jam's key so those chords
  // stay diatonic (the ensemble applies a part's scale.* params)
  const lockScale = SCALES[sc.harm] ? sc.harm : SCALES[sc.id] && sc.mel.length === 7 ? sc.id : 'minor';
  const makePart = (name, zh, role, slot, patch, gain, pan, events, extra = {}) => {
    const params = { ...(patch.params || {}) };
    if (patchTraits(patch).chordMem) { params['scale.root'] = key; params['scale.type'] = lockScale; }
    return {
      name, zh, role, slot, color: PART_COLORS[slot] || '#5cf2ff',
      patch: { params, macros: (patch.macros || []).map(m => ({ name: m.name, targets: (m.targets || []).map(t => ({ ...t })) })) },
      gain, pan, events, ...extra,
    };
  };
  const sortEv = ev => ev.sort((a, b) => a.beat - b.beat || (a.type === 'on') - (b.type === 'on') || (a.note ?? 0) - (b.note ?? 0));

  // ── lead part ──
  const leadEvents = [];
  let melody = null;
  let chordVoicings = null;
  const melRange = MEL_RANGE[leadRole] || MEL_RANGE.lead;
  if (plays === 'melody' || plays === 'comp') {
    const range = plays === 'comp' ? MEL_RANGE.keys : melRange;
    melody = genMelody(ctx, { range });
    const legato = style.legato && (leadRole === 'lead' || leadRole === 'strings');
    const f = ctx.feel;
    for (let i = 0; i < melody.length; i++) {
      const m = melody[i];
      const next = melody[i + 1];
      let dur = m.dur * (style.id === 'chiptune' ? 0.8 : 0.92);
      if (legato && next && Math.abs(next.beat - (m.beat + m.dur)) < 1e-6 && Math.abs(next.note - m.note) <= 5 && m.dur <= 1) dur = m.dur + 0.06; // slur → glide on mono leads
      // pentatonic ornament: grace note from a scale step above before long strong notes
      if (style.grace && m.strong && m.dur >= 1 && i > 0 && rngFor(seed, 'grace', variation, i).chance(0.45)) {
        const mel = melodyScale(sc, key);
        let g = m.note + 1;
        while (!mel.includes(mod12(g)) && g < m.note + 4) g++;
        pushNote(leadEvents, Math.max(0, m.beat - 0.09), g, 0.08, m.vel * 0.7, lengthBeats);
      }
      pushNote(leadEvents, f(m.beat), m.note, dur, m.vel, lengthBeats);
    }
    slots.melody = 'lead';
    if (plays === 'comp') {
      // keys: rhythmic comp in the middle register under the melody + left-hand roots
      const compHow = { sustain: 'sustain', swell: 'sustain', chipArp: 'chipArp', lofiComp: 'lofiComp', houseStab: 'houseStab', roll: 'roll' }[style.chordRhythm] || 'sustain';
      const comp = chordPart(ctx, compHow,
        { voicing: { lo: 52, hi: 71, top: 67, n: 3, rootless: true, maxSpan: 12 }, traits: leadTraits });
      for (const e of comp.events) { e.vel = clampVel(e.vel * 0.82); leadEvents.push(e); }
      for (const ch of tl) for (let b = ch.beat; b < ch.beat + ch.beats - 1e-6; b += 4) pushNote(leadEvents, ctx.feel(b, 0.4), nearestPc(ch.root, 43), Math.min(4, ch.beat + ch.beats - b) - 0.1, b === ch.beat ? 0.66 : 0.56, lengthBeats);
      chordVoicings = comp.voicings;
      slots.chords = 'lead';
    }
  } else if (plays === 'chords' || plays === 'held') {
    const cp = chordPart(ctx, plays === 'held' ? 'held' : (style.chordRhythm === 'chipArp' ? 'sustain' : style.chordRhythm), { traits: leadTraits, voicing: plays === 'held' ? { lo: 53, hi: 74, n: 4, top: 69, maxSpan: 14 } : {} });
    leadEvents.push(...cp.events);
    chordVoicings = cp.voicings;
    slots.chords = 'lead';
  } else if (plays === 'bass') {
    leadEvents.push(...bassPart(ctx, { always: true }));
    slots.bass = 'lead';
  } else if (plays === 'arp') {
    leadEvents.push(...arpPart(ctx, { lo: melRange.lo - 4, hi: melRange.hi - 2 }));
    slots.arp = 'lead';
  } else if (plays === 'texture') {
    leadEvents.push(...texturePart(ctx));
    slots.texture = 'lead';
  }
  const leadSlotName = plays === 'drums' ? drumSlotForPatch({ ...leadPatch, tags: lead.tags, name: lead.name }) : null;
  const rides = plays === 'drums' ? [] : pickRides(leadPatch, style, intensity);
  const leadGain = ({ melody: leadRole === 'strings' ? 2 : 0, comp: -1, chords: -2, held: 1, bass: style.mix.bass + 2, arp: 1, texture: -2, drums: -1 }[plays] ?? 0);

  // ── backing: candidate parts with priorities (the ensemble plays at most MAX_PARTS parts) ──
  const cands = [];
  const cand = (prio, order, name, zh, role, slot, patch, gain, pan, events, extra = {}) => {
    if (!events.length || !patch) return;
    cands.push({ prio, order, part: makePart(name, zh, role, slot, patch, gain, pan, sortEv(events), extra) });
  };
  const drumsOn = !!backing.drums;
  const userDrum = backing.drums && typeof backing.drums === 'object' && backing.drums.params ? backing.drums : null;
  const kickNote = (() => { // the kick is tuned to the key: root or fifth, whichever is closest to A1 (55 Hz)
    const a = nearestPc(key, 33), b = nearestPc(mod12(key + 7), 33);
    return Math.abs(a - 33) <= Math.abs(b - 33) ? a : b;
  })();

  // chords
  if (!slots.chords && backing.pad && backing.pad.params) {
    const t = patchTraits(backing.pad);
    const how = t.arp ? 'held' : style.chordRhythm;
    const cp = chordPart(ctx, how, { traits: t, voicing: how === 'held' ? { lo: 53, hi: 74, n: 4, top: 69, maxSpan: 14 } : {} });
    const g = how === 'held' ? -5 : how === 'chipArp' ? -8 : style.chordRhythm === 'lofiComp' || style.chordRhythm === 'houseStab' ? -5 : -6;
    cand(3, 2, 'Chords', '和弦', 'chords', 'chords', backing.pad, g, 0, cp.events, { presetName: backing.pad.name || null });
    if (!chordVoicings) chordVoicings = cp.voicings;
    slots.chords = 'backing';
  }
  // bass
  if (!slots.bass && backing.bass && backing.bass.params) {
    cand(1, 3, 'Bass', '貝斯', 'bass', 'bass', backing.bass, style.mix.bass, 0, bassPart(ctx, {}), { presetName: backing.bass.name || null });
    slots.bass = 'backing';
  }
  // extra: a melody when the lead is not melodic, otherwise an arpeggio / ostinato counterpart
  const extra = backing.extra && (backing.extra.patch || backing.extra.params) ? (backing.extra.patch ? backing.extra : { patch: backing.extra, role: backing.extra.category || 'pluck' }) : null;
  if (extra) {
    const t = patchTraits(extra.patch);
    const exRole = extra.role || 'pluck';
    let evs, what;
    if (!slots.melody && !t.arp && !t.chordMem) {
      const r = MEL_RANGE[exRole] || MEL_RANGE.lead;
      const m = genMelody({ ...ctx, seed: hashSeed(seed, 'extra') }, { range: r });
      evs = [];
      for (const n of m) pushNote(evs, ctx.feel(n.beat), n.note, n.dur * 0.92, n.vel * 0.95, lengthBeats);
      what = 'melody';
      if (!melody) melody = m;
    } else if (t.arp) {
      evs = chordPart(ctx, 'held', { traits: t, voicing: { lo: 53, hi: 74, n: 4, top: 69, maxSpan: 14 } }).events;
      what = 'held';
    } else if (t.chordMem) { // chord-memory stabs on the chord roots
      evs = chordPart(ctx, style.chordRhythm === 'sustain' || style.chordRhythm === 'swell' || style.chordRhythm === 'chipArp' ? 'houseStab' : style.chordRhythm, { traits: t }).events;
      what = 'arp';
    } else {
      const r = MEL_RANGE[exRole] || MEL_RANGE.pluck;
      evs = arpPart(ctx, { lo: Math.max(55, r.lo - 5), hi: r.hi - 4, minEnergy: (style.enter && style.enter.counter) ?? 0.6 });
      what = 'arp';
    }
    const isMel = what === 'melody';
    cand(6, isMel ? 1 : 4, isMel ? 'Melody' : 'Counter', isMel ? '旋律' : '點綴', what, 'extra', extra.patch, isMel ? -1 : what === 'held' ? -5 : -6, isMel ? -0.1 : 0.22, evs,
      { presetName: extra.patch.name || extra.name || null });
    if (evs.length) { if (isMel) slots.melody = 'extra'; else slots.arp = slots.arp || 'extra'; }
  }
  // drums: the style's kit = 2 parts (kick / hand drums + "top" or shaker). A factory drum preset takes the kick
  // part when its tags say kick/808, otherwise it plays tom-style accents in an extra "perc" part.
  const userSlot = plays === 'drums' ? leadSlotName : userDrum ? drumSlotForPatch(userDrum) : null;
  const kitNote = (kp, slot) => {
    if (slot === 'hat') return 96;
    if (kp.patch === 'taiko') return slot === 'kick' ? nearestPc(key, 45) : nearestPc(key, 57);
    if (kp.patch === 'tabla') return slot === 'kick' ? nearestPc(key, 45) : nearestPc(key, 74);
    return slot === 'kick' ? kickNote : 50;
  };
  let kickTaken = false;
  if (drumsOn) {
    style.kit.forEach((kp, i) => {
      const kickOnly = kp.slots.length === 1 && kp.slots[0] === 'kick';
      let patch = kitPatch(kp.patch), name = kp.id, presetName = null;
      if (kickOnly && userSlot === 'kick') {
        kickTaken = true;
        if (plays === 'drums') return; // the lead part plays the kick
        patch = userDrum; name = 'Kick'; presetName = userDrum.name || null;
      }
      const evs = [];
      for (const slot of kp.slots) {
        const opts = { note: kitNote(kp, slot), hiNote: kitNote(kp, slot) };
        if (kp.patch === 'tabla' && slot === 'snare') opts.alternate = nearestPc(mod12(key + 7), 79);
        evs.push(...drumSlot(ctx, slot, opts));
      }
      const g = kp.patch === 'shaker' || kp.patch === 'tick' ? -3 : kp.patch === 'tabla' ? 3 : kp.membrane ? -1 : kickOnly ? 0 : -2;
      cand(i === 0 ? 2 : 4, 5 + i, name, kp.zh, 'drums', i === 0 ? 'kick' : 'hat', patch, presetName ? g + 1 : g, i === 0 ? 0 : 0.14, evs,
        { kit: presetName ? null : kp.patch, presetName });
    });
    slots.drums = 'kit';
  }
  if (userDrum && plays !== 'drums' && !kickTaken) {
    const evs = drumSlot({ ...ctx, style: { ...style, drumStyle: style.drumStyle === 'pentatonic' ? 'pentatonic' : 'cinematic' } }, 'kick', { note: userSlot === 'kick' ? kickNote : nearestPc(key, 48) });
    cand(5, 7, 'Perc', '打擊', 'drums', 'perc', userDrum, -5, -0.2, evs, { presetName: userDrum.name || null });
    slots.drums = slots.drums ? 'kit+perc' : 'perc';
  }
  if (plays === 'drums') {
    // the lead (a drum preset) plays its slot's groove; a non-kick percussion preset plays tom-style accents
    const asKick = leadSlotName === 'kick';
    const note = asKick ? kickNote : leadSlotName === 'snare' ? 50 : leadSlotName === 'hat' ? 96 : nearestPc(key, 45);
    const slot = asKick || leadSlotName === 'perc' ? 'kick' : leadSlotName;
    const grooveStyle = leadSlotName === 'perc' && !['cinematic', 'pentatonic'].includes(style.drumStyle) ? { ...style, drumStyle: 'cinematic' } : style;
    leadEvents.push(...drumSlot({ ...ctx, style: grooveStyle }, slot, { note, hiNote: nearestPc(key, 57), always: true }));
    slots.drums = drumsOn ? 'kit+lead' : 'lead';
  }

  // budget: highest priorities win, then display order (lead first = index 0 = "your preset")
  cands.sort((a, b) => a.prio - b.prio || a.order - b.order);
  const kept = cands.slice(0, MAX_PARTS - 1);
  const dropped = cands.slice(MAX_PARTS - 1).map(c => c.part.name);
  kept.sort((a, b) => a.order - b.order);
  const leadEv = sortEv(leadEvents.concat(rideEvents(rides, ctx)));
  const leadPart = makePart('Lead', '你的音色', plays, 'lead', leadPatch, leadGain, 0, leadEv, { presetName: lead.name || leadPatch.name || null });
  const parts = [leadPart, ...kept.map(c => c.part)];
  const seen = new Set();
  for (const p of parts) { let n = p.name, k = 2; while (seen.has(n)) n = `${p.name} ${k++}`; p.name = n; seen.add(n); }
  // mix trim (≈ −16 LUFS for the whole jam) and dynamics: melodic parts play softer in the quiet sections
  for (const p of parts) {
    p.gain = Math.round((p.gain + (style.mix.trim || 0)) * 10) / 10;
    if (p.role === 'drums') continue;
    for (const e of p.events) if (e.type === 'on') e.vel = clampVel(e.vel * (0.86 + 0.34 * (plan.energy[Math.min(bars - 1, Math.floor(e.beat / 4))] - 0.6)));
  }

  const keyName = `${names[key]} ${JAM_SCALES[sc.id].zh}`;
  return {
    bpm, lengthBeats, loop: o.loop !== undefined ? !!o.loop : !endless,
    sections: plan.sections,
    parts,
    meta: {
      generator: 'aurora-jam', version: 1,
      style: style.id, key, scale: sc.id, harm: sc.harm, keyName, keyNameEn: `${names[key]} ${JAM_SCALES[sc.id].en}`,
      bars, seed, variation, intensity: r4(intensity), endless, kind: plan.kind,
      progression: { a: progs.a.seq, b: progs.b.seq },
      chords: tl.map(c => ({ beat: c.beat, beats: c.beats, symbol: c.symbol, root: c.root, pcs: c.pcs.slice(), degree: c.degree + 1, prog: c.prog })),
      energy: plan.energy.map(r4),
      leadRole, leadPlays: plays, slots, dropped,
      rides: rides.map(r => ({ ...r })),
      melodyScale: melodyScale(sc, key), harmScale: sc.harmPcs.map(x => mod12(key + x)),
      melody: melody ? melody.map(m => ({ beat: r4(m.beat), note: m.note, dur: r4(m.dur), strong: m.strong, chordBeat: r4(m.chordBeat) })) : null,
      voicings: chordVoicings ? chordVoicings.map(v => ({ beat: v.beat, notes: v.notes.slice() })) : null,
      scaleLock: { 'scale.root': key, 'scale.type': sc.id },
    },
  };
}

/** Suggested defaults for a style: { bpm, key, scale }. */
export function styleDefaults(styleId) {
  const s = STYLES[styleId] || STYLES.ambient;
  return { bpm: s.bpm, key: s.key, scale: s.scale, bars: 8 };
}

/** Role of a preset in the jam from its category (and demo phrase as a hint). */
export function roleForPreset(preset) {
  if (!preset) return 'lead';
  const cat = preset.category;
  if (ROLE_FOR_CATEGORY[cat]) return ROLE_FOR_CATEGORY[cat];
  const demo = preset.demo;
  return ROLE_FOR_CATEGORY[demo] || 'lead';
}

// ───────────────────────── backing-band suggestions ─────────────────────────
/**
 * What the lead part will do for a role (+ patch traits) in a style:
 * 'melody' | 'comp' | 'chords' | 'held' | 'bass' | 'arp' | 'drums' | 'texture'.
 */
export function leadPlays(role, patch, styleId) {
  const style = STYLES[styleId] || STYLES.ambient;
  const t = patchTraits(patch);
  if (t.chordMem && role !== 'bass' && role !== 'drum') return 'chords';
  switch (role) {
    case 'pad': return t.arp ? 'held' : 'chords';
    case 'keys': return t.arp ? 'held' : t.mono ? 'melody' : 'comp';
    case 'bass': return 'bass';
    case 'arp': return t.arp ? 'held' : 'arp';
    case 'pluck': return t.arp ? 'held' : style.pluckAs;
    case 'bell': return t.arp ? 'held' : style.bellAs;
    case 'drum': return 'drums';
    case 'fx': return 'texture';
    default: return t.arp ? 'held' : 'melody';
  }
}

// Preferred factory presets per style and slot: names first (curated), then tag / category matches.
const BACKING_PREFS = {
  ambient: {
    pad: { names: ['Aurora Pad', 'Frost Lantern', 'Glass Harmonica', "String Machine '79"], tags: ['ambient', 'lush', 'ethereal', 'wide', 'evolving'], cats: ['pad', 'strings', 'bell'] },
    bass: { names: ['Abyssal Sub', 'Deep Bass'], tags: ['sub', 'clean', 'deep'], cats: ['bass'] },
    counter: { names: ['Starlight Harp', 'Snowglobe Cascade', 'Dewdrop Kalimba', 'Celestial Carillon'], tags: ['shimmer', 'ethereal', 'bell', 'crystal'], cats: ['pluck', 'bell', 'arp'] },
    melody: { names: ['Meadow Whistle', 'Celestial Carillon', 'Starlight Harp', 'Glass Harmonica'], tags: ['soft', 'airy', 'ethereal'], cats: ['lead', 'bell', 'pluck'] },
  },
  lofi: {
    pad: { names: ['Moonlit Suitcase', 'Faded Summer', 'Amber Reeds', 'Cassette Bloom'], tags: ['lo-fi', 'lofi', 'electric piano', 'tape'], cats: ['keys'] },
    bass: { names: ['Walnut Upright', 'Deep Bass', 'Abyssal Sub'], tags: ['upright', 'jazz', 'acoustic'], cats: ['bass'] },
    counter: { names: ['Midnight Vibraphone', 'Nylon Serenade', 'Cassette Bloom', 'Moonlit Carousel'], tags: ['jazz', 'lofi', 'vibraphone'], cats: ['bell', 'pluck'] },
    melody: { names: ['Cassette Bloom', 'Midnight Vibraphone', 'Ebony Clarinet', 'Meadow Whistle'], tags: ['lofi', 'jazz', 'mellow'], cats: ['pluck', 'bell', 'lead'] },
  },
  synthwave: {
    pad: { names: ["String Machine '79", 'Sunset Poly', 'Aurora Pad'], tags: ['80s', 'vintage', 'analog', 'string-machine'], cats: ['pad', 'keys', 'strings'] },
    bass: { names: ['Rubber Pulse', 'Deep Bass', 'Tidal Reese'], tags: ['synthpop', '80s', 'analog'], cats: ['bass'] },
    counter: { names: ['Midnight Freeway', 'Borealis Sequencer', 'Prism Shards'], tags: ['synthwave', 'sequence', 'arp'], cats: ['arp', 'pluck'] },
    melody: { names: ['Polaris Sync', 'Horizon Throw', 'Monolith Solo', 'Stellar Supersaw'], tags: ['sync', 'bright', 'analog'], cats: ['lead'] },
  },
  house: {
    pad: { names: ['Gospel Rotary', 'Velvet Dub Stabs', 'Sunset Poly', 'Moonlit Suitcase'], tags: ['organ', 'house', 'stab', 'chord'], cats: ['keys', 'arp', 'pad'] },
    bass: { names: ['Warehouse Organ', 'Deep Bass', 'Rubber Pulse'], tags: ['house', '90s', 'organ'], cats: ['bass'] },
    counter: { names: ['Prism Shards', 'Hyperion Gate', 'Obsidian Techno', 'Sunrise Anthem'], tags: ['house', 'techno', 'pluck', 'digital'], cats: ['pluck', 'arp'] },
    melody: { names: ['Prism Shards', 'Vowel Siren', 'Polaris Sync'], tags: ['vocal', 'bright'], cats: ['lead', 'pluck'] },
  },
  cinematic: {
    pad: { names: ['Aurora Symphony', 'Vesper Choir', 'Twilight Horn', 'Aurora Pad'], tags: ['orchestral', 'cinematic', 'choir', 'ensemble'], cats: ['strings', 'pad'] },
    bass: { names: ['Abyssal Sub', 'Rosewood Cello', 'Deep Bass'], tags: ['sub', 'deep', 'cello'], cats: ['bass', 'strings'] },
    counter: { names: ['Storm Ostinato', 'Borealis Sequencer', 'Pizzicato Hall'], tags: ['ostinato', 'cinematic', 'rhythmic'], cats: ['strings', 'arp', 'pluck'] },
    melody: { names: ['Horizon Throw', 'Solar Brass', 'Rosewood Cello', 'Autumn Moon Erhu'], tags: ['cinematic', 'brass', 'expressive'], cats: ['lead', 'strings'] },
  },
  pentatonic: {
    pad: { names: ['Jade Guzheng', 'Paper Lantern Echoes', 'Nylon Serenade', 'Frost Lantern'], tags: ['guzheng', 'koto', 'asian', 'harp'], cats: ['pluck', 'arp', 'pad'] },
    bass: { names: ['Walnut Upright', 'Abyssal Sub'], tags: ['acoustic', 'upright', 'sub'], cats: ['bass'] },
    counter: { names: ['Paper Lantern Echoes', 'Dewdrop Kalimba', 'Ombak Gamelan', 'Wind Chime Garden'], tags: ['koto', 'gamelan', 'world', 'chimes'], cats: ['arp', 'pluck', 'bell'] },
    melody: { names: ['Bamboo Dizi', 'Andes Pan Flute', 'Autumn Moon Erhu', 'Jade Guzheng'], tags: ['flute', 'erhu', 'asian', 'world'], cats: ['lead', 'strings', 'pluck'] },
  },
  chiptune: {
    pad: { names: ['Pixel Quest', 'Sunset Poly'], tags: ['chiptune', '8-bit', 'retro'], cats: ['arp', 'keys', 'pad'] },
    bass: { names: ['Rubber Pulse', 'Deep Bass'], tags: ['8-bit', 'chiptune', 'synthpop'], cats: ['bass'] },
    counter: { names: ['Pixel Quest', 'Prism Shards'], tags: ['chiptune', '8-bit', 'retro'], cats: ['arp', 'pluck'] },
    melody: { names: ['Cartridge Hero', 'Polaris Sync'], tags: ['chiptune', '8-bit', 'retro'], cats: ['lead'] },
  },
};

function findBacking(presets, pref, exclude) {
  const ok = p => p && p.params && !exclude.has(p.name);
  for (const n of pref.names) { const p = presets.find(x => x && x.name === n); if (ok(p)) return p; }
  let best = null, bestScore = 0;
  for (const p of presets) {
    if (!ok(p)) continue;
    const tags = (p.tags || []).map(t => String(t).toLowerCase());
    let sc = 0;
    for (const t of pref.tags) if (tags.includes(t)) sc += 2;
    const ci = pref.cats.indexOf(p.category);
    if (ci >= 0) sc += 3 - ci;
    else sc = 0;
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  return best;
}

/**
 * Sensible factory presets for the backing band of a style (pure; the panel and tools/render-jam.mjs share it).
 * @param {string} styleId
 * @param {object[]} presets factory presets (src/presets/index.js PRESETS)
 * @param {{lead?: {name?:string, role?:string, patch?:object}}} [opts]
 * @returns {{pad: object|null, bass: object|null, extra: object|null, extraRole: string|null, drums: object|null, extraAs: 'melody'|'counter'}}
 */
export function suggestBacking(styleId, presets = [], opts = {}) {
  const prefs = BACKING_PREFS[styleId] || BACKING_PREFS.ambient;
  const lead = opts.lead || {};
  const exclude = new Set(lead.name ? [lead.name] : []);
  const plays = leadPlays(lead.role || 'lead', lead.patch, styleId);
  const pad = findBacking(presets, prefs.pad, exclude);
  if (pad) exclude.add(pad.name);
  const bass = findBacking(presets, prefs.bass, exclude);
  if (bass) exclude.add(bass.name);
  const melodic = plays === 'melody' || plays === 'comp';
  const extraAs = melodic ? 'counter' : 'melody';
  const extra = findBacking(presets, melodic ? prefs.counter : prefs.melody, exclude);
  return { pad, bass, extra, extraRole: extra ? roleForPreset(extra) : null, extraAs, drums: null };
}

// ───────────────────────── theory / mix checks (Node tests + tools/render-jam.mjs) ─────────────────────────
/**
 * Music-theory sanity checks on a generated song. Returns { ok, issues:[string], stats:{…} }.
 * • chords diatonic to the harmony mode • melody notes in the melody scale; strong-beat notes are chord tones
 * • no minor-2nd clash between the melody and the sounding chord voicing on strong beats • voice ranges
 * • pad voice-leading (average movement per change) • density per bar • event sanity (beats, durations, notes).
 */
export function checkJam(song) {
  const issues = [];
  const m = song.meta || {};
  const harm = new Set(m.harmScale || []);
  const mel = new Set(m.melodyScale || []);
  const L = song.lengthBeats;
  const stats = { parts: song.parts.length, notes: 0, perPart: {} };
  // events
  for (const p of song.parts) {
    let n = 0;
    const perBar = new Array(Math.ceil(L / 4)).fill(0);
    let lo = 127, hi = 0;
    for (const e of p.events) {
      if (!(e.beat >= 0 && e.beat < L)) issues.push(`${p.name}: event beat ${e.beat} outside 0..${L}`);
      if (e.type === 'on') {
        n++;
        if (!(e.note >= 0 && e.note <= 127)) issues.push(`${p.name}: bad note ${e.note}`);
        if (!(e.dur > 0) || e.beat + e.dur > L + 1e-6) issues.push(`${p.name}: bad duration ${e.dur} at ${e.beat}`);
        if (!(e.vel > 0 && e.vel <= 1)) issues.push(`${p.name}: bad velocity ${e.vel}`);
        perBar[Math.floor(e.beat / 4)]++;
        lo = Math.min(lo, e.note); hi = Math.max(hi, e.note);
      } else if (e.type === 'ramp-macro' || e.type === 'macro') {
        const v = e.type === 'macro' ? e.value : e.to;
        if (!(v >= 0 && v <= 1)) issues.push(`${p.name}: macro value ${v} out of range`);
        if (e.type === 'ramp-macro' && e.beat + e.beats > L + 1e-6) issues.push(`${p.name}: macro ramp past the end`);
      }
    }
    stats.notes += n;
    stats.perPart[p.name] = { notes: n, maxPerBar: Math.max(...perBar), lo: n ? lo : null, hi: n ? hi : null };
    if (Math.max(...perBar) > 72) issues.push(`${p.name}: too dense (${Math.max(...perBar)} notes in a bar)`);
  }
  // chords
  for (const c of m.chords || []) {
    for (const pc of c.pcs) if (!harm.has(pc)) issues.push(`chord ${c.symbol} @${c.beat}: ${pc} not in the harmony scale`);
  }
  const chordAtBeat = b => { let cur = m.chords[0]; for (const c of m.chords) if (b >= c.beat - 1e-6) cur = c; return cur; };
  // melody
  let strongTotal = 0, strongOk = 0, clashes = 0;
  if (m.melody) {
    for (const n of m.melody) {
      const pc = mod12(n.note);
      if (!mel.has(pc)) issues.push(`melody note ${n.note} @${n.beat} not in the melody scale`);
      const c = chordAtBeat(n.chordBeat ?? n.beat);
      if (n.strong) {
        strongTotal++;
        if (c.pcs.includes(pc)) strongOk++;
        else issues.push(`melody ${n.note} @${n.beat} (strong) is not a chord tone of ${c.symbol}`);
      }
    }
    // clashes with the sounding voicing: a sustained melody note a semitone (or minor 9th) above a chord note
    if (m.voicings) {
      for (const n of m.melody) {
        if (n.dur < 0.5) continue; // short passing tones are fine
        let v = m.voicings[0];
        for (const x of m.voicings) if ((n.chordBeat ?? n.beat) >= x.beat - 1e-6) v = x;
        for (const x of v.notes) if (n.note > x && mod12(n.note - x) === 1) { clashes++; issues.push(`melody ${n.note} @${n.beat} rubs a minor 9th/2nd above voicing note ${x}`); }
      }
    }
    // leaps
    for (let i = 1; i < m.melody.length; i++) {
      const iv = Math.abs(m.melody[i].note - m.melody[i - 1].note);
      if (iv > 12) issues.push(`melody leap of ${iv} semitones @${m.melody[i].beat}`);
    }
  }
  stats.strongChordTonePct = strongTotal ? Math.round((strongOk / strongTotal) * 100) : null;
  stats.clashes = clashes;
  // voicings: range & voice leading
  if (m.voicings && m.voicings.length) {
    let move = 0, changes = 0;
    for (let i = 0; i < m.voicings.length; i++) {
      const v = m.voicings[i].notes;
      if (v[0] < 36 || v[v.length - 1] > 88) issues.push(`voicing @${m.voicings[i].beat} out of range ${v[0]}..${v[v.length - 1]}`);
      for (let j = 1; j < v.length; j++) if ((v[j] + v[j - 1]) / 2 < 50 && v[j] - v[j - 1] < 5) issues.push(`muddy low interval in voicing @${m.voicings[i].beat}: ${v[j - 1]}-${v[j]}`);
      if (i > 0) {
        const p = m.voicings[i - 1].notes;
        if (p.length === v.length) { for (let j = 0; j < v.length; j++) move += Math.abs(v[j] - p[j]); changes++; }
      }
    }
    const voices = m.voicings[0].notes.length || 1;
    stats.avgVoiceMove = changes ? Math.round((move / changes / voices) * 10) / 10 : 0; // semitones per voice per change
    if (changes && move / changes / voices > 3.5) issues.push(`jumpy voice leading (avg ${stats.avgVoiceMove} semitones per voice)`);
  }
  // bass: range & roots on chord changes
  const bass = song.parts.find(p => p.slot === 'bass' || (p.slot === 'lead' && p.role === 'bass'));
  if (bass) {
    let rootsOk = 0, rootsN = 0;
    for (const c of m.chords) {
      // first bass note of the chord (on the change, or the first off-beat hit in house-style lines)
      const hit = bass.events.find(e => e.type === 'on' && e.beat > c.beat - 0.08 && e.beat < c.beat + 1);
      if (hit) { rootsN++; if (mod12(hit.note) === c.root) rootsOk++; }
    }
    stats.bassRootPct = rootsN ? Math.round((rootsOk / rootsN) * 100) : null;
    for (const e of bass.events) if (e.type === 'on' && (e.note < 24 || e.note > 55)) issues.push(`bass note ${e.note} out of range`);
    for (const e of bass.events) if (e.type === 'on' && !harm.has(mod12(e.note))) issues.push(`bass note ${e.note} @${e.beat} outside the harmony scale`);
  }
  return { ok: issues.length === 0, issues, stats };
}
