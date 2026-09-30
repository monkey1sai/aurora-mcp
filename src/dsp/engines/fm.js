// AURORA 極光 — 4-operator FM engine (DX-style phase modulation).
//
// Pure ES module (AudioWorklet + Node). No allocation in the audio path.
//
// Signal model (per voice, mono; the voice applies fm.level / fm.pan / fm.filt):
//   op_j(t) = sin(2π·φ_j(t) + Σ_{m→j} out_m(t))              (phase modulation, index in radians)
//   modulator output  out_m = β_m · env_m · sin(...)           β_m = 4π·level'²  (peak radians)
//   carrier output    out_c = level' · env_c · sin(...) / √(#carriers)
//   op4 self-feedback: φ4 += β_fb · env4 · (y[n−1] + y[n−2]) / 2 (two-sample average → no period-2 chaos)
//   level' = level · velocityScale · keyScale
//
// Quality features
//   • 4097-point interleaved (value, delta) sine table, linear interpolation: max error 2.9e-7 (−130 dB).
//   • Double-precision phase accumulators.
//   • 2× oversampling below 64 kHz sample rate, decimated by an 8-coefficient polyphase IIR halfband
//     (−95 dB stopband, ±0.01 dB passband to 0.43·fs).
//   • Spectral-reach limiting ("index clamping"): per control block, the RMS instantaneous frequency of every
//     operator is estimated recursively through the algorithm graph, and one uniform scale on each carrier
//     tree's modulation indices is solved (bisection, soft knee) so that (a) Carson-like spectral edges stay
//     clear of fold-back at the oversampled rate and (b) carrier brightness stays under a musical ceiling.
//     Low/mid notes are untouched; the top octaves get progressively gentler (natural "key scaling by
//     default") instead of harsh / aliased. Worst aliased component in a randomised 160-case torture suite:
//     −85 dBFS @ 48 kHz, −76 dBFS @ 44.1 kHz.
//   • Carriers fade out near the oversampled Nyquist; modulators fade out once ultrasonic (≥ 0.2–0.32 × the
//     oversampled rate), where they only produce fold-back. Feedback depth shrinks at very high op4 pitch.
//   • 5 Hz DC blocker on the output (asymmetric high-feedback waveforms carry DC).
//   • DX-like envelopes: RC-shaped attack (≥ 1 ms, restarts from the current level → click-free retrigger),
//     exponential decay / release (linear in dB; d and r are T60-style times: time to fall 60 dB).
//   • Op levels & feedback are smoothed (≈3 ms one-pole) and all gains are linearly ramped across each block
//     (no zipper, no clicks from macro/UI jumps); algorithm switches duck out/in over ≈2 ms each.
//   • Phase reset (key sync) only when the voice is silent, so retriggers of a sounding voice never click.

import { idx } from '../params.js';

// ───────────────────────── Algorithms ─────────────────────────
// carriers: summed to the output.  mods[target] = operators modulating that target.
// layout[op] = [col, row] (row 0 = top); carriers sit on the bottom row. Op 4 always has feedback.
const ALGO_SPECS = [
  {
    name: 'Stack', zh: '四層堆疊', hint: 'Brass, leads, complex bells',
    carriers: [1], mods: { 1: [2], 2: [3], 3: [4] },
    layout: { 4: [0, 0], 3: [0, 1], 2: [0, 2], 1: [0, 3] }, cols: 1, rows: 4,
    ascii: [
      '[4]↺',
      ' │ ',
      '[3]',
      ' │ ',
      '[2]',
      ' │ ',
      '[1]',
      ' ▼ ',
    ],
  },
  {
    name: 'Y-Stack', zh: '雙入堆疊', hint: 'Bass, brass, reeds',
    carriers: [1], mods: { 1: [2], 2: [3, 4] },
    layout: { 3: [0, 0], 4: [1, 0], 2: [0.5, 1], 1: [0.5, 2] }, cols: 2, rows: 3,
    ascii: [
      '[3] [4]↺',
      ' └─┬─┘  ',
      '  [2]   ',
      '   │    ',
      '  [1]   ',
      '   ▼    ',
    ],
  },
  {
    name: 'Twin Pairs', zh: '雙對並聯', hint: 'E-piano, layered keys',
    carriers: [1, 3], mods: { 1: [2], 3: [4] },
    layout: { 2: [0, 0], 1: [0, 1], 4: [1, 0], 3: [1, 1] }, cols: 2, rows: 2,
    ascii: [
      '[2]  [4]↺',
      ' │    │  ',
      '[1]  [3] ',
      ' └──┬─┘  ',
      '    ▼    ',
    ],
  },
  {
    name: 'Branch', zh: '分支', hint: 'Clav, metallic, complex tones',
    carriers: [1], mods: { 1: [2, 3], 3: [4] },
    layout: { 4: [1, 0], 3: [1, 1], 2: [0, 1], 1: [0.5, 2] }, cols: 2, rows: 3,
    ascii: [
      '     [4]↺',
      '      │  ',
      '[2]  [3] ',
      ' └─┬──┘  ',
      '  [1]    ',
      '   ▼     ',
    ],
  },
  {
    name: 'Fan Out', zh: '一對三', hint: 'Fat organs, chords, pads',
    carriers: [1, 2, 3], mods: { 1: [4], 2: [4], 3: [4] },
    layout: { 4: [1, 0], 1: [0, 1], 2: [1, 1], 3: [2, 1] }, cols: 3, rows: 2,
    ascii: [
      '    [4]↺    ',
      ' ┌───┼───┐  ',
      '[1] [2] [3] ',
      ' └───┼───┘  ',
      '     ▼      ',
    ],
  },
  {
    name: 'Pair + 2', zh: '一對加雙正弦', hint: 'Bells with body, organ + tine',
    carriers: [1, 2, 3], mods: { 3: [4] },
    layout: { 4: [2, 0], 1: [0, 1], 2: [1, 1], 3: [2, 1] }, cols: 3, rows: 2,
    ascii: [
      '        [4]↺',
      '         │  ',
      '[1] [2] [3] ',
      ' └───┼───┘  ',
      '     ▼      ',
    ],
  },
  {
    name: 'Pair + 2 Alt', zh: '一對加雙載波', hint: 'Organ, layered, feedback saw',
    carriers: [1, 3, 4], mods: { 1: [2] },
    layout: { 2: [0, 0], 1: [0, 1], 3: [1, 1], 4: [2, 1] }, cols: 3, rows: 2,
    ascii: [
      '[2]         ',
      ' │          ',
      '[1] [3] [4]↺',
      ' └───┼───┘  ',
      '     ▼      ',
    ],
  },
  {
    name: 'Additive', zh: '加法合成', hint: 'Drawbar organ, additive',
    carriers: [1, 2, 3, 4], mods: {},
    layout: { 1: [0, 0], 2: [1, 0], 3: [2, 0], 4: [3, 0] }, cols: 4, rows: 1,
    ascii: [
      '[1] [2] [3] [4]↺',
      ' └───┴─┬─┴───┘  ',
      '       ▼        ',
    ],
  },
];

