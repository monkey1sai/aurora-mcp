// Physical-modelling engine: exciter → resonator.
//
//   string   — bidirectional digital waveguide (two delay segments split at the excitation/bow point, so the
//              pick/bow position comb falls out of the physics). Bridge reflection = exactly-tuned fractional
//              allpass (phase delay solved at f0, with hysteresis) → 4-stage stiffness-dispersion allpass cascade
//              → one-pole loss filter designed for T60 = `decay` at f0 and a brightness-dependent T60 at a high
//              reference frequency. The fundamental is tuned exactly by subtracting every filter's phase delay
//              at f0 (for the bow: a 1/k-weighted mean over the harmonics, since the stick-slip motion
//              mode-locks them). Bow = STK-style friction junction with a pitch-invariant loss spectrum and a
//              bow-point/force window kept inside the single-slip (Helmholtz) regime; breath = noise + jet tone.
//              In-loop DC blocker (non-bowed) and a DC-gain bound keep sub-audio modes from outliving the note.
//              Stereo = two slightly detuned strings with slightly different excitation points.
//              Body = parallel resonant band-passes (guitar/koto-like), mixed by `body`.
//   bar/bell/glass/membrane/plate — modal banks of complex one-pole (coupled-form) resonators, 24–32 modes
//              with material-specific ratios morphed by `inharm`, per-mode T60 falling with frequency (tilted by
//              `brightness`), position-weighted excitation, per-mode stereo radiation (`spread`), doublet
//              splitting for bells/glass (natural beating shimmer). Modes above 0.45·fs are skipped.
//
// Exciters: pluck (impulse + noise burst through a hardness-controlled 2-pole low-pass; on the string it is
// integrated → 1/k plucked spectrum), mallet (Hann force pulse, hardness & pitch = contact time), bow
// (friction on the string; resonant drive + rosin noise with bow damping on modal models), breath (filtered
// turbulence + a jet tone locked to the fundamental + a little direct air noise).
// Normalisation: every strike is normalised by *simulating* its exact onset peak at noteOn (string: scratch
// copy of the loop; modal: whole bank), so plucks/strikes peak ≈ ±1 at any pitch/hardness/position.
// Continuous exciters are normalised analytically (drive at resonance, noise through the bank).
// Level, pan and routing are applied by the voice — this engine only produces unit-scale stereo output.
// Pure ES module; no allocation after construction.

import { idx } from '../params.js';
import { Rng, clamp, PI, PI2 } from '../util.js';

const LN1000 = 6.907755278982137;       // ln(1000): T60 → per-sample decay
const SILENCE = 3.1622776601683795e-5;  // −90 dB
const MAXM = 32;                        // max modes per model
const EXMAX_SEC = 0.024;                // transient exciter buffer length (s)
const M_DISP = 4;                       // dispersion allpass stages
const BOW_LOSS = 0.95;                  // bowed-string reflection gain per round trip (while bowing)

// Model / exciter enum indices (order in params.js)
const M_STRING = 0, M_BAR = 1, M_BELL = 2, M_GLASS = 3, M_MEMBRANE = 4, M_PLATE = 5;
const X_PLUCK = 0, X_MALLET = 1, X_BOW = 2, X_BREATH = 3;
const N_MODELS = 6, N_EXC = 4;
// Scratch for the noteOn-time bank simulation (_modalNormalise): filled and read within one synchronous call, so
// one module-level pair serves every engine (per engine it was 64 KB × 20 voices × 10 Synths ≈ 13 MB in the worklet).
const SIM_CAP = 1 << 12;
const SIM_L = new Float64Array(SIM_CAP), SIM_R = new Float64Array(SIM_CAP);
// Enum values arrive as floats from the voice's value array; clamp so an out-of-range index (params outside the
// schema, e.g. a hand-edited patch) can never index a missing model table (→ TypeError in the audio thread).
// (callers pass `x | 0`: a small integer, never a boxed double)
const modelOf = m => (m < 0 ? 0 : m >= N_MODELS ? N_MODELS - 1 : m);
const excOf = e => (e < 0 ? 0 : e >= N_EXC ? N_EXC - 1 : e);

// ───────────────────────────── modal material tables ─────────────────────────────
// Each model: K modes with T (tuned/pure ratio, inharm = 0) and U (raw/inharmonic ratio, inharm = 1),
// morphed log-linearly; amp = base amplitude; kind/order data for position weighting; pan pattern.

function besselJ(n, x) {
  // power series (accurate for x ≤ ~20 in double precision); load time + membrane position changes only
  let term = 1;
  for (let i = 1; i <= n; i++) term *= x / 2 / i;
  let sum = term;
  const q = -(x * x) / 4;
  for (let k = 1; k < 80; k++) {
    term *= q / (k * (k + n));
    sum += term;
    if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
  }
  return sum;
}

function makeModel(K) {
  return {
    K,
    T: new Float64Array(K), lnUT: new Float64Array(K), amp: new Float64Array(K),
    kind: new Uint8Array(K),    // model-specific sub-kind (bar: 0 flexural / 1 torsional; membrane: n index)
    order: new Float64Array(K), // bar: k; membrane: Bessel zero j_nm; plate: m; bell/glass: order
    order2: new Float64Array(K),// membrane: n; plate: n
    pan: new Float64Array(K),   // −1..1 radiation pattern (scaled by spread)
    maxJ: new Float64Array(K),  // membrane: max |J_n| over the radius (for weight normalisation)
  };
}
function setMode(m, k, T, U, amp) { m.T[k] = T; m.lnUT[k] = Math.log(U / T); m.amp[k] = amp; }

const MODELS = [];
MODELS[M_STRING] = null;

// BAR — free-free bar: 16 flexural (tuned 1:4:10 marimba/vibraphone style at inharm 0, raw free-bar ratios
// at inharm 1) + 8 torsional "clang" modes.
{
  const beta = [4.7300, 7.8532, 10.9956, 14.1372];
  for (let k = 5; k <= 16; k++) beta.push((2 * k + 1) * PI / 2);
  const m = makeModel(24);
  for (let k = 0; k < 16; k++) {
    const U = (beta[k] / beta[0]) ** 2;
    const T = k === 0 ? 1 : k === 1 ? 4 : k === 2 ? 10 : U * (10 / ((beta[2] / beta[0]) ** 2));
    setMode(m, k, T, U, 1 / Math.pow(k + 1, 0.35));
    m.kind[k] = 0; m.order[k] = k + 1;
  }
  for (let j = 1; j <= 8; j++) {
    const k = 15 + j;
    const r = 3.37 * j * (1 + 0.006 * j);
    setMode(m, k, r, r * 1.04, 0.16 / Math.sqrt(j));
    m.kind[k] = 1; m.order[k] = j;
  }
  MODELS[M_BAR] = m;
}

// BELL — tuned church-bell partials (hum, prime, tierce, quint, nominal, …) as split doublets (warble).
{
  const T = [0.5, 1.0, 1.2, 1.5, 2.0, 2.5, 2.667, 3.0, 4.0, 4.5, 5.333, 6.0, 6.667, 8.0];
  const U = [0.53, 1.0, 1.17, 1.62, 2.19, 2.83, 3.02, 3.46, 4.62, 5.35, 6.2, 7.1, 7.96, 9.6];
  const A = [0.55, 0.75, 0.95, 0.4, 1.0, 0.65, 0.4, 0.5, 0.35, 0.22, 0.25, 0.16, 0.12, 0.08];
  const D = [0.0015, 0.0003, 0.0012, 0.001, 0.0008, 0.0012, 0.0015, 0.001, 0.0012, 0.0014, 0.001, 0.0012, 0.0013, 0.001];
  const m = makeModel(28);
  for (let i = 0; i < 14; i++) {
    for (let h = 0; h < 2; h++) {
      const k = i * 2 + h;
      const s = h === 0 ? 1 - D[i] * 0.5 : 1 + D[i] * 0.5;
      const sU = h === 0 ? 1 - D[i] * 1.5 : 1 + D[i] * 1.5;
      setMode(m, k, T[i] * s, U[i] * sU, A[i] * (h === 0 ? 0.62 : 0.5));
      m.order[k] = i + 1;
    }
  }
  MODELS[M_BELL] = m;
}

// GLASS — thin shell (wine glass) modes f_n ∝ n(n²−1)/√(n²+1), n = 2..13, as doublets; inharm stretches.
{
  const f = n => n * (n * n - 1) / Math.sqrt(n * n + 1);
  const m = makeModel(24);
  for (let i = 0; i < 12; i++) {
    const n = i + 2;
    const r = f(n) / f(2);
    const d = 0.0007 + 0.0002 * (i % 4);
    for (let h = 0; h < 2; h++) {
      const k = i * 2 + h;
      const s = h === 0 ? 1 - d * 0.5 : 1 + d * 0.5;
      const sU = h === 0 ? 1 - d * 2 : 1 + d * 2;
      setMode(m, k, r * s, Math.pow(r, 1.16) * sU * (1 + 0.012 * ((i * 7) % 5 - 2) * (i > 0)), (h === 0 ? 0.6 : 0.45) / Math.pow(i + 1, 0.6));
      m.order[k] = i + 1;
    }
  }
  MODELS[M_GLASS] = m;
}

