// ADSR envelope generator. Pure ES module (AudioWorklet + Node safe), allocation-free after construction.
//
// Each segment (attack / decay / release) is a normalised exponential curve
//     y(p) = L0 + (T − L0) · (1 − e^(−k·p)) / (1 − e^(−k)),  p = 0..1 over N samples
// evaluated with a single multiply-add per sample (y ← y·c + b). The curvature k comes from the
// `curve` param: k > 0 convex (fast start — punchy), k ≈ 0 linear, k < 0 concave (slow start — swell).
// Every segment lands exactly on its target, so there are no discontinuities; retriggers start from
// the current level; parameter changes re-plan the running segment from the current level.

export const ENV_IDLE = 0;
export const ENV_ATTACK = 1;
export const ENV_DECAY = 2;
export const ENV_SUSTAIN = 3;
export const ENV_RELEASE = 4;
export const ENV_STAGE_NAMES = ['idle', 'attack', 'decay', 'sustain', 'release'];

const lerp = (a, b, t) => a + (b - a) * t;

/** Attack curvature from the 0..1 `curve` param (0 punchy/convex, 0.5 natural RC-like, 1 swell/concave). */
export function attackK(curve) {
  return curve < 0.5 ? lerp(5.5, 1.4, curve * 2) : lerp(1.4, -4.5, (curve - 0.5) * 2);
}
/** Decay/release curvature (0 snappy exponential, 0.5 natural exponential ≈ −52 dB shape, 1 slow/concave). */
export function decayK(curve) {
  return curve < 0.5 ? lerp(12, 6, curve * 2) : lerp(6, -1.5, (curve - 0.5) * 2);
}

export class Env {
  /**
   * @param {number} sampleRate
   * @param {boolean} amp  amplitude envelope: enforces ≥1 ms attack, ≥4 ms release, a minimum segment
   *                       time constant, and rounds segment corners with a 0.2 ms smoother on the output
   *                       (declick). Mod envelopes may be as snappy as asked.
   */
  constructor(sampleRate, amp = false) {
    this.sr = sampleRate;
    this.amp = amp;
    this.minA = amp ? 0.001 : 0;
    this.minD = amp ? 0.002 : 0;
    this.minR = amp ? 0.004 : 0;
    this.tauMin = amp ? 0.00035 * sampleRate : 0; // samples
    this.a = 0.005; this.d = 0.3; this.s = 0.8; this.r = 0.3; this.curve = 0.5;
    this._pa = 0.005; this._pd = 0.3; this._ps = 0.8; this._pr = 0.3; this._pc = 0.5; // pending (set/setFrom)
    this.kA = attackK(0.5); this.kD = decayK(0.5);
    this.level = 0;
    this.stage = ENV_IDLE;
    // running segment
    this.c = 1; this.b = 0; this.count = 0; this.segN = 1; this.target = 0;
    this.segL0 = 0.5; this.segK = 1.5; this.segA = 1.5; this.segYinf = 1.5; this.segLin = false; // shape of the running segment
    // sustain follower (smooths sustain-level changes, ~4 ms)
    this.susCoef = 1 - Math.exp(-1 / (0.004 * sampleRate));
    // amp only: corner-rounding smoother on the rendered output (the internal level stays exact)
    this.smK = amp ? 1 - Math.exp(-1 / (0.0002 * sampleRate)) : 1;
    this.out = 0.5; this.out = 0;
  }

  reset() {
    this.level = 0; this.stage = ENV_IDLE; this.count = 0; this.c = 1; this.b = 0; this.out = 0;
  }

  /** Update parameters (seconds / 0..1). Cheap when unchanged. Re-plans the running segment. */
  set(a, d, s, r, curve) {
    this._pa = a; this._pd = d; this._ps = s; this._pr = r; this._pc = curve;
    this._commit();
  }

  /**
   * Same as set(), reading from a value array by index: ids = [a, d, s, r, curve] param indices.
   * (Hot path: passing indices instead of doubles avoids number boxing across the call.)
   */
  setFrom(v, ids) {
    this._pa = v[ids[0]]; this._pd = v[ids[1]]; this._ps = v[ids[2]]; this._pr = v[ids[3]]; this._pc = v[ids[4]];
    this._commit();
  }

