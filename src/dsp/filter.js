// AURORA 極光 — voice filters.
//
//   VoiceFilter  main per-voice stereo filter:
//                · ladder24 / ladder12  nonlinear zero-delay-feedback transistor ladder (Moog-style), 2× oversampled
//                  below 88.2 kHz. Per-stage tanh transconductance nonlinearities, linearised per sample around
//                  the previous state ("cheap non-linear ZDF", after Teemu Voipio / mystran), so the feedback loop
//                  is solved without a unit delay. Self-oscillates with a stable, bounded amplitude near res = 1.
//                  ladder12 taps stage 2 while the resonance loop still closes over all 4 stages (Xpander style).
//                · lp / bp / hp / notch  Simper/Cytomic TPT state-variable filter (trapezoidal, modulation-stable).
//                · formant  5 parallel TPT bandpasses (real bass/tenor/alto/soprano formant tables, A-E-I-O-U morph).
//                · comb     fractional-delay (Hermite) feedback comb tuned to cutoff Hz, damped loop, loop saturation.
//   SVFilter     generic stereo TPT SVF (filter2 etc).
//   filterResponse  analytic magnitude response (dB) for UI curves.
//
// Pure ES module: no allocation on the audio path, no platform APIs, deterministic.
import { fastTanh, hermite } from './util.js';
import { FILTER_TYPES } from './params.js';

const PI = Math.PI;
const MAXN = 128; // internal chunk size (scratch buffers); larger blocks are split
const FLUSH = 1e-18; // states smaller than this are flushed to 0 (also catches NaN)

// Engines (types sharing one state set switch by output-weight crossfade; across engines we crossfade outputs)
const E_LADDER = 0, E_SVF = 1, E_FORMANT = 2, E_COMB = 3;
// Block-parameter slots (VoiceFilter.B)
const B_C0 = 0, B_C1 = 1, B_RES = 2, B_DRIVE = 3, B_VOWEL = 4;
const TYPE_ENGINE = [E_LADDER, E_LADDER, E_SVF, E_SVF, E_SVF, E_SVF, E_FORMANT, E_COMB];

// ───────────────────────── parameter mappings (shared with filterResponse) ─────────────────────────
const LADDER_BASS_COMP = 0.62; // fraction of the ladder's (1+k) passband loss restored at the input
const LADDER_IN_SCALE = 0.45;  // internal level: ±1 input → ±0.45 "thermal" units (gentle warmth at drive 0)
const LADDER_DRIVE_OCT = 3;    // drive 1 → +18 dB into the ladder
/** res 0..1 → ladder feedback k. Linear threshold k = 4 is crossed at res ≈ 0.93 */
function ladderK(res) { return 4.4 * Math.pow(res, 1.25); }
/**
 * Self-oscillation pitch compensation (cutoff multiplier). Past k = 4 the saturating loop oscillates slightly
 * flat (amplitude-dependent); measured detune ≈ −(6.63u − 4.08u²)% · (1 − 8.2·fc/fsI), u = k − 4.
 */
function ladderPitchComp(k, fcRel) {
  const u = k - 4;
  if (u <= 0) return 1;
  let h = 1 - 8.2 * fcRel; if (h < 0) h = 0;
  return 1 + (0.0663 * u - 0.0408 * u * u) * h;
}
/** Level trim for the 2-pole ladder tap (its resonant peak is twice the 4-pole's). */
function ladder12Gain(k) { return 1 / (1 + 0.12 * k); }
/** Output makeup for the ladder as a function of drive (keeps perceived loudness roughly constant). */
function ladderMakeup(drive) { return Math.pow(10, 0.3 * drive * drive); } // +6 dB at drive 1
/** res 0..1 → SVF damping k = 1/Q, Q = 0.5 · 50^res  (0.5 … 25) */
function svfK(res) { return 2 * Math.pow(50, -res); }
/** Bandpass output gain: peak gain = sqrt(2Q/0.707) (+3 dB at Q 0.707) — rises gently with res, skirts fall gently. */
function svfBpGain(k) { return Math.sqrt(k * 2.8284271247461903); }
const COMB_LOOP_DC = 0.5, COMB_IN_DC = 5; // Hz
const DRIVE_MAKEUP = 0.35; // SVF/formant pre-saturation tanh(a·x)/a·(1 + 0.35a), a = 4·drive
/** res 0..1 → comb feedback 0..0.98 */
function combFb(res) { return 0.98 * Math.sqrt(res); }
/** Formant bandwidth scale: res 0 → 1.5× table bandwidth (smooth), res 1 → 0.3× (sharp, vocal). */
function formantBwScale(res) { return Math.pow(2, 0.6 - 2.3 * res); }
const SVF_WEIGHTS = [ // out = m0·x + (mb·bpGain − m1·k)·band + m2·low
  [0, 0, 0, 1],   // lp
  [0, 0, 1, 0],   // bp
  [1, 1, 0, -1],  // hp  (x − k·band − low)
  [1, 1, 0, 0],   // notch (x − k·band)
];
const SVF_MODE_OF_TYPE = [0, 0, 0, 1, 2, 3, 0, 0]; // VoiceFilter type → weight row (lp,bp,hp,notch)
const SVF2_MODE_ROW = [0, 2, 1, 3];                  // SVFilter mode (0 lp,1 hp,2 bp,3 notch) → weight row

function clampCut(c, fs) {
  const hi = fs * 0.49;
  return c > 10 ? (c < hi ? c : hi) : 10; // NaN → 10
}
function clamp01(x) { return x > 0 ? (x < 1 ? x : 1) : 0; } // NaN → 0

// ───────────────────────── 2× polyphase IIR halfband (hiir-style, 6 coefs, tbw 0.06) ─────────────────────────
// Passband flat (< 0.001 dB) to 0.23·fs2, stopband ≥ 85 dB from 0.28·fs2. Path A: HB0,HB2,HB4; path B: HB1,HB3,HB5.
const HB0 = 0.05421752575519079, HB1 = 0.1967979698143128, HB2 = 0.3830873272909491;
const HB3 = 0.5731364111480913, HB4 = 0.7487209444364263, HB5 = 0.9142937096850178;