// MEMBRANE — circular membrane Bessel modes (inharm 1 = ideal membrane / tom), tuned harmonic
// "loaded membrane" (tabla/mridangam, Raman) at inharm 0.
{
  const modes = [[0, 1, 2.4048], [1, 1, 3.8317], [2, 1, 5.1356], [0, 2, 5.5201], [3, 1, 6.3802], [1, 2, 7.0156],
    [4, 1, 7.5883], [2, 2, 8.4172], [0, 3, 8.6537], [5, 1, 8.7715], [3, 2, 9.7610], [6, 1, 9.9361],
    [1, 3, 10.1735], [4, 2, 11.0647], [7, 1, 11.0864], [2, 3, 11.6198], [0, 4, 11.7915], [8, 1, 12.2251],
    [5, 2, 12.3386], [3, 3, 13.0152], [1, 4, 13.3237], [9, 1, 13.3543], [6, 2, 13.5893], [4, 3, 14.3725]];
  const harm = [1, 2, 3, 3.006, 4, 3.994, 5, 5.008, 4.992];
  const m = makeModel(24);
  for (let k = 0; k < 24; k++) {
    const [n, , j] = modes[k];
    const U = j / 2.4048;
    const T = k < 9 ? harm[k] : U * (5 / 3.598);
    setMode(m, k, T, U, 1 / Math.pow(U, 0.25));
    m.kind[k] = n; m.order[k] = j; m.order2[k] = n;
    let mx = 0;
    for (let x = 0; x <= 1.0001; x += 0.005) mx = Math.max(mx, Math.abs(besselJ(n, j * x)));
    m.maxJ[k] = mx;
  }
  MODELS[M_MEMBRANE] = m;
}

// PLATE — simply-supported rectangular plate, 32 lowest (m,n) modes; inharm morphs the aspect ratio.
{
  const a0 = 1.19, a1 = 1.73, aMid = 1.41;
  const cand = [];
  for (let i = 1; i <= 12; i++) for (let j = 1; j <= 12; j++) cand.push([i, j, i * i + (j / aMid) ** 2]);
  cand.sort((p, q) => p[2] - q[2]);
  const m = makeModel(32);
  const rr = (i, j, a) => (i * i + (j / a) ** 2) / (1 + 1 / (a * a));
  for (let k = 0; k < 32; k++) {
    const [i, j] = cand[k];
    const T = rr(i, j, a0), U = rr(i, j, a1);
    setMode(m, k, T, U, 1 / Math.pow(T, 0.2));
    m.order[k] = i; m.order2[k] = j;
  }
  MODELS[M_PLATE] = m;
}

// Per-mode radiation pan pattern (golden-angle sequence; doublet partners mirrored).
for (const m of MODELS) {
  if (!m) continue;
  for (let k = 0; k < m.K; k++) m.pan[k] = k === 0 ? 0 : Math.sin(k * 2.399963229728653) * 0.9;
}
for (const mi of [M_BELL, M_GLASS]) {
  const m = MODELS[mi];
  for (let i = 0; i < m.K / 2; i++) {
    const p = i === 0 ? 0.25 : Math.sin((i + 1) * 2.399963229728653) * 0.85;
    m.pan[2 * i] = p; m.pan[2 * i + 1] = -p;
  }
}

// String body: guitar/koto-like resonances (Hz, Q, gain).
const BODY = [[98, 14, 1.0], [196, 18, 0.75], [282, 11, 0.55], [420, 12, 0.5], [1150, 5, 0.4], [2600, 3, 0.32]];
const NBODY = BODY.length;

// ───────────────────────────── waveguide string ─────────────────────────────

/** One-pole loss-filter phase delay (samples) at ω. */
function lpDelay(p, w) { return Math.atan2(p * Math.sin(w), 1 - p * Math.cos(w)) / w; }
/** First-order allpass (a + z⁻¹)/(1 + a z⁻¹) phase delay (samples) at ω. */
function apDelay(a, w) { return 1 - (2 / w) * Math.atan2(a * Math.sin(w), 1 + a * Math.cos(w)); }
/** DC blocker (1−z⁻¹)·q/(1−q z⁻¹): magnitude and phase lead (rad) at ω. */
function hpMag(q, w) {
  const c = Math.cos(w), s = Math.sin(w);
  return q * Math.sqrt((1 - c) * (1 - c) + s * s) / Math.sqrt((1 - q * c) * (1 - q * c) + q * q * s * s);
}
function hpPh(q, w) { const c = Math.cos(w), s = Math.sin(w); return Math.atan2(s, 1 - c) - Math.atan2(q * s, 1 - q * c); }
/** One-pole smoothing step toward tgt (k = fraction per call); snaps when within eps. */
function smooth(cur, tgt, k, eps) {
  if (k >= 1) return tgt;
  const d = tgt - cur;
  return d < eps && d > -eps ? tgt : cur + d * k;
}
/** DC gain g of the loss filter g(1−p)/(1−p z⁻¹) that gives magnitude rho at ω0 (c0 = cos ω0). */
function lpDcGain(rho, p, c0) { return rho * Math.sqrt(1 - 2 * p * c0 + p * p) / (1 - p); }

// Waveguide.tuneT() arguments (module scratch: numeric arguments to non-inlined calls would be boxed).
const TUNE_ARGS = new Float64Array(6);

class Waveguide {
  constructor(sr) {
    this.sr = sr;
    let cap = 1;
    while (cap < sr / 14 + 16) cap <<= 1;
    this.mask = cap - 1;
    this.neck = new Float32Array(cap);
    this.bridge = new Float32Array(cap);
    this.dx = new Float64Array(M_DISP);
    this.dy = new Float64Array(M_DISP);
    this.clear();
    this.Nn = 8; this.Nb = 8; this.eta = 0; this.ad = 0; this.p = 0; this.gg = 0.5;
    this.rho0 = 0.99; this.P = 16; this.kdc = 0;
    this.slope = 0.5; this.gain = 1.5; this.peak = 0.5; // runF() inputs / output (double fields)
  }
  clear() {
    this.neck.fill(0); this.bridge.fill(0); this.dx.fill(0); this.dy.fill(0);
    this.w = 0; this.ax = 0; this.ay = 0; this.lp = 0; this.dc = 0;
  }
  /**
   * Design the loop for fundamental f0 (Hz), T60 at f0 (s), brightness 0..1, dispersion 0..1, relative
   * excitation point beta (0..0.5). When `keepNeck`, the neck segment length is kept (no discontinuity).
   */
  tune(f0, t60, bright, disp, beta, keepNeck, bowLoss = 0) {
    const T = TUNE_ARGS;
    T[0] = f0; T[1] = t60; T[2] = bright; T[3] = disp; T[4] = beta; T[5] = bowLoss;
    this.tuneT(keepNeck);
  }

