// AURORA 極光 — procedural wavetables with per-octave band-limited mipmaps.
//
// Pure ES module (AudioWorklet + Node). Tables are generated once, on demand, into a module-level cache that
// every OscEngine (and the UI) shares.
//
// Every frame is defined as a harmonic spectrum (cos/sin coefficient per harmonic 1..512), obtained either
//   • analytically (additive / formant / drawbar models),
//   • exactly from a piecewise-linear periodic waveform (closed-form Fourier integral per segment — no aliasing),
//   • or from a densely sampled smooth waveform via FFT (for waveshaped / windowed shapes).
// Each mip level L keeps harmonics 1..WT_LEVEL_HARM[L] (512, 256, … 1: one level per octave) with a short
// raised-cosine taper on the top ~15 % (less Gibbs ringing, softer level changes) and is rendered with a real
// inverse FFT into WT_LEVEL_SIZE[L] samples: 4× oversampled for the 512-harmonic level (only used below
// ≈ 64 Hz, where the top harmonics are tiny), 8× for 256, ≥ 16× for the rest, so the 4-point cubic (Hermite)
// read keeps interpolation images ≈ 45–65 dB below the (already weak) top harmonics.
// Frames are stored as 16-bit integers (per-table scale, ≈ −90 dB quantisation) with guard samples
// [y(N−1) | y(0) … y(N−1) | y(0) y(1)] so the 4-point read never wraps.
//
// Memory: 10 tables × 64 frames × 8286 samples × 2 B ≈ 10.6 MB. Generation time: see wavetableStats().

import { WAVETABLES } from '../params.js';
import { Rng } from '../util.js';

export const WT_FRAMES = 64;
export const WT_HARMONICS = 512;
export const WT_LEVELS = 10;
/** Highest harmonic kept in each mip level. */
export const WT_LEVEL_HARM = Int32Array.from([512, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
/** Samples per frame (one cycle) in each mip level. */
export const WT_LEVEL_SIZE = Int32Array.from([2048, 2048, 2048, 1024, 512, 256, 128, 64, 64, 64]);
/** Guard samples: one before, two after each frame. y(0) of a frame is at its start + WT_GUARD_PRE. */
export const WT_GUARD_PRE = 1;
/** Distance between consecutive frames of one level (size + 3 guard samples). */
export const WT_LEVEL_STRIDE = Int32Array.from(WT_LEVEL_SIZE, n => n + 3);
/** Offset of each level's frame block inside a table's data array. */
export const WT_LEVEL_BASE = new Int32Array(WT_LEVELS);
let _total = 0;
for (let L = 0; L < WT_LEVELS; L++) { WT_LEVEL_BASE[L] = _total; _total += WT_FRAMES * WT_LEVEL_STRIDE[L]; }
/** Samples per table. */
export const WT_TABLE_SAMPLES = _total;

const H = WT_HARMONICS;
const TAU = Math.PI * 2;
const SAMPLES_MAX = 4096; // largest synthesis size (top mip / sampled-waveform path)

// ───────────────────────── FFT (radix-2, complex, in place) ─────────────────────────

const plans = new Map();
function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) { cos[i] = Math.cos((TAU * i) / n); sin[i] = Math.sin((TAU * i) / n); }
  p = { rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  plans.set(n, p);
  return p;
}

/** In-place complex FFT. sign = −1: forward (e^{−iωt}); +1: inverse (unscaled). */
function fft(re, im, n, sign) {
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // size-2 stage (twiddle 1)
  for (let i = 0; i < n; i += 2) {
    const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1];
    re[i] = ar + br; im[i] = ai + bi; re[i + 1] = ar - br; im[i + 1] = ai - bi;
  }
  // larger stages, twiddle-outer loop order (each twiddle loaded once per stage)
  for (let size = 4; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let j = 0, t = 0; j < half; j++, t += step) {
      const wr = cos[t], wi = sign * sin[t];
      for (let a = j; a < n; a += size) {
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        const ar = re[a], ai = im[a];
        re[b] = ar - xr; im[b] = ai - xi;
        re[a] = ar + xr; im[a] = ai + xi;
      }
    }
  }
}