/**
 * UI-facing algorithm descriptions, indexed by `fm.algo − 1`.
 * { id, name, zh, hint, carriers:[op], mods:{op:[modulators]}, modulators:[op], edges:[[from,to]],
 *   feedback: 4, layout:{op:[col,row]}, cols, rows, ascii:[lines] }
 */
export const FM_ALGORITHMS = Object.freeze(ALGO_SPECS.map((a, i) => {
  const edges = [];
  const modulators = [];
  for (const t of [1, 2, 3, 4]) {
    for (const m of a.mods[t] || []) {
      edges.push([m, t]);
      if (!modulators.includes(m)) modulators.push(m);
    }
  }
  modulators.sort((x, y) => x - y);
  return Object.freeze({
    id: i + 1, name: a.name, zh: a.zh, hint: a.hint,
    carriers: Object.freeze(a.carriers.slice()),
    mods: Object.freeze(Object.fromEntries(Object.entries(a.mods).map(([k, v]) => [k, Object.freeze(v.slice())]))),
    modulators: Object.freeze(modulators),
    edges: Object.freeze(edges.map(e => Object.freeze(e))),
    feedback: 4,
    layout: Object.freeze(Object.fromEntries(Object.entries(a.layout).map(([k, v]) => [k, Object.freeze(v.slice())]))),
    cols: a.cols, rows: a.rows,
    ascii: Object.freeze(a.ascii.slice()),
  });
}));

// Routing tables derived once: ROUTE[a*16 + target*4 + mod] = 1 if op `mod` modulates op `target` (0-based),
// CARRIER[a*4 + op] = 1 if carrier, NCAR[a] = number of carriers.
const ROUTE = new Float64Array(8 * 16);
const CARRIER = new Float64Array(8 * 4);
const NCAR = new Float64Array(8);
FM_ALGORITHMS.forEach((a, ai) => {
  for (const c of a.carriers) CARRIER[ai * 4 + c - 1] = 1;
  NCAR[ai] = a.carriers.length;
  for (const [m, t] of a.edges) ROUTE[ai * 16 + (t - 1) * 4 + (m - 1)] = 1;
});

// Modulation groups for index clamping: carriers whose modulator trees share operators are merged.
// GRP_CAR / GRP_MOD[a*2 + g] = bitmask (bit j = op j+1) of the group's carriers / modulators; NGRP[a] ≤ 2.
const GRP_CAR = new Int32Array(8 * 2);
const GRP_MOD = new Int32Array(8 * 2);
const NGRP = new Int32Array(8);
FM_ALGORITHMS.forEach((a, ai) => {
  const tree = c => { // bitmask of all (transitive) modulators of op c (1-based)
    let m = 0;
    for (const x of a.mods[c] || []) m |= (1 << (x - 1)) | tree(x);
    return m;
  };
  const groups = [];
  for (const c of a.carriers) {
    const t = tree(c);
    if (!t) continue;
    const g = groups.find(gr => gr.mod & t);
    if (g) { g.car |= 1 << (c - 1); g.mod |= t; } else groups.push({ car: 1 << (c - 1), mod: t });
  }
  NGRP[ai] = groups.length;
  groups.forEach((g, gi) => { GRP_CAR[ai * 2 + gi] = g.car; GRP_MOD[ai * 2 + gi] = g.mod; });
});

