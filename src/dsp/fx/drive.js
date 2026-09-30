// Drive: soft (tanh) / tube (asymmetric) / fold (sine wavefolder) / crush (bit + rate reduction).
// soft/tube/fold run at 2× with a polyphase IIR half-band (8 coefficients, >100 dB image rejection); the
// dry path is sent through an identical up/down pair so dry/wet blends stay phase-aligned. Auto-gain =
// static table (measured per type/amount at construction) × a slow adaptive in/out-RMS correction (so
// switching drive on keeps loudness within ~1.5 dB for real program material), tilt tone EQ after the
// shaper, DC blocker, mix, and a click-free (smoothstep) on/off + type-change crossfade.
// Hot loop is fully inlined (no calls with double arguments) → allocation-free under any JIT.
import { idx } from '../params.js';
import { fastTanh, DENORMAL } from '../util.js';
import { designHalfband } from './common.js';

const T_SOFT = 0, T_TUBE = 1, T_FOLD = 2, T_CRUSH = 3;
const TABLE_STEPS = 32;
const TUBE_BIAS = 0.3;
const HB = designHalfband(8, 0.04);
const HALF_PI = 1.5707963267948966;

// ── transfer curves (construction-time table building only; the audio loop inlines them) ──
function shapeTube(u) {
  // asymmetric: positive half saturates earlier than the negative half → even harmonics
  return u >= 0 ? fastTanh(u) : fastTanh(0.62 * u) * 1.6129;
}
const TUBE_OFS = shapeTube(TUBE_BIAS);

function preGainOf(type, amt) {
  switch (type) {
    case T_SOFT: return Math.pow(10, (amt * 34) / 20);          // 0 … +34 dB
    case T_TUBE: return Math.pow(10, (1 + amt * 29) / 20);      // +1 … +30 dB
    case T_FOLD: return 1 + amt * amt * 9 + amt * 2;            // 1 … 12
    default: return 1 + amt * 0.6;
  }
}

function shapeOne(type, u) {
  switch (type) {
    case T_SOFT: return fastTanh(u);
    case T_TUBE: return shapeTube(u + TUBE_BIAS) - TUBE_OFS;
    case T_FOLD: return Math.sin(u * HALF_PI);
    default: return u;
  }
}

// state layout per oversampler (32 doubles): up x[0..7] y[8..15], down x[16..23] y[24..31]
// oversamplers: 0 = wet L, 1 = wet R, 2 = dry L, 3 = dry R
const OS = 32;

export class Drive {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.iOn = idx('drive.on');
    this.iType = idx('drive.type');
    this.iAmt = idx('drive.amount');
    this.iTone = idx('drive.tone');
    this.iMix = idx('drive.mix');

    this.hb = HB;
    this.st = new Float64Array(4 * OS);
    this.res = new Float64Array(4);

    this.fadeStep = 1 / (0.02 * sampleRate); // 20 ms on/off
    this.swStep = 1 / (0.008 * sampleRate);  // 8 ms type-switch dip
    this.onG = 0.5;
    this.sw = 1;
    this.type = 0;
    this.active = false;

    this.amt = 0.3; this.tone = 0.5; this.mix = 1;
    this.inited = false;

    // per-sample ramps (set per chunk)
    this.gPre = 1.5; this.gComp = 1.5; this.gLo = 1.5; this.gHi = 1.5; this.gMix = 1.5;
    this.tPre = 1.5; this.tComp = 1.5; this.tHi = 1.5; this.tLo = 1.5; this.tMix = 1.5;
    this.msIn = 0.5; this.msOut = 0.5; this.corr = 1.5; this.tStatic = 1.5; this.bias = 1.5;
    this.measAmt = -1.5; this.hold = 0;

    // tone: one-pole split at ~900 Hz
    const g = Math.tan((Math.PI * 900) / sampleRate);
    this.toneG = g / (1 + g);
    this.tzL = 0.5; this.tzR = 0.5;
    // DC blocker (8 Hz)
    this.dcR = 1 - (2 * Math.PI * 8) / sampleRate;
    this.dxL = 0.5; this.dyL = 0.5; this.dxR = 0.5; this.dyR = 0.5;
    // crush
    this.hPh = 1.5; this.hL = 0.5; this.hR = 0.5;

