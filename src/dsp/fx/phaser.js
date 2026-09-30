// Phaser: 4/6/8/12 first-order TPT all-pass stages per channel, exponential sweep (200 Hz – 8 kHz at full
// depth, centred on ~1.26 kHz), stereo quadrature LFO, soft-limited feedback. Stage coefficients are
// computed at chunk boundaries and interpolated per sample (smooth, no zipper). Stage-count changes dip the
// wet signal for a few ms instead of clicking. The feedback path is DC-blocked (~25 Hz).
import { idx } from '../params.js';
import { DENORMAL } from '../util.js';

const STAGES = [4, 6, 8, 12];
const MAXST = 12;
const TWO_PI = Math.PI * 2;
const F_CENTER = Math.sqrt(200 * 8000);
const LOG_SPAN = Math.log(8000 / 200) * 0.5; // ± half the log span at depth 1

export class Phaser {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.iOn = idx('phaser.on');
    this.iRate = idx('phaser.rate');
    this.iDepth = idx('phaser.depth');
    this.iFb = idx('phaser.feedback');
    this.iStages = idx('phaser.stages');
    this.iMix = idx('phaser.mix');

    this.sL = new Float64Array(MAXST);
    this.sR = new Float64Array(MAXST);
    this.ph = 0.5;
    this.gL0 = 0.5; this.gL1 = 0.5; this.gR0 = 0.5; this.gR1 = 0.5; // TPT G = g/(1+g), interpolated
    this.yL = 0.5; this.yR = 0.5;
    this.fadeStep = 1 / (0.02 * sampleRate);
    this.swStep = 1 / (0.008 * sampleRate);
    this.onG = 0.5; this.sw = 1.5; this.nst = 6;
    this.active = false; this.inited = false;
    this.rate = 0.3; this.depth = 0.7; this.fb = 0.4; this.mix = 0.5;
    this.gMix = 0.5; this.gFb = 0.4;
    this.hzL = 0.5; this.hzR = 0.5;
    this.fMax = 0.45 * sampleRate;
    const h = Math.tan((Math.PI * 25) / sampleRate);
    this.hpG = h / (1 + h);
    this.reset();
  }

  reset() {
    this.sL.fill(0); this.sR.fill(0);
    this.ph = 0; this.yL = this.yR = 0; this.hzL = this.hzR = 0;
    this.onG = 0; this.sw = 1; this.active = false; this.inited = false;
  }

  tailActive() { return this.active; }

  /** Stage coefficients (TPT G) for the current LFO phase → gL1 / gR1 (R in quadrature). */
  updateCoefs() {
    const k = LOG_SPAN * this.depth, sr = this.sr;
    let f = F_CENTER * Math.exp(k * Math.sin(TWO_PI * this.ph));
    if (f > this.fMax) f = this.fMax;
    let g = Math.tan((Math.PI * f) / sr);
    this.gL1 = g / (1 + g);
    f = F_CENTER * Math.exp(k * Math.sin(TWO_PI * (this.ph + 0.25)));
    if (f > this.fMax) f = this.fMax;
    g = Math.tan((Math.PI * f) / sr);
    this.gR1 = g / (1 + g);
  }

  process(L, R, off, n, eff) {
    const on = eff[this.iOn] >= 0.5 ? 1 : 0;
    if (!this.active) {
      if (!on) return;
      this.active = true;
      this.sL.fill(0); this.sR.fill(0); this.yL = this.yR = 0; this.hzL = this.hzR = 0;
      this.onG = 0; this.sw = 1;
      this.nst = STAGES[Math.max(0, Math.min(3, eff[this.iStages] | 0))];
      this.inited = false;
    }
    const tRate = eff[this.iRate], tDepth = eff[this.iDepth], tFb = eff[this.iFb], tMix = eff[this.iMix];
    if (!this.inited) {
      this.rate = tRate; this.depth = tDepth; this.fb = tFb; this.mix = tMix;
      this.gMix = tMix; this.gFb = tFb;
      this.updateCoefs();
      this.inited = true;
    }
    const k = 1 - Math.exp(-n / (0.04 * this.sr));
    this.rate += (tRate - this.rate) * k;
    this.depth += (tDepth - this.depth) * k;
    this.fb += (tFb - this.fb) * k;
    this.mix += (tMix - this.mix) * k;

    this.ph += (this.rate * n) / this.sr;
    this.ph -= Math.floor(this.ph);
    this.gL0 = this.gL1; this.gR0 = this.gR1;
    this.updateCoefs();
    const inv = 1 / n;
    const dGL = (this.gL1 - this.gL0) * inv, dGR = (this.gR1 - this.gR0) * inv;
    let gL = this.gL0, gR = this.gR0;
    const dMix = (this.mix - this.gMix) * inv, dFb = (this.fb - this.gFb) * inv;
    let gMix = this.gMix, gFb = this.gFb;

    const tSt = STAGES[Math.max(0, Math.min(3, eff[this.iStages] | 0))];
    const nst = this.nst;
    const sL = this.sL, sR = this.sR;
    let yL = this.yL, yR = this.yR, onG = this.onG, sw = this.sw;
    let hzL = this.hzL, hzR = this.hzR;
    const hpG = this.hpG;
    const fadeStep = this.fadeStep, swStep = this.swStep;
    let switched = false;

    for (let i = off, end = off + n; i < end; i++) {
      const xL = L[i], xR = R[i];
      if (on) { onG += fadeStep; if (onG > 1) onG = 1; } else { onG -= fadeStep; if (onG < 0) onG = 0; }
      if (tSt !== nst && !switched) { sw -= swStep; if (sw <= 0) { sw = 0; switched = true; } }
      else if (!switched && sw < 1) { sw += swStep; if (sw > 1) sw = 1; }

      // feedback: DC-blocked (≈25 Hz one-pole HP, no low-end boom) and soft-limited
      let v0 = (yL - hzL) * hpG; let l0 = v0 + hzL; hzL = l0 + v0;
      let q = (yL - l0) * gFb * 1.1;
      q = q > 3 ? 1 : q < -3 ? -1 : (q * (27 + q * q)) / (27 + 9 * q * q);
      let a = xL + q * 0.909;
      v0 = (yR - hzR) * hpG; l0 = v0 + hzR; hzR = l0 + v0;
      q = (yR - l0) * gFb * 1.1;
      q = q > 3 ? 1 : q < -3 ? -1 : (q * (27 + q * q)) / (27 + 9 * q * q);
      let b = xR + q * 0.909;
      for (let s = 0; s < nst; s++) {
        let v = (a - sL[s]) * gL; let lp = v + sL[s]; sL[s] = lp + v; a = 2 * lp - a;
        v = (b - sR[s]) * gR; lp = v + sR[s]; sR[s] = lp + v; b = 2 * lp - b;
      }
      yL = a + DENORMAL; yR = b + DENORMAL;
      const oL = xL + (yL - xL) * gMix;
      const oR = xR + (yR - xR) * gMix;
      const e = onG * onG * (3 - 2 * onG) * sw * sw * (3 - 2 * sw);
      L[i] = xL + (oL - xL) * e;
      R[i] = xR + (oR - xR) * e;
      gL += dGL; gR += dGR; gMix += dMix; gFb += dFb;
    }
    this.gMix = this.mix; this.gFb = this.fb;
    this.yL = yL; this.yR = yR; this.onG = onG; this.sw = sw;
    this.hzL = hzL; this.hzR = hzR;
    if (switched) {
      this.nst = tSt;
      this.sL.fill(0); this.sR.fill(0); this.yL = this.yR = 0;
    }
    if (!on && onG <= 0) this.active = false;
  }
}