  /** tune() with its numeric arguments read from TUNE_ARGS [f0, t60, bright, disp, beta, bowLoss] (allocation-free). */
  tuneT(keepNeck) {
    const T = TUNE_ARGS;
    let f0 = T[0];
    const t60 = T[1], bright = T[2], disp = T[3], beta = T[4], bowLoss = T[5];
    const sr = this.sr;
    if (f0 < 16) f0 = 16; else if (f0 > 0.2 * sr) f0 = 0.2 * sr;
    const P = sr / f0;
    this.P = P;
    const w0 = PI2 * f0 / sr;
    // ── in-loop DC blocker (not while bowing: the bowed junction legitimately carries DC, and the bow-mode
    //    loss already bounds it). Otherwise the loss filter's DC gain can sit at ≈1, leaving a slowly decaying
    //    DC mode. Its gain and phase at f0 are compensated exactly. ──
    const fdc = bowLoss > 0 ? 0 : Math.min(4, 0.006 * f0); // lead at f0 ≈ 0.34° → partials ≤ 1.7 ct flat
    const kdc = fdc > 0 ? 1 - Math.exp(-PI2 * fdc / sr) : 0;
    this.kdc = kdc;
    const q = 1 - kdc;
    // ── loss filter: |H(ω0)| = ρ0 (T60 at f0), |H(ωh)| = ρh (brightness-dependent T60 at fh) ──
    let rho0 = Math.pow(10, -3 / (t60 * f0));
    if (rho0 > 0.999995) rho0 = 0.999995;
    this.rho0 = rho0;
    if (kdc > 0) { rho0 /= hpMag(q, w0); if (rho0 > 0.99999) rho0 = 0.99999; }
    let fh = Math.max(3200, 2.2 * f0);
    if (fh > 0.42 * sr) fh = 0.42 * sr;
    const wh = PI2 * fh / sr;
    const t60h = t60 * Math.pow(10, -2.3 + 2.2 * bright);
    const rhoh = Math.pow(10, -3 / (t60h * f0));
    let r2 = (rhoh / rho0) ** 2;
    const c0 = Math.cos(w0), ch = Math.cos(wh);
    const rmin = (1 - c0) / (1 - ch) * 1.0001;
    let p = 0;
    if (bowLoss > 0) {
      // bowed: STK-like per-round-trip reflection loss (keeps Helmholtz motion stable at every pitch)
      // pitch-invariant corner rounding: per-round-trip loss spectrum defined in harmonic numbers
      const kh = 7 + 10 * bright;
      let fb = kh * f0; if (fb > 0.45 * sr) fb = 0.45 * sr;
      if (fb > 1.5 * f0) {
        const cb = Math.cos(PI2 * fb / sr);
        let rb = 0.36;                          // |H(kh·f0)| / |H(f0)| = 0.6 per round trip
        const rmn = (1 - c0) / (1 - cb) * 1.0001;
        if (rb < rmn) rb = rmn;
        const B = (c0 - rb * cb) / (1 - rb);
        p = B - Math.sqrt(Math.max(0, B * B - 1));
        if (!(p >= 0)) p = 0; else if (p > 0.9995) p = 0.9995;
      } else p = 0;
      this.p = p;
      this.gg = bowLoss * (1 - p);
      this.rho0 = bowLoss * (1 - p) / Math.sqrt(1 - 2 * p * c0 + p * p);
    } else if (r2 < 0.99999) {
      if (r2 < rmin) r2 = rmin;
      const B = (c0 - r2 * ch) / (1 - r2);
      p = B - Math.sqrt(Math.max(0, B * B - 1));
      if (!(p >= 0)) p = 0; else if (p > 0.9995) p = 0.9995;
    }
    if (bowLoss <= 0) {
      // DC gain must stay < 1 (and the sub-f0 region must not outlive the note by more than ~2×): back off
      // the low-pass (brighter) rather than shorten the fundamental's T60.
      const gmax = Math.min(0.99999, Math.pow(this.rho0, 0.5));
      if (lpDcGain(rho0, p, c0) > gmax) {
        let lo = 0, hi = p;
        for (let i = 0; i < 24; i++) { const mid = 0.5 * (lo + hi); if (lpDcGain(rho0, mid, c0) > gmax) hi = mid; else lo = mid; }
        p = lo;
      }
      this.p = p;
      this.gg = lpDcGain(rho0, p, c0) * (1 - p);
    }
    // ── dispersion (stiffness): M first-order allpasses, always in the loop (a = 0 → plain unit delays), so
    //    the coefficient is a continuous function of every parameter — no delay jumps under modulation.
    //    Corner ≈ κ·ω0: partials above it see less delay → stretched (piano-like at high `inharm`). ──
    let ad = 0;
    if (disp > 0) {
      const eps = 2.6 / Math.pow(disp, 1.1) * w0;
      if (eps < 1) ad = -(1 - eps);
    }
    const budget = 0.6 * (P - lpDelay(p, w0) - 2.6);
    if (M_DISP * apDelay(ad, w0) > budget) {
      // largest dispersion that fits the loop (bisection; allows a > 0 for the very top notes)
      let lo = ad, hi = 0.6;
      for (let i = 0; i < 28; i++) { const mid = 0.5 * (lo + hi); if (M_DISP * apDelay(mid, w0) > budget) lo = mid; else hi = mid; }
      ad = hi;
    }
    this.ad = ad;
    let dRem;
    if (bowLoss > 0) {
      // Bowed (mode-locked) oscillation settles at a period set by the average loop delay over the
      // harmonics, not just the fundamental: compensate with a sawtooth-amplitude-weighted mean (1/k).
      let sw = 0, sd = 0;
      for (let k = 1; k <= 12 && k * w0 < 0.9 * PI; k++) {
        const w = k * w0, wt = 1 / k;
        sd += wt * (lpDelay(p, w) + M_DISP * apDelay(ad, w));
        sw += wt;
      }
      dRem = P - sd / sw;
    } else {
      dRem = P - lpDelay(p, w0) - M_DISP * apDelay(ad, w0) + (kdc > 0 ? hpPh(q, w0) / w0 : 0);
    }
    // ── split into neck (integer) + bridge (integer + fractional allpass) ──
    let Nn = this.Nn;
    const nnMax = Math.max(1, Math.floor(dRem - 1.4));
    if (!keepNeck || Nn > nnMax) {
      Nn = Math.round(beta * dRem);
      if (Nn < 1) Nn = 1; else if (Nn > nnMax) Nn = nnMax;
    }
    this.Nn = Nn;
    const rem = dRem - Nn;
    let Nb = this.Nb;
    let d = rem - Nb;
    if (!keepNeck || d < 0.3 || d > 1.7) {
      Nb = Math.floor(rem - 0.5);
      if (Nb < 1) Nb = 1;
      d = rem - Nb;
    }
    if (Nb !== this.Nb) {
      // Tap moved by whole samples (vibrato/glide): re-seed the allpass state as if it had always read the
      // new tap — previous input = new tap's last sample, previous output ≈ that signal delayed by d.
      // This removes the classic time-varying-allpass transient (no clicks under ±50 ct vibrato).
      const m = this.mask, br = this.bridge, w = this.w;
      this.ax = br[(w - 1 - Nb) & m];
      const i0 = Math.floor(d), fr = d - i0;
      const a0 = br[(w - 1 - Nb - i0) & m], a1 = br[(w - 2 - Nb - i0) & m];
      this.ay = a0 + (a1 - a0) * fr;
    }
    this.Nb = Nb;
    if (d < 0.1) d = 0.1;                      // only reachable at the extreme top (loop too short): stay stable
    this.eta = Math.sin((1 - d) * w0 * 0.5) / Math.sin((1 + d) * w0 * 0.5);
  }

  /**
   * Run n samples. ex = external excitation (pluck/mallet/breath) or bow velocity (bow=true).
   * Writes the bridge signal into out[0..n). Returns block peak.
   */
  run(ex, n, out, bow, slope, gain) {
    this.slope = slope; this.gain = gain;
    this.runF(ex, n, out, bow);
    return this.peak;
  }

  /** run() with slope / gain read from this.slope / this.gain; the block peak goes to this.peak. */
  runF(ex, n, out, bow) {
    const slope = this.slope, gain = this.gain;
    const nk = this.neck, br = this.bridge, mask = this.mask;
    const dx = this.dx, dy = this.dy;
    const Nn = this.Nn, Nb = this.Nb, eta = this.eta, ad = this.ad, p = this.p, gg = this.gg;
    let w = this.w, ax = this.ax, ay = this.ay, lp = this.lp;
    const kdc = this.kdc;
    let dc = kdc > 0 ? this.dc : 0;
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const bo = br[(w - Nb) & mask];
      const no = nk[(w - Nn) & mask];
      // fractional-delay allpass (exactly tuned at f0)
      let x = eta * bo + ax - eta * ay;
      ax = bo; ay = x;
      // stiffness dispersion cascade
      for (let s = 0; s < M_DISP; s++) {
        const y = ad * x + dx[s] - ad * dy[s];
        dx[s] = x; dy[s] = y; x = y;
      }
      // loss filter + DC blocker
      lp = gg * x + p * lp;
      dc += kdc * (lp - dc);
      const bRef = dc - lp;
      const nRef = -no;
      let e;
      if (bow) {
        const dv = ex[i] - (bRef + nRef);
        let t = (dv + 0.001) * slope;
        t = (t < 0 ? -t : t) + 0.75;
        t *= t;
        let f = 1 / (t * t);
        if (f > 1) f = 1;
        e = dv * f;
      } else e = ex[i];
      nk[w] = bRef + e;
      br[w] = nRef + e;
      w = (w + 1) & mask;
      const o = -bRef * gain;
      out[i] = o;
      const a = o < 0 ? -o : o;
      if (a > pk) pk = a;
    }
    // denormal flush
    if (lp < 1e-30 && lp > -1e-30) lp = 0;
    if (dc < 1e-30 && dc > -1e-30) dc = 0;
    this.w = w; this.ax = ax; this.ay = ay; this.lp = lp; this.dc = dc;
    this.peak = pk;
  }
}

// ───────────────────────────── engine ─────────────────────────────

let instanceCounter = 0;

