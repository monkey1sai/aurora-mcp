// AURORA 極光 — visualizers (src/ui/visuals.js)
//
//   createHeroVisualizer  the centrepiece: WebGL2 HDR aurora (curtains, stars, sparkles, note blooms,
//                         bloom post-process, filmic tone map) with a Canvas2D fallback
//   createScope           phosphor oscilloscope (trigger-stabilised) + lissajous / goniometer mode
//   createSpectrum        log-frequency analyser: smoothed curve, gradient fill, peak hold, grid
//   createFilterView      animated filter magnitude response (filterResponse from dsp/filter.js)
//   createLfoView         one cycle of the LFO shape with a running phase dot
//   createMeter           stereo peak + RMS meter with peak hold and clip LED
//
// Every visual shares ONE requestAnimationFrame loop that stops while document.hidden, skips work
// while an element is scrolled out of view / display:none (IntersectionObserver), and is
// devicePixelRatio- and resize-aware (ResizeObserver). Visuals never talk to audio except by reading
// AnalyserNodes and the getState() snapshot. Styling: css/visuals.css (class prefix `av-`).
//
// Safe to import in Node (no DOM access at module load) — the pure helpers are exported as
// `_internals` for tests.

import { PARAM_BY_ID, divToBeats, formatValue } from '../dsp/params.js';
import { Rng } from '../dsp/util.js';

/* ═══════════════════════════════ small helpers ═══════════════════════════════ */

const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';
const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
/** One-pole smoothing coefficient for a time constant `tau` seconds over `dt` seconds. */
const follow = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mtof = n => 440 * Math.pow(2, (n - 69) / 12);
const toDb = g => (g > 1e-10 ? 20 * Math.log10(g) : -200);
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const noop = () => {};
const RM = HAS_DOM && typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => !!(RM && RM.matches);

function h(tag, cls, attrs, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : String(attrs[k]));
  if (text != null) e.textContent = text;
  return e;
}

function hash11(p) {
  p = (p * 0.1031) % 1; if (p < 0) p += 1;
  p *= p + 33.33; p *= p + p;
  return p - Math.floor(p);
}
function vnoise(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash11(i), hash11(i + 1), u);
}

/* ═══════════════════════════════ colour ═══════════════════════════════ */

function hexToRgb(s) {
  if (typeof s !== 'string') return null;
  let x = s.trim().replace(/^#/, '');
  if (x.length === 3 || x.length === 4) x = x.split('').map(c => c + c).join('');
  if (x.length !== 6 && x.length !== 8) return null;
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
let _probe = null;
/** CSS colour → [r,g,b] 0..1 (sRGB). Handles hex/rgb() directly, anything else via a canvas probe. */
function parseColor(str, fallback = '#5cf2ff') {
  if (Array.isArray(str)) return str;
  const s = typeof str === 'string' ? str.trim() : '';
  if (s) {
    if (s[0] === '#') { const c = hexToRgb(s); if (c) return c; }
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [m[1] / 255, m[2] / 255, m[3] / 255];
    if (HAS_DOM) {
      try {
        _probe = _probe || document.createElement('canvas').getContext('2d');
        _probe.fillStyle = '#010203';
        _probe.fillStyle = s;
        const v = String(_probe.fillStyle);
        if (v !== '#010203' && (v[0] === '#' || /^rgb/i.test(v))) return parseColor(v, fallback);
      } catch { /* ignore */ }
    }
  }
  return hexToRgb(fallback) || [0.36, 0.95, 1];
}
const rgba = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const s2l = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const mixRgb = (a, b, t, out = [0, 0, 0]) => { out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t); return out; };

/** Cyclic palettes (evenly spaced stops, wrap from last to first). Low u = deep, high u = bright/hot. */
export const PALETTES = {
  aurora: ['#4b35c8', '#1c9fb5', '#22e3a6', '#5cf2ff', '#a78bfa', '#ff6bd6', '#8a4fe0'],
  sunset: ['#5a1f8c', '#c2327a', '#ff6b6b', '#ff9f43', '#ffc46b', '#ff7eb3', '#8e2d9c'],
  ocean: ['#1b2f8f', '#1f6fe0', '#2ec4ff', '#5cf2ff', '#3ef0b0', '#8ff7ff', '#2451c9'],
  mono: ['#3a4260', '#7c86ad', '#c9d2f2', '#ffffff', '#aab4dc', '#6a7398', '#4a5274'],
  borealis: ['#0f5c4a', '#1fbf7a', '#46f59a', '#b6ff9e', '#4fe3c1', '#c05bd6', '#3b2f8f'],
  nebula: ['#2a1462', '#5b2bd1', '#9b5cff', '#ff7ad9', '#ffb3e6', '#6ad7ff', '#3a3fb8'],
};
const PAL_NAMES = Object.keys(PALETTES);
const PAL_RGB = {};
for (const k of PAL_NAMES) PAL_RGB[k] = PALETTES[k].map(c => hexToRgb(c));

/** Sample a cyclic palette at u (any real; wraps) with Catmull-Rom smoothing → out [r,g,b] sRGB 0..1. */
function paletteAt(name, u, out = [0, 0, 0]) {
  const st = PAL_RGB[name] || PAL_RGB.aurora;
  const n = st.length;
  const x = (u - Math.floor(u)) * n;
  const i = Math.floor(x) % n, t = x - Math.floor(x);
  const p0 = st[(i + n - 1) % n], p1 = st[i], p2 = st[(i + 1) % n], p3 = st[(i + 2) % n];
  const t2 = t * t, t3 = t2 * t;
  for (let c = 0; c < 3; c++) {
    const v = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
    out[c] = clamp01(v);
  }
  return out;
}

/* ═══════════════════════════════ design tokens ═══════════════════════════════ */

const TOKENS = {
  '--a-cyan': '#5cf2ff', '--a-teal': '#3ef0b0', '--a-violet': '#a78bfa', '--a-pink': '#ff6bd6',
  '--a-amber': '#ffc46b', '--a-red': '#ff6b81', '--text': '#e8ecff', '--text-dim': '#8e97b8',
  '--text-faint': '#7a83a6', '--line': 'rgba(140,160,220,.14)', '--bg-0': '#07080d',
  '--font-mono': '"JetBrains Mono", ui-monospace, monospace', '--font-ui': '"Inter", "Noto Sans TC", system-ui, sans-serif',
};
function readTokens(el, accent, accentFallback = '--a-cyan') {
  const cs = HAS_DOM && el ? getComputedStyle(el) : null;
  const get = k => (cs && cs.getPropertyValue(k).trim()) || TOKENS[k];
  let acc = null;
  if (accent) {
    // resolve var(--x) etc. through the cascade
    if (cs && /var\(/.test(accent)) { el.style.setProperty('--av-accent', accent); acc = getComputedStyle(el).getPropertyValue('--av-accent').trim(); }
    else acc = accent;
  }
  return {
    cyan: parseColor(get('--a-cyan'), TOKENS['--a-cyan']), teal: parseColor(get('--a-teal'), TOKENS['--a-teal']),
    violet: parseColor(get('--a-violet'), TOKENS['--a-violet']), pink: parseColor(get('--a-pink'), TOKENS['--a-pink']),
    amber: parseColor(get('--a-amber'), TOKENS['--a-amber']), red: parseColor(get('--a-red'), TOKENS['--a-red']),
    text: parseColor(get('--text'), TOKENS['--text']), dim: parseColor(get('--text-dim'), TOKENS['--text-dim']),
    faint: parseColor(get('--text-faint'), TOKENS['--text-faint']), line: parseColor(get('--line'), '#8ca0dc'),
    accent: parseColor(acc || get(accentFallback), TOKENS[accentFallback] || '#5cf2ff'),
    mono: get('--font-mono'), ui: get('--font-ui'),
  };
}

/* ═══════════════════════════════ shared animation loop ═══════════════════════════════ */

const subs = [];
const runList = [];
let rafId = 0, lastT = 0, frameStamp = 1;
let fpsEma = 60;

function tickerAdd(entry) {
  if (!subs.includes(entry)) subs.push(entry);
  tickerKick();
}
function tickerRemove(entry) {
  const i = subs.indexOf(entry);
  if (i >= 0) subs.splice(i, 1);
  if (!subs.length && rafId && HAS_DOM) { cancelAnimationFrame(rafId); rafId = 0; }
}
function tickerKick() {
  if (!HAS_DOM || rafId || !subs.length || document.hidden) return;
  lastT = 0;
  rafId = requestAnimationFrame(tickerFrame);
}
function tickerFrame(ts) {
  rafId = 0;
  if (!subs.length || document.hidden) return;
  runSubs(ts);
  rafId = requestAnimationFrame(tickerFrame);
}
function runSubs(ts) {
  const dt = lastT ? clamp((ts - lastT) / 1000, 0, 0.1) : 1 / 60;
  lastT = ts;
  if (dt > 0) fpsEma += (1 / dt - fpsEma) * 0.05;
  frameStamp++;
  runList.length = 0;
  for (let i = 0; i < subs.length; i++) runList.push(subs[i]);
  const tsec = ts / 1000;
  for (let i = 0; i < runList.length; i++) {
    const s = runList[i];
    if (!subs.includes(s)) continue;
    const t0 = perfNow();
    try { s.fn(tsec, dt); } catch (err) {
      s.errors = (s.errors || 0) + 1;
      if (s.errors <= 3) console.error(`[visuals] ${s.name}:`, err);
      if (s.errors > 120) tickerRemove(s);
    }
    const ms = perfNow() - t0;
    s.ms = s.ms === undefined ? ms : s.ms + (ms - s.ms) * 0.05;
    s.peak = Math.max((s.peak || 0) * 0.995, ms);
    s.frames = (s.frames || 0) + 1;
  }
}
if (HAS_DOM) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; } else tickerKick();
  });
}

/** Per-visual JS cost (ms, moving average + decaying peak) and the loop's frame rate. */
export function getVisualStats() {
  const out = { fps: Math.round(fpsEma * 10) / 10, running: subs.length, visuals: [] };
  for (const s of subs) out.visuals.push({ name: s.name, avgMs: +(s.ms || 0).toFixed(3), peakMs: +(s.peak || 0).toFixed(3), frames: s.frames || 0, visible: s.visible !== false });
  return out;
}

let nameCount = Object.create(null);
function makeEntry(kind, fn) {
  nameCount[kind] = (nameCount[kind] || 0) + 1;
  return { name: nameCount[kind] > 1 ? `${kind}#${nameCount[kind]}` : kind, fn, visible: true, ms: 0, peak: 0, frames: 0 };
}

function observeVisibility(el, entry) {
  entry.visible = true;
  if (!HAS_DOM || typeof IntersectionObserver === 'undefined') return noop;
  const io = new IntersectionObserver(es => { for (const e of es) entry.visible = e.isIntersecting; }, { rootMargin: '80px' });
  io.observe(el);
  return () => io.disconnect();
}

/** Canvas layers stacked inside `el`, sized to el × devicePixelRatio. */
class Surface {
  constructor(el, layers = 1, maxDpr = 2, ctxOpts) {
    this.el = el; this.cv = []; this.ctx = [];
    for (let i = 0; i < layers; i++) {
      const c = h('canvas', 'av-canvas', { 'aria-hidden': 'true' });
      el.appendChild(c);
      this.cv.push(c);
      this.ctx.push(c.getContext('2d', ctxOpts));
    }
    this.w = 0; this.h = 0; this.dpr = 1; this.pw = 0; this.ph = 0; this.maxDpr = maxDpr; this.dirty = true;
    this.ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(es => {
        const r = es[es.length - 1].contentRect;
        if (r.width !== this.w || r.height !== this.h) { this.w = r.width; this.h = r.height; this.dirty = true; }
      });
      this.ro.observe(el);
    }
  }
  /** Returns true when the backing store was (re)sized this call. */
  sync() {
    // ResizeObserver hasn't reported yet (first frame / hidden document) → measure directly
    if (!this.ro || !this.w || !this.h) {
      const w = this.el.clientWidth, hh = this.el.clientHeight;
      if (w !== this.w || hh !== this.h) { this.w = w; this.h = hh; this.dirty = true; }
    }
    const dpr = Math.min(this.maxDpr, (HAS_DOM && window.devicePixelRatio) || 1);
    if (dpr !== this.dpr) { this.dpr = dpr; this.dirty = true; }
    if (!this.dirty) return false;
    this.dirty = false;
    this.pw = Math.max(0, Math.round(this.w * dpr));
    this.ph = Math.max(0, Math.round(this.h * dpr));
    for (const c of this.cv) { c.width = this.pw; c.height = this.ph; }
    return true;
  }
  get ok() { return this.pw > 1 && this.ph > 1; }
  destroy() { if (this.ro) this.ro.disconnect(); }
}

/* ═══════════════════════════════ analyser access ═══════════════════════════════ */

const _anCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
function anCache(an) {
  let c = _anCache.get(an);
  if (!c) { c = { f: null, ft: 0, t: null, tt: 0 }; _anCache.set(an, c); }
  return c;
}
/** Float dB spectrum, read at most once per animation frame per analyser (shared across visuals). */
function readFreq(an) {
  const c = anCache(an);
  const n = an.frequencyBinCount;
  if (!c.f || c.f.length !== n) { c.f = new Float32Array(n); c.ft = 0; }
  if (c.ft !== frameStamp) { an.getFloatFrequencyData(c.f); c.ft = frameStamp; }
  return c.f;
}
/** Float time-domain block (fftSize samples), read at most once per frame per analyser. */
function readTime(an) {
  const c = anCache(an);
  const n = an.fftSize;
  if (!c.t || c.t.length !== n) { c.t = new Float32Array(n); c.tt = 0; }
  if (c.tt !== frameStamp) { an.getFloatTimeDomainData(c.t); c.tt = frameStamp; }
  return c.t;
}
const anRate = an => (an && an.context && an.context.sampleRate) || 48000;
function safeState(getState) {
  if (typeof getState !== 'function') return null;
  try { return getState() || null; } catch { return null; }
}

/**
 * Maps FFT bins (dB) to n log-spaced bands between fLo and fHi. Bands narrower than ~2 bins are
 * interpolated between neighbouring bins (smooth low end); wider bands take the max bin (peaks read
 * true at the top end).
 */
class BandMap {
  constructor(n, fLo, fHi) {
    this.n = n; this.fLo = fLo; this.fHi = fHi;
    this.bins = 0; this.sr = 0;
    this.lo = new Int32Array(n); this.hi = new Int32Array(n); this.pos = new Float32Array(n);
    this.x = new Float32Array(n); this.f = new Float32Array(n);
    const span = Math.log2(fHi / fLo);
    for (let k = 0; k < n; k++) { this.x[k] = (k + 0.5) / n; this.f[k] = fLo * Math.pow(2, this.x[k] * span); }
  }
  configure(bins, sr) {
    if (bins === this.bins && sr === this.sr) return;
    this.bins = bins; this.sr = sr;
    const binHz = sr / (2 * bins), half = 0.5 * Math.log2(this.fHi / this.fLo) / this.n;
    for (let k = 0; k < this.n; k++) {
      const fc = this.f[k], b0 = (fc * Math.pow(2, -half)) / binHz, b1 = (fc * Math.pow(2, half)) / binHz;
      this.pos[k] = Math.min(fc / binHz, bins - 1.001);
      if (b1 - b0 < 2) { this.lo[k] = -1; this.hi[k] = -1; }
      else { this.lo[k] = Math.max(0, Math.ceil(b0)); this.hi[k] = Math.max(this.lo[k], Math.min(bins - 1, Math.floor(b1))); }
    }
  }
  map(db, out) {
    const n = this.n, bins = this.bins;
    for (let k = 0; k < n; k++) {
      let v;
      if (this.lo[k] < 0) {
        const p = this.pos[k], i = p | 0, fr = p - i;
        let a = db[i], b = db[i + 1 < bins ? i + 1 : i];
        if (!(a > -160)) a = -160; if (!(b > -160)) b = -160;
        v = a + (b - a) * fr;
      } else {
        v = -160;
        for (let i = this.lo[k], e = this.hi[k]; i <= e; i++) { const d = db[i]; if (d > v) v = d; }
      }
      out[k] = v;
    }
    return out;
  }
}

/* ═══════════════════════════════ hero: analysis ═══════════════════════════════ */

// Horizontal axis of the hero = log frequency, shared by the spectrum-driven curtains and the note blooms.
const F_LO = 40, F_HI = 11000, LOG_SPAN = Math.log2(F_HI / F_LO);
const freqToX = f => Math.log2(f / F_LO) / LOG_SPAN;
const noteToX = n => clamp(freqToX(mtof(n)), 0.025, 0.975);
const NB = 128;

