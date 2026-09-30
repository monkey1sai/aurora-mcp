// Noise source: white → continuously coloured noise (brown … white … blue), stereo width, one-shot decay.
//
// Colour is a true spectral *tilt*: a cascade of first-order shelving sections whose poles/zeros are
// spaced geometrically across the audio band, giving a constant slope of `color`·6 dB/oct for
// color < 0 (−1 = brown, −0.5 ≈ pink) and up to +4.8 dB/oct for color > 0 (≈ blue/violet).
// The slope is smooth in both frequency (±0.5 dB ripple) and time (coefficients are interpolated from
// a per-sample-rate table and the colour is smoothed per call — sweeping it never zips or clicks).
// Every colour is RMS-normalised to the RMS of a unit saw (1/√3), so `level` means the same loudness
// at any colour (power over 0..Nyquist) — and at any sample rate: above 48 kHz each colour is matched to the
// 48 kHz level below 12 kHz, so the ultrasonic half/three quarters of white noise at 96/192 kHz no longer eat
// into the audible level (it was −3/−6 dB quieter, brown +3 dB louder). Width decorrelates L/R with a mid/side rotation of two independent white sources
// (power-preserving: width 0 = mono, 1 = fully uncorrelated).
//
// Pure ES module; allocation-free in process().

import { idx } from '../params.js';
import { Rng } from '../util.js';

const NSEC = 8;                 // shelving sections
const GRID = 128;               // colour table resolution (GRID+1 points over −1..+1)
const F_LO = 22;                // lowest section centre (Hz)
const F_HI = 11000;             // highest section centre (Hz)
const HP_HZ = 16;               // sub-sonic high-pass (keeps brown noise from wandering)
const POS_SLOPE = 0.8;          // color +1 → +4.8 dB/oct
const TARGET_RMS = 1 / Math.sqrt(3); // RMS of a ±1 saw (and of uniform white noise)

// Per-sample-rate coefficient tables, shared by every voice.
const TABLES = new Map();

function colorToAlpha(c) { return c < 0 ? c : c * POS_SLOPE; }

const REF_SR = 48000;            // above this rate the level is matched to the 48 kHz design (see buildTable)
const REF_BAND = 12000;         // … in the band below 12 kHz (where the bilinear designs agree)

/**
 * Share of a white source's power that the colour filter g (incl. the HP) passes in 0..fMax:
 * mean |H|² over 0..fMax × fMax/nyq.
 */
function bandPower(coef, g, sr, K, wh, fMax) {
  const NF = 512, nyq = sr * 0.5;
  const hb = K / (K + wh), ha = (wh - K) / (K + wh);
  let pw = 0;
  for (let k = 0; k < NF; k++) {
    const f = (k + 0.5) / NF * fMax;
    const w = 2 * Math.PI * f / sr;
    const cr = Math.cos(w), ci = -Math.sin(w); // z^-1
    let mag2 = 1;
    for (let s = 0; s < NSEC; s++) {
      const o = (g * NSEC + s) * 3;
      const b0 = coef[o], b1 = coef[o + 1], a1 = coef[o + 2];
      const nr = b0 + b1 * cr, ni = b1 * ci;
      const dr = 1 + a1 * cr, di = a1 * ci;
      mag2 *= (nr * nr + ni * ni) / (dr * dr + di * di);
    }
    // HP: H = K/(K+wh) · (1 − z^-1)/(1 + ((wh−K)/(K+wh)) z^-1)
    const hnr = hb * (1 - cr), hni = -hb * ci;
    const hdr = 1 + ha * cr, hdi = ha * ci;
    mag2 *= (hnr * hnr + hni * hni) / (hdr * hdr + hdi * hdi);
    pw += mag2;
  }
  return pw / NF * (fMax / nyq);
}