// ───────────────────────── Sine table ─────────────────────────
// Interleaved [value, delta] pairs → one cache line holds both interpolation operands.
const SIN_SIZE = 4096;
const SIN_MASK = SIN_SIZE - 1;
const SIN_TD = new Float64Array(SIN_SIZE * 2 + 2);
{
  const t = new Float64Array(SIN_SIZE + 1);
  for (let i = 0; i <= SIN_SIZE; i++) t[i] = Math.sin((2 * Math.PI * i) / SIN_SIZE);
  t[0] = t[SIN_SIZE / 2] = t[SIN_SIZE] = 0;
  t[SIN_SIZE / 4] = 1;
  t[(3 * SIN_SIZE) / 4] = -1;
  for (let i = 0; i < SIN_SIZE; i++) {
    SIN_TD[2 * i] = t[i];
    SIN_TD[2 * i + 1] = t[i + 1] - t[i];
  }
}
// Phase offset (cycles) so the table index is always positive → `|0` truncation == floor.
const PH_OFS = 1024;

/** Table sine of a phase in cycles (exported for tests/UI; the engine inlines this). */
export function fmSin(cycles) {
  const x = (cycles + PH_OFS) * SIN_SIZE;
  const i0 = x | 0;
  const i = (i0 & SIN_MASK) << 1;
  return SIN_TD[i] + (x - i0) * SIN_TD[i + 1];
}

// ───────────────────────── Halfband decimator design ─────────────────────────
// Polyphase IIR halfband (two allpass chains), Valenzuela & Constantinides / hiir design.
// tbw = transition half-width relative to the oversampled rate: passband to (0.25−tbw)·fs2.
function designHalfband(nCoefs, tbw) {
  let k = Math.tan(((1 - tbw * 2) * Math.PI) / 4);
  k *= k;
  const kksqrt = Math.pow(1 - k * k, 0.25);
  const e = (0.5 * (1 - kksqrt)) / (1 + kksqrt);
  const e4 = e * e * e * e;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const order = nCoefs * 2 + 1;
  const c = new Float64Array(nCoefs);
  for (let n = 0; n < nCoefs; n++) {
    const cc = n + 1;
    let acc = 0, i = 0, sgn = 1, qp;
    do {
      qp = Math.pow(q, i * (i + 1));
      acc += qp * Math.sin(((i * 2 + 1) * cc * Math.PI) / order) * sgn;
      sgn = -sgn; i++;
    } while (qp > 1e-100);
    const num = acc * Math.pow(q, 0.25);
    acc = 0; i = 1; sgn = -1;
    do {
      qp = Math.pow(q, i * i);
      acc += qp * Math.cos((i * 2 * cc * Math.PI) / order) * sgn;
      sgn = -sgn; i++;
    } while (qp > 1e-100);
    const den = acc + 0.5;
    const ww = num / den, w2 = ww * ww;
    const x = Math.sqrt((1 - w2 * k) * (1 - w2 / k)) / (1 + w2);
    c[n] = (1 - x) / (1 + x);
  }
  return c;
}
const HB_N = 8;
const HB = designHalfband(HB_N, 0.035); // −95 dB stopband from 0.57·fs, passband to 0.43·fs (fs = base rate)

// ───────────────────────── Constants ─────────────────────────
const IDLE = 0, ATTACK = 1, DECAY = 2, RELEASE = 3;
const SILENT = 3.1622776e-5;           // −90 dB: envelope considered finished
const LN_1000 = Math.log(1000);        // 60 dB
const LN_3 = Math.log(3);              // attack: RC approach to 1.5, reaches 1.0 at t = a
const ATT_TARGET = 1.5;
const MIN_ATTACK = 0.001;              // s
const MAX_BLOCK = 16;                  // base-rate samples processed per inner block
const OS_MAX = 2;
const RESET_LEVEL = 1e-3;              // carriers below −60 dB → voice counts as silent → key-sync phases
const TWO_PI = 2 * Math.PI;
const KNEE_W = Math.log(1.6);          // soft-knee half-width (log domain): reduction spans x = 1/1.6 … 1.6
const KNEE_HI = 1.6;                   // k at which the knee starts (x = 1/k)
const ALIAS_GAMMA = 3;                 // spectral edge ≈ f + γ·(RMS deviation) + (γ/√2)·(RMS modulator freq)
const ALIAS_MARGIN = ALIAS_GAMMA / Math.SQRT2;

// Feedback: fm.feedback 0..1 → β_fb (peak radians applied to the two-sample average of op4's output).
// Measured at the oversampled rate: 0 → sine, 0.25 → h2 ≈ −15 dB, 0.5 → h2 ≈ −9 dB,
// 0.75 → saw-like (β 1.4, harmonics within ~1.5 dB of 1/k), 0.9 → gritty edge of chaos (β ≈ 2.8),
// 1 → noise (β = 10, spectral flatness ≈ 0.5). C¹-continuous at the 0.75 joint.
export function feedbackBeta(fb) {
  if (fb <= 0) return 0;
  if (fb <= 0.75) {
    const u = fb / 0.75;
    return 1.4 * u * (0.6 + 0.4 * u);
  }
  const w = (fb - 0.75) * 4;
  const w2 = w * w;
  return 1.4 + 2.6133333 * (fb - 0.75) + 7.9466667 * w2 * w2;
}

