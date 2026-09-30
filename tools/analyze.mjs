// Offline audio analysis for Aurora renders: metrics, spectrogram PNG, waveform PNG.
// Zero dependencies. Own radix-2 FFT.
//
//   import { analyze, spectrogram, waveformPng, formatMetrics } from './analyze.mjs';
//   const m = analyze(L, R, 48000, { lastNoteOff: 6.2 });
//   fs.writeFileSync('spec.png', spectrogram(L, R, 48000, { title: 'Aurora Pad · pad' }));

import { Raster, parseColor } from './png.mjs';

const LOG10 = Math.log10;
const DB_FLOOR = -200;
const db20 = x => (x > 1e-10 ? 20 * LOG10(x) : DB_FLOOR);
const db10 = x => (x > 1e-20 ? 10 * LOG10(x) : DB_FLOOR);
const r2 = x => (x == null || !Number.isFinite(x) ? x ?? null : Math.round(x * 100) / 100);
const r4 = x => (x == null || !Number.isFinite(x) ? x ?? null : Math.round(x * 1e4) / 1e4);
const r6 = x => (x == null || !Number.isFinite(x) ? x ?? null : Math.round(x * 1e6) / 1e6);

// ───────────────────────── FFT ─────────────────────────
export class FFT {
  /** In-place complex radix-2 FFT of size n (power of two). */
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two (got ${n})`);
    this.n = n;
    const bits = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    for (let k = 0; k < n >> 1; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** Forward transform (e^{-iωt}); inverse = true for the unscaled inverse. */
  transform(re, im, inverse = false) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cs[k], wi = sgn * sn[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

const fftCache = new Map();
export function getFFT(n) {
  let f = fftCache.get(n);
  if (!f) fftCache.set(n, (f = new FFT(n)));
  return f;
}

const winCache = new Map();
/** 'hann' | 'blackmanharris' (4-term, −92 dB sidelobes) — periodic form. */
export function makeWindow(type, n) {
  const key = type + n;
  let w = winCache.get(key);
  if (w) return w;
  w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] = type === 'hann'
      ? 0.5 - 0.5 * Math.cos(x)
      : 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
  }
  winCache.set(key, w);
  return w;
}

const nextPow2Near = x => 2 ** Math.round(Math.log2(x));

/**
 * Stereo power spectrum of the frame centred at `center`: out[k] = |XL[k]|² + |XR[k]|², k = 0..n/2.
 * Uses one complex FFT (L in re, R in im). Returns the windowed time-domain mean square (per channel avg).
 */
function stereoPowerFrame(fft, win, L, R, center, re, im, out) {
  const n = fft.n, len = L.length;
  const start = center - (n >> 1);
  let ms = 0;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    if (j >= 0 && j < len) {
      const w = win[i];
      const l = L[j] * w, r = R[j] * w;
      re[i] = l; im[i] = r;
      ms += l * l + r * r;
    } else { re[i] = 0; im[i] = 0; }
  }
  fft.transform(re, im);
  const h = n >> 1;
  for (let k = 0; k <= h; k++) {
    const k2 = (n - k) & (n - 1);
    out[k] = 0.5 * (re[k] * re[k] + im[k] * im[k] + re[k2] * re[k2] + im[k2] * im[k2]);
  }
  return ms;
}

// ───────────────────────── Loudness (ITU-R BS.1770-4 / EBU R128) ─────────────────────────
function kWeightingCoefs(fs) {
  // Stage 1: high shelf (+4 dB @ ~1.7 kHz); Stage 2: RLB high-pass (~38 Hz). Same analog prototypes as libebur128.
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

function biquadInto(x, y, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/**
 * Integrated loudness (LUFS), max momentary (400 ms), max short-term (3 s) and loudness range (LU).
 * Channels weighted 1.0 (L, R).
 */
export function loudness(L, R, fs) {
  const [s1, s2] = kWeightingCoefs(fs);
  const tmp = new Float64Array(L.length), kL = new Float64Array(L.length), kR = new Float64Array(L.length);
  biquadInto(biquadInto(L, tmp, s1), kL, s2);
  biquadInto(biquadInto(R, tmp, s1), kR, s2);
  const sub = Math.round(fs * 0.1); // 100 ms sub-blocks
  const nSub = Math.floor(L.length / sub);
  const subMs = new Float64Array(Math.max(1, nSub));
  for (let b = 0; b < nSub; b++) {
    let s = 0;
    for (let i = b * sub, e = i + sub; i < e; i++) s += kL[i] * kL[i] + kR[i] * kR[i];
    subMs[b] = s / sub; // Σ over channels of per-channel mean square
  }
  const lk = z => (z > 0 ? -0.691 + 10 * LOG10(z) : -Infinity);
  // 400 ms momentary blocks (4 sub-blocks, 75 % overlap)
  const blocks = [];
  if (nSub < 4) {
    let s = 0;
    for (let i = 0; i < L.length; i++) s += kL[i] * kL[i] + kR[i] * kR[i];
    if (L.length) blocks.push(s / L.length);
  } else {
    for (let b = 0; b + 4 <= nSub; b++) blocks.push((subMs[b] + subMs[b + 1] + subMs[b + 2] + subMs[b + 3]) / 4);
  }
  let momentaryMax = -Infinity;
  for (const z of blocks) momentaryMax = Math.max(momentaryMax, lk(z));
  const absGated = blocks.filter(z => lk(z) > -70);
  let integrated = null;
  if (absGated.length) {
    const rel = lk(absGated.reduce((a, b) => a + b, 0) / absGated.length) - 10;
    const gated = absGated.filter(z => lk(z) > rel);
    if (gated.length) integrated = lk(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
  // Short-term 3 s windows (30 sub-blocks), 100 ms hop.
  const shortTerm = [];
  if (nSub >= 30) {
    let s = 0;
    for (let b = 0; b < nSub; b++) {
      s += subMs[b];
      if (b >= 30) s -= subMs[b - 30];
      if (b >= 29) shortTerm.push(lk(s / 30));
    }
  }
  const shortMax = shortTerm.length ? Math.max(...shortTerm) : momentaryMax;
  // Loudness range (EBU Tech 3342)
  let lra = null;
  const stAbs = shortTerm.filter(v => v > -70);
  if (stAbs.length >= 2) {
    const meanE = stAbs.reduce((a, v) => a + 10 ** (v / 10), 0) / stAbs.length;
    const relGate = 10 * LOG10(meanE) - 20;
    const g = stAbs.filter(v => v > relGate).sort((a, b) => a - b);
    if (g.length >= 2) {
      const pct = p => g[Math.min(g.length - 1, Math.max(0, Math.round((p / 100) * (g.length - 1))))];
      lra = pct(95) - pct(10);
    }
  }
  const fin = v => (Number.isFinite(v) ? v : null);
  return { integrated: fin(integrated), momentaryMax: fin(momentaryMax), shortTermMax: fin(shortMax), lra: fin(lra) };
}

// ───────────────────────── True peak (4× oversampling) ─────────────────────────
const TP_TAPS = 16; // taps each side per phase (32 per phase)
const TP_COEF = (() => {
  const i0 = x => { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const beta = 8, norm = i0(beta);
  const out = [];
  for (let p = 1; p < 4; p++) {
    const c = new Float64Array(2 * TP_TAPS);
    let sum = 0;
    for (let j = -TP_TAPS; j < TP_TAPS; j++) {
      const tau = p / 4 - j; // y(n + p/4) = Σ_j x[n + j] g(p/4 − j)
      const sinc = tau === 0 ? 1 : Math.sin(Math.PI * tau) / (Math.PI * tau);
      const r = tau / (TP_TAPS + 1);
      const w = Math.abs(r) >= 1 ? 0 : i0(beta * Math.sqrt(1 - r * r)) / norm;
      c[j + TP_TAPS] = sinc * w;
      sum += sinc * w;
    }
    for (let k = 0; k < c.length; k++) c[k] /= sum; // unity DC gain per phase
    out.push(c);
  }
  return out;
})();

/** Approximate true peak (linear) of one channel via 4× windowed-sinc interpolation. */
export function truePeak(x, samplePeak = null) {
  const n = x.length;
  if (samplePeak == null) { samplePeak = 0; for (let i = 0; i < n; i++) samplePeak = Math.max(samplePeak, Math.abs(x[i])); }
  let tp = samplePeak;
  const thr = samplePeak * 0.3; // intersample overs only matter near loud samples
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(x[i]) < thr && Math.abs(x[i + 1]) < thr) continue;
    for (let p = 0; p < 3; p++) {
      const c = TP_COEF[p];
      let acc = 0;
      for (let j = -TP_TAPS; j < TP_TAPS; j++) {
        const k = i + j;
        if (k >= 0 && k < n) acc += x[k] * c[j + TP_TAPS];
      }
      const a = Math.abs(acc);
      if (a > tp) tp = a;
    }
  }
  return tp;
}

// ───────────────────────── Main analysis ─────────────────────────
/**
 * Analyse a stereo render.
 * @param {Float32Array} L
 * @param {Float32Array} [R=L]
 * @param {number} sampleRate
 * @param {{lastNoteOff?: number, silenceDb?: number}} [opts]
 *   lastNoteOff: seconds of the last note-off (enables release/tail metrics).
 *   silenceDb: absolute threshold for "silent" (default −80 dBFS, sample peak).
 * @returns {object} metrics (dB values are dBFS unless noted; null when undefined)
 */
export function analyze(L, R = L, sampleRate = 48000, opts = {}) {
  const silenceDb = opts.silenceDb ?? -80;
  const n = Math.min(L.length, R.length);
  const sr = sampleRate;
  // 1. Non-finite scan + sanitised copies if needed
  let nanCount = 0, infCount = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    if (l !== l) nanCount++; else if (l === Infinity || l === -Infinity) infCount++;
    if (r !== r) nanCount++; else if (r === Infinity || r === -Infinity) infCount++;
  }
  if (nanCount || infCount) {
    const cl = new Float32Array(n), cr = new Float32Array(n);
    for (let i = 0; i < n; i++) { cl[i] = Number.isFinite(L[i]) ? L[i] : 0; cr[i] = Number.isFinite(R[i]) ? R[i] : 0; }
    L = cl; R = cr;
  }
  // 2. Basic level statistics
  let pkL = 0, pkR = 0, sL = 0, sR = 0, qL = 0, qR = 0, lr = 0, clip = 0, sM = 0, sS = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
    if (al > pkL) pkL = al;
    if (ar > pkR) pkR = ar;
    if (al > 1 || ar > 1) clip++;
    sL += l; sR += r; qL += l * l; qR += r * r; lr += l * r;
    const m = 0.5 * (l + r), s = 0.5 * (l - r);
    sM += m * m; sS += s * s;
  }
  const peak = Math.max(pkL, pkR);
  const msAll = n ? (qL + qR) / (2 * n) : 0;
  const tp = Math.max(truePeak(L, pkL), R === L ? 0 : truePeak(R, pkR));
  const loud = loudness(L, R, sr);
  const dcL = n ? sL / n : 0, dcR = n ? sR / n : 0;
  const corr = qL > 0 && qR > 0 ? lr / Math.sqrt(qL * qR) : qL > 0 || qR > 0 ? 0 : 1;
  const width = sM > 1e-20 ? Math.sqrt(sS / sM) : sS > 1e-20 ? 10 : 0;

  // 3. STFT-based spectral metrics
  const N = sr > 60000 ? 4096 : 2048;
  const hop = N >> 2;
  const fft = getFFT(N), win = makeWindow('hann', N);
  let w2 = 0;
  for (let i = 0; i < N; i++) w2 += win[i] * win[i];
  const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2 + 1);
  const ltas = new Float64Array(N / 2 + 1);
  const binHz = sr / N;
  const nFrames = n ? Math.floor(n / hop) + 1 : 0;
  const frameCent = new Float64Array(nFrames), frameDb = new Float64Array(nFrames), frameMag = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const ms = stereoPowerFrame(fft, win, L, R, f * hop, re, im, P);
    frameDb[f] = db10(ms / (2 * w2));
    let mSum = 0, fSum = 0;
    for (let k = 1; k <= N / 2; k++) {
      ltas[k] += P[k];
      const mag = Math.sqrt(P[k]);
      mSum += mag; fSum += mag * k * binHz;
    }
    frameMag[f] = mSum;
    frameCent[f] = mSum > 0 ? fSum / mSum : 0;
  }
  const loudestFrame = nFrames ? Math.max(...frameDb) : DB_FLOOR;
  const gate = Math.max(-70, loudestFrame - 60);
  let cNum = 0, cDen = 0;
  for (let f = 0; f < nFrames; f++) {
    if (frameDb[f] < gate) continue;
    const wgt = 10 ** (frameDb[f] / 10);
    cNum += frameCent[f] * wgt; cDen += wgt;
  }
  const centroid = cDen > 0 ? cNum / cDen : null;
  const segs = Math.min(64, nFrames);
  const centroidOverTime = [];
  for (let s = 0; s < segs; s++) {
    const f0 = Math.floor((s * nFrames) / segs), f1 = Math.floor(((s + 1) * nFrames) / segs);
    let num = 0, den = 0, e = 0;
    for (let f = f0; f < f1; f++) {
      e += 10 ** (frameDb[f] / 10);
      if (frameDb[f] < gate) continue;
      const wgt = 10 ** (frameDb[f] / 10);
      num += frameCent[f] * wgt; den += wgt;
    }
    centroidOverTime.push({
      t: r2(((f0 + f1 - 1) / 2) * hop / sr),
      hz: den > 0 ? Math.round(num / den) : null,
      db: r2(db10(e / Math.max(1, f1 - f0))),
    });
  }
  let eTot = 0, eLow = 0, eMid = 0, eHigh = 0, e16 = 0, pkBin = 1, pkVal = 0;
  for (let k = 1; k <= N / 2; k++) {
    const f = k * binHz, e = ltas[k];
    eTot += e;
    if (f < 250) eLow += e; else if (f <= 4000) eMid += e; else eHigh += e;
    if (f >= 16000) e16 += e;
    if (e > pkVal) { pkVal = e; pkBin = k; }
  }
  let peakFreq = null;
  if (pkVal > 0 && pkBin > 1 && pkBin < N / 2) {
    const a = db10(ltas[pkBin - 1]), b = db10(ltas[pkBin]), c = db10(ltas[pkBin + 1]);
    const d = a - 2 * b + c;
    peakFreq = (pkBin + (d !== 0 ? (0.5 * (a - c)) / d : 0)) * binHz;
  }
  const pct = e => (eTot > 0 ? (100 * e) / eTot : 0);
  const rel = e => (eTot > 0 ? db10(e / eTot) : DB_FLOOR);

  // 4. Envelopes: 1 ms peak envelope (attack), 5 ms-hop / 20 ms RMS envelope (decay)
  const h1 = Math.max(1, Math.round(sr / 1000));
  const nH1 = Math.ceil(n / h1);
  const pk1 = new Float32Array(nH1);
  for (let b = 0; b < nH1; b++) {
    let m = 0;
    for (let i = b * h1, e = Math.min(n, i + h1); i < e; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > m) m = a;
    }
    pk1[b] = m;
  }
  const hold = new Float32Array(nH1); // trailing 12 ms max-hold
  for (let b = 0; b < nH1; b++) {
    let m = 0;
    for (let j = Math.max(0, b - 11); j <= b; j++) if (pk1[j] > m) m = pk1[j];
    hold[b] = m;
  }
  let gMax = 0;
  for (let b = 0; b < nH1; b++) if (hold[b] > gMax) gMax = hold[b];
  let onsetTime = null, attackTime = null;
  if (gMax > 1e-6) {
    let on = 0;
    while (on < nH1 && hold[on] < gMax * 0.01) on++;
    onsetTime = (on * h1) / sr;
    let lMax = 0;
    for (let b = on; b < Math.min(nH1, on + 1500); b++) if (hold[b] > lMax) lMax = hold[b];
    let a10 = on;
    while (a10 < nH1 && hold[a10] < 0.1 * lMax) a10++;
    let a90 = a10;
    while (a90 < nH1 && hold[a90] < 0.9 * lMax) a90++;
    attackTime = ((a90 - a10) * h1) / sr;
  }
  const h5 = Math.max(1, Math.round(sr * 0.005));
  const nH5 = Math.ceil(n / h5);
  const ms5 = new Float64Array(nH5), pk5 = new Float32Array(nH5);
  for (let b = 0; b < nH5; b++) {
    let s = 0, m = 0;
    const i0 = b * h5, e = Math.min(n, i0 + h5);
    for (let i = i0; i < e; i++) {
      s += L[i] * L[i] + R[i] * R[i];
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > m) m = a;
    }
    ms5[b] = s / (2 * Math.max(1, e - i0));
    pk5[b] = m;
  }
  const env = new Float64Array(nH5); // 20 ms centred RMS, dB
  for (let b = 0; b < nH5; b++) {
    let s = 0, c = 0;
    for (let j = b - 2; j <= b + 1; j++) if (j >= 0 && j < nH5) { s += ms5[j]; c++; }
    env[b] = db10(s / Math.max(1, c));
  }
  const hopSec = h5 / sr;
  const decayFrom = (p) => {
    if (p < 0 || p >= nH5) return { t60: null, method: null };
    const top = env[p];
    if (top <= silenceDb) return { t60: null, method: null };
    for (let b = p + 1; b < nH5; b++) if (env[b] <= top - 60) return { t60: (b - p) * hopSec, method: 'direct' };
    // Extrapolate from the decay slope (T20/T30 style) between −5 dB and −35 dB (or the end).
    let s = p;
    while (s < nH5 && env[s] > top - 5) s++;
    let e = s;
    while (e < nH5 && env[e] > top - 35 && env[e] > silenceDb) e++;
    if (e - s < 8 || env[s] - env[Math.min(e, nH5 - 1)] < 10) return { t60: null, method: 'no-decay' };
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let b = s; b < e; b++) { const x = b * hopSec, y = env[b]; sx += x; sy += y; sxx += x * x; sxy += x * y; cnt++; }
    const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
    if (!(slope < 0)) return { t60: null, method: 'no-decay' };
    return { t60: (s - p) * hopSec + (55 / -slope), method: 'extrapolated' };
  };
  let pIdx = 0;
  for (let b = 1; b < nH5; b++) if (env[b] > env[pIdx]) pIdx = b;
  const dPeak = decayFrom(pIdx);

  const thr = 10 ** (silenceDb / 20);
  let lastLoud = -1;
  for (let b = nH5 - 1; b >= 0; b--) if (pk5[b] > thr) { lastLoud = b; break; }
  const silentAt = lastLoud < 0 ? 0 : lastLoud + 1 < nH5 ? ((lastLoud + 1) * h5) / sr : null; // null → still sounding at the end

  let release = null;
  if (opts.lastNoteOff != null) {
    const b0 = Math.min(nH5 - 1, Math.max(0, Math.round(opts.lastNoteOff / hopSec)));
    const d = decayFrom(b0);
    release = {
      levelAtOffDb: r2(env[b0]),
      t60: r2(d.t60), t60Method: d.method,
      tailToSilence: silentAt == null ? null : r2(Math.max(0, silentAt - opts.lastNoteOff)),
    };
  }
  // Noise floor: quietest 50 ms RMS window inside the final second.
  const w50 = 10, lastSecStart = Math.max(0, nH5 - Math.round(1 / hopSec));
  let floorMs = Infinity;
  for (let b = lastSecStart; b + w50 <= nH5; b += 2) {
    let s = 0;
    for (let j = b; j < b + w50; j++) s += ms5[j];
    floorMs = Math.min(floorMs, s / w50);
  }
  if (!Number.isFinite(floorMs)) floorMs = nH5 ? ms5.reduce((a, b) => a + b, 0) / nH5 : 0;
  let endPk = 0;
  for (let i = Math.max(0, n - Math.round(sr * 0.1)); i < n; i++) endPk = Math.max(endPk, Math.abs(L[i]), Math.abs(R[i]));

  return {
    sampleRate: sr,
    duration: r4(n / sr),
    nanCount, infCount,
    clipCount: clip,
    peakDb: r2(db20(peak)), peakDbL: r2(db20(pkL)), peakDbR: r2(db20(pkR)),
    peak: r6(peak),
    truePeakDb: r2(db20(tp)),
    rmsDb: r2(db10(msAll)),
    lufs: r2(loud.integrated), lufsMomentaryMax: r2(loud.momentaryMax), lufsShortTermMax: r2(loud.shortTermMax), lra: r2(loud.lra),
    crestDb: r2(msAll > 0 ? db20(peak) - db10(msAll) : 0),
    dcL: r6(dcL), dcR: r6(dcR), dcMax: r6(Math.max(Math.abs(dcL), Math.abs(dcR))),
    centroidHz: centroid == null ? null : Math.round(centroid),
    centroidOverTime,
    peakFreqHz: r2(peakFreq),
    bands: {
      lowPct: r2(pct(eLow)), midPct: r2(pct(eMid)), highPct: r2(pct(eHigh)),
      lowDb: r2(rel(eLow)), midDb: r2(rel(eMid)), highDb: r2(rel(eHigh)),
    },
    above16kDb: r2(rel(e16)), above16kPct: r4(pct(e16)),
    correlation: r4(corr), width: r4(width), sideDb: r2(sM > 0 ? db10(sS / sM) : sS > 0 ? 0 : DB_FLOOR),
    balanceDb: r2(qR > 0 && qL > 0 ? db10(qL / qR) : 0),
    onsetTime: r4(onsetTime), attackTime: r4(attackTime),
    t60: r2(dPeak.t60), t60Method: dPeak.method,
    silentAt: silentAt == null ? null : r4(silentAt), silentAtEnd: silentAt != null,
    release,
    noiseFloorDb: r2(db10(floorMs)),
    endPeakDb: r2(db20(endPk)),
  };
}

// ───────────────────────── Formatting ─────────────────────────
const fmtHz = hz => (hz == null ? '—' : hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`);
const fmtS = s => (s == null ? '—' : s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(1)}s`);
const fmtDb = (d, p = 1) => (d == null ? '—' : d <= -199 ? '-inf' : d.toFixed(p));

/** Compact one-line summary of analyze() output. */
export function formatMetrics(m) {
  const parts = [
    `peak ${fmtDb(m.peakDb)} dBFS`, `TP ${fmtDb(m.truePeakDb)}`, `LUFS ${fmtDb(m.lufs)}`, `crest ${fmtDb(m.crestDb)}`,
    `cent ${fmtHz(m.centroidHz)}Hz`, `L/M/H ${Math.round(m.bands.lowPct)}/${Math.round(m.bands.midPct)}/${Math.round(m.bands.highPct)}%`,
    `>16k ${fmtDb(m.above16kDb, 0)}dB`, `corr ${m.correlation?.toFixed(2)}`, `width ${m.width?.toFixed(2)}`,
    `atk ${fmtS(m.attackTime)}`, `T60 ${fmtS(m.t60)}`,
  ];
  if (m.release) parts.push(`tail ${m.release.tailToSilence == null ? '>end' : fmtS(m.release.tailToSilence)}`);
  parts.push(`DC ${Math.abs(m.dcMax) < 1e-4 ? '<1e-4' : m.dcMax.toExponential(1)}`);
  if (m.nanCount || m.infCount) parts.push(`NaN ${m.nanCount} Inf ${m.infCount}`);
  if (m.clipCount) parts.push(`clip ${m.clipCount}`);
  return parts.join('  ');
}

// ───────────────────────── Colour maps ─────────────────────────
// Polynomial fits of matplotlib's inferno/magma (Matt Zucker's fits, CC0).
const POLY = {
  inferno: [
    [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
    [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
    [11.60249308247187, -3.972853965665698, -15.9423941062914],
    [-41.70399613139459, 17.43639888205313, 44.35414519872813],
    [77.162935699427, -33.40235894210092, -81.80730925738993],
    [-71.31942824499214, 32.62606426397723, 73.20951985803202],
    [25.13112622477341, -12.24266895238567, -23.07032500287172],
  ],
  magma: [
    [-0.002136485053939582, -0.000749655052795221, -0.005386127855323933],
    [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
    [8.353717279216625, -3.577719514958484, 0.3144679030132573],
    [-27.66873308576866, 14.26473078096533, -13.64921318813922],
    [52.17613981234068, -27.94360607168351, 12.94416944238394],
    [-50.76852536473588, 29.04658282127291, 4.23415299384598],
    [18.65570506591883, -11.48977351997711, -5.601961508734096],
  ],
};
const AURORA_STOPS = [
  [0, '#07080d'], [0.18, '#1a1240'], [0.36, '#3b1f86'], [0.52, '#7a4fd8'], [0.66, '#ff6bd6'],
  [0.8, '#5cf2ff'], [0.92, '#3ef0b0'], [1, '#f2fff8'],
];
const lutCache = new Map();
/** 256×RGB lookup table for 'inferno' | 'magma' | 'aurora'. */
export function colormap(name = 'inferno') {
  let lut = lutCache.get(name);
  if (lut) return lut;
  lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let rgb;
    if (POLY[name]) {
      const c = POLY[name];
      rgb = [0, 1, 2].map(ch => { let v = c[6][ch]; for (let k = 5; k >= 0; k--) v = v * t + c[k][ch]; return v * 255; });
    } else {
      let j = 0;
      while (j < AURORA_STOPS.length - 2 && t > AURORA_STOPS[j + 1][0]) j++;
      const [t0, c0] = AURORA_STOPS[j], [t1, c1] = AURORA_STOPS[j + 1];
      const u = (t - t0) / (t1 - t0), a = parseColor(c0), b = parseColor(c1);
      rgb = [0, 1, 2].map(ch => a[ch] + (b[ch] - a[ch]) * u);
    }
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = Math.max(0, Math.min(255, Math.round(rgb[ch])));
  }
  lutCache.set(name, lut);
  return lut;
}

// ───────────────────────── Plot helpers ─────────────────────────
const THEME = {
  bg0: '#07080d', bg1: '#0c0f18', text: '#e8ecff', dim: '#8e97b8', faint: '#5a6284', line: '#8ca0dc',
  cyan: '#5cf2ff', violet: '#a78bfa', pink: '#ff6bd6', amber: '#ffc46b', red: '#ff6b81', teal: '#3ef0b0',
};

function niceTimeStep(duration, maxTicks) {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120];
  for (const s of steps) if (duration / s <= maxTicks) return s;
  return 300;
}
const fmtTime = (t, step) => (step < 1 ? `${t.toFixed(step < 0.1 ? 2 : 1)}s` : `${Math.round(t)}s`);

function drawTimeAxis(img, x0, pw, yTop, yBottom, duration, { grid = true } = {}) {
  const step = niceTimeStep(duration, Math.max(4, Math.floor(pw / 90)));
  for (let t = 0; t <= duration + 1e-9; t += step) {
    const x = x0 + (t / duration) * pw;
    img.vline(x, yBottom + 1, yBottom + 4, THEME.dim, 0.9);
    if (grid && t > 0) img.vline(x, yTop, yBottom, '#ffffff', 0.07, 3);
    const label = fmtTime(t, step);
    const align = t === 0 ? 'left' : x + img.textWidth(label) / 2 > x0 + pw ? 'right' : 'center';
    img.text(align === 'right' ? x0 + pw : x, yBottom + 8, label, THEME.dim, { align });
  }
}

function drawHeader(img, x0, title, subtitle, right) {
  if (title) img.text(x0, 7, title, THEME.text, { scale: 2 });
  const tw = title ? img.textWidth(title, 2) + 14 : 0;
  if (subtitle) img.text(x0 + tw, 12, subtitle, THEME.dim);
  if (right) img.text(img.width - 12, 12, right, THEME.faint, { align: 'right' });
}

function drawMarkers(img, markers, x0, pw, yTop, yBottom, duration) {
  for (const m of markers || []) {
    if (m.t == null || m.t < 0 || m.t > duration) continue;
    const x = x0 + (m.t / duration) * pw;
    img.vline(x, yTop, yBottom, m.color || THEME.teal, 0.55, 4);
    if (m.label) img.text(x + 4, yTop + 4, m.label, m.color || THEME.teal, { alpha: 0.9 });
  }
}

// ───────────────────────── Spectrogram ─────────────────────────
/**
 * Log-frequency multi-resolution spectrogram as an RGB Raster.
 * opts: { width=1400, height=500, fmin=20, fmax=20000, dbTop=0, dbRange=120, colormap='inferno'|'magma'|'aurora',
 *         title, subtitle, markers:[{t, label, color}] }
 * Levels are dBFS of a sinusoid (per channel, L/R power-averaged).
 */
export function spectrogramRaster(L, R = L, sampleRate = 48000, opts = {}) {
  const W = opts.width ?? 1400, H = opts.height ?? 500;
  const fmin = opts.fmin ?? 20, fmaxReq = opts.fmax ?? 20000;
  const dbTop = opts.dbTop ?? 0, dbRange = opts.dbRange ?? 120;
  const lut = colormap(opts.colormap ?? 'inferno');
  const sr = sampleRate, n = Math.min(L.length, R.length), duration = Math.max(n / sr, 1e-3);
  const ml = 58, mr = 70, mt = 30, mb = 30;
  const x0 = ml, y0 = mt, pw = W - ml - mr, ph = H - mt - mb;
  const img = new Raster(W, H, THEME.bg0);
  img.gradientRect(0, 0, W, H, THEME.bg1, THEME.bg0);
  const fmax = fmaxReq;
  const nyq = sr / 2;

  // Resolution tiers: long window for lows, short for highs (crossfaded in log-frequency).
  const tiers = [
    { N: nextPow2Near(sr * 0.3413), upTo: 150 },
    { N: nextPow2Near(sr * 0.1707), upTo: 600 },
    { N: nextPow2Near(sr * 0.0853), upTo: 2500 },
    { N: nextPow2Near(sr * 0.0427), upTo: Infinity },
  ].map(t => {
    const fft = getFFT(t.N), win = makeWindow('blackmanharris', t.N);
    let ws = 0;
    for (let i = 0; i < t.N; i++) ws += win[i];
    return { ...t, fft, win, norm: 2 / (ws * ws), re: new Float64Array(t.N), im: new Float64Array(t.N), P: new Float64Array(t.N / 2 + 1) };
  });
  const XF = 1.5; // crossfade width (frequency ratio) around each tier boundary
  // Per-row lookup: frequency, bin ranges per tier, tier weights.
  const rows = [];
  const lf = Math.log(fmax / fmin);
  for (let y = 0; y < ph; y++) {
    const u = 1 - y / (ph - 1);
    const f = fmin * Math.exp(u * lf);
    const fLo = fmin * Math.exp((1 - (y + 0.5) / (ph - 1)) * lf), fHi = fmin * Math.exp((1 - (y - 0.5) / (ph - 1)) * lf);
    const weights = tiers.map((t, i) => {
      const lo = i === 0 ? 0 : tiers[i - 1].upTo, hi = t.upTo;
      const rise = lo === 0 ? 1 : Math.min(1, Math.max(0, Math.log(f / (lo / Math.sqrt(XF))) / Math.log(XF)));
      const fall = hi === Infinity ? 1 : Math.min(1, Math.max(0, Math.log((hi * Math.sqrt(XF)) / f) / Math.log(XF)));
      return Math.min(rise, fall);
    });
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;
    const bins = tiers.map(t => {
      const bw = sr / t.N;
      const b = f / bw, bLo = fLo / bw, bHi = fHi / bw;
      return bHi - bLo >= 1 ? { lo: Math.max(0, Math.floor(bLo)), hi: Math.min(t.N / 2, Math.ceil(bHi)), b } : { lo: -1, hi: -1, b };
    });
    rows.push({ f, above: f > nyq, weights: weights.map(w => w / wsum), bins });
  }
  // Each tier is evaluated on its own frame grid (hop ≤ N/8 or one frame per pixel column, whichever is
  // coarser) and linearly interpolated (in dB) to the pixel columns — long windows need few frames.
  const colHop = n / pw;
  const pixDb = new Float32Array(pw * ph);
  for (let ti = 0; ti < tiers.length; ti++) {
    const t = tiers[ti], P = t.P;
    const ys = [];
    for (let y = 0; y < ph; y++) if (!rows[y].above && rows[y].weights[ti] > 0) ys.push(y);
    if (!ys.length) continue;
    const hopS = Math.max(colHop, t.N / 8);
    const nF = Math.ceil(n / hopS) + 2;
    const mat = new Float32Array(nF * ys.length);
    for (let f = 0; f < nF; f++) {
      stereoPowerFrame(t.fft, t.win, L, R, Math.round(f * hopS), t.re, t.im, P);
      for (let j = 0; j < ys.length; j++) {
        const bn = rows[ys[j]].bins[ti];
        let p;
        if (bn.lo >= 0) {
          p = 0;
          for (let k = bn.lo; k <= bn.hi; k++) if (P[k] > p) p = P[k];
        } else {
          const k = Math.min(t.N / 2 - 1, Math.floor(bn.b)), fr = bn.b - k;
          p = P[k] * (1 - fr) + P[k + 1] * fr;
        }
        mat[f * ys.length + j] = db10(p * t.norm);
      }
    }
    for (let x = 0; x < pw; x++) {
      const pos = ((x + 0.5) * colHop) / hopS;
      const f0 = Math.min(nF - 2, Math.floor(pos)), fr = pos - f0;
      for (let j = 0; j < ys.length; j++) {
        const y = ys[j];
        const a = mat[f0 * ys.length + j], b = mat[(f0 + 1) * ys.length + j];
        pixDb[x * ph + y] += rows[y].weights[ti] * (a + (b - a) * fr);
      }
    }
  }
  for (let x = 0; x < pw; x++) {
    for (let y = 0; y < ph; y++) {
      const i = ((y0 + y) * W + x0 + x) * 3;
      if (rows[y].above) { img.data[i] = 10; img.data[i + 1] = 12; img.data[i + 2] = 20; continue; }
      const t = (pixDb[x * ph + y] - (dbTop - dbRange)) / dbRange;
      const c = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
      img.data[i] = lut[c]; img.data[i + 1] = lut[c + 1]; img.data[i + 2] = lut[c + 2];
    }
  }
  // Frequency axis
  const yOf = f => y0 + (1 - Math.log(f / fmin) / lf) * (ph - 1);
  const major = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (let dec = 10; dec <= 10000; dec *= 10) {
    for (let k = 1; k <= 9; k++) {
      const f = dec * k;
      if (f < fmin || f > fmax) continue;
      img.hline(x0 - 3, x0 - 1, yOf(f), THEME.faint, 0.9);
    }
  }
  for (const f of major) {
    if (f < fmin || f > fmax) continue;
    const y = yOf(f);
    img.hline(x0 - 6, x0 - 1, y, THEME.dim);
    if (f > fmin && f < fmax) img.hline(x0, x0 + pw - 1, y, '#ffffff', 0.08, 3);
    img.text(x0 - 9, y - 3, f >= 1000 ? `${f / 1000}k` : `${f}`, THEME.dim, { align: 'right' });
  }
  img.text(x0 - 9, y0 + ph + 8, 'Hz', THEME.faint, { align: 'right' });
  drawTimeAxis(img, x0, pw, y0, y0 + ph, duration);
  drawMarkers(img, opts.markers, x0, pw, y0, y0 + ph, duration);
  // Frame
  img.hline(x0 - 1, x0 + pw, y0 - 1, THEME.line, 0.25);
  img.hline(x0 - 1, x0 + pw, y0 + ph, THEME.line, 0.25);
  img.vline(x0 - 1, y0 - 1, y0 + ph, THEME.line, 0.25);
  img.vline(x0 + pw, y0 - 1, y0 + ph, THEME.line, 0.25);
  // Colour bar
  const cbx = x0 + pw + 14, cbw = 10;
  for (let y = 0; y < ph; y++) {
    const c = Math.round((1 - y / (ph - 1)) * 255) * 3;
    for (let x = 0; x < cbw; x++) img.blend(cbx + x, y0 + y, lut[c], lut[c + 1], lut[c + 2], 1);
  }
  for (let d = 0; d <= dbRange; d += 20) {
    const y = y0 + (d / dbRange) * (ph - 1);
    img.hline(cbx + cbw, cbx + cbw + 3, y, THEME.dim);
    img.text(cbx + cbw + 6, y - 3, `${dbTop - d}`, THEME.dim);
  }
  img.text(cbx - 1, y0 + ph + 8, 'dBFS', THEME.faint);
  drawHeader(img, x0, opts.title, opts.subtitle, opts.right ?? `${(sr / 1000).toFixed(1)} kHz · log freq`);
  return img;
}

/** Spectrogram PNG buffer. See spectrogramRaster for opts. */
export function spectrogram(L, R, sampleRate, opts = {}) {
  return spectrogramRaster(L, R, sampleRate, opts).toPng();
}

// ───────────────────────── Waveform ─────────────────────────
/**
 * Stereo waveform PNG (min/max envelope + RMS core, L = cyan, R = violet).
 * opts: { width=1400, height=360, title, subtitle, markers }
 */
export function waveformRaster(L, R = L, sampleRate = 48000, opts = {}) {
  const W = opts.width ?? 1400, H = opts.height ?? 360;
  const n = Math.min(L.length, R.length), sr = sampleRate, duration = Math.max(n / sr, 1e-3);
  const ml = 58, mr = 20, mt = 30, mb = 30, gap = 10;
  const x0 = ml, pw = W - ml - mr, laneH = Math.floor((H - mt - mb - gap) / 2);
  const img = new Raster(W, H, THEME.bg0);
  img.gradientRect(0, 0, W, H, THEME.bg1, THEME.bg0);
  const lanes = [
    { data: L, y: mt, color: parseColor(THEME.cyan), name: 'L' },
    { data: R, y: mt + laneH + gap, color: parseColor(THEME.violet), name: 'R' },
  ];
  for (const lane of lanes) {
    const cy = lane.y + laneH / 2, amp = laneH / 2 - 2;
    img.fillRect(x0, lane.y, pw, laneH, '#ffffff', 0.018);
    for (const [v, lbl, dash] of [[1, '0dB', 0], [0.5, '-6', 3], [0.25, '-12', 3]]) {
      img.hline(x0, x0 + pw - 1, cy - v * amp, '#ffffff', v === 1 ? 0.12 : 0.07, dash);
      img.hline(x0, x0 + pw - 1, cy + v * amp, '#ffffff', v === 1 ? 0.12 : 0.07, dash);
      img.text(x0 - 8, cy - v * amp - 3, lbl, THEME.faint, { align: 'right' });
    }
    img.hline(x0, x0 + pw - 1, cy, '#ffffff', 0.14);
    img.text(x0 - 8, cy - 3, lane.name, lane.color, { align: 'right', scale: 1 });
    const [r, g, b] = lane.color;
    for (let x = 0; x < pw; x++) {
      const s0 = Math.floor((x / pw) * n), s1 = Math.max(s0 + 1, Math.floor(((x + 1) / pw) * n));
      let mn = Infinity, mx = -Infinity, q = 0, over = false;
      for (let i = s0; i < Math.min(n, s1); i++) {
        let v = lane.data[i];
        if (!Number.isFinite(v)) { over = true; continue; }
        if (v > mx) mx = v;
        if (v < mn) mn = v;
        q += v * v;
        if (v > 1 || v < -1) over = true;
      }
      if (mx === -Infinity) continue;
      const rms = Math.sqrt(q / Math.max(1, s1 - s0));
      const yMin = cy - Math.min(1, mx) * amp, yMax = cy - Math.max(-1, mn) * amp;
      for (let y = Math.floor(yMin); y <= Math.ceil(yMax); y++) img.blend(x0 + x, y, r, g, b, 0.42);
      const yr0 = cy - Math.min(1, rms) * amp, yr1 = cy + Math.min(1, rms) * amp;
      for (let y = Math.floor(yr0); y <= Math.ceil(yr1); y++) img.blend(x0 + x, y, 255 - (255 - r) * 0.55, 255 - (255 - g) * 0.55, 255 - (255 - b) * 0.55, 0.85);
      if (over) img.fillRect(x0 + x, lane.y, 1, 4, THEME.red);
    }
  }
  drawTimeAxis(img, x0, pw, mt, mt + 2 * laneH + gap, duration, { grid: true });
  drawMarkers(img, opts.markers, x0, pw, mt, mt + 2 * laneH + gap, duration);
  drawHeader(img, x0, opts.title, opts.subtitle, opts.right ?? 'waveform · L / R');
  return img;
}

export function waveformPng(L, R, sampleRate, opts = {}) {
  return waveformRaster(L, R, sampleRate, opts).toPng();
}
