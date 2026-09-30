// Chorus / Ensemble / Flanger.
//  chorus   : 2 modulated voices per channel (4 taps, quadrature LFO phases across L/R), optional feedback.
//  ensemble : string-ensemble style — 3 taps per channel at 120° LFO spacing, each driven by a slow + fast
//             LFO sum (Solina/Juno feel); R uses the opposite phase set; BBD-ish 2-pole low-pass on the wet.
//  flanger  : one short swept tap per channel (quadrature L/R), resonant feedback with damping, DC block
//             and soft clip.
// Cubic Hermite fractional reads (inlined); delay targets evaluated per chunk and ramped per sample (no
// zipper). On activation the line pre-fills for 24 ms before the wet fades in (no "empty buffer" step);
// mode changes dip the wet for 10 ms. Allocation-free hot loop.
import { idx } from '../params.js';
import { DENORMAL } from '../util.js';
import { nextPow2 } from './common.js';

const M_CHORUS = 0, M_ENSEMBLE = 1, M_FLANGER = 2;
const TWO_PI = Math.PI * 2;
const MAXTAPS = 3;
const NTAPS = [2, 3, 1];
const TAP_GAIN = [0.7071, 0.5774, 1];

export class Chorus {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.iOn = idx('chorus.on');
    this.iMode = idx('chorus.mode');
    this.iRate = idx('chorus.rate');
    this.iDepth = idx('chorus.depth');
    this.iFb = idx('chorus.feedback');
    this.iMix = idx('chorus.mix');