export class FmEngine {
  /**
   * @param {number} sampleRate
   * @param {string} prefix  param prefix, normally 'fm'
   * @param {object} [opts]  quality/test overrides (defaults are the tuned values):
   *   oversample 1|2 (default 2 below 64 kHz), ceiling (Hz, carrier RMS-deviation ceiling, 8000),
   *   laCar / laMod (spectral-edge limits × oversampled rate, 0.3 / 0.25),
   *   modLo / modHi (ultrasonic modulator fade × oversampled rate, 0.2 / 0.32), fbKnee (0.06; 0 = off)
   */
  constructor(sampleRate, prefix = 'fm', opts = {}) {
    this.sr = sampleRate;
    this.os = opts.oversample || (sampleRate < 64000 ? 2 : 1);
    if (this.os > OS_MAX) this.os = OS_MAX;
    this.rate = sampleRate * this.os;
    // Musical brightness ceiling for carriers (Hz): the RMS frequency deviation is soft-limited to (ceiling − f_c).
    this.ceiling = opts.ceiling || 8000;
    this.laCar = opts.laCar || 0.3;     // anti-alias spectral-edge limits (× oversampled rate)
    this.laMod = opts.laMod || 0.25;
    this.modLo = opts.modLo || 0.2;     // modulator ultrasonic fade start / end (× oversampled rate)
    this.modHi = opts.modHi || 0.32;
    this.fbKnee = opts.fbKnee ?? 0.06;  // feedback depth halves at op4 freq = fbKnee × oversampled rate

    const p = prefix;
    this.iAlgo = idx(`${p}.algo`);
    this.iFb = idx(`${p}.feedback`);
    this.iOct = idx(`${p}.oct`);
    this.iFine = idx(`${p}.fine`);
    this.iRatio = new Int32Array(4);
    this.iDet = new Int32Array(4);
    this.iLevel = new Int32Array(4);
    this.iA = new Int32Array(4);
    this.iD = new Int32Array(4);
    this.iS = new Int32Array(4);
    this.iR = new Int32Array(4);
    this.iVel = new Int32Array(4);
    this.iKs = new Int32Array(4);
    for (let j = 0; j < 4; j++) {
      const o = `${p}.op${j + 1}`;
      this.iRatio[j] = idx(`${o}.ratio`);
      this.iDet[j] = idx(`${o}.detune`);
      this.iLevel[j] = idx(`${o}.level`);
      this.iA[j] = idx(`${o}.a`);
      this.iD[j] = idx(`${o}.d`);
      this.iS[j] = idx(`${o}.s`);
      this.iR[j] = idx(`${o}.r`);
      this.iVel[j] = idx(`${o}.vel`);
      this.iKs[j] = idx(`${o}.kscale`);
    }

    // Operator state
    this.ph = new Float64Array(4);        // phase, cycles [0,1)
    this.lv = new Float64Array(4);        // envelope level
    this.st = new Int32Array(4);          // envelope stage
    this.cA = new Float64Array(4);        // per-sample coefficients (oversampled rate)
    this.cD = new Float64Array(4);
    this.cR = new Float64Array(4);
    this.pA = new Float64Array(4).fill(-1); // cached param values for coefficient recompute
    this.pD = new Float64Array(4).fill(-1);
    this.pR = new Float64Array(4).fill(-1);
    this.g = new Float64Array(4);         // gain at block start (ramped to target over the block)
    this.gT = new Float64Array(4);        // gain targets (scratch)
    this.frq = new Float64Array(4);       // scratch: op frequencies
    this.lvl = new Float64Array(4);       // scratch: scaled levels
    this.fade = new Float64Array(4);      // scratch: Nyquist fades
    this.F2 = new Float64Array(4);        // scratch: mean-square instantaneous frequency estimates (Hz²)
    this.B = new Float64Array(4);         // scratch: modulation indices β (radians) at block end
    this.fbe = 0;                         // scratch: effective feedback β × env4
    this.sOut = new Float64Array(4);      // scratch: output scale from the clamp of each op's targets
    // _viol() in/out: [k, violation]. Passed through a typed array because a non-inlined call with a double
    // argument / double return value boxes a HeapNumber per call (≈2.8 KB garbage per 128 samples).
    this.vio = new Float64Array(2);
    this.fbG = 0;                          // feedback gain (cycles, includes ½ average)
    this.y1 = 0; this.y2 = 0;              // op4 output history for feedback
    this.env = [];
    for (let j = 0; j < 4; j++) this.env.push(new Float64Array(MAX_BLOCK * OS_MAX));
    this.buf = new Float64Array(MAX_BLOCK * OS_MAX);
    this.hx = new Float64Array(HB_N);
    this.hy = new Float64Array(HB_N);
    // DC blocker (5 Hz one-pole high-pass): high feedback settings produce asymmetric (DC-carrying) waves.
    this.dcR = Math.exp((-2 * Math.PI * 5) / sampleRate);
    this.dcx = 0;
    this.dcy = 0;

    this.algo = 0;          // current algorithm index (0-based)
    this.duck = 0;          // algorithm-switch duck: 0 none, 1 fading out (switch at 0), 2 fading in
    this.duckG = 1;         // current duck gain
    this.duckStep = 1 / (0.002 * sampleRate);
    this.lvS = new Float64Array(4); // smoothed op level params
    this.fbS = 0;                   // smoothed feedback param
    this.smN = -1; this.smC = 1;    // cached smoothing coefficient for block length smN
    this.pendingAlgo = 0;
    this.gate = false;
    this.velocity = 1;
    this.fresh = true;      // next block: jump gains instead of ramping
    this.silentOut = true;  // decimator state has been cleared
    this.freqIn = 261.6255653005986; // voice pitch (Hz) used by render()
  }