class HeroAnalysis {
  constructor(nb = NB) {
    this.nb = nb;
    this.map = new BandMap(nb, F_LO, F_HI);
    this.raw = new Float32Array(nb);
    this.slow = new Float32Array(nb);   // smoothed energy 0..~1.2
    this.fastE = new Float32Array(nb);  // transient energy (sparkle)
    this.blur = new Float32Array(nb);
    this.tmp = new Float32Array(nb);
    this.tilt = new Float32Array(nb);
    for (let k = 0; k < nb; k++) this.tilt[k] = clamp(3 * Math.log2(this.map.f[k] / 600), -6, 14);
    this.ref = 0.5;
    this.loud = 0; this.rmsDb = -120; this.low = 0; this.mid = 0; this.high = 0;
    this.centroid = 0.42; this.width = 0.35; this.balance = 0; this.pulse = 0;
    // transient ("kick") detector: positive spectral flux vs. its own slow average
    this.flux = 0; this.fluxAvg = 0.01; this.onset = 0; this.onsetT = 1;
    this.spec = new Float32Array(nb * 2); // RG interleaved for the GPU: R = energy, G = transient
  }
  update(src, dt, st) {
    const nb = this.nb, an = src.analyser || src.analyserL || src.analyserR || null;
    let peakN = 0;
    if (an) {
      const db = readFreq(an);
      this.map.configure(db.length, anRate(an));
      this.map.map(db, this.raw);
      for (let k = 0; k < nb; k++) {
        const n = clamp01((this.raw[k] + this.tilt[k] + 92) / 72);
        const e = Math.pow(n, 1.7);
        this.tmp[k] = e;
        if (e > peakN) peakN = e;
      }
    } else this.tmp.fill(0);
    // slow auto-reference so quiet material still draws curtains (loudness drives brightness separately)
    this.ref += (Math.max(peakN, 0.3) - this.ref) * follow(dt, peakN > this.ref ? 0.25 : 3.5);
    const g = lerp(1, 0.95 / Math.max(this.ref, 0.3), 0.55);
    const aAtt = follow(dt, 0.03), aRel = follow(dt, 0.28), fRel = follow(dt, 0.12);
    let flux = 0;
    for (let k = 0; k < nb; k++) {
      const tgt = Math.min(1.25, this.tmp[k] * g);
      const s = this.slow[k];
      const tr = tgt - s;
      if (tr > 0) flux += tr;
      this.fastE[k] = Math.max(tr > 0 ? tr * 2 : 0, this.fastE[k] - this.fastE[k] * fRel);
      this.slow[k] = s + tr * (tr > 0 ? aAtt : aRel);
    }
    // onsets: flux clearly above its running average (and not re-triggering within 90 ms)
    flux /= nb;
    this.onsetT += dt;
    const thr = this.fluxAvg * 1.9 + 0.012;
    if (flux > thr && flux > this.flux && this.onsetT > 0.09) {
      this.onset = Math.max(this.onset, clamp01((flux - thr) * 9 + 0.35));
      this.onsetT = 0;
    }
    this.onset *= Math.exp(-dt / 0.16);
    this.flux = flux;
    this.fluxAvg += (flux - this.fluxAvg) * follow(dt, 0.45);
    // spatial smoothing: two [1 2 1]/4 passes (slow → tmp → blur) → flowing, not bar-like
    const s = this.slow, b = this.blur, t = this.tmp, last = nb - 1;
    for (let k = 0; k < nb; k++) t[k] = (s[k > 0 ? k - 1 : 0] + 2 * s[k] + s[k < last ? k + 1 : last]) * 0.25;
    for (let k = 0; k < nb; k++) b[k] = (t[k > 0 ? k - 1 : 0] + 2 * t[k] + t[k < last ? k + 1 : last]) * 0.25;
    let sw = 0, sx = 0, lo = 0, mi = 0, hi = 0, nlo = 0, nmi = 0, nhi = 0;
    for (let k = 0; k < nb; k++) {
      const e = b[k], x = this.map.x[k];
      this.spec[2 * k] = e;
      this.spec[2 * k + 1] = Math.min(1.5, this.fastE[k]);
      sw += e; sx += e * x;
      if (x < 0.3) { lo += e; nlo++; } else if (x < 0.66) { mi += e; nmi++; } else { hi += e + this.fastE[k] * 0.5; nhi++; }
    }
    const cen = sw > 0.05 ? sx / sw : 0.42;
    this.centroid += (cen - this.centroid) * follow(dt, 0.45);
    this.low += (lo / nlo - this.low) * follow(dt, 0.12);
    this.mid += (mi / nmi - this.mid) * follow(dt, 0.12);
    this.high += (hi / nhi - this.high) * follow(dt, 0.08);

    // loudness, stereo width & balance from the time domain
    let rms = 0, width = -1, bal = 0;
    const aL = src.analyserL, aR = src.analyserR;
    if (aL && aR && aL !== aR) {
      const L = readTime(aL), R = readTime(aR);
      const n = Math.min(L.length, R.length);
      let ll = 0, rr = 0, lr = 0;
      for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; ll += l * l; rr += r * r; lr += l * r; }
      rms = Math.sqrt((ll + rr) / (2 * n));
      const m2 = ll + rr + 2 * lr, s2 = ll + rr - 2 * lr;
      if (ll + rr > n * 1e-8) { width = clamp01((2 * s2) / (m2 + s2 + 1e-20)); bal = (rr - ll) / (rr + ll); }
    } else if (an) {
      const T = readTime(an);
      let ss = 0;
      for (let i = 0; i < T.length; i++) ss += T[i] * T[i];
      rms = Math.sqrt(ss / T.length);
    } else if (st && st.rms) {
      rms = Math.sqrt(0.5 * (finite(st.rms[0], 0) ** 2 + finite(st.rms[1], 0) ** 2));
    }
    this.rmsDb = toDb(rms);
    const lt = Math.pow(clamp01((this.rmsDb + 58) / 48), 1.15);
    this.loud += (lt - this.loud) * follow(dt, lt > this.loud ? 0.05 : 0.4);
    if (width >= 0) {
      this.width += (width - this.width) * follow(dt, 0.35);
      this.balance += (bal - this.balance) * follow(dt, 0.35);
    } else {
      this.width += (0.35 - this.width) * follow(dt, 2);
      this.balance += (0 - this.balance) * follow(dt, 2);
    }
    // subtle beat pulse while the sequencer / arp is running
    let p = 0;
    if (st && (st.seqPlaying || st.arpStep >= 0) && Number.isFinite(st.beat)) {
      const fr = st.beat - Math.floor(st.beat);
      p = Math.exp(-fr * 6);
    }
    this.pulse += (p - this.pulse) * follow(dt, 0.04);
  }
}

/* ═══════════════════════════════ hero: blooms & particles ═══════════════════════════════ */

const MAXB = 32;
const MAXP = 720;
const BLOOM_STRIDE = 12;
const PART_STRIDE = 7;
const BLOOM_BASE = 0.15; // light columns stand on the horizon, just above the far ridge
const KEY_RGB = ['#3ef0b0', '#5cf2ff', '#a78bfa', '#ff6bd6'].map(hexToRgb); // = keyboard.js key glow stops

/**
 * Note → hero x (0..1) taken from the on-screen keyboard, so a played note's light rises right above
 * its key (the dock keyboard sits under the hero). Key centres are re-measured at most every 0.5 s;
 * notes off the keyboard extrapolate linearly. Falls back to the log-frequency axis when there is no
 * keyboard or it doesn't overlap the hero horizontally.
 */
class KeyMap {
  constructor(el) {
    this.el = el;
    this.u = new Float32Array(128).fill(NaN);
    this.t = -1e9; this.ok = false; this.kb = null; this.lo = 0; this.hi = 0; this.slope = 0;
    this.fn = n => this.x(n);
    this._c = [0, 0, 0];
    this.colFn = (n, vel, pal, out) => this.color(n, vel, pal, out);
  }
  refresh(now) {
    if (now - this.t < 500 || !HAS_DOM) return;
    this.t = now;
    this.ok = false;
    let kb = this.kb && this.kb.isConnected ? this.kb : null;
    if (!kb) kb = this.kb = document.querySelector('.dock .ac-kb__keys') || document.querySelector('.ac-kb__keys');
    if (!kb) return;
    const hr = this.el.getBoundingClientRect();
    if (hr.width < 8) return;
    const keys = kb.children;
    let lo = 999, hi = -1;
    this.u.fill(NaN);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], n = +(k.dataset && k.dataset.note);
      if (!(n >= 0 && n < 128)) continue;
      const r = k.getBoundingClientRect();
      if (r.width <= 0) continue;
      this.u[n] = (r.left + r.width / 2 - hr.left) / hr.width;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
    if (hi - lo < 5) return;
    const a = this.u[lo], b = this.u[hi];
    // the keyboard must cover a good part of the hero, or the mapping would pile notes at an edge
    const cover = Math.min(1, Math.max(a, b)) - Math.max(0, Math.min(a, b));
    if (!(cover > 0.45)) return;
    this.lo = lo; this.hi = hi; this.slope = (b - a) / (hi - lo);
    this.ok = true;
  }
  /** Light colour of note n: the keyboard's own teal→cyan→violet→pink key glow, tinted by the palette. */
  color(n, vel, pal, out) {
    const lo = this.ok ? this.lo : 36, hi = this.ok ? this.hi : 96;
    const t = clamp01((this.fold(n) - lo) / Math.max(1, hi - lo)) * (KEY_RGB.length - 1);
    const i = Math.min(KEY_RGB.length - 2, Math.floor(t));
    mixRgb(KEY_RGB[i], KEY_RGB[i + 1], t - i, out);
    pal(0.2 + 0.55 * vel, this._c);
    mixRgb(out, this._c, 0.3, out);
    const w = 0.22 * vel * vel;
    out[0] = lerp(out[0], 1, w); out[1] = lerp(out[1], 1, w); out[2] = lerp(out[2], 1, w);
    return out;
  }
  /** Notes beyond the keyboard fold by octaves onto it (a bass line lights the matching keys' sky). */
  fold(n) {
    if (!this.ok) return n;
    if (n < this.lo) n += 12 * Math.ceil((this.lo - n) / 12);
    if (n > this.hi) n -= 12 * Math.ceil((n - this.hi) / 12);
    return n < this.lo ? this.lo : n;
  }
  x(n) {
    if (!this.ok) return noteToX(n);
    n = this.fold(n);
    const i = Math.round(n);
    if (i >= this.lo && i <= this.hi) { const v = this.u[i]; if (v === v) return v; }
    return this.u[this.lo] + (n - this.lo) * this.slope;
  }
}

class HeroModel {
  constructor(seed = 0xa11ce) {
    this.rng = new Rng(seed);
    this.voices = new Map(); // key → { note, age, b (bloom slot), stamp }
    this.stamp = 0;
    // blooms (SoA)
    this.bn = 0;
    this.bKey = new Array(MAXB).fill(null);
    this.bNote = new Float32Array(MAXB); this.bVel = new Float32Array(MAXB);
    this.bLevel = new Float32Array(MAXB); this.bTarget = new Float32Array(MAXB);
    this.bAge = new Float32Array(MAXB); this.bX = new Float32Array(MAXB); this.bY = new Float32Array(MAXB);
    this.bSeed = new Float32Array(MAXB); this.bHeld = new Uint8Array(MAXB); this.bEmit = new Float32Array(MAXB);
    this.bRing = new Float32Array(MAXB);
    this.bRgb = new Float32Array(MAXB * 3);  // sRGB (Canvas2D)
    this.bLin = new Float32Array(MAXB * 3);  // linear (WebGL)
    this.bCss = new Array(MAXB).fill('#fff');
    // particles (SoA)
    this.pn = 0;
    this.px = new Float32Array(MAXP); this.py = new Float32Array(MAXP); this.vx = new Float32Array(MAXP); this.vy = new Float32Array(MAXP);
    this.life = new Float32Array(MAXP); this.maxLife = new Float32Array(MAXP); this.size = new Float32Array(MAXP);
    this.pSeed = new Float32Array(MAXP); this.pLin = new Float32Array(MAXP * 3); this.pCss = new Array(MAXP).fill('#fff');
    // GPU upload buffers
    this.bloomData = new Float32Array(MAXB * BLOOM_STRIDE);
    this.partData = new Float32Array(MAXP * PART_STRIDE);
    this.notes = new Float32Array(16 * 4); this.noteCount = 0;
    this._c = [0, 0, 0]; this._c2 = [0, 0, 0];
    this.newNotes = 0; // count of blooms spawned (tests / stats)
    this.wantCss = false; // Canvas2D fallback needs CSS colour strings; WebGL doesn't (no per-spark garbage)
    this._gone = [];
    this.rate = 0;     // recent note-on rate (per second) → busy passages get gentler rings/bursts
    /** note → hero x (0..1). The hero points this at the on-screen keyboard so light rises above the key. */
    this.xOf = noteToX;
    /** (note, vel, pal, out) → sRGB light colour; null = palette by velocity. */
    this.colOf = null;
    this.baseY = BLOOM_BASE; // where a note's light column stands (0 = bottom, 1 = top)
    this.kick = 0;           // note-on transient energy (decays) → horizon flash / curtain pulse
    this.starT = 3 + this.rng.next() * 5; // idle shooting stars
    this.streak = null;
  }

  _colour(vel, pal, out) {
    // soft = cool/deep region of the palette, hard = hot/bright region, nudged toward white
    pal(0.2 + 0.55 * vel, out);
    const w = 0.28 * vel * vel;
    out[0] = lerp(out[0], 1, w); out[1] = lerp(out[1], 1, w); out[2] = lerp(out[2], 1, w);
    return out;
  }

  _spawnBloom(key, note, vel, level, pal) {
    let i = this.bn;
    if (i >= MAXB) {
      // replace the weakest released bloom, else the weakest overall
      let best = -1, bestScore = 1e9;
      for (let j = 0; j < this.bn; j++) {
        const sc = this.bLevel[j] + (this.bHeld[j] ? 10 : 0) - this.bAge[j] * 0.01;
        if (sc < bestScore) { bestScore = sc; best = j; }
      }
      i = best;
      const k = this.bKey[i];
      if (k != null && this.voices.has(k) && this.voices.get(k).b === i) this.voices.get(k).b = -1;
    } else this.bn++;
    const r = this.rng;
    this.bKey[i] = key; this.bNote[i] = note; this.bVel[i] = vel;
    this.bLevel[i] = 0; this.bTarget[i] = level; this.bAge[i] = 0; this.bHeld[i] = 1; this.bEmit[i] = 0;
    const dens = 1 / Math.sqrt(Math.max(1, this.rate / 3));
    this.bRing[i] = (0.08 + 0.62 * vel * vel) * dens;
    this._spawned++;
    this.bX[i] = clamp(this.xOf(note), 0.012, 0.988);
    this.bY[i] = this.baseY + (r.next() - 0.5) * 0.012;
    this.bSeed[i] = r.next() * 100;
    this.kick = Math.max(this.kick, (0.3 + 0.9 * vel) * dens);
    const c = this.colOf ? this.colOf(note, vel, pal, this._c) : this._colour(vel, pal, this._c);
    this.bRgb[i * 3] = c[0]; this.bRgb[i * 3 + 1] = c[1]; this.bRgb[i * 3 + 2] = c[2];
    this.bLin[i * 3] = s2l(c[0]); this.bLin[i * 3 + 1] = s2l(c[1]); this.bLin[i * 3 + 2] = s2l(c[2]);
    if (this.wantCss) this.bCss[i] = rgba(c, 1);
    this.newNotes++;
    // burst of sparks
    const n = Math.round((10 + 28 * vel) * dens);
    for (let k = 0; k < n; k++) this._spawnParticle(i, 0.6 + 0.6 * vel, true);
    return i;
  }

  _spawnParticle(b, energy, burst) {
    if (this.pn >= MAXP) return;
    const r = this.rng, j = this.pn++;
    const ang = Math.PI / 2 + (r.next() - 0.5) * Math.PI * (burst ? 1.25 : 0.5);
    const sp = burst ? (0.05 + 0.3 * r.next() * r.next() + 0.08 * r.next()) * energy : 0.02 + 0.05 * r.next();
    this.px[j] = this.bX[b]; this.py[j] = this.bY[b] + (burst ? 0 : r.next() * 0.25 * this.bLevel[b]);
    this.vx[j] = Math.cos(ang) * sp; this.vy[j] = Math.sin(ang) * sp;
    this.maxLife[j] = burst ? 0.8 + 1.6 * r.next() : 1.2 + 1.5 * r.next();
    this.life[j] = 0;
    this.size[j] = burst ? 1.3 + 2.6 * r.next() * r.next() : 1 + 1.4 * r.next();
    this.pSeed[j] = r.next() * 50;
    const w = r.next() * 0.45;
    const cr = lerp(this.bRgb[b * 3], 1, w), cg = lerp(this.bRgb[b * 3 + 1], 1, w), cb = lerp(this.bRgb[b * 3 + 2], 1, w);
    this.pLin[j * 3] = s2l(cr); this.pLin[j * 3 + 1] = s2l(cg); this.pLin[j * 3 + 2] = s2l(cb);
    if (this.wantCss) this.pCss[j] = `rgb(${(cr * 255) | 0},${(cg * 255) | 0},${(cb * 255) | 0})`;
  }