    this.size = nextPow2(Math.ceil(0.06 * sampleRate) + 8);
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size * 2); // L ring at 0, R ring at size
    this.w = 0;

    // per-channel tap delays (samples) at chunk start / slope across the chunk: [ch*MAXTAPS + t]
    this.d0 = new Float64Array(2 * MAXTAPS);
    this.d1 = new Float64Array(2 * MAXTAPS);
    this.dd = new Float64Array(2 * MAXTAPS);
    this.phSlow = 0.5; // LFO phases (cycles)
    this.phFast = 0.5;

    this.fadeStep = 1 / (0.02 * sampleRate);
    this.swStep = 1 / (0.01 * sampleRate);
    this.onG = 0.5; this.sw = 1.5; this.mode = 0; this.prefill = 0;
    this.active = false; this.inited = false;
    this.rate = 0.6; this.depth = 0.5; this.fb = 0.5; this.mix = 0.5;
    this.gDry = 1.5; this.gWet = 0.5; this.gFb = 0.5;

    this.fbL = 0.5; this.fbR = 0.5;      // feedback sample (post damping)
    this.dampL = 0.5; this.dampR = 0.5;  // flanger feedback damping LP state
    const gd = Math.tan(Math.PI * Math.min(9000, 0.4 * sampleRate) / sampleRate);
    this.dampG = gd / (1 + gd);
    const gh = Math.tan((Math.PI * 20) / sampleRate);
    this.hpG = gh / (1 + gh);
    this.hzL = 0.5; this.hzR = 0.5;
    // BBD-ish wet low-pass (2-pole TPT SVF, ~8.5 kHz, Q 0.6) for ensemble
    const gb = Math.tan(Math.PI * Math.min(8500, 0.4 * sampleRate) / sampleRate);
    const kb = 1 / 0.6;
    this.bbG = gb;
    this.bbA1 = 1 / (1 + gb * (gb + kb));
    this.bs = new Float64Array(4); // ic1L, ic2L, ic1R, ic2R
    this.reset();
  }

  reset() {
    this.buf.fill(0);
    this.w = 0;
    this.phSlow = 0; this.phFast = 0;
    this.fbL = this.fbR = this.dampL = this.dampR = this.hzL = this.hzR = 0;
    this.bs.fill(0);
    this.onG = 0; this.sw = 1; this.prefill = 0; this.active = false; this.inited = false;
  }

  tailActive() { return this.active; }

  /** Tap delays (samples) for the current LFO phases, mode and depth → `this.d1`. */
  computeDelays() {
    const dst = this.d1, sr = this.sr, s = this.phSlow, f = this.phFast, depth = this.depth, mode = this.mode;
    if (mode === M_CHORUS) {
      const md = (0.25 + 3.6 * depth) * 0.001 * sr;
      // L: voices at phase 0, 0.5 ; R: 0.25, 0.75 (quadrature spread)
      dst[0] = 0.0075 * sr + md * Math.sin(TWO_PI * s);
      dst[1] = 0.0112 * sr + md * Math.sin(TWO_PI * (s + 0.5));
      dst[2] = 0.0075 * sr;
      dst[3] = 0.0083 * sr + md * Math.sin(TWO_PI * (s + 0.25));
      dst[4] = 0.0101 * sr + md * Math.sin(TWO_PI * (s + 0.75));
      dst[5] = 0.0083 * sr;
    } else if (mode === M_ENSEMBLE) {
      const ms = (0.35 + 3.2 * depth) * 0.001 * sr;   // slow sweep depth
      const mf = (0.08 + 0.32 * depth) * 0.001 * sr;  // fast vibrato depth
      const base = 0.0105 * sr;
      for (let t = 0; t < 3; t++) {
        const p = t / 3;
        dst[t] = base + ms * Math.sin(TWO_PI * (s + p)) + mf * Math.sin(TWO_PI * (f + p));
        dst[3 + t] = base + ms * Math.sin(TWO_PI * (s + p + 0.5)) + mf * Math.sin(TWO_PI * (f + p + 0.5));
      }
    } else {
      const lo = 0.00025 * sr, span = (0.3 + 5.5 * depth) * 0.001 * sr;
      const a = 0.5 - 0.5 * Math.cos(TWO_PI * s);
      const b = 0.5 - 0.5 * Math.cos(TWO_PI * (s + 0.25));
      // squared sweep: more time near the short end sounds like a classic flanger
      dst[0] = lo + span * a * a;
      dst[3] = lo + span * b * b;
      dst[1] = dst[2] = dst[0];
      dst[4] = dst[5] = dst[3];
    }
  }

  /** Dry/wet/feedback gains for the current mode and smoothed mix/feedback. */
  applyGains() {
    const m = this.mix;
    if (this.mode === M_FLANGER) {
      this.gDry = 1 - m; this.gWet = m; // linear: deepest notches at 0.5
      this.gFb = this.fb;
    } else {
      this.gDry = Math.pow(1 - m, 0.75); this.gWet = Math.pow(m, 0.75); // between linear and equal-power
      this.gFb = this.fb * 0.6; // chorus/ensemble: gentler regeneration
    }
  }

  process(L, R, off, n, eff) {
    const on = eff[this.iOn] >= 0.5 ? 1 : 0;
    if (!this.active) {
      if (!on) return;
      this.active = true;
      this.buf.fill(0);
      this.fbL = this.fbR = this.dampL = this.dampR = this.hzL = this.hzR = 0;
      this.bs.fill(0);
      this.onG = 0; this.sw = 1;
      this.prefill = Math.round(0.024 * this.sr); // let the delay line fill before fading the wet in
      this.mode = Math.max(0, Math.min(2, eff[this.iMode] | 0));
      this.inited = false;
    }
    const sr = this.sr;
    const tRate = eff[this.iRate], tDepth = eff[this.iDepth], tFb = eff[this.iFb], tMix = eff[this.iMix];
    if (!this.inited) {
      this.rate = tRate; this.depth = tDepth; this.fb = tFb; this.mix = tMix;
      this.computeDelays();
      this.applyGains();
      this.inited = true;
    }
    const k = 1 - Math.exp(-n / (0.04 * sr));
    this.rate += (tRate - this.rate) * k;
    this.depth += (tDepth - this.depth) * k;
    this.fb += (tFb - this.fb) * k;
    this.mix += (tMix - this.mix) * k;

    const tMode = Math.max(0, Math.min(2, eff[this.iMode] | 0));
    const mode = this.mode;
    // advance LFOs to the end of this chunk
    const slowHz = this.rate;
    const fastHz = mode === M_ENSEMBLE ? Math.min(12, 5.2 * Math.pow(this.rate / 0.6, 0.35)) : 0;
    this.phSlow += (slowHz * n) / sr; this.phSlow -= Math.floor(this.phSlow);
    this.phFast += (fastHz * n) / sr; this.phFast -= Math.floor(this.phFast);
    const d0 = this.d0, d1 = this.d1, dd = this.dd;
    for (let t = 0; t < 6; t++) d0[t] = d1[t];
    this.computeDelays();
    for (let t = 0; t < 6; t++) dd[t] = d1[t] - d0[t];
    const inv = 1 / n;

    const pDry = this.gDry, pWet = this.gWet, pFb = this.gFb;
    this.applyGains();
    const dDry = (this.gDry - pDry) * inv, dWet = (this.gWet - pWet) * inv, dFb = (this.gFb - pFb) * inv;
    let gDry = pDry, gWet = pWet, gFb = pFb;

    const buf = this.buf, mask = this.mask, size = this.size;
    let w = this.w;
    let onG = this.onG, sw = this.sw, prefill = this.prefill;
    const fadeStep = this.fadeStep, swStep = this.swStep;
    let fbL = this.fbL, fbR = this.fbR, dampL = this.dampL, dampR = this.dampR;
    let hzL = this.hzL, hzR = this.hzR;
    const dg = this.dampG, hpG = this.hpG;
    const bs = this.bs, bbG = this.bbG, bbA1 = this.bbA1;
    const ntaps = NTAPS[mode], tapGain = TAP_GAIN[mode];
    let switched = false;

    for (let i = off, end = off + n, j = 0; i < end; i++, j++) {
      const xL = L[i], xR = R[i];
      if (on) { if (prefill > 0) prefill--; else { onG += fadeStep; if (onG > 1) onG = 1; } }
      else { onG -= fadeStep; if (onG < 0) onG = 0; }
      if (tMode !== mode && !switched) {
        sw -= swStep;
        if (sw <= 0) { sw = 0; switched = true; }
      } else if (!switched && sw < 1) { sw += swStep; if (sw > 1) sw = 1; }

      buf[w] = xL + fbL * gFb + DENORMAL;
      buf[size + w] = xR + fbR * gFb + DENORMAL;
      const fr = j * inv;
      // modulated taps, Hermite-interpolated (inlined)
      let wL = 0, wR = 0;
      for (let c = 0; c < 2; c++) {
        const bo = c * size, to = c * MAXTAPS;
        let acc = 0;
        for (let t = 0; t < ntaps; t++) {
          const pos = w - (d0[to + t] + dd[to + t] * fr);
          const ip = Math.floor(pos);
          const fq = pos - ip;
          const ym1 = buf[bo + ((ip - 1) & mask)], y0 = buf[bo + (ip & mask)];
          const y1 = buf[bo + ((ip + 1) & mask)], y2 = buf[bo + ((ip + 2) & mask)];
          acc += ((((0.5 * (y2 - ym1) + 1.5 * (y0 - y1)) * fq + (ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2)) * fq + 0.5 * (y1 - ym1)) * fq) + y0;
        }
        if (c === 0) wL = acc * tapGain; else wR = acc * tapGain;
      }
      if (mode === M_CHORUS) {
        fbL = wL; fbR = wR;
      } else if (mode === M_ENSEMBLE) {
        // BBD-flavoured 2-pole low-pass (TPT SVF LP)
        let v3 = wL - bs[1], v1 = bbA1 * bs[0] + bbG * bbA1 * v3, v2 = bs[1] + bbG * v1;
        bs[0] = 2 * v1 - bs[0]; bs[1] = 2 * v2 - bs[1]; wL = v2;
        v3 = wR - bs[3]; v1 = bbA1 * bs[2] + bbG * bbA1 * v3; v2 = bs[3] + bbG * v1;
        bs[2] = 2 * v1 - bs[2]; bs[3] = 2 * v2 - bs[3]; wR = v2;
        fbL = wL; fbR = wR;
      } else {
        dampL += (wL - dampL) * dg; dampR += (wR - dampR) * dg;
        // DC-block the regeneration (≈20 Hz) so high feedback never booms at 0 Hz, then soft-clip
        let v0 = (dampL - hzL) * hpG; let l0 = v0 + hzL; hzL = l0 + v0;
        let q = (dampL - l0) * 1.2;
        q = q > 3 ? 1 : q < -3 ? -1 : (q * (27 + q * q)) / (27 + 9 * q * q);
        fbL = q * 0.8333;
        v0 = (dampR - hzR) * hpG; l0 = v0 + hzR; hzR = l0 + v0;
        q = (dampR - l0) * 1.2;
        q = q > 3 ? 1 : q < -3 ? -1 : (q * (27 + q * q)) / (27 + 9 * q * q);
        fbR = q * 0.8333;
      }
      w = (w + 1) & mask;
      const oL = xL * gDry + wL * gWet;
      const oR = xR * gDry + wR * gWet;
      const e = onG * onG * (3 - 2 * onG) * sw * sw * (3 - 2 * sw);
      L[i] = xL + (oL - xL) * e;
      R[i] = xR + (oR - xR) * e;
      gDry += dDry; gWet += dWet; gFb += dFb;
    }
    this.w = w;
    this.onG = onG; this.sw = sw; this.prefill = prefill;
    this.fbL = fbL; this.fbR = fbR; this.dampL = dampL; this.dampR = dampR;
    this.hzL = hzL; this.hzR = hzR;
    if (switched) {
      this.mode = tMode;
      this.fbL = this.fbR = this.dampL = this.dampR = this.hzL = this.hzR = 0;
      this.bs.fill(0);
      this.computeDelays();
      this.applyGains();
    }
    if (!on && onG <= 0) this.active = false;
  }
}
