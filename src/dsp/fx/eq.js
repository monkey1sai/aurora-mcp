// 3-band EQ: RBJ low shelf (120 Hz), peaking band at eq.midfreq (Q 0.9), high shelf (8 kHz).
// Gains/frequency are smoothed per chunk; a band whose gain is (and stays) 0 dB is skipped entirely, so the
// whole EQ costs ~nothing when flat. A flat RBJ biquad in TDF-II has zero state, so skipping/resuming is exact.
import { idx } from '../params.js';
import { rbjLowShelf, rbjPeak, rbjHighShelf } from './common.js';

const F_LOW = 120, F_HIGH = 8000, Q_MID = 0.9;
const EPS_DB = 0.005;

export class EQ {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.iLow = idx('eq.low');
    this.iMid = idx('eq.mid');
    this.iFreq = idx('eq.midfreq');
    this.iHigh = idx('eq.high');
    this.g = new Float64Array(3);     // smoothed dB
    this.f = 1000;                    // smoothed mid freq
    this.coef = new Float64Array(15); // 3 × [b0 b1 b2 a1 a2]
    this.prev = new Float64Array(15);
    this.z = new Float64Array(12);    // 3 bands × 2 ch × 2 states
    this.on = new Uint8Array(3);
    this.busy = false; // any band still non-flat (smoothing toward 0 included)
    this.fHigh = Math.min(F_HIGH, 0.42 * sampleRate);
    // start flat and "initialised" so the first non-zero gain glides in from 0 dB (FxChain skips a flat EQ,
    // so the first call can come long after construction); reset() snaps to the targets instead
    for (let b = 0; b < 3; b++) this.design(b, this.coef, b * 5);
    this.inited = true;
  }

  reset() {
    this.z.fill(0);
    this.on.fill(0);
    this.busy = false;
    this.inited = false;
  }

  tailActive() { return false; }

  design(band, dst, o) {
    const sr = this.sr;
    if (band === 0) rbjLowShelf(dst, o, F_LOW, this.g[0], sr);
    else if (band === 1) rbjPeak(dst, o, this.f, Q_MID, this.g[1], sr);
    else rbjHighShelf(dst, o, this.fHigh, this.g[2], sr);
  }

  process(L, R, off, n, eff) {
    const tL = eff[this.iLow], tM = eff[this.iMid], tH = eff[this.iHigh], tF = eff[this.iFreq];
    const g = this.g;
    if (!this.inited) {
      g[0] = tL; g[1] = tM; g[2] = tH; this.f = tF;
      for (let b = 0; b < 3; b++) this.design(b, this.coef, b * 5);
      this.inited = true;
    }
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && tL === 0 && tM === 0 && tH === 0) {
      this.on.fill(0);
      this.busy = false;
      return;
    }
    this.busy = true;
    const k = 1 - Math.exp(-n / (0.03 * this.sr));
    const tg0 = tL, tg1 = tM, tg2 = tH;
    const coef = this.coef, prev = this.prev, z = this.z;
    const inv = 1 / n;
    for (let b = 0; b < 3; b++) {
      const t = b === 0 ? tg0 : b === 1 ? tg1 : tg2;
      const old = g[b];
      let nv = old + (t - old) * k;
      if (Math.abs(t - nv) < 1e-4) nv = t;
      if (Math.abs(nv) < EPS_DB && t === 0) nv = 0;
      g[b] = nv;
      const moved = nv !== old || (b === 1 && this.f !== tF);
      if (nv === 0 && old === 0) { // flat band: skip
        if (this.on[b]) { this.on[b] = 0; z[b * 4] = z[b * 4 + 1] = z[b * 4 + 2] = z[b * 4 + 3] = 0; }
        continue;
      }
      if (!this.on[b]) { this.on[b] = 1; z[b * 4] = z[b * 4 + 1] = z[b * 4 + 2] = z[b * 4 + 3] = 0; }
      const o = b * 5;
      for (let c = 0; c < 5; c++) prev[o + c] = coef[o + c];
      if (b === 1) {
        let nf = this.f + (tF - this.f) * k;
        if (Math.abs(tF - nf) < 0.01) nf = tF;
        this.f = nf;
      }
      if (moved) this.design(b, coef, o);
      // per-sample coefficient interpolation across the chunk (tiny chunks; stable for smooth moves)
      let b0 = prev[o], b1 = prev[o + 1], b2 = prev[o + 2], a1 = prev[o + 3], a2 = prev[o + 4];
      const db0 = (coef[o] - b0) * inv, db1 = (coef[o + 1] - b1) * inv, db2 = (coef[o + 2] - b2) * inv;
      const da1 = (coef[o + 3] - a1) * inv, da2 = (coef[o + 4] - a2) * inv;
      const zo = b * 4;
      let s1L = z[zo], s2L = z[zo + 1], s1R = z[zo + 2], s2R = z[zo + 3];
      for (let i = off, end = off + n; i < end; i++) {
        b0 += db0; b1 += db1; b2 += db2; a1 += da1; a2 += da2;
        const xl = L[i];
        const yl = b0 * xl + s1L;
        s1L = b1 * xl - a1 * yl + s2L;
        s2L = b2 * xl - a2 * yl;
        L[i] = yl;
        const xr = R[i];
        const yr = b0 * xr + s1R;
        s1R = b1 * xr - a1 * yr + s2R;
        s2R = b2 * xr - a2 * yr;
        R[i] = yr;
      }
      z[zo] = s1L; z[zo + 1] = s2L; z[zo + 2] = s1R; z[zo + 3] = s2R;
    }
    // keep the mid frequency tracking even while the band is flat
    if (!this.on[1]) this.f = tF;
  }
}
