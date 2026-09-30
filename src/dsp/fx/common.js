// Shared helpers for the FX modules (src/dsp/fx/*). Pure ES module.
// The FX hot loops inline their interpolation/saturation code (no per-sample calls with double arguments,
// so no boxing under any JIT); these helpers are for construction-time work and for other modules.

/** Smallest power of two ≥ n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * 4-point cubic Hermite (Catmull-Rom) read from a power-of-two ring buffer.
 * `pos` = fractional absolute read index (may be negative; wrapped with `mask`), `base` = offset of the ring
 * inside `buf` (lets several rings share one Float32Array).
 */
export function readHermite(buf, base, mask, pos) {
  const ip = Math.floor(pos);
  const f = pos - ip;
  const ym1 = buf[base + ((ip - 1) & mask)];
  const y0 = buf[base + (ip & mask)];
  const y1 = buf[base + ((ip + 1) & mask)];
  const y2 = buf[base + ((ip + 2) & mask)];
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * f + c2) * f + c1) * f + y0;
}

/** Linear-interpolated read from a power-of-two ring buffer (see readHermite). */
export function readLinear(buf, base, mask, pos) {
  const ip = Math.floor(pos);
  const f = pos - ip;
  const a = buf[base + (ip & mask)];
  return a + (buf[base + ((ip + 1) & mask)] - a) * f;
}

// ───────────────────────── Polyphase IIR half-band (2× over/undersampling) ─────────────────────────
// Coefficient design after Laurent de Soras' HIIR (elliptic half-band made of two all-pass chains).

function accNum(q, order, c) {
  let i = 0, j = 1, acc = 0, t;
  do {
    t = Math.pow(q, i * (i + 1)) * Math.sin(((i * 2 + 1) * c * Math.PI) / order) * j;
    acc += t;
    j = -j;
    i++;
  } while (Math.abs(t) > 1e-100 && i < 1000);
  return acc;
}

function accDen(q, order, c) {
  let i = 1, j = -1, acc = 0, t;
  do {
    t = Math.pow(q, i * i) * Math.cos((i * 2 * c * Math.PI) / order) * j;
    acc += t;
    j = -j;
    i++;
  } while (Math.abs(t) > 1e-100 && i < 1000);
  return acc;
}

/**
 * Design `nCoefs` all-pass coefficients for a half-band filter with the given normalised transition
 * bandwidth (0 < tbw < 0.5, relative to the oversampled rate's Nyquist band edge).
 */
export function designHalfband(nCoefs, tbw) {
  let k = Math.tan(((1 - tbw * 2) * Math.PI) / 4);
  k *= k;
  const kksqrt = Math.pow(1 - k * k, 0.25);
  const e = (0.5 * (1 - kksqrt)) / (1 + kksqrt);
  const e2 = e * e;
  const e4 = e2 * e2;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const order = nCoefs * 2 + 1;
  const out = new Float64Array(nCoefs);
  for (let idx = 0; idx < nCoefs; idx++) {
    const c = idx + 1;
    const num = accNum(q, order, c) * Math.pow(q, 0.25);
    const den = accDen(q, order, c) + 0.5;
    const ww = num / den;
    const wwsq = ww * ww;
    const x = Math.sqrt((1 - wwsq * k) * (1 - wwsq / k)) / (1 + wwsq);
    out[idx] = (1 - x) / (1 + x);
  }
  return out;
}

/**
 * One channel of 2× oversampling: `up(x)` produces two high-rate samples in `this.u0`, `this.u1`;
 * `down(a, b)` consumes two high-rate samples and returns one base-rate sample.
 * Both directions use the same polyphase all-pass half-band design (independent state).
 */
export class Oversampler2x {
  constructor(coefs) {
    this.c = coefs;
    this.n = coefs.length;
    this.ux = new Float64Array(this.n);
    this.uy = new Float64Array(this.n);
    this.dx = new Float64Array(this.n);
    this.dy = new Float64Array(this.n);
    this.u0 = 0;
    this.u1 = 0;
  }

  reset() {
    this.ux.fill(0); this.uy.fill(0); this.dx.fill(0); this.dy.fill(0);
    this.u0 = 0; this.u1 = 0;
  }

  up(input) {
    if (this.n === 8) { this.up8(input); return; }
    const c = this.c, x = this.ux, y = this.uy, n = this.n;
    let s0 = input, s1 = input;
    for (let i = 0; i < n; i += 2) {
      const t0 = (s0 - y[i]) * c[i] + x[i];
      x[i] = s0; y[i] = t0; s0 = t0;
      if (i + 1 < n) {
        const t1 = (s1 - y[i + 1]) * c[i + 1] + x[i + 1];
        x[i + 1] = s1; y[i + 1] = t1; s1 = t1;
      }
    }
    this.u0 = s0;
    this.u1 = s1;
  }