  /** Free particle (shooting-star trail): sRGB colour 0..1. */
  _spawnFree(x, y, vx, vy, life, size, cr, cg, cb) {
    if (this.pn >= MAXP) return;
    const j = this.pn++;
    this.px[j] = x; this.py[j] = y; this.vx[j] = vx; this.vy[j] = vy;
    this.maxLife[j] = life; this.life[j] = 0; this.size[j] = size; this.pSeed[j] = this.rng.next() * 50;
    this.pLin[j * 3] = s2l(cr); this.pLin[j * 3 + 1] = s2l(cg); this.pLin[j * 3 + 2] = s2l(cb);
    if (this.wantCss) this.pCss[j] = `rgb(${(cr * 255) | 0},${(cg * 255) | 0},${(cb * 255) | 0})`;
  }

  /** Occasional shooting star while the sky is quiet (a streak of short-lived sparks). */
  _sky(dt, idle, motion, aspect) {
    if (motion < 1) { this.streak = null; return; }
    const r = this.rng;
    if (!this.streak) {
      this.starT -= dt * (idle > 0.5 ? 1 : 0.15);
      if (this.starT > 0) return;
      this.starT = 6 + r.next() * 12;
      const dir = r.next() < 0.5 ? -1 : 1, sp = 0.55 + 0.35 * r.next();
      const ang = 0.28 + 0.3 * r.next();
      this.streak = { x: 0.15 + 0.7 * r.next(), y: 0.72 + 0.24 * r.next(), vx: dir * Math.cos(ang) * sp / Math.max(0.5, aspect / 3), vy: -Math.sin(ang) * sp, t: 0, dur: 0.5 + 0.35 * r.next(), acc: 0 };
    }
    const s = this.streak;
    const x0 = s.x, y0 = s.y;
    s.t += dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    const f = s.t / s.dur, bright = Math.sin(Math.PI * clamp01(f));
    // spawn along this frame's whole path segment → a continuous streak, not a dotted line
    s.acc += dt * 520;
    const n = Math.floor(s.acc);
    s.acc -= n;
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      this._spawnFree(lerp(x0, s.x, u), lerp(y0, s.y, u), s.vx * 0.03, s.vy * 0.03, (0.16 + 0.34 * r.next()) * (0.4 + 0.6 * bright), 0.7 + 1.4 * bright, 0.82 + 0.18 * bright, 0.9, 1);
    }
    if (f >= 1 || s.y < 0.3) this.streak = null;
  }

  _killParticle(j) {
    const k = --this.pn;
    if (j === k) return;
    this.px[j] = this.px[k]; this.py[j] = this.py[k]; this.vx[j] = this.vx[k]; this.vy[j] = this.vy[k];
    this.life[j] = this.life[k]; this.maxLife[j] = this.maxLife[k]; this.size[j] = this.size[k]; this.pSeed[j] = this.pSeed[k];
    this.pLin[j * 3] = this.pLin[k * 3]; this.pLin[j * 3 + 1] = this.pLin[k * 3 + 1]; this.pLin[j * 3 + 2] = this.pLin[k * 3 + 2];
    this.pCss[j] = this.pCss[k];
  }

  _killBloom(i) {
    const k = --this.bn;
    const key = this.bKey[i];
    if (key != null && this.voices.has(key) && this.voices.get(key).b === i) this.voices.get(key).b = -1;
    if (i !== k) {
      this.bKey[i] = this.bKey[k]; this.bNote[i] = this.bNote[k]; this.bVel[i] = this.bVel[k]; this.bLevel[i] = this.bLevel[k];
      this.bTarget[i] = this.bTarget[k]; this.bAge[i] = this.bAge[k]; this.bX[i] = this.bX[k]; this.bY[i] = this.bY[k];
      this.bSeed[i] = this.bSeed[k]; this.bHeld[i] = this.bHeld[k]; this.bEmit[i] = this.bEmit[k]; this.bCss[i] = this.bCss[k];
      this.bRing[i] = this.bRing[k];
      for (let c = 0; c < 3; c++) { this.bRgb[i * 3 + c] = this.bRgb[k * 3 + c]; this.bLin[i * 3 + c] = this.bLin[k * 3 + c]; }
      const kk = this.bKey[i];
      if (kk != null && this.voices.has(kk) && this.voices.get(kk).b === k) this.voices.get(kk).b = i;
    }
    this.bKey[k] = null;
  }

  /** voices: getState().voices (or null). pal(u, out): palette sampler. aspect = width/height. */
  update(dt, t, voices, pal, aspect, motion = 1, idle = 0) {
    const st = ++this.stamp;
    this._spawned = 0;
    this.kick *= Math.exp(-dt / 0.18);
    if (voices && voices.length) {
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (!v) continue;
        const note = finite(v.note, 60);
        // numeric keys (voice slot, else 10000+note) avoid per-frame string garbage
        const key = v.id != null ? `i${v.id}` : v.index != null ? v.index : 10000 + note;
        const age = finite(v.age, 0);
        const level = clamp01(finite(v.level, 1));
        const vel = clamp01(finite(v.velocity, finite(v.vel, 0.8)));
        let s = this.voices.get(key);
        const isNew = !s || s.note !== note || age + 0.004 < s.age;
        if (isNew) {
          if (s && s.b >= 0 && this.bKey[s.b] === key) { this.bHeld[s.b] = 0; this.bTarget[s.b] = 0; this.bKey[s.b] = null; }
          if (!s) { s = { note, age, b: -1, stamp: st }; this.voices.set(key, s); }
          s.note = note;
          s.b = this._spawnBloom(key, note, vel, level, pal);
        }
        s.age = age; s.stamp = st;
        if (s.b >= 0 && this.bKey[s.b] === key) { this.bTarget[s.b] = level; this.bHeld[s.b] = 1; }
      }
    }
    this.rate = this.rate * Math.exp(-dt / 1.0) + this._spawned;
    // chords: several blooms born in the same frame share one ring's worth of light
    if (this._spawned > 1) {
      const k = 1 / Math.sqrt(this._spawned);
      for (let i = 0; i < this.bn; i++) if (this.bAge[i] === 0) this.bRing[i] *= k;
    }
    const gone = this._gone;
    gone.length = 0;
    this.voices.forEach(this._sweep || (this._sweep = (s, key) => { if (s.stamp !== this.stamp) gone.push(key); }));
    for (let g = 0; g < gone.length; g++) {
      const key = gone[g], s = this.voices.get(key);
      if (s.b >= 0 && this.bKey[s.b] === key) { this.bHeld[s.b] = 0; this.bTarget[s.b] = 0; this.bKey[s.b] = null; }
      this.voices.delete(key);
    }

    // blooms
    const aUp = follow(dt, 0.025), aDn = follow(dt, 0.09), aGone = follow(dt, 0.35);
    for (let i = 0; i < this.bn; i++) {
      this.bAge[i] += dt * motion;
      const tg = this.bTarget[i], l = this.bLevel[i];
      this.bLevel[i] = l + (tg - l) * (tg > l ? aUp : this.bHeld[i] ? aDn : aGone);
      // held notes keep shedding a few sparks
      if (this.bLevel[i] > 0.05 && this.bHeld[i]) {
        this.bEmit[i] += dt * motion * 7 * this.bLevel[i];
        while (this.bEmit[i] >= 1) { this.bEmit[i] -= 1; this._spawnParticle(i, 1, false); }
      }
    }
    for (let i = this.bn - 1; i >= 0; i--) {
      if (!this.bHeld[i] && this.bLevel[i] < 0.003 && this.bAge[i] > 2.8) this._killBloom(i);
    }

    this._sky(dt, idle, motion, aspect);

    // particles
    const drag = Math.exp(-1.7 * dt * motion);
    const ia = 1 / Math.max(0.2, aspect);
    for (let j = this.pn - 1; j >= 0; j--) {
      const lf = (this.life[j] += dt * motion);
      if (lf >= this.maxLife[j]) { this._killParticle(j); continue; }
      const sd = this.pSeed[j];
      this.vx[j] = this.vx[j] * drag + Math.sin(this.py[j] * 17 + t * 1.3 + sd) * 0.03 * dt * motion;
      this.vy[j] = this.vy[j] * drag + 0.04 * dt * motion;
      this.px[j] += this.vx[j] * dt * motion * ia;
      this.py[j] += this.vy[j] * dt * motion;
    }

    // GPU buffers
    const B = this.bloomData;
    let nc = 0, act = 0;
    for (let i = 0; i < this.bn; i++) act += this.bLevel[i];
    const gN = Math.pow(Math.max(1, act * 0.55), -0.8);
    for (let i = 0; i < this.bn; i++) {
      const o = i * BLOOM_STRIDE;
      B[o] = this.bX[i]; B[o + 1] = this.bY[i]; B[o + 2] = this.bLevel[i]; B[o + 3] = this.bVel[i];
      B[o + 4] = this.bLin[i * 3]; B[o + 5] = this.bLin[i * 3 + 1]; B[o + 6] = this.bLin[i * 3 + 2]; B[o + 7] = this.bAge[i];
      B[o + 8] = this.bSeed[i]; B[o + 9] = this.bRing[i]; B[o + 10] = 1.5 * gN; B[o + 11] = 1.5 * gN;
      if (nc < 16 && this.bLevel[i] > 0.01) {
        this.notes[nc * 4] = this.bX[i]; this.notes[nc * 4 + 1] = this.bLevel[i]; this.notes[nc * 4 + 2] = this.bVel[i]; this.notes[nc * 4 + 3] = 0;
        nc++;
      }
    }
    this.noteCount = nc;
    const P = this.partData;
    for (let j = 0; j < this.pn; j++) {
      const o = j * PART_STRIDE, u = this.life[j] / this.maxLife[j];
      const a = Math.pow(1 - u, 1.4) * Math.min(1, this.life[j] * 25) * (0.75 + 0.25 * Math.sin(t * 13 + this.pSeed[j]));
      P[o] = this.px[j]; P[o + 1] = this.py[j]; P[o + 2] = this.size[j]; P[o + 3] = a;
      P[o + 4] = this.pLin[j * 3]; P[o + 5] = this.pLin[j * 3 + 1]; P[o + 6] = this.pLin[j * 3 + 2];
    }
  }
}

/* ═══════════════════════════════ hero: WebGL2 renderer ═══════════════════════════════ */

// Aurora curtains, back → front: [baseY, height, depth, seed] [xOff, hue, speed, brightness]
// Far curtains sit high and faint and drift slowly; near ones hang lower, taller, brighter and slide
// faster (parallax). Each lower border meanders in S-curves so they read as folded curtains, not bands.
const RIBBONS = [
  [0.64, 0.17, 0.00, 1.3, 0.020, 0.30, 0.50, 0.40],
  [0.55, 0.24, 0.25, 4.7, -0.012, 0.19, 0.70, 0.56],
  [0.47, 0.31, 0.50, 7.1, 0.008, 0.09, 0.90, 0.74],
  [0.39, 0.38, 0.75, 2.9, -0.018, 0.00, 1.08, 0.90],
  [0.31, 0.46, 1.00, 9.4, 0.000, -0.07, 1.25, 1.04],
];
const RIB_SEG = 200;
const N_STARS = 520;
const N_DUST = 900;
const PAL_W = 256;