// ───────────────────────── formant tables ─────────────────────────
// Classic singer formant data (F1–F5 centre Hz, level dB, bandwidth Hz) for bass, tenor, alto, soprano.
// Order per voice type: vowels a, e, i, o, u.
const FORMANT_DATA = [
  [ // bass
    [[600, 1040, 2250, 2450, 2750], [0, -7, -9, -9, -20], [60, 70, 110, 120, 130]],
    [[400, 1620, 2400, 2800, 3100], [0, -12, -9, -12, -18], [40, 80, 100, 120, 120]],
    [[250, 1750, 2600, 3050, 3340], [0, -30, -16, -22, -28], [60, 90, 100, 120, 120]],
    [[400, 750, 2400, 2600, 2900], [0, -11, -21, -20, -40], [40, 80, 100, 120, 120]],
    [[350, 600, 2400, 2675, 2950], [0, -20, -32, -28, -36], [40, 80, 100, 120, 120]],
  ],
  [ // tenor
    [[650, 1080, 2650, 2900, 3250], [0, -6, -7, -8, -22], [80, 90, 120, 130, 140]],
    [[400, 1700, 2600, 3200, 3580], [0, -14, -12, -14, -20], [70, 80, 100, 120, 120]],
    [[290, 1870, 2800, 3250, 3540], [0, -15, -18, -20, -30], [40, 90, 100, 120, 120]],
    [[400, 800, 2600, 2800, 3000], [0, -10, -12, -12, -26], [40, 80, 100, 120, 120]],
    [[350, 600, 2700, 2900, 3300], [0, -20, -17, -14, -26], [40, 60, 100, 120, 120]],
  ],
  [ // alto
    [[800, 1150, 2800, 3500, 4950], [0, -4, -20, -36, -60], [80, 90, 120, 130, 140]],
    [[400, 1600, 2700, 3300, 4950], [0, -24, -30, -35, -60], [60, 80, 120, 150, 200]],
    [[350, 1700, 2700, 3700, 4950], [0, -20, -30, -36, -60], [50, 100, 120, 150, 200]],
    [[450, 800, 2830, 3500, 4950], [0, -9, -16, -28, -55], [70, 80, 100, 130, 135]],
    [[325, 700, 2530, 3500, 4950], [0, -12, -30, -40, -64], [50, 60, 170, 180, 200]],
  ],
  [ // soprano
    [[800, 1150, 2900, 3900, 4950], [0, -6, -32, -20, -50], [80, 90, 120, 130, 140]],
    [[350, 2000, 2800, 3600, 4950], [0, -20, -15, -40, -56], [60, 100, 120, 150, 200]],
    [[270, 2140, 2950, 3900, 4950], [0, -12, -26, -26, -44], [60, 90, 100, 120, 120]],
    [[450, 800, 2830, 3800, 4950], [0, -11, -22, -22, -50], [70, 80, 100, 130, 135]],
    [[325, 700, 2700, 3800, 4950], [0, -16, -35, -40, -60], [50, 60, 170, 180, 200]],
  ],
];
const NF = 5; // formants per vowel
// Flattened log tables: index (voiceType*5 + vowel)*5 + formant
const F_LOGF = new Float64Array(4 * 5 * NF), F_DB = new Float64Array(4 * 5 * NF), F_LOGBW = new Float64Array(4 * 5 * NF);
for (let t = 0; t < 4; t++) for (let v = 0; v < 5; v++) for (let j = 0; j < NF; j++) {
  const i = (t * 5 + v) * NF + j, d = FORMANT_DATA[t][v];
  F_LOGF[i] = Math.log(d[0][j]); F_DB[i] = d[1][j]; F_LOGBW[i] = Math.log(d[2][j]);
}
// Alternating polarity between neighbouring parallel formants keeps the valleys between them shallow
// (as in Klatt's parallel synthesiser) instead of cancelling into deep notches.
const F_SIGN = [1, -1, 1, -1, 1];
const FORMANT_NORM_REF = 60;  // loudness reference for the power normalisation (tuned: 110–220 Hz saw → ≈ −2…−4 dB)
const FORMANT_TILT = 1.6;       // source spectral tilt assumed by the normalisation (power ∝ f^-tilt)

/**
 * Compute the 5 formant targets for B = [·, cutoff, res, ·, vowel] into out arrays (freq Hz, bandwidth Hz, signed gain
 * including the loudness normalisation). Cutoff maps to "voice size": the table blends bass (≈354 Hz) → tenor (1 kHz)
 * → alto (2.8 kHz) → soprano (8 kHz), and all formants are additionally shifted by 0.2 octave per octave of cutoff
 * (×0.46 at 20 Hz … ×1.8 at 20 kHz), so an envelope on cutoff gives a continuous "size/gender" sweep.
 */
function formantTargets(B, fs, outF, outBW, outGain) {
  const cutoff = B[B_C1], vowel = B[B_VOWEL], res = B[B_RES];
  let lc = Math.log2((cutoff > 1 ? cutoff : 1) / 1000);
  lc = lc < -6 ? -6 : lc > 4.5 ? 4.5 : lc;
  let q = (lc + 1.5) / 1.5; q = q < 0 ? 0 : q > 3 ? 3 : q;
  let vt = q | 0; if (vt > 2) vt = 2;
  const ft = q - vt;
  const p = clamp01(vowel) * 4;
  let vw = p | 0; if (vw > 3) vw = 3;
  const fv = p - vw;
  const shift = Math.pow(2, 0.2 * lc);
  const bws = formantBwScale(clamp01(res));
  const nyq = 0.45 * fs;
  const i00 = (vt * 5 + vw) * NF, i01 = i00 + NF, i10 = ((vt + 1) * 5 + vw) * NF, i11 = i10 + NF;
  const w00 = (1 - ft) * (1 - fv), w01 = (1 - ft) * fv, w10 = ft * (1 - fv), w11 = ft * fv;
  let pw = 0;
  for (let j = 0; j < NF; j++) {
    const lf = w00 * F_LOGF[i00 + j] + w01 * F_LOGF[i01 + j] + w10 * F_LOGF[i10 + j] + w11 * F_LOGF[i11 + j];
    const db = w00 * F_DB[i00 + j] + w01 * F_DB[i01 + j] + w10 * F_DB[i10 + j] + w11 * F_DB[i11 + j];
    const lb = w00 * F_LOGBW[i00 + j] + w01 * F_LOGBW[i01 + j] + w10 * F_LOGBW[i10 + j] + w11 * F_LOGBW[i11 + j];
    let f = Math.exp(lf) * shift;
    let bw = Math.exp(lb) * shift * bws;
    let a = Math.pow(10, db * 0.05);
    if (f > nyq * 0.8) { // fade formants approaching Nyquist
      const x = (nyq - f) / (nyq * 0.2);
      a *= x > 0 ? x : 0;
      if (f > nyq) f = nyq;
    }
    if (bw < f * 0.0125) bw = f * 0.0125; // Q ≤ 80
    if (bw > f * 2) bw = f * 2;           // Q ≥ 0.5
    outF[j] = f; outBW[j] = bw;
    outGain[j] = a;
    pw += a * a * bw * Math.pow(f * 0.001, -FORMANT_TILT);
  }
  const norm = FORMANT_NORM_REF / Math.sqrt(pw + 1e-9);
  for (let j = 0; j < NF; j++) outGain[j] *= norm * F_SIGN[j];
}

// ───────────────────────── VoiceFilter ─────────────────────────
// Allocation note: V8 boxes doubles passed to / returned from non-inlined functions. Everything below the public
// process() therefore passes block parameters through preallocated Float64Arrays (B, and one coefficient block per
// engine) and only arrays / small ints as call arguments → zero garbage per block.