  /** Unrolled 8-coefficient version of up(). */
  up8(input) {
    const c = this.c, x = this.ux, y = this.uy;
    let t;
    t = (input - y[0]) * c[0] + x[0]; x[0] = input; y[0] = t;
    let s0 = t;
    t = (input - y[1]) * c[1] + x[1]; x[1] = input; y[1] = t;
    let s1 = t;
    t = (s0 - y[2]) * c[2] + x[2]; x[2] = s0; y[2] = t; s0 = t;
    t = (s1 - y[3]) * c[3] + x[3]; x[3] = s1; y[3] = t; s1 = t;
    t = (s0 - y[4]) * c[4] + x[4]; x[4] = s0; y[4] = t; s0 = t;
    t = (s1 - y[5]) * c[5] + x[5]; x[5] = s1; y[5] = t; s1 = t;
    t = (s0 - y[6]) * c[6] + x[6]; x[6] = s0; y[6] = t; s0 = t;
    t = (s1 - y[7]) * c[7] + x[7]; x[7] = s1; y[7] = t; s1 = t;
    this.u0 = s0;
    this.u1 = s1;
  }

  /** Unrolled 8-coefficient version of down(). */
  down8(a, b) {
    const c = this.c, x = this.dx, y = this.dy;
    let s0 = b, s1 = a, t;
    t = (s0 - y[0]) * c[0] + x[0]; x[0] = s0; y[0] = t; s0 = t;
    t = (s1 - y[1]) * c[1] + x[1]; x[1] = s1; y[1] = t; s1 = t;
    t = (s0 - y[2]) * c[2] + x[2]; x[2] = s0; y[2] = t; s0 = t;
    t = (s1 - y[3]) * c[3] + x[3]; x[3] = s1; y[3] = t; s1 = t;
    t = (s0 - y[4]) * c[4] + x[4]; x[4] = s0; y[4] = t; s0 = t;
    t = (s1 - y[5]) * c[5] + x[5]; x[5] = s1; y[5] = t; s1 = t;
    t = (s0 - y[6]) * c[6] + x[6]; x[6] = s0; y[6] = t; s0 = t;
    t = (s1 - y[7]) * c[7] + x[7]; x[7] = s1; y[7] = t; s1 = t;
    return 0.5 * (s0 + s1);
  }

  down(a, b) {
    if (this.n === 8) return this.down8(a, b);
    const c = this.c, x = this.dx, y = this.dy, n = this.n;
    let s0 = b, s1 = a;
    for (let i = 0; i < n; i += 2) {
      const t0 = (s0 - y[i]) * c[i] + x[i];
      x[i] = s0; y[i] = t0; s0 = t0;
      if (i + 1 < n) {
        const t1 = (s1 - y[i + 1]) * c[i + 1] + x[i + 1];
        x[i + 1] = s1; y[i + 1] = t1; s1 = t1;
      }
    }
    return 0.5 * (s0 + s1);
  }
}

/** RBJ biquad coefficient helper: writes [b0,b1,b2,a1,a2] (normalised) into `out` at offset `o`. */
export function rbjPeak(out, o, f, q, db, sr) {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * f) / sr;
  const cs = Math.cos(w), sn = Math.sin(w);
  const al = sn / (2 * q);
  const a0 = 1 + al / A;
  out[o] = (1 + al * A) / a0;
  out[o + 1] = (-2 * cs) / a0;
  out[o + 2] = (1 - al * A) / a0;
  out[o + 3] = (-2 * cs) / a0;
  out[o + 4] = (1 - al / A) / a0;
}

export function rbjLowShelf(out, o, f, db, sr, S = 1) {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * f) / sr;
  const cs = Math.cos(w), sn = Math.sin(w);
  const al = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const sq = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) + (A - 1) * cs + sq;
  out[o] = (A * ((A + 1) - (A - 1) * cs + sq)) / a0;
  out[o + 1] = (2 * A * ((A - 1) - (A + 1) * cs)) / a0;
  out[o + 2] = (A * ((A + 1) - (A - 1) * cs - sq)) / a0;
  out[o + 3] = (-2 * ((A - 1) + (A + 1) * cs)) / a0;
  out[o + 4] = ((A + 1) + (A - 1) * cs - sq) / a0;
}

export function rbjHighShelf(out, o, f, db, sr, S = 1) {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * f) / sr;
  const cs = Math.cos(w), sn = Math.sin(w);
  const al = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const sq = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) - (A - 1) * cs + sq;
  out[o] = (A * ((A + 1) + (A - 1) * cs + sq)) / a0;
  out[o + 1] = (-2 * A * ((A - 1) + (A + 1) * cs)) / a0;
  out[o + 2] = (A * ((A + 1) + (A - 1) * cs - sq)) / a0;
  out[o + 3] = (2 * ((A - 1) - (A + 1) * cs)) / a0;
  out[o + 4] = ((A + 1) - (A - 1) * cs - sq) / a0;
}

/** RBJ low-pass (used for anti-alias pre-filters). */
export function rbjLowpass(out, o, f, q, sr) {
  const w = (2 * Math.PI * f) / sr;
  const cs = Math.cos(w), sn = Math.sin(w);
  const al = sn / (2 * q);
  const a0 = 1 + al;
  out[o] = (1 - cs) / 2 / a0;
  out[o + 1] = (1 - cs) / a0;
  out[o + 2] = (1 - cs) / 2 / a0;
  out[o + 3] = (-2 * cs) / a0;
  out[o + 4] = (1 - al) / a0;
}