const GLSL_HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
const GLSL_COMMON = `
uniform float uTime, uRt, uAspect, uPx, uGain, uIntensity, uShift, uLoud, uLow, uHigh, uWidth, uIdle, uBalance, uMaxPt, uPulse;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float vnoise(float x) { float i = floor(x); float f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
uniform sampler2D uPal;
uniform vec3 uPalSel;
vec3 pal(float u) {
  vec3 m = mix(textureLod(uPal, vec2(u, uPalSel.x), 0.0).rgb, textureLod(uPal, vec2(u, uPalSel.y), 0.0).rgb, uPalSel.z);
  float k = uPalSel.z * (1.0 - uPalSel.z) * 4.0;   // mid-crossfade: restore some chroma lost by mixing
  float l = dot(m, vec3(0.2126, 0.7152, 0.0722));
  return max(vec3(l) + (m - vec3(l)) * (1.0 + 0.6 * k), vec3(0.0));
}
`;
const GLSL_RIBBON = `
uniform sampler2D uSpec;
uniform vec4 uRA[6];
uniform vec4 uRB[6];
uniform vec4 uNotes[16];
uniform int uNoteCount;
vec2 specAt(float x) { return textureLod(uSpec, vec2(clamp(x, 0.0, 1.0), 0.5), 0.0).rg; }
/** Parallax drift of curtain ri (nearer = faster). */
float ribbonPar(int ri) { return uTime * uRB[ri].z * (0.006 + 0.018 * uRA[ri].z); }
vec3 ribbonGeo(int ri, float x, out float e, out float fb, out float nb) {
  vec4 A = uRA[ri];
  vec4 B = uRB[ri];
  float t = uTime * B.z;
  float xp = x + ribbonPar(ri);
  float w = (0.55 + 0.9 * uWidth) * (0.7 + 0.6 * A.z);
  float a1 = xp * 4.3 + t * 0.12 + A.w * 3.1;
  float a2 = xp * 11.7 - t * 0.08 + A.w * 1.7;
  float fold = (sin(a1) * 0.034 + sin(a2) * 0.011) * w;
  float dfold = (cos(a1) * 0.146 + cos(a2) * 0.129) * w;
  float xs = x + fold;
  e = specAt(x + B.x).r;
  float yb = A.x + (vnoise(xp * 1.9 + t * 0.03 + A.w * 7.0) - 0.5) * 0.26
           + sin(xp * 2.6 + t * 0.07 + A.w) * 0.055 + sin(xp * 8.3 - t * 0.19 + A.w * 2.3) * 0.01;
  yb += (A.z - 0.5) * 0.12 * uWidth;
  float ns = 0.0;
  for (int k = 0; k < 16; k++) {
    if (k >= uNoteCount) break;
    vec4 n = uNotes[k];
    float dx = xs - n.x;
    ns += n.y * exp(-dx * dx * 900.0);
  }
  nb = ns / (1.0 + ns);
  float eh = min(e, 1.0);
  float idleH = (0.28 + 0.36 * vnoise(xp * 3.1 - t * 0.05 + A.w * 3.0)) * (0.6 + 0.4 * uIdle);
  float h = A.y * (idleH + eh * 1.1) * (1.0 + 0.12 * uPulse) + nb * 0.2 * (0.55 + 0.45 * A.z);
  fb = clamp(1.0 / max(abs(1.0 + dfold), 0.3), 0.0, 2.5);
  return vec3(xs, yb, h);
}
`;
const VS_FULL = `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS_SKY = `
uniform vec4 uNotes[16];
uniform int uNoteCount;
in vec2 vUv;
out vec4 o;
void main() {
  float y = vUv.y;
  vec3 top = vec3(0.0010, 0.0014, 0.0048);
  vec3 hor = vec3(0.0080, 0.0118, 0.0310);
  vec3 c = mix(hor, top, pow(y, 0.6));
  vec3 glow = pal(vUv.x * 0.5 + uShift + 0.05);
  float g = exp(-pow((y - 0.42) * 2.3, 2.0)) * (0.012 + 0.05 * uIntensity + 0.07 * uLow);
  c += glow * g;
  // horizon light: a flash on transients / beats and a soft glow above every sounding note
  float hz = exp(-pow((y - 0.15) * 5.5, 2.0));
  c += pal(vUv.x * 0.4 + uShift + 0.15) * hz * 0.07 * uPulse;
  vec3 ng = vec3(0.0);
  for (int k = 0; k < 16; k++) {
    if (k >= uNoteCount) break;
    vec4 n = uNotes[k];
    float dx = (vUv.x - n.x) * uAspect;
    ng += pal(0.2 + 0.55 * n.z) * (n.y * exp(-dx * dx * 7.0));
  }
  c += ng * exp(-pow((y - 0.17) * 3.0, 2.0)) * 0.05;
  float n = vnoise(vUv.x * 5.0 * uAspect + uTime * 0.01) * vnoise(y * 8.0 - uTime * 0.007 + 3.0);
  c += pal(0.72 + vUv.x * 0.2) * n * n * 0.02 * smoothstep(0.35, 1.0, y);
  o = vec4(c * uGain, 1.0);
}`;
const VS_STARS = `
layout(location = 0) in vec4 aSeed;
out vec3 vCol;
out float vA;
void main() {
  float x = fract(aSeed.x + uRt * 0.0012 * (0.5 + aSeed.w));
  float y = 0.1 + 0.9 * pow(aSeed.y, 0.8);
  float big = pow(aSeed.z, 9.0);
  gl_PointSize = clamp((1.3 + 3.2 * big) * uPx, 1.0, uMaxPt);
  float tw = 0.62 + 0.38 * sin(uRt * (0.6 + 2.8 * aSeed.w) + aSeed.x * 91.0);
  vA = (0.07 + 1.1 * big + 0.16 * aSeed.w) * tw * smoothstep(0.12, 0.4, y) * (1.0 - 0.4 * uLoud) * (1.0 + 0.6 * uPulse * aSeed.w);
  vCol = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.82, 0.66), step(0.86, aSeed.w));
  gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS_POINT = `
in vec3 vCol;
in float vA;
out vec4 o;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  float a = exp(-r2 * 4.5) * (1.0 - smoothstep(0.75, 1.0, r2));
  o = vec4(vCol * (vA * a * uGain), 1.0);
}`;
const VS_RIBBON = `
layout(location = 0) in vec2 aPos;
uniform int uRi;
out float vV;
out float vX;
out float vXp;
out float vE;
out float vNb;
out float vFb;
out vec3 vLo;
out vec3 vHi;
void main() {
  float x = mix(-0.06, 1.06, aPos.x);
  float e, fb, nb;
  vec3 g = ribbonGeo(uRi, x, e, fb, nb);
  float v = aPos.y;
  float lean = sin(x * 3.7 + uTime * 0.06 + uRA[uRi].w) * 0.05;
  float X = g.x + v * g.z * lean;
  float Y = g.y + v * g.z;
  gl_Position = vec4(X * 2.0 - 1.0, Y * 2.0 - 1.0, 0.0, 1.0);
  vV = v; vX = x; vXp = x + ribbonPar(uRi); vE = e; vNb = nb; vFb = fb;
  float u = x * 0.5 + uShift + uRB[uRi].y;
  vLo = pal(u);
  vHi = pal(u + 0.27);
}`;
const FS_RIBBON = `
uniform vec4 uRA[6];
uniform vec4 uRB[6];
uniform int uRi;
in float vV;
in float vX;
in float vXp;
in float vE;
in float vNb;
in float vFb;
in vec3 vLo;
in vec3 vHi;
out vec4 o;
void main() {
  vec4 A = uRA[uRi];
  vec4 B = uRB[uRi];
  float v = vV;
  float t = uTime * B.z;
  float fr = mix(150.0, 85.0, A.z);
  float r1 = vnoise(vXp * fr + t * 0.45 + A.w * 13.0);
  float r2 = vnoise(vXp * fr * 2.7 - t * 1.1 + A.w * 5.0);
  float r3 = vnoise(vXp * fr * 0.07 + t * 0.12 + A.w * 2.0);   // broad bright/dim clumps along the curtain
  float seg = smoothstep(0.28, 0.72, vnoise(vXp * (1.7 + 0.9 * A.z) + A.w * 5.0 + t * 0.021)) * 0.94 + 0.06;
  float edge = smoothstep(0.0, 0.05, v);
  float body = exp(-v * 2.3) * (1.0 - smoothstep(0.6, 1.0, v));
  float line = exp(-v * 24.0) * (0.25 + 1.0 * r1);
  float rays = mix(1.0, 0.15 + 1.3 * (r1 * 0.65 + r2 * 0.35), smoothstep(0.0, 0.25, v));
  float prof = edge * (body * rays + line * 0.7) * (0.55 + 0.7 * r3) * mix(seg, 1.0, min(vE * 1.3, 1.0));
  vec3 col = mix(vLo, vHi, smoothstep(0.06, 0.7, v));
  col += vec3(0.75, 0.9, 1.0) * (vE * vE * 0.16 + vNb * 0.2) * (1.0 - v);
  float I = prof * B.w * uIntensity * (0.5 + 0.7 * min(vE, 1.1) + vNb * 0.45) * vFb * (1.0 + 0.3 * uPulse);
  I *= smoothstep(-0.04, 0.06, vX) * smoothstep(1.04, 0.94, vX);
  I *= 1.0 + uBalance * (vX - 0.5) * 0.5;
  o = vec4(col * (I * uGain), 1.0);
}`;
const VS_DUST = `
layout(location = 0) in vec4 aSeed;
uniform int uRibbons;
out vec3 vCol;
out float vA;
void main() {
  float P = 3.5 + 5.0 * aSeed.z;
  float ph = fract(uRt / P + aSeed.x);
  int ri = int(min(aSeed.w * float(uRibbons), float(uRibbons) - 1.0));
  float x = fract(aSeed.y + uRt * 0.004 * (aSeed.z - 0.5));
  float e, fb, nb;
  vec3 g = ribbonGeo(ri, x, e, fb, nb);
  float y = g.y + g.z * (0.05 + 0.9 * fract(aSeed.x * 7.13)) + ph * 0.07;
  float life = sin(ph * 3.14159265);
  float tw = 0.5 + 0.5 * sin(uRt * (5.0 + 9.0 * aSeed.z) + aSeed.y * 40.0);
  float hi = specAt(x).g;
  float I = life * tw * (uHigh * 1.4 + hi * 1.1 + e * 0.25 + 0.05 + nb * 0.6 + uPulse * 0.25);
  gl_PointSize = clamp((1.0 + 1.9 * aSeed.z * aSeed.z) * uPx, 1.0, uMaxPt);
  gl_Position = vec4(g.x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  vCol = pal(x * 0.5 + uShift + 0.3 + aSeed.z * 0.2);
  vA = I * uIntensity;
}`;
// A sounding note = a column of light standing on the horizon above its key:
// width & strike flash ← velocity, height & brightness ← amp envelope (fades on release).
const VS_PILLAR = `
layout(location = 0) in vec4 iA;
layout(location = 1) in vec4 iB;
layout(location = 2) in vec4 iC;
out vec2 vQ;
out vec3 vCol;
out float vLevel;
out float vSeed;
out float vGain;
out float vAge;
out float vH;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  float lvl = max(iA.z, 0.0);
  float w = 0.008 + 0.014 * iA.w;
  float H = 0.24 + 0.66 * pow(lvl, 0.6);
  float X = iA.x + (c.x * 2.0 - 1.0) * w * 5.0 / uAspect;
  float Y = iA.y - 0.08 + c.y * (H + 0.08);
  gl_Position = vec4(X * 2.0 - 1.0, Y * 2.0 - 1.0, 0.0, 1.0);
  vQ = vec2((c.x * 2.0 - 1.0) * 5.0, c.y * (H + 0.08) - 0.08);
  vCol = iB.rgb; vLevel = lvl; vSeed = iC.x; vGain = iC.z; vAge = iB.w; vH = H;
}`;
const FS_PILLAR = `
in vec2 vQ;
in vec3 vCol;
in float vLevel;
in float vSeed;
in float vGain;
in float vAge;
in float vH;
out vec4 o;
void main() {
  float y = vQ.y;
  float v = clamp(y / vH, 0.0, 1.0);
  float q = vQ.x + sin(y * 26.0 + uRt * 1.4 + vSeed) * 0.55 * v;
  float core = exp(-q * q * 2.2);
  float halo = exp(-q * q * 0.16) * 0.22;
  float vert = smoothstep(-0.08, 0.03, y) * pow(1.0 - v, 1.1);
  float fl = 0.62 + 0.38 * vnoise(y * 38.0 - uRt * 3.2 + vSeed * 17.0);
  float strike = 1.0 + 1.6 * exp(-vAge * 4.0);
  vec3 col = vCol * (core * fl + halo) + vec3(1.0) * core * core * 0.55 * (1.0 - v);
  o = vec4(col * (vert * vLevel * vGain * strike * uGain), 1.0);
}`;
const VS_BLOOM = `
layout(location = 0) in vec4 iA;
layout(location = 1) in vec4 iB;
layout(location = 2) in vec4 iC;
out vec2 vP;
out vec3 vCol;
out float vLevel;
out float vAge;
out float vRing;
out float vGain;
out float vRc;
out float vRr;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  float age = iB.w, lvl = iA.z;
  float rc = 0.011 + 0.026 * iA.w;              // velocity → orb size
  float rr = 0.07 + 0.19 * iA.w;                // velocity → ripple size
  float R = lvl > 0.004 ? rc * 3.4 : 0.0;
  float g = 1.0 - exp(-age * 2.6);
  if (exp(-age * 1.7) * iC.y > 0.003) R = max(R, rr * g + 2.6 * (0.003 + 0.016 * g));
  R = min(R, 0.36);
  vP = c * R;
  float X = iA.x + c.x * R * 1.6 / uAspect;
  float Y = iA.y + c.y * R;
  gl_Position = vec4(X * 2.0 - 1.0, Y * 2.0 - 1.0, 0.0, 1.0);
  vCol = iB.rgb; vLevel = lvl; vAge = age; vRing = iC.y; vGain = iC.w; vRc = rc; vRr = rr;
}`;
const FS_BLOOM = `
in vec2 vP;
in vec3 vCol;
in float vLevel;
in float vAge;
in float vRing;
in float vGain;
in float vRc;
in float vRr;
out vec4 o;
void main() {
  float r = length(vP);
  float rc = vRc * (0.75 + 0.25 * vLevel);
  float core = exp(-r * r / (rc * rc)) * vLevel * vGain;
  float halo = exp(-r * r / (rc * rc * 9.0)) * vLevel * 0.13 * vGain;
  float g = 1.0 - exp(-vAge * 2.6);
  float d = (r - vRr * g) / (0.003 + 0.016 * g);
  float ring = exp(-d * d) * exp(-vAge * 1.7) * vRing;
  float a2 = max(vAge - 0.14, 0.0);
  float g2 = 1.0 - exp(-a2 * 2.6);
  float d2 = (r - vRr * 0.66 * g2) / (0.0025 + 0.013 * g2);
  float ring2 = exp(-d2 * d2) * exp(-vAge * 2.1) * vRing * 0.45 * step(0.14, vAge);
  vec3 c = vCol * (core + halo + ring + ring2) + vec3(1.0) * core * core * 0.3;
  o = vec4(c * uGain, 1.0);
}`;
const VS_SPARK = `
layout(location = 0) in vec4 aP;
layout(location = 1) in vec3 aC;
out vec3 vCol;
out float vA;
void main() {
  gl_PointSize = clamp(aP.z * uPx, 1.0, uMaxPt);
  vCol = aC * 1.6;
  vA = aP.w;
  gl_Position = vec4(aP.x * 2.0 - 1.0, aP.y * 2.0 - 1.0, 0.0, 1.0);
}`;
const VS_BAND = `
uniform float uTop;
out vec2 vUv;
void main() {
  vec2 p = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1) * uTop);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS_LAND = `