export class VoiceFilter {
  /**
   * @param {number} sampleRate
   * @param {{oversample?: 1|2}} [opts] ladder oversampling; default 2 below 88.2 kHz, 1 above.
   */
  constructor(sampleRate, opts = {}) {
    this.fs = sampleRate;
    this.os = opts.oversample === 1 || opts.oversample === 2 ? opts.oversample : (sampleRate >= 88200 ? 1 : 2);
    this.xfLen = Math.max(32, Math.round(0.005 * sampleRate)); // 5 ms crossfades for type switches

    this.B = new Float64Array(8);                                             // current block params
    this.inp = new Float64Array(5);  // run() inputs: [cutoff0, cutoff1, res, drive, vowel] (see run())
    this.tmpL = new Float64Array(MAXN); this.tmpR = new Float64Array(MAXN);   // formant input scratch
    this.accL = new Float64Array(MAXN); this.accR = new Float64Array(MAXN);   // formant sum scratch
    this.xfL = new Float64Array(MAXN); this.xfR = new Float64Array(MAXN);     // engine-crossfade (old engine) buffers

    // ladder: [s0..s3, zi] × L,R; halfband up (7 per channel) / down (8 per channel); oversampled work buffers
    this.ld = new Float64Array(10);
    this.hbUp = new Float64Array(14); this.hbDn = new Float64Array(16);
    this.osL = new Float64Array(2 * MAXN); this.osR = new Float64Array(2 * MAXN);
    this.lP = new Float64Array(12);  // kernel coefficients (see ladderStereo / upsample2 / downsample2)
    this.lS = new Float64Array(7);   // smoothing: [k, gin, gout] + tap fade [w4 from, w4 to, w2 from, w2 to]
    this.lG = new Float64Array(2);   // tan cache [cutoff, g]
    // svf states [ic1L, ic2L, ic1R, ic2R], kernel coefficients, smoothing [k, bp, a], output-weight fade a → b
    this.sv = new Float64Array(4);
    this.sP = new Float64Array(20);
    this.sX = new Float64Array(9);
    this.sS = new Float64Array(3);
    this.sG = new Float64Array(2);
    this.sWa = new Float64Array(4); this.sWb = new Float64Array(4);
    // formant states: per formant [ic1L, ic2L, ic1R, ic2R]; current coefficients (g, k, gain); targets; cache key
    this.fmS = new Float64Array(NF * 4);
    this.fmG = new Float64Array(NF); this.fmK = new Float64Array(NF); this.fmA = new Float64Array(NF);
    this.fmTF = new Float64Array(NF); this.fmTBW = new Float64Array(NF); this.fmTA = new Float64Array(NF);
    this.fmKey = new Float64Array(3);
    this.fmD = new Float64Array(1); // smoothed drive amount a
    // comb: delay lines (power of two), states per channel [lp, loopHpX, loopHpY, inHpX, inHpY], coefficients, smoothing
    let len = 1; while (len < Math.ceil(sampleRate / 20 * 1.1) + 16) len <<= 1;
    this.cbLen = len; this.cbMask = len - 1;
    this.cbL = new Float32Array(len); this.cbR = new Float32Array(len);
    this.cbS = new Float64Array(10);
    this.cP = new Float64Array(12);
    this.cSm = new Float64Array(4); // [fb, D, sat, gc]
    this.cQ = new Float64Array(8);  // combDelay scratch
    this.cbW = 0; this.cbDirty = false;
    this.reset();
  }

  reset() {
    this.ld.fill(0); this.hbUp.fill(0); this.hbDn.fill(0); this.sv.fill(0); this.fmS.fill(0); this.cbS.fill(0);
    this.cbDirty = true; this.cbW = 0;
    this.engine = -1; this.type = -1;
    this.prevEngine = -1; this.xfPos = 0; // engine crossfade progress (samples); ≥ xfLen = done
    // per-engine smoothed params ("previous block end" values); NaN = uninitialised → no ramp
    this.lS.fill(NaN); this.lS[3] = this.lS[4] = 1; this.lS[5] = this.lS[6] = 0; this.lSubPos = 1 << 30;
    this.lG[0] = -1; this.sG[0] = -1;
    this.sS.fill(NaN);
    this.sWa.fill(0); this.sWb.fill(0); this.sWa[3] = this.sWb[3] = 1; this.sSubPos = 1 << 30;
    this.fmInit = false; this.fmD[0] = NaN; this.fmKey.fill(NaN);
    this.cSm.fill(NaN);
  }

  /** Reset one engine's state (called when it becomes active). */
  _resetEngine(e) {
    if (e === E_LADDER) { this.ld.fill(0); this.hbUp.fill(0); this.hbDn.fill(0); this.lS[0] = this.lS[1] = this.lS[2] = NaN; }
    else if (e === E_SVF) { this.sv.fill(0); this.sS.fill(NaN); }
    else if (e === E_FORMANT) { this.fmS.fill(0); this.fmInit = false; this.fmD[0] = NaN; }
    else if (e === E_COMB) { this.cbS.fill(0); this.cbDirty = true; this.cSm.fill(NaN); }
  }

  /**
   * In place on bufL/bufR[offset..offset+n) (two distinct buffers). type = FILTER_TYPES index. cutoff0 → cutoff1 (Hz)
   * interpolated exponentially across the block. res, drive, vowel 0..1 (smoothed linearly across the block).
   */
  process(bufL, bufR, offset, n, type, cutoff0, cutoff1, res, drive, vowel) {
    const I = this.inp;
    I[0] = cutoff0; I[1] = cutoff1; I[2] = res; I[3] = drive; I[4] = vowel;
    this.run(bufL, bufR, offset, n, type);
  }

  /**
   * process() with the numeric block parameters read from this.inp = [cutoff0, cutoff1, res, drive, vowel].
   * Allocation-free entry point for the voice (double arguments to a non-inlined call would be boxed).
   */
  run(bufL, bufR, offset, n, type) {
    if (n <= 0) return;
    const B = this.B, fs = this.fs, I = this.inp;
    const c0 = clampCut(I[0], fs), c1 = clampCut(I[1], fs);
    B[B_RES] = clamp01(I[2]); B[B_DRIVE] = clamp01(I[3]); B[B_VOWEL] = clamp01(I[4]);
    let t = (type + 0.5) | 0; if (t < 0 || t > 7) t = 0;
    if (n <= MAXN) { B[B_C0] = c0; B[B_C1] = c1; this._chunk(bufL, bufR, offset, n, t); return; }
    // split long blocks, keeping the exponential cutoff trajectory
    const lr = Math.log(c1 / c0);
    for (let o = 0; o < n; o += MAXN) {
      const m = n - o < MAXN ? n - o : MAXN;
      B[B_C0] = c0 * Math.exp(lr * o / n); B[B_C1] = c0 * Math.exp(lr * (o + m) / n);
      this._chunk(bufL, bufR, offset + o, m, t);
    }
  }

  _chunk(bufL, bufR, offset, n, t) {
    if (t !== this.type) this._switchType(t);
    const e = this.engine;
    if (this.prevEngine >= 0 && this.xfPos < this.xfLen) {
      // engine crossfade: run the old engine on a copy of the input, mix with a smoothstep fade
      const tl = this.xfL, tr = this.xfR;
      for (let i = 0; i < n; i++) { tl[i] = bufL[offset + i]; tr[i] = bufR[offset + i]; }
      this._run(this.prevEngine, tl, tr, 0, n);
      this._run(e, bufL, bufR, offset, n);
      const L = this.xfLen;
      let p = this.xfPos;
      for (let i = 0; i < n; i++, p++) {
        const u = p < L ? p / L : 1, w = u * u * (3 - 2 * u);
        const j = offset + i;
        bufL[j] = tl[i] + (bufL[j] - tl[i]) * w;
        bufR[j] = tr[i] + (bufR[j] - tr[i]) * w;
      }
      this.xfPos = p < L ? p : L;
      if (p >= L) this.prevEngine = -1;
    } else {
      this._run(e, bufL, bufR, offset, n);
    }
  }

  _switchType(t) {
    const e = TYPE_ENGINE[t];
    if (this.type < 0) { // first use after reset: no fade
      this.engine = e; this.type = t; this.prevEngine = -1; this.xfPos = this.xfLen;
      this._resetEngine(e);
      this._setSubtype(t, true);
      return;
    }
    if (e !== this.engine) {
      this.prevEngine = this.engine;
      this.engine = e;
      this.xfPos = 0;
      this._resetEngine(e);
      this._setSubtype(t, true);
    } else {
      this._setSubtype(t, false);
    }
    this.type = t;
  }