/**
 * Real inverse transform: out[off+n] = scale · Σ_{k=1..hmax} w_k·(A[k]·cos(2πkn/N) + B[k]·sin(2πkn/N)),
 * w = raised-cosine taper on the top ~15 % of hmax (hmax < N/2), via one complex FFT of size N/2.
 */
const XR = new Float64Array(SAMPLES_MAX / 2 + 1), XI = new Float64Array(SAMPLES_MAX / 2 + 1);
function synthReal(A, B, hmax, N, out, off, scale) {
  const M = N >> 1;
  const { re, im } = plan(M);
  const h0 = hmax <= 2 ? hmax : Math.ceil(hmax * 0.85);
  const tw = 1 / (hmax - h0 + 1);
  for (let k = 0; k <= M; k++) { XR[k] = 0; XI[k] = 0; }
  // X[k] = (A_k − i·B_k)/2 · w_k ; X[N−k] = conj(X[k])
  for (let k = 1; k <= hmax && k < M; k++) {
    const w = k <= h0 ? 0.5 : 0.5 * Math.cos(0.5 * Math.PI * (k - h0) * tw) ** 2;
    XR[k] = A[k] * w; XI[k] = -B[k] * w;
  }
  const { cos, sin } = plan(N);
  for (let k = 0; k < M; k++) {
    const ar = XR[k], ai = XI[k];
    const br = XR[M - k], bi = -XI[M - k]; // X[k + M] = conj(X[M − k])
    const er = ar + br, ei = ai + bi;
    const dr = ar - br, di = ai - bi;
    const c = cos[k], s = sin[k]; // O = (X[k] − X[k+M]) · e^{+i2πk/N}
    const or = dr * c - di * s, oi = dr * s + di * c;
    re[k] = er - oi; // Z = E + i·O
    im[k] = ei + or;
  }
  fft(re, im, M, 1);
  for (let m = 0; m < M; m++) {
    out[off + 2 * m] = re[m] * scale;
    out[off + 2 * m + 1] = im[m] * scale;
  }
}

// ───────────────────────── spectrum builders ─────────────────────────

/** Add a sinusoid amp·sin(2πkp + phase). */
function addPartial(A, B, k, amp, phase = 0) {
  if (k < 1 || k > H) return;
  B[k] += amp * Math.cos(phase);
  A[k] += amp * Math.sin(phase);
}
/** Non-integer "partial": constant-power split between the two neighbouring harmonics. */
function addPartialFrac(A, B, r, amp, phases) {
  const k = Math.floor(r), fr = r - k;
  const a0 = amp * Math.cos(fr * Math.PI * 0.5), a1 = amp * Math.sin(fr * Math.PI * 0.5);
  if (k >= 1 && k <= H) addPartial(A, B, k, a0, phases[k]);
  if (k + 1 >= 1 && k + 1 <= H) addPartial(A, B, k + 1, a1, phases[k + 1]);
}

/**
 * Exact Fourier series of a periodic piecewise-linear waveform (jumps allowed).
 * segs: flat [x0, x1, y0, y1, …] covering [0,1). Adds gain·(waveform harmonics 1..H) into A/B.
 * Uses c_k = Σ_seg [F(x1,y1) − F(x0,y0)], F(x,y) = e^{−iωx}(i·y/ω + s/ω²), ω = 2πk.
 */
function addPWL(A, B, segs, nseg, gain = 1) {
  for (let q = 0; q < nseg; q++) {
    const x0 = segs[4 * q], x1 = segs[4 * q + 1], y0 = segs[4 * q + 2], y1 = segs[4 * q + 3];
    if (!(x1 > x0)) continue;
    const s = (y1 - y0) / (x1 - x0);
    // endpoint 1 (+), endpoint 0 (−)
    for (let e = 0; e < 2; e++) {
      const x = e === 0 ? x1 : x0, y = e === 0 ? y1 : y0, sg = e === 0 ? 2 * gain : -2 * gain;
      const br = Math.cos(TAU * x), bi = -Math.sin(TAU * x);
      let zr = 1, zi = 0;
      for (let k = 1; k <= H; k++) {
        const t = zr * br - zi * bi; zi = zr * bi + zi * br; zr = t;
        const w = TAU * k;
        const pr = s / (w * w), pi = y / w; // (s/ω² + i·y/ω)
        const fr = zr * pr - zi * pi, fi = zr * pi + zi * pr;
        // C_k = 2c_k → A += Re, B += −Im
        A[k] += sg * fr;
        B[k] -= sg * fi;
      }
    }
  }
}