export class PhysEngine {
  /**
   * @param {number} sampleRate
   * @param {string} [prefix]
   * @param {number} [seed] per-instance seed (the voice passes one) → renders don't depend on how many engines
   *                        were constructed before (a module counter is the fallback).
   */
  constructor(sampleRate, prefix = 'phys', seed) {
    const sr = this.sr = sampleRate;
    const p = prefix;
    this.iModel = idx(`${p}.model`); this.iExc = idx(`${p}.exciter`);
    this.iHard = idx(`${p}.hardness`); this.iPos = idx(`${p}.position`);
    this.iDecay = idx(`${p}.decay`); this.iBright = idx(`${p}.brightness`);
    this.iInh = idx(`${p}.inharm`); this.iBody = idx(`${p}.body`);
    this.iPress = idx(`${p}.pressure`); this.iDamp = idx(`${p}.damp`);
    this.iSpread = idx(`${p}.spread`); this.iOct = idx(`${p}.oct`); this.iFine = idx(`${p}.fine`);

    const s0 = seed !== undefined && seed !== null ? (seed >>> 0) : (++instanceCounter + 3);
    this.rng = new Rng((Math.imul(0x2545F491, s0 + 1) ^ 0x6a09e667) >>> 0 || 0x6a09e667);

    // strings
    this.sA = new Waveguide(sr);
    this.sB = new Waveguide(sr);
    this.sS = new Waveguide(sr);            // scratch copy used at noteOn to measure the pluck's true peak
    this.useB = false;
    this.bufA = new Float64Array(16); this.bufB = new Float64Array(16);
    this.exA = new Float64Array(16); this.exB = new Float64Array(16);
    this.gA = 1; this.gB = 1;               // excitation normalisation per string
    // body resonators (TPT SVF band-pass, stereo)
    this.bodyK = new Float64Array(NBODY); this.bodyW = new Float64Array(NBODY);
    this.bodyA1 = new Float64Array(NBODY); this.bodyA2 = new Float64Array(NBODY); this.bodyA3 = new Float64Array(NBODY);
    for (let i = 0; i < NBODY; i++) {
      const [f, q, w] = BODY[i];
      const g = Math.tan(PI * Math.min(f, 0.45 * sr) / sr), k = 1 / q;
      this.bodyK[i] = k; this.bodyW[i] = w;
      this.bodyA1[i] = 1 / (1 + g * (g + k)); this.bodyA2[i] = g * this.bodyA1[i]; this.bodyA3[i] = g * this.bodyA2[i];
    }
    this.bz = new Float64Array(NBODY * 4);  // ic1L, ic2L, ic1R, ic2R
    this.bodyAmt = 0;
    // DC blockers
    this.dcR = Math.exp(-PI2 * 8 / sr);
    this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
    this.integLam = Math.exp(-PI2 * 5 / sr);  // pluck output integrator (leaky; corner follows f0)
    this.igL = 0; this.igR = 0; this.integ = false;

    // modal bank
    this.zr = new Float64Array(MAXM); this.zi = new Float64Array(MAXM);
    this.pr = new Float64Array(MAXM); this.pi = new Float64Array(MAXM);
    this.cL = new Float64Array(MAXM); this.cR = new Float64Array(MAXM);
    this.tL = new Float64Array(MAXM); this.tR = new Float64Array(MAXM);
    this.ratio = new Float64Array(MAXM); this.wgt = new Float64Array(MAXM);
    this.dcomp = new Float64Array(MAXM);    // 1/|1 − e^(−jω)|: undoes the input differentiator at each mode
    this.Rk = new Float64Array(MAXM); this.fR = 1; // pole radii and the f0 they were designed at
    this.bL = new Float64Array(MAXM); this.bR = new Float64Array(MAXM); // base output gains (no dcomp)
    this.exD = new Float64Array(16); this.exPrev = 0;
    this.simCap = SIM_CAP;                  // noteOn-time bank simulation (exact strike normalisation; shared scratch)
    this.simL = SIM_L; this.simR = SIM_R;
    this.act = new Int32Array(MAXM); this.nAct = 0;
    this.modalNorm = 1;
    this.gainsRamp = false;

    // exciter
    let cap = 1; while (cap < EXMAX_SEC * sr) cap <<= 1;
    this.exBuf = new Float64Array(cap); this.exCap = cap;
    this.exLen = 0; this.exPos = 0;
    this.exBlk = new Float64Array(16);      // block excitation (transient + continuous)
    this.airBlk = new Float64Array(16);     // direct breath noise
    this.cEnv = 0; this.cAtt = 0.001; this.cRel = 0.001;
    this.nz1 = 0; this.nz2 = 0; this.jit = 0; this.phase = 0;

    // state
    this.model = -1; this.exc = 0;
    this.gate = false; this.damped = false;
    this.vel = 0.8;
    this.t = 0; this.lastLoud = 0; this.modalQuietBlocks = 0;
    this.active = false;
    // cached params (change detection)
    this.cF0 = -1; this.cDecay = -1; this.cBright = -1; this.cInh = -1; this.cBody = -1;
    this.cPos = -1; this.cSpread = -1; this.cBowT = -1; this.cDamp = -1;
    this.t60Damp = 1e9; this.t60Bow = 1e9;
    this.dampedApplied = false; this.R1 = 0.999; this.vbow = 0.2; this.bowTuned = false;
    this.bowA = 0; this.nNorm = 1;
    // smoothed resonator params
    this.kSm = 1 - Math.exp(-1 / (0.012 * sampleRate));
    this.sLogDec = Math.log(2); this.lastLogDec = NaN; this.sBri = 0.6; this.sInh = 0.1; this.sBody = 0.3;
    this.sPos = 0.25; this.sSpr = 0.3; this.sPress = 0.5;
    this.freqIn = 261.6255653005986; // voice pitch (Hz) used by render() / _update()
    this.nzA = 0.5; this.nzOut = 1.5; // _modalNoiseGain() input (pole) / output
    this.rcCos = 1;                    // _retuneComp() input (cos ω of the mode being retuned)
    // model switch while sounding: the old resonator fades out (smoothstep, 6 ms), then the new one starts
    this.swG = 1; this.swStep = 1 / (0.006 * sampleRate);
    // white-noise density compensation above 48 kHz: breath noise is shaped in Hz, so at 96/192 kHz the same
    // variance spread over a 2–4× wider band left it 3–6 dB quieter where it is heard (the modal bank's noise
    // drive is normalised analytically, nNorm, and needs no compensation)
    this.nsc = sampleRate > 48000 ? Math.sqrt(sampleRate / 48000) : 1;
  }

  // ─────────────── helpers ───────────────

  _f0(v) {
    const f = this.freqIn * Math.pow(2, v[this.iOct] + v[this.iFine] / 1200);
    // modal banks: keep the fundamental audible / inside the bank (string clamps inside tune())
    if (this.model !== M_STRING) return f < 20 ? 20 : f > 0.45 * this.sr ? 0.45 * this.sr : f;
    return f;
  }

  _hardEff(v) {
    return clamp(v[this.iHard] + 0.35 * (this.vel - 0.6), 0, 1);
  }

  /** Build the transient excitation (pluck / mallet) into exBuf. P = period in samples (string) or 0. */
  _makeTransient(kind, h, P) {
    const sr = this.sr, buf = this.exBuf, cap = this.exCap, rng = this.rng;
    buf.fill(0);
    let len = 0;
    if (kind === X_MALLET) {
      // contact time: hardness, and longer for low notes (heavier hammers / bigger mallets)
      let Tc = 0.00012 * Math.pow(33, 1 - h) * clamp(Math.pow(261.63 / this.cF0, 0.35), 0.5, 2.5);
      // …but never much longer than one period of the fundamental: a Hann pulse of ≥ 2 periods has a spectral
      // null at (or below) f0, so soft mallets on high notes excited almost nothing but sub-audio "thump"
      // (−40…−50 dB RMS at C7). Soft limit (4-norm) → unchanged wherever Tc ≪ 1/f0.
      const rq = Tc * this.cF0;
      Tc /= Math.sqrt(Math.sqrt(1 + rq * rq * rq * rq));
      const L = Math.max(2, Math.min(cap - 1, Math.round(Tc * sr)));
      for (let t = 0; t < L; t++) { const s = Math.sin(PI * (t + 0.5) / L); buf[t] = s * s; }
      len = L;
    } else if (kind === X_PLUCK) {
      let Ln = Math.round(sr * (0.0005 + 0.0055 * (1 - h) * (1 - h)));
      if (P > 0 && Ln > P) Ln = Math.max(2, Math.floor(P));
      const rn = 0.2 + 0.35 * (1 - h);             // noise energy fraction
      const ai = Math.sqrt(1 - rn), an = Math.sqrt(rn * 5 / Ln);
      let fc = 280 * Math.pow(2, 5.8 * h);
      if (fc > 0.45 * sr) fc = 0.45 * sr;
      const a = Math.exp(-PI2 * fc / sr), b = 1 - a;
      const tail = Math.ceil(7 * sr / (PI2 * fc));
      len = Math.min(cap, Ln + tail + 2);
      let y1 = 0, y2 = 0;
      for (let t = 0; t < len; t++) {
        let x = t === 0 ? ai : 0;
        if (t < Ln) { const e = 1 - t / Ln; x += rng.bipolar() * an * e * e; }
        y1 = b * x + a * y1; y2 = b * y1 + a * y2;
        buf[t] = y2;
      }
    }
    this.exLen = len; this.exPos = 0;
    return len;
  }

  // ─────────────── string ───────────────

  /** Exact output peak of string `wg` for the current transient (runs a scratch copy of the loop). */
  _stringPeak(wg, integ) {
    const sc = this.sS;
    sc.clear();
    sc.Nn = wg.Nn; sc.Nb = wg.Nb; sc.eta = wg.eta; sc.ad = wg.ad; sc.p = wg.p; sc.gg = wg.gg; sc.kdc = wg.kdc;
    const total = Math.min(this.exLen + 3 * Math.ceil(wg.P) + 32, 8192);
    const inb = this.exA, outb = this.bufA, b = this.exBuf, L = this.exLen, lam = this.integLam;
    let pk = 0, y = 0;
    for (let o = 0; o < total; o += 16) {
      for (let i = 0; i < 16; i++) { const t = o + i; inb[i] = t < L ? b[t] : 0; }
      sc.slope = 0; sc.gain = 1;
      sc.runF(inb, 16, outb, false);
      for (let i = 0; i < 16; i++) {
        y = integ ? outb[i] + lam * y : outb[i];
        const a = y < 0 ? -y : y;
        if (a > pk) pk = a;
      }
    }
    return pk;
  }

