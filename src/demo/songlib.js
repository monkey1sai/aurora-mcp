// Song composition helpers — pure functions producing sequencer events (beats). See docs/SONGS.md.
// Pure ES module (browser + Node; no DOM / Node APIs, no Math.random: everything is deterministic).
//
// Event format (docs/ARCHITECTURE.md §6, src/dsp/sequencer.js):
//   {beat, type:'on', note, vel /*0..1*/, dur /*beats*/}   {beat, type:'off', note}
//   {beat, type:'param', id, value}   {beat, type:'ramp', id, to, beats[, from]}
//   {beat, type:'macro', index /*0..3*/, value /*0..1*/}   {beat, type:'ramp-macro', index, to, beats}
//
//   import * as L from '../songlib.js';
//   const pad  = L.chords('Am9 Fmaj7 C G6', { octave: 4, voiceLead: true, vel: 0.6 });
//   const bass = L.bassline('Am9 Fmaj7 C G6', 'x..x..x.', { octave: 2 });
//   const beat = L.repeat(L.drums({ kick: 'x...x...x...x...', hat: '..x...x...x...x.' }), 4, 4);
//   const lead = L.melody('E5 - D5 C5 | A4 - - . | G4 A4 C5 D5 | E5 - - -', { step: 1 });

// ───────────────────────── notes ─────────────────────────

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Parse an accidental string ('#', 'b', '♯', '♭', 'x', 'bb', '') → semitone offset. */
function accidental(s) {
  let o = 0;
  for (const ch of s) {
    if (ch === '#' || ch === '♯') o += 1;
    else if (ch === 'b' || ch === '♭') o -= 1;
    else if (ch === 'x' || ch === '𝄪') o += 2;
    else throw new Error(`songlib: bad accidental '${ch}'`);
  }
  return o;
}

/**
 * Pitch class (0..11) of a note letter with accidentals: 'C' → 0, 'F#' → 6, 'Bb' → 10, 'Cb' → 11.
 * @param {string|number} name
 * @returns {number}
 */