  reset() {
    this.ph.fill(0);
    this.lv.fill(0);
    this.st.fill(IDLE);
    this.g.fill(0);
    this.fbG = 0;
    this.y1 = 0; this.y2 = 0;
    this.hx.fill(0);
    this.hy.fill(0);
    this.dcx = 0;
    this.dcy = 0;
    this.duck = 0;
    this.duckG = 1;
    this.gate = false;
    this.fresh = true;
    this.silentOut = true;
  }

  noteOn(note, velocity, freq, v, legato) {
    if (legato && this.gate) return; // legato: envelopes, phases and velocity continue (DX-style)
    this.velocity = velocity > 0 ? (velocity < 1 ? velocity : 1) : 0; // NaN-safe
    // Key sync: reset phases only if the voice is (practically) silent → no discontinuity.
    const a = this._algoFrom(v);
    let loud = 0;
    for (let j = 0; j < 4; j++) {
      if (CARRIER[a * 4 + j] && this.st[j] !== IDLE && this.lv[j] > loud) loud = this.lv[j];
    }
    if (loud < RESET_LEVEL) {
      this.ph.fill(0);
      this.y1 = 0; this.y2 = 0;
      this.algo = a;
      this.duck = 0;
      this.duckG = 1;
      this.fresh = true;
      this.hx.fill(0);
      this.hy.fill(0);
    }
    for (let j = 0; j < 4; j++) this.st[j] = ATTACK; // attack restarts from the current level
    this.gate = true;
  }

  noteOff() {
    this.gate = false;
    for (let j = 0; j < 4; j++) if (this.st[j] !== IDLE) this.st[j] = RELEASE;
  }

  isActive() {
    if (this.gate) return true;
    const a = this.duck === 1 ? this.pendingAlgo : this.algo;
    for (let j = 0; j < 4; j++) {
      if (this.st[j] !== IDLE && (CARRIER[this.algo * 4 + j] || CARRIER[a * 4 + j])) return true;
    }
    return false;
  }

  /** Current envelope levels (0..1) of the four operators, for UI meters. Fills `out` (length ≥ 4). */
  getOpLevels(out) {
    for (let j = 0; j < 4; j++) out[j] = this.lv[j];
    return out;
  }

  _algoFrom(v) {
    const a = Math.round(v[this.iAlgo]) - 1;
    return a > 0 ? (a < 7 ? a : 7) : 0; // NaN-safe
  }

  process(v, freq, outL, outR, offset, n) {
    this.freqIn = freq;
    this.render(v, outL, outR, offset, n);
  }

  /**
   * Same as process() with the pitch taken from this.freqIn. The voice uses this entry point: a double argument
   * to a non-inlined call is boxed (a HeapNumber per call), a field store is not.
   */
  render(v, outL, outR, offset, n) {
    while (n > 0) {
      const m = n > MAX_BLOCK ? MAX_BLOCK : n;
      this._block(v, outL, outR, offset, m);
      offset += m;
      n -= m;
    }
  }

  _updateCoefs(v, j) {
    const a = v[this.iA[j]], d = v[this.iD[j]], r = v[this.iR[j]];
    const rate = this.rate;
    if (a !== this.pA[j]) {
      this.pA[j] = a;
      const t = a > MIN_ATTACK ? a : MIN_ATTACK;
      this.cA[j] = 1 - Math.exp(-LN_3 / (t * rate));
    }
    if (d !== this.pD[j]) {
      this.pD[j] = d;
      const t = d > 0.0005 ? d : 0.0005;
      this.cD[j] = Math.exp(-LN_1000 / (t * rate));
    }
    if (r !== this.pR[j]) {
      this.pR[j] = r;
      const t = r > 0.0005 ? r : 0.0005;
      this.cR[j] = Math.exp(-LN_1000 / (t * rate));
    }
  }

  /** Render envelope of op j for N oversampled samples into this.env[j]. */
  _env(j, N, sus) {
    const out = this.env[j];
    let lv = this.lv[j];
    let st = this.st[j];
    let k = 0;
    while (k < N) {
      if (st === ATTACK) {
        const c = this.cA[j];
        while (k < N) {
          lv += (ATT_TARGET - lv) * c;
          if (lv >= 1) { lv = 1; out[k++] = 1; st = DECAY; break; }
          out[k++] = lv;
        }
      } else if (st === DECAY) {
        const c = this.cD[j];
        while (k < N) { lv = sus + (lv - sus) * c; out[k++] = lv; }
      } else if (st === RELEASE) {
        const c = this.cR[j];
        while (k < N) {
          lv *= c;
          if (lv < SILENT) { lv = 0; st = IDLE; out[k++] = 0; break; }
          out[k++] = lv;
        }
      } else {
        while (k < N) out[k++] = 0;
      }
    }
    if (st === DECAY) {
      const dlt = lv - sus;
      if (dlt < 1e-9 && dlt > -1e-9) lv = sus; // settle exactly (no denormal creep)
    }
    this.lv[j] = lv;
    this.st[j] = st;
  }

