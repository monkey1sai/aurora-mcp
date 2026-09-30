// Brickwall look-ahead peak limiter (master output).
//  • peak detector = max(|L|,|R|) plus an 8-tap windowed-sinc half-sample estimate (inter-sample peaks,
//    "true-peak-ish")
//  • soft-knee (2 dB) gain request so peaks just under the ceiling are touched gently
//  • sliding-window minimum over the look-ahead (monotonic deque), exponential release, then a box filter
//    of the same length → the gain ramps smoothly into every peak and is provably ≤ the request at the
//    moment the (delayed) peak is output.
//  • final safety clamp at the ceiling + NaN/Inf sanitising: the output can never exceed the ceiling.
import { dbToGain, gainToDb } from '../util.js';
import { nextPow2 } from './common.js';

const KNEE_DB = 2;

export class Limiter {
  constructor(sampleRate, { ceilingDb = -0.3, lookaheadMs = 1.5, releaseMs = 90 } = {}) {
    this.sr = sampleRate;
    this.ceilDb = ceilingDb;
    this.ceil = dbToGain(ceilingDb);
    this.kneeLo = dbToGain(ceilingDb - KNEE_DB / 2);
    this.La = Math.max(5, Math.round(lookaheadMs * 0.001 * sampleRate)); // ≥ 5: ISP estimate looks 4 back
    this.B = this.La + 1;
    this.AS = nextPow2(this.La + 4);
    this.amask = this.AS - 1;
    this.aL = new Float64Array(this.AS);
    this.aR = new Float64Array(this.AS);
    this.w = 0;
    // deque for sliding minimum
    this.DQ = nextPow2(this.B + 2);
    this.dqmask = this.DQ - 1;
    this.dqV = new Float64Array(this.DQ);
    this.dqT = new Float64Array(this.DQ);
    this.dqHead = 0; this.dqTail = 0;
    this.t = 0;
    // box filter
    this.box = new Float64Array(this.B);
    this.boxI = 0;
    this.sum = this.B;
    this.recalc = 0;
    this.env = 1;
    this.rel = 1 - Math.exp(-1 / (releaseMs * 0.001 * sampleRate));
    // inter-sample estimate: half-sample windowed-sinc interpolator over the last 8 samples
    this.isc = new Float64Array(4);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const x = k + 0.5;
      const c = (Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos((Math.PI * x) / 4.5));
      this.isc[k] = c; sum += 2 * c;
    }
    for (let k = 0; k < 4; k++) this.isc[k] /= sum;
    this.hL = new Float64Array(8);
    this.hR = new Float64Array(8);
    this.hi = 0;
    this.minGain = 1;
    this.reset();
  }

  reset() {
    this.aL.fill(0); this.aR.fill(0);
    this.w = 0;
    this.dqHead = this.dqTail = 0;
    this.t = 0;
    this.box.fill(1);
    this.boxI = 0;
    this.sum = this.B;
    this.env = 1;
    this.hL.fill(0); this.hR.fill(0); this.hi = 0;
    this.minGain = 1;
  }

  /** Current gain reduction in dB (≤ 0): the deepest reduction applied during the last process() call. */
  getReduction() { return this.minGain >= 1 ? 0 : gainToDb(this.minGain); }

  /** Output latency in samples. */
  get latency() { return this.La; }

  request(p) {
    if (p <= this.kneeLo) return 1;
    const xdB = 20 * Math.log10(p);
    const over = xdB - this.ceilDb;
    let ydB;
    if (over >= KNEE_DB / 2) ydB = this.ceilDb;
    else {
      const u = over + KNEE_DB / 2;
      ydB = xdB - (u * u) / (2 * KNEE_DB);
    }
    return Math.pow(10, (ydB - xdB) / 20);
  }

  /** In place on L/R[off .. off+n). */
  process(L, R, n, off = 0) {
    const ceil = this.ceil, La = this.La, B = this.B, kneeLo = this.kneeLo, ceilDb = this.ceilDb;
    const aL = this.aL, aR = this.aR, amask = this.amask;
    const dqV = this.dqV, dqT = this.dqT, dqmask = this.dqmask;
    const box = this.box, rel = this.rel;
    let w = this.w, head = this.dqHead, tail = this.dqTail, t = this.t;
    let boxI = this.boxI, sum = this.sum, env = this.env;
    const hL = this.hL, hR = this.hR, isc = this.isc;
    const c0 = isc[0], c1 = isc[1], c2 = isc[2], c3 = isc[3];
    let hi = this.hi;
    let minGain = 1;
    for (let i = off, end = off + n; i < end; i++) {
      let xl = L[i], xr = R[i];
      // sanitise (NaN → 0, ±Inf → large finite)
      if (!(xl > -1e4 && xl < 1e4)) xl = xl !== xl ? 0 : xl > 0 ? 1e4 : -1e4;
      if (!(xr > -1e4 && xr < 1e4)) xr = xr !== xr ? 0 : xr > 0 ? 1e4 : -1e4;
      // peak incl. the half-sample value between x[t-4] and x[t-3] (8-tap sinc over x[t-7..t])
      hL[hi] = xl; hR[hi] = xr;
      const i0 = hi, i1 = (hi - 1) & 7, i2 = (hi - 2) & 7, i3 = (hi - 3) & 7;
      const i4 = (hi - 4) & 7, i5 = (hi - 5) & 7, i6 = (hi - 6) & 7, i7 = (hi - 7) & 7;
      const mL = c0 * (hL[i3] + hL[i4]) + c1 * (hL[i2] + hL[i5]) + c2 * (hL[i1] + hL[i6]) + c3 * (hL[i0] + hL[i7]);
      const mR = c0 * (hR[i3] + hR[i4]) + c1 * (hR[i2] + hR[i5]) + c2 * (hR[i1] + hR[i6]) + c3 * (hR[i0] + hR[i7]);
      hi = (hi + 1) & 7;
      let p = xl < 0 ? -xl : xl;
      let q = xr < 0 ? -xr : xr;
      if (q > p) p = q;
      q = mL < 0 ? -mL : mL; if (q > p) p = q;
      q = mR < 0 ? -mR : mR; if (q > p) p = q;
      // soft-knee gain request (inlined; only computed above the knee)
      let g = 1;
      if (p > kneeLo) {
        const xdB = 20 * Math.log10(p);
        const over = xdB - ceilDb;
        let ydB;
        if (over >= KNEE_DB / 2) ydB = ceilDb;
        else { const u = over + KNEE_DB / 2; ydB = xdB - (u * u) / (2 * KNEE_DB); }
        g = Math.pow(10, (ydB - xdB) / 20);
      }
      // sliding min over the last B requests
      while (tail !== head && dqV[(tail - 1) & dqmask] >= g) tail--;
      dqV[tail & dqmask] = g; dqT[tail & dqmask] = t; tail++;
      while (dqT[head & dqmask] <= t - B) head++;
      const hmin = dqV[head & dqmask];
      // release (instant attack; the box filter provides the smooth ramp)
      env = hmin < env ? hmin : env + (hmin - env) * rel;
      // box average
      sum += env - box[boxI];
      box[boxI] = env;
      boxI++; if (boxI >= B) boxI = 0;
      let gain = sum / B;
      if (gain > 1) gain = 1;
      if (gain < minGain) minGain = gain;
      // delayed audio
      const wi = w & amask;
      aL[wi] = xl; aR[wi] = xr;
      const ri = (w - La) & amask;
      let yl = aL[ri] * gain, yr = aR[ri] * gain;
      if (yl > ceil) yl = ceil; else if (yl < -ceil) yl = -ceil;
      if (yr > ceil) yr = ceil; else if (yr < -ceil) yr = -ceil;
      L[i] = yl; R[i] = yr;
      w = (w + 1) & 0x3fffffff;
      t++;
    }
    // keep counters bounded (multiples of the ring size keep masks valid) & re-sum the box to cancel drift
    if (head >= 0x40000000) { const sh = head & ~dqmask; head -= sh; tail -= sh; }
    if (++this.recalc >= 64) {
      this.recalc = 0;
      let s = 0;
      for (let k = 0; k < B; k++) s += box[k];
      sum = s;
    }
    this.w = w; this.dqHead = head; this.dqTail = tail; this.t = t;
    this.boxI = boxI; this.sum = sum; this.env = env;
    this.hi = hi;
    this.minGain = minGain;
  }
}
