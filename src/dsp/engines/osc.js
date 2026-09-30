// AURORA 極光 — classic VA + wavetable oscillator (osc1 / osc2).
//
// Pure ES module (AudioWorklet + Node). No allocation in the audio path. Deterministic (util.js Rng).
//
// ── Anti-aliasing: linear-phase table BLEP / BLAMP with an output accumulator ──────────────────────────────
// Every unison voice writes its naive (trivial) waveform sample into a small stereo accumulator; every
// discontinuity (saw reset, pulse edges, sync resets) adds a band-limited-step residual and every slope break
// (triangle corners, sync resets) a band-limited-ramp residual, placed at the exact sub-sample event time and
// spread over 32 taps (±16 samples) of a Kaiser-windowed sinc (cutoff = Nyquist, β = 9). Output is read 16
// samples late (0.33 ms @ 48 kHz), so residuals can reach both sides of the event. This equals filtering the
// ideal continuous waveform with a 32-tap brick-wall kernel: passband flat to ≈ 0.42·fs, aliases that would
// land below ≈ 0.42·fs suppressed by ≈ 90 dB (measured: every alias of a 1–5 kHz saw/pulse/tri < −94 dBFS).
// Because residuals are linear, all unison voices (with their own pan gains) share one accumulator; a
// discontinuity costs ~64 multiply-adds, so low notes are nearly free and a 5 kHz saw is still cheap.
//
// Classic shapes (phase-aligned so crossfades never cancel the fundamental):
//   sine  sin(2πp) · triangle (0 → +1 @¼ → −1 @¾) · saw 1 − 2p (falling, reset to +1) · pulse +/− (DC-free)
//   shape 0 → ⅓ → ⅔ → 1 crossfades neighbours; weights, pw, gains are ramped per sample (no zipper/clicks);
//   pulse edges are found analytically even while pw moves (p − pw crossing), so PWM is click- and alias-free.
// Hard sync: slave = f·2^(4·sync) reset by a virtual master at f. Every reset is band-limited at its exact
//   sub-sample time with residuals for the jumps in value, slope, 2nd and 3rd derivative (the last two matter
//   for sine / wavetable slaves); waveform-internal events are handled on both sides of the reset. A DC blocker
//   (3.5 Hz) removes the DC that synced waveforms carry.
// Wavetable: 64-frame tables (wavetables.js), 4-point cubic Hermite within 8×–64× oversampled per-octave mips,
//   linear frame crossfade; mip = richest level whose top harmonic stays below fs − 15 kHz (aliases can only
//   land above 15 kHz; synced: ≤ 0.33·fs so the reset residuals converge), level changes crossfade over one
//   block. Sync works in wavetable mode too.
// Unison 1–8: JP-8000-style irregular voice spacing, nonlinear detune curve (0..1 → ±50 ct outer voices),
//   blend (centre vs side voices), alternating stereo spread, power normalisation 1/√Σg², per-voice analog drift
//   (smoothed random walk, ≈0.1–1 Hz, drift 1 ≈ ±8 ct). Phase modes: free / reset (fixed spread pattern, centre
//   voice at 0) / random. Parameter changes reach the output with the accumulator latency (16 samples).
// Retriggers in reset/random mode crossfade (16 samples) from the old waveform; a fresh note starts exactly on
//   the note-on sample at the chosen phase (the accumulator latency is pre-rolled).

import { idx } from '../params.js';
import { Rng } from '../util.js';
import {
  ensureAllWavetables, getWavetable, WT_FRAMES, WT_LEVELS, WT_LEVEL_SIZE, WT_LEVEL_STRIDE, WT_LEVEL_BASE,
  WT_HARMONICS, WT_GUARD_PRE,
} from './wavetables.js';

// ───────────────────────── BLEP / BLAMP tables ─────────────────────────

const BK = 16;          // half-width (samples) = output latency
const BW = 2 * BK;      // taps
const BR = 64;          // sub-sample resolution (rows), linear interpolation between rows
const BLEP = new Float64Array((BR + 1) * BW);
const BLAMP = new Float64Array((BR + 1) * BW);
const BLAMP2 = new Float64Array((BR + 1) * BW); // 2nd-derivative jump residual (sync of curved shapes)
const BLAMP3 = new Float64Array((BR + 1) * BW); // 3rd-derivative jump residual

function besselI0(x) {
  let s = 1, t = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 200; k++) {
    t *= q / (k * k);
    s += t;
    if (t < 1e-17 * s) break;
  }
  return s;
}

(function buildBlepTables() {
  const OS = 16;                    // integration points per row step
  const step = 1 / (BR * OS);       // grid step in samples
  const M = BW * BR * OS;           // grid intervals over [−BK, BK]
  const FC = 0.5, BETA = 9;
  const i0b = besselI0(BETA);
  const h = new Float64Array(M + 1);
  for (let i = 0; i <= M; i++) {
    const t = -BK + i * step;
    const x = 2 * FC * t;
    const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = t / BK;
    h[i] = 2 * FC * sinc * (besselI0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b);
  }
  const c = new Float64Array(M + 1);
  for (let i = 1; i <= M; i++) c[i] = c[i - 1] + 0.5 * step * (h[i - 1] + h[i]);
  const tot = c[M];
  const zero = BK * BR * OS;        // grid index of t = 0
  const res = new Float64Array(M + 1);   // band-limited step − naive step (naive = 1 at t ≥ 0)
  for (let i = 0; i <= M; i++) res[i] = c[i] / tot - (i >= zero ? 1 : 0);
  const ramp = new Float64Array(M + 1);  // ∫ res  (band-limited ramp − naive ramp)
  for (let i = 1; i <= M; i++) {
    const right = i === zero ? res[i] + 1 : res[i]; // left limit at the jump
    ramp[i] = ramp[i - 1] + 0.5 * step * (res[i - 1] + right);
  }
  const ramp2 = new Float64Array(M + 1); // ∫∫ res (band-limited t²/2 − naive)
  for (let i = 1; i <= M; i++) ramp2[i] = ramp2[i - 1] + 0.5 * step * (ramp[i - 1] + ramp[i]);
  const ramp3 = new Float64Array(M + 1); // ∫∫∫ res (band-limited t³/6 − naive)
  for (let i = 1; i <= M; i++) ramp3[i] = ramp3[i - 1] + 0.5 * step * (ramp2[i - 1] + ramp2[i]);
  // The windowed kernel has a tiny non-zero 2nd moment, so the band-limited t²/2 and t³/6 do not converge
  // to the naive ones beyond the window (tails c2 and c2·t). Subtract c2 × (band-limited step / ramp) — both
  // band-limited — so every residual is exactly finite-support.
  const c2 = ramp2[M];
  for (let r = 0; r <= BR; r++) {
    for (let t = 0; t < BW; t++) {
      const i = t * BR * OS + r * OS; // time = (t − BK) + r/BR
      const time = t - BK + r / BR;
      const post = t >= BK;           // the naive part belongs to the tap: samples before the event never
      //                                 contain it, even at d = 1 (left limit of the residual)
      const bstep = c[i] / tot;       // band-limited unit step
      BLEP[r * BW + t] = bstep - (post ? 1 : 0);
      BLAMP[r * BW + t] = ramp[i];
      BLAMP2[r * BW + t] = ramp2[i] - c2 * bstep;
      BLAMP3[r * BW + t] = ramp3[i] - c2 * (ramp[i] + (post ? time : 0));
    }
  }
})();