function buildTable(sr) {
  const nyq = sr * 0.5;
  const K = 2 * sr;
  const ratio = Math.pow(F_HI / F_LO, 1 / (NSEC - 1));
  const coef = new Float64Array((GRID + 1) * NSEC * 3);
  const gain = new Float64Array(GRID + 1);
  const refBand = new Float64Array(GRID + 1); // (48 kHz table) gain² × power below REF_BAND
  const warp = f => K * Math.tan(Math.PI * Math.min(f, 0.47 * sr) / sr);
  // HP (bilinear one-pole) for the normalisation integral
  const wh = warp(HP_HZ);
  // Above 48 kHz: match the 48 kHz level in the audible band instead of normalising over 0..Nyquist, where
  // the ultrasonic half (96 kHz) / three quarters (192 kHz) of white noise made every colour 3–6 dB quieter
  // where it is heard (and brown louder). ≤ 48 kHz: unchanged (power over the whole band).
  const ref = sr > REF_SR ? tableFor(REF_SR) : null;
  for (let g = 0; g <= GRID; g++) {
    const color = -1 + 2 * g / GRID;
    const a = colorToAlpha(color);
    const rp = Math.pow(ratio, a * 0.5);   // pole = c·R^(α/2), zero = c·R^(−α/2)
    for (let s = 0; s < NSEC; s++) {
      const c = F_LO * Math.pow(ratio, s);
      const wp = warp(c * rp), wz = warp(c / rp);
      // H(s) = (1 + s/wz)/(1 + s/wp)  (unity DC gain) → bilinear
      const n0 = (K + wz) / wz, n1 = (wz - K) / wz;
      const d0 = (K + wp) / wp, d1 = (wp - K) / wp;
      const o = (g * NSEC + s) * 3;
      coef[o] = n0 / d0; coef[o + 1] = n1 / d0; coef[o + 2] = d1 / d0;
    }
    if (ref) {
      gain[g] = Math.sqrt(ref.refBand[g] / bandPower(coef, g, sr, K, wh, REF_BAND));
    } else {
      // mean |H|² over linear frequency 0..Nyquist (white-noise power gain), including the HP
      gain[g] = 1 / Math.sqrt(bandPower(coef, g, sr, K, wh, nyq));
      if (sr === REF_SR) refBand[g] = gain[g] * gain[g] * bandPower(coef, g, sr, K, wh, REF_BAND);
    }
  }
  const hpB = K / (K + wh), hpA = (wh - K) / (K + wh);
  return { coef, gain, hpB, hpA, refBand };
}

function tableFor(sr) {
  let t = TABLES.get(sr);
  if (!t) { t = buildTable(sr); TABLES.set(sr, t); }
  return t;
}

let instanceCounter = 0;

export class NoiseEngine {
  /**
   * @param {number} sampleRate
   * @param {string} [prefix]
   * @param {number} [seed] per-instance seed (the voice passes one). Without it a module counter is used, which
   *                        makes renders depend on how many engines were constructed before.
   */
  constructor(sampleRate, prefix = 'noise', seed) {
    this.sr = sampleRate;
    this.freqIn = 261.6255653005986; // voice pitch (Hz) for render(); unused by the noise source
    this.iColor = idx(`${prefix}.color`);
    this.iDecay = idx(`${prefix}.decay`);
    this.iWidth = idx(`${prefix}.width`);
    this.tab = tableFor(sampleRate);
    const s0 = seed !== undefined && seed !== null ? (seed >>> 0) : (++instanceCounter + 7);
    const seed32 = Math.imul(0x9E3779B1, s0 + 1) >>> 0;
    this.rngA = new Rng((seed32 ^ 0x5bd1e995) >>> 0);
    this.rngB = new Rng((Math.imul(seed32, 0x85ebca6b) ^ 0x27d4eb2f) >>> 0);
    this.co = new Float64Array(NSEC * 3);     // current section coefs
    this.sL = new Float64Array(NSEC * 2);     // per section: x1, y1
    this.sR = new Float64Array(NSEC * 2);
    this.hpxL = 0; this.hpyL = 0; this.hpxR = 0; this.hpyR = 0;
    this.color = 0; this.colorApplied = NaN; this.g = 1;
    this.width = 1; this.wc = Math.SQRT1_2; this.ws = Math.SQRT1_2;
    this.env = 1; this.decay = 0; this.decMul = 1;
    this.fresh = true;
    this.smoothK = 1 - Math.exp(-16 / (0.015 * sampleRate)); // per-16-sample step, ~15 ms
    this._setColor();
  }