export function pc(name) {
  if (typeof name === 'number') return ((Math.round(name) % 12) + 12) % 12;
  const m = /^\s*([A-Ga-g])([#b♯♭x]*)\s*$/.exec(String(name));
  if (!m) throw new Error(`songlib: not a pitch class '${name}'`);
  return (((LETTER[m[1].toUpperCase()] + accidental(m[2])) % 12) + 12) % 12;
}

/**
 * Note name → MIDI number. C4 = 60 (scientific pitch, same as params.js noteName). Numbers pass through.
 * midi('C#4') = 61, midi('Bb3') = 58, midi('E♭5') = 75, midi('Cb4') = 59, midi('B#3') = 60, midi('A-1') = 9.
 * @param {string|number} name
 * @returns {number}
 */
export function midi(name) {
  if (typeof name === 'number') {
    if (!Number.isFinite(name)) throw new Error(`songlib: bad note ${name}`);
    return Math.round(name);
  }
  const m = /^\s*([A-Ga-g])([#b♯♭x]*)(-?\d+)\s*$/.exec(String(name));
  if (!m) throw new Error(`songlib: bad note name '${name}' (expected e.g. 'C#4', 'Bb3')`);
  const n = 12 * (Number(m[3]) + 1) + LETTER[m[1].toUpperCase()] + accidental(m[2]);
  if (n < 0 || n > 127) throw new Error(`songlib: note '${name}' out of MIDI range`);
  return n;
}
/** Alias of midi(). */
export const note = midi;

/**
 * MIDI number → name ('C#4'); { flats: true } → 'Db4'.
 * @param {number} n
 * @param {{flats?:boolean}} [opts]
 */
export function noteName(n, { flats = false } = {}) {
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  return names[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

/** General-MIDI drum map (use with drums()). Keys are friendly names. */
export const GM = Object.freeze({
  kick: 36, kick2: 35, rim: 37, snare: 38, clap: 39, snare2: 40,
  floorTom: 41, hat: 42, closedHat: 42, pedalHat: 44, openHat: 46,
  tomLow: 45, tomMid: 47, tomHi: 50, tom: 48,
  crash: 49, crash2: 57, ride: 51, rideBell: 53, splash: 55, china: 52,
  tamb: 54, cowbell: 56, bongoHi: 60, bongoLo: 61, congaMute: 62, congaHi: 63, congaLo: 64,
  timbaleHi: 65, timbaleLo: 66, agogoHi: 67, agogoLo: 68, cabasa: 69, shaker: 70, maracas: 70,
  claves: 75, blockHi: 76, blockLo: 77, triangle: 81, triangleOpen: 81,
});

// ───────────────────────── scales & keys ─────────────────────────

/** Scale interval tables (semitones from the root). Includes every scale of params.js SCALES. */
export const SCALES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
  harmMinor: [0, 2, 3, 5, 7, 8, 11], melMinor: [0, 2, 3, 5, 7, 9, 11],
  pentMajor: [0, 2, 4, 7, 9], pentMinor: [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
  inSen: [0, 1, 5, 7, 10], hirajoshi: [0, 2, 3, 7, 8], yo: [0, 2, 5, 7, 9], wholeTone: [0, 2, 4, 6, 8, 10],
  // Chinese pentatonic modes (宮商角徵羽) — same pitch set as pentMajor, different tonic
  gong: [0, 2, 4, 7, 9], shang: [0, 2, 5, 7, 10], jue: [0, 3, 5, 8, 10], zhi: [0, 2, 5, 7, 9], yu: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
});

/**
 * Normalise a key: {root:'D', scale:'dorian'} | 'D dorian' | 'Am' | 'F#' → {root:'D', scale:'dorian', pc, steps}.
 * @param {object|string} key
 */
export function keyOf(key) {
  if (key && typeof key === 'object' && key.steps) return key;
  let root, scale;
  if (typeof key === 'string') {
    const m = /^\s*([A-Ga-g][#b♯♭]*)\s*(m(?!aj)|min(?:or)?|maj(?:or)?)?\s*([A-Za-z]+)?\s*$/.exec(key);
    if (!m) throw new Error(`songlib: bad key '${key}'`);
    root = m[1];
    scale = m[3] || (m[2] && /^m(in(or)?)?$/.test(m[2]) ? 'minor' : 'major');
  } else if (key && typeof key === 'object') {
    root = key.root ?? 'C'; scale = key.scale ?? 'major';
  } else throw new Error('songlib: key required');
  const steps = SCALES[scale];
  if (!steps) throw new Error(`songlib: unknown scale '${scale}' (known: ${Object.keys(SCALES).join(', ')})`);
  return { root: String(root), scale, pc: pc(root), steps };
}

/**
 * Scale note by 0-based step: degree(key, 0, 4) = root in octave 4; step 7 in a heptatonic scale = root + 12;
 * negative steps go down. Octave of the root follows scientific pitch (C4 = 60).
 * @param {object|string} key
 * @param {number} step 0-based scale step (integer)
 * @param {number} [octave=4]
 */
export function degree(key, step, octave = 4) {
  const k = keyOf(key);
  const n = k.steps.length;
  const s = Math.round(step);
  const oct = Math.floor(s / n), idx = s - oct * n;
  return 12 * (octave + 1) + k.pc + k.steps[idx] + 12 * oct;
}

/**
 * All scale notes between lo and hi (inclusive, MIDI or names).
 * @returns {number[]}
 */
export function scaleNotes(key, lo = 48, hi = 84) {
  const k = keyOf(key), a = midi(lo), b = midi(hi), out = [];
  for (let n = a; n <= b; n++) if (k.steps.includes((((n - k.pc) % 12) + 12) % 12)) out.push(n);
  return out;
}

/** Nearest scale note (ties go down, like the synth's scale lock). */
export function snap(n, key) {
  const k = keyOf(key);
  for (let d = 0; d < 12; d++) {
    for (const c of [n - d, n + d]) if (k.steps.includes((((c - k.pc) % 12) + 12) % 12)) return c;
  }
  return n;
}

// ───────────────────────── chords ─────────────────────────

/** Chord qualities → intervals. Aliases map to the same table entry. */
export const CHORD_QUALITIES = Object.freeze({
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7],
  m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7],
  dim: [0, 3, 6], '°': [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], 5: [0, 7],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 69: [0, 4, 7, 9, 14], '6/9': [0, 4, 7, 9, 14], m69: [0, 3, 7, 9, 14],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], 'Δ': [0, 4, 7, 11], 'Δ7': [0, 4, 7, 11],
  m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], '-7': [0, 3, 7, 10], mMaj7: [0, 3, 7, 11], mM7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9], '°7': [0, 3, 6, 9], m7b5: [0, 3, 6, 10], 'ø': [0, 3, 6, 10], 'ø7': [0, 3, 6, 10],
  '7sus4': [0, 5, 7, 10], '7sus2': [0, 2, 7, 10], aug7: [0, 4, 8, 10], '7#5': [0, 4, 8, 10], '7b5': [0, 4, 6, 10],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], M9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], min9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14], add2: [0, 2, 4, 7], madd9: [0, 3, 7, 14], add11: [0, 4, 7, 17], '9sus4': [0, 5, 7, 10, 14],
  '7b9': [0, 4, 7, 10, 13], '7#9': [0, 4, 7, 10, 15], '7#11': [0, 4, 7, 10, 18], 'maj7#11': [0, 4, 7, 11, 18],
  11: [0, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 21], maj13: [0, 4, 7, 11, 14, 21],
  m13: [0, 3, 7, 10, 14, 21],
});