// ───────────────────────── other constants ─────────────────────────

const SIN_N = 2048;
const SINT = new Float64Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SINT[i] = Math.sin((2 * Math.PI * i) / SIN_N);

const XFADE = Float64Array.from({ length: BK }, (_, i) => 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / BK));

const MAXU = 8;
const MAXB = 128;                  // largest block rendered in one go (longer calls are split)
const BUFN = 2 * BK + MAXB;
const DPMAX = 0.49;                // max phase increment (cycles/sample)
const LAMBDA_SYNC = 0.33;         // mip limit for synced wavetables (see _update)
const DPMAX_SYNC = 0.42;           // max synced-slave increment (keeps the slave inside the BLEP passband)
const LN2 = Math.LN2;
const FM2 = WT_FRAMES - 2;
const TOPH = WT_HARMONICS;

// Unison voice detune positions (−1..1, outer voice = ±1). N = 7 uses the JP-8000 ratios; others are
// hand-made irregular spacings (no periodic beating pattern).
const UNI_OFF = [
  [0],
  [-1, 1],
  [-1, 0, 1],
  [-1, -0.33, 0.35, 0.98],
  [-1, -0.45, 0, 0.47, 0.97],
  [-1, -0.6, -0.2, 0.19, 0.58, 0.98],
  [-1, -0.5716, -0.1774, 0, 0.181, 0.565, 0.9766],
  [-1, -0.68, -0.39, -0.12, 0.14, 0.42, 0.7, 0.97],
].map(a => Float64Array.from(a));
// Stereo positions: opposite detunes on opposite sides, each side gets sharp and flat voices.
const UNI_PAN = [
  [0],
  [-1, 1],
  [-1, 0, 1],
  [-1, 0.33, -0.33, 1],
  [-1, 0.5, 0, -0.5, 1],
  [-1, 0.6, -0.2, 0.2, -0.6, 1],
  [-1, 0.67, -0.33, 0, 0.33, -0.67, 1],
  [-1, 0.71, -0.43, 0.14, -0.14, 0.43, -0.71, 1],
].map(a => Float64Array.from(a));

/** Supersaw-style nonlinear detune curve: slow start, accelerating top (0..1 → 0..1). */
function detuneCurve(x) { return 0.6 * Math.pow(x, 1.3) + 0.4 * x * x * x; }
const DETUNE_MAX_CENTS = 50;
const DRIFT_CENTS = 8;

function clamp01(x) { return x > 0 ? (x < 1 ? x : 1) : 0; }

function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Wavetable read: frames at o and o+S (y(0) positions), crossfade ff, 4-point cubic Hermite at fraction f.
 * Values are raw int16 units (the caller folds the table scale into its gains).
 */
function wtRead(D, o, S, ff, f) {
  let a = D[o - 1];
  const ym1 = a + ff * (D[o - 1 + S] - a);
  a = D[o];
  const y0 = a + ff * (D[o + S] - a);
  a = D[o + 1];
  const y1 = a + ff * (D[o + 1 + S] - a);
  a = D[o + 2];
  const y2 = a + ff * (D[o + 2 + S] - a);
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * f + c2) * f + c1) * f + y0;
}

/**
 * Hermite value and derivatives (per table sample) at o + f → out[0..3] = y, y′, y″, y‴.
 * Inputs: out[0] = frame fraction ff, out[1] = sample fraction f (passed in the array: no boxed doubles).
 */
function wtDerivs(D, o, S, out) {
  const ff = out[0], f = out[1];
  let a = D[o - 1];
  const ym1 = a + ff * (D[o - 1 + S] - a);
  a = D[o];
  const y0 = a + ff * (D[o + S] - a);
  a = D[o + 1];
  const y1 = a + ff * (D[o + 1 + S] - a);
  a = D[o + 2];
  const y2 = a + ff * (D[o + 2 + S] - a);
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  out[0] = ((c3 * f + c2) * f + c1) * f + y0;
  out[1] = (3 * c3 * f + 2 * c2) * f + c1;
  out[2] = 6 * c3 * f + 2 * c2;
  out[3] = 6 * c3;
}

// ───────────────────────── engine ─────────────────────────