  /**
   * Worst normalised violation (> 1 = too much) for modulation group (car, mod bitmasks) when all its
   * modulation indices are scaled by k = this.vio[0]; the result goes to this.vio[1]. Monotone in k. Per operator j, modulators first:
   *   F2_j  = f_j² + Σ_m (k·β_m)²/2 · F2_m          mean-square instantaneous frequency (Hz²); RMS deviations
   *                                                  add in quadrature through the graph
   *   edge  = f_j + γ·√dev2_j + max_m w_m·(γ/√2)·√F2_m,  w_m = min(1, 2kβ_m)     (Carson-like spectral edge)
   *   alias : edge / limit  (limit = laCar·rate for carriers, laMod·rate for modulators; oversampled rate)
   *   bright: √dev2_j / (ceiling − f_j)  for carriers  → upper notes become gentler instead of harsh
   * Calibrated with a randomised 4-op torture suite (160 patch×note cases, all algorithms, feedback).
   */
  _viol(a16, car, mod) {
    const k = this.vio[0];
    const frq = this.frq, B = this.B, F2 = this.F2;
    const all = car | mod;
    const LaCar = this.laCar * this.rate, LaMod = this.laMod * this.rate;
    let viol = 0;
    for (let j = 3; j >= 0; j--) {
      if (((all >> j) & 1) === 0) continue;
      const fj = frq[j];
      let f2 = fj * fj;
      if (j === 3) { const q = 1 + this.fbe; f2 *= q * q; }
      let dev2 = 0, margin = 0;
      for (let m = j + 1; m < 4; m++) {
        if (ROUTE[a16 + j * 4 + m] !== 0 && ((mod >> m) & 1) !== 0) {
          const b = B[m] * k;
          dev2 += 0.5 * b * b * F2[m];
          const w = 2 * b < 1 ? 2 * b : 1;
          const mg = w * w * F2[m];
          if (mg > margin) margin = mg;
        }
      }
      F2[j] = f2 + dev2;
      const isCar = ((car >> j) & 1) !== 0;
      const dev = Math.sqrt(dev2);
      const edge = fj + ALIAS_GAMMA * dev + ALIAS_MARGIN * Math.sqrt(margin);
      const vA = edge / (isCar ? LaCar : LaMod);
      if (vA > viol) viol = vA;
      if (isCar && dev2 > 0) {
        const room = this.ceiling - fj;
        const vB = room > 0 ? dev / room : 1e9;
        if (vB > viol) viol = vB;
      }
    }
    this.vio[1] = viol;
  }