  /** Interpolate the colour filter coefficients for this.color (read from the field: no boxed double argument). */
  _setColor() {
    const c = this.color;
    const t = this.tab;
    let x = (c + 1) * 0.5 * GRID;
    if (x < 0) x = 0; else if (x > GRID) x = GRID;
    let i = x | 0; if (i >= GRID) i = GRID - 1;
    const f = x - i;
    const a = t.coef, co = this.co;
    const o0 = i * NSEC * 3, o1 = o0 + NSEC * 3;
    for (let k = 0; k < NSEC * 3; k++) co[k] = a[o0 + k] + (a[o1 + k] - a[o0 + k]) * f;
    this.g = t.gain[i] + (t.gain[i + 1] - t.gain[i]) * f;
    this.colorApplied = c;
  }

  _params(v, n) {
    const tc = v[this.iColor];
    const tw = v[this.iWidth];
    if (this.fresh) {
      this.color = tc; this.width = tw; this.fresh = false;
    } else {
      const k = this.smoothK * (n / 16);
      this.color += (tc - this.color) * k;
      this.width += (tw - this.width) * k;
      if (Math.abs(tc - this.color) < 1e-4) this.color = tc;
      if (Math.abs(tw - this.width) < 1e-4) this.width = tw;
    }
    if (this.color !== this.colorApplied) this._setColor();
    const th = this.width * Math.PI * 0.25;
    this.wc = Math.cos(th); this.ws = Math.sin(th);
    const d = v[this.iDecay];
    if (d !== this.decay) {
      this.decay = d;
      this.decMul = d > 0 ? Math.exp(-6.907755 / (d * this.sr)) : 1; // −60 dB at `decay` s
    }
  }

  noteOn(note, velocity, freq, v, legato) {
    if (legato) return;
    this.env = 1;
    this._params(v, 16);
  }

  noteOff() { /* noise keeps running; the amp envelope shapes the release */ }

  isActive() {
    return !(this.decay > 0 && this.env < 1e-5);
  }

  reset() {
    this.sL.fill(0); this.sR.fill(0);
    this.hpxL = this.hpyL = this.hpxR = this.hpyR = 0;
    this.env = 1; this.fresh = true;
  }

  process(v, freq, outL, outR, offset, n) {
    this.freqIn = freq;
    this.render(v, outL, outR, offset, n);
  }

  /** Same as process() with the pitch taken from this.freqIn (allocation-free call path used by the voice). */
  render(v, outL, outR, offset, n) {
    this._params(v, n);
    const co = this.co, sL = this.sL, sR = this.sR;
    const ra = this.rngA, rb = this.rngB;
    const wc = this.wc, ws = this.ws;
    const g = this.g * TARGET_RMS * 1.7320508; // uniform white has RMS 1/√3 → scale to unity then target
    const hb = this.tab.hpB, ha = this.tab.hpA;
    const oneShot = this.decay > 0;
    const dm = this.decMul;
    let env = this.env;
    let hxL = this.hpxL, hyL = this.hpyL, hxR = this.hpxR, hyR = this.hpyR;
    const end = offset + n;
    for (let i = offset; i < end; i++) {
      const a = ra.bipolar(), b = rb.bipolar();
      let xl = a * wc + b * ws;
      let xr = a * wc - b * ws;
      for (let s = 0, o = 0, m = 0; s < NSEC; s++, o += 3, m += 2) {
        const b0 = co[o], b1 = co[o + 1], a1 = co[o + 2];
        const yl = b0 * xl + b1 * sL[m] - a1 * sL[m + 1];
        sL[m] = xl; sL[m + 1] = yl; xl = yl;
        const yr = b0 * xr + b1 * sR[m] - a1 * sR[m + 1];
        sR[m] = xr; sR[m + 1] = yr; xr = yr;
      }
      // sub-sonic high-pass
      const ol = hb * (xl - hxL) - ha * hyL; hxL = xl; hyL = ol;
      const or = hb * (xr - hxR) - ha * hyR; hxR = xr; hyR = or;
      let gg = g;
      if (oneShot) { gg *= env; env *= dm; }
      outL[i] = ol * gg;
      outR[i] = or * gg;
    }
    // denormal guard on filter states (brown noise integrators never go truly quiet, but be safe)
    if (Math.abs(hyL) < 1e-25) hyL = 0;
    if (Math.abs(hyR) < 1e-25) hyR = 0;
    this.hpxL = hxL; this.hpyL = hyL; this.hpxR = hxR; this.hpyR = hyR;
    this.env = env < 1e-9 ? 0 : env;
  }
}