export class OscEngine {
  /**
   * @param {number} sampleRate
   * @param {'osc1'|'osc2'} prefix
   * @param {number} [seed] optional extra seed (e.g. voice index) — decorrelates free-running phases/drift
   */
  constructor(sampleRate, prefix = 'osc1', seed = 0) {
    this.sr = sampleRate;
    this.prefix = prefix;
    ensureAllWavetables(); // module-level cache, generated once (~0.1 s), shared by all engines
    this.iMode = idx(`${prefix}.mode`);
    this.iShape = idx(`${prefix}.shape`);
    this.iTable = idx(`${prefix}.table`);
    this.iPw = idx(`${prefix}.pw`);
    this.iSync = idx(`${prefix}.sync`);
    this.iOct = idx(`${prefix}.oct`);
    this.iSemi = idx(`${prefix}.semi`);
    this.iFine = idx(`${prefix}.fine`);
    this.iUni = idx(`${prefix}.unison`);
    this.iDet = idx(`${prefix}.detune`);
    this.iSpread = idx(`${prefix}.spread`);
    this.iBlend = idx(`${prefix}.blend`);
    this.iPhase = idx(`${prefix}.phase`);
    this.iDrift = idx(`${prefix}.drift`);

    this.seed = hash32((strHash(prefix) ^ Math.imul((seed | 0) + 1, 0x9e3779b1)) >>> 0) || 1;
    this.rng = new Rng(this.seed);
    this.noteCount = 0;

    this.bufL = new Float64Array(BUFN);
    this.bufR = new Float64Array(BUFN);
    this.xfL = new Float64Array(BK);
    this.xfR = new Float64Array(BK);

    // per unison voice
    this.ph = new Float64Array(MAXU);   // slave / main phase 0..1
    this.mph = new Float64Array(MAXU);  // virtual master phase (sync)
    this.dp = new Float64Array(MAXU);   // slave increment (cycles/sample)
    this.dm = new Float64Array(MAXU);   // master increment
    this.gLp = new Float64Array(MAXU); this.gRp = new Float64Array(MAXU); // gains at block start
    this.gLt = new Float64Array(MAXU); this.gRt = new Float64Array(MAXU); // gains at block end
    this.lvl = new Int32Array(MAXU);    // wavetable mip level at block start
    this.lvlT = new Int32Array(MAXU);   // … at block end
    this.dX = new Float64Array(MAXU);   // drift (smoothed, −1..1)
    this.dY = new Float64Array(MAXU);
    this.dT = new Float64Array(MAXU);
    this.dCnt = new Float64Array(MAXU); // samples until next drift target

    // shape weights [sine, tri, saw, pulse] at block start / end, pw, wavetable frame position
    this.w0 = new Float64Array(4); this.w1 = new Float64Array(4);
    this.pw0 = 0.5; this.pw1 = 0.5;
    this.pos0 = 0; this.pos1 = 0;

    this.mode = 0;
    this.nAct = 1;
    this.syncOn = false;
    this.tabIdx = -1;
    this.tab = null;
    this.wtData = null;
    this.wtScale = 0;
    this.dA = new Float64Array(4); // wavetable derivative scratch (sync)
    this.dB = new Float64Array(4);
    // argument blocks for the sync-reset helpers (numeric arguments to non-inlined calls would be boxed)
    this.sg = new Float64Array(12); // _seg: [a, b, dEnd, dp, pwA, pwB, wt, ww, wq, gl, gr] → [11] = wrapped end phase
    this.rs = new Float64Array(7);  // _reset: [d, gl, gr, c0, c1, c2, c3]
    this.ev = new Float64Array(3);  // _blep / _blamp: [d, aL, aR]
    // wavetable mip limit (top harmonic ≤ λ·fs). Synced wavetables use LAMBDA_SYNC: the slave's partials stay
    // well below Nyquist so the reset residuals (up to 3rd order) converge; the resets supply the bright edge.
    this.lambda = Math.min(0.85, Math.max(0.5, 1 - 15000 / sampleRate));

    // gain cache
    this.gN = -1; this.gBlend = -1; this.gSpread = -1;

    // DC blocker (sync waveforms carry DC) ~3.5 Hz
    this.dcR = 1 - (2 * Math.PI * 3.5) / sampleRate;
    this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;

    this.fresh = true;
    this.preroll = 0;
    this.phaseSet = false;
    this.freqIn = 261.6255653005986; // voice pitch (Hz) used by render()
    this._initState();
  }

  _initState() {
    const r = this.rng;
    for (let u = 0; u < MAXU; u++) {
      const p = r.next();
      this.ph[u] = p; this.mph[u] = p;
      const t = r.bipolar();
      this.dT[u] = t; this.dY[u] = t * 0.8; this.dX[u] = t * 0.6;
      this.dCnt[u] = (0.2 + 1.5 * r.next()) * this.sr;
      this.lvl[u] = -1; this.lvlT[u] = -1;
    }
  }

  noteOn(note, velocity, freq, v, legato) {
    // decorrelate per note (drift targets / random phases) — deterministic from this engine's history
    this.noteCount++;
    this.rng.s = hash32((this.seed ^ Math.imul((note | 0) + 7, 0x9e3779b1) ^ Math.imul(this.noteCount, 0x85ebca77)) >>> 0) || 0x2545f491;
    if (legato) return;
    // new drift targets / timings (the smoothed drift itself continues → no pitch jump on retrigger)
    const r = this.rng, sr = this.sr;
    for (let u = 0; u < MAXU; u++) {
      this.dT[u] = r.bipolar();
      this.dCnt[u] = (0.15 + 1.2 * r.next()) * sr;
      if (this.fresh) { const x = r.bipolar() * 0.8; this.dX[u] = x; this.dY[u] = x; }
    }
    const mode = Math.round(v[this.iPhase]);
    if (mode <= 0) {
      // free: phases run on. A fresh engine gets note-seeded random phases (free-running analog oscillators
      // are never aligned) and starts exactly on the note.
      if (this.fresh) {
        for (let u = 0; u < MAXU; u++) { const p = r.next(); this.ph[u] = p; this.mph[u] = p; }
        this.preroll = 1;
      }
      return;
    }
    let N = Math.round(v[this.iUni]);
    N = N >= 1 ? (N <= MAXU ? N : MAXU) : 1;
    const c = (N - 1) >> 1;
    for (let u = 0; u < MAXU; u++) {
      let p;
      if (mode === 1) { p = 0.618034 * (u - c); p -= Math.floor(p); } // reset: centre voice at 0, others spread
      else p = this.rng.next();                                       // random
      this.ph[u] = p; this.mph[u] = p;
    }
    this.preroll = this.fresh ? 1 : 2;   // 2 → crossfade from the still-sounding old waveform
    this.phaseSet = true;                // first output sample lands exactly on the chosen phase
  }

  noteOff() {}

  isActive() { return true; }