const SAMP_N = 4096;
const sampBuf = new Float64Array(SAMP_N);
/** Harmonics of a densely sampled smooth periodic waveform (sampBuf) via FFT. */
function addSampled(A, B, buf, gain = 1) {
  const { re, im } = plan(SAMP_N);
  for (let i = 0; i < SAMP_N; i++) { re[i] = buf[i]; im[i] = 0; }
  fft(re, im, SAMP_N, -1);
  const sc = (2 / SAMP_N) * gain;
  for (let k = 1; k <= H; k++) { A[k] += re[k] * sc; B[k] -= im[k] * sc; }
}
/** Evaluate the current spectrum into sampBuf (SAMP_N points). */
function spectrumToSamples(A, B) {
  // (tapers the top 15 % of the 512 harmonics — harmless: only used by the waveshaped growl table whose
  // content sits far below that)
  synthReal(A, B, H, SAMP_N, sampBuf, 0, 1);
}

/** Cascade formant response Π F²/(F² − f² + i·f·BW); writes [re, im] into out. */
function cascade(f, F, BW, n, out) {
  let r = 1, i = 0;
  for (let j = 0; j < n; j++) {
    const F2 = F[j] * F[j];
    const dr = F2 - f * f, di = f * BW[j];
    const den = dr * dr + di * di;
    const hr = (F2 * dr) / den, hi = (-F2 * di) / den;
    const t = r * hr - i * hi; i = r * hi + i * hr; r = t;
  }
  out[0] = r; out[1] = i;
}

/** Magnitude of a normalised band-pass resonance (1 at fc). */
function bp(f, fc, q) {
  const x = q * (f / fc - fc / f);
  return 1 / Math.sqrt(1 + x * x);
}

const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

function randomPhases(seed) {
  const r = new Rng(seed);
  const ph = new Float64Array(H + 2);
  for (let k = 0; k <= H + 1; k++) ph[k] = r.next() * TAU;
  return ph;
}

const segBuf = new Float64Array(4 * 1024);
const cplx = new Float64Array(2);

// ───────────────────────── table definitions ─────────────────────────

// 0 · analog: sine → triangle → saw → square (phase-aligned exactly like the classic oscillator)
function fillAnalog(x, f, A, B) {
  const m = x * 3;
  let ws = 0, wt = 0, ww = 0, wq = 0;
  if (m <= 1) { ws = 1 - m; wt = m; } else if (m <= 2) { wt = 2 - m; ww = m - 1; } else { ww = 3 - m; wq = m - 2; }
  B[1] += ws;
  for (let k = 1; k <= H; k++) {
    let b = (ww * 2) / (Math.PI * k);
    if (k & 1) {
      b += (wq * 4) / (Math.PI * k);
      b += (wt * 8 * ((((k - 1) >> 1) & 1) ? -1 : 1)) / (Math.PI * Math.PI * k * k);
    }
    B[k] += b;
  }
}

// 1 · harmonic: additive sweep, frame f holds partials 1..f+1 (1/k, sine phase) → 64 partials at the end
function fillHarmonic(x, f, A, B) {
  const n = f + 1;
  for (let k = 1; k <= n; k++) B[k] += 1 / k;
}

// 2 · vowels: glottal source through a 5-formant cascade (Klatt-style), A → E → I → O → U
const VOWELS = [ // tenor formants (Hz) and bandwidths (Hz)
  [[650, 1080, 2650, 2900, 3250], [80, 90, 120, 130, 140]], // A
  [[400, 1700, 2600, 3200, 3580], [70, 80, 100, 120, 120]], // E
  [[290, 1870, 2800, 3250, 3540], [40, 90, 100, 120, 120]], // I
  [[400, 800, 2600, 2800, 3000], [40, 80, 100, 120, 120]],  // O
  [[350, 600, 2700, 2900, 3300], [40, 60, 100, 120, 120]],  // U
];
const VOWEL_F0 = 146.8; // D3 reference pitch
const fF = new Float64Array(5), fBW = new Float64Array(5);
function fillVowels(x, f, A, B) {
  const s = x * 4;
  const i = Math.min(3, Math.floor(s));
  const t = smooth(s - i);
  const [Fa, Ba] = VOWELS[i], [Fb, Bb] = VOWELS[i + 1];
  for (let j = 0; j < 5; j++) {
    fF[j] = Math.exp(lerp(Math.log(Fa[j]), Math.log(Fb[j]), t));
    fBW[j] = lerp(Ba[j], Bb[j], t) * 1.3;
  }
  for (let k = 1; k <= H; k++) {
    const fk = k * VOWEL_F0;
    if (fk > 12000) break;
    cascade(fk, fF, fBW, 5, cplx);
    // source: −6 dB/oct glottal+radiation, gentle presence lift (higher-pole correction), sine phase
    const src = (1 / k) * Math.sqrt(1 + (fk / 3500) ** 2);
    A[k] += src * cplx[1];
    B[k] += src * cplx[0];
  }
}