  _setSubtype(t, immediate) {
    const e = TYPE_ENGINE[t];
    if (e === E_LADDER) {
      const S = this.lS, w4 = t === 0 ? 1 : 0, w2 = 1 - w4;
      if (immediate) { S[3] = S[4] = w4; S[5] = S[6] = w2; this.lSubPos = 1 << 30; }
      else { // start from the current mix
        const p = fadeProgress(this.lSubPos, this.xfLen);
        S[3] = S[3] + (S[4] - S[3]) * p; S[5] = S[5] + (S[6] - S[5]) * p;
        S[4] = w4; S[6] = w2; this.lSubPos = 0;
      }
    } else if (e === E_SVF) {
      const row = SVF_WEIGHTS[SVF_MODE_OF_TYPE[t]];
      const a = this.sWa, b = this.sWb;
      if (immediate) { for (let i = 0; i < 4; i++) a[i] = b[i] = row[i]; this.sSubPos = 1 << 30; }
      else {
        const p = fadeProgress(this.sSubPos, this.xfLen);
        for (let i = 0; i < 4; i++) { a[i] = a[i] + (b[i] - a[i]) * p; b[i] = row[i]; }
        this.sSubPos = 0;
      }
    }
  }

  _run(e, bL, bR, off, n) {
    if (e === E_LADDER) this._ladder(bL, bR, off, n);
    else if (e === E_SVF) this._svf(bL, bR, off, n);
    else if (e === E_FORMANT) this._formant(bL, bR, off, n);
    else this._comb(bL, bR, off, n);
  }

  // ───────── ladder ─────────
  _ladder(bL, bR, off, n) {
    const B = this.B, S = this.lS, P = this.lP, G = this.lG;
    const os = this.os, fsI = this.fs * os, m = n * os;
    const res = B[B_RES], drive = B[B_DRIVE];
    const k1 = ladderK(res);
    let c0 = B[B_C0], c1 = B[B_C1];
    const pm = ladderPitchComp(k1, c1 / fsI);
    if (pm !== 1) { c0 = clampCut(c0 * pm, this.fs); c1 = clampCut(c1 * pm, this.fs); }
    const g0 = c0 === G[0] ? G[1] : Math.tan(PI * c0 / fsI);
    const g1 = c1 === c0 ? g0 : c1 === G[0] ? G[1] : Math.tan(PI * c1 / fsI);
    G[0] = c1; G[1] = g1;
    const dg = Math.pow(2, drive * LADDER_DRIVE_OCT);
    const gin1 = LADDER_IN_SCALE * dg * (1 + LADDER_BASS_COMP * k1);
    const gout1 = ladderMakeup(drive) / (LADDER_IN_SCALE * dg);
    const k0 = S[0] === S[0] ? S[0] : k1;
    const gin0 = S[1] === S[1] ? S[1] : gin1;
    const gout0 = S[2] === S[2] ? S[2] : gout1;
    S[0] = k1; S[1] = gin1; S[2] = gout1;
    const inv = 1 / n, im = 1 / m;
    // tap weights (24 ↔ 12 crossfade)
    const pa = fadeProgress(this.lSubPos, this.xfLen), pb = fadeProgress(this.lSubPos + n, this.xfLen);
    this.lSubPos = this.lSubPos < this.xfLen ? this.lSubPos + n : this.xfLen;
    const w4a = S[3] + (S[4] - S[3]) * pa, w4b = S[3] + (S[4] - S[3]) * pb;
    // 2-pole tap: its resonant peak is 2× the 4-pole's, so it is scaled by 1/(1 + 0.12k) to keep levels comparable
    const w2a = (S[5] + (S[6] - S[5]) * pa) * ladder12Gain(k0);
    const w2b = (S[5] + (S[6] - S[5]) * pb) * ladder12Gain(k1);
    P[0] = g0; P[1] = g1 === g0 ? 1 : Math.exp(Math.log(g1 / g0) * im);
    P[2] = k0; P[3] = (k1 - k0) * im;
    P[4] = w4a; P[5] = (w4b - w4a) * im; P[6] = w2a; P[7] = (w2b - w2a) * im;
    P[8] = gin0; P[9] = (gin1 - gin0) * inv; P[10] = gout0; P[11] = (gout1 - gout0) * inv;
    const xl = this.osL, xr = this.osR;
    if (os === 2) {
      upsample2(bL, off, n, this.hbUp, 0, xl, P);
      upsample2(bR, off, n, this.hbUp, 7, xr, P);
      ladderStereo(xl, xr, m, this.ld, P);
      downsample2(xl, bL, off, n, this.hbDn, 0, P);
      downsample2(xr, bR, off, n, this.hbDn, 8, P);
    } else {
      let gi = gin0; const dgi = P[9];
      for (let i = 0; i < n; i++) { xl[i] = bL[off + i] * gi; xr[i] = bR[off + i] * gi; gi += dgi; }
      ladderStereo(xl, xr, m, this.ld, P);
      let go = gout0; const dgo = P[11];
      for (let i = 0; i < n; i++) { bL[off + i] = xl[i] * go; bR[off + i] = xr[i] * go; go += dgo; }
    }
  }

  // ───────── SVF (lp/bp/hp/notch) ─────────
  _svf(bL, bR, off, n) {
    const B = this.B, S = this.sS, P = this.sP, G = this.sG, fs = this.fs;
    const c0 = B[B_C0], c1 = B[B_C1], res = B[B_RES], drive = B[B_DRIVE];
    const g0 = c0 === G[0] ? G[1] : Math.tan(PI * c0 / fs);
    const g1 = c1 === c0 ? g0 : c1 === G[0] ? G[1] : Math.tan(PI * c1 / fs);
    G[0] = c1; G[1] = g1;
    const k1 = svfK(res), bp1 = svfBpGain(k1), a1 = drive * 4;
    const k0 = S[0] === S[0] ? S[0] : k1, bp0 = S[1] === S[1] ? S[1] : bp1, a0 = S[2] === S[2] ? S[2] : a1;
    S[0] = k1; S[1] = bp1; S[2] = a1;
    const inv = 1 / n;
    const pa = fadeProgress(this.sSubPos, this.xfLen), pb = fadeProgress(this.sSubPos + n, this.xfLen);
    this.sSubPos = this.sSubPos < this.xfLen ? this.sSubPos + n : this.xfLen;
    const X = this.sX;
    X[0] = g0; X[1] = g1; X[2] = inv; X[3] = k0; X[4] = k1; X[5] = bp0; X[6] = bp1; X[7] = pa; X[8] = pb;
    svfCoefs(P, X, this.sWa, this.sWb);
    const drv = a0 > 1e-4 || a1 > 1e-4;
    P[14] = drv ? (a0 > 1e-4 ? a0 : 1e-4) : 0; P[15] = (a1 - a0) * inv;
    // band-state soft limit (analog-style resonance limiting; transparent below T)
    const T = 1.8 / (1 + 1.5 * drive);
    P[16] = T; P[17] = 1 / T;
    svfRun(bL, bR, off, n, this.sv, P);
  }