  reset() {
    this.bufL.fill(0); this.bufR.fill(0);
    this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0;
    this.gLp.fill(0); this.gRp.fill(0);
    this.lvl.fill(-1);
    this.preroll = 0;
    this.phaseSet = false;
    this.fresh = true;
  }

  /** Output latency of the band-limiting accumulator (samples). Pre-rolled at note start. */
  static get latency() { return BK; }

  process(v, freq, outL, outR, offset, n) {
    this.freqIn = freq;
    this.render(v, outL, outR, offset, n);
  }

  /**
   * Same as process() with the pitch taken from this.freqIn. The voice uses this entry point: a double argument
   * to a non-inlined call is boxed (a HeapNumber per call), a field store is not.
   */
  render(v, outL, outR, offset, n) {
    while (n > MAXB) {
      this.render(v, outL, outR, offset, MAXB);
      offset += MAXB; n -= MAXB;
    }
    if (n <= 0) return;
    if (this.preroll) this._preroll(v);
    this._update(v, n);
    this._render(n);

    const bl = this.bufL, br = this.bufR, R = this.dcR;
    let xl = this.dcxL, yl = this.dcyL, xr = this.dcxR, yr = this.dcyR;
    for (let j = 0; j < n; j++) {
      const a = bl[j], b = br[j];
      yl = a - xl + R * yl; xl = a;
      yr = b - xr + R * yr; xr = b;
      outL[offset + j] = yl;
      outR[offset + j] = yr;
    }
    // flush denormal-range DC states
    if (yl < 1e-20 && yl > -1e-20) yl = 0;
    if (yr < 1e-20 && yr > -1e-20) yr = 0;
    this.dcxL = xl; this.dcyL = yl; this.dcxR = xr; this.dcyR = yr;
    bl.copyWithin(0, n, n + BW); bl.fill(0, BW, BW + n);
    br.copyWithin(0, n, n + BW); br.fill(0, BW, BW + n);
    this.fresh = false;
  }

  // Render the accumulator latency ahead so the new note starts on the note-on sample.
  _preroll(v) {
    const bl = this.bufL, br = this.bufR;
    const xfade = this.preroll === 2;
    this.preroll = 0;
    if (xfade) for (let i = 0; i < BK; i++) { this.xfL[i] = bl[i]; this.xfR[i] = br[i]; }
    this._update(v, BK);
    if (this.phaseSet) {
      // phases are advanced before each sample is evaluated: step back one increment (no wrap event) — only
      // for the voices rendered right now, so no negative phase can survive
      this.phaseSet = false;
      for (let u = 0; u < this.nAct; u++) { this.ph[u] -= this.dp[u]; this.mph[u] -= this.dm[u]; }
    }
    // jump every ramp to its target
    this.gLp.set(this.gLt); this.gRp.set(this.gRt);
    this.w0.set(this.w1); this.pw0 = this.pw1; this.pos0 = this.pos1;
    this.lvl.set(this.lvlT);
    bl.fill(0); br.fill(0);
    this._render(BK);
    for (let u = 0; u < MAXU; u++) { // silent voices (gain 0) were not advanced: wrap them back into [0, 1)
      if (this.ph[u] < 0) this.ph[u] += 1;
      if (this.mph[u] < 0) this.mph[u] += 1;
    }
    bl.copyWithin(0, BK, BK + BW); bl.fill(0, BW);
    br.copyWithin(0, BK, BK + BW); br.fill(0, BW);
    if (xfade) {
      for (let i = 0; i < BK; i++) {
        const w = XFADE[i];
        bl[i] = this.xfL[i] + (bl[i] - this.xfL[i]) * w;
        br[i] = this.xfR[i] + (br[i] - this.xfR[i]) * w;
      }
    }
  }

  // ───────────── control (per call) ─────────────