  _stringT60() {
    let t60 = this.cDecay;
    if (this.damped && this.t60Damp < t60) t60 = this.t60Damp;
    return t60;
  }

  _tuneStrings(keepNeck) {
    const pos = this.cPos, sp = this.cSpread;
    // excitation point (fraction of the string): pluck/mallet 0.03..0.5; bow 0.175..0.19 (the robust
    // single-slip zone between the 1/6 and 1/5 rational points, verified across C1..C7)
    const beta = this.exc === X_BOW ? 0.175 + 0.015 * pos : 0.03 + 0.47 * pos;
    const t60 = this._stringT60();
    const br = this.damped ? this.cBright * (1 - 0.45 * this.cDamp) : this.cBright; // dampers also darken
    const det = Math.pow(2, sp * 3.5 / 1200);
    const bl = this.exc === X_BOW && this.gate ? BOW_LOSS : 0;
    const T = TUNE_ARGS;
    T[1] = t60; T[2] = br; T[3] = this.cInh; T[5] = bl;
    if (this.useB) {
      T[0] = this.cF0 / det; T[4] = beta;
      this.sA.tuneT(keepNeck);
      T[0] = this.cF0 * det; T[4] = clamp(beta * (1 - 0.12 * sp), 0.02, 0.5);
      this.sB.tuneT(keepNeck);
    } else {
      T[0] = this.cF0; T[4] = beta;
      this.sA.tuneT(keepNeck);
    }
    this.bowTuned = bl > 0;
    // output DC blocker 0.3·f0: the plucked pulse train settles DC-free within ~a period instead of leaving a
    // slow sub-bass "thump" at every onset (outside the loop → tuning unaffected; −0.4 dB at f0)
    // the pluck integrator only needs to integrate above ~f0/4; leaking below keeps sub-bass out.
    // Transient exciters: both corners scale with f0 at every pitch. Capped (30/40 Hz) they boosted the loop's
    // sub-audio residue by ≈ f0/40 relative to the fundamental → energy < 60 Hz rose from −46 dB (C3) to
    // −8 dB (F♯7), an audible thud on top notes. Bow/breath keep the capped (≤ 30 Hz) blocker.
    const cont = this.exc === X_BOW || this.exc === X_BREATH;
    const fdc = cont ? clamp(0.3 * this.cF0, 5, 30) : Math.max(5, 0.3 * this.cF0);
    this.dcR = Math.exp(-PI2 * fdc / this.sr);
    this.integLam = Math.exp(-PI2 * Math.max(4, 0.25 * this.cF0) / this.sr);
  }

  // ─────────────── modal ───────────────

  _modalFreqs() {
    const m = MODELS[this.model];
    const sr = this.sr, K = m.K;
    const f0 = this.cF0, inh = this.cInh, b = this.cBright;
    const gam = 2.1 - 1.85 * b;                 // T60 ∝ ratio^−γ
    const fair = 5000 + 15000 * b;              // air/radiation damping corner
    let t60cap = 1e9;
    if (this.damped) t60cap = this.t60Damp;
    if (this.cBowT > 0 && this.t60Bow < t60cap) t60cap = this.t60Bow;
    const fmax = 0.45 * sr;
    let na = 0;
    for (let k = 0; k < K; k++) {
      const r = m.T[k] * Math.exp(inh * m.lnUT[k]);
      this.ratio[k] = r;
      const f = f0 * r;
      if (f >= fmax || f < 10) { this.zr[k] = 0; this.zi[k] = 0; this.Rk[k] = -1; continue; } // (Rk −1: culled)
      let t60 = this.cDecay * Math.pow(r, -gam) / (1 + (f / fair) * (f / fair));
      if (t60 > t60cap) t60 = t60cap;
      if (t60 < 0.004) t60 = 0.004;
      const R = Math.exp(-LN1000 / (t60 * sr));
      const w = PI2 * f / sr, c = Math.cos(w);
      this.Rk[k] = R;
      this.pr[k] = R * c; this.pi[k] = R * Math.sin(w);
      this.rcCos = c; this._retuneComp(k); // (cos ω through a field: no boxed double argument, §2)
      this.act[na++] = k;
    }
    this.nAct = na;
    this.fR = f0;
    // R1 (bow/breath drive) from the fundamental mode — or, when it is culled (above 0.45·fs), from the lowest
    // mode still in the bank: pr/pi of a culled mode are stale (left from its last active tuning).
    let fund = this.model === M_BELL ? 2 : 0;
    if (this.Rk[fund] < 0) fund = na > 0 ? this.act[0] : -1;
    const R1 = fund < 0 ? 0 : Math.sqrt(this.pr[fund] * this.pr[fund] + this.pi[fund] * this.pi[fund]);
    this.R1 = R1 > 0 && R1 < 1 ? R1 : 0.999;
  }

  _modalWeights() {
    const m = MODELS[this.model], K = m.K, pos = this.cPos, w = this.wgt;
    switch (this.model) {
      case M_BAR: {
        const x = 0.5 * pos;
        for (let k = 0; k < K; k++) {
          let v;
          if (m.kind[k] === 0) { const kk = m.order[k]; v = Math.cos(0.9 * (kk + 1) * PI * (x - 0.5) - (kk - 1) * PI * 0.5); }
          else v = 0.5 * Math.cos(m.order[k] * PI * x) + 0.3;
          w[k] = Math.max(0.03, Math.abs(v));
        }
        break;
      }
      case M_MEMBRANE: {
        const rho = 0.85 * (1 - pos);
        for (let k = 0; k < K; k++) w[k] = Math.max(0.02, Math.abs(besselJ(m.order2[k], m.order[k] * rho)) / m.maxJ[k]);
        break;
      }
      case M_PLATE: {
        const x = 0.07 + 0.43 * pos, y = 0.11 + 0.37 * pos;
        for (let k = 0; k < K; k++) w[k] = Math.max(0.03, Math.abs(Math.sin(m.order[k] * PI * x) * Math.sin(m.order2[k] * PI * y)));
        break;
      }
      default: { // bell, glass: strike height along the profile
        const x = 0.12 + 0.36 * pos;
        for (let k = 0; k < K; k++) w[k] = 0.3 + 0.7 * Math.abs(Math.sin((m.order[k] + 0.5) * PI * x));
      }
    }
  }

  /** Output gains per mode (includes normalisation, position, body and stereo radiation). ramp: glide over next block. */
  _modalGains(ramp) {
    const m = MODELS[this.model], K = m.K;
    const b = this.cBright, body = this.cBody, sp = this.cSpread, nrm = this.modalNorm;
    const tilt = -0.45 * (1 - b);
    for (let k = 0; k < K; k++) {
      const r = this.ratio[k], dr = r - 1;
      const c = nrm * m.amp[k] * this.wgt[k] * Math.pow(r, tilt) * (1 + 1.2 * body / (1 + 4 * dr * dr));
      const a = (clamp(m.pan[k] * sp, -1, 1) + 1) * 0.25 * PI;
      this.bL[k] = c * Math.cos(a) * Math.SQRT2; this.bR[k] = c * Math.sin(a) * Math.SQRT2;
    }
    this._applyGains(ramp);
  }

  /** Output gains = base gains × differentiator compensation (depends on each mode's frequency). */
  _applyGains(ramp) {
    const K = MODELS[this.model].K, bL = this.bL, bR = this.bR, dc = this.dcomp;
    for (let k = 0; k < K; k++) {
      const gl = bL[k] * dc[k], gr = bR[k] * dc[k];
      if (ramp) { this.tL[k] = gl; this.tR[k] = gr; }
      else { this.cL[k] = gl; this.cR[k] = gr; this.tL[k] = gl; this.tR[k] = gr; }
    }
    this.gainsRamp = ramp;
  }

  /**
   * Pitch-only retune: rotate each active pole to its new angle keeping its radius (T60). Falls back to a
   * full recompute (returns true) when the pitch drifted > ~7 ct from the last full design (air damping,
   * Nyquist culling) or a mode would cross 0.45·fs.
   */
  _modalPitch() {
    const f0 = this.cF0;
    if (Math.abs(f0 / this.fR - 1) > 0.004) { this._modalFreqs(); return true; }
    const sr = this.sr, fmax = 0.45 * sr, act = this.act, na = this.nAct, k2w = PI2 * f0 / sr;
    for (let j = 0; j < na; j++) {
      const k = act[j];
      const r = this.ratio[k];
      if (f0 * r >= fmax) { this._modalFreqs(); return true; }
      const w = k2w * r, c = Math.cos(w), R = this.Rk[k];
      this.pr[k] = R * c; this.pi[k] = R * Math.sin(w);
      this.rcCos = c; this._retuneComp(k); // (cos ω through a field: no boxed double argument, §2)
    }
    return false;
  }