  _block(v, outL, outR, offset, n) {
    const freq = this.freqIn;
    const os = this.os;
    const N = n * os;

    // ── Silent fast path ──
    if (!this.isActive()) {
      for (let i = 0; i < n; i++) { outL[offset + i] = 0; outR[offset + i] = 0; }
      if (!this.silentOut) {
        this.hx.fill(0); this.hy.fill(0); this.y1 = 0; this.y2 = 0; this.g.fill(0); this.fbG = 0;
        this.dcx = 0; this.dcy = 0;
        this.silentOut = true;
      }
      if (this.duck !== 0) {
        if (this.duck === 1) this.algo = this.pendingAlgo;
        this.duck = 0;
      }
      this.duckG = 1;
      this.fresh = true;
      return;
    }
    this.silentOut = false;

    // ── Algorithm (duck ≈2 ms out, switch at silence, ≈2 ms in) ──
    const want = this._algoFrom(v);
    if (this.duck === 1) {
      if (want === this.algo) this.duck = 2;     // switched back before the swap: just fade in again
      else this.pendingAlgo = want;
    } else if (want !== this.algo) {
      if (this.fresh) this.algo = want;          // no audible history → switch immediately
      else { this.duck = 1; this.pendingAlgo = want; }
    }
    const a = this.algo;
    const a4 = a * 4, a16 = a * 16;

    // ── Frequencies ──
    const oct = v[this.iOct];
    const base = freq * Math.pow(2, oct + v[this.iFine] / 1200);
    const rate = this.rate;
    // Carriers fade out between 0.40 and 0.47 of the (oversampled) rate. Modulators fade out between
    // modLo and modHi: an ultrasonic modulator produces no audible first-order sidebands, only
    // higher-order ones that fold back (e.g. C7 × ratio 14 → J3 sidebands at ≈ 90 kHz).
    const frq = this.frq, fade = this.fade;
    const modLo = this.modLo * rate, modInv = 1 / ((this.modHi - this.modLo) * rate);
    const carLo = 0.40 * rate, carInv = 1 / (0.07 * rate);
    for (let j = 0; j < 4; j++) {
      const det = v[this.iDet[j]];
      let f = base * v[this.iRatio[j]] * (det !== 0 ? Math.pow(2, det / 1200) : 1);
      if (!(f > 0)) f = 0;
      let fd = CARRIER[a4 + j] !== 0 ? 1 - (f - carLo) * carInv : 1 - (f - modLo) * modInv;
      fd = fd < 0 ? 0 : fd > 1 ? 1 : fd;
      fade[j] = fd * fd * (3 - 2 * fd);
      if (f > 0.49 * rate) f = 0.49 * rate; // silent anyway (fade = 0); keeps phase increments sane
      frq[j] = f;
    }

    // ── Envelopes (oversampled rate) ──
    for (let j = 0; j < 4; j++) {
      this._updateCoefs(v, j);
      let s = v[this.iS[j]];
      s = s > 0 ? (s < 1 ? s : 1) : 0; // NaN-safe
      this._env(j, N, s);
    }

    // ── Levels: velocity & key scaling ──
    const vel = this.velocity;
    let noteRel = 0;
    if (freq > 0) noteRel = (12 * Math.log2(freq / 440) + 9) / 24; // (note − 60)/24
    const lvl = this.lvl, lvS = this.lvS;
    if (n !== this.smN) { this.smN = n; this.smC = 1 - Math.exp(-n / (0.003 * this.sr)); }
    const cS = this.fresh ? 1 : this.smC;
    for (let j = 0; j < 4; j++) {
      let Lt = v[this.iLevel[j]];
      Lt = Lt > 0 ? (Lt < 1 ? Lt : 1) : 0; // NaN-safe
      let L = lvS[j] + (Lt - lvS[j]) * cS;
      if (L - Lt < 1e-7 && Lt - L < 1e-7) L = Lt;
      lvS[j] = L;
      const vs = v[this.iVel[j]];
      L *= 1 - vs * (1 - vel);
      const ks = v[this.iKs[j]];
      if (ks !== 0) L *= Math.pow(2, ks * noteRel); // ±12 dB at ±4 octaves (ks = ±1)
      lvl[j] = L >= 0 ? L : 0; // NaN-safe (bad vel/kscale values)
    }

    // ── Spectral-reach limiting (index clamping) ──
    // For each modulation group (a carrier tree), one uniform scale k on all its modulation indices is found
    // such that the worst "violation" is 1 (see _viol): anti-alias Carson edges of every operator and the RMS
    // brightness of the carriers. x = 1/k_hard is passed through a quadratic soft knee, so the reduction
    // starts gently and is monotone and smooth across the keyboard. Low/mid notes: no reduction at all.
    const E = this.env;
    const Nl = N - 1;
    const B = this.B, sOut = this.sOut, gT = this.gT;
    let fb = v[this.iFb];
    fb = fb > 0 ? (fb < 1 ? fb : 1) : 0; // NaN-safe
    fb = this.fbS + (fb - this.fbS) * cS;
    this.fbS = fb;
    let fbBeta = feedbackBeta(fb);
    if (fbBeta > 0 && this.fbKnee > 0) {
      const r = frq[3] / (this.fbKnee * rate);
      fbBeta /= 1 + r * r; // feedback saw is rich in harmonics: shrink it at very high op4 pitch
    }
    this.fbe = fbBeta * E[3][Nl];
    for (let j = 0; j < 4; j++) {
      const Lm = lvl[j] < 1.5 ? lvl[j] : 1.5;
      B[j] = CARRIER[a4 + j] !== 0 ? 0 : 4 * Math.PI * Lm * Lm * fade[j] * E[j][Nl]; // β in radians
      sOut[j] = 1;
    }
    const ng = NGRP[a];
    for (let gi = 0; gi < ng; gi++) {
      const car = GRP_CAR[a * 2 + gi], mod = GRP_MOD[a * 2 + gi];
      let h = 1;
      const vio = this.vio;
      vio[0] = KNEE_HI; this._viol(a16, car, mod);
      if (vio[1] > 1) {
        // Deterministic bisection over the full bracket: identical inputs → identical k every block (a
        // warm-started bracket makes k jitter at the block rate, which modulates the index → sidebands).
        // Final regula-falsi step between the bracket's violations → k is continuous in its inputs.
        let lo = 0, hi = KNEE_HI, kh = 0;
        vio[0] = 0; this._viol(a16, car, mod);
        let vlo = vio[1];
        vio[0] = KNEE_HI; this._viol(a16, car, mod);
        let vhi = vio[1];
        if (vlo < 1) {
          for (let it = 0; it < 10; it++) {
            const mid = 0.5 * (lo + hi);
            vio[0] = mid; this._viol(a16, car, mod);
            const vm = vio[1];
            if (vm > 1) { hi = mid; vhi = vm; } else { lo = mid; vlo = vm; }
          }
          kh = lo + ((hi - lo) * (1 - vlo)) / (vhi - vlo);
        }
        if (kh <= 1e-6) h = 0;
        else {
          const u = -Math.log(kh); // log x
          h = u >= KNEE_W ? kh : Math.exp(-((u + KNEE_W) * (u + KNEE_W)) / (4 * KNEE_W));
        }
      }
      for (let j = 0; j < 4; j++) if ((mod >> j) & 1) sOut[j] = h;
    }

    // ── Gain targets ──
    const norm = 1 / Math.sqrt(NCAR[a]);
    for (let j = 0; j < 4; j++) {
      if (CARRIER[a4 + j] !== 0) {
        const L = lvl[j] < 1 ? lvl[j] : 1; // key/velocity scaling never pushes a carrier past full level
        gT[j] = L * norm * fade[j];
      } else {
        const L = lvl[j] < 1.5 ? lvl[j] : 1.5;
        gT[j] = 2 * L * L * fade[j] * sOut[j]; // β/2π in cycles: 4π·L²/2π
      }
    }
    const fbT = (fbBeta * 0.5) / TWO_PI;

    // ramp setup
    const g = this.g;
    if (this.fresh) {
      for (let j = 0; j < 4; j++) g[j] = gT[j];
      this.fbG = fbT;
      this.fresh = false;
    }
    const invN = 1 / N;
    let g1 = g[0], g2 = g[1], g3 = g[2], g4 = g[3], gf = this.fbG;
    const d1 = (gT[0] - g1) * invN, d2 = (gT[1] - g2) * invN, d3 = (gT[2] - g3) * invN, d4 = (gT[3] - g4) * invN;
    const df = (fbT - gf) * invN;
    g[0] = gT[0]; g[1] = gT[1]; g[2] = gT[2]; g[3] = gT[3];
    this.fbG = fbT;

    // routing
    const r12 = ROUTE[a16 + 1], r13 = ROUTE[a16 + 2], r14 = ROUTE[a16 + 3];
    const r23 = ROUTE[a16 + 4 + 2], r24 = ROUTE[a16 + 4 + 3];
    const r34 = ROUTE[a16 + 8 + 3];
    const k1 = CARRIER[a4], k2 = CARRIER[a4 + 1], k3 = CARRIER[a4 + 2], k4 = CARRIER[a4 + 3];

    const E1 = E[0], E2 = E[1], E3 = E[2], E4 = E[3];
    const T = SIN_TD;
    const inv = 1 / rate;
    const dp1 = frq[0] * inv, dp2 = frq[1] * inv, dp3 = frq[2] * inv, dp4 = frq[3] * inv;
    let p1 = this.ph[0], p2 = this.ph[1], p3 = this.ph[2], p4 = this.ph[3];
    let y1 = this.y1, y2 = this.y2;
    const buf = this.buf;

    // ── Operator loop (oversampled) ──
    for (let k = 0; k < N; k++) {
      g1 += d1; g2 += d2; g3 += d3; g4 += d4; gf += df;
      const e4k = E4[k];
      // op 4 (feedback)
      let x = (p4 + gf * e4k * (y1 + y2) + PH_OFS) * SIN_SIZE;
      let i0 = x | 0;
      let i = (i0 & SIN_MASK) << 1;
      const s4 = T[i] + (x - i0) * T[i + 1];
      y2 = y1; y1 = s4;
      const o4 = s4 * g4 * e4k;
      // op 3
      x = (p3 + r34 * o4 + PH_OFS) * SIN_SIZE;
      i0 = x | 0; i = (i0 & SIN_MASK) << 1;
      const o3 = (T[i] + (x - i0) * T[i + 1]) * g3 * E3[k];
      // op 2
      x = (p2 + r23 * o3 + r24 * o4 + PH_OFS) * SIN_SIZE;
      i0 = x | 0; i = (i0 & SIN_MASK) << 1;
      const o2 = (T[i] + (x - i0) * T[i + 1]) * g2 * E2[k];
      // op 1
      x = (p1 + r12 * o2 + r13 * o3 + r14 * o4 + PH_OFS) * SIN_SIZE;
      i0 = x | 0; i = (i0 & SIN_MASK) << 1;
      const o1 = (T[i] + (x - i0) * T[i + 1]) * g1 * E1[k];

      buf[k] = k1 * o1 + k2 * o2 + k3 * o3 + k4 * o4;

      p1 += dp1; if (p1 >= 1) p1 -= 1;
      p2 += dp2; if (p2 >= 1) p2 -= 1;
      p3 += dp3; if (p3 >= 1) p3 -= 1;
      p4 += dp4; if (p4 >= 1) p4 -= 1;
    }
    this.ph[0] = p1; this.ph[1] = p2; this.ph[2] = p3; this.ph[3] = p4;
    this.y1 = y1; this.y2 = y2;

    // ── Decimate + output (with algorithm-switch duck) ──
    const dm = this.duck, dst = this.duckStep;
    let og = this.duckG;
    const dcR = this.dcR;
    let dcx = this.dcx, dcy = this.dcy;
    if (os === 2) {
      const hx = this.hx, hy = this.hy;
      for (let t = 0; t < n; t++) {
        let s0 = buf[2 * t + 1], s1 = buf[2 * t];
        for (let c = 0; c < HB_N; c += 2) {
          const t0 = (s0 - hy[c]) * HB[c] + hx[c];
          hx[c] = s0; hy[c] = t0; s0 = t0;
          const t1 = (s1 - hy[c + 1]) * HB[c + 1] + hx[c + 1];
          hx[c + 1] = s1; hy[c + 1] = t1; s1 = t1;
        }
        const xin = 0.5 * (s0 + s1);
        dcy = xin - dcx + dcR * dcy;
        dcx = xin;
        if (dm === 1) { og -= dst; if (og < 0) og = 0; } else if (dm === 2) { og += dst; if (og > 1) og = 1; }
        const y = dcy * og;
        outL[offset + t] = y;
        outR[offset + t] = y;
      }
      // denormal guard: flush decayed allpass states
      let e = 0;
      for (let c = 0; c < HB_N; c++) e += (hy[c] < 0 ? -hy[c] : hy[c]) + (hx[c] < 0 ? -hx[c] : hx[c]);
      if (e < 1e-15) { hx.fill(0); hy.fill(0); }
    } else {
      for (let t = 0; t < n; t++) {
        const xin = buf[t];
        dcy = xin - dcx + dcR * dcy;
        dcx = xin;
        if (dm === 1) { og -= dst; if (og < 0) og = 0; } else if (dm === 2) { og += dst; if (og > 1) og = 1; }
        const y = dcy * og;
        outL[offset + t] = y;
        outR[offset + t] = y;
      }
    }
    if (dcy < 1e-15 && dcy > -1e-15) dcy = 0;
    this.dcx = dcx;
    this.dcy = dcy;
    this.duckG = og;
    if (dm === 1 && og <= 0) {
      this.algo = this.pendingAlgo;
      this.duck = 2;
      // gains would ramp from the old algorithm's targets; jump them instead (output is ducked to 0 here)
      this.fresh = true;
    } else if (dm === 2 && og >= 1) {
      this.duck = 0;
    }
  }
}