  _update(v, n) {
    const freq = this.freqIn;
    const sr = this.sr;
    const mode = v[this.iMode] >= 0.5 ? 1 : 0;
    this.mode = mode;
    // (NaN-safe clamps: a NaN parameter falls back to the lower bound instead of poisoning the state)
    let N = Math.round(v[this.iUni]);
    N = N >= 1 ? (N <= MAXU ? N : MAXU) : 1;
    this.nAct = N;
    const shape = clamp01(v[this.iShape]);
    const sync = clamp01(v[this.iSync]);
    const det = clamp01(v[this.iDet]);
    const drift = clamp01(v[this.iDrift]);
    const blend = clamp01(v[this.iBlend]);
    const spread = clamp01(v[this.iSpread]);

    // drift random walk (advanced per call; frozen when drift = 0)
    if (drift > 0) {
      const a = 1 - Math.exp(-n / (0.3 * sr));
      const r = this.rng;
      for (let u = 0; u < MAXU; u++) {
        this.dCnt[u] -= n;
        if (this.dCnt[u] <= 0) {
          this.dT[u] = r.bipolar();
          this.dCnt[u] += (0.35 + 1.4 * r.next()) * sr;
        }
        this.dY[u] += (this.dT[u] - this.dY[u]) * a;
        this.dX[u] += (this.dY[u] - this.dX[u]) * a;
      }
    }

    // table
    let tr = 1;
    if (mode === 1) {
      let ti = Math.round(v[this.iTable]);
      if (ti !== this.tabIdx) {
        this.tab = getWavetable(ti);
        this.tabIdx = ti;
        this.wtData = this.tab.data;
        this.wtScale = this.tab.scale;
      }
      tr = this.tab.freqRatio;
    }

    // frequencies
    const semis = 12 * v[this.iOct] + v[this.iSemi] + 0.01 * v[this.iFine];
    let base = (freq * tr * Math.exp((LN2 / 12) * semis)) / sr;
    if (!(base > 0)) base = 0;
    this.syncOn = sync > 0.0005;
    const ratio = this.syncOn ? Math.exp(LN2 * 4 * sync) : 1;
    const off = UNI_OFF[N - 1];
    const detC = DETUNE_MAX_CENTS * detuneCurve(det);
    const drC = DRIFT_CENTS * drift;
    const lam = this.syncOn ? LAMBDA_SYNC : this.lambda;
    for (let u = 0; u < N; u++) {
      const cents = off[u] * detC + drC * this.dX[u];
      let d = base * Math.exp((LN2 / 1200) * cents);
      let m = d > 0.45 ? 0.45 : d;
      if (ratio !== 1) {
        d *= ratio;
        if (d > DPMAX_SYNC) d = m > DPMAX_SYNC ? m : DPMAX_SYNC; // slave stays inside the passband
      } else if (d > DPMAX) d = DPMAX;
      this.dm[u] = m;
      this.dp[u] = d;
    }
    if (mode === 1) {
      for (let u = 0; u < MAXU; u++) {
        // richest mip whose top harmonic stays below λ·fs (aliases fold above fs − λ·fs ≈ 15 kHz)
        const d = this.dp[u];
        const x = d > 0 ? Math.log2((d * TOPH) / lam) : -1;
        let L = x <= 0 ? 0 : Math.ceil(x);
        const cur = this.lvlT[u];
        if (cur >= 0 && L === cur - 1 && x > L - 0.03) L = cur; // hysteresis toward richer levels only
        this.lvlT[u] = L > WT_LEVELS - 1 ? WT_LEVELS - 1 : L;
        if (this.lvl[u] < 0) this.lvl[u] = this.lvlT[u];
      }
    }

    // unison gains (blend / spread / count)
    if (N !== this.gN || blend !== this.gBlend || spread !== this.gSpread) {
      this.gN = N; this.gBlend = blend; this.gSpread = spread;
      const gc = blend <= 0.5 ? 1 : Math.cos((blend - 0.5) * Math.PI * 0.8);
      const gs = blend >= 0.5 ? 1 : Math.sin(blend * Math.PI);
      const c0 = (N - 1) >> 1, c1 = N >> 1; // centre voice(s)
      let sum = 0;
      for (let u = 0; u < N; u++) {
        const g = N === 1 || u === c0 || u === c1 ? gc : gs;
        sum += g * g;
      }
      const norm = sum > 1e-12 ? 1 / Math.sqrt(sum) : 0;
      const pans = UNI_PAN[N - 1];
      for (let u = 0; u < MAXU; u++) {
        if (u >= N) { this.gLt[u] = 0; this.gRt[u] = 0; continue; }
        const g = (N === 1 || u === c0 || u === c1 ? gc : gs) * norm * Math.SQRT2;
        const a = (spread * pans[u] + 1) * 0.25 * Math.PI;
        this.gLt[u] = Math.cos(a) * g;
        this.gRt[u] = Math.sin(a) * g;
      }
    }

    // shape
    const w1 = this.w1;
    if (mode === 0) {
      const m = shape * 3;
      w1[0] = w1[1] = w1[2] = w1[3] = 0;
      if (m <= 1) { w1[0] = 1 - m; w1[1] = m; } else if (m <= 2) { w1[1] = 2 - m; w1[2] = m - 1; } else { w1[2] = 3 - m; w1[3] = m - 2; }
      const pw = v[this.iPw];
      this.pw1 = pw > 0.01 ? (pw < 0.99 ? pw : 0.99) : 0.01;
    } else {
      this.pos1 = shape * (WT_FRAMES - 1);
    }
  }

  // ───────────── audio ─────────────

  _render(n) {
    const mode = this.mode, sync = this.syncOn;
    for (let u = 0; u < MAXU; u++) {
      if (this.gLp[u] === 0 && this.gRp[u] === 0 && this.gLt[u] === 0 && this.gRt[u] === 0) continue;
      const p = this.ph[u];
      if (!(p >= -0.5 && p < 1)) { this.ph[u] = 0; this.mph[u] = 0; } // never let a bad phase index a table
      if (mode === 0) {
        if (sync) this._classicSync(u, n); else this._classic(u, n);
      } else {
        if (this.lvl[u] < 0) this.lvl[u] = this.lvlT[u];
        if (sync) this._wtSync(u, n); else this._wt(u, n);
      }
      this.gLp[u] = this.gLt[u]; this.gRp[u] = this.gRt[u];
    }
    this.w0.set(this.w1);
    this.pw0 = this.pw1;
    this.pos0 = this.pos1;
    this.lvl.set(this.lvlT);
  }

  /** Band-limited step residual at sample j, event d = ev[0] samples before it (0 ≤ d ≤ 1), amplitudes ev[1], ev[2]. */
  _blep(j) {
    const E = this.ev;
    const d = E[0], aL = E[1], aR = E[2];
    let x = d * BR;
    if (x < 0) x = 0; else if (x > BR) x = BR;
    let r = x | 0;
    if (r >= BR) r = BR - 1;
    const f = x - r;
    const T = BLEP, bl = this.bufL, br = this.bufR;
    const o0 = r * BW, o1 = o0 + BW;
    for (let t = 0; t < BW; t++) {
      const a = T[o0 + t];
      const y = a + f * (T[o1 + t] - a);
      bl[j + t] += aL * y;
      br[j + t] += aR * y;
    }
  }

  /** Band-limited ramp residual at sample j (ev = [d, slope change L, slope change R] per sample). */
  _blamp(j) {
    const E = this.ev;
    const d = E[0], aL = E[1], aR = E[2];
    let x = d * BR;
    if (x < 0) x = 0; else if (x > BR) x = BR;
    let r = x | 0;
    if (r >= BR) r = BR - 1;
    const f = x - r;
    const T = BLAMP, bl = this.bufL, br = this.bufR;
    const o0 = r * BW, o1 = o0 + BW;
    for (let t = 0; t < BW; t++) {
      const a = T[o0 + t];
      const y = a + f * (T[o1 + t] - a);
      bl[j + t] += aL * y;
      br[j + t] += aR * y;
    }
  }