in vec2 vUv;
uniform float uPxH;
out vec4 o;
float ridgeFar(float x) { return 0.085 + 0.045 * vnoise(x * 2.3 + 4.0) + 0.02 * vnoise(x * 7.1 + 1.3) + 0.007 * vnoise(x * 23.0); }
float ridgeNear(float x) { return 0.04 + 0.04 * vnoise(x * 1.7 + 9.0) + 0.015 * vnoise(x * 6.3 + 2.0) + 0.005 * vnoise(x * 29.0 + 5.0); }
void main() {
  float x = vUv.x * uAspect;
  float y = vUv.y;
  float aa = uPxH * 1.5;
  float hf = ridgeFar(x);
  float hn = ridgeNear(x);
  float cf = smoothstep(hf + aa, hf - aa, y);
  float cn = smoothstep(hn + aa, hn - aa, y);
  vec3 lc = pal(vUv.x * 0.5 + uShift + 0.1);
  vec3 farCol = vec3(0.004, 0.006, 0.014) + lc * 0.012 * uIntensity;
  vec3 nearCol = vec3(0.0012, 0.0016, 0.004);
  float rimF = exp(-max(hf - y, 0.0) * 240.0) * cf * (1.0 + 1.5 * uPulse);
  float rimN = exp(-max(hn - y, 0.0) * 300.0) * cn;
  vec3 far = farCol + lc * rimF * 0.07 * uIntensity;
  vec3 near = nearCol + lc * rimN * 0.045 * uIntensity;
  vec3 col = mix(far, near, cn);
  float a = max(cf, cn);
  float haze = exp(-max(y - hf, 0.0) * 20.0) * (1.0 - cf) * (0.012 + 0.04 * uIntensity);
  o = vec4((col * a + lc * haze) * uGain, a);
}`;
const FS_DOWN = `
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThr;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  if (uThr > 0.0) { float l = max(c.r, max(c.g, c.b)); c *= max(l - uThr, 0.0) / max(l, 1e-4); }
  o = vec4(c, 1.0);
}`;
const FS_BLUR = `
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  c += texture(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`;
const FS_COMP = `
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform float uBloom1, uBloom2, uExposure;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float acesf(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// hue-preserving filmic curve on the max channel (keeps the aurora saturated when bright),
// blended with a little per-channel ACES so the hottest cores still roll off toward white
vec3 tonemap(vec3 c) {
  float m = max(max(c.r, c.g), max(c.b, 1e-5));
  vec3 hp = c * (acesf(m) / m);
  return mix(hp, aces(c), 0.22);
}
void main() {
  float ig = 1.0 / uGain;
  vec3 c = texture(uScene, vUv).rgb;
  c += texture(uB1, vUv).rgb * uBloom1 + texture(uB2, vUv).rgb * uBloom2;
  c *= ig * uExposure;
  vec2 q = (vUv - 0.5) * vec2(0.95, 1.25);
  c *= 1.0 - dot(q, q) * 0.6;
  c = tonemap(c);
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash21(gl_FragCoord.xy + fract(uRt * 7.0) * 113.0) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

function glCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    throw new Error(`[visuals] shader compile failed: ${log}\n${numbered}`);
  }
  return sh;
}
function glProgram(gl, vsBody, fsBody, useRibbon = false) {
  const vsSrc = GLSL_HEAD + GLSL_COMMON + (useRibbon ? GLSL_RIBBON : '') + vsBody;
  const fsSrc = GLSL_HEAD + GLSL_COMMON + fsBody;
  const vs = glCompile(gl, gl.VERTEX_SHADER, vsSrc), fs = glCompile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`[visuals] link failed: ${gl.getProgramInfoLog(p)}`);
  const u = Object.create(null);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function createHeroGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
    preserveDrawingBuffer: false, powerPreference: 'default',
  });
  if (!gl) return null;
  const hdr = !!gl.getExtension('EXT_color_buffer_float');
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2'); // GPU timing → adaptive resolution
  let tqPending = [], gpuMs = -1, frameNo = 0;
  const ptRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const maxPt = ptRange && ptRange[1] ? ptRange[1] : 64;
  const gain = hdr ? 1 : 0.5;

  const P = {
    sky: glProgram(gl, VS_FULL, FS_SKY),
    stars: glProgram(gl, VS_STARS, FS_POINT),
    ribbon: glProgram(gl, VS_RIBBON, FS_RIBBON, true),
    dust: glProgram(gl, VS_DUST, FS_POINT, true),
    pillar: glProgram(gl, VS_PILLAR, FS_PILLAR),
    bloom: glProgram(gl, VS_BLOOM, FS_BLOOM),
    spark: glProgram(gl, VS_SPARK, FS_POINT),
    land: glProgram(gl, VS_BAND, FS_LAND),
    down: glProgram(gl, VS_FULL, FS_DOWN),
    blur: glProgram(gl, VS_FULL, FS_BLUR),
    comp: glProgram(gl, VS_FULL, FS_COMP),
  };
  // fixed sampler units: 0 palette, 1 spectrum, 2..4 post
  for (const k in P) {
    const pr = P[k];
    gl.useProgram(pr.p);
    if (pr.u.uPal) gl.uniform1i(pr.u.uPal, 0);
    if (pr.u.uSpec) gl.uniform1i(pr.u.uSpec, 1);
    if (pr.u.uTex) gl.uniform1i(pr.u.uTex, 2);
    if (pr.u.uScene) gl.uniform1i(pr.u.uScene, 2);
    if (pr.u.uB1) gl.uniform1i(pr.u.uB1, 3);
    if (pr.u.uB2) gl.uniform1i(pr.u.uB2, 4);
  }

  // palette texture: one row per palette, sRGB → sampled as linear
  const palTex = gl.createTexture();
  {
    const data = new Uint8Array(PAL_W * PAL_NAMES.length * 4), c = [0, 0, 0];
    PAL_NAMES.forEach((name, row) => {
      for (let i = 0; i < PAL_W; i++) {
        paletteAt(name, i / PAL_W, c);
        const o = (row * PAL_W + i) * 4;
        data[o] = Math.round(c[0] * 255); data[o + 1] = Math.round(c[1] * 255); data[o + 2] = Math.round(c[2] * 255); data[o + 3] = 255;
      }
    });
    gl.bindTexture(gl.TEXTURE_2D, palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, PAL_W, PAL_NAMES.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  const specTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, specTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, NB, 1, 0, gl.RG, gl.FLOAT, new Float32Array(NB * 2));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // geometry
  const vaoEmpty = gl.createVertexArray();
  const mkStatic = (data, size) => {
    const vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, buf };
  };
  const ribData = new Float32Array((RIB_SEG + 1) * 4);
  for (let i = 0; i <= RIB_SEG; i++) { const x = i / RIB_SEG; ribData.set([x, 0, x, 1], i * 4); }
  const ribGeo = mkStatic(ribData, 2);
  const seeds = (n, seed) => { const r = new Rng(seed), a = new Float32Array(n * 4); for (let i = 0; i < a.length; i++) a[i] = r.next(); return a; };
  const starGeo = mkStatic(seeds(N_STARS, 0x5eed), 4);
  const dustGeo = mkStatic(seeds(N_DUST, 0xd057), 4);

  const instVao = gl.createVertexArray(), instBuf = gl.createBuffer();
  gl.bindVertexArray(instVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, MAXB * BLOOM_STRIDE * 4, gl.DYNAMIC_DRAW);
  for (let a = 0; a < 3; a++) {
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 4, gl.FLOAT, false, BLOOM_STRIDE * 4, a * 16);
    gl.vertexAttribDivisor(a, 1);
  }
  const partVao = gl.createVertexArray(), partBuf = gl.createBuffer();
  gl.bindVertexArray(partVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, partBuf);
  gl.bufferData(gl.ARRAY_BUFFER, MAXP * PART_STRIDE * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, PART_STRIDE * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, PART_STRIDE * 4, 16);
  gl.bindVertexArray(null);

  const ribA = new Float32Array(24), ribB = new Float32Array(24);
  RIBBONS.forEach((r, i) => { ribA.set(r.slice(0, 4), i * 4); ribB.set(r.slice(4, 8), i * 4); });

  // render targets
  let W = 0, H = 0, T = null, fmtHdr = hdr;
  function makeTarget(w, hh, useHdr) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (useHdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, hh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h: hh, ok };
  }
  function freeTargets() {
    if (!T) return;
    for (const k in T) { gl.deleteTexture(T[k].tex); gl.deleteFramebuffer(T[k].fb); }
    T = null;
  }
  function resize(w, hh) {
    if (w === W && hh === H && T) return;
    W = w; H = hh;
    freeTargets();
    const build = useHdr => {
      const w1 = Math.max(1, Math.ceil(W / 4)), h1 = Math.max(1, Math.ceil(H / 4));
      const w2 = Math.max(1, Math.ceil(w1 / 2)), h2 = Math.max(1, Math.ceil(h1 / 2));
      return {
        scene: makeTarget(W, H, useHdr),
        b1a: makeTarget(w1, h1, useHdr), b1b: makeTarget(w1, h1, useHdr),
        b2a: makeTarget(w2, h2, useHdr), b2b: makeTarget(w2, h2, useHdr),
      };
    };
    T = build(fmtHdr);
    if (fmtHdr && !Object.values(T).every(t => t.ok)) { freeTargets(); fmtHdr = false; T = build(false); }
  }

  let cur = null;
  const use = pr => { if (cur !== pr) { gl.useProgram(pr.p); cur = pr; } };
  const f1 = (pr, name, v) => { const l = pr.u[name]; if (l) gl.uniform1f(l, v); };
  function common(pr, F) {
    use(pr);
    const u = pr.u;
    if (u.uTime) gl.uniform1f(u.uTime, F.t);
    if (u.uRt) gl.uniform1f(u.uRt, F.rt);
    if (u.uAspect) gl.uniform1f(u.uAspect, F.aspect);
    if (u.uPx) gl.uniform1f(u.uPx, F.px);
    if (u.uGain) gl.uniform1f(u.uGain, fmtHdr ? 1 : gain);
    if (u.uIntensity) gl.uniform1f(u.uIntensity, F.intensity);
    if (u.uShift) gl.uniform1f(u.uShift, F.shift);
    if (u.uLoud) gl.uniform1f(u.uLoud, F.loud);
    if (u.uLow) gl.uniform1f(u.uLow, F.low);
    if (u.uHigh) gl.uniform1f(u.uHigh, F.high);
    if (u.uWidth) gl.uniform1f(u.uWidth, F.width);
    if (u.uIdle) gl.uniform1f(u.uIdle, F.idle);
    if (u.uBalance) gl.uniform1f(u.uBalance, F.balance);
    if (u.uPulse) gl.uniform1f(u.uPulse, F.pulse);
    if (u.uMaxPt) gl.uniform1f(u.uMaxPt, maxPt);
    if (u.uPalSel) gl.uniform3f(u.uPalSel, (F.palA + 0.5) / PAL_NAMES.length, (F.palB + 0.5) / PAL_NAMES.length, F.palMix);
  }
  function ribbonUniforms(pr, F) {
    const u = pr.u;
    if (u.uRA) gl.uniform4fv(u.uRA, ribA);
    if (u.uRB) gl.uniform4fv(u.uRB, ribB);
    if (u.uNotes) gl.uniform4fv(u.uNotes, F.model.notes);
    if (u.uNoteCount) gl.uniform1i(u.uNoteCount, F.model.noteCount);
  }
  function pass(pr, target, tex, extra) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    use(pr);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    extra();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function pollTimer() {
    while (tqPending.length) {
      const q = tqPending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      tqPending.shift();
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) gpuMs = gpuMs < 0 ? ms : gpuMs * 0.7 + ms * 0.3;
    }
  }

  function render(F) {
    if (!T || gl.isContextLost()) return;
    const M = F.model;
    cur = null;
    let q = null;
    if (tq) {
      pollTimer();
      if (++frameNo % 15 === 0 && tqPending.length < 4) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
    }
    gl.bindVertexArray(vaoEmpty);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NB, 1, gl.RG, gl.FLOAT, F.spec);

    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    common(P.sky, F);
    ribbonUniforms(P.sky, F);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    common(P.stars, F);
    gl.bindVertexArray(starGeo.vao);
    gl.drawArrays(gl.POINTS, 0, N_STARS);

    common(P.ribbon, F);
    ribbonUniforms(P.ribbon, F);
    gl.bindVertexArray(ribGeo.vao);
    for (let i = 0; i < RIBBONS.length; i++) {
      gl.uniform1i(P.ribbon.u.uRi, i);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, (RIB_SEG + 1) * 2);
    }

    common(P.dust, F);
    ribbonUniforms(P.dust, F);
    if (P.dust.u.uRibbons) gl.uniform1i(P.dust.u.uRibbons, RIBBONS.length);
    gl.bindVertexArray(dustGeo.vao);
    gl.drawArrays(gl.POINTS, 0, N_DUST);

    if (M.bn) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, M.bloomData, 0, M.bn * BLOOM_STRIDE);
      gl.bindVertexArray(instVao);
      common(P.pillar, F);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, M.bn);
      common(P.bloom, F);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, M.bn);
    }
    if (M.pn) {
      gl.bindBuffer(gl.ARRAY_BUFFER, partBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, M.partData, 0, M.pn * PART_STRIDE);
      gl.bindVertexArray(partVao);
      common(P.spark, F);
      gl.drawArrays(gl.POINTS, 0, M.pn);
    }
    if (F.landscape) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vaoEmpty);
      common(P.land, F);
      f1(P.land, 'uPxH', 1 / H);
      f1(P.land, 'uTop', 0.42);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vaoEmpty);

    // bloom: ¼-res bright pass + blur, ⅛-res wide blur
    const ud = P.down.u, ub = P.blur.u;
    pass(P.down, T.b1a, T.scene, () => { gl.uniform2f(ud.uTexel, 1 / W, 1 / H); gl.uniform1f(ud.uThr, 0.04); });
    pass(P.blur, T.b1b, T.b1a, () => gl.uniform2f(ub.uDir, 1 / T.b1a.w, 0));
    pass(P.blur, T.b1a, T.b1b, () => gl.uniform2f(ub.uDir, 0, 1 / T.b1a.h));
    pass(P.down, T.b2a, T.b1a, () => { gl.uniform2f(ud.uTexel, 0.5 / T.b1a.w, 0.5 / T.b1a.h); gl.uniform1f(ud.uThr, 0); });
    pass(P.blur, T.b2b, T.b2a, () => gl.uniform2f(ub.uDir, 1.5 / T.b2a.w, 0));
    pass(P.blur, T.b2a, T.b2b, () => gl.uniform2f(ub.uDir, 0, 1.5 / T.b2a.h));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    common(P.comp, F);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, T.scene.tex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, T.b1a.tex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, T.b2a.tex);
    f1(P.comp, 'uBloom1', F.bloom1);
    f1(P.comp, 'uBloom2', F.bloom2);
    f1(P.comp, 'uExposure', F.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); tqPending.push(q); }
  }

  function destroy() {
    for (const q of tqPending) gl.deleteQuery(q);
    tqPending = [];
    freeTargets();
    for (const k in P) gl.deleteProgram(P[k].p);
    [palTex, specTex].forEach(t => gl.deleteTexture(t));
    [ribGeo, starGeo, dustGeo].forEach(g => { gl.deleteBuffer(g.buf); gl.deleteVertexArray(g.vao); });
    gl.deleteBuffer(instBuf); gl.deleteBuffer(partBuf);
    [vaoEmpty, instVao, partVao].forEach(v => gl.deleteVertexArray(v));
    const lc = gl.getExtension('WEBGL_lose_context');
    if (lc) lc.loseContext(); // free the context slot now rather than at GC
  }

  return {
    kind: 'webgl2', get hdr() { return fmtHdr; }, resize, render, destroy, gl, maxDpr: 1.5, // soft imagery: 1.5× is visually lossless and ~45 % cheaper than 2×
    /** Smoothed GPU time of a hero frame in ms (−1 when EXT_disjoint_timer_query_webgl2 is unavailable). */
    get gpuMs() { return gpuMs; },
    resetGpu() { gpuMs = -1; },
  };
}

/* ═══════════════════════════════ hero: Canvas2D fallback ═══════════════════════════════ */

function ribbonCPU(R, x, F, out) {
  const t = F.t * R[6], sd = R[3], xp = x + F.t * R[6] * (0.006 + 0.018 * R[2]);
  const w = (0.55 + 0.9 * F.width) * (0.7 + 0.6 * R[2]);
  const xs = x + (Math.sin(xp * 4.3 + t * 0.12 + sd * 3.1) * 0.034 + Math.sin(xp * 11.7 - t * 0.08 + sd * 1.7) * 0.011) * w;
  const bx = clamp(x + R[4], 0, 1) * (NB - 1), bi = Math.floor(bx), bf = bx - bi;
  const e = lerp(F.bands[bi], F.bands[Math.min(NB - 1, bi + 1)], bf);
  let yb = R[0] + (vnoise(xp * 1.9 + t * 0.03 + sd * 7) - 0.5) * 0.26 + Math.sin(xp * 2.6 + t * 0.07 + sd) * 0.055 + Math.sin(xp * 8.3 - t * 0.19 + sd * 2.3) * 0.01;
  yb += (R[2] - 0.5) * 0.12 * F.width;
  let ns = 0;
  const N = F.model.notes;
  for (let k = 0; k < F.model.noteCount; k++) { const dx = xs - N[k * 4]; ns += N[k * 4 + 1] * Math.exp(-dx * dx * 900); }
  const nb = ns / (1 + ns);
  const idleH = (0.28 + 0.36 * vnoise(xp * 3.1 - t * 0.05 + sd * 3)) * (0.6 + 0.4 * F.idle);
  out[0] = xs; out[1] = yb; out[2] = R[1] * (idleH + Math.min(e, 1) * 1.1) * (1 + 0.12 * (F.pulse || 0)) + nb * 0.2 * (0.55 + 0.45 * R[2]); out[3] = e; out[4] = nb;
  return out;
}