  /**
   * New differentiator compensation for mode k (this.rcCos = cos ω). A ringing mode's state was built from the
   * *differentiated* drive (∝ ω) and its output gain carries 1/|1 − e^(−jω)| (∝ 1/ω), so a retune alone scaled
   * the output by ω_old/ω_new: a two-octave drop (S&H / envelope → pitch, a fast glide) was a ×4 (+12 dB) burst
   * decaying over the mode's T60. Scale the state by d_old/d_new and the current gain by the inverse: the
   * output is continuous; the gain still ramps to its new target (_applyGains) as before.
   */
  _retuneComp(k) {
    const d1 = 0.5 / Math.sqrt(0.5 * (1 - this.rcCos)), d0 = this.dcomp[k];
    this.dcomp[k] = d1;
    if (d0 > 0 && d0 !== d1 && (this.zr[k] !== 0 || this.zi[k] !== 0)) {
      const q = d0 / d1;
      this.zr[k] *= q; this.zi[k] *= q;
      this.cL[k] /= q; this.cR[k] /= q;
    }
  }

  /**
   * Modal normalisation. Transient exciters: run the whole bank (raw gains, stereo radiation) over the
   * strike + max(1.5 fundamental periods, 10 ms) and scale so the true onset peak is ≈ 0.95. Continuous exciters:
   * the fundamental mode's output gain is set to 0.7 (the drive / noise levels are normalised elsewhere).
   */
  _modalNormalise() {
    const m = MODELS[this.model], K = m.K, sr = this.sr;
    const fund = this.model === M_BELL ? 2 : 0;
    const bri = this.cBright, body = this.cBody, sp = this.cSpread, tilt = -0.45 * (1 - bri);
    if (this.exc === X_PLUCK || this.exc === X_MALLET) {
      const b = this.exBuf, L = this.exLen;
      let W = L + Math.ceil(Math.max(1.5 * sr / this.cF0, 0.01 * sr));
      if (W > this.simCap) W = this.simCap;
      const sL = this.simL, sR = this.simR;
      for (let t = 0; t < W; t++) { sL[t] = 0; sR[t] = 0; }
      const act = this.act, na = this.nAct;
      for (let j = 0; j < na; j++) {
        const k = act[j];
        const r = this.ratio[k], dr = r - 1;
        const c = this.dcomp[k] * m.amp[k] * this.wgt[k] * Math.pow(r, tilt) * (1 + 1.2 * body / (1 + 4 * dr * dr));
        const an = (clamp(m.pan[k] * sp, -1, 1) + 1) * 0.25 * PI;
        const gl = c * Math.cos(an) * Math.SQRT2, gr = c * Math.sin(an) * Math.SQRT2;
        const qr = this.pr[k], qi = this.pi[k];
        let zr = 0, zi = 0;
        for (let t = 0; t < W; t++) {
          const nr = qr * zr - qi * zi + ((t < L ? b[t] : 0) - (t > 0 && t <= L ? b[t - 1] : 0));
          zi = qi * zr + qr * zi; zr = nr;
          sL[t] += zi * gl; sR[t] += zi * gr;
        }
      }
      let pk = 0;
      for (let t = 0; t < W; t++) {
        const a = Math.abs(sL[t]), c = Math.abs(sR[t]);
        if (a > pk) pk = a;
        if (c > pk) pk = c;
      }
      this.modalNorm = pk > 1e-9 ? 0.95 / pk : 1;
    } else {
      const r = this.ratio[fund], dr = r - 1;
      const c = m.amp[fund] * this.wgt[fund] * Math.pow(r, tilt) * (1 + 1.2 * body / (1 + 4 * dr * dr));
      this.modalNorm = 0.7 / Math.max(0.05, c);
    }
  }

  // ─────────────── parameters ───────────────

  /** Read params; retune/recompute only what changed. */
  _update(v, force, skipGains, n) {
    const f0 = this._f0(v);
    // Resonator parameters are smoothed (~12 ms) so automation / macros / even per-block random modulation
    // glide the loop & mode coefficients instead of jumping (time-varying resonators can otherwise pump).
    const k = force ? 1 : this.kSm * n;
    this.sLogDec = smooth(this.sLogDec, Math.log(v[this.iDecay]), k, 1e-4);
    this.sBri = smooth(this.sBri, v[this.iBright], k, 1e-4);
    this.sInh = smooth(this.sInh, v[this.iInh], k, 1e-4);
    this.sBody = smooth(this.sBody, v[this.iBody], k, 1e-4);
    this.sPos = smooth(this.sPos, v[this.iPos], k, 1e-4);
    this.sSpr = smooth(this.sSpr, v[this.iSpread], k, 1e-4);
    this.sPress = smooth(this.sPress, v[this.iPress], k, 1e-4);
    const decay = this.sLogDec === this.lastLogDec ? this.cDecay : Math.exp(this.sLogDec);
    this.lastLogDec = this.sLogDec;
    const bright = this.sBri, inh = this.sInh, body = this.sBody;
    const pos = this.sPos, spread = this.sSpr, damp = v[this.iDamp];
    const exc = this.exc;
    const continuous = exc === X_BOW || exc === X_BREATH;
    if (damp !== this.cDamp) {
      this.cDamp = damp;
      const td = 0.03 * Math.pow(10, 3 * (1 - damp));
      if (td !== this.t60Damp) { this.t60Damp = td; if (this.damped) force = true; }
    }
    const pitchMoved = f0 !== this.cF0;
    let freqDirty = force || decay !== this.cDecay || bright !== this.cBright ||
      inh !== this.cInh || this.dampedApplied !== this.damped ||
      (this.model === M_STRING && this.bowTuned !== (exc === X_BOW && this.gate));
    let gainDirty = force || pos !== this.cPos || spread !== this.cSpread || body !== this.cBody ||
      bright !== this.cBright || inh !== this.cInh;
    const posMoved = Math.abs(pos - this.cPos) > 0.004;
    this.cF0 = f0; this.cDecay = decay; this.cBright = bright; this.cInh = inh; this.cBody = body;
    this.cSpread = spread;
    if (this.model === M_STRING) {
      this.bodyAmt = body;
      if (force || (continuous && posMoved)) { this.cPos = pos; this._tuneStrings(false); }
      else if (freqDirty || pitchMoved) { this._tuneStrings(true); }
      this.dampedApplied = this.damped;
      return;
    }
    // modal
    const bowing = exc === X_BOW && this.gate ? 1 : 0;
    const press = this.sPress;
    if (bowing) {
      const tb = 0.12 + 1.4 * (1 - press);
      if (tb !== this.t60Bow || this.cBowT !== 1) { this.t60Bow = tb; freqDirty = true; }
    } else if (this.cBowT === 1) freqDirty = true;
    this.cBowT = bowing;
    if (freqDirty) this._modalFreqs();
    else if (pitchMoved) {
      // pitch-only change (vibrato, bend, glide): cheap path — rotate the poles, keep radii & base gains
      if (this._modalPitch()) freqDirty = true;
      else if (!gainDirty && !skipGains) this._applyGains(true);
    }
    if (gainDirty || freqDirty) {
      if (pos !== this.cPos || force) { this.cPos = pos; this._modalWeights(); }
      if (!skipGains) this._modalGains(true);
    }
    this.dampedApplied = this.damped;
  }

  // ─────────────── engine interface ───────────────

  noteOn(note, velocity, freq, v, legato) {
    this.freqIn = freq;
    this.vel = velocity;
    this.swG = 1; // (a note-on handles a pending model switch itself)
    const model = modelOf(v[this.iModel] | 0);
    const exc = excOf(v[this.iExc] | 0);
    if (legato && this.active && model === this.model) {
      this.gate = true; this.damped = false;
      this._update(v, false, false, 16);
      return;
    }
    const wasActive = this.active && model === this.model;
    if (model !== this.model) this._clearStates();
    this.model = model; this.exc = exc;
    this.gate = true; this.damped = false; this.dampedApplied = false;
    this.active = true;
    const h = this._hardEff(v);
    const continuous = exc === X_BOW || exc === X_BREATH;
    // continuous exciter envelope times
    if (exc === X_BOW) { const a = 0.015 + 0.25 * Math.pow(1 - h, 1.5); this.cAtt = 1 - Math.exp(-1 / (a * this.sr)); }
    else { const a = 0.008 + 0.12 * (1 - h); this.cAtt = 1 - Math.exp(-1 / (a * this.sr)); }
    this.cRel = 1 - Math.exp(-1 / (0.045 * this.sr));
    this.cPos = v[this.iPos];
    if (model === M_STRING) {
      const wantB = v[this.iSpread] > 0.001;
      if (wantB && !this.useB) this.sB.clear();
      this.useB = wantB;
      this.cSpread = v[this.iSpread];
      this._update(v, true, false, 16);
      if (!continuous) {
        this._makeTransient(exc, h, this.sA.P);
        const ig = exc === X_PLUCK;
        if (ig !== this.integ) { this.igL = 0; this.igR = 0; this.integ = ig; }
        const pa = this._stringPeak(this.sA, ig);
        this.gA = Math.min(4, pa > 1e-9 ? 1 / pa : 1);
        if (this.useB) { const pb = this._stringPeak(this.sB, ig); this.gB = Math.min(4, pb > 1e-9 ? 1 / pb : 1); }
      } else { this.exLen = 0; this.exPos = 0; }
    } else {
      this.cSpread = v[this.iSpread];
      this.cBowT = exc === X_BOW ? 1 : 0;
      this.t60Bow = 0.12 + 1.4 * (1 - this.sPress);
      this._update(v, true, true, 16);       // freqs + weights (gains set below)
      if (!continuous) this._makeTransient(exc, h, 0); else { this.exLen = 0; this.exPos = 0; }
      this._modalNormalise();
      this._modalGains(wasActive);          // ramp if the bank is still ringing
      this.modalQuietBlocks = 0;
    }
    this.lastLoud = this.t;
  }