// 3 · pulse: PWM sweep 50 % → 3 % (DC-free, exact band-limited PWL spectrum)
function fillPulse(x, f, A, B) {
  const pw = 0.5 - 0.47 * Math.pow(x, 1.15);
  const s = segBuf;
  s[0] = 0; s[1] = pw; s[2] = 1; s[3] = 1;
  s[4] = pw; s[5] = 1; s[6] = -1; s[7] = -1;
  addPWL(A, B, s, 2);
}

// 4 · organ: tonewheel drawbar registrations (table fundamental = 16′, played at ½ the note frequency)
const DRAWBAR_HARM = [1, 3, 2, 4, 6, 8, 10, 12, 16]; // 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′
const REGISTRATIONS = [
  '008000000', // flute 8′
  '008400000', // flute 8′ + 4′
  '008060400', // reedy / clarinet
  '008080800', // theatre
  '808000008', // jazz (16′ 8′ 1′)
  '888000000', // "Jimmy Smith"
  '888800000', // gospel
  '868868000', // rich
  '888888000', // big
  '888888888', // full organ
];
const organPhases = randomPhases(0x0a9a1);
function fillOrgan(x, f, A, B) {
  const s = x * (REGISTRATIONS.length - 1);
  const i = Math.min(REGISTRATIONS.length - 2, Math.floor(s));
  const t = s - i;
  const ra = REGISTRATIONS[i], rb = REGISTRATIONS[i + 1];
  const amp = d => (d <= 0 ? 0 : Math.pow(10, (-3 * (8 - d)) / 20));
  for (let j = 0; j < 9; j++) {
    const a = lerp(amp(+ra[j]), amp(+rb[j]), t);
    if (a > 0) addPartial(A, B, DRAWBAR_HARM[j], a, organPhases[j]);
  }
}

// 5 · glass: free-free bar modes (1, 2.76, 5.40, 8.93 …) mapped onto sparse (mostly odd) harmonics, stretching
//     and brightening across the table, plus faint twinkling high partials
const GLASS_MODES = [1, 2.756, 5.404, 8.933, 13.344, 18.64, 24.81];
const glassPhases = randomPhases(0x61a55);
const SPARKLE = [23, 29, 31, 37, 41, 47, 53, 59, 67, 73];
const sparkleRate = Float64Array.from(SPARKLE, (_, j) => 1.3 + ((j * 0.618034) % 1) * 3.2);
const sparklePh = Float64Array.from(SPARKLE, (_, j) => ((j * 0.381966 + 0.2) % 1) * TAU);
function fillGlass(x, f, A, B) {
  const stretch = 1 + 1.2 * x;
  const bright = 0.5 + 0.38 * x;
  for (let m = 0; m < GLASS_MODES.length; m++) {
    const r = 1 + (GLASS_MODES[m] - 1) * stretch;
    const a = m === 0 ? 1 : 0.72 * Math.pow(bright, m);
    addPartialFrac(A, B, r, a, glassPhases);
  }
  for (let j = 0; j < SPARKLE.length; j++) {
    const tw = 0.5 + 0.5 * Math.sin(TAU * x * sparkleRate[j] + sparklePh[j]);
    addPartial(A, B, SPARKLE[j], 0.06 * (0.35 + 0.65 * x) * tw * tw, glassPhases[SPARKLE[j]]);
  }
}

