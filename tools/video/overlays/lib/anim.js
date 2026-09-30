// Tiny animation kernel for the overlay: one rAF loop, tweens, waits and per-frame tickers.
// Everything time-based goes through Engine.now() so a host can inject a virtual clock.

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = {
  linear: t => t,
  inCubic: t => t * t * t,
  outCubic: t => 1 - (1 - t) ** 3,
  inOutCubic: t => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuint: t => 1 - (1 - t) ** 5,
  outExpo: t => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inExpo: t => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  inOutExpo: t => (t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: t => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; },
};
// CSS equivalents for WAAPI
export const css = {
  out: 'cubic-bezier(.16, 1, .3, 1)',        // expo-ish out: fast start, long settle
  outSoft: 'cubic-bezier(.2, .8, .2, 1)',    // AURORA --ease-out
  spring: 'cubic-bezier(.3, 1.35, .5, 1)',   // AURORA --ease-spring
  in: 'cubic-bezier(.55, 0, .75, .1)',
  inOut: 'cubic-bezier(.65, 0, .35, 1)',
};

export class Engine {
  constructor(clock) {
    this.base = clock || (() => performance.now());
    this.shift = 0; this.frozen = null;
    this.now = () => (this.frozen ?? this.base() - this.shift);
    this.tickers = new Set();
    this.raf = 0; this.to = 0;
    this.t = this.now();
    this.samples = new Float64Array(1200); this.ns = 0; this.frames = 0;
    this._loop = this._loop.bind(this);
  }
  /** Stop the clock (tweens, waits and canvases hold still) until thaw(). */
  freeze() { if (this.frozen == null) this.frozen = this.base() - this.shift; }
  thaw() { if (this.frozen != null) { this.shift = this.base() - this.frozen; this.frozen = null; } }
  /** fn(now, dt) runs every frame until it returns false (or the returned remover is called). */
  add(fn) {
    this.tickers.add(fn);
    if (!this.raf && !this.to) { this.t = this.now(); this._schedule(); }
    return () => this.tickers.delete(fn);
  }
  // rAF drives the loop; a timer backs it up so waits/tweens still advance when frames are not being
  // produced (background tab, CDP virtual time, frame-by-frame capture).
  _schedule() {
    this.raf = requestAnimationFrame(this._loop);
    this.to = setTimeout(this._loop, 50);
  }
  _loop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.to) clearTimeout(this.to);
    this.raf = 0; this.to = 0;
    const t0 = performance.now();
    const now = this.now(); const dt = Math.min(100, now - this.t); this.t = now;
    for (const fn of [...this.tickers]) {
      let keep;
      try { keep = fn(now, dt); } catch (e) { console.error('[overlay] ticker failed', e); keep = false; }
      if (keep === false) this.tickers.delete(fn);
    }
    const cost = performance.now() - t0;
    this.samples[this.ns++ % this.samples.length] = cost; this.frames++;
    if (this.tickers.size) this._schedule();
  }
  /** Tween p: 0 → 1 over ms with an easing; update(eased, raw). Resolves when done (or cancelled). */
  tween({ ms = 600, delay = 0, easing = ease.outCubic, update, done, signal } = {}) {
    return new Promise(res => {
      const start = this.now() + delay;
      this.add(now => {
        if (signal?.aborted) { res(false); return false; }
        if (now < start) return true;
        const raw = ms <= 0 ? 1 : clamp((now - start) / ms);
        update?.(easing(raw), raw);
        if (raw >= 1) { done?.(); res(true); return false; }
        return true;
      });
    });
  }
  wait(ms, signal) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise(res => {
      const end = this.now() + ms;
      this.add(now => { if (signal?.aborted || now >= end) { res(); return false; } return true; });
    });
  }
  perf() {
    const n = Math.min(this.ns, this.samples.length);
    const a = Array.from(this.samples.subarray(0, n)).sort((x, y) => x - y);
    const q = p => (n ? a[Math.min(n - 1, Math.floor(p * n))] : 0);
    return { frames: this.frames, samples: n, avg: n ? a.reduce((s, v) => s + v, 0) / n : 0, p50: q(.5), p95: q(.95), p99: q(.99), max: n ? a[n - 1] : 0 };
  }
  perfReset() { this.ns = 0; this.frames = 0; }
}

/** WAAPI helper → promise that resolves on finish (or cancel). Keeps the end state (fill: forwards). */
export function anim(el, keyframes, { ms = 600, delay = 0, easing = css.out, fill = 'both', composite } = {}) {
  const a = el.animate(keyframes, { duration: Math.max(1, ms), delay, easing, fill, ...(composite ? { composite } : {}) });
  if (stepping.on) { a.pause(); a.currentTime = 0; } // frame-stepping: new animations wait for the next step
  return a.finished.then(() => a, () => a);
}
/** shared flag: true while the overlay is frozen / being frame-stepped */
export const stepping = { on: false };
