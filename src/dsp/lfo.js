// Low-frequency oscillator, evaluated at control rate. Pure ES module, allocation-free after construction.
// Output is bipolar −1..1. Shapes follow params.js order:
//   0 sine, 1 tri, 2 saw (up), 3 ramp (down), 4 square, 5 sh (sample & hold), 6 smooth (smooth random)

import { Rng, PI2, hermite } from './util.js';

export const LFO_SINE = 0;
export const LFO_TRI = 1;
export const LFO_SAW = 2;
export const LFO_RAMP = 3;
export const LFO_SQUARE = 4;
export const LFO_SH = 5;
export const LFO_SMOOTH = 6;

export class Lfo {
  /**
   * @param {number} sampleRate
   * @param {number} seed  RNG seed (S&H / smooth random), deterministic
   * @param {number} blockSize  samples per control step (for the de-step smoother)
   */
  constructor(sampleRate, seed = 1, blockSize = 16) {
    this.sr = sampleRate;
    this.rng = new Rng(seed);
    this.phase = 0;
    this.shape = LFO_SINE;
    this.value = 0.5;    // latest output
    this.value = 0;
    this.hz = 1.5;       // rate for advance()
    this.lockPhase = 0.5; // absolute phase for lock()
    this.raw = 0;        // unsmoothed output
    this.held = 0;       // S&H value
    // smooth random: Hermite spline through successive random points (rm1, r0 | r1, r2)
    this.rm1 = this.rng.bipolar(); this.r0 = this.rng.bipolar();
    this.r1 = this.rng.bipolar(); this.r2 = this.rng.bipolar();
    this.held = this.rng.bipolar();
    // ~1.2 ms one-pole on discontinuous shapes: removes harsh steps (no zipper) without dulling the shape
    this.deStep = 1 - Math.exp(-blockSize / (0.0012 * sampleRate));
  }

  /** Restart at phase p (0..1). New random values for S&H / smooth so every note differs. */
  reset(p = 0, shape = this.shape) {
    p -= Math.floor(p);
    this.phase = p;
    this.shape = shape;
    this.held = this.rng.bipolar();
    this.rm1 = this.rng.bipolar(); this.r0 = this.held;
    this.r1 = this.rng.bipolar(); this.r2 = this.rng.bipolar();
    this.raw = this._eval();
    this.value = this.raw;
  }

  _wrap() {
    // new cycle: new random targets
    this.held = this.rng.bipolar();
    this.rm1 = this.r0; this.r0 = this.r1; this.r1 = this.r2;
    this.r2 = this.rng.bipolar();
  }

  /**
   * Hot path: advance n samples at `this.hz` (set the field first); result in `this.value`.
   * (Fields instead of double args/returns: avoids number boxing across non-inlined calls.)
   */
  advance(n, shape) {
    let p = this.phase + (this.hz * n) / this.sr;
    if (p >= 1) {
      p -= Math.floor(p);
      this._wrap();
    }
    this.phase = p;
    this._out(shape);
  }

  /** Hot path: jump to the absolute phase `this.lockPhase` (tempo-locked LFOs); detects cycle wraps. */
  lock(shape) {
    let p = this.lockPhase;
    p -= Math.floor(p);
    const d = p - this.phase;
    if (d < -0.5) this._wrap(); // wrapped forward
    this.phase = p;
    this._out(shape);
  }

  /** Convenience: advance by n samples at `hz`, return the new value. */
  step(n, hz, shape) {
    this.hz = hz;
    this.advance(n, shape);
    return this.value;
  }

  /** Convenience: set an absolute phase, return the new value. */
  setPhase(p, shape) {
    this.lockPhase = p;
    this.lock(shape);
    return this.value;
  }

  _out(shape) {
    this.shape = shape;
    // (evaluated inline: a non-inlined call returning a double would box it)
    const p = this.phase;
    let x;
    switch (shape) {
      case LFO_SINE: x = Math.sin(PI2 * p); break;
      case LFO_TRI: x = p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4; break;
      case LFO_SAW: x = 2 * p - 1; break;
      case LFO_RAMP: x = 1 - 2 * p; break;
      case LFO_SQUARE: x = p < 0.5 ? 1 : -1; break;
      case LFO_SH: x = this.held; break;
      case LFO_SMOOTH: {
        const rm1 = this.rm1, r0 = this.r0, r1 = this.r1, r2 = this.r2;
        const c1 = 0.5 * (r1 - rm1), c2 = rm1 - 2.5 * r0 + 2 * r1 - 0.5 * r2, c3 = 0.5 * (r2 - rm1) + 1.5 * (r0 - r1);
        x = ((c3 * p + c2) * p + c1) * p + r0;
        x = x > 1 ? 1 : x < -1 ? -1 : x;
        break;
      }
      default: x = 0;
    }
    this.raw = x;
    if (shape === LFO_SQUARE || shape === LFO_SAW || shape === LFO_RAMP || shape === LFO_SH) {
      this.value += (x - this.value) * this.deStep;
    } else {
      this.value = x;
    }
  }

  _eval() {
    const p = this.phase;
    switch (this.shape) {
      case LFO_SINE: return Math.sin(PI2 * p);
      case LFO_TRI: return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
      case LFO_SAW: return 2 * p - 1;
      case LFO_RAMP: return 1 - 2 * p;
      case LFO_SQUARE: return p < 0.5 ? 1 : -1;
      case LFO_SH: return this.held;
      case LFO_SMOOTH: {
        const y = hermite(this.rm1, this.r0, this.r1, this.r2, p);
        return y > 1 ? 1 : y < -1 ? -1 : y;
      }
      default: return 0;
    }
  }
}