// 6 · sync: hard-synced falling saw, slave ratio 1 → 8 (exponential), exact PWL spectrum
function fillSync(x, f, A, B) {
  const r = Math.pow(2, 3 * x);
  const s = segBuf;
  let n = 0;
  for (let j = 0; j / r < 1 - 1e-12; j++) {
    const x0 = j / r, x1 = Math.min(1, (j + 1) / r);
    s[4 * n] = x0; s[4 * n + 1] = x1; s[4 * n + 2] = 1; s[4 * n + 3] = 1 - 2 * (x1 - x0) * r;
    n++;
  }
  addPWL(A, B, s, n);
}

// 7 · digital: PPG-flavoured — stepped sine (32→4 steps) · digital organ (square + square×h) ·
//     bit-reduced saw (16→3 levels) · CZ-style resonant sweep (windowed sine 1.5→14)
function fillDigital(x, f, A, B) {
  const sec = f >> 4, t = (f & 15) / 15;
  const s = segBuf;
  if (sec === 0) {
    const S = Math.max(4, Math.round(32 * Math.pow(2, -3 * t)));
    for (let i = 0; i < S; i++) {
      const y = Math.sin((TAU * (i + 0.5)) / S);
      s[4 * i] = i / S; s[4 * i + 1] = (i + 1) / S; s[4 * i + 2] = y; s[4 * i + 3] = y;
    }
    addPWL(A, B, s, S);
  } else if (sec === 1) {
    const h = 2 + Math.round(7 * t);
    for (let k = 1; k <= H; k += 2) B[k] += 4 / (Math.PI * k);
    for (let m = 1; m * h <= H; m += 2) B[m * h] += (0.6 * 4) / (Math.PI * m);
  } else if (sec === 2) {
    const L = Math.max(3, Math.round(16 * Math.pow(2, -2.4 * t)));
    for (let i = 0; i < L; i++) {
      const y = 1 - (2 * (i + 0.5)) / L;
      s[4 * i] = i / L; s[4 * i + 1] = (i + 1) / L; s[4 * i + 2] = y; s[4 * i + 3] = y;
    }
    addPWL(A, B, s, L);
  } else {
    const h = 1.5 * Math.pow(14 / 1.5, t);
    for (let i = 0; i < SAMP_N; i++) {
      const p = i / SAMP_N;
      sampBuf[i] = Math.sin(TAU * h * p) * (1 - p) * (1 - p * 0.3);
    }
    addSampled(A, B, sampBuf);
  }
}

// 8 · strings: bowed (Helmholtz) sawtooth spectrum · bow-position comb · violin-family body resonances;
//     darker/softer bowing → brighter, closer-to-bridge bowing across the table
const STRING_F0 = 196; // G3 reference
const stringPhases = randomPhases(0x57a1);
function fillStrings(x, f, A, B) {
  const tilt = 1.3 - 0.55 * x;
  const beta = lerp(0.17, 0.075, x);
  const fc = lerp(3200, 8500, x);
  for (let k = 1; k <= H; k++) {
    const fk = k * STRING_F0;
    if (fk > 16000) break;
    let a = Math.pow(k, -tilt);
    a *= 0.3 + 0.7 * Math.abs(Math.sin(Math.PI * k * beta));
    a *= 1 + 1.6 * bp(fk, 280, 9) + 1.2 * bp(fk, 460, 7) + 1.0 * bp(fk, 580, 7) + 0.9 * bp(fk, 2800, 1.3);
    a /= Math.sqrt(1 + (fk / fc) ** 4);
    const ph = (stringPhases[k] - Math.PI) * 0.12; // near-sawtooth phase, slightly softened
    addPartial(A, B, k, a, ph);
  }
}