    // auto-gain tables: rms(sine-ish −12 dBFS) / rms(shaped)
    this.comp = new Float64Array(4 * (TABLE_STEPS + 1));
    for (let t = 0; t < 4; t++) {
      for (let s = 0; s <= TABLE_STEPS; s++) {
        const a = s / TABLE_STEPS;
        const gp = preGainOf(t, a);
        let si = 0, so = 0, mo = 0;
        const N = 256;
        for (let k = 0; k < N; k++) {
          const x = 0.25 * Math.sin((2 * Math.PI * k) / N) + 0.08 * Math.sin((6 * Math.PI * k) / N + 0.7);
          const y = t === T_CRUSH ? x * gp : shapeOne(t, x * gp);
          si += x * x; so += y * y; mo += y;
        }
        mo /= N;
        so = so / N - mo * mo;
        const c = Math.sqrt(si / N) / Math.sqrt(Math.max(so, 1e-12));
        this.comp[t * (TABLE_STEPS + 1) + s] = Math.min(4, Math.max(0.05, c));
      }
    }
    this.reset();
  }

  reset() {
    this.st.fill(0);
    this.tzL = this.tzR = 0;
    this.dxL = this.dyL = this.dxR = this.dyR = 0;
    this.hPh = 1; this.hL = this.hR = 0;
    this.msIn = this.msOut = 0; this.corr = 1; this.measAmt = -1; this.hold = 0;
    this.onG = 0; this.sw = 1; this.active = false; this.inited = false;
  }

  tailActive() { return this.active; }

  /** Recompute per-chunk gain targets from the smoothed amount/tone/mix and current type (no arguments). */
  setTargets() {
    const t = this.type, a = this.amt;
    this.tPre = preGainOf(t, a);
    const p = a * TABLE_STEPS;
    const i = Math.min(TABLE_STEPS - 1, Math.floor(p));
    const f = p - i;
    const o = t * (TABLE_STEPS + 1);
    this.tStatic = this.comp[o + i] + (this.comp[o + i + 1] - this.comp[o + i]) * f;
    this.bias = Math.pow(10, (-1.5 * a) / 20); // added harmonics read louder at equal RMS
    this.tComp = this.tStatic * this.corr;
    const tiltDb = (this.tone - 0.5) * 2 * 8; // ±8 dB tilt around 900 Hz
    this.tHi = Math.pow(10, tiltDb / 40);
    this.tLo = 1 / this.tHi;
    this.tMix = this.mix;
  }

  process(L, R, off, n, eff) {
    const on = eff[this.iOn] >= 0.5 ? 1 : 0;
    if (!this.active) {
      if (!on) return;
      this.active = true;
      this.onG = 0;
      this.type = Math.max(0, Math.min(3, eff[this.iType] | 0));
      this.sw = 1;
      this.st.fill(0);
      this.tzL = this.tzR = 0; this.dxL = this.dyL = this.dxR = this.dyR = 0;
      this.msIn = this.msOut = 0; this.corr = 1;
      this.inited = false;
    }
    const sr = this.sr;
    const tAmt = eff[this.iAmt], tTone = eff[this.iTone], tMix = eff[this.iMix];
    if (!this.inited) {
      this.amt = tAmt; this.tone = tTone; this.mix = tMix; this.inited = true;
      this.setTargets();
      this.gPre = this.tPre; this.gComp = this.tComp; this.gLo = this.tLo; this.gHi = this.tHi; this.gMix = this.tMix;
    }
    const k = 1 - Math.exp(-n / (0.03 * sr));
    this.amt += (tAmt - this.amt) * k;
    this.tone += (tTone - this.tone) * k;
    this.mix += (tMix - this.mix) * k;
    this.setTargets();

    const tType = Math.max(0, Math.min(3, eff[this.iType] | 0));
    const inv = 1 / n;
    const dPre = (this.tPre - this.gPre) * inv, dComp = (this.tComp - this.gComp) * inv;
    const dLo = (this.tLo - this.gLo) * inv, dHi = (this.tHi - this.gHi) * inv, dMix = (this.tMix - this.gMix) * inv;
    let gPre = this.gPre, gComp = this.gComp, gLo = this.gLo, gHi = this.gHi, gMix = this.gMix;
    let inSS = 0, outSS = 0;

    const st = this.st, hb = this.hb, res = this.res;
    const h0 = hb[0], h1 = hb[1], h2 = hb[2], h3 = hb[3], h4 = hb[4], h5 = hb[5], h6 = hb[6], h7 = hb[7];
    const tg = this.toneG, dcR = this.dcR;
    let tzL = this.tzL, tzR = this.tzR, dxL = this.dxL, dyL = this.dyL, dxR = this.dxR, dyR = this.dyR;
    let onG = this.onG, sw = this.sw;
    const fadeStep = this.fadeStep, swStep = this.swStep;
    const type = this.type;
    let switched = false;
    // crush params
    const bits = 16 - this.amt * 12.5;
    const qStep = Math.pow(2, 1 - bits);
    const rateInc = 1 / (1 + this.amt * this.amt * 30);
    let hPh = this.hPh, hL = this.hL, hR = this.hR;

    for (let i = off, end = off + n; i < end; i++) {
      const xL = L[i], xR = R[i];
      // fades
      if (on) { onG += fadeStep; if (onG > 1) onG = 1; } else { onG -= fadeStep; if (onG < 0) onG = 0; }
      if (tType !== type && !switched) { sw -= swStep; if (sw <= 0) { sw = 0; switched = true; } }
      else if (!switched && sw < 1) { sw += swStep; if (sw > 1) sw = 1; }

      let wL, wR, drL, drR;
      if (type === T_CRUSH) {
        hPh += rateInc;
        if (hPh >= 1) {
          hPh -= 1;
          let a = xL * gPre, b = xR * gPre;
          a = a > 1 ? 1 : a < -1 ? -1 : a;
          b = b > 1 ? 1 : b < -1 ? -1 : b;
          hL = Math.round(a / qStep) * qStep;
          hR = Math.round(b / qStep) * qStep;
        }
        wL = hL; wR = hR; drL = xL; drR = xR;
      } else {
        // 4 oversamplers: wet L/R (shaped at 2×) and phase-matched dry L/R (linear, always running so
        // mix moves never expose stale filter state)
        for (let c = 0; c < 4; c++) {
          const o = c * OS;
          const u = c === 0 ? xL * gPre : c === 1 ? xR * gPre : c === 2 ? xL : xR;
          // ── up: two all-pass chains in z^-2 (even coefs → phase 0, odd → phase 1) ──
          let s0 = u, s1 = u, t;
          t = (s0 - st[o + 8]) * h0 + st[o]; st[o] = s0; st[o + 8] = t; s0 = t;
          t = (s1 - st[o + 9]) * h1 + st[o + 1]; st[o + 1] = s1; st[o + 9] = t; s1 = t;
          t = (s0 - st[o + 10]) * h2 + st[o + 2]; st[o + 2] = s0; st[o + 10] = t; s0 = t;
          t = (s1 - st[o + 11]) * h3 + st[o + 3]; st[o + 3] = s1; st[o + 11] = t; s1 = t;
          t = (s0 - st[o + 12]) * h4 + st[o + 4]; st[o + 4] = s0; st[o + 12] = t; s0 = t;
          t = (s1 - st[o + 13]) * h5 + st[o + 5]; st[o + 5] = s1; st[o + 13] = t; s1 = t;
          t = (s0 - st[o + 14]) * h6 + st[o + 6]; st[o + 6] = s0; st[o + 14] = t; s0 = t;
          t = (s1 - st[o + 15]) * h7 + st[o + 7]; st[o + 7] = s1; st[o + 15] = t; s1 = t;
          // ── nonlinearity on both high-rate samples (wet only) ──
          if (c < 2) {
            if (type === T_SOFT) {
              let q = s0;
              if (q > 4.97) q = 1; else if (q < -4.97) q = -1;
              else { const q2 = q * q; q = (q * (135135 + q2 * (17325 + q2 * (378 + q2)))) / (135135 + q2 * (62370 + q2 * (3150 + q2 * 28))); }
              s0 = q;
              q = s1;
              if (q > 4.97) q = 1; else if (q < -4.97) q = -1;
              else { const q2 = q * q; q = (q * (135135 + q2 * (17325 + q2 * (378 + q2)))) / (135135 + q2 * (62370 + q2 * (3150 + q2 * 28))); }
              s1 = q;
            } else if (type === T_TUBE) {
              let q = s0 + TUBE_BIAS, sc = 1;
              if (q < 0) { q *= 0.62; sc = 1.6129; }
              if (q > 4.97) q = 1; else if (q < -4.97) q = -1;
              else { const q2 = q * q; q = (q * (135135 + q2 * (17325 + q2 * (378 + q2)))) / (135135 + q2 * (62370 + q2 * (3150 + q2 * 28))); }
              s0 = q * sc - TUBE_OFS;
              q = s1 + TUBE_BIAS; sc = 1;
              if (q < 0) { q *= 0.62; sc = 1.6129; }
              if (q > 4.97) q = 1; else if (q < -4.97) q = -1;
              else { const q2 = q * q; q = (q * (135135 + q2 * (17325 + q2 * (378 + q2)))) / (135135 + q2 * (62370 + q2 * (3150 + q2 * 28))); }
              s1 = q * sc - TUBE_OFS;
            } else {
              s0 = Math.sin(s0 * HALF_PI);
              s1 = Math.sin(s1 * HALF_PI);
            }
          }
          // ── down: phase 1 sample → chain 0, phase 0 sample → chain 1 ──
          let d0 = s1, d1 = s0;
          t = (d0 - st[o + 24]) * h0 + st[o + 16]; st[o + 16] = d0; st[o + 24] = t; d0 = t;
          t = (d1 - st[o + 25]) * h1 + st[o + 17]; st[o + 17] = d1; st[o + 25] = t; d1 = t;
          t = (d0 - st[o + 26]) * h2 + st[o + 18]; st[o + 18] = d0; st[o + 26] = t; d0 = t;
          t = (d1 - st[o + 27]) * h3 + st[o + 19]; st[o + 19] = d1; st[o + 27] = t; d1 = t;
          t = (d0 - st[o + 28]) * h4 + st[o + 20]; st[o + 20] = d0; st[o + 28] = t; d0 = t;
          t = (d1 - st[o + 29]) * h5 + st[o + 21]; st[o + 21] = d1; st[o + 29] = t; d1 = t;
          t = (d0 - st[o + 30]) * h6 + st[o + 22]; st[o + 22] = d0; st[o + 30] = t; d0 = t;
          t = (d1 - st[o + 31]) * h7 + st[o + 23]; st[o + 23] = d1; st[o + 31] = t; d1 = t;
          res[c] = 0.5 * (d0 + d1);
        }
        wL = res[0]; wR = res[1]; drL = res[2]; drR = res[3];
      }
      // DC block
      let yL = wL - dxL + dcR * dyL; dxL = wL; dyL = yL + DENORMAL;
      let yR = wR - dxR + dcR * dyR; dxR = wR; dyR = yR + DENORMAL;
      // tilt tone
      let v = (yL - tzL) * tg; let lp = v + tzL; tzL = lp + v;
      yL = lp * gLo + (yL - lp) * gHi;
      outSS += yL * yL;
      yL *= gComp;
      v = (yR - tzR) * tg; lp = v + tzR; tzR = lp + v;
      yR = lp * gLo + (yR - lp) * gHi;
      outSS += yR * yR;
      yR *= gComp;
      inSS += xL * xL + xR * xR;
      // mix + bypass crossfade
      const oL = drL + (yL - drL) * gMix;
      const oR = drR + (yR - drR) * gMix;
      const e = onG * onG * (3 - 2 * onG) * sw * sw * (3 - 2 * sw);
      L[i] = xL + (oL - xL) * e;
      R[i] = xR + (oR - xR) * e;
      gPre += dPre; gComp += dComp; gLo += dLo; gHi += dHi; gMix += dMix;
    }
    this.gPre = this.tPre; this.gComp = this.tComp; this.gLo = this.tLo; this.gHi = this.tHi; this.gMix = this.tMix;
    // Adaptive loudness match: slow in/out RMS tracking refines the static table (bounded to −15…+10 dB
    // of it). Kept as a correction factor relative to the static table so amount/type moves take effect
    // at once; while the amount moves, the averages restart and the correction is frozen.
    if (Math.abs(this.amt - this.measAmt) > 0.004) {
      this.measAmt = this.amt;
      this.msIn = this.msOut = 0;
      this.hold = Math.round(0.12 * sr);
    }
    const ka = 1 - Math.exp(-n / (0.3 * sr));
    this.msIn += (inSS / n - this.msIn) * ka;
    this.msOut += (outSS / n - this.msOut) * ka;
    if (this.hold > 0) this.hold -= n;
    else if (this.msIn > 1e-8 && this.msOut > 1e-10) {
      let c = (Math.sqrt(this.msIn / this.msOut) * this.bias) / this.tStatic;
      if (c > 3.2) c = 3.2; else if (c < 0.18) c = 0.18;
      this.corr = c;
    }
    this.tzL = tzL; this.tzR = tzR; this.dxL = dxL; this.dyL = dyL; this.dxR = dxR; this.dyR = dyR;
    this.onG = onG; this.sw = sw;
    this.hPh = hPh; this.hL = hL; this.hR = hR;
    if (switched) {
      // switch at the bottom of the dip; the oversamplers are linear so they keep running (no transient)
      this.type = tType;
      this.hPh = 1; this.hL = this.hR = 0;
      this.msIn = this.msOut = 0; this.corr = 1;
      this.setTargets();
      this.gPre = this.tPre; this.gComp = this.tComp; this.gLo = this.tLo; this.gHi = this.tHi; this.gMix = this.tMix;
    }
    if (!on && onG <= 0) this.active = false;
  }
}