  /**
   * Sync-reset residuals in one pass: jumps of value (c0), slope (c1, per sample), 2nd (c2) and 3rd (c3)
   * derivative (per sample², per sample³), scaled by the voice's pan gains.
   */
  _reset(j) {
    const R = this.rs;
    const d = R[0], gl = R[1], gr = R[2], c0 = R[3], c1 = R[4], c2 = R[5], c3 = R[6];
    let x = d * BR;
    if (x < 0) x = 0; else if (x > BR) x = BR;
    let r = x | 0;
    if (r >= BR) r = BR - 1;
    const f = x - r;
    const bl = this.bufL, br = this.bufR;
    const o0 = r * BW, o1 = o0 + BW;
    if (c2 === 0 && c3 === 0) {
      for (let t = 0; t < BW; t++) {
        const a = BLEP[o0 + t], b = BLAMP[o0 + t];
        const y = c0 * (a + f * (BLEP[o1 + t] - a)) + c1 * (b + f * (BLAMP[o1 + t] - b));
        bl[j + t] += gl * y;
        br[j + t] += gr * y;
      }
    } else {
      for (let t = 0; t < BW; t++) {
        const a = BLEP[o0 + t], b = BLAMP[o0 + t], c = BLAMP2[o0 + t], e = BLAMP3[o0 + t];
        const y = c0 * (a + f * (BLEP[o1 + t] - a)) + c1 * (b + f * (BLAMP[o1 + t] - b))
          + c2 * (c + f * (BLAMP2[o1 + t] - c)) + c3 * (e + f * (BLAMP3[o1 + t] - e));
        bl[j + t] += gl * y;
        br[j + t] += gr * y;
      }
    }
  }

  // Classic, free-running (no sync). Inline event detection for speed.
  _classic(u, n) {
    const bl = this.bufL, br = this.bufR, S = SINT;
    const inv = 1 / n;
    let p = this.ph[u];
    const dp = this.dp[u];
    let gl = this.gLp[u], gr = this.gRp[u];
    const dgl = (this.gLt[u] - gl) * inv, dgr = (this.gRt[u] - gr) * inv;
    const W0 = this.w0, W1 = this.w1;
    let ws = W0[0], wt = W0[1], ww = W0[2], wq = W0[3];
    const dws = (W1[0] - ws) * inv, dwt = (W1[1] - wt) * inv, dww = (W1[2] - ww) * inv, dwq = (W1[3] - wq) * inv;
    const hasS = ws !== 0 || W1[0] !== 0, hasT = wt !== 0 || W1[1] !== 0;
    const hasW = ww !== 0 || W1[2] !== 0, hasQ = wq !== 0 || W1[3] !== 0;
    let pw = this.pw0;
    const dpw = hasQ ? (this.pw1 - pw) * inv : 0;
    const idp = dp > 0 ? 1 / dp : 0;
    const d8 = 8 * dp;
    for (let j = 0; j < n; j++) {
      gl += dgl; gr += dgr;
      ws += dws; wt += dwt; ww += dww; wq += dwq;
      const pwOld = pw;
      pw += dpw;
      const p0 = p;
      p += dp;
      if (hasQ) {
        const g0 = p0 - pwOld, g1 = p - pw;
        if (g0 < 0 ? g1 >= 0 : g1 < 0) {                 // pulse edge (either direction, pw may move)
          const a = g0 < 0 ? -2 * wq : 2 * wq;
          { const E = this.ev; E[0] = g1 / (g1 - g0); E[1] = a * gl; E[2] = a * gr; this._blep(j); }
        }
      }
      if (hasT) {
        if (p0 < 0.25 && p >= 0.25) { const a = -d8 * wt; const E = this.ev; E[0] = (p - 0.25) * idp; E[1] = a * gl; E[2] = a * gr; this._blamp(j); }
        if (p0 < 0.75 && p >= 0.75) { const a = d8 * wt; const E = this.ev; E[0] = (p - 0.75) * idp; E[1] = a * gl; E[2] = a * gr; this._blamp(j); }
      }
      if (p >= 1) {
        p -= 1;
        const a = 2 * (ww + wq);                        // saw reset / pulse rising edge
        if (a !== 0) { const E = this.ev; E[0] = p * idp; E[1] = a * gl; E[2] = a * gr; this._blep(j); }
        if (hasQ && p >= pw) { const b = -2 * wq; const E = this.ev; E[0] = (p - pw) * idp; E[1] = b * gl; E[2] = b * gr; this._blep(j); }
        if (hasT && p >= 0.25) { const c = -d8 * wt; const E = this.ev; E[0] = (p - 0.25) * idp; E[1] = c * gl; E[2] = c * gr; this._blamp(j); }
      }
      let y = 0;
      if (hasS) { const x = p * SIN_N; const i = x | 0; const s0 = S[i]; y += ws * (s0 + (x - i) * (S[i + 1] - s0)); }
      if (hasT) y += wt * (p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4);
      if (hasW) y += ww * (1 - 2 * p);
      if (hasQ) y += wq * ((p < pw ? 2 : 0) - 2 * pw);
      bl[BK + j] += y * gl;
      br[BK + j] += y * gr;
    }
    this.ph[u] = p;
    this.mph[u] = p;
  }

  // Waveform-internal events on a linear phase segment a → b (b may pass 1), ending dEnd samples before
  // sample j. Arguments in this.sg = [a, b, dEnd, dp, pwA, pwB, wt, ww, wq, gl, gr]; the wrapped end phase
  // is written to this.sg[11].
  _seg(j) {
    const G = this.sg;
    const a = G[0], dEnd = G[2], dp = G[3], pwA = G[4], pwB = G[5], wt = G[6], ww = G[7], wq = G[8], gl = G[9], gr = G[10];
    let b = G[1];
    if (!(b > a)) { G[11] = a >= 1 ? a - 1 : a; return; }
    const idp = 1 / dp;
    if (wq !== 0) {
      const g0 = a - pwA, g1 = b - pwB;
      if (g0 < 0 ? g1 >= 0 : g1 < 0) {
        const s = (g0 < 0 ? -2 : 2) * wq;
        { const E = this.ev; E[0] = dEnd + (g1 / (g1 - g0)) * (b - a) * idp; E[1] = s * gl; E[2] = s * gr; this._blep(j); }
      }
    }
    if (wt !== 0) {
      const d8 = 8 * dp * wt;
      if (a < 0.25 && b >= 0.25) { const E = this.ev; E[0] = dEnd + (b - 0.25) * idp; E[1] = -d8 * gl; E[2] = -d8 * gr; this._blamp(j); }
      if (a < 0.75 && b >= 0.75) { const E = this.ev; E[0] = dEnd + (b - 0.75) * idp; E[1] = d8 * gl; E[2] = d8 * gr; this._blamp(j); }
    }
    if (b >= 1) {
      b -= 1;
      const s = 2 * (ww + wq);
      if (s !== 0) { const E = this.ev; E[0] = dEnd + b * idp; E[1] = s * gl; E[2] = s * gr; this._blep(j); }
      if (wq !== 0 && b >= pwB) { const q = -2 * wq; const E = this.ev; E[0] = dEnd + (b - pwB) * idp; E[1] = q * gl; E[2] = q * gr; this._blep(j); }
      if (wt !== 0 && b >= 0.25) { const d8 = -8 * dp * wt; const E = this.ev; E[0] = dEnd + (b - 0.25) * idp; E[1] = d8 * gl; E[2] = d8 * gr; this._blamp(j); }
    }
    G[11] = b;
  }