// 9 · growl: bright saw/square source through sweeping resonant formants ("oo-oh-ah-eh-ee"), then
//     waveshaped (tanh) for grit and re-band-limited — aggressive talking bass
const GROWL_F0 = 65.4; // C2
const GROWL_PATH = [ // [F1, F2, F3]
  [300, 700, 2200], [480, 900, 2400], [760, 1250, 2600], [520, 1800, 2700], [330, 2350, 3000],
];
const GROWL_BW = [70, 90, 150];
function fillGrowl(x, f, A, B) {
  const s = x * (GROWL_PATH.length - 1);
  const i = Math.min(GROWL_PATH.length - 2, Math.floor(s));
  const t = smooth(s - i);
  for (let j = 0; j < 3; j++) {
    fF[j] = Math.exp(lerp(Math.log(GROWL_PATH[i][j]), Math.log(GROWL_PATH[i + 1][j]), t));
    fBW[j] = GROWL_BW[j];
  }
  const sq = 0.35 * x; // odd-harmonic (square) share grows → more aggressive
  for (let k = 1; k <= H; k++) {
    const fk = k * GROWL_F0;
    if (fk > 14000) break;
    cascade(fk, fF, fBW, 3, cplx);
    const src = Math.pow(k, -0.85) * (1 - sq + ((k & 1) ? 2 * sq : 0));
    const g = src * (0.25 + Math.hypot(cplx[0], cplx[1]));
    const ph = Math.atan2(cplx[1], cplx[0]);
    addPartial(A, B, k, g, ph);
  }
  // keep a solid fundamental (sub weight) for bass
  addPartial(A, B, 1, 0.9, 0);
  // waveshape
  spectrumToSamples(A, B);
  let pk = 0;
  for (let n = 0; n < SAMP_N; n++) pk = Math.max(pk, Math.abs(sampBuf[n]));
  const drive = 1.6 + 1.6 * x;
  const inv = 1 / (pk || 1);
  const norm = 1 / Math.tanh(drive);
  for (let n = 0; n < SAMP_N; n++) sampBuf[n] = Math.tanh(drive * sampBuf[n] * inv) * norm;
  A.fill(0); B.fill(0);
  addSampled(A, B, sampBuf);
}

const DEFS = [
  { id: 'analog', fill: fillAnalog, norm: 'none', freqRatio: 1 },
  { id: 'harmonic', fill: fillHarmonic, norm: 'frame', freqRatio: 1 },
  { id: 'vowels', fill: fillVowels, norm: 'frame', freqRatio: 1 },
  { id: 'pulse', fill: fillPulse, norm: 'ptp', freqRatio: 1 },
  { id: 'organ', fill: fillOrgan, norm: 'frame', freqRatio: 0.5 },
  { id: 'glass', fill: fillGlass, norm: 'frame', freqRatio: 1 },
  { id: 'sync', fill: fillSync, norm: 'frame', freqRatio: 1 },
  { id: 'digital', fill: fillDigital, norm: 'frame', freqRatio: 1 },
  { id: 'strings', fill: fillStrings, norm: 'frame', freqRatio: 1 },
  { id: 'growl', fill: fillGrowl, norm: 'frame', freqRatio: 1 },
];
if (DEFS.length !== WAVETABLES.length || DEFS.some((d, i) => d.id !== WAVETABLES[i])) {
  throw new Error('wavetables.js: table list out of sync with params.js WAVETABLES');
}

// ───────────────────────── generation + cache ─────────────────────────

const cache = new Array(DEFS.length).fill(null);
let genMs = 0;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Scaled copy of one synthesized cycle into the table (with guard samples); returns its max |value|. */
function storeFrame(src, dst, off, N, g) {
  let m = 0;
  for (let i = 0; i < N; i++) {
    const y = src[i] * g;
    dst[off + i] = y;
    const a = y < 0 ? -y : y;
    if (a > m) m = a;
  }
  dst[off - 1] = dst[off + N - 1];
  dst[off + N] = dst[off];
  dst[off + N + 1] = dst[off + 1];
  return m;
}

function quantize(src, dst, q) {
  for (let i = 0; i < src.length; i++) {
    const y = src[i] * q;
    dst[i] = y >= 0 ? y + 0.5 : y - 0.5; // Int16Array store truncates → round half away from zero
  }
}