  noteOff() {
    this.gate = false;
    this.damped = true;
  }

  isActive() {
    if (!this.active) return false;
    if (this.gate && (this.exc === X_BOW || this.exc === X_BREATH)) return true;
    if (this.exPos < this.exLen || this.cEnv > 1e-4) return true;
    if (this.model === M_STRING) return this.t - this.lastLoud < this.sA.P + 96;
    return this.modalQuietBlocks < 3;
  }

  _clearStates() {
    this.sA.clear(); this.sB.clear();
    this.zr.fill(0); this.zi.fill(0);
    this.bz.fill(0);
    this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0;
    this.igL = 0; this.igR = 0;
    this.nAct = 0; this.exPrev = 0;
  }

  reset() {
    this._clearStates();
    this.exLen = 0; this.exPos = 0; this.cEnv = 0; this.nz1 = 0; this.nz2 = 0; this.jit = 0; this.phase = 0;
    this.gate = false; this.damped = false; this.active = false;
    this.model = -1; this.cF0 = -1; this.cDecay = -1; this.swG = 1;
    // _update() reuses cDecay while the smoothed log-decay is unchanged: forget it too, or the next note
    // after a voice steal would design its modes with T60 = −1 (→ 4 ms floor: silent strikes, hissy bows)
    this.lastLogDec = NaN;
  }

  process(v, freq, outL, outR, offset, n) {
    this.freqIn = freq;
    this.render(v, outL, outR, offset, n);
  }

  /**
   * Same as process() with the pitch taken from this.freqIn. The voice uses this entry point: a double argument
   * to a non-inlined call is boxed (a HeapNumber per call), a field store is not.
   */
  render(v, outL, outR, offset, n) {
    if (!this.active) {
      for (let i = offset, e = offset + n; i < e; i++) { outL[i] = 0; outR[i] = 0; }
      return;
    }
    // Model switched while sounding: clearing the resonator at once was a one-sample step (a click) followed
    // by silence. Keep rendering the old model while it fades out (swDir −1, smoothstep over 6 ms), then switch:
    // a held note is re-excited in the new model (noteOn), a released one ends. Switching back mid-fade fades in.
    const mv = modelOf(v[this.iModel] | 0);
    let swDir = 0;
    if (mv !== this.model) {
      if (this.swG <= 0) {
        this.swG = 1;
        if (this.gate) this.noteOn(0, this.vel, this.freqIn, v, false);
        else { this._clearStates(); this.model = mv; this._update(v, true, false, 16); this._modalNormaliseIfModal(); }
      } else swDir = -1;
    } else if (this.swG < 1) swDir = 1;
    const ev = excOf(v[this.iExc] | 0);
    if (ev !== this.exc) { this.exc = ev; if (this.model !== M_STRING) this._modalNormalise(); this._update(v, true, false, 16); }
    else this._update(v, false, false, n);

    // ── excitation for this block ──
    const exc = this.exc, ex = this.exBlk, air = this.airBlk, rng = this.rng;
    const continuous = exc === X_BOW || exc === X_BREATH;
    let exLive = false;
    for (let i = 0; i < n; i++) { ex[i] = 0; air[i] = 0; }
    if (this.exPos < this.exLen) {
      const b = this.exBuf;
      let p = this.exPos;
      const e = Math.min(n, this.exLen - p);
      for (let i = 0; i < e; i++) ex[i] = b[p++];
      this.exPos = p;
      exLive = true;
    }
    if (continuous && !this.gate && this.cEnv <= 1e-6) this.cEnv = 0;
    if (continuous && (this.gate || this.cEnv > 1e-6)) {
      exLive = true;
      const press = this.sPress;
      const h = this._hardEff(v);
      const tgt = this.gate ? 1 : 0;
      const ca = this.gate ? this.cAtt : this.cRel;
      let env = this.cEnv, n1 = this.nz1, n2 = this.nz2, jit = this.jit, ph = this.phase;
      if (exc === X_BREATH) {
        let fc = 500 * Math.pow(2, 4.5 * h); if (fc > 0.45 * this.sr) fc = 0.45 * this.sr;
        const a = Math.exp(-PI2 * fc / this.sr), bb = 1 - a;
        // Breath = turbulent noise + a "jet" tone locked to the resonator's fundamental (edge-tone drive):
        // the noise gives the breathy body, the jet a stable, flute-like pitch. Pressure raises both.
        let sig;
        const airAmt = (0.02 + 0.06 * h) * press * this.nsc;
        const jet = 0.2 + 0.35 * press;
        if (this.model === M_STRING) {
          const r = this.sA.rho0;
          sig = (0.3 + 0.55 * press) * 2.5 * Math.sqrt(Math.max(1e-6, 1 - r * r)) * this.nsc;
          const comb = Math.abs(2 * Math.sin(PI * this.cF0 * this.sA.Nn / this.sr));
          if (this.gate) this.bowA = jet * (1 - r) / Math.max(0.15, comb);
        } else {
          // output RMS of the noise-driven bank normalised analytically: 0.18 … 0.4 with pressure
          // (frozen after release so the damping doesn't re-scale the fading exciter)
          if (this.gate) {
            this.nzA = a; this._modalNoiseGain(2);
            this.nNorm = 1 / this.nzOut;
            this.bowA = 2 * (1 - this.R1) * jet * (this.model === M_BELL || this.model === M_GLASS ? 0.55 : 1);
          }
          sig = (0.18 + 0.22 * press) * this.nNorm;
        }
        const A = this.bowA, dph = this.cF0 / this.sr;
        for (let i = 0; i < n; i++) {
          env += (tgt - env) * ca;
          const w = rng.bipolar();
          n1 = bb * w + a * n1; n2 = bb * n1 + a * n2;
          ph += dph; if (ph >= 1) ph -= 1;
          ex[i] += env * (n2 * sig + A * Math.sin(PI2 * ph));
          air[i] = (w - n1) * env * airAmt;
        }
      } else if (this.model === M_STRING) {
        // bow velocity with a little rosin jitter
        const vb = 0.05 + 0.2 * (0.45 + 0.55 * this.vel);
        this.vbow = vb;
        for (let i = 0; i < n; i++) {
          env += (tgt - env) * ca;
          jit = 0.995 * jit + 0.005 * rng.bipolar();
          ex[i] = vb * env * (1 + 0.6 * jit);
        }
      } else {
        // modal bow: resonant drive at the fundamental mode + pressure-dependent rosin noise
        let fc = 800 * Math.pow(2, 4 * h); if (fc > 0.45 * this.sr) fc = 0.45 * this.sr;
        const a = Math.exp(-PI2 * fc / this.sr), bb = 1 - a;
        if (this.gate) {
          // fundamental mode settles at ≈ 0.85 × its gain (0.7); bell/glass fundamentals are doublets (both
          // driven). Frozen after release so the release damping doesn't re-scale the fading bow.
          this.bowA = 2 * (1 - this.R1) * (this.model === M_BELL || this.model === M_GLASS ? 0.47 : 0.85);
          this.nzA = a; this._modalNoiseGain(1);
          this.nNorm = 1 / this.nzOut;
        }
        const A = this.bowA;
        const sig = (0.03 + 0.14 * press) * this.nNorm; // rosin noise RMS
        const dph = this.cF0 / this.sr;
        const sh = 0.25 + 0.5 * press;          // richer drive with pressure
        for (let i = 0; i < n; i++) {
          env += (tgt - env) * ca;
          ph += dph; if (ph >= 1) ph -= 1;
          const s = Math.sin(PI2 * ph);
          const d = s + sh * (s * s * s - 0.75 * s);  // adds a little 3rd harmonic (friction)
          n1 = bb * rng.bipolar() + a * n1;
          ex[i] = env * (A * d + sig * n1);
        }
      }
      if (env < 1e-7 && !this.gate) env = 0;
      this.cEnv = env; this.nz1 = n1; this.nz2 = n2; this.jit = jit; this.phase = ph;
    }

    if (this.model === M_STRING) this._runString(v, outL, outR, offset, n, exLive);
    else this._runModal(outL, outR, offset, n, exLive);

    if (exc === X_BREATH) for (let i = 0; i < n; i++) { outL[offset + i] += air[i]; outR[offset + i] += air[i]; }
    if (swDir !== 0) {
      let t = this.swG;
      const st = swDir * this.swStep;
      for (let i = offset, e = offset + n; i < e; i++) {
        t += st; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const g = t * t * (3 - 2 * t);
        outL[i] *= g; outR[i] *= g;
      }
      this.swG = t;
    }
    this.t += n;
  }

