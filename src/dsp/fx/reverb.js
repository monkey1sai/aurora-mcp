// AURORA reverb — 16-line modulated feedback delay network.
//
//   in ─▶ gate(on) ─▶ HP 80 Hz · bandwidth LP ─▶ predelay (Hermite, slewed) ─▶ 4-stage allpass diffuser / ch
//        ─▶ early buffer ─┬─▶ 12 early-reflection taps / ch (times ∝ size) ─────────────────────┐
//                         └─▶ inject into 16 lines (alternating L/R, signed)                    │
//   16 delay lines (lengths ∝ size over ~1 octave, each Hermite-read with its own sine + smooth-random
//   modulation) ─▶ per-line absorption shelf (DC gain & HF gain give T60 = decay, T60_hf = decay·f(damp))
//   ─▶ lossless 16×16 Hadamard mix (fast WHT) ─▶ [shimmer: 4 lines cross-faded with an octave-up
//   dual-grain pitch shifter] ─▶ write back.  Late L/R = orthogonal ±¼ sums of line outputs.
//   wet = late + ER ─▶ width (M/S) ─▶ send-style dry/wet mix.
//
// Turning the reverb off only closes its input gate — the tail keeps ringing and the module goes idle
// once it has decayed below −100 dBFS. The loop is contractive by construction (orthogonal mix, per-line
// gains < 1, Hermite reads |H| ≤ 1, shimmer blend convex with capped compensation); an energy guard is
// kept as a last-resort backstop.
import { idx } from '../params.js';
import { DENORMAL } from '../util.js';
import { nextPow2, rbjLowpass } from './common.js';

const N = 16;
const TWO_PI = Math.PI * 2;
const LN1000 = Math.log(1000);
const SIZE_MIN_MS = 16, SIZE_MAX_MS = 144;
const MOD_MAX_S = 0.0009;
const SHIM_LINES = [2, 6, 9, 13];
const NSH = 4;
const GRAIN_S = [0.047, 0.059, 0.071, 0.087]; // ascending
const LATE_GAIN = 0.75;
const ER_TAPS = 12;
const DIFF_MS_L = [3.1, 4.7, 7.3, 11.9];
const DIFF_MS_R = [3.4, 5.3, 6.7, 12.7];
const DIFF_G = [0.72, 0.7, 0.64, 0.62];