function buildTable(ti) {
  const t0 = now();
  const def = DEFS[ti];
  const raw = new Float32Array(WT_TABLE_SAMPLES); // unquantised, normalised
  const A = new Float64Array(H + 2), B = new Float64Array(H + 2);
  const tmp = new Float64Array(SAMPLES_MAX);
  let maxAbs = 0;
  for (let f = 0; f < WT_FRAMES; f++) {
    A.fill(0); B.fill(0);
    def.fill(f / (WT_FRAMES - 1), f, A, B);
    A[0] = 0; B[0] = 0;
    let g = 1;
    for (let L = 0; L < WT_LEVELS; L++) {
      const N = WT_LEVEL_SIZE[L];
      synthReal(A, B, WT_LEVEL_HARM[L], N, tmp, 0, 1);
      if (L === 0) {
        // normalisation: 'frame' → each frame peaks at 1; 'ptp' → peak-to-peak 2 (asymmetric DC-free pulses keep
        // their classic level, like the classic oscillator); 'none' → shapes are unit-amplitude by construction
        // (analog: identical level to the classic oscillator)
        let hi = -Infinity, lo = Infinity;
        for (let i = 0; i < N; i++) { const a = tmp[i]; if (a > hi) hi = a; if (a < lo) lo = a; }
        const pk = def.norm === 'frame' ? Math.max(hi, -lo) : def.norm === 'ptp' ? 0.5 * (hi - lo) : 1;
        g = pk > 1e-9 ? 1 / pk : 0;
      }
      const off = WT_LEVEL_BASE[L] + f * WT_LEVEL_STRIDE[L] + WT_GUARD_PRE;
      const a = storeFrame(tmp, raw, off, N, g);
      if (a > maxAbs) maxAbs = a;
    }
  }
  const q = Math.floor(32767 / Math.max(1e-6, maxAbs * 1.0001));
  const data = new Int16Array(WT_TABLE_SAMPLES);
  quantize(raw, data, q);
  const tab = { index: ti, id: def.id, data, scale: 1 / q, freqRatio: def.freqRatio, frames: WT_FRAMES };
  cache[ti] = tab;
  genMs += now() - t0;
  return tab;
}

/**
 * The generated table (cached): { index, id, data: Int16Array, scale, freqRatio, frames }.
 * Sample value = data[i] · scale. Frame f of mip level L: y(0) at WT_LEVEL_BASE[L] + f·WT_LEVEL_STRIDE[L] +
 * WT_GUARD_PRE, WT_LEVEL_SIZE[L] samples, plus guards y(−1) before and y(N), y(N+1) after.
 * freqRatio: the table's fundamental relative to the played note (organ: 0.5 → 16′ foundation).
 */
export function getWavetable(index) {
  const i = Math.max(0, Math.min(DEFS.length - 1, index | 0));
  return cache[i] || buildTable(i);
}

/** Generate every table now (call at construction time, never from the audio path). */
export function ensureAllWavetables() {
  for (let i = 0; i < DEFS.length; i++) if (!cache[i]) buildTable(i);
  return wavetableStats();
}

/** { tables, generated, bytes, ms } — memory and cumulative generation time. */
export function wavetableStats() {
  const generated = cache.filter(Boolean).length;
  return { tables: DEFS.length, generated, bytes: generated * WT_TABLE_SAMPLES * 2, ms: genMs };
}

/**
 * One single-cycle waveform for UI drawing: table `tableIndex`, frame position 0..1 (interpolated between
 * frames, as the oscillator does), resampled to `size` points. Returns a new Float32Array.
 */
export function getWavetableFrame(tableIndex, position, size = 256) {
  const tab = getWavetable(tableIndex);
  const L = 2, N = WT_LEVEL_SIZE[L], S = WT_LEVEL_STRIDE[L]; // 128 harmonics, 2048 samples
  const pos = (position < 0 ? 0 : position > 1 ? 1 : position) * (WT_FRAMES - 1);
  let fi = Math.floor(pos);
  if (fi > WT_FRAMES - 2) fi = WT_FRAMES - 2;
  const ff = pos - fi;
  const b0 = WT_LEVEL_BASE[L] + fi * S + WT_GUARD_PRE, b1 = b0 + S;
  const d = tab.data, sc = tab.scale;
  const out = new Float32Array(size);
  for (let j = 0; j < size; j++) {
    const x = (j / size) * N;
    const i = Math.floor(x), fr = x - i;
    const s0 = d[b0 + i] + fr * (d[b0 + i + 1] - d[b0 + i]);
    const s1 = d[b1 + i] + fr * (d[b1 + i + 1] - d[b1 + i]);
    out[j] = (s0 + ff * (s1 - s0)) * sc;
  }
  return out;
}

/** Reference pitch (Hz) at which formant-based tables sound "as designed" (UI hint). */
export const WAVETABLE_REF_HZ = { vowels: VOWEL_F0, strings: STRING_F0, growl: GROWL_F0 };