  _commit() {
    const a = this._pa, d = this._pd, r = this._pr, curve = this._pc;
    let s = this._ps;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    if (a === this.a && d === this.d && s === this.s && r === this.r && curve === this.curve) return;
    const cCh = curve !== this.curve;
    const aCh = a !== this.a, dCh = d !== this.d, sCh = s !== this.s, rCh = r !== this.r;
    this.a = a; this.d = d; this.s = s; this.r = r; this.curve = curve;
    if (cCh) { this.kA = attackK(curve); this.kD = decayK(curve); }
    if (this.count <= 0) return;
    // Modulated times keep the curve's phase (only its speed changes); a modulated sustain target is
    // re-solved so the current level is preserved. Only a curve change restarts the remaining shape.
    switch (this.stage) {
      case ENV_ATTACK:
        if (cCh) this._planAttack();
        else if (aCh) this._retime(Math.max(this.a * this.sr * (1 - this.segL0), this.minA * this.sr));
        break;
      case ENV_DECAY:
        if (cCh) this._plan(this.s, Math.max(this.d, this.minD) * this.sr * (this.count / this.segN), this.kD);
        else {
          if (dCh) this._retime(Math.max(this.d, this.minD) * this.sr);
          if (sCh) this._retarget(this.s);
        }
        break;
      case ENV_RELEASE:
        if (cCh) this._plan(0, Math.max(this.r, this.minR) * this.sr * (this.count / this.segN), this.kD);
        else if (rCh) this._retime(Math.max(this.r, this.minR) * this.sr);
        break;
    }
  }

  /** Change the running segment's total length (samples), keeping its phase and shape. */
  _retime(N) {
    if (N < 1) N = 1;
    const frac = this.count / this.segN;
    this.segN = N;
    let cnt = Math.round(frac * N);
    if (cnt < 1) cnt = 1;
    this.count = cnt;
    if (this.segLin) {
      this.b = (this.target - this.level) / cnt;
    } else {
      const c = Math.exp(-this.segK / N);
      this.c = c;
      this.b = this.segYinf * (1 - c);
    }
  }

  /** Change the running segment's target, keeping the current level and phase (no jump). */
  _retarget(T) {
    const y = this.level;
    if (this.segLin) {
      this.target = T;
      this.b = (T - y) / this.count;
      return;
    }
    const L0 = this.segL0, T0 = this.target;
    let sh = Math.abs(T0 - L0) > 1e-9 ? (y - L0) / (T0 - L0) : 1 - this.count / this.segN;
    if (sh < 0) sh = 0;
    if (sh > 0.9999) {
      // practically at the end: finish linearly
      this.segLin = true; this.c = 1; this.target = T; this.b = (T - y) / this.count;
      return;
    }
    const L0n = (y - T * sh) / (1 - sh);
    this.segL0 = L0n;
    this.target = T;
    this.segYinf = L0n + (T - L0n) * this.segA;
    this.b = this.segYinf * (1 - this.c);
  }

  /** Key down. retrigger=false keeps the envelope running (legato). Always starts from the current level. */
  gateOn(retrigger = true) {
    if (!retrigger && this.stage !== ENV_IDLE && this.stage !== ENV_RELEASE) return;
    this.stage = ENV_ATTACK;
    this._planAttack();
  }

  /** Key up → release from the current level. */
  gateOff() {
    if (this.stage === ENV_IDLE || this.stage === ENV_RELEASE) return;
    if (this.level <= 1e-7) { this.reset(); return; }
    this.stage = ENV_RELEASE;
    this._plan(0, Math.max(this.r, this.minR) * this.sr, this.kD);
  }

  get idle() { return this.stage === ENV_IDLE; }
  /** Finished and the (smoothed) output has settled at zero → the voice can be freed. */
  get done() { return this.stage === ENV_IDLE && this.out < 1e-6; }
  get stageName() { return ENV_STAGE_NAMES[this.stage]; }

