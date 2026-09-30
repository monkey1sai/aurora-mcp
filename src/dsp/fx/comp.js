// Glue compressor: stereo-linked feed-forward bus compressor.
// Detector = max(RMS (≈8 ms) + 3 dB, 0.7·peak envelope) → soft-knee (8 dB) static curve, ratio 1 → 3.5 and
// threshold −6 → −20 dBFS rising with comp.amount → attack 12 ms / program-dependent release (150 ms
// fast + 900 ms slow blend) in the dB domain → auto makeup (60% of the static reduction at a −10 dBFS
// reference). comp.amount = 0 is an exact bypass; the gain computer runs every 8 samples with per-sample
// linear gain interpolation.
import { idx } from '../params.js';

const SUB = 8;
const KNEE = 8;
const REF_DB = -10;

export class Comp {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.iAmt = idx('comp.amount');
    this.amt = 0;
    this.ms = 0.5;       // mean-square detector
    this.pk = 0.5;       // peak envelope
    this.grFast = 0.5;   // dB (≤ 0)
    this.grSlow = 0.5;
    this.gain = 1.5;     // current linear gain (incl. makeup)
    this.amt = 0.5;
    this.reduction = 0.5;
    this.rmsK = 1 - Math.exp(-1 / (0.008 * sampleRate));
    this.pkRel = Math.exp(-1 / (0.06 * sampleRate));
    this.atk = 1 - Math.exp(-SUB / (0.012 * sampleRate));
    this.relF = 1 - Math.exp(-SUB / (0.15 * sampleRate));
    this.relS = 1 - Math.exp(-SUB / (0.9 * sampleRate));
    this.reset();
  }

  reset() {
    this.ms = 0; this.pk = 0; this.grFast = 0; this.grSlow = 0; this.gain = 1; this.reduction = 0; this.amt = 0;
  }

  tailActive() { return false; }

  /** Current gain reduction in dB (≤ 0), for meters. */
  getReduction() { return this.reduction; }

  static curve(xdB, thr, ratio) {
    const over = xdB - thr;
    if (over <= -KNEE / 2) return 0;
    const slope = 1 / ratio - 1;
    if (over >= KNEE / 2) return slope * over;
    const t = over + KNEE / 2;
    return (slope * t * t) / (2 * KNEE);
  }

  process(L, R, off, n, eff) {
    const tA = eff[this.iAmt];
    this.amt += (tA - this.amt) * (1 - Math.exp(-n / (0.05 * this.sr)));
    if (tA <= 0 && this.amt < 1e-4) {
      this.amt = 0;
      if (this.gain !== 1) { this.gain = 1; this.grFast = this.grSlow = 0; }
      this.reduction = 0;
      return;
    }
    const a = this.amt;
    const ratio = 1 + 2.5 * Math.pow(a, 0.8);
    const thr = -6 - 14 * a;
    const makeup = -0.6 * Comp.curve(REF_DB, thr, ratio);
    const slope = 1 / ratio - 1;
    let ms = this.ms, pk = this.pk, gFast = this.grFast, gSlow = this.grSlow, gain = this.gain;
    const rmsK = this.rmsK, pkRel = this.pkRel, atk = this.atk, relF = this.relF, relS = this.relS;
    let minGr = 0;
    for (let i = off, end = off + n; i < end;) {
      const m = Math.min(SUB, end - i);
      // detector over the sub-block
      for (let j = 0; j < m; j++) {
        const l = L[i + j], r = R[i + j];
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        const x = al > ar ? al : ar;
        ms += (x * x - ms) * rmsK;
        pk = x > pk ? x : pk * pkRel;
      }
      const lvl = Math.max(Math.sqrt(ms) * 1.4142, pk * 0.7);
      const xdB = lvl > 1e-6 ? 20 * Math.log10(lvl) : -120;
      // static soft-knee curve (inlined Comp.curve) → target reduction in dB (≤ 0)
      const over = xdB - thr;
      let target = 0;
      if (over >= KNEE / 2) target = slope * over;
      else if (over > -KNEE / 2) { const u = over + KNEE / 2; target = (slope * u * u) / (2 * KNEE); }
      // attack on the fast state, dual release (fast follows, slow tracks sustained reduction)
      if (target < gFast) gFast += (target - gFast) * atk;
      else gFast += (target - gFast) * relF;
      if (target < gSlow) gSlow += (target - gSlow) * atk * 0.25;
      else gSlow += (target - gSlow) * relS;
      const gr = Math.min(gFast, 0.5 * (gFast + gSlow));
      if (gr < minGr) minGr = gr;
      const tGain = Math.pow(10, (gr + makeup) / 20);
      const d = (tGain - gain) / m;
      for (let j = 0; j < m; j++) {
        gain += d;
        L[i + j] *= gain;
        R[i + j] *= gain;
      }
      i += m;
    }
    this.ms = ms; this.pk = pk; this.grFast = gFast; this.grSlow = gSlow; this.gain = gain;
    this.reduction = minGr;
  }
}