  // Classic with hard sync to a virtual master at the note frequency. Samples without a reset use the same
  // inline event detection as _classic; a reset sample splits into two segments handled by _seg.
  _classicSync(u, n) {
    const bl = this.bufL, br = this.bufR, S = SINT;
    const inv = 1 / n;
    let p = this.ph[u], m = this.mph[u];
    const dp = this.dp[u], dm = this.dm[u];
    let gl = this.gLp[u], gr = this.gRp[u];
    const dgl = (this.gLt[u] - gl) * inv, dgr = (this.gRt[u] - gr) * inv;
    const W0 = this.w0, W1 = this.w1;
    let ws = W0[0], wt = W0[1], ww = W0[2], wq = W0[3];
    const dws = (W1[0] - ws) * inv, dwt = (W1[1] - wt) * inv, dww = (W1[2] - ww) * inv, dwq = (W1[3] - wq) * inv;
    const hasS = ws !== 0 || W1[0] !== 0, hasT = wt !== 0 || W1[1] !== 0;
    const hasW = ww !== 0 || W1[2] !== 0, hasQ = wq !== 0 || W1[3] !== 0;
    let pw = this.pw0;
    const dpw = (this.pw1 - pw) * inv;
    const idp = dp > 0 ? 1 / dp : 0;
    const d8 = 8 * dp;
    const TWO_PI = 2 * Math.PI;
    for (let j = 0; j < n; j++) {
      gl += dgl; gr += dgr;
      ws += dws; wt += dwt; ww += dww; wq += dwq;
      const pwOld = pw;
      pw += dpw;
      const p0 = p;
      m += dm;
      if (m >= 1) {
        m -= 1;
        let dr = dm > 0 ? m / dm : 0;
        if (dr > 1) dr = 1;
        const pwR = pwOld + (pw - pwOld) * (1 - dr);
        const G = this.sg;
        G[0] = p0; G[1] = p0 + dp * (1 - dr); G[2] = dr; G[3] = dp; G[4] = pwOld; G[5] = pwR;
        G[6] = wt; G[7] = ww; G[8] = wq; G[9] = gl; G[10] = gr;
        this._seg(j);
        const pr = G[11];
        // value / derivatives just before and after the reset
        let vb = 0, sb = 0, svb = 0, cvb = 1;
        if (ws !== 0) {
          const x = pr * SIN_N; const i = x | 0; const f = x - i;
          svb = S[i] + f * (S[i + 1] - S[i]);
          vb += ws * svb;
          let xc = x + SIN_N * 0.25; if (xc >= SIN_N) xc -= SIN_N;
          const ic = xc | 0;
          cvb = S[ic] + (xc - ic) * (S[ic + 1] - S[ic]);
          sb += ws * TWO_PI * cvb;
        }
        if (wt !== 0) {
          vb += wt * (pr < 0.25 ? 4 * pr : pr < 0.75 ? 2 - 4 * pr : 4 * pr - 4);
          sb += wt * (pr < 0.25 || pr >= 0.75 ? 4 : -4);
        }
        vb += ww * (1 - 2 * pr); sb -= 2 * ww;
        vb += wq * ((pr < pwR ? 2 : 0) - 2 * pwR);
        const va = wq * (2 - 2 * pwR) + ww;
        const sa = ws * TWO_PI + 4 * wt - 2 * ww;
        const dv = va - vb, ds = (sa - sb) * dp;
        // sine: higher derivative jumps Δy⁽ⁿ⁾ = (2π·dp)ⁿ·[sin(nπ/2) − sin(2π·pr + nπ/2)]
        let d2 = 0, d3 = 0;
        if (ws !== 0) {
          const w = TWO_PI * dp, w2 = w * w;
          d2 = ws * w2 * svb;
          d3 = ws * w2 * w * (cvb - 1);
        }
        if (dv !== 0 || ds !== 0 || d2 !== 0) {
          const R = this.rs;
          R[0] = dr; R[1] = gl; R[2] = gr; R[3] = dv; R[4] = ds; R[5] = d2; R[6] = d3;
          this._reset(j);
        }
        G[0] = 0; G[1] = dp * dr; G[2] = 0; G[3] = dp; G[4] = pwR; G[5] = pw;
        G[6] = wt; G[7] = ww; G[8] = wq; G[9] = gl; G[10] = gr;
        this._seg(j);
        p = G[11];
      } else {
        p += dp;
        if (hasQ) {
          const g0 = p0 - pwOld, g1 = p - pw;
          if (g0 < 0 ? g1 >= 0 : g1 < 0) {
            const a = g0 < 0 ? -2 * wq : 2 * wq;
            { const E = this.ev; E[0] = g1 / (g1 - g0); E[1] = a * gl; E[2] = a * gr; this._blep(j); }
          }
        }
        if (hasT) {
          if (p0 < 0.25 && p >= 0.25) { const a = -d8 * wt; const E = this.ev; E[0] = (p - 0.25) * idp; E[1] = a * gl; E[2] = a * gr; this._blamp(j); }
          if (p0 < 0.75 && p >= 0.75) { const a = d8 * wt; const E = this.ev; E[0] = (p - 0.75) * idp; E[1] = a * gl; E[2] = a * gr; this._blamp(j); }
        }
        if (p >= 1) {
          p -= 1;
          const a = 2 * (ww + wq);
          if (a !== 0) { const E = this.ev; E[0] = p * idp; E[1] = a * gl; E[2] = a * gr; this._blep(j); }
          if (hasQ && p >= pw) { const b = -2 * wq; const E = this.ev; E[0] = (p - pw) * idp; E[1] = b * gl; E[2] = b * gr; this._blep(j); }
          if (hasT && p >= 0.25) { const c = -d8 * wt; const E = this.ev; E[0] = (p - 0.25) * idp; E[1] = c * gl; E[2] = c * gr; this._blamp(j); }
        }
      }
      let y = 0;
      if (hasS) { const x = p * SIN_N; const i = x | 0; const s0 = S[i]; y += ws * (s0 + (x - i) * (S[i + 1] - s0)); }
      if (hasT) y += wt * (p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4);
      if (hasW) y += ww * (1 - 2 * p);
      if (hasQ) y += wq * ((p < pw ? 2 : 0) - 2 * pw);
      bl[BK + j] += y * gl;
      br[BK + j] += y * gr;
    }
    this.ph[u] = p;
    this.mph[u] = m;
  }