  // ───────── formant ─────────
  _formant(bL, bR, off, n) {
    const B = this.B, fs = this.fs;
    const TF = this.fmTF, TBW = this.fmTBW, TA = this.fmTA, key = this.fmKey;
    if (B[B_C1] !== key[0] || B[B_VOWEL] !== key[1] || B[B_RES] !== key[2]) {
      formantTargets(B, fs, TF, TBW, TA);
      key[0] = B[B_C1]; key[1] = B[B_VOWEL]; key[2] = B[B_RES];
    }
    const G = this.fmG, K = this.fmK, GA = this.fmA;
    const inv = 1 / n;
    // input with optional drive saturation: tanh(a·x)/a · (1 + 0.35a)
    const inL = this.tmpL, inR = this.tmpR, accL = this.accL, accR = this.accR;
    const a1 = B[B_DRIVE] * 4;
    const a0 = this.fmD[0] === this.fmD[0] ? this.fmD[0] : a1;
    this.fmD[0] = a1;
    if (a0 > 1e-4 || a1 > 1e-4) {
      let a = a0 > 1e-4 ? a0 : 1e-4; const da = (a1 - a0) * inv;
      for (let i = 0; i < n; i++) {
        const cm = (1 + DRIVE_MAKEUP * a) / a;
        inL[i] = fastTanh(a * bL[off + i]) * cm; inR[i] = fastTanh(a * bR[off + i]) * cm;
        a += da; if (a < 1e-4) a = 1e-4;
      }
    } else {
      for (let i = 0; i < n; i++) { inL[i] = bL[off + i]; inR[i] = bR[off + i]; }
    }
    for (let i = 0; i < n; i++) { accL[i] = 0; accR[i] = 0; }
    const S = this.fmS;
    for (let j = 0; j < NF; j++) {
      const gT = Math.tan(PI * TF[j] / fs), kT = TBW[j] / TF[j], aT = TA[j] * kT; // unity-peak BP × level
      let g, k, ga;
      if (this.fmInit) { g = G[j]; k = K[j]; ga = GA[j]; } else { g = gT; k = kT; ga = aT; }
      const dg = (gT - g) * inv, dk = (kT - k) * inv, da = (aT - ga) * inv;
      G[j] = gT; K[j] = kT; GA[j] = aT;
      const s = j * 4;
      let l1 = S[s], l2 = S[s + 1], r1 = S[s + 2], r2 = S[s + 3];
      for (let i = 0; i < n; i++) {
        g += dg; k += dk; ga += da;
        const c1 = 1 / (1 + g * (g + k)), c2 = g * c1, c3 = g * c2;
        let v3 = inL[i] - l2;
        let v1 = c1 * l1 + c2 * v3, v2 = l2 + c2 * l1 + c3 * v3;
        l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
        accL[i] += ga * v1;
        v3 = inR[i] - r2;
        v1 = c1 * r1 + c2 * v3; v2 = r2 + c2 * r1 + c3 * v3;
        r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
        accR[i] += ga * v1;
      }
      S[s] = flush(l1); S[s + 1] = flush(l2); S[s + 2] = flush(r1); S[s + 3] = flush(r2);
    }
    this.fmInit = true;
    for (let i = 0; i < n; i++) { bL[off + i] = accL[i]; bR[off + i] = accR[i]; }
  }

  // ───────── comb ─────────
  _comb(bL, bR, off, n) {
    const B = this.B, P = this.cP, Sm = this.cSm, Q = this.cQ, fs = this.fs;
    if (this.cbDirty) { this.cbL.fill(0); this.cbR.fill(0); this.cbDirty = false; this.cbW = 0; }
    const c1 = B[B_C1], res = B[B_RES], drive = B[B_DRIVE];
    const fb1 = combFb(res);
    // damping lowpass in the loop: corner rises with the comb pitch (string-like, gentle)
    let fd = c1 * 20; fd = fd < 3000 ? 3000 : fd > 0.42 * fs ? 0.42 * fs : fd;
    const aLp = Math.exp(-2 * PI * fd / fs);
    const R = 1 - 2 * PI * COMB_LOOP_DC / fs, Ri = 1 - 2 * PI * COMB_IN_DC / fs; // DC blockers: loop (0.5 Hz), input (5 Hz)
    Q[0] = c1; Q[1] = fs; Q[2] = aLp; Q[3] = R; Q[4] = this.cbLen;
    combDelay(Q);
    const D1 = Q[5];
    const sat1 = drive * 3, gc1 = Math.sqrt(1 - fb1 * fb1 * 0.93) * (1 + 0.55 * sat1);
    // previous block-end values (glide from them: always continuous)
    const fb0 = Sm[0] === Sm[0] ? Sm[0] : fb1, D0 = Sm[1] === Sm[1] ? Sm[1] : D1;
    const sat0 = Sm[2] === Sm[2] ? Sm[2] : sat1, gc0 = Sm[3] === Sm[3] ? Sm[3] : gc1;
    Sm[0] = fb1; Sm[1] = D1; Sm[2] = sat1; Sm[3] = gc1;
    const inv = 1 / n;
    P[0] = D0; P[1] = D1 === D0 ? 1 : Math.exp(Math.log(D1 / D0) * inv);
    P[2] = fb0; P[3] = (fb1 - fb0) * inv; P[4] = aLp; P[5] = R; P[6] = Ri;
    P[7] = sat0; P[8] = (sat1 - sat0) * inv; P[9] = gc0; P[10] = (gc1 - gc0) * inv;
    const w0 = this.cbW;
    combRun(bL, off, n, this.cbL, this.cbMask, w0, this.cbS, 0, P);
    combRun(bR, off, n, this.cbR, this.cbMask, w0, this.cbS, 5, P);
    this.cbW = (w0 + n) & this.cbMask;
  }
}

/** Smoothstep crossfade progress (sampled per block, ramped linearly inside the block). */
function fadeProgress(pos, len) { if (pos >= len) return 1; const u = pos / len; return u * u * (3 - 2 * u); }

function flush(x) { return x > FLUSH || x < -FLUSH ? x : 0; } // NaN → 0

/**
 * Comb loop delay (samples) for a target pitch, compensating the loop lowpass and DC-blocker phase at the fundamental.
 * Q: [c Hz, fs, aLp, R, bufferLen] → Q[5] = delay.
 */
function combDelay(Q) {
  const fs = Q[1], aLp = Q[2], R = Q[3], len = Q[4];
  let c = Q[0];
  if (c > fs / 3.2) c = fs / 3.2;
  const w = 2 * PI * c / fs, sw = Math.sin(w), cw = Math.cos(w);
  const lpDelay = Math.atan2(aLp * sw, 1 - aLp * cw) / w;                       // one-pole lowpass phase delay
  const hpLead = ((PI - w) * 0.5 - Math.atan2(R * sw, 1 - R * cw)) / w;          // DC blocker phase advance
  let D = fs / c - lpDelay + hpLead;
  if (D < 3) D = 3;
  if (D > len - 8) D = len - 8;
  Q[5] = D;
}

/**
 * SVF kernel coefficients into P[0..13] (g ramp, k ramp, bp-gain ramp, output-weight ramps).
 * X: [g0, g1, 1/n, k0, k1, bp0, bp1, fadeStart, fadeEnd]; A → Bw: output-weight crossfade endpoints.
 */
function svfCoefs(P, X, A, Bw) {
  const g0 = X[0], g1 = X[1], inv = X[2], k0 = X[3], k1 = X[4], bp0 = X[5], bp1 = X[6], pa = X[7], pb = X[8];
  P[0] = g0; P[1] = g1 === g0 ? 1 : Math.exp(Math.log(g1 / g0) * inv);
  P[2] = k0; P[3] = (k1 - k0) * inv; P[4] = bp0; P[5] = (bp1 - bp0) * inv;
  for (let j = 0; j < 4; j++) {
    const a = A[j] + (Bw[j] - A[j]) * pa, b = A[j] + (Bw[j] - A[j]) * pb;
    P[6 + 2 * j] = a; P[7 + 2 * j] = (b - a) * inv;
  }
}

// ───────────────────────── ladder kernels ─────────────────────────
// Transconductance nonlinearity gains t(x) = tanh(x)/x, written as N/D with a = min(x², 3.5²) (branch-free):
//   N = 945 + a(105 + a), D = (945 + a(420 + 15a)) · max(1, |x|/3.5)
//   → [5/4] Padé of tanh for |x| ≤ 3.5 (error ≤ 4e-4 to |x| = 3, 1e-3 at 3.5), and 0.99925/|x| beyond (tanh ≈ ±1 tail),
//   so x·t(x) never exceeds 1 and every stage voltage stays bounded.
// (A [7/6] Padé measured identical in output/aliasing and ~30% slower; the branch-free tail is ~12% faster than an if.)
// Stage gains are only ever needed as TG = t·g = N/(D + fN) and G = D/(D + fN) → one division per stage.
// Structure (per tick, after Teemu Voipio's "cheap non-linear zero-delay" ladder): nonlinear gains are evaluated at the
// previous states (input stage at the half-sample-delayed input), then the resulting *linear* ZDF system is solved
// exactly for the 4th-stage output y3, so the feedback loop has no unit delay (correct tuning & resonance at any fc).
const TQ = 3.5 * 3.5, INV_XC = 1 / 3.5;