// Deterministic pseudo-random helper (construction-time only).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class Reverb {
  constructor(sampleRate) {
    const sr = (this.sr = sampleRate);
    this.iOn = idx('reverb.on');
    this.iSize = idx('reverb.size');
    this.iDecay = idx('reverb.decay');
    this.iPre = idx('reverb.predelay');
    this.iDamp = idx('reverb.damp');
    this.iMod = idx('reverb.mod');
    this.iWidth = idx('reverb.width');
    this.iShim = idx('reverb.shimmer');
    this.iMix = idx('reverb.mix');

    const rnd = lcg(0xa0c0a);

    // ── delay-line geometry ──
    this.ratio = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const jit = ((i * 0.6180339887) % 1) * 0.8;
      this.ratio[i] = Math.pow(2, (i + jit) / N);
    }
    this.LS = nextPow2(Math.ceil((SIZE_MAX_MS * 2.02 * 0.001 + MOD_MAX_S * 1.5) * sr) + 16);
    this.lmask = this.LS - 1;
    this.lines = new Float32Array(N * this.LS);
    this.w = 0;

    // per-line state
    this.D = new Float64Array(N);       // current nominal delay (samples) for the slewed size
    this.dCur = new Float64Array(N);    // delay incl. modulation at chunk start
    this.dEnd = new Float64Array(N);
    this.gDC = new Float64Array(N);
    this.gHF = new Float64Array(N);
    this.lpS = new Float64Array(N);     // absorption-shelf LP state
    this.y = new Float64Array(N);
    this.modPh = new Float64Array(N);
    this.modRate = new Float64Array(N);
    this.rPrev = new Float64Array(N);
    this.rNext = new Float64Array(N);
    this.rPh = new Float64Array(N);
    this.rRate = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.modPh[i] = rnd();
      this.modRate[i] = 0.11 + 0.72 * ((i * 0.7548776662) % 1);
      this.rPrev[i] = rnd() * 2 - 1;
      this.rNext[i] = rnd() * 2 - 1;
      this.rPh[i] = rnd();
      this.rRate[i] = 0.25 + 0.5 * rnd();
    }
    this.rng = 0x51f15e;
    // reference loop energy loss (size 0.6, decay 3 s) for the partial loudness normalisation
    {
      const s06 = SIZE_MIN_MS * Math.pow(SIZE_MAX_MS / SIZE_MIN_MS, 0.6) * 0.001;
      let gm = 0;
      for (let i = 0; i < N; i++) { const g = Math.exp((-LN1000 * this.ratio[i] * s06) / 3); gm += g * g; }
      this.refE = 1 - gm / N;
      this.refMs = s06 * 1000;
    }

    // injection signs & output patterns (orthogonal Hadamard rows 5 and 10, scaled ¼)
    this.injS = new Float64Array(N);
    this.oL = new Float64Array(N);
    this.oR = new Float64Array(N);
    const had = (r, c) => {
      let b = r & c, p = 0;
      while (b) { p ^= b & 1; b >>= 1; }
      return p ? -1 : 1;
    };
    for (let i = 0; i < N; i++) {
      this.injS[i] = had(7, i);
      this.oL[i] = 0.25 * had(5, i);
      this.oR[i] = 0.25 * had(10, i);
    }

    // ── predelay (stereo) ──
    this.PS = nextPow2(Math.ceil(0.26 * sr) + 8);
    this.pmask = this.PS - 1;
    this.pre = new Float32Array(this.PS * 2).fill(DENORMAL); // (holds the +DENORMAL bias everywhere: see process)

    // ── input diffuser: 4 allpasses per channel ──
    this.DS = nextPow2(Math.ceil(0.0135 * sr) + 8);
    this.dmask = this.DS - 1;
    this.diff = new Float32Array(this.DS * 8);
    this.diffLen = new Float64Array(8); // current lengths (samples) for the slewed size

    // ── early reflections (read from the diffused signal) ──
    this.ES = nextPow2(Math.ceil(SIZE_MAX_MS * 0.001 * sr) + 16);
    this.emask = this.ES - 1;
    this.early = new Float32Array(this.ES * 2);
    this.erT = new Float64Array(ER_TAPS * 2);   // ratio of size scale
    this.erG = new Float64Array(ER_TAPS * 2);
    this.erSrc = new Int32Array(ER_TAPS * 2);   // 0 = own channel, 1 = other channel
    for (let c = 0; c < 2; c++) {
      let e = 0;
      for (let k = 0; k < ER_TAPS; k++) {
        const t = 0.035 + 0.9 * Math.pow((k + 0.3 + 0.55 * rnd()) / ER_TAPS, 1.2);
        const g = (rnd() < 0.5 ? -1 : 1) * (1 - 0.55 * (k / ER_TAPS)) * (0.75 + 0.25 * rnd());
        this.erT[c * ER_TAPS + k] = t;
        this.erG[c * ER_TAPS + k] = g;
        this.erSrc[c * ER_TAPS + k] = k % 3 === 1 ? 1 : 0;
        e += g * g;
      }
      const nrm = 1 / Math.sqrt(e);
      for (let k = 0; k < ER_TAPS; k++) this.erG[c * ER_TAPS + k] *= nrm;
    }
    this.erGd = new Float64Array(ER_TAPS * 2);  // decay-weighted, normalised gains
    this.erPos0 = new Float64Array(ER_TAPS * 2);
    this.erDelta = new Float64Array(ER_TAPS * 2);
    this.erOff = new Int32Array(ER_TAPS * 2);   // buffer offset per tap (which channel it reads)
    for (let k = 0; k < ER_TAPS; k++) {
      this.erOff[k] = this.erSrc[k] ? this.ES : 0;
      this.erOff[ER_TAPS + k] = this.erSrc[ER_TAPS + k] ? 0 : this.ES;
    }
    this.diffG = Float64Array.from(DIFF_G);
    this.dSlope = new Float64Array(N);
    this.erPos1 = new Float64Array(ER_TAPS * 2);

    // ── shimmer: dual-grain octave-up shifters on 4 lines ──
    // grain lengths differ per shifter so their grain-rate sidebands don't line up (smoother cloud)
    this.GW = new Int32Array(NSH);
    this.invGW = new Float64Array(NSH);
    for (let j = 0; j < NSH; j++) {
      this.GW[j] = Math.round(GRAIN_S[j] * sr) & ~1;
      this.invGW[j] = 1 / this.GW[j];
    }
    this.SS = nextPow2(this.GW[NSH - 1] + 16);
    this.smask = this.SS - 1;
    this.shBuf = new Float32Array(this.SS * NSH);
    this.shCnt = new Int32Array(NSH);
    for (let j = 0; j < NSH; j++) this.shCnt[j] = Math.floor((j * this.GW[j]) / NSH);
    // 4th-order Butterworth anti-alias low-pass in front of each shifter (octave-up = 2× decimation)
    this.shLP = new Float64Array(10);
    const fAA = Math.min(0.2 * sr, 12000);
    rbjLowpass(this.shLP, 0, fAA, 0.5412, sr);
    rbjLowpass(this.shLP, 5, fAA, 1.3066, sr);
    this.shZ = new Float64Array(NSH * 4);
    // per-shifter blend s and gain compensation c (ramped per sample)
    this.shS0 = new Float64Array(NSH); this.shS1 = new Float64Array(NSH);
    this.shC0 = new Float64Array(NSH); this.shC1 = new Float64Array(NSH);
    this.shC1.fill(1); this.shC0.fill(1);

    // ── input conditioning ──
    const hp = Math.tan((Math.PI * 80) / sr);
    this.hpG = hp / (1 + hp);
    this.hpL = 0; this.hpR = 0;
    this.bwL = 0; this.bwR = 0; this.bwG = 0.5;

    // ── smoothed params ──
    this.fadeStep = 1 / (0.02 * sr);
    this.inG = 0;
    this.active = false; this.inited = false;
    this.quiet = 0;
    this.sizeN = 0.6; this.sizeMs = 60; this.decay = 3; this.preS = 0.02 * sr; this.prePrev = this.preS;
    this.damp = 0.5; this.mod = 0.3; this.width = 1; this.shim = 0; this.mix = 0.3;
    this.gDry = 1; this.gWet = 0.6; this.gWidth = 1;
    this.lateGain = 1; this.gLate = 1; this.erLevel = 0.5; this.gEr = 0.5;
    this.dampG = 0.5;
    this.guard = 1;
    this.gMax = 0.9;
  }

  reset() {
    this.lines.fill(0); this.pre.fill(DENORMAL); this.diff.fill(0); this.early.fill(0); this.shBuf.fill(0);
    this.lpS.fill(0); this.shZ.fill(0);
    this.hpL = this.hpR = this.bwL = this.bwR = 0;
    this.w = 0;
    this.inG = 0; this.active = false; this.inited = false; this.quiet = 0; this.guard = 1;
  }

  /** True while the tail may still be audible (idle, or quiet for longer than the pre-delay path, → false). */
  tailActive() { return this.active && this.quiet < 0.35 * this.sr + this.preS; }

  rndBip() {
    let s = this.rng;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this.rng = s;
    return s / 2147483648 - 1;
  }

  /** Send-style dry/wet law: dry stays at unity up to mix 0.5, wet reaches unity at 0.5. */
  mixGains() {
    const m = this.mix;
    this.gDry = m <= 0.5 ? 1 : 2 * (1 - m);
    this.gWet = m >= 0.5 ? 1 : 2 * m;
  }

  /** Recompute per-line absorption gains and related coefficients from the smoothed params. */
  updateCoefs() {
    const sr = this.sr;
    const T = this.decay;
    const damp = this.damp;
    const fc = Math.min(0.45 * sr, 10000 * Math.pow(0.3, damp));
    const g = Math.tan((Math.PI * fc) / sr);
    this.dampG = g / (1 + g);
    const hfRatio = 0.85 - 0.72 * damp;
    const kDC = -LN1000 / (T * sr);
    const kHF = -LN1000 / (T * hfRatio * sr);
    let gm = 0, gMax = 0;
    for (let i = 0; i < N; i++) {
      const d = this.D[i];
      this.gDC[i] = Math.exp(kDC * d);
      this.gHF[i] = Math.exp(kHF * d);
      gm += this.gDC[i] * this.gDC[i];
      if (this.gDC[i] > gMax) gMax = this.gDC[i];
    }
    this.gMax = gMax;
    gm /= N;
    // partial loudness normalisation: long decays still get bigger, but only by half the dB difference
    const e = Math.max(1e-5, 1 - gm);
    // + size compensation: bigger rooms would otherwise get quieter at equal T60 (energy ∝ T60 / size)
    this.lateGain = LATE_GAIN * Math.pow(e / this.refE, 0.25) * Math.pow(this.sizeMs / this.refMs, 0.3);
    const bw = Math.min(0.45 * sr, 16000 * Math.pow(0.4, damp));
    const b = Math.tan((Math.PI * bw) / sr);
    this.bwG = b / (1 + b);
    this.erLevel = 0.55 - 0.25 * this.sizeN;
    // early reflections follow the same exponential envelope as the tail (energy-normalised)
    const s = this.sizeMs * 0.001;
    const kT = -LN1000 / T;
    for (let c = 0; c < 2; c++) {
      let e = 0;
      for (let k = 0; k < ER_TAPS; k++) {
        const q = c * ER_TAPS + k;
        const gk = this.erG[q] * Math.exp(kT * (this.erT[q] * s + 0.004));
        this.erGd[q] = gk;
        e += gk * gk;
      }
      const nrm = 1 / Math.sqrt(e + 1e-12);
      for (let k = 0; k < ER_TAPS; k++) this.erGd[c * ER_TAPS + k] *= nrm;
    }
  }

  process(L, R, off, n, eff) {
    const on = eff[this.iOn] >= 0.5 ? 1 : 0;
    if (!this.active) {
      if (!on) return;
      this.active = true;
      this.inG = 0; this.quiet = 0;
    }
    const sr = this.sr;
    const tSize = eff[this.iSize], tDecay = eff[this.iDecay], tPre = eff[this.iPre] * sr, tDamp = eff[this.iDamp];
    const tMod = eff[this.iMod], tWidth = eff[this.iWidth], tShim = eff[this.iShim], tMix = eff[this.iMix];
    if (!this.inited) {
      this.sizeN = tSize; this.sizeMs = SIZE_MIN_MS * Math.pow(SIZE_MAX_MS / SIZE_MIN_MS, tSize);
      this.decay = tDecay; this.preS = tPre; this.prePrev = tPre; this.damp = tDamp; this.mod = tMod;
      this.width = tWidth; this.shim = tShim; this.mix = tMix;
      for (let i = 0; i < N; i++) {
        this.D[i] = this.ratio[i] * this.sizeMs * 0.001 * sr;
        this.dEnd[i] = this.D[i];
      }
      this.updateDiffLen();
      this.updateER(this.erPos1);
      this.updateCoefs();
      this.mixGains(); this.gWidth = tWidth;
      this.gLate = this.lateGain; this.gEr = this.erLevel;
      this.shimTargets(this.shS1, this.shC1);
      this.inited = true;
    }
    // ── parameter smoothing (per chunk) ──
    const kFast = 1 - Math.exp(-n / (0.05 * sr));
    const kSize = 1 - Math.exp(-n / (0.25 * sr));
    const kPre = 1 - Math.exp(-n / (0.12 * sr));
    this.sizeN += (tSize - this.sizeN) * kSize;
    const newMs = SIZE_MIN_MS * Math.pow(SIZE_MAX_MS / SIZE_MIN_MS, this.sizeN);
    const sizeMoved = Math.abs(newMs - this.sizeMs) > 1e-7;
    this.sizeMs = newMs;
    const oldDecay = this.decay, oldDamp = this.damp;
    this.decay += (tDecay - this.decay) * kFast;
    this.damp += (tDamp - this.damp) * kFast;
    this.mod += (tMod - this.mod) * kFast;
    this.width += (tWidth - this.width) * kFast;
    this.shim += (tShim - this.shim) * kFast;
    this.mix += (tMix - this.mix) * kFast;
    this.prePrev = this.preS;
    let pstep = (tPre - this.preS) * kPre;
    const plim = 0.5 * n; // predelay glide rate limit
    if (pstep > plim) pstep = plim; else if (pstep < -plim) pstep = -plim;
    this.preS += pstep;
    if (Math.abs(tPre - this.preS) < 0.01) this.preS = tPre;

    if (sizeMoved) {
      const s = this.sizeMs * 0.001 * sr;
      for (let i = 0; i < N; i++) this.D[i] = this.ratio[i] * s;
      this.updateDiffLen();
    }
    if (sizeMoved || Math.abs(oldDecay - this.decay) > 1e-9 || Math.abs(oldDamp - this.damp) > 1e-9) this.updateCoefs();

    // ── modulation targets for the end of this chunk ──
    const depth = this.mod * MOD_MAX_S * sr;
    const dCur = this.dCur, dEnd = this.dEnd, D = this.D;
    const modPh = this.modPh, modRate = this.modRate, rPh = this.rPh, rRate = this.rRate, rPrev = this.rPrev, rNext = this.rNext;
    const dtc = n / sr;
    for (let i = 0; i < N; i++) {
      dCur[i] = dEnd[i];
      let p = modPh[i] + modRate[i] * dtc;
      p -= Math.floor(p);
      modPh[i] = p;
      let q = rPh[i] + rRate[i] * dtc;
      if (q >= 1) { q -= 1; rPrev[i] = rNext[i]; rNext[i] = this.rndBip(); }
      rPh[i] = q;
      const sm = rPrev[i] + (rNext[i] - rPrev[i]) * (0.5 - 0.5 * Math.cos(Math.PI * q));
      dEnd[i] = D[i] + depth * (1.05 + 0.7 * Math.sin(TWO_PI * p) + 0.3 * sm);
    }
    const erPos0 = this.erPos0, erPos1 = this.erPos1, erDelta = this.erDelta;
    for (let k = 0; k < 2 * ER_TAPS; k++) erPos0[k] = erPos1[k];
    this.updateER(erPos1);
    for (let k = 0; k < 2 * ER_TAPS; k++) erDelta[k] = erPos1[k] - erPos0[k];
    const dSlope = this.dSlope;
    for (let i = 0; i < N; i++) dSlope[i] = dEnd[i] - dCur[i];

    const inv = 1 / n;
    const pDry = this.gDry, pWet = this.gWet, pWidth = this.gWidth, pLate = this.gLate, pEr = this.gEr;
    this.mixGains(); this.gWidth = this.width;
    this.gLate = this.lateGain; this.gEr = this.erLevel;
    const shS0 = this.shS0, shS1 = this.shS1, shC0 = this.shC0, shC1 = this.shC1;
    for (let q = 0; q < NSH; q++) { shS0[q] = shS1[q]; shC0[q] = shC1[q]; }
    this.shimTargets(shS1, shC1);
    let shimOn = false;
    for (let q = 0; q < NSH; q++) if (shS0[q] > 0 || shS1[q] > 0) shimOn = true;
    const dDry = (this.gDry - pDry) * inv, dWet = (this.gWet - pWet) * inv, dWidth = (this.gWidth - pWidth) * inv;
    const dLate = (this.gLate - pLate) * inv, dEr = (this.gEr - pEr) * inv;
    let gDry = pDry, gWet = pWet, gWidth = pWidth, gLate = pLate, gEr = pEr;

    // locals
    const lines = this.lines, LS = this.LS, lmask = this.lmask;
    const pre = this.pre, PS = this.PS, pmask = this.pmask;
    const diff = this.diff, DS = this.DS, dmask = this.dmask, diffLen = this.diffLen;
    const early = this.early, ES = this.ES, emask = this.emask;
    const erG = this.erGd, erOff = this.erOff, diffG = this.diffG;
    const gDC = this.gDC, gHF = this.gHF, lpS = this.lpS, y = this.y, injS = this.injS, oL = this.oL, oR = this.oR;
    const dampG = this.dampG, hpG = this.hpG, bwG = this.bwG;
    const shBuf = this.shBuf, SS = this.SS, smask = this.smask, shCnt = this.shCnt, GWa = this.GW, invGWa = this.invGW;
    const shLP = this.shLP, shZ = this.shZ;
    const b0 = shLP[0], b1 = shLP[1], b2 = shLP[2], a1 = shLP[3], a2 = shLP[4];
    const c0 = shLP[5], c1 = shLP[6], c2 = shLP[7], e1 = shLP[8], e2 = shLP[9];
    let w = this.w, inG = this.inG;
    let hpL = this.hpL, hpR = this.hpR, bwL = this.bwL, bwR = this.bwR;
    const fadeStep = this.fadeStep;
    const p0 = this.prePrev, p1 = this.preS;
    let peak = 0, energy = 0;
    const guardScale = 0.25 * this.guard;

    for (let s = off, end = off + n, j = 0; s < end; s++, j++) {
      const xL = L[s], xR = R[s];
      if (on) { inG += fadeStep; if (inG > 1) inG = 1; } else { inG -= fadeStep; if (inG < 0) inG = 0; }
      const fr = j * inv;
      // input conditioning: HP 80 Hz, bandwidth LP
      let a = xL * inG, b = xR * inG;
      let v = (a - hpL) * hpG; let lp = v + hpL; hpL = lp + v; a -= lp;
      v = (b - hpR) * hpG; lp = v + hpR; hpR = lp + v; b -= lp;
      v = (a - bwL) * bwG; lp = v + bwL; bwL = lp + v; a = lp;
      v = (b - bwR) * bwG; lp = v + bwR; bwR = lp + v; b = lp;
      const ain = (a < 0 ? -a : a) + (b < 0 ? -b : b);
      if (ain > peak) peak = ain;
      // predelay. +DENORMAL (§2): the decaying input filters otherwise leave float32-subnormal values in the
      // predelay → diffuser → early-reflection buffers (stuck limit cycles read every sample until the idle
      // bypass, ≈5 s: 3k/8k diffuser and 5k/16k ER values measured on Twilight Horn). The bias keeps them normal;
      // the FDN adds its own.
      const wp = w & pmask;
      pre[wp] = a + DENORMAL; pre[PS + wp] = b + DENORMAL;
      let pd = p0 + (p1 - p0) * fr;
      if (pd < 2) pd = 2;
      {
        const pos = wp - pd;
        const ip = Math.floor(pos);
        const fq = pos - ip;
        const i0 = (ip - 1) & pmask, i1 = ip & pmask, i2 = (ip + 1) & pmask, i3 = (ip + 2) & pmask;
        let ym1 = pre[i0], y0 = pre[i1], y1 = pre[i2], y2 = pre[i3];
        a = ((((0.5 * (y2 - ym1) + 1.5 * (y0 - y1)) * fq + (ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2)) * fq + 0.5 * (y1 - ym1)) * fq) + y0;
        ym1 = pre[PS + i0]; y0 = pre[PS + i1]; y1 = pre[PS + i2]; y2 = pre[PS + i3];
        b = ((((0.5 * (y2 - ym1) + 1.5 * (y0 - y1)) * fq + (ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2)) * fq + 0.5 * (y1 - ym1)) * fq) + y0;
      }
      // diffuser (Schroeder allpasses, linear-interpolated lengths)
      const wd = w & dmask;
      for (let k = 0; k < 4; k++) {
        const gk = diffG[k];
        let o = k * DS;
        let pos = wd - diffLen[k];
        let ip = Math.floor(pos);
        let fq = pos - ip;
        let r0 = diff[o + (ip & dmask)];
        let vd = r0 + (diff[o + ((ip + 1) & dmask)] - r0) * fq;
        let vv = a - gk * vd;
        diff[o + wd] = vv;
        a = gk * vv + vd;
        o += 4 * DS;
        pos = wd - diffLen[4 + k];
        ip = Math.floor(pos);
        fq = pos - ip;
        r0 = diff[o + (ip & dmask)];
        vd = r0 + (diff[o + ((ip + 1) & dmask)] - r0) * fq;
        vv = b - gk * vd;
        diff[o + wd] = vv;
        b = gk * vv + vd;
      }
      const we = w & emask;
      early[we] = a; early[ES + we] = b;
      // early reflections
      let eL = 0, eR = 0;
      for (let k = 0; k < 2 * ER_TAPS; k++) {
        const pos = we - (erPos0[k] + erDelta[k] * fr);
        const ip = Math.floor(pos);
        const fq = pos - ip;
        const o = erOff[k];
        const r0 = early[o + (ip & emask)];
        const v = erG[k] * (r0 + (early[o + ((ip + 1) & emask)] - r0) * fq);
        if (k < ER_TAPS) eL += v; else eR += v;
      }
      // late: read + absorb
      const wl = w & lmask;
      let lateL = 0, lateR = 0;
      for (let i = 0; i < N; i++) {
        const pos = wl - (dCur[i] + dSlope[i] * fr);
        const ip = Math.floor(pos);
        const fq = pos - ip;
        const o = i * LS;
        const ym1 = lines[o + ((ip - 1) & lmask)], y0 = lines[o + (ip & lmask)];
        const y1 = lines[o + ((ip + 1) & lmask)], y2 = lines[o + ((ip + 2) & lmask)];
        const r = ((((0.5 * (y2 - ym1) + 1.5 * (y0 - y1)) * fq + (ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2)) * fq + 0.5 * (y1 - ym1)) * fq) + y0;
        const vv = (r - lpS[i]) * dampG;
        const l = vv + lpS[i];
        lpS[i] = l + vv;
        const yi = gHF[i] * r + (gDC[i] - gHF[i]) * l;
        y[i] = yi;
        lateL += oL[i] * yi;
        lateR += oR[i] * yi;
      }
      // fast Walsh–Hadamard transform (unnormalised; ×¼ applied at write-back → orthonormal)
      {
        let x0 = y[0], x1 = y[1], x2 = y[2], x3 = y[3], x4 = y[4], x5 = y[5], x6 = y[6], x7 = y[7];
        let x8 = y[8], x9 = y[9], x10 = y[10], x11 = y[11], x12 = y[12], x13 = y[13], x14 = y[14], x15 = y[15];
        let t;
        t = x0; x0 += x1; x1 = t - x1; t = x2; x2 += x3; x3 = t - x3; t = x4; x4 += x5; x5 = t - x5; t = x6; x6 += x7; x7 = t - x7;
        t = x8; x8 += x9; x9 = t - x9; t = x10; x10 += x11; x11 = t - x11; t = x12; x12 += x13; x13 = t - x13; t = x14; x14 += x15; x15 = t - x15;
        t = x0; x0 += x2; x2 = t - x2; t = x1; x1 += x3; x3 = t - x3; t = x4; x4 += x6; x6 = t - x6; t = x5; x5 += x7; x7 = t - x7;
        t = x8; x8 += x10; x10 = t - x10; t = x9; x9 += x11; x11 = t - x11; t = x12; x12 += x14; x14 = t - x14; t = x13; x13 += x15; x15 = t - x15;
        t = x0; x0 += x4; x4 = t - x4; t = x1; x1 += x5; x5 = t - x5; t = x2; x2 += x6; x6 = t - x6; t = x3; x3 += x7; x7 = t - x7;
        t = x8; x8 += x12; x12 = t - x12; t = x9; x9 += x13; x13 = t - x13; t = x10; x10 += x14; x14 = t - x14; t = x11; x11 += x15; x15 = t - x15;
        y[0] = x0 + x8; y[8] = x0 - x8; y[1] = x1 + x9; y[9] = x1 - x9; y[2] = x2 + x10; y[10] = x2 - x10; y[3] = x3 + x11; y[11] = x3 - x11;
        y[4] = x4 + x12; y[12] = x4 - x12; y[5] = x5 + x13; y[13] = x5 - x13; y[6] = x6 + x14; y[14] = x6 - x14; y[7] = x7 + x15; y[15] = x7 - x15;
      }
      // shimmer: octave-up dual-grain shifter, blended per line. Windows sin²/cos² sum to 1 and the blend is
      // convex, so |out| ≤ max(|in|, |shifted|); the gain compensation c is capped so that c·gDC ≤ 0.998 —
      // the loop stays strictly contractive for any signal.
      if (shimOn) {
        const ws = w & smask;
        for (let q = 0; q < NSH; q++) {
          const li = SHIM_LINES[q];
          const m = y[li] * 0.25;
          // anti-alias LP (2 × biquad, TDF2)
          const zo = q * 4;
          let f = b0 * m + shZ[zo];
          shZ[zo] = b1 * m - a1 * f + shZ[zo + 1];
          shZ[zo + 1] = b2 * m - a2 * f;
          const f2 = c0 * f + shZ[zo + 2];
          shZ[zo + 2] = c1 * f - e1 * f2 + shZ[zo + 3];
          shZ[zo + 3] = c2 * f - e2 * f2;
          const so = q * SS;
          shBuf[so + ws] = f2;
          const GW = GWa[q], invGW = invGWa[q];
          let c = shCnt[q];
          let cB = c + (GW >> 1); if (cB >= GW) cB -= GW;
          const ra = shBuf[so + ((ws - (2 + GW - c)) & smask)];
          const rb = shBuf[so + ((ws - (2 + GW - cB)) & smask)];
          const pu = c * invGW, qu = pu * (1 - pu);
          const sa = (16 * qu) / (5 - 4 * qu); // Bhaskara sin(π·p)
          const wa = sa * sa;
          const ps = ra * wa + rb * (1 - wa);
          c++; if (c >= GW) c = 0;
          shCnt[q] = c;
          const sq = shS0[q] + (shS1[q] - shS0[q]) * fr;
          const cq = shC0[q] + (shC1[q] - shC0[q]) * fr;
          y[li] = (m + (ps - m) * sq) * cq * 4;
        }
      }
      // write back with injection
      for (let i = 0; i < N; i++) {
        const yi = y[i] * guardScale;
        energy += yi * yi;
        lines[i * LS + wl] = yi + injS[i] * ((i & 1) ? b : a) * 0.5 + DENORMAL;
      }
      w = (w + 1) | 0;
      if (w >= 0x40000000) w = 0; // keep index small; all masks are powers of two dividing 2^30
      // output
      let wetL = lateL * gLate + eL * gEr;
      let wetR = lateR * gLate + eR * gEr;
      const mid = (wetL + wetR) * 0.5, side = (wetL - wetR) * 0.5 * gWidth;
      wetL = mid + side; wetR = mid - side;
      const aw = (wetL < 0 ? -wetL : wetL) + (wetR < 0 ? -wetR : wetR);
      if (aw > peak) peak = aw;
      const dry = gDry + (1 - gDry) * (1 - inG);
      L[s] = xL * dry + wetL * gWet;
      R[s] = xR * dry + wetR * gWet;
      gDry += dDry; gWet += dWet; gWidth += dWidth; gLate += dLate; gEr += dEr;
    }
    this.w = w; this.inG = inG;
    // (flush the input filter states: silent input decays them geometrically into the subnormal range)
    const DN = DENORMAL;
    this.hpL = hpL > DN || hpL < -DN ? hpL : 0; this.hpR = hpR > DN || hpR < -DN ? hpR : 0;
    this.bwL = bwL > DN || bwL < -DN ? bwL : 0; this.bwR = bwR > DN || bwR < -DN ? bwR : 0;

    // loop energy guard: never engages in normal use (line RMS > +18 dBFS), but makes runaway impossible
    const ms = energy / (n * N);
    if (ms > 64) this.guard = Math.max(0.5, this.guard * 0.97);
    else if (this.guard < 1) this.guard = Math.min(1, this.guard + 0.0005);

    if (peak < 6e-6) this.quiet += n; else this.quiet = 0;
    if (!on && inG === 0 && this.quiet > 0.35 * sr + this.preS) {
      this.lines.fill(0); this.pre.fill(DENORMAL); this.diff.fill(0); this.early.fill(0); this.shBuf.fill(0);
      this.lpS.fill(0); this.shZ.fill(0);
      this.active = false;
    }
  }


  /** Shimmer amount → per-shifter blend (lines engage one after another) + capped loss compensation. */
  shimTargets(sDst, cDst) {
    const x = this.shim * NSH;
    for (let q = 0; q < NSH; q++) {
      let sq = x - q;
      sq = sq < 0 ? 0 : sq > 1 ? 1 : sq;
      if (sq < 1e-4) sq = 0;
      sDst[q] = sq;
      // expected power of the blend for uncorrelated in/shifted signals (shifter power ≈ 0.75)
      const pw = (1 - sq) * (1 - sq) + 0.75 * sq * sq;
      const want = 1 / Math.sqrt(pw);
      const g = this.gMax; // ||D·A·G|| ≤ max(c)·max(gDC): cap against the loudest line
      const cap = 0.998 / (g > 1e-6 ? g : 1e-6);
      cDst[q] = want < cap ? want : cap;
    }
  }

  updateDiffLen() {
    const s = (0.35 + 0.65 * this.sizeN) * 0.001 * this.sr;
    for (let k = 0; k < 4; k++) {
      this.diffLen[k] = Math.max(2, DIFF_MS_L[k] * s);
      this.diffLen[4 + k] = Math.max(2, DIFF_MS_R[k] * s);
    }
  }

  updateER(dst) {
    const s = this.sizeMs * 0.001 * this.sr;
    const lim = this.ES - 4;
    for (let k = 0; k < 2 * ER_TAPS; k++) {
      let p = this.erT[k] * s;
      if (p < 1) p = 1; else if (p > lim) p = lim;
      dst[k] = p;
    }
  }
}