  // Wavetable, free-running: cubic Hermite within frames, linear crossfade between frames.
  _wt(u, n) {
    const D = this.wtData, bl = this.bufL, br = this.bufR;
    const inv = 1 / n, sc = this.wtScale;
    let p = this.ph[u];
    const dp = this.dp[u];
    let gl = this.gLp[u] * sc, gr = this.gRp[u] * sc;
    const dgl = (this.gLt[u] * sc - gl) * inv, dgr = (this.gRt[u] * sc - gr) * inv;
    let pos = this.pos0;
    const dpos = (this.pos1 - pos) * inv;
    const L = this.lvlT[u], Lo = this.lvl[u];
    const N = WT_LEVEL_SIZE[L], S = WT_LEVEL_STRIDE[L], base = WT_LEVEL_BASE[L] + WT_GUARD_PRE;
    if (L === Lo) {
      for (let j = 0; j < n; j++) {
        gl += dgl; gr += dgr; pos += dpos;
        p += dp;
        if (p >= 1) p -= 1;
        let fi = pos | 0;
        if (fi > FM2) fi = FM2;
        const x = p * N;
        const i = x | 0;
        const y = wtRead(D, base + fi * S + i, S, pos - fi, x - i);
        bl[BK + j] += y * gl;
        br[BK + j] += y * gr;
      }
    } else {
      // mip level change: crossfade old → new level across the block
      const No = WT_LEVEL_SIZE[Lo], So = WT_LEVEL_STRIDE[Lo], baseO = WT_LEVEL_BASE[Lo] + WT_GUARD_PRE;
      for (let j = 0; j < n; j++) {
        gl += dgl; gr += dgr; pos += dpos;
        p += dp;
        if (p >= 1) p -= 1;
        let fi = pos | 0;
        if (fi > FM2) fi = FM2;
        const ff = pos - fi;
        let x = p * N, i = x | 0;
        const yn = wtRead(D, base + fi * S + i, S, ff, x - i);
        x = p * No; i = x | 0;
        const yo = wtRead(D, baseO + fi * So + i, So, ff, x - i);
        const y = yo + (yn - yo) * ((j + 1) * inv);
        bl[BK + j] += y * gl;
        br[BK + j] += y * gr;
      }
    }
    this.ph[u] = p;
    this.mph[u] = p;
  }

  // Wavetable with hard sync: value, slope, curvature and 3rd-derivative jumps of the (cubic) waveform are
  // band-limited at every reset.
  _wtSync(u, n) {
    const D = this.wtData, bl = this.bufL, br = this.bufR;
    const inv = 1 / n, sc = this.wtScale;
    let p = this.ph[u], m = this.mph[u];
    const dp = this.dp[u], dm = this.dm[u];
    let gl = this.gLp[u] * sc, gr = this.gRp[u] * sc;
    const dgl = (this.gLt[u] * sc - gl) * inv, dgr = (this.gRt[u] * sc - gr) * inv;
    let pos = this.pos0;
    const dpos = (this.pos1 - pos) * inv;
    const L = this.lvlT[u], Lo = this.lvl[u];
    const N = WT_LEVEL_SIZE[L], S = WT_LEVEL_STRIDE[L], base = WT_LEVEL_BASE[L] + WT_GUARD_PRE;
    const No = WT_LEVEL_SIZE[Lo], So = WT_LEVEL_STRIDE[Lo], baseO = WT_LEVEL_BASE[Lo] + WT_GUARD_PRE;
    const xf = L !== Lo; // mip change: crossfade the old level out across the block
    const dA = this.dA, dB = this.dB;
    const k1 = N * dp, k2 = k1 * k1, k3 = k2 * k1;
    for (let j = 0; j < n; j++) {
      gl += dgl; gr += dgr; pos += dpos;
      let fi = pos | 0;
      if (fi > FM2) fi = FM2;
      const ff = pos - fi;
      const fb = base + fi * S;
      p += dp;
      m += dm;
      if (m >= 1) {
        m -= 1;
        let dr = dm > 0 ? m / dm : 0;
        if (dr > 1) dr = 1;
        let pr = p - dp * dr;             // slave phase at the reset instant
        if (pr >= 1) pr -= 1; else if (pr < 0) pr += 1;
        const x = pr * N, i = x | 0;
        dB[0] = ff; dB[1] = x - i; wtDerivs(D, fb + i, S, dB);  // before
        dA[0] = ff; dA[1] = 0; wtDerivs(D, fb, S, dA);          // after (phase 0)
        const R = this.rs;
        R[0] = dr; R[1] = gl; R[2] = gr;
        R[3] = dA[0] - dB[0]; R[4] = (dA[1] - dB[1]) * k1; R[5] = (dA[2] - dB[2]) * k2; R[6] = (dA[3] - dB[3]) * k3;
        this._reset(j);
        p = dp * dr;
      } else if (p >= 1) p -= 1;
      const x = p * N, i = x | 0;
      let y = wtRead(D, fb + i, S, ff, x - i);
      if (xf) {
        const xo = p * No, io = xo | 0;
        const yo = wtRead(D, baseO + fi * So + io, So, ff, xo - io);
        y = yo + (y - yo) * ((j + 1) * inv);
      }
      bl[BK + j] += y * gl;
      br[BK + j] += y * gr;
    }
    this.ph[u] = p;
    this.mph[u] = m;
  }
}