  _planAttack() {
    const dist = 1 - this.level;
    if (dist <= 1e-6) { this._enterDecay(); return; }
    // attack time scales with the remaining distance so retriggers keep the same slope
    let N = this.a * this.sr * dist;
    const minN = this.minA * this.sr;
    if (N < minN) N = minN;
    this._plan(1, N, this.kA);
  }

  _enterDecay() {
    this.level = 1;
    this.stage = ENV_DECAY;
    this._plan(this.s, Math.max(this.d, this.minD) * this.sr, this.kD);
  }

  /** Plan a segment from the current level to T over N samples with curvature k. */
  _plan(T, N, k) {
    N = N < 1 ? 1 : Math.round(N);
    const L0 = this.level;
    if (k > 0 && this.tauMin > 0) {
      // declick: keep the initial time constant (N/k samples) ≥ tauMin
      const kMax = N / this.tauMin;
      if (k > kMax) k = kMax;
    }
    this.segL0 = L0;
    this.segK = k;
    if (k > -1e-3 && k < 1e-3) {
      this.segLin = true;
      this.c = 1;
      this.b = (T - L0) / N;
    } else {
      this.segLin = false;
      const A = 1 / (1 - Math.exp(-k));
      const yInf = L0 + (T - L0) * A;
      const c = Math.exp(-k / N);
      this.segA = A;
      this.segYinf = yInf;
      this.c = c;
      this.b = yInf * (1 - c);
    }
    this.count = N;
    this.segN = N;
    this.target = T;
  }

  _segmentDone() {
    this.level = this.target;
    this.count = 0;
    switch (this.stage) {
      case ENV_ATTACK: this._enterDecay(); break;
      case ENV_DECAY: this.stage = ENV_SUSTAIN; break;
      case ENV_RELEASE: this.level = 0; this.stage = ENV_IDLE; break;
    }
  }

  /** Per-sample render into buf[offset..offset+n). Read `.level` afterwards (no return value: avoids boxing). */
  process(buf, offset, n) {
    let y = this.level;
    const end = offset + n;
    let i = offset;
    while (i < end) {
      const st = this.stage;
      if (st === ENV_IDLE) {
        for (; i < end; i++) buf[i] = 0;
        y = 0;
        break;
      }
      if (st === ENV_SUSTAIN) {
        const s = this.s, k = this.susCoef;
        if (y === s) { for (; i < end; i++) buf[i] = y; }
        else {
          for (; i < end; i++) { y += (s - y) * k; buf[i] = y; }
          if (Math.abs(y - s) < 1e-9) y = s;
        }
        break;
      }
      // running segment
      let m = end - i;
      if (m > this.count) m = this.count;
      const c = this.c, b = this.b;
      for (let j = 0; j < m; j++, i++) { y = y * c + b; buf[i] = y; }
      this.count -= m;
      this.level = y;
      if (this.count <= 0) { this._segmentDone(); y = this.level; }
    }
    this.level = y;
    if (this.smK < 1) {
      // round segment corners (C1-smooth amp transitions → no spectral splatter on fast segments)
      const k = this.smK;
      let z = this.out;
      for (let j = offset; j < end; j++) { z += (buf[j] - z) * k; buf[j] = z; }
      this.out = z < 1e-9 && this.stage === ENV_IDLE ? 0 : z;
    }
  }

  /** Advance n samples without writing a buffer (mod envelopes at control rate). Read `.level` afterwards. */
  advance(n) {
    let y = this.level;
    while (n > 0) {
      const st = this.stage;
      if (st === ENV_IDLE) { y = 0; break; }
      if (st === ENV_SUSTAIN) {
        const s = this.s;
        if (y !== s) {
          // closed form of n one-pole steps
          y = s + (y - s) * Math.pow(1 - this.susCoef, n);
          if (Math.abs(y - s) < 1e-9) y = s;
        }
        break;
      }
      let m = n;
      if (m > this.count) m = this.count;
      const c = this.c, b = this.b;
      for (let j = 0; j < m; j++) y = y * c + b;
      this.count -= m;
      n -= m;
      this.level = y;
      if (this.count <= 0) { this._segmentDone(); y = this.level; }
    }
    this.level = y;
  }
}