  /**
   * Output RMS of the bank (average of L/R power) when every active mode is driven by uniform white noise
   * (variance 1/3) through `order` one-pole low-passes with pole a: √(Σ c²·|H(ω)|² / (2(1−R²)) · 1/3).
   */
  _modalNoiseGain(order) {
    const a = this.nzA;
    const act = this.act, na = this.nAct, pr = this.pr, pi = this.pi, tL = this.tL, tR = this.tR;
    // No mode in the bank (every mode above 0.45·fs, e.g. a top note bent/modulated upwards): keep the last
    // gain. The 1e-12 floor below would give nNorm ≈ 1.7e6 → a ≈ 1e5 excitation that the input differentiator
    // (exPrev) then fed into the first mode to come back (+60…90 dB bursts).
    if (na === 0) return;
    const b2 = (1 - a) * (1 - a), a2 = 1 + a * a;
    let s = 0;
    for (let j = 0; j < na; j++) {
      const k = act[j];
      const R2 = pr[k] * pr[k] + pi[k] * pi[k];
      const c = pr[k] / Math.sqrt(R2);
      let h2 = b2 / (a2 - 2 * a * c);
      if (order === 2) h2 *= h2;
      h2 *= 2 - 2 * c;                           // input differentiator
      const g2 = 0.5 * (tL[k] * tL[k] + tR[k] * tR[k]);
      s += g2 * h2 / (2 * Math.max(1e-9, 1 - R2));
    }
    this.nzOut = Math.sqrt(Math.max(1e-12, s / 3));
  }

  _modalNormaliseIfModal() { if (this.model !== M_STRING) { this._modalNormalise(); this._modalGains(true); } }

  _runString(v, outL, outR, offset, n, exLive) {
    const exc = this.exc, ex = this.exBlk;
    const bow = exc === X_BOW;
    const exA = this.exA, exB = this.exB;
    let slope = 0, gOut = 1;
    if (bow) {
      slope = 1.2 - 0.4 * this.sPress;         // bow force range kept inside the Helmholtz (single-slip) regime
      gOut = 0.4 / (this.vbow || 0.2);
      for (let i = 0; i < n; i++) { exA[i] = ex[i]; exB[i] = ex[i]; }
    } else if (exc === X_BREATH) {
      for (let i = 0; i < n; i++) { exA[i] = ex[i]; exB[i] = ex[i]; }
    } else {
      const gA = this.gA, gB = this.gB;
      for (let i = 0; i < n; i++) { exA[i] = ex[i] * gA; exB[i] = ex[i] * gB; }
    }
    const A = this.bufA, B = this.bufB;
    const sA = this.sA, sB = this.sB;
    sA.slope = slope; sA.gain = gOut;
    sA.runF(exA, n, A, bow);
    if (this.useB) {
      sB.slope = slope; sB.gain = gOut;
      sB.runF(exB, n, B, bow);
      const sp = this.cSpread, wa = 0.5 + 0.5 * sp, wb = 0.5 - 0.5 * sp;
      for (let i = 0; i < n; i++) { const a = A[i], b = B[i]; outL[offset + i] = a * wa + b * wb; outR[offset + i] = a * wb + b * wa; }
    } else {
      for (let i = 0; i < n; i++) { outL[offset + i] = A[i]; outR[offset + i] = A[i]; }
    }
    // pluck: leaky integration (velocity wave → bridge force of a plucked string, 1/k spectrum)
    if (this.integ) {
      if (exc !== X_PLUCK) { this.integ = false; this.igL = 0; this.igR = 0; }
      else {
        const lam = this.integLam;
        let a = this.igL, b = this.igR;
        for (let i = offset, e = offset + n; i < e; i++) { a = outL[i] + lam * a; b = outR[i] + lam * b; outL[i] = a; outR[i] = b; }
        if (a < 1e-25 && a > -1e-25) a = 0;
        if (b < 1e-25 && b > -1e-25) b = 0;
        this.igL = a; this.igR = b;
      }
    }
    // DC blocker
    const dr = this.dcR;
    let xl = this.dcxL, yl = this.dcyL, xr = this.dcxR, yr = this.dcyR;
    for (let i = offset, e = offset + n; i < e; i++) {
      const a = outL[i], b = outR[i];
      yl = a - xl + dr * yl; xl = a; outL[i] = yl;
      yr = b - xr + dr * yr; xr = b; outR[i] = yr;
    }
    if (yl < 1e-25 && yl > -1e-25) yl = 0;
    if (yr < 1e-25 && yr > -1e-25) yr = 0;
    this.dcxL = xl; this.dcyL = yl; this.dcxR = xr; this.dcyR = yr;
    // activity (after DC removal: a bowed string legitimately holds DC in its neck segment)
    let opk = 0;
    for (let i = offset, e = offset + n; i < e; i++) { const a = outL[i], b = outR[i]; const m = (a < 0 ? -a : a) + (b < 0 ? -b : b); if (m > opk) opk = m; }
    if (opk > SILENCE || exLive) this.lastLoud = this.t + n;
    // body resonances
    const body = this.bodyAmt;
    if (body > 0.001) {
      const z = this.bz, K = this.bodyK, W = this.bodyW, A1 = this.bodyA1, A2 = this.bodyA2, A3 = this.bodyA3;
      const dry = 1 - 0.35 * body, wet = 0.9 * body;
      for (let i = offset, e = offset + n; i < e; i++) {
        const xl0 = outL[i], xr0 = outR[i];
        let sl = 0, sr = 0;
        for (let j = 0, o = 0; j < NBODY; j++, o += 4) {
          const a1 = A1[j], a2 = A2[j], a3 = A3[j];
          let v3 = xl0 - z[o + 1];
          let v1 = a1 * z[o] + a2 * v3;
          let v2 = z[o + 1] + a2 * z[o] + a3 * v3;
          z[o] = 2 * v1 - z[o]; z[o + 1] = 2 * v2 - z[o + 1];
          sl += W[j] * K[j] * v1;
          v3 = xr0 - z[o + 3];
          v1 = a1 * z[o + 2] + a2 * v3;
          v2 = z[o + 3] + a2 * z[o + 2] + a3 * v3;
          z[o + 2] = 2 * v1 - z[o + 2]; z[o + 3] = 2 * v2 - z[o + 3];
          sr += W[j] * K[j] * v1;
        }
        outL[i] = xl0 * dry + sl * wet;
        outR[i] = xr0 * dry + sr * wet;
      }
    }
  }

  _runModal(outL, outR, offset, n, exLive) {
    // Drive the modes with the *derivative* of the force (gains are compensated per mode by dcomp): the
    // resonances are unchanged but DC-rich strikes no longer produce a quasi-static low "thump".
    const ex = this.exD, act = this.act, ex0 = this.exBlk;
    let prev = this.exPrev;
    for (let i = 0; i < n; i++) { const x = ex0[i]; ex[i] = x - prev; prev = x; }
    // (no active mode: nothing consumed the excitation → a mode that (re)enters starts from a clean differentiator)
    this.exPrev = this.nAct > 0 ? prev : 0;
    const zr = this.zr, zi = this.zi, pr = this.pr, pi = this.pi;
    const cL = this.cL, cR = this.cR, tL = this.tL, tR = this.tR;
    const end = offset + n;
    for (let i = offset; i < end; i++) { outL[i] = 0; outR[i] = 0; }
    const ramp = this.gainsRamp;
    const inv = 1 / n;
    let energy = 0;
    let na = this.nAct;
    for (let a = 0; a < na; a++) {
      const k = act[a];
      let re = zr[k], im = zi[k];
      const r = pr[k], s = pi[k];
      let gl = cL[k], gr = cR[k];
      if (ramp) {
        const dl = (tL[k] - gl) * inv, dr = (tR[k] - gr) * inv;
        if (exLive) {
          for (let i = 0, o = offset; i < n; i++, o++) {
            const t = r * re - s * im + ex[i];
            im = s * re + r * im; re = t;
            gl += dl; gr += dr;
            outL[o] += im * gl; outR[o] += im * gr;
          }
        } else {
          for (let i = 0, o = offset; i < n; i++, o++) {
            const t = r * re - s * im;
            im = s * re + r * im; re = t;
            gl += dl; gr += dr;
            outL[o] += im * gl; outR[o] += im * gr;
          }
        }
        gl = tL[k]; gr = tR[k];
        cL[k] = gl; cR[k] = gr;
      } else if (exLive) {
        for (let i = 0, o = offset; i < n; i++, o++) {
          const t = r * re - s * im + ex[i];
          im = s * re + r * im; re = t;
          outL[o] += im * gl; outR[o] += im * gr;
        }
      } else {
        for (let i = 0, o = offset; i < n; i++, o++) {
          const t = r * re - s * im;
          im = s * re + r * im; re = t;
          outL[o] += im * gl; outR[o] += im * gr;
        }
      }
      const m2 = (re * re + im * im) * (gl * gl + gr * gr);
      if (!exLive && m2 < 1e-14) {
        // mode has rung out: stop computing it until the next excitation / retune
        zr[k] = 0; zi[k] = 0;
        act[a] = act[--na]; a--;
        continue;
      }
      zr[k] = re; zi[k] = im;
      energy += m2;
    }
    this.nAct = na;
    this.gainsRamp = false;
    if (!exLive && 32 * energy < SILENCE * SILENCE) this.modalQuietBlocks++;
    else this.modalQuietBlocks = 0;
  }
}