/** 2× polyphase upsampler (one channel) with the input gain ramp P[8], P[9] → out[0 .. 2n). */
function upsample2(buf, off, n, st, so, out, P) {
  let gin = P[8]; const dgin = P[9];
  let p0 = st[so], a1s = st[so + 1], a2s = st[so + 2], a3s = st[so + 3], b1s = st[so + 4], b2s = st[so + 5], b3s = st[so + 6];
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const x = buf[off + i] * gin; gin += dgin;
    const a1 = HB0 * (x - a1s) + p0, a2 = HB2 * (a1 - a2s) + a1s, a3 = HB4 * (a2 - a3s) + a2s;
    const b1 = HB1 * (x - b1s) + p0, b2 = HB3 * (b1 - b2s) + b1s, b3 = HB5 * (b2 - b3s) + b2s;
    p0 = x; a1s = a1; a2s = a2; a3s = a3; b1s = b1; b2s = b2; b3s = b3;
    out[j] = a3; out[j + 1] = b3;
  }
  st[so] = flush(p0); st[so + 1] = flush(a1s); st[so + 2] = flush(a2s); st[so + 3] = flush(a3s);
  st[so + 4] = flush(b1s); st[so + 5] = flush(b2s); st[so + 6] = flush(b3s);
}

/** 2× polyphase decimator (one channel) with the output gain ramp P[10], P[11]: inp[0 .. 2n) → buf[off .. off+n). */
function downsample2(inp, buf, off, n, st, so, P) {
  let gout = P[10]; const dgout = P[11];
  let a0 = st[so], a1s = st[so + 1], a2s = st[so + 2], a3s = st[so + 3], b0 = st[so + 4], b1s = st[so + 5], b2s = st[so + 6], b3s = st[so + 7];
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const ya = inp[j], yb = inp[j + 1];
    // path A takes the odd (2nd) sample, path B the even (1st)
    const c1 = HB0 * (yb - a1s) + a0, c2 = HB2 * (c1 - a2s) + a1s, c3 = HB4 * (c2 - a3s) + a2s;
    a0 = yb; a1s = c1; a2s = c2; a3s = c3;
    const e1 = HB1 * (ya - b1s) + b0, e2 = HB3 * (e1 - b2s) + b1s, e3 = HB5 * (e2 - b3s) + b2s;
    b0 = ya; b1s = e1; b2s = e2; b3s = e3;
    buf[off + i] = 0.5 * (c3 + e3) * gout; gout += dgout;
  }
  st[so] = flush(a0); st[so + 1] = flush(a1s); st[so + 2] = flush(a2s); st[so + 3] = flush(a3s);
  st[so + 4] = flush(b0); st[so + 5] = flush(b1s); st[so + 6] = flush(b2s); st[so + 7] = flush(b3s);
}

/**
 * Stereo nonlinear ZDF ladder over m ticks, in place on xl/xr[0..m). L and R are interleaved in one loop so the two
 * independent dependency chains overlap (≈2× throughput in V8). Output = w4·y4 + w2·y2 (4-pole / 2-pole taps).
 * P: [g, g-ratio per tick, k, dk, w4, dw4, w2, dw2].
 */
function ladderStereo(xl, xr, m, st, P) {
  let g = P[0], k = P[2], w4 = P[4], w2 = P[6];
  const gr = P[1], dk = P[3], dw4 = P[5], dw2 = P[7];
  let a0 = st[0], a1 = st[1], a2 = st[2], a3 = st[3], az = st[4];
  let b0 = st[5], b1 = st[6], b2 = st[7], b3 = st[8], bz = st[9];
  for (let i = 0; i < m; i++) {
    g *= gr;
    const f = g, f2 = f + f;
    { // ── left ──
      const xin = xl[i];
      const u = 0.5 * (xin + az) - k * a3; az = xin;
      let q = Math.min(u * u, TQ);
      const t0 = (945 + q * (105 + q)) / ((945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(u) * INV_XC));
      q = Math.min(a0 * a0, TQ);
      let N = 945 + q * (105 + q), D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(a0) * INV_XC);
      let iv = 1 / (D + f * N); const TG1 = N * iv;
      q = Math.min(a1 * a1, TQ);
      N = 945 + q * (105 + q); D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(a1) * INV_XC);
      iv = 1 / (D + f * N); const TG2 = N * iv, G2 = D * iv;
      q = Math.min(a2 * a2, TQ);
      N = 945 + q * (105 + q); D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(a2) * INV_XC);
      iv = 1 / (D + f * N); const TG3 = N * iv;
      q = Math.min(a3 * a3, TQ);
      N = 945 + q * (105 + q); D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(a3) * INV_XC);
      iv = 1 / (D + f * N); const TG4 = N * iv, G4 = D * iv;
      const c2 = G4 * (f * TG3), c1 = c2 * (f * TG2), c0 = c1 * (f * TG1), ci = c0 * (f * t0); // short dependency chain
      const y3 = (G4 * a3 + c2 * a2 + c1 * a1 + c0 * a0 + ci * xin) / (1 + k * ci);
      const xx = t0 * (xin - k * y3);
      const Y0 = TG1 * (a0 + f * xx);
      const m1 = a1 + f * Y0;
      const Y1 = TG2 * m1;
      const Y2 = TG3 * (a2 + f * Y1);
      const t4y3 = TG4 * (a3 + f * Y2);
      a0 += f2 * (xx - Y0); a1 += f2 * (Y0 - Y1); a2 += f2 * (Y1 - Y2); a3 += f2 * (Y2 - t4y3);
      xl[i] = w4 * y3 + w2 * G2 * m1;
    }
    { // ── right ──
      const xin = xr[i];
      const u = 0.5 * (xin + bz) - k * b3; bz = xin;
      let q = Math.min(u * u, TQ);
      const t0 = (945 + q * (105 + q)) / ((945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(u) * INV_XC));
      q = Math.min(b0 * b0, TQ);
      let N = 945 + q * (105 + q), D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(b0) * INV_XC);
      let iv = 1 / (D + f * N); const TG1 = N * iv;
      q = Math.min(b1 * b1, TQ);
      N = 945 + q * (105 + q); D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(b1) * INV_XC);
      iv = 1 / (D + f * N); const TG2 = N * iv, G2 = D * iv;
      q = Math.min(b2 * b2, TQ);
      N = 945 + q * (105 + q); D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(b2) * INV_XC);
      iv = 1 / (D + f * N); const TG3 = N * iv;
      q = Math.min(b3 * b3, TQ);
      N = 945 + q * (105 + q); D = (945 + q * (420 + 15 * q)) * Math.max(1, Math.abs(b3) * INV_XC);
      iv = 1 / (D + f * N); const TG4 = N * iv, G4 = D * iv;
      const c2 = G4 * (f * TG3), c1 = c2 * (f * TG2), c0 = c1 * (f * TG1), ci = c0 * (f * t0);
      const y3 = (G4 * b3 + c2 * b2 + c1 * b1 + c0 * b0 + ci * xin) / (1 + k * ci);
      const xx = t0 * (xin - k * y3);
      const Y0 = TG1 * (b0 + f * xx);
      const m1 = b1 + f * Y0;
      const Y1 = TG2 * m1;
      const Y2 = TG3 * (b2 + f * Y1);
      const t4y3 = TG4 * (b3 + f * Y2);
      b0 += f2 * (xx - Y0); b1 += f2 * (Y0 - Y1); b2 += f2 * (Y1 - Y2); b3 += f2 * (Y2 - t4y3);
      xr[i] = w4 * y3 + w2 * G2 * m1;
    }
    k += dk; w4 += dw4; w2 += dw2;
  }
  st[0] = flush(a0); st[1] = flush(a1); st[2] = flush(a2); st[3] = flush(a3); st[4] = flush(az);
  st[5] = flush(b0); st[6] = flush(b1); st[7] = flush(b2); st[8] = flush(b3); st[9] = flush(bz);
}

