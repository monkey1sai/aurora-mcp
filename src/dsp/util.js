// Shared DSP helpers. Pure ES module (AudioWorklet + Node safe). No allocation in hot paths.

export const PI = Math.PI;
export const PI2 = Math.PI * 2;
export const CR = 16; // control-rate block size (samples)

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mtof = note => 440 * Math.pow(2, (note - 69) / 12);
export const ftom = f => 69 + 12 * Math.log2(f / 440);
export const dbToGain = db => Math.pow(10, db / 20);
export const gainToDb = g => (g > 1e-12 ? 20 * Math.log10(g) : -240);
export const centsToRatio = c => Math.pow(2, c / 1200);

/** Coefficient for a one-pole smoother reaching ~63% in `timeSec`: y += (x - y) * coef. */
export function onePoleCoef(timeSec, sampleRate) {
  if (timeSec <= 0) return 1;
  return 1 - Math.exp(-1 / (timeSec * sampleRate));
}

/** Rational tanh approximation: max error ≈ 1e-4 on [-5,5]; monotone, bounded to ±1 beyond. */
export function fastTanh(x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  const a = x * (135135 + x2 * (17325 + x2 * (378 + x2)));
  const b = 135135 + x2 * (62370 + x2 * (3150 + x2 * 28));
  const y = a / b;
  return y > 1 ? 1 : y < -1 ? -1 : y;
}

/** Soft clipper with unity slope at 0 and smooth saturation to ±1 (cheaper than tanh). */
export function softClip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  return (x * (27 + x * x)) / (27 + 9 * x * x);
}

/** PolyBLEP residual. t = phase in [0,1), dt = phase increment per sample. */
export function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** PolyBLAMP residual (for slope discontinuities, e.g. triangle). Scale by slope change * dt. */
export function polyBlamp(t, dt) {
  if (t < dt) {
    t = t / dt - 1;
    return (-1 / 3) * t * t * t;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt + 1;
    return (1 / 3) * t * t * t;
  }
  return 0;
}

/** Deterministic xorshift32 RNG. */
export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  nextU32() {
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s;
  }
  /** Uniform 0..1 */
  next() { return this.nextU32() / 4294967296; }
  /** Uniform -1..1 */
  bipolar() { return this.nextU32() / 2147483648 - 1; }
  /** Approximately gaussian (sum of 4 uniforms), mean 0, sd ≈ 1 */
  gauss() { return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508; }
}

/** 4-point, 3rd-order Hermite interpolation. frac in [0,1) between y0 and y1 (ym1, y0, y1, y2). */
export function hermite(ym1, y0, y1, y2, frac) {
  const c0 = y0;
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * frac + c2) * frac + c1) * frac + c0;
}

/** Equal-power pan: returns [gL, gR] into the provided 2-element array. pan -1..1. */
export function panGains(pan, out) {
  const a = (clamp(pan, -1, 1) + 1) * 0.25 * PI;
  out[0] = Math.cos(a) * Math.SQRT2;
  out[1] = Math.sin(a) * Math.SQRT2;
  return out;
}

export const DENORMAL = 1e-20;