function createHero2D(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  const S = 72;
  const X = new Float32Array(S + 1), YB = new Float32Array(S + 1), HH = new Float32Array(S + 1), EE = new Float32Array(S + 1);
  const g5 = [0, 0, 0, 0, 0], c = [0, 0, 0];
  let W = 0, H = 0, sky = null, stars = [], hillFar = null, hillNear = null;
  const BANDS = [[0, 0.035, 0.5], [0.035, 0.1, 0.36], [0.1, 0.2, 0.25], [0.2, 0.34, 0.16], [0.34, 0.52, 0.1], [0.52, 0.78, 0.05], [0.78, 1, 0.02]];

  function resize(w, hh) {
    W = w; H = hh;
    sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#020309'); sky.addColorStop(0.7, '#070b1c'); sky.addColorStop(1, '#0c1330');
    const r = new Rng(0x5eed);
    stars = [];
    for (let i = 0; i < 170; i++) {
      const big = Math.pow(r.next(), 9);
      stars.push({ x: r.next(), y: 0.12 + 0.88 * Math.pow(r.next(), 0.8), s: 0.7 + 2.2 * big, a: 0.12 + 0.7 * big + 0.2 * r.next(), w: 0.6 + 2.6 * r.next(), ph: r.next() * 6.28 });
    }
    const asp = W / Math.max(1, H);
    const ridge = (fn) => {
      const p = new Path2D();
      p.moveTo(0, H);
      for (let i = 0; i <= 160; i++) { const u = i / 160; p.lineTo(u * W, H * (1 - fn(u * asp))); }
      p.lineTo(W, H); p.closePath();
      return p;
    };
    hillFar = ridge(x => 0.085 + 0.045 * vnoise(x * 2.3 + 4) + 0.02 * vnoise(x * 7.1 + 1.3) + 0.007 * vnoise(x * 23));
    hillNear = ridge(x => 0.04 + 0.04 * vnoise(x * 1.7 + 9) + 0.015 * vnoise(x * 6.3 + 2) + 0.005 * vnoise(x * 29 + 5));
  }

  function render(F) {
    if (!W || !H) return;
    const pal = F.palSample;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    // stars
    ctx.fillStyle = '#c9d6ff';
    const sd = 1 - 0.4 * F.loud;
    for (const s of stars) {
      const x = ((s.x + F.rt * 0.0012) % 1) * W, y = (1 - s.y) * H;
      ctx.globalAlpha = clamp01(s.a * (0.62 + 0.38 * Math.sin(F.rt * s.w + s.ph)) * sd);
      ctx.fillRect(x, y, s.s * F.px, s.s * F.px);
    }
    // curtains
    for (let r = 0; r < RIBBONS.length; r++) {
      const R = RIBBONS[r];
      let eAvg = 0;
      for (let j = 0; j <= S; j++) {
        ribbonCPU(R, -0.04 + 1.08 * (j / S), F, g5);
        X[j] = g5[0] * W; YB[j] = g5[1]; HH[j] = g5[2]; EE[j] = g5[3]; eAvg += g5[3];
      }
      eAvg /= S + 1;
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      for (let s = 0; s <= 4; s++) { pal(s / 8 + F.shift + R[5], c); grad.addColorStop(s / 4, rgba(c)); }
      ctx.fillStyle = grad;
      const I = R[7] * F.intensity * (0.8 + 1.4 * eAvg) * (1 + 0.25 * (F.pulse || 0));
      for (const [lo, hi, a] of BANDS) {
        ctx.globalAlpha = clamp01(a * I);
        ctx.beginPath();
        for (let j = 0; j <= S; j++) { const y = H * (1 - (YB[j] + HH[j] * lo)); if (j) ctx.lineTo(X[j], y); else ctx.moveTo(X[j], y); }
        for (let j = S; j >= 0; j--) ctx.lineTo(X[j], H * (1 - (YB[j] + HH[j] * hi)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = clamp01(0.4 * I);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2 * F.px;
      ctx.beginPath();
      for (let j = 0; j <= S; j++) { const y = H * (1 - YB[j]); if (j) ctx.lineTo(X[j], y); else ctx.moveTo(X[j], y); }
      ctx.stroke();
    }
    // blooms
    const M = F.model;
    for (let i = 0; i < M.bn; i++) {
      const x = M.bX[i] * W, y = (1 - M.bY[i]) * H, lv = M.bLevel[i], age = M.bAge[i];
      const col = [M.bRgb[i * 3], M.bRgb[i * 3 + 1], M.bRgb[i * 3 + 2]];
      if (lv > 0.01) {
        const ph = H * (0.24 + 0.66 * Math.pow(lv, 0.6)), pw = H * (0.008 + 0.014 * M.bVel[i]) * 3.2;
        const pg = ctx.createLinearGradient(0, y, 0, y - ph);
        const g0 = clamp01(0.45 * lv * M.bloomData[i * BLOOM_STRIDE + 10]);
        pg.addColorStop(0, rgba(col, g0)); pg.addColorStop(0.3, rgba(col, g0 * 0.45)); pg.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = pg;
        // three nested strips ≈ a soft gaussian cross-section
        for (const [wk, a] of [[1, 0.22], [0.5, 0.35], [0.2, 0.6]]) { ctx.globalAlpha = a; ctx.fillRect(x - pw * wk * 0.5, y - ph, pw * wk, ph); }
        ctx.globalAlpha = 1;
        const rc = H * (0.011 + 0.026 * M.bVel[i]) * (0.75 + 0.25 * lv) * 3.2;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, rc);
        rg.addColorStop(0, rgba([lerp(col[0], 1, 0.5), lerp(col[1], 1, 0.5), lerp(col[2], 1, 0.5)], clamp01(lv)));
        rg.addColorStop(0.35, rgba(col, 0.35 * lv)); rg.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(x - rc, y - rc, rc * 2, rc * 2);
      }
      const ra = Math.exp(-age * 1.7) * M.bRing[i];
      if (ra > 0.01) {
        const g = 1 - Math.exp(-age * 2.6), rr = (0.07 + 0.19 * M.bVel[i]) * g * H;
        ctx.globalAlpha = clamp01(ra * 0.8);
        ctx.strokeStyle = M.bCss[i];
        ctx.lineWidth = Math.max(1, (0.003 + 0.016 * g) * H * 0.8);
        ctx.beginPath(); ctx.ellipse(x, y, rr * 1.6 + 0.5, rr + 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // sparks
    const PD = M.partData;
    for (let j = 0; j < M.pn; j++) {
      const o = j * PART_STRIDE, s = PD[o + 2] * F.px;
      ctx.globalAlpha = clamp01(PD[o + 3]);
      ctx.fillStyle = M.pCss[j];
      ctx.fillRect(PD[o] * W - s / 2, (1 - PD[o + 1]) * H - s / 2, s, s);
    }
    // landscape
    if (F.landscape) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      pal(0.1 + F.shift, c);
      ctx.fillStyle = `rgb(${(8 + c[0] * 10 * F.intensity) | 0},${(10 + c[1] * 10 * F.intensity) | 0},${(20 + c[2] * 12 * F.intensity) | 0})`;
      ctx.fill(hillFar);
      ctx.fillStyle = '#030408';
      ctx.fill(hillNear);
    }
    ctx.globalAlpha = 1;
  }
  return { kind: 'canvas2d', hdr: false, resize, render, destroy: noop, maxDpr: 1.25 };
}

/* ═══════════════════════════════ createHeroVisualizer ═══════════════════════════════ */

export function createHeroVisualizer({
  analyser = null, analyserL = null, analyserR = null, getState = null,
  palette = 'aurora', renderer: prefer = 'auto', landscape = true,
} = {}) {
  const el = h('div', 'av-hero av-vis', { role: 'img', 'aria-label': '極光視覺化 Aurora visualizer' });
  let canvas = h('canvas', 'av-canvas', { 'aria-hidden': 'true' });
  el.appendChild(canvas);
  const src = { analyser, analyserL, analyserR, getState };
  const ana = new HeroAnalysis(NB);
  const model = new HeroModel();
  const keys = new KeyMap(el);
  model.xOf = keys.fn;
  model.colOf = keys.colFn;

  let palA = Math.max(0, PAL_NAMES.indexOf(palette)), palB = palA, palMix = 0;
  const cB = [0, 0, 0];
  const palSample = (u, out) => {
    paletteAt(PAL_NAMES[palA], u, out);
    if (palMix > 0) { paletteAt(PAL_NAMES[palB], u, cB); mixRgb(out, cB, palMix, out); }
    return out;
  };

  const F = {
    t: (Date.now() % 60000) / 1200, rt: 0, dt: 0, aspect: 1, px: 1, // start the drift at a varying phase
    loud: 0, low: 0, mid: 0, high: 0, centroid: 0.42, width: 0.35, balance: 0, idle: 1, pulse: 0, beat: 0,
    intensity: 0.5, shift: 0, bloom1: 0.4, bloom2: 0.32, exposure: 0.95,
    spec: ana.spec, bands: ana.blur, model, palA, palB, palMix, palSample, landscape,
  };

  let r = null;
  function makeRenderer() {
    if (prefer !== 'canvas2d') {
      try {
        r = createHeroGL(canvas);
        if (r) return;
      } catch (err) {
        console.warn('[visuals] WebGL2 hero unavailable, using Canvas2D:', err && err.message ? err.message.split('\n')[0] : err);
      }
      // a canvas that tried WebGL can't give a 2D context → swap in a fresh one
      const c2 = h('canvas', 'av-canvas', { 'aria-hidden': 'true' });
      el.replaceChild(c2, canvas);
      canvas = c2;
      bindLoss();
    }
    r = createHero2D(canvas);
    model.wantCss = true;
  }
  let lost = false;
  function bindLoss() {
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      lost = false;
      try { r = createHeroGL(canvas); sizeKey = ''; } catch { r = null; }
    });
  }
  bindLoss();
  makeRenderer();

  // sizing
  let cssW = 0, cssH = 0, sizeKey = '', resScale = 1;
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(es => { const cr = es[es.length - 1].contentRect; cssW = cr.width; cssH = cr.height; }) : null;
  if (ro) ro.observe(el);
  function syncSize() {
    if (!ro || cssW < 2 || cssH < 2) { cssW = el.clientWidth; cssH = el.clientHeight; }
    if (cssW < 2 || cssH < 2 || !r) return false;
    const dpr = Math.min(r.maxDpr, (HAS_DOM && window.devicePixelRatio) || 1) * resScale;
    let pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    const maxPx = 2.6e6;
    if (pw * ph > maxPx) { const k = Math.sqrt(maxPx / (pw * ph)); pw = Math.round(pw * k); ph = Math.round(ph * k); }
    const key = `${pw}x${ph}`;
    if (key !== sizeKey) {
      sizeKey = key;
      canvas.width = pw; canvas.height = ph;
      r.resize(pw, ph);
    }
    F.px = pw / cssW;
    F.aspect = pw / ph;
    return true;
  }

  // adaptive resolution. With GPU timer queries: keep the hero's GPU time ≲ 9 ms (scale down after
  // ~1 s over budget, back up after ~4 s comfortably under). Without them: only *irregular* long
  // frames count (GPU-bound at vsync alternates 16/33 ms), so a steady 30 fps cap is left alone.
  let slowT = 0, fastT = 0, lastDt = 1 / 60;
  function adapt(dt) {
    const g = r && r.gpuMs !== undefined ? r.gpuMs : -1;
    if (g >= 0) {
      if (g > 9 && resScale > 0.5) { slowT += dt; fastT = 0; if (slowT > 1) { resScale = Math.max(0.5, resScale - 0.15); slowT = 0; r.resetGpu(); } }
      else if (g < 3.5 && resScale < 1) { fastT += dt; slowT = 0; if (fastT > 4) { resScale = Math.min(1, resScale + 0.15); fastT = 0; r.resetGpu(); } }
      else { slowT = Math.max(0, slowT - dt); fastT = 0; }
      return;
    }
    const irregular = Math.abs(dt - lastDt) > 0.006;
    lastDt = dt;
    if (dt > 0.024 && dt < 0.09 && irregular) slowT += dt; else slowT = Math.max(0, slowT - dt * 0.5);
    if (slowT > 2 && resScale > 0.55) { resScale = Math.max(0.5, resScale - 0.15); slowT = 0; }
  }

  let t0 = 0;
  const entry = makeEntry('hero', (ts, dt) => {
    if (!entry.visible || lost || !r) return;
    if (!syncSize()) return;
    adapt(dt);
    const motion = reducedMotion() ? 0.35 : 1;
    if (!t0) t0 = ts;
    const st = safeState(src.getState);
    ana.update(src, dt, st);
    // palette crossfade
    if (palB !== palA) {
      palMix = Math.min(1, palMix + dt / 1.0);
      if (palMix >= 1) { palA = palB; palMix = 0; }
    }
    F.palA = palA; F.palB = palB; F.palMix = palMix;
    const loud = ana.loud;
    F.dt = dt;
    F.rt = ts - t0;
    F.t += dt * (0.55 + 0.75 * loud) * motion;
    F.loud = loud; F.low = ana.low; F.mid = ana.mid; F.high = clamp01(ana.high * 1.6);
    F.centroid = ana.centroid; F.width = ana.width; F.balance = ana.balance; F.beat = ana.pulse;
    F.idle = 1 - smoothstep(0.03, 0.3, loud);
    keys.refresh(ts * 1000);
    model.update(dt, F.rt, st && st.voices, palSample, F.aspect, motion, F.idle);
    // one "pulse" drives the horizon flash, curtain surge and star twinkle: sequencer/arp beats,
    // audio onsets and note-on strikes (whichever is strongest); gentler under reduced motion
    const kick = Math.min(1, model.kick * 0.8);
    F.pulse = Math.max(ana.pulse * 0.55 * loud, ana.onset * (0.35 + 0.65 * loud), kick) * (motion < 1 ? 0.4 : 1);
    F.intensity = 0.5 + 0.5 * loud + 0.08 * ana.pulse * loud;
    F.shift = (ana.centroid - 0.42) * 0.8 + 0.05 * Math.sin(F.rt * 0.021);
    F.bloom1 = 0.4 + 0.3 * loud + 0.12 * F.pulse;
    F.bloom2 = 0.32 + 0.25 * loud;
    r.render(F);
  });
  const unobserve = observeVisibility(el, entry);
  let running = false;

  return {
    el,
    start() { if (!running) { running = true; tickerAdd(entry); } },
    stop() { running = false; tickerRemove(entry); },
    /** 'aurora' | 'sunset' | 'ocean' | 'mono' | 'borealis' | 'nebula' — crossfades over ~1 s. */
    setPalette(name) {
      const i = PAL_NAMES.indexOf(name);
      if (i < 0) { console.warn(`[visuals] unknown palette "${name}" (${PAL_NAMES.join(', ')})`); return; }
      if (palB !== palA && palMix > 0.5) palA = palB; // mid-fade: continue from the nearer palette
      palB = i;
      palMix = 0;
    },
    /** Late-bind audio sources (e.g. after the AudioContext is created on first user gesture). */
    setSources(s = {}) { for (const k of ['analyser', 'analyserL', 'analyserR', 'getState']) if (k in s) src[k] = s[k]; },
    get renderer() { return r ? r.kind : 'none'; },
    get hdr() { return !!(r && r.hdr); },
    get palettes() { return PAL_NAMES.slice(); },
    destroy() { this.stop(); unobserve(); if (ro) ro.disconnect(); if (r) r.destroy(); r = null; },
    /** Internal state (debugging / tests). */
    _debug: { ana, model, F, get resScale() { return resScale; }, get gpuMs() { return r && r.gpuMs !== undefined ? r.gpuMs : -1; }, tick: (ts, dt) => entry.fn(ts, dt) },
  };
}

/* ═══════════════════════════════ createScope ═══════════════════════════════ */

/**
 * Trigger search: rising zero crossings (with hysteresis) of a low-passed mono signal inside
 * [1, N - win); among ≤ maxCand candidates choose the one whose following window best matches the
 * previously displayed window (similarity triggering) → rock-steady display of complex waves.
 * Returns the fractional start index.
 */
function findTrigger(mono, lp, N, win, prev, prevValid, maxCand = 32) {
  const lim = N - win - 1;
  if (lim < 2) return 0;
  let pk = 0;
  for (let i = 0; i < N; i++) { const a = lp[i] < 0 ? -lp[i] : lp[i]; if (a > pk) pk = a; }
  if (pk < 1e-6) return 0;
  const hyst = pk * 0.08;
  let armed = false, best = -1, bestErr = Infinity, cands = 0, first = -1;
  for (let i = 1; i < lim && cands < maxCand; i++) {
    const a = lp[i - 1], b = lp[i];
    if (a < -hyst) armed = true;
    if (armed && a < 0 && b >= 0) {
      armed = false;
      cands++;
      const pos = i - 1 + a / (a - b);
      if (first < 0) first = pos;
      if (!prevValid) break;
      let err = 0;
      const i0 = pos | 0, fr = pos - i0;
      for (let j = 0; j < win; j += 4) {
        const k = i0 + j, v = mono[k] + (mono[k + 1] - mono[k]) * fr;
        const d = v - prev[j];
        err += d < 0 ? -d : d;
        if (err >= bestErr) break;
      }
      if (err < bestErr) { bestErr = err; best = pos; }
    }
  }
  return best >= 0 ? best : first >= 0 ? first : 0;
}

export function createScope({ analyserL = null, analyserR = null, analyser = null, mode = 'wave', toggle = true, window: winSec = 0.024 } = {}) {
  const el = h('div', 'av-scope av-vis');
  const surf = new Surface(el, 2);
  const src = { L: analyserL || analyser, R: analyserR || analyserL || analyser };
  let tok = null;
  let mono = new Float32Array(0), lp = new Float32Array(0), prev = new Float32Array(0), prevValid = false;
  let gain = 1, pkS = 0, silentT = 0;
  let chip = null, chipW = null, chipX = null;

  function setMode(m) {
    mode = m === 'lissajous' || m === 'xy' ? 'lissajous' : 'wave';
    el.dataset.mode = mode;
    prevValid = false;
    if (chip) { chipW.classList.toggle('on', mode === 'wave'); chipX.classList.toggle('on', mode !== 'wave'); chip.setAttribute('aria-label', mode === 'wave' ? '示波器 Waveform' : '李薩如 Lissajous'); }
    if (surf.ok && tok) { drawGrid(); surf.ctx[1].clearRect(0, 0, surf.pw, surf.ph); }
  }
  if (toggle) {
    chip = h('button', 'av-chip', { type: 'button', title: '切換 波形 / XY  Toggle waveform / lissajous' });
    chipW = h('span', null, null, 'WAVE'); chipX = h('span', null, null, 'XY');
    chip.append(chipW, chipX);
    chip.addEventListener('click', () => setMode(mode === 'wave' ? 'lissajous' : 'wave'));
    el.appendChild(chip);
  }

  function drawGrid() {
    const g = surf.ctx[0], W = surf.pw, H = surf.ph, d = surf.dpr;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    if (mode === 'wave') {
      g.strokeStyle = rgba(tok.line, 0.32);
      g.beginPath();
      for (let i = 1; i < 8; i++) { const x = Math.round((i * W) / 8) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
      for (let i = 1; i < 4; i++) { if (i === 2) continue; const y = Math.round((i * H) / 4) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
      g.strokeStyle = rgba(tok.dim, 0.28);
      g.beginPath(); g.moveTo(0, Math.round(H / 2) + 0.5); g.lineTo(W, Math.round(H / 2) + 0.5); g.stroke();
    } else {
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.45;
      g.strokeStyle = rgba(tok.line, 0.6);
      g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(cx, cy, R * 0.5, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = rgba(tok.dim, 0.22);
      g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.stroke();
      g.setLineDash([2 * d, 4 * d]);
      const k = R * Math.SQRT1_2;
      g.beginPath(); g.moveTo(cx - k, cy - k); g.lineTo(cx + k, cy + k); g.moveTo(cx + k, cy - k); g.lineTo(cx - k, cy + k); g.stroke();
      g.setLineDash([]);
      g.fillStyle = rgba(tok.faint, 0.9);
      g.font = `600 ${10 * d}px ${tok.mono}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('L', cx - k - 7 * d, cy - k - 7 * d);
      g.fillText('R', cx + k + 7 * d, cy - k - 7 * d);
      g.fillText('M', cx, cy - R - 7 * d > 5 * d ? cy - R - 7 * d : cy - R + 8 * d);
    }
  }

  function stroke(ctx, path, col, widths, alphas) {
    for (let i = 0; i < widths.length; i++) {
      ctx.lineWidth = widths[i];
      ctx.strokeStyle = rgba(col, alphas[i]);
      ctx.stroke(path);
    }
  }

  const entry = makeEntry('scope', (ts, dt) => {
    if (!entry.visible) return;
    const resized = surf.sync();
    if (!surf.ok) return;
    if (resized || !tok) { tok = readTokens(el); drawGrid(); }
    const ctx = surf.ctx[1], W = surf.pw, H = surf.ph, d = surf.dpr;
    // phosphor persistence: fade what's there instead of clearing
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${mode === 'wave' ? 0.5 : 0.2})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (!src.L) { silentT += dt; return; }
    const L = readTime(src.L), R = src.R && src.R !== src.L ? readTime(src.R) : L;
    const N = Math.min(L.length, R.length);
    if (mono.length !== N) { mono = new Float32Array(N); lp = new Float32Array(N); prevValid = false; }
    let pk = 0;
    for (let i = 0; i < N; i++) { const m = 0.5 * (L[i] + R[i]); mono[i] = m; const a = Math.abs(L[i]) > Math.abs(R[i]) ? Math.abs(L[i]) : Math.abs(R[i]); if (a > pk) pk = a; }
    pkS = Math.max(pk, pkS * Math.exp(-dt / 0.8));
    const gT = clamp(0.8 / Math.max(pkS, 1e-4), 1, 8);
    gain += (gT - gain) * follow(dt, gT < gain ? 0.08 : 0.5);
    if (pk < 1e-4) { silentT += dt; if (silentT > 1.5) ctx.clearRect(0, 0, W, H); return; }
    silentT = 0;

    if (mode === 'wave') {
      const sr = anRate(src.L);
      const win = Math.max(64, Math.min(N >> 1, Math.round(sr * winSec)));
      const a = 1 - Math.exp((-2 * Math.PI * 900) / sr);
      let y = 0;
      for (let i = 0; i < N; i++) { y += (mono[i] - y) * a; lp[i] = y; }
      if (prev.length !== win) { prev = new Float32Array(win); prevValid = false; }
      const start = findTrigger(mono, lp, N, win, prev, prevValid);
      const i0 = start | 0, fr = start - i0;
      for (let j = 0; j < win; j++) { const k = Math.min(N - 2, i0 + j); prev[j] = mono[k] + (mono[k + 1] - mono[k]) * fr; }
      prevValid = true;
      const amp = H * 0.44 * gain, cy = H / 2, sx = W / (win - 1);
      const stereo = R !== L;
      const chans = stereo ? [[L, tok.cyan], [R, tok.pink]] : [[L, tok.cyan]];
      for (const [buf, col] of chans) {
        const p = new Path2D();
        for (let j = 0; j < win; j++) {
          const k = Math.min(N - 2, i0 + j), v = buf[k] + (buf[k + 1] - buf[k]) * fr;
          const x = j * sx, yy = cy - v * amp;
          if (j) p.lineTo(x, yy); else p.moveTo(x, yy);
        }
        stroke(ctx, p, col, [7 * d, 3 * d, 1.25 * d], stereo ? [0.06, 0.16, 0.8] : [0.08, 0.2, 0.95]);
      }
    } else {
      const cx = W / 2, cy = H / 2, s = Math.min(W, H) * 0.45 * Math.SQRT1_2 * Math.min(gain, 6);
      const p = new Path2D();
      for (let i = 0; i < N; i++) {
        const x = cx + (R[i] - L[i]) * s, y = cy - (L[i] + R[i]) * s;
        if (i) p.lineTo(x, y); else p.moveTo(x, y);
      }
      stroke(ctx, p, tok.violet, [5 * d], [0.05]);
      stroke(ctx, p, tok.cyan, [1.1 * d], [0.5]);
    }
  });
  const unobserve = observeVisibility(el, entry);
  setMode(mode);
  let running = false;
  return {
    el,
    start() { if (!running) { running = true; tickerAdd(entry); } },
    stop() { running = false; tickerRemove(entry); },
    setMode,
    get mode() { return mode; },
    setSources(s = {}) { if (s.analyserL || s.analyser) src.L = s.analyserL || s.analyser; if (s.analyserR || s.analyserL || s.analyser) src.R = s.analyserR || s.analyserL || s.analyser; prevValid = false; },
    destroy() { this.stop(); unobserve(); surf.destroy(); },
  };
}

/* ═══════════════════════════════ createSpectrum ═══════════════════════════════ */

const SPEC_GRID = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000];
const SPEC_LABELS = { 100: '100', 1000: '1k', 10000: '10k' };

export function createSpectrum({ analyser = null, fMin = 20, fMax = 20000, dbMin = -100, dbMax = -8, tilt = 3, peakHold = true } = {}) {
  const el = h('div', 'av-spectrum av-vis');
  const surf = new Surface(el, 2);
  const src = { an: analyser };
  let tok = null, map = null, n = 0;
  let cur = null, pk = null, pkT = null, xs = null, ys = null, tl = null;
  let gradH = null, gradMask = null, gradLine = null;
  const lx = f => Math.log(f / fMin) / Math.log(fMax / fMin);

  function layout() {
    n = clamp(Math.round(surf.w / 3), 48, 256);
    map = new BandMap(n, fMin, fMax);
    cur = new Float32Array(n).fill(-160); pk = new Float32Array(n).fill(-160); pkT = new Float32Array(n);
    xs = new Float32Array(n); ys = new Float32Array(n); tl = new Float32Array(n);
    for (let k = 0; k < n; k++) { xs[k] = map.x[k] * surf.pw; tl[k] = tilt * Math.log2(map.f[k] / 1000); }
    const g = surf.ctx[1], W = surf.pw, H = surf.ph;
    gradH = g.createLinearGradient(0, 0, W, 0);
    gradH.addColorStop(0, rgba(tok.teal)); gradH.addColorStop(0.3, rgba(tok.cyan)); gradH.addColorStop(0.65, rgba(tok.violet)); gradH.addColorStop(1, rgba(tok.pink));
    gradLine = gradH;
    gradMask = g.createLinearGradient(0, 0, 0, H);
    gradMask.addColorStop(0, 'rgba(0,0,0,0.62)'); gradMask.addColorStop(0.55, 'rgba(0,0,0,0.24)'); gradMask.addColorStop(1, 'rgba(0,0,0,0.02)');
    drawGrid();
  }
  function yOf(db) { const H = surf.ph; return H - clamp01((db - dbMin) / (dbMax - dbMin)) * (H - 6 * surf.dpr) - 1; }
  function drawGrid() {
    const g = surf.ctx[0], W = surf.pw, H = surf.ph, d = surf.dpr;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    for (const f of SPEC_GRID) {
      if (f < fMin || f > fMax) continue;
      const major = f in SPEC_LABELS, x = Math.round(lx(f) * W) + 0.5;
      g.strokeStyle = rgba(major ? tok.dim : tok.line, major ? 0.22 : 0.26);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    g.strokeStyle = rgba(tok.line, 0.24);
    g.beginPath();
    for (let db = Math.ceil(dbMax / 12) * 12; db > dbMin; db -= 12) { const y = Math.round(yOf(db)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.font = `500 ${10 * d}px ${tok.mono}`;
    g.fillStyle = rgba(tok.faint, 1);
    g.textBaseline = 'bottom';
    for (const f in SPEC_LABELS) {
      const x = lx(+f) * W;
      g.textAlign = 'left';
      g.fillText(SPEC_LABELS[f], x + 3 * d, H - 3 * d);
    }
  }
  function curve(path, ys2) {
    path.moveTo(0, ys2[0]);
    path.lineTo(xs[0], ys2[0]);
    for (let k = 0; k < n - 1; k++) {
      const mx = (xs[k] + xs[k + 1]) * 0.5, my = (ys2[k] + ys2[k + 1]) * 0.5;
      path.quadraticCurveTo(xs[k], ys2[k], mx, my);
    }
    path.lineTo(xs[n - 1], ys2[n - 1]);
    path.lineTo(surf.pw, ys2[n - 1]);
  }
  const tmpDb = { a: null };
  const peakY = { a: null };

  const entry = makeEntry('spectrum', (ts, dt) => {
    if (!entry.visible) return;
    const resized = surf.sync();
    if (!surf.ok) return;
    if (resized || !tok) { tok = readTokens(el); layout(); }
    const ctx = surf.ctx[1], W = surf.pw, H = surf.ph, d = surf.dpr;
    if (!tmpDb.a || tmpDb.a.length !== n) { tmpDb.a = new Float32Array(n); peakY.a = new Float32Array(n); }
    const raw = tmpDb.a;
    if (src.an) { const db = readFreq(src.an); map.configure(db.length, anRate(src.an)); map.map(db, raw); } else raw.fill(-160);
    const aA = follow(dt, 0.012), aR = follow(dt, 0.2);
    let any = false;
    for (let k = 0; k < n; k++) {
      const v = raw[k] + tl[k], c = cur[k];
      cur[k] = c + (v - c) * (v > c ? aA : aR);
      if (cur[k] > dbMin) any = true;
      if (cur[k] >= pk[k]) { pk[k] = cur[k]; pkT[k] = 0.9; } else if (pkT[k] > 0) pkT[k] -= dt; else pk[k] = Math.max(cur[k], pk[k] - 22 * dt);
      ys[k] = yOf(cur[k]);
      peakY.a[k] = yOf(pk[k]);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    if (!any) return;
    const line = new Path2D();
    curve(line, ys);
    const fill = new Path2D(line);
    fill.lineTo(W, H); fill.lineTo(0, H); fill.closePath();
    ctx.fillStyle = gradH;
    ctx.fill(fill);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = gradMask;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = gradLine;
    ctx.globalAlpha = 0.18; ctx.lineWidth = 6 * d; ctx.stroke(line);
    ctx.globalAlpha = 0.95; ctx.lineWidth = 1.5 * d; ctx.stroke(line);
    ctx.globalAlpha = 1;
    if (peakHold) {
      const pp = new Path2D();
      curve(pp, peakY.a);
      ctx.strokeStyle = rgba(tok.text, 0.3);
      ctx.lineWidth = 1 * d;
      ctx.stroke(pp);
    }
  });
  const unobserve = observeVisibility(el, entry);
  let running = false;
  return {
    el,
    start() { if (!running) { running = true; tickerAdd(entry); } },
    stop() { running = false; tickerRemove(entry); },
    setSources(s = {}) { if (s.analyser) src.an = s.analyser; },
    destroy() { this.stop(); unobserve(); surf.destroy(); },
  };
}

/* ═══════════════════════════════ createFilterView ═══════════════════════════════ */

let _frPromise = null;
function loadFilterResponse() {
  if (!_frPromise) _frPromise = import('../dsp/filter.js').then(m => m.filterResponse);
  return _frPromise;
}
const FILTER_OPTS = PARAM_BY_ID['filter.type'] ? PARAM_BY_ID['filter.type'].options : ['ladder24', 'ladder12', 'lp', 'bp', 'hp', 'notch', 'formant', 'comb'];
const FILTER_LABELS = PARAM_BY_ID['filter.type'] ? PARAM_BY_ID['filter.type'].labels : FILTER_OPTS;
const fmtHz = v => (PARAM_BY_ID['filter.cutoff'] ? formatValue(PARAM_BY_ID['filter.cutoff'], v) : `${Math.round(v)} Hz`);

export function createFilterView({
  getParams = null, filterResponse = null, sampleRate = 48000, accent = null,
  dbMin = -42, dbMax = 24, points = 300, labels = true,
} = {}) {
  const el = h('div', 'av-filter av-vis');
  const surf = new Surface(el, 2);
  let fr = typeof filterResponse === 'function' ? filterResponse : null;
  let dirty = true, tok = null;
  if (!fr) loadFilterResponse().then(f => { fr = f; dirty = true; if (!running) render(); }).catch(err => console.warn('[visuals] filterResponse unavailable:', err));
  const fMin = 20, fMax = 20000;
  const freqs = new Float32Array(points);
  for (let i = 0; i < points; i++) freqs[i] = fMin * Math.pow(fMax / fMin, i / (points - 1));
  const disp = new Float32Array(points), from = new Float32Array(points);
  const tgt = { type: 0, lc: Math.log2(8000), res: 0.1, drive: 0, vowel: 0, on: true };
  const cur = { ...tgt };
  let xf = 1, have = false, curOn = 1;

  function read() {
    let p = null;
    try { p = getParams ? getParams() : null; } catch { p = null; }
    p = p || {};
    let ty = p.type;
    if (typeof ty === 'string') ty = Math.max(0, FILTER_OPTS.indexOf(ty));
    ty = clamp(Math.round(finite(ty, 0)), 0, FILTER_OPTS.length - 1);
    const lc = Math.log2(clamp(finite(p.cutoff, 8000), 20, 20000));
    const res = clamp01(finite(p.res, 0.1)), drive = clamp01(finite(p.drive, 0)), vowel = clamp01(finite(p.vowel, 0));
    const on = p.on !== false && p.on !== 0;
    if (ty !== tgt.type || lc !== tgt.lc || res !== tgt.res || drive !== tgt.drive || vowel !== tgt.vowel || on !== tgt.on) {
      if (ty !== tgt.type && have) { from.set(disp); xf = 0; }
      Object.assign(tgt, { type: ty, lc, res, drive, vowel, on });
      dirty = true;
      if (!have) { Object.assign(cur, tgt); curOn = on ? 1 : 0; }
    }
  }

  function step(dt) {
    const k = follow(dt, 0.07);
    let moving = false;
    for (const key of ['lc', 'res', 'drive', 'vowel']) {
      const dlt = tgt[key] - cur[key];
      if (Math.abs(dlt) > (key === 'lc' ? 0.002 : 0.0008)) { cur[key] += dlt * k; moving = true; } else cur[key] = tgt[key];
    }
    const onT = tgt.on ? 1 : 0;
    if (Math.abs(onT - curOn) > 0.002) { curOn += (onT - curOn) * follow(dt, 0.08); moving = true; } else curOn = onT;
    if (xf < 1) { xf = Math.min(1, xf + dt / 0.22); moving = true; }
    return moving;
  }

  const xOf = f => (Math.log(f / fMin) / Math.log(fMax / fMin)) * surf.pw;
  const yOf = db => { const H = surf.ph, top = 14 * surf.dpr, bot = 4 * surf.dpr; return top + (1 - (clamp(db, dbMin - 30, dbMax + 30) - dbMin) / (dbMax - dbMin)) * (H - top - bot); };

  function drawGrid() {
    const g = surf.ctx[0], W = surf.pw, H = surf.ph, d = surf.dpr;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    g.strokeStyle = rgba(tok.line, 0.45);
    g.beginPath();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f)) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
    for (let db = Math.ceil(dbMax / 12) * 12; db >= dbMin; db -= 12) { if (db === 0) continue; const y = Math.round(yOf(db)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.strokeStyle = rgba(tok.dim, 0.3);
    g.beginPath(); const y0 = Math.round(yOf(0)) + 0.5; g.moveTo(0, y0); g.lineTo(W, y0); g.stroke();
    if (labels) {
      g.font = `500 ${10 * d}px ${tok.mono}`;
      g.fillStyle = rgba(tok.faint, 1);
      g.textBaseline = 'bottom'; g.textAlign = 'left';
      for (const [f, s] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(s, xOf(f) + 3 * d, H - 3 * d);
    }
  }

  function render() {
    if (!surf.ok || !tok) return;
    const ctx = surf.ctx[1], W = surf.pw, H = surf.ph, d = surf.dpr;
    ctx.clearRect(0, 0, W, H);
    if (!fr) return;
    const cutoff = Math.pow(2, cur.lc);
    let resp;
    try { resp = fr(tgt.type, cutoff, cur.res, cur.drive, cur.vowel, freqs, sampleRate); } catch (err) { console.warn('[visuals] filterResponse threw:', err); return; }
    have = true;
    const e = xf < 1 ? xf * xf * (3 - 2 * xf) : 1;
    for (let i = 0; i < points; i++) {
      let v = finite(resp[i], -120);
      if (e < 1) v = lerp(from[i], v, e);
      disp[i] = lerp(0, v, curOn);  // bypass → flat
    }
    const acc = tok.accent;
    const path = new Path2D();
    for (let i = 0; i < points; i++) { const x = (i / (points - 1)) * W, y = yOf(disp[i]); if (i) path.lineTo(x, y); else path.moveTo(x, y); }
    const fill = new Path2D(path);
    fill.lineTo(W, H); fill.lineTo(0, H); fill.closePath();
    const fg = ctx.createLinearGradient(0, yOf(dbMax), 0, H);
    fg.addColorStop(0, rgba(acc, 0.42)); fg.addColorStop(0.5, rgba(acc, 0.14)); fg.addColorStop(1, rgba(acc, 0.02));
    const dim = 0.35 + 0.65 * curOn;
    ctx.globalAlpha = dim;
    ctx.fillStyle = fg;
    ctx.fill(fill);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(acc, 0.16); ctx.lineWidth = 7 * d; ctx.stroke(path);
    ctx.strokeStyle = rgba(acc, 0.35); ctx.lineWidth = 3 * d; ctx.stroke(path);
    ctx.strokeStyle = rgba(mixRgb(acc, [1, 1, 1], 0.35), 0.95); ctx.lineWidth = 1.5 * d; ctx.stroke(path);
    // cutoff marker
    const xc = xOf(cutoff);
    const fi = (Math.log(cutoff / fMin) / Math.log(fMax / fMin)) * (points - 1), i0 = clamp(Math.floor(fi), 0, points - 2);
    const yc = clamp(yOf(lerp(disp[i0], disp[i0 + 1], fi - i0)), 16 * d, H - 5 * d);
    const mg = ctx.createLinearGradient(0, yc, 0, H);
    mg.addColorStop(0, rgba(acc, 0.5)); mg.addColorStop(1, rgba(acc, 0));
    ctx.strokeStyle = mg; ctx.lineWidth = 1 * d;
    ctx.beginPath(); ctx.moveTo(xc, yc); ctx.lineTo(xc, H); ctx.stroke();
    const rg = ctx.createRadialGradient(xc, yc, 0, xc, yc, 11 * d);
    rg.addColorStop(0, rgba(acc, 0.6)); rg.addColorStop(1, rgba(acc, 0));
    ctx.fillStyle = rg; ctx.fillRect(xc - 11 * d, yc - 11 * d, 22 * d, 22 * d);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(xc, yc, 3 * d, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(acc, 1); ctx.lineWidth = 1.5 * d; ctx.stroke();
    if (labels) {
      ctx.font = `600 ${10.5 * d}px ${tok.mono}`;
      ctx.textBaseline = 'top';
      const txt = fmtHz(cutoff), tw = ctx.measureText(txt).width;
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(tok.text, 0.85);
      ctx.fillText(txt, clamp(xc - tw / 2, 4 * d, W - tw - 4 * d), 3 * d);
      ctx.fillStyle = rgba(tok.faint, 1);
      ctx.font = `600 ${10 * d}px ${tok.ui}`;
      ctx.fillText(String(FILTER_LABELS[tgt.type] || '').toUpperCase(), 5 * d, 3 * d + 12 * d > H * 0.5 ? 3 * d : 3 * d + 12 * d);
    }
    ctx.globalAlpha = 1;
  }

  function tick(dt) {
    const resized = surf.sync();
    if (!surf.ok) return;
    if (resized || !tok) { tok = readTokens(el, accent, '--a-violet'); drawGrid(); dirty = true; }
    read();
    const moving = step(dt);
    if (moving || dirty) { dirty = false; render(); }
  }
  const entry = makeEntry('filter', (ts, dt) => { if (entry.visible) tick(dt); });
  const unobserve = observeVisibility(el, entry);
  let running = false;
  const api = {
    el,
    /** Re-read getParams() now (the view also polls every frame while visible and animates toward changes). */
    update() {
      read();
      if (running && entry.visible) { dirty = true; return; }
      // not animating (stopped / hidden): jump straight to the new response
      Object.assign(cur, tgt); curOn = tgt.on ? 1 : 0; xf = 1;
      const resized = surf.sync();
      if (surf.ok && (resized || !tok)) { tok = readTokens(el, accent, '--a-violet'); drawGrid(); }
      render();
    },
    start() { if (!running) { running = true; tickerAdd(entry); } },
    stop() { running = false; tickerRemove(entry); },
    destroy() { api.stop(); unobserve(); surf.destroy(); },
  };
  api.start();
  return api;
}

/* ═══════════════════════════════ createLfoView ═══════════════════════════════ */

const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square', 'sh', 'smooth'];
const LFO_LABELS = PARAM_BY_ID['lfo1.shape'] ? PARAM_BY_ID['lfo1.shape'].labels : LFO_SHAPES;
const SYNC_OPTS = PARAM_BY_ID['lfo1.sync'] ? PARAM_BY_ID['lfo1.sync'].options : ['off'];

/** LFO shape value (matches dsp/lfo.js). rnd: per-cycle random values (−1..1), ci: cycle index. */
function lfoValue(shape, p, rnd, ci) {
  switch (shape) {
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 2: return 2 * p - 1;
    case 3: return 1 - 2 * p;
    case 4: return p < 0.5 ? 1 : -1;
    case 5: return rnd[ci + 1];
    case 6: {
      const rm1 = rnd[ci], r0 = rnd[ci + 1], r1 = rnd[ci + 2], r2 = rnd[ci + 3];
      const c1 = 0.5 * (r1 - rm1), c2 = rm1 - 2.5 * r0 + 2 * r1 - 0.5 * r2, c3 = 0.5 * (r2 - rm1) + 1.5 * (r0 - r1);
      return clamp(((c3 * p + c2) * p + c1) * p + r0, -1, 1);
    }
    default: return 0;
  }
}

export function createLfoView({ getParams = null, accent = null, labels = true } = {}) {
  const el = h('div', 'av-lfo av-vis');
  const surf = new Surface(el, 2);
  let tok = null, shape = 0, rateHz = 2, label = '', phase0 = 0, sig = '', ph = 0, dirty = true;
  const rng = new Rng(0x1f0);
  const RND = 8;
  const rnd = new Float32Array(RND);
  for (let i = 0; i < RND; i++) rnd[i] = rng.bipolar();

  function read() {
    let p = null;
    try { p = getParams ? getParams() : null; } catch { p = null; }
    p = p || {};
    let s = p.shape;
    if (typeof s === 'string') s = Math.max(0, LFO_SHAPES.indexOf(s));
    s = clamp(Math.round(finite(s, 0)), 0, 6);
    let sync = p.sync;
    if (typeof sync === 'number') sync = SYNC_OPTS[clamp(Math.round(sync), 0, SYNC_OPTS.length - 1)];
    const bpm = clamp(finite(p.bpm, 110), 20, 400);
    const beats = sync && sync !== 'off' ? divToBeats(sync) : 0;
    const rate = beats > 0 ? bpm / 60 / beats : clamp(finite(p.rate, 2), 0.001, 100);
    const lab = beats > 0 ? `${sync} · ${rate.toFixed(rate < 10 ? 2 : 1)} Hz` : (PARAM_BY_ID['lfo1.rate'] ? formatValue(PARAM_BY_ID['lfo1.rate'], rate) : `${rate.toFixed(2)} Hz`);
    const p0 = clamp01(finite(p.phase, 0));
    const key = `${s}|${lab}|${p0}`;
    if (key !== sig) { sig = key; shape = s; rateHz = rate; label = lab; phase0 = p0; dirty = true; }
    if (Number.isFinite(p.phaseNow)) ph = p.phaseNow - Math.floor(p.phaseNow);
    return p;
  }
  const cycles = () => (shape >= 5 ? 4 : 1);
  const X0 = () => 6 * surf.dpr;
  const plotW = () => surf.pw - 12 * surf.dpr;
  const yOf = v => { const H = surf.ph, top = (labels ? 18 : 8) * surf.dpr, bot = 8 * surf.dpr; return top + (1 - (v + 1) / 2) * (H - top - bot); };
  function valueAt(u) {
    const cyc = cycles(), x = u * cyc, ci = Math.min(cyc - 1, Math.floor(x));
    return lfoValue(shape, x - ci, rnd, ci);
  }

  function drawCurve() {
    const g = surf.ctx[0], W = surf.pw, H = surf.ph, d = surf.dpr, acc = tok.accent;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    g.strokeStyle = rgba(tok.line, 0.5);
    g.beginPath();
    const y0 = Math.round(yOf(0)) + 0.5;
    g.moveTo(0, y0); g.lineTo(W, y0);
    const cyc = cycles();
    for (let i = 1; i < 4 * cyc; i++) { const x = Math.round(X0() + (i / (4 * cyc)) * plotW()) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
    g.stroke();
    const n = Math.max(64, Math.round(plotW() / (1.5 * d)));
    const path = new Path2D();
    const jumpy = shape >= 2 && shape <= 5;
    let vPrev = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = valueAt(u);
      const x = X0() + u * plotW(), y = yOf(v);
      if (!i) path.moveTo(x, y);
      else {
        // discontinuous shapes: vertical edge exactly at the jump
        if (jumpy && Math.abs(v - vPrev) > 0.25) path.lineTo(x, yOf(vPrev));
        path.lineTo(x, y);
      }
      vPrev = v;
    }
    const fill = new Path2D(path);
    fill.lineTo(X0() + plotW(), yOf(0)); fill.lineTo(X0(), yOf(0)); fill.closePath();
    const fg = g.createLinearGradient(0, yOf(1), 0, yOf(-1));
    fg.addColorStop(0, rgba(acc, 0.3)); fg.addColorStop(0.5, rgba(acc, 0.03)); fg.addColorStop(1, rgba(acc, 0.3));
    g.fillStyle = fg; g.fill(fill);
    g.lineJoin = 'round';
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = rgba(acc, 0.15); g.lineWidth = 6 * d; g.stroke(path);
    g.strokeStyle = rgba(mixRgb(acc, [1, 1, 1], 0.25), 0.95); g.lineWidth = 1.5 * d; g.stroke(path);
    g.globalCompositeOperation = 'source-over';
    // start-phase tick
    if (phase0 > 0 && shape < 5) {
      const x = X0() + phase0 * plotW();
      g.strokeStyle = rgba(tok.dim, 0.6); g.setLineDash([2 * d, 3 * d]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
    }
    if (labels) {
      g.font = `600 ${10 * d}px ${tok.ui}`;
      g.fillStyle = rgba(tok.faint, 1);
      g.textBaseline = 'top'; g.textAlign = 'left';
      g.fillText(String(LFO_LABELS[shape] || '').toUpperCase(), 5 * d, 3 * d);
      g.font = `600 ${10 * d}px ${tok.mono}`;
      g.fillStyle = rgba(tok.text, 0.8);
      g.textAlign = 'right';
      g.fillText(label, W - 5 * d, 3 * d);
    }
  }

  function drawDot() {
    const ctx = surf.ctx[1], W = surf.pw, H = surf.ph, d = surf.dpr, acc = tok.accent;
    ctx.clearRect(0, 0, W, H);
    const cyc = cycles();
    const u = ph;
    // comet trail behind the dot
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const segs = 16, span = Math.min(0.18, 0.5 / cyc + 0.05);
    for (let i = 0; i < segs; i++) {
      const ua = u - span * (1 - i / segs), ub = u - span * (1 - (i + 1) / segs);
      if (ub < 0) continue;
      const a = Math.max(0, ua);
      ctx.strokeStyle = rgba(acc, 0.5 * ((i + 1) / segs) ** 2);
      ctx.lineWidth = (1 + 3 * (i / segs)) * d;
      ctx.beginPath();
      ctx.moveTo(X0() + a * plotW(), yOf(valueAt(a)));
      ctx.lineTo(X0() + ub * plotW(), yOf(valueAt(ub)));
      ctx.stroke();
    }
    const x = X0() + u * plotW(), y = yOf(valueAt(u));
    const rg = ctx.createRadialGradient(x, y, 0, x, y, 12 * d);
    rg.addColorStop(0, rgba(acc, 0.75)); rg.addColorStop(1, rgba(acc, 0));
    ctx.fillStyle = rg; ctx.fillRect(x - 12 * d, y - 12 * d, 24 * d, 24 * d);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, 2.8 * d, 0, Math.PI * 2); ctx.fill();
  }

  let external = false;
  function tick(dt) {
    const resized = surf.sync();
    if (!surf.ok) return;
    if (resized || !tok) { tok = readTokens(el, accent, '--a-amber'); dirty = true; }
    const p = read();
    external = Number.isFinite(p.phaseNow);
    if (!external) {
      // displayed speed is capped so fast LFOs stay readable
      const cyc = cycles(), vis = Math.min(rateHz, 3) / cyc;
      ph += dt * vis * (reducedMotion() ? 0.5 : 1);
      if (ph >= 1) {
        ph -= Math.floor(ph);
        if (shape >= 5) { // new random values scroll in
          for (let i = 0; i < RND - 4; i++) rnd[i] = rnd[i + 4];
          for (let i = RND - 4; i < RND; i++) rnd[i] = rng.bipolar();
          dirty = true;
        }
      }
    }
    if (dirty) { dirty = false; drawCurve(); }
    drawDot();
  }
  const entry = makeEntry('lfo', (ts, dt) => { if (entry.visible) tick(dt); });
  const unobserve = observeVisibility(el, entry);
  let running = false;
  const api = {
    el,
    /** Re-read getParams() now (also polled every frame while visible). */
    update() { sig = ''; if (!running || !entry.visible) tick(0); },
    start() { if (!running) { running = true; tickerAdd(entry); } },
    stop() { running = false; tickerRemove(entry); },
    destroy() { api.stop(); unobserve(); surf.destroy(); },
  };
  api.start();
  return api;
}

/* ═══════════════════════════════ createMeter ═══════════════════════════════ */

/** Peak/RMS ballistics for one channel (dB). */
class MeterChannel {
  constructor() { this.pk = -120; this.rms = -120; this.hold = -120; this.holdT = 0; this.clipT = 0; this.rmsPow = 0; }
  update(peakLin, rmsLin, dt) {
    const p = toDb(Math.abs(finite(peakLin, 0)));
    if (p >= this.pk) this.pk = p; else this.pk = Math.max(p, this.pk - 22 * dt);
    const pw = finite(rmsLin, 0) ** 2;
    this.rmsPow += (pw - this.rmsPow) * follow(dt, 0.22);
    this.rms = toDb(Math.sqrt(this.rmsPow));
    if (this.pk >= this.hold) { this.hold = this.pk; this.holdT = 1.4; } else if (this.holdT > 0) this.holdT -= dt; else this.hold = Math.max(this.pk, this.hold - 16 * dt);
    if (p >= -0.3) this.clipT = 1.6; else if (this.clipT > 0) this.clipT -= dt;
    return this;
  }
}
/** dB → 0..1 meter position (more resolution near the top). */
const meterPos = (db, minDb = -60) => Math.pow(clamp01((db - minDb) / -minDb), 1.35);

export function createMeter({ getState = null, orientation = 'auto', minDb = -60, label = '輸出電平 Output level' } = {}) {
  const el = h('div', `av-meter av-vis${orientation === 'v' ? ' av-meter--v' : ''}`, { role: 'img', 'aria-label': label });
  const surf = new Surface(el, 1);
  const src = { getState };
  const ch = [new MeterChannel(), new MeterChannel()];
  let tok = null, grad = null, orient = 'h', lastKey = '';
  function layout() {
    orient = orientation === 'auto' ? (surf.w >= surf.h ? 'h' : 'v') : orientation;
    el.dataset.orient = orient;
    const ctx = surf.ctx[0], W = surf.pw, H = surf.ph;
    grad = orient === 'h' ? ctx.createLinearGradient(0, 0, W, 0) : ctx.createLinearGradient(0, H, 0, 0);
    const at = db => meterPos(db, minDb);
    grad.addColorStop(0, rgba(tok.teal, 0.9));
    grad.addColorStop(at(-18), rgba(tok.cyan, 1));
    grad.addColorStop(at(-9), rgba(tok.violet, 1));
    grad.addColorStop(at(-4), rgba(tok.amber, 1));
    grad.addColorStop(at(-1), rgba(tok.red, 1));
    grad.addColorStop(1, rgba(tok.red, 1));
    lastKey = '';
  }
  function draw() {
    const ctx = surf.ctx[0], W = surf.pw, H = surf.ph, d = surf.dpr;
    ctx.clearRect(0, 0, W, H);
    const led = Math.round(Math.min(orient === 'h' ? H : W, 7 * d));
    const gap = Math.max(1, Math.round(2 * d));
    const len = (orient === 'h' ? W : H) - led - gap * 2;
    const thick = ((orient === 'h' ? H : W) - gap) / 2;
    for (let c = 0; c < 2; c++) {
      const m = ch[c];
      const o = c * (thick + gap);
      const rect = (a, b) => (orient === 'h' ? [a, o, b - a, thick] : [o, H - b, thick, b - a]);
      // track
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(...rect(0, len));
      const pR = meterPos(m.rms, minDb) * len, pP = meterPos(m.pk, minDb) * len, pH = meterPos(m.hold, minDb) * len;
      ctx.fillStyle = grad;
      if (pP > pR) { ctx.globalAlpha = 0.38; ctx.fillRect(...rect(pR, pP)); }
      ctx.globalAlpha = 1;
      if (pR > 0) ctx.fillRect(...rect(0, pR));
      if (m.hold > minDb) {
        const hw = Math.max(1, Math.round(1.5 * d));
        ctx.fillStyle = m.hold > -1 ? rgba(tok.red) : m.hold > -6 ? rgba(tok.amber) : rgba(tok.text, 0.9);
        ctx.fillRect(...rect(Math.max(0, pH - hw), Math.max(hw, pH)));
      }
      // clip LED
      const lit = m.clipT > 0;
      ctx.fillStyle = lit ? rgba(tok.red) : 'rgba(255,255,255,0.07)';
      if (orient === 'h') ctx.fillRect(W - led, o, led, thick); else ctx.fillRect(o, 0, thick, led);
    }
    // ticks
    if ((orient === 'h' ? surf.w : surf.h) > 110) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(7,8,13,0.55)';
      for (const db of [-48, -36, -24, -18, -12, -6, -3]) {
        if (db <= minDb) continue;
        const p = Math.round(meterPos(db, minDb) * len);
        if (orient === 'h') ctx.fillRect(p, 0, Math.max(1, Math.round(d)), H); else ctx.fillRect(0, H - p, W, Math.max(1, Math.round(d)));
      }
    }
  }
  const entry = makeEntry('meter', (ts, dt) => {
    if (!entry.visible) return;
    const resized = surf.sync();
    if (!surf.ok) return;
    if (resized || !tok) { tok = readTokens(el); layout(); }
    const st = safeState(src.getState);
    const pk = st && st.peak, rm = st && st.rms;
    for (let c = 0; c < 2; c++) ch[c].update(pk ? pk[c] : 0, rm ? rm[c] : 0, dt);
    const key = `${ch[0].pk.toFixed(1)}|${ch[1].pk.toFixed(1)}|${ch[0].rms.toFixed(1)}|${ch[1].rms.toFixed(1)}|${ch[0].hold.toFixed(1)}|${ch[1].hold.toFixed(1)}|${ch[0].clipT > 0}|${ch[1].clipT > 0}`;
    if (key !== lastKey) { lastKey = key; draw(); }
  });
  const unobserve = observeVisibility(el, entry);
  let running = false;
  const api = {
    el,
    start() { if (!running) { running = true; tickerAdd(entry); } },
    stop() { running = false; tickerRemove(entry); },
    setSources(s = {}) { if ('getState' in s) src.getState = s.getState; },
    get levels() { return { peak: [ch[0].pk, ch[1].pk], rms: [ch[0].rms, ch[1].rms], hold: [ch[0].hold, ch[1].hold], clip: [ch[0].clipT > 0, ch[1].clipT > 0] }; },
    destroy() { api.stop(); unobserve(); surf.destroy(); },
  };
  api.start();
  return api;
}

/* ═══════════════════════════════ test hooks ═══════════════════════════════ */

export const _internals = {
  BandMap, HeroAnalysis, HeroModel, MeterChannel, meterPos, findTrigger, lfoValue, paletteAt, parseColor,
  noteToX, freqToX, F_LO, F_HI, NB, MAXB, MAXP, RIBBONS, ribbonCPU,
  setFrameStamp: v => { frameStamp = v; }, get frameStamp() { return frameStamp; },
  /** Run every registered visual once, synchronously (tests / hidden-page debugging). */
  tickAll: (tsMs = perfNow()) => runSubs(tsMs),
};