// ───────────────────────── SVF kernel (stereo) ─────────────────────────
/**
 * Simper/Cytomic trapezoidal SVF, L and R in one loop. out = m0·x + (mb·bpGain − m1·k)·band + m2·low.
 * P: [g, g-ratio, k, dk, bp, dbp, m0, dm0, m1, dm1, mb, dmb, m2, dm2, a (0 = no drive), da, T, 1/T].
 */
function svfRun(bL, bR, off, n, st, P) {
  let g = P[0], k = P[2], bp = P[4], m0 = P[6], m1 = P[8], mb = P[10], m2 = P[12], a = P[14];
  const gr = P[1], dk = P[3], dbp = P[5], dm0 = P[7], dm1 = P[9], dmb = P[11], dm2 = P[13], da = P[15];
  const T = P[16], invW = P[17], drv = a > 0;
  let l1 = st[0], l2 = st[1], r1 = st[2], r2 = st[3];
  for (let i = off, end = off + n; i < end; i++) {
    g *= gr;
    const c1 = 1 / (1 + g * (g + k)), c2 = g * c1, c3 = g * c2;
    let xL = bL[i], xR = bR[i];
    if (drv) { // tanh(a·x)/a · (1 + 0.35a): identity as a → 0, loudness-compensated when driven
      const cm = (1 + DRIVE_MAKEUP * a) / a;
      xL = fastTanh(a * xL) * cm; xR = fastTanh(a * xR) * cm;
      a += da; if (a < 1e-4) a = 1e-4;
    }
    const cb = mb * bp - m1 * k;
    // left
    let v3 = xL - l2;
    let v1 = c1 * l1 + c2 * v3, v2 = l2 + c2 * l1 + c3 * v3;
    l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
    if (l1 > T) { const d = l1 - T; l1 = T + d / (1 + d * invW); } else if (l1 < -T) { const d = -l1 - T; l1 = -T - d / (1 + d * invW); }
    bL[i] = m0 * xL + cb * v1 + m2 * v2;
    // right
    v3 = xR - r2;
    v1 = c1 * r1 + c2 * v3; v2 = r2 + c2 * r1 + c3 * v3;
    r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
    if (r1 > T) { const d = r1 - T; r1 = T + d / (1 + d * invW); } else if (r1 < -T) { const d = -r1 - T; r1 = -T - d / (1 + d * invW); }
    bR[i] = m0 * xR + cb * v1 + m2 * v2;
    k += dk; bp += dbp; m0 += dm0; m1 += dm1; mb += dmb; m2 += dm2;
  }
  st[0] = flush(l1); st[1] = flush(l2); st[2] = flush(r1); st[3] = flush(r2);
}

// ───────────────────────── comb kernel (one channel) ─────────────────────────
/** P: [D, D-ratio, fb, dfb, aLp, R (loop DC), Ri (input DC), sat, dsat, gc, dgc]. st[so..so+4]: lp, hx, hy, ix, iy. */
function combRun(buf, off, n, line, mask, w, st, so, P) {
  let D = P[0], fb = P[2], sat = P[7], gc = P[9];
  const dr = P[1], dfb = P[3], aLp = P[4], R = P[5], Ri = P[6], dsat = P[8], dgc = P[10];
  let lp = st[so], hx = st[so + 1], hy = st[so + 2], ix = st[so + 3], iy = st[so + 4];
  const bLp = 1 - aLp;
  for (let i = off, end = off + n; i < end; i++) {
    D *= dr;
    const rp = w - D;
    const ip = Math.floor(rp);
    const fr = rp - ip;
    const d = hermite(line[(ip - 1) & mask], line[ip & mask], line[(ip + 1) & mask], line[(ip + 2) & mask], fr);
    lp += bLp * (d - lp);
    const hp = lp - hx + R * hy; hx = lp; hy = hp;
    const xi = buf[i], xh = xi - ix + Ri * iy; ix = xi; iy = xh; // input DC blocker (outside the loop: no dispersion)
    let y = xh + fb * hp;
    if (sat > 1e-4) y = fastTanh(sat * y) / sat;
    // safety knee: identity below 2, soft ceiling at 4
    if (y > 2) { const e = y - 2; y = 2 + e / (1 + e * 0.5); } else if (y < -2) { const e = -y - 2; y = -2 - e / (1 + e * 0.5); }
    if (!(y > -4.5 && y < 4.5)) y = 0; // NaN/Inf guard (never let them into the delay line)
    else if (y < 1e-20 && y > -1e-20) y = 0; // flush tiny values (no subnormals in the Float32 line)
    line[w] = y;
    w = (w + 1) & mask;
    buf[i] = y * gc;
    fb += dfb; sat += dsat; gc += dgc;
  }
  st[so] = flush(lp); st[so + 1] = flush(hx); st[so + 2] = flush(hy); st[so + 3] = flush(ix); st[so + 4] = flush(iy);
}

// ───────────────────────── SVFilter (generic, stereo) ─────────────────────────
export class SVFilter {
  constructor(sampleRate) {
    this.fs = sampleRate;
    this.st = new Float64Array(4);
    this.xfLen = Math.max(32, Math.round(0.005 * sampleRate));
    this.wa = new Float64Array(4); this.wb = new Float64Array(4);
    this.P = new Float64Array(20);
    this.X = new Float64Array(9);
    this.S = new Float64Array(3);  // smoothing [g, k, bp]
    this.G = new Float64Array(2);  // tan cache [cutoff, g]
    this.inp = new Float64Array(2); // run() inputs: [cutoff, res]
    this.reset();
  }
  reset() {
    this.st.fill(0);
    this.mode = -1; this.pos = 1 << 30;
    this.S.fill(NaN); this.G[0] = -1;
  }
  /**
   * In place on bufL/bufR[offset..offset+n). mode: 0 lp, 1 hp, 2 bp, 3 notch. cutoff Hz, res 0..1 (Q 0.5..25).
   * Cutoff/res glide from the previous call's values across the block; mode changes crossfade over 5 ms.
   */
  process(bufL, bufR, offset, n, mode, cutoff, res) {
    const I = this.inp;
    I[0] = cutoff; I[1] = res;
    this.run(bufL, bufR, offset, n, mode);
  }