/**
 * Parse a chord symbol: 'Am7', 'F#m7b5', 'Bbmaj9', 'C/E', 'Gsus4', 'D5', 'Ebadd9', 'Cmaj7#11'.
 * @param {string} symbol
 * @returns {{symbol:string, root:number /*pc*\/, quality:string, intervals:number[], bass:number|null /*pc*\/}}
 */
export function parseChord(symbol) {
  const s = String(symbol).trim();
  const m = /^([A-G])([#b♯♭]?)([^/]*)(?:\/([A-G][#b♯♭]?))?$/.exec(s);
  if (!m) throw new Error(`songlib: bad chord symbol '${symbol}'`);
  const quality = m[3];
  const intervals = CHORD_QUALITIES[quality];
  if (!intervals) throw new Error(`songlib: unknown chord quality '${quality}' in '${symbol}' (known: ${Object.keys(CHORD_QUALITIES).filter(Boolean).join(' ')})`);
  return { symbol: s, root: pc(m[1] + m[2]), quality, intervals: intervals.slice(), bass: m[4] ? pc(m[4]) : null };
}

/**
 * Chord symbol → MIDI notes (ascending).
 * @param {string} symbol
 * @param {{octave?:number, inversion?:number, voicing?:'close'|'open'|'drop2'|'spread'|'shell', bass?:boolean|number}} [opts]
 *   octave: octave of the root (close voicing starts at the root, default 4) · inversion: rotate the lowest
 *   notes up an octave · voicing: close (default), open (root down an octave), drop2 (2nd-highest note down an
 *   octave), spread (every other note up an octave), shell (root, 3rd/4th, 7th/6th only) · bass: true adds the
 *   root (or slash bass) an octave below the voicing; a number = that octave for the bass note.
 * @returns {number[]}
 */
export function chord(symbol, { octave = 4, inversion = 0, voicing = 'close', bass = false } = {}) {
  const c = typeof symbol === 'object' && symbol.intervals ? symbol : parseChord(symbol);
  const base = 12 * (octave + 1) + c.root;
  let iv = c.intervals;
  if (voicing === 'shell') {
    const third = iv.find(x => x === 3 || x === 4 || x === 2 || x === 5);
    const sev = iv.find(x => x === 10 || x === 11 || x === 9);
    iv = [0, third ?? 7, sev ?? 7].filter((x, i, a) => a.indexOf(x) === i);
  }
  let notes = iv.map(x => base + x).sort((a, b) => a - b);
  for (let k = 0; k < (inversion | 0) && notes.length; k++) { const lo = notes.shift(); notes.push(lo + 12); }
  if (voicing === 'open' && notes.length >= 3) notes[0] -= 12;
  else if (voicing === 'drop2' && notes.length >= 4) notes[notes.length - 2] -= 12;
  else if (voicing === 'spread') notes = notes.map((x, i) => (i % 2 === 1 ? x + 12 : x));
  notes.sort((a, b) => a - b);
  if (bass !== false && bass !== undefined && bass !== null) {
    const bo = typeof bass === 'number' ? bass : octave - 1;
    let b = 12 * (bo + 1) + (c.bass ?? c.root);
    while (b >= notes[0]) b -= 12;
    notes.unshift(b);
  } else if (c.bass !== null) {
    let b = 12 * (octave + 1) + c.bass;
    while (b >= notes[0]) b -= 12;
    notes.unshift(b);
  }
  return notes;
}

/** Root (or slash-bass) note of a chord symbol in the given octave (default 2). */
export function chordRoot(symbol, octave = 2) {
  const c = parseChord(symbol);
  return 12 * (octave + 1) + (c.bass ?? c.root);
}

/**
 * Voice-lead a progression: every chord (close voicing, all inversions/octaves inside `range`) is placed to
 * minimise total voice movement from the previous one; the first chord is centred in the range (or `start`).
 * @param {(string|number[])[]} symbols chord symbols (or explicit note arrays, kept as-is)
 * @param {{range?:[number|string, number|string], start?:number[], drop2?:boolean}} [opts] range for the voicing
 *   (default ['A3', 'E5']).
 * @returns {number[][]}
 */
export function voiceLead(symbols, { range = ['A3', 'E5'], start = null, drop2 = false } = {}) {
  const lo = midi(range[0]), hi = midi(range[1]);
  const out = [];
  let prev = start ? start.slice().sort((a, b) => a - b) : null;
  const centre = (lo + hi) / 2;
  for (const sym of symbols) {
    if (Array.isArray(sym)) { out.push(sym.slice()); prev = sym.slice().sort((a, b) => a - b); continue; }
    const c = parseChord(sym);
    const cands = [];
    for (let inv = 0; inv < c.intervals.length; inv++) {
      for (let oct = 1; oct <= 7; oct++) {
        const notes = chord(c, { octave: oct, inversion: inv });
        if (c.bass !== null) notes.shift(); // slash bass handled by bass parts
        let v = notes;
        if (drop2 && v.length >= 4) { v = v.slice(); v[v.length - 2] -= 12; v.sort((a, b) => a - b); }
        if (v[0] >= lo && v[v.length - 1] <= hi) cands.push(v);
      }
    }
    if (!cands.length) cands.push(chord(c, { octave: Math.max(0, Math.floor(lo / 12) - 1) }));
    let best = cands[0], bestCost = Infinity;
    for (const v of cands) {
      let cost;
      if (prev) {
        cost = 0;
        for (const x of v) { let d = Infinity; for (const y of prev) d = Math.min(d, Math.abs(x - y)); cost += d; }
        for (const y of prev) { let d = Infinity; for (const x of v) d = Math.min(d, Math.abs(x - y)); cost += d; }
        cost += 0.05 * Math.abs(v.reduce((a, b) => a + b, 0) / v.length - centre);
      } else cost = Math.abs(v.reduce((a, b) => a + b, 0) / v.length - centre);
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
    out.push(best);
    prev = best;
  }
  return out;
}

/**
 * Parse a progression string: chords separated by spaces; '|' bar lines are ignored; 'Am7:2' = 2 beats
 * (default beatsPer); '%' repeats the previous chord; '.' is a rest of beatsPer.
 * @param {string|Array<string|[string, number]>} spec 'Am7 F | C:2 G:2' or [['Am7', 4], 'F', …]
 * @param {{beatsPer?:number, start?:number}} [opts]
 * @returns {{symbol:string|null, beat:number, beats:number}[]}
 */
export function progression(spec, { beatsPer = 4, start = 0 } = {}) {
  const toks = Array.isArray(spec) ? spec : String(spec).split(/[\s|]+/).filter(Boolean);
  const out = [];
  let beat = start, last = null;
  for (const t of toks) {
    let sym, beats = beatsPer;
    if (Array.isArray(t)) { sym = t[0]; beats = Number(t[1]) || beatsPer; }
    else {
      const m = /^(.+?)(?::(\d+(?:\.\d+)?))?$/.exec(t);
      sym = m[1]; if (m[2]) beats = Number(m[2]);
    }
    if (sym === '%') sym = last;
    if (sym === '.') { out.push({ symbol: null, beat, beats }); beat += beats; continue; }
    parseChord(sym); // validate early
    out.push({ symbol: sym, beat, beats });
    last = sym;
    beat += beats;
  }
  return out;
}

/**
 * Sustained (or rhythmic) chord events from a progression.
 * @param {string|Array} spec progression (see progression())
 * @param {{beatsPer?:number, start?:number, octave?:number, voiceLead?:boolean, range?:[any, any], voicing?:string,
 *          vel?:number, gate?:number, strum?:number, rhythm?:string, step?:number, bass?:boolean|number, drop2?:boolean}} [opts]
 *   gate: note length as a fraction of the chord length (default 0.98) · strum: beats between chord notes (upward) ·
 *   rhythm: step string (see steps()) re-striking the chord inside each chord span, e.g. 'x..x..x.' with step 0.5 ·
 *   voiceLead (default true): smooth voice leading inside `range` (default ['A3','E5']).
 * @returns {object[]} events
 */
export function chords(spec, opts = {}) {
  const { beatsPer = 4, start = 0, octave = 4, vel = 0.7, gate = 0.98, strum = 0, rhythm = null, step = 0.25,
    voicing = 'close', bass = false } = opts;
  const prog = progression(spec, { beatsPer, start });
  const syms = prog.filter(c => c.symbol).map(c => c.symbol);
  const voiced = opts.voiceLead === false
    ? syms.map(s => chord(s, { octave, voicing }))
    : voiceLead(syms, { range: opts.range, drop2: opts.drop2 });
  const ev = [];
  let k = 0;
  for (const c of prog) {
    if (!c.symbol) continue;
    let notes = voiced[k++];
    if (bass !== false && bass !== undefined) {
      const b = chordRoot(c.symbol, typeof bass === 'number' ? bass : 2);
      notes = [b, ...notes];
    }
    const hits = rhythm
      ? loopTo(steps(rhythm, { step, note: 0, vel, gate: 0.9 }), [...String(rhythm).replace(/[\s|]/g, '')].length * step, c.beats)
      : [{ beat: 0, vel, dur: c.beats * gate }];
    for (const h of hits) {
      const dur = rhythm ? Math.min(h.dur, c.beats - h.beat) : h.dur;
      notes.forEach((n, i) => ev.push({ beat: r4(c.beat + h.beat + i * strum), type: 'on', note: n, vel: clampVel(h.vel - i * 0.01), dur: r4(Math.max(0.02, dur - i * strum)) }));
    }
  }
  return sortEvents(ev);
}

/**
 * Bass line from a progression's roots with a step pattern repeated through every chord.
 * Pattern characters: 'x' root, 'X' accented root, 'o' octave up, 'O' accented octave, 'f' fifth,
 * '3' third (of the chord quality), '7' seventh (or octave if none), '.' rest, '-' tie; spaces/'|' ignored.
 * @param {string|Array} spec progression
 * @param {string} pattern e.g. 'x..x..x.'
 * @param {{beatsPer?:number, start?:number, step?:number, octave?:number, vel?:number, accent?:number, gate?:number}} [opts]
 */
export function bassline(spec, pattern = 'x...', opts = {}) {
  const { beatsPer = 4, start = 0, step = 0.5, octave = 2, vel = 0.8, accent = 1, gate = 0.85 } = opts;
  const prog = progression(spec, { beatsPer, start });
  const pat = [...String(pattern).replace(/[\s|]/g, '')];
  const ev = [];
  for (const c of prog) {
    if (!c.symbol) continue;
    const ch = parseChord(c.symbol);
    const root = 12 * (octave + 1) + (ch.bass ?? ch.root);
    const third = ch.intervals.find(x => x === 3 || x === 4) ?? ch.intervals[1] ?? 7;
    const sev = ch.intervals.find(x => x === 10 || x === 11 || x === 9) ?? 12;
    const nSteps = Math.round(c.beats / step);
    let last = null;
    for (let i = 0; i < nSteps; i++) {
      const t = pat[i % pat.length];
      const b = c.beat + i * step;
      if (t === '-' || t === '_') { if (last) last.dur = r4(last.dur + step); continue; }
      last = null;
      let n = null, v = vel;
      switch (t) {
        case 'x': n = root; break;
        case 'X': n = root; v = accent; break;
        case 'o': n = root + 12; break;
        case 'O': n = root + 12; v = accent; break;
        case 'f': n = root + 7; break;
        case 'F': n = root + 7; v = accent; break;
        case '3': n = root + third; break;
        case '7': n = root + sev; break;
        case '.': break;
        default: throw new Error(`songlib: bassline pattern char '${t}'`);
      }
      if (n === null) continue;
      last = { beat: r4(b), type: 'on', note: n, vel: clampVel(v), dur: r4(step * gate) };
      ev.push(last);
    }
  }
  return ev;
}

// ───────────────────────── rhythm ─────────────────────────

/**
 * Step-sequencer string → note events.
 *   'x' hit (vel) · 'X' accent (accent) · 'o' ghost (ghost) · '1'…'9' velocity 0.1…0.9 · '.' rest ·
 *   '-' or '_' tie (extends the previous hit) · spaces and '|' are ignored (use them as bar lines).
 * @param {string} pattern e.g. 'x..x..x.|x...x.x.'
 * @param {{note?:number|string, step?:number, start?:number, vel?:number, accent?:number, ghost?:number, gate?:number, dur?:number}} [opts]
 *   step: beats per character (default 0.25 = 16ths) · gate: fraction of a step (default 0.5) · dur: fixed
 *   duration in beats (overrides gate; ties still add steps)
 * @returns {object[]} events
 */
export function steps(pattern, { note: n = 60, step = 0.25, start = 0, vel = 0.8, accent = 1, ghost = 0.4, gate = 0.5, dur = null } = {}) {
  const nn = midi(n);
  const chars = [...String(pattern).replace(/[\s|]/g, '')];
  const ev = [];
  let last = null;
  chars.forEach((c, i) => {
    const beat = start + i * step;
    if (c === '-' || c === '_') { if (last) last.dur = r4(last.dur + step); return; }
    last = null;
    let v = null;
    if (c === 'x') v = vel;
    else if (c === 'X') v = accent;
    else if (c === 'o') v = ghost;
    else if (c >= '1' && c <= '9') v = Number(c) / 10;
    else if (c === '.') v = null;
    else throw new Error(`songlib: step pattern char '${c}' (use x X o 1-9 . - |)`);
    if (v === null) return;
    last = { beat: r4(beat), type: 'on', note: nn, vel: clampVel(v), dur: r4(dur ?? step * gate) };
    ev.push(last);
  });
  return ev;
}

/**
 * Drum grid: several step patterns, one per instrument, merged.
 * @param {Object<string,string>} patterns { kick: 'x...x...', snare: '....x...', hat: 'x.x.x.x.' }
 * @param {{map?:Object<string,number>, step?:number, start?:number, vel?:number|Object<string,number>, accent?:number, ghost?:number, dur?:number}} [opts]
 *   map: instrument → MIDI note (default GM; numbers or note names also accepted as keys) · vel: number or per-instrument
 * @returns {object[]}
 */
export function drums(patterns, opts = {}) {
  const map = opts.map || GM;
  const ev = [];
  for (const [inst, pat] of Object.entries(patterns)) {
    const n = map[inst] ?? (/^\d+$/.test(inst) ? Number(inst) : midi(inst));
    if (n === undefined) throw new Error(`songlib: unknown drum '${inst}'`);
    const vel = typeof opts.vel === 'object' ? (opts.vel[inst] ?? 0.8) : (opts.vel ?? 0.8);
    ev.push(...steps(pat, { note: n, step: opts.step ?? 0.25, start: opts.start ?? 0, vel, accent: opts.accent ?? 1, ghost: opts.ghost ?? 0.4, dur: opts.dur ?? 0.2 }));
  }
  return sortEvents(ev);
}

/**
 * Melody from a token string. Tokens (space separated; '|' ignored):
 *   note names 'E5', 'C#4' · scale degrees (needs opts.key): '1'…'9' (1 = root in opts.octave), with '#'/'b'
 *   prefixes and ' (up) / , (down) octave suffixes, e.g. "5," "1'" "b3" · '.' rest · '-' hold previous note ·
 *   suffix '!' accent, '?' soft · '~' prefix = legato (overlaps the next note slightly, for mono/legato glides).
 * @param {string} str e.g. 'E5 - D5 C5 | A4 - - .'
 * @param {{step?:number, start?:number, vel?:number, accent?:number, soft?:number, gate?:number, key?:any, octave?:number}} [opts]
 * @returns {object[]}
 */
export function melody(str, { step = 0.5, start = 0, vel = 0.75, accent = 0.95, soft = 0.5, gate = 0.92, key = null, octave = 4 } = {}) {
  const toks = String(str).split(/[\s|]+/).filter(Boolean);
  const k = key ? keyOf(key) : null;
  const ev = [];
  let last = null, beat = start;
  for (const t0 of toks) {
    let t = t0;
    if (t === '-' || t === '_') { if (last) last.dur = r4(last.dur + step); beat += step; continue; }
    if (t === '.') { last = null; beat += step; continue; }
    let v = vel, legato = false;
    if (t.startsWith('~')) { legato = true; t = t.slice(1); }
    if (t.endsWith('!')) { v = accent; t = t.slice(0, -1); } else if (t.endsWith('?')) { v = soft; t = t.slice(0, -1); }
    let n;
    const dm = /^([#b]*)(\d+)([',]*)$/.exec(t);
    if (dm) {
      if (!k) throw new Error(`songlib: melody degree '${t0}' needs opts.key`);
      const d = Number(dm[2]);
      if (d < 1) throw new Error(`songlib: melody degree '${t0}' (degrees start at 1)`);
      n = degree(k, d - 1, octave) + accidental(dm[1]);
      for (const ch of dm[3]) n += ch === "'" ? 12 : -12;
    } else n = midi(t);
    last = { beat: r4(beat), type: 'on', note: n, vel: clampVel(v), dur: r4(step * (legato ? 1.05 : gate)) };
    ev.push(last);
    beat += step;
  }
  return ev;
}

/**
 * Arpeggiate notes over a span.
 * @param {(number|string)[]} notes chord notes (any order)
 * @param {{pattern?:'up'|'down'|'updown'|'downup'|'random'|'converge'|number[], rate?:number, beats?:number, start?:number,
 *          octaves?:number, gate?:number, vel?:number, accentEvery?:number, accent?:number, seed?:number}} [opts]
 *   rate: beats per note (0.25 = 16ths) · beats: total span (default 4) · pattern array = indices into the
 *   (octave-extended, ascending) note list · accentEvery: accent every N notes (default 4)
 * @returns {object[]}
 */
export function arpeggiate(notes, { pattern = 'up', rate = 0.25, beats = 4, start = 0, octaves = 1, gate = 0.8, vel = 0.7, accentEvery = 4, accent = 0.85, seed = 1 } = {}) {
  const base = notes.map(midi).sort((a, b) => a - b);
  let pool = [];
  for (let o = 0; o < Math.max(1, octaves | 0); o++) pool.push(...base.map(x => x + 12 * o));
  let order;
  if (Array.isArray(pattern)) order = pattern.map(i => pool[((i % pool.length) + pool.length) % pool.length]);
  else if (pattern === 'up') order = pool;
  else if (pattern === 'down') order = pool.slice().reverse();
  else if (pattern === 'updown') order = pool.concat(pool.slice(1, -1).reverse());
  else if (pattern === 'downup') { const d = pool.slice().reverse(); order = d.concat(d.slice(1, -1).reverse()); }
  else if (pattern === 'converge') { order = []; for (let i = 0, j = pool.length - 1; i <= j; i++, j--) { order.push(pool[i]); if (i !== j) order.push(pool[j]); } }
  else if (pattern === 'random') order = null;
  else throw new Error(`songlib: arp pattern '${pattern}'`);
  const rng = rngOf(seed);
  const count = Math.round(beats / rate);
  const ev = [];
  for (let i = 0; i < count; i++) {
    const n = order ? order[i % order.length] : pool[Math.floor(rng() * pool.length) % pool.length];
    ev.push({ beat: r4(start + i * rate), type: 'on', note: n, vel: clampVel(accentEvery > 0 && i % accentEvery === 0 ? accent : vel), dur: r4(rate * gate) });
  }
  return ev;
}

// ───────────────────────── event transforms ─────────────────────────

const r4 = x => Math.round(x * 1e6) / 1e6;
const clampVel = v => Math.max(0.01, Math.min(1, Math.round(v * 1000) / 1000));
const ORDER = { param: 0, macro: 0, ramp: 1, 'ramp-macro': 1, off: 2, on: 3 };

/** Sort events by beat (params → ramps → offs → ons at equal beats, then note). Returns a new array. */
export function sortEvents(events) {
  return events.slice().sort((a, b) => a.beat - b.beat || (ORDER[a.type] ?? 4) - (ORDER[b.type] ?? 4) || (a.note ?? 0) - (b.note ?? 0));
}

/** Concatenate event lists (sorted). */
export function merge(...lists) { return sortEvents(lists.flat(2).filter(Boolean)); }

/** Events moved by `beats`. */
export function shift(events, beats) { return events.map(e => ({ ...e, beat: r4(e.beat + beats) })); }

/** Notes transposed by `semitones` (clamped 0..127); non-note events unchanged. */
export function transpose(events, semitones) {
  return events.map(e => (e.type === 'on' || e.type === 'off' ? { ...e, note: Math.max(0, Math.min(127, e.note + semitones)) } : { ...e }));
}

/** Scale velocities by a factor or map them with fn(vel, event, index). */
export function velocity(events, f) {
  return events.map((e, i) => (e.type === 'on' ? { ...e, vel: clampVel(typeof f === 'function' ? f(e.vel, e, i) : e.vel * f) } : { ...e }));
}

/** Scale note durations by a factor (legato > 1, staccato < 1). */
export function legato(events, f) {
  return events.map(e => (e.type === 'on' ? { ...e, dur: r4(Math.max(0.01, e.dur * f)) } : { ...e }));
}

/**
 * Repeat a pattern: `times` copies, each `every` beats apart (default: the pattern's length rounded up to a bar).
 * @returns {object[]}
 */
export function repeat(events, times, every = null) {
  const len = every ?? Math.max(4, Math.ceil(spanOf(events) / 4 - 1e-9) * 4);
  const out = [];
  for (let k = 0; k < times; k++) for (const e of events) out.push({ ...e, beat: r4(e.beat + k * len) });
  return sortEvents(out);
}

/** Loop a pattern of `patternBeats` to fill `totalBeats` (the last copy is cut at totalBeats). */
export function loopTo(events, patternBeats, totalBeats) {
  const out = [];
  for (let s = 0; s < totalBeats - 1e-9; s += patternBeats) {
    for (const e of events) {
      const b = e.beat + s;
      if (b >= totalBeats - 1e-9) continue;
      const c = { ...e, beat: r4(b) };
      if (c.type === 'on' && b + c.dur > totalBeats) c.dur = r4(totalBeats - b);
      out.push(c);
    }
  }
  return sortEvents(out);
}

/** Events with from ≤ beat < to (absolute beats kept). */
export function clip(events, from, to) { return events.filter(e => e.beat >= from - 1e-9 && e.beat < to - 1e-9); }

/** End (beats) of the last note/ramp. */
export function spanOf(events) {
  let end = 0;
  for (const e of events) end = Math.max(end, e.beat + (e.type === 'on' ? e.dur ?? 1 : e.type === 'ramp' || e.type === 'ramp-macro' ? e.beats ?? 0 : 0));
  return end;
}

/**
 * Deterministic seeded xorshift RNG → () => 0..1 (no Math.random anywhere, renders are repeatable).
 * @param {number} [seed=1]
 */
export function rngOf(seed = 1) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Humanise notes: deterministic timing (± `timing` beats) and velocity (± `velocity`) jitter; optional swing.
 * Notes on beat 0 are never moved earlier; non-note events are untouched.
 * @param {object[]} events
 * @param {{timing?:number, velocity?:number, seed?:number, swing?:number, swingStep?:number}} [opts]
 *   swing: 0..0.5 — delays every second `swingStep` (default 0.25 = 16ths) by swing·swingStep
 */
export function humanize(events, { timing = 0.01, velocity: vj = 0.06, seed = 1, swing = 0, swingStep = 0.25 } = {}) {
  const rng = rngOf(seed);
  return sortEvents(events.map(e => {
    if (e.type !== 'on') return { ...e };
    let beat = e.beat;
    if (swing > 0) {
      const idx = Math.round(beat / swingStep);
      if (Math.abs(idx * swingStep - beat) < 1e-6 && idx % 2 === 1) beat += swing * swingStep;
    }
    const dt = (rng() * 2 - 1) * timing;
    const dv = (rng() * 2 - 1) * vj;
    beat = Math.max(0, beat + dt);
    return { ...e, beat: r4(beat), vel: clampVel(e.vel + dv) };
  }));
}

// ───────────────────────── automation ─────────────────────────

/** Set a param (native value) at `beat`. */
export function param(id, value, beat = 0) { return { beat, type: 'param', id, value }; }

/** Set macro `index` (0..3) to value (0..1) at `beat`. */
export function macro(index, value, beat = 0) { return { beat, type: 'macro', index, value }; }

/**
 * Param ramp from → to (native values) starting at `beat`, lasting `beats` (linear in normalised space, so
 * Hz/seconds sweep musically). from = null → ramp from the current value.
 * @returns {object[]}
 */
export function ramp(id, from, to, beat, beats) {
  const ev = [];
  if (from !== null && from !== undefined) ev.push({ beat, type: 'param', id, value: from });
  ev.push({ beat, type: 'ramp', id, to, beats });
  return ev;
}

/** Macro ramp (index 0..3, values 0..1). from = null → from the current value. */
export function macroRamp(index, from, to, beat, beats) {
  const ev = [];
  if (from !== null && from !== undefined) ev.push({ beat, type: 'macro', index, value: from });
  ev.push({ beat, type: 'ramp-macro', index, to, beats });
  return ev;
}

/**
 * Piecewise-linear automation through points [[beat, value], …] for a param id or a macro ({macro: index}).
 * The first point sets the value, each next point ramps to its value.
 * @param {string|{macro:number}} target
 * @param {[number, number|string|boolean][]} points
 */
export function automate(target, points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const isMacro = typeof target === 'object' && target !== null && Number.isInteger(target.macro);
  const ev = [];
  pts.forEach(([beat, value], i) => {
    if (i === 0) { ev.push(isMacro ? macro(target.macro, value, beat) : param(target, value, beat)); return; }
    const [pb] = pts[i - 1];
    ev.push(isMacro ? { beat: pb, type: 'ramp-macro', index: target.macro, to: value, beats: r4(beat - pb) }
      : { beat: pb, type: 'ramp', id: target, to: value, beats: r4(beat - pb) });
  });
  return ev;
}

// ───────────────────────── structure ─────────────────────────

/** Bars → beats (default 4/4). */
export const bars = (n, beatsPerBar = 4) => n * beatsPerBar;

/**
 * Build a song arrangement from sections.
 * @param {{name:string, zh?:string, bars?:number, beats?:number, parts?:Object<string, object[]|function>}[]} sections
 *   parts: partName → events in section-relative beats, or fn({start, beats, bars, index, name}) → events.
 * @param {{beatsPerBar?:number}} [opts]
 * @returns {{sections:{beat:number,name:string,zh:string}[], lengthBeats:number, tracks:Object<string, object[]>}}
 * @example
 *   const A = arrange([
 *     { name: 'Intro', zh: '前奏', bars: 4, parts: { pad: padIntro } },
 *     { name: 'Theme', zh: '主題', bars: 8, parts: { pad: padLoop, bass: b => loopTo(bassBar, 4, b.beats) } },
 *   ]);
 *   // A.tracks.pad, A.tracks.bass (absolute beats), A.sections, A.lengthBeats
 */
export function arrange(sections, { beatsPerBar = 4 } = {}) {
  const out = { sections: [], lengthBeats: 0, tracks: {} };
  let beat = 0;
  sections.forEach((s, index) => {
    const beats = s.beats ?? (s.bars ?? 4) * beatsPerBar;
    out.sections.push({ beat, name: s.name, zh: s.zh ?? s.name });
    for (const [name, src] of Object.entries(s.parts || {})) {
      const evs = typeof src === 'function' ? src({ start: beat, beats, bars: beats / beatsPerBar, index, name: s.name }) : src;
      if (!out.tracks[name]) out.tracks[name] = [];
      for (const e of evs || []) out.tracks[name].push({ ...e, beat: r4(e.beat + beat) });
    }
    beat += beats;
  });
  out.lengthBeats = beat;
  for (const k of Object.keys(out.tracks)) out.tracks[k] = sortEvents(out.tracks[k]);
  return out;
}