  /** process() with cutoff / res read from this.inp = [cutoff, res] (allocation-free entry point). */
  run(bufL, bufR, offset, n, mode) {
    if (n <= 0) return;
    const fs = this.fs, S = this.S, G = this.G, P = this.P;
    const cutoff = this.inp[0], res = this.inp[1];
    let m = (mode + 0.5) | 0; if (m < 0 || m > 3) m = 0;
    const row = SVF_WEIGHTS[SVF2_MODE_ROW[m]];
    const A = this.wa, Bw = this.wb;
    if (this.mode < 0) { for (let i = 0; i < 4; i++) A[i] = Bw[i] = row[i]; this.pos = 1 << 30; }
    else if (m !== this.mode) {
      const p = fadeProgress(this.pos, this.xfLen);
      for (let i = 0; i < 4; i++) { A[i] = A[i] + (Bw[i] - A[i]) * p; Bw[i] = row[i]; }
      this.pos = 0;
    }
    this.mode = m;
    const c = clampCut(cutoff, fs);
    const g1 = c === G[0] ? G[1] : Math.tan(PI * c / fs);
    G[0] = c; G[1] = g1;
    const k1 = svfK(clamp01(res)), bp1 = svfBpGain(k1);
    const g0 = S[0] === S[0] ? S[0] : g1, k0 = S[1] === S[1] ? S[1] : k1, bp0 = S[2] === S[2] ? S[2] : bp1;
    S[0] = g1; S[1] = k1; S[2] = bp1;
    const L = this.xfLen;
    const pa = fadeProgress(this.pos, L), pb = fadeProgress(this.pos + n, L);
    this.pos = this.pos < L ? this.pos + n : L;
    const X = this.X;
    X[0] = g0; X[1] = g1; X[2] = 1 / n; X[3] = k0; X[4] = k1; X[5] = bp0; X[6] = bp1; X[7] = pa; X[8] = pb;
    svfCoefs(P, X, A, Bw);
    P[14] = 0; P[15] = 0; P[16] = 3; P[17] = 1 / 3;
    svfRun(bufL, bufR, offset, n, this.st, P);
  }
}

// ───────────────────────── filterResponse (UI) ─────────────────────────
/**
 * Magnitude response in dB at the given frequencies (Hz). type: FILTER_TYPES index or id string.
 * Analytic (small-signal) response of the exact digital structures used above; the self-oscillating
 * ladder is displayed as a tall finite peak. Output clamped to [-120, +40] dB.
 */
export function filterResponse(type, cutoff, res, drive, vowel, freqs, sampleRate = 48000) {
  const t = typeof type === 'string' ? Math.max(0, FILTER_TYPES.indexOf(type)) : ((type + 0.5) | 0);
  const fs = sampleRate;
  const N = freqs.length;
  const out = new Float32Array(N);
  res = clamp01(res); drive = clamp01(drive); vowel = clamp01(vowel);
  const c = clampCut(cutoff, fs);
  const nyq = fs * 0.5;
  const toDb = m => { const d = 20 * Math.log10(m + 1e-12); return d < -120 ? -120 : d > 40 ? 40 : d; };
  if (t === 0 || t === 1) {
    const os = fs >= 88200 ? 1 : 2, fsI = fs * os;
    let k = ladderK(res);
    // saturation limits the effective resonance with drive; self-oscillation shown as a finite peak
    k = k / (1 + 0.35 * drive);
    if (k > 3.96) k = 3.96;
    const comp = 1 + LADDER_BASS_COMP * ladderK(res);
    const gc = Math.tan(PI * c / fsI);
    for (let i = 0; i < N; i++) {
      const f = freqs[i];
      if (!(f > 0) || f >= nyq) { out[i] = -120; continue; }
      const W = Math.tan(PI * f / fsI) / gc;
      // G = 1/(1 + jW); G^2, G^4
      const d = 1 + W * W, gr = 1 / d, gi = -W / d;
      const g2r = gr * gr - gi * gi, g2i = 2 * gr * gi;
      const g4r = g2r * g2r - g2i * g2i, g4i = 2 * g2r * g2i;
      const dr = 1 + k * g4r, di = k * g4i, dm = Math.hypot(dr, di);
      const num = t === 0 ? Math.hypot(g4r, g4i) : Math.hypot(g2r, g2i) * ladder12Gain(ladderK(res));
      out[i] = toDb(comp * num / dm);
    }
    return out;
  }
  if (t >= 2 && t <= 5) {
    const k = svfK(res), bp = svfBpGain(k), gc = Math.tan(PI * c / fs);
    for (let i = 0; i < N; i++) {
      const f = freqs[i];
      if (!(f > 0) || f >= nyq) { out[i] = -120; continue; }
      const W = Math.tan(PI * f / fs) / gc;
      const dr = 1 - W * W, di = k * W, dm = Math.hypot(dr, di);
      let m;
      if (t === 2) m = 1 / dm;
      else if (t === 3) m = bp * W / dm;
      else if (t === 4) m = W * W / dm;
      else m = Math.abs(1 - W * W) / dm;
      out[i] = toDb(m);
    }
    return out;
  }
  if (t === 6) {
    const F = new Float64Array(NF), BW = new Float64Array(NF), A = new Float64Array(NF);
    const Bp = new Float64Array(8); Bp[B_C1] = c; Bp[B_RES] = res; Bp[B_VOWEL] = vowel;
    formantTargets(Bp, fs, F, BW, A);
    const gcs = new Float64Array(NF);
    for (let j = 0; j < NF; j++) gcs[j] = Math.tan(PI * F[j] / fs);
    for (let i = 0; i < N; i++) {
      const f = freqs[i];
      if (!(f > 0) || f >= nyq) { out[i] = -120; continue; }
      const tf = Math.tan(PI * f / fs);
      let hr = 0, hi = 0;
      for (let j = 0; j < NF; j++) {
        const k = BW[j] / F[j], W = tf / gcs[j];
        // unity-peak BP: jkW / (1 − W² + jkW)
        const dr = 1 - W * W, di = k * W, d2 = dr * dr + di * di;
        const nr = 0, ni = k * W;
        hr += A[j] * (nr * dr + ni * di) / d2;
        hi += A[j] * (ni * dr - nr * di) / d2;
      }
      out[i] = toDb(Math.hypot(hr, hi));
    }
    return out;
  }
  // comb
  const fb = combFb(res);
  let fd = c * 20; fd = fd < 3000 ? 3000 : fd > 0.42 * fs ? 0.42 * fs : fd;
  const aLp = Math.exp(-2 * PI * fd / fs), R = 1 - 2 * PI * COMB_LOOP_DC / fs, Ri = 1 - 2 * PI * COMB_IN_DC / fs;
  let len = 1; while (len < Math.ceil(fs / 20 * 1.1) + 16) len <<= 1;
  const Q = new Float64Array(8); Q[0] = c; Q[1] = fs; Q[2] = aLp; Q[3] = R; Q[4] = len;
  combDelay(Q);
  const D = Q[5];
  const gc = Math.sqrt(1 - fb * fb * 0.93) * (1 + 0.55 * drive * 3);
  for (let i = 0; i < N; i++) {
    const f = freqs[i];
    if (!(f > 0) || f >= nyq) { out[i] = -120; continue; }
    const w = 2 * PI * f / fs, cw = Math.cos(w), sw = Math.sin(w);
    // loop: fb · LP(z) · HP(z) · z^-D
    const lpDr = 1 - aLp * cw, lpDi = aLp * sw, lpD2 = lpDr * lpDr + lpDi * lpDi;
    const lpr = (1 - aLp) * lpDr / lpD2, lpi = -(1 - aLp) * lpDi / lpD2;
    const hnR = 1 - cw, hnI = sw, hdR = 1 - R * cw, hdI = R * sw, hd2 = hdR * hdR + hdI * hdI;
    const hpr = (hnR * hdR + hnI * hdI) / hd2, hpi = (hnI * hdR - hnR * hdI) / hd2;
    let lr = lpr * hpr - lpi * hpi, li = lpr * hpi + lpi * hpr;
    const ph = -w * D, zr = Math.cos(ph), zi = Math.sin(ph);
    const tr = (lr * zr - li * zi) * fb, ti = (lr * zi + li * zr) * fb;
    const dr = 1 - tr, di = -ti;
    const inHp = Math.hypot(1 - cw, sw) / Math.hypot(1 - Ri * cw, Ri * sw);
    out[i] = toDb(gc * inHp / Math.hypot(dr, di));
  }
  return out;
}
