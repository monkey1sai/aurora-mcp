// Voice: sources (osc1, osc2, fm, phys, noise) → filter bus / dry bus → filter → filter2 → amp → pan.
// Pure ES module (AudioWorklet + Node safe). Allocation-free after construction.
//
// Control rate: `control()` runs once per CR-sample block (mod sources, mod matrix, pitch, cutoff, gain
// targets); `render()` renders any sub-range of that block. Every gain is linearly ramped across the block
// and the cutoff is interpolated exponentially, so nothing zippers; the amp envelope runs per sample.
//
// Also exports fast per-param normalise / denormalise mappers used by the synth, macros and sequencer.

import { PARAMS, PARAM_COUNT, idx, MOD_SOURCES, MOD_SLOTS, SYNC_DIVS, divToBeats } from './params.js';
import { CR, PI2, Rng } from './util.js';
import { Env, ENV_IDLE, ENV_ATTACK, ENV_STAGE_NAMES } from './env.js';
import { Lfo } from './lfo.js';
import { OscEngine } from './engines/osc.js';
import { FmEngine } from './engines/fm.js';
import { PhysEngine } from './engines/phys.js';
import { NoiseEngine } from './engines/noise.js';
import { VoiceFilter, SVFilter } from './filter.js';

// ───────────────────────── fast param mappers ─────────────────────────

const K_LIN = 0, K_EXP = 1, K_POW = 2, K_ENUM = 3, K_BOOL = 4;
export const PM_KIND = new Uint8Array(PARAM_COUNT);
export const PM_INT = new Uint8Array(PARAM_COUNT);
export const PM_MIN = new Float64Array(PARAM_COUNT);
export const PM_MAX = new Float64Array(PARAM_COUNT);
const PM_SPAN = new Float64Array(PARAM_COUNT);
const PM_LNR = new Float64Array(PARAM_COUNT);   // ln(max/min) for exp
const PM_K = new Float64Array(PARAM_COUNT);
const PM_INVK = new Float64Array(PARAM_COUNT);
for (let i = 0; i < PARAM_COUNT; i++) {
  const p = PARAMS[i];
  PM_MIN[i] = p.min; PM_MAX[i] = p.max; PM_SPAN[i] = p.max - p.min;
  PM_INT[i] = p.type === 'int' ? 1 : 0;
  if (p.type === 'enum') PM_KIND[i] = K_ENUM;
  else if (p.type === 'bool') PM_KIND[i] = K_BOOL;
  else if (p.curve === 'exp') { PM_KIND[i] = K_EXP; PM_LNR[i] = Math.log(p.max / p.min); }
  else if (p.curve === 'pow') { PM_KIND[i] = K_POW; PM_K[i] = p.k || 3; PM_INVK[i] = 1 / (p.k || 3); }
  else PM_KIND[i] = K_LIN;
}

/** DSP numeric value → normalised 0..1 (same semantics as params.toNorm, but fast, by index). */
export function normOf(i, x) {
  let n;
  switch (PM_KIND[i]) {
    case K_LIN: n = PM_SPAN[i] > 0 ? (x - PM_MIN[i]) / PM_SPAN[i] : 0; break;
    case K_EXP: n = x > 0 ? Math.log(x / PM_MIN[i]) / PM_LNR[i] : 0; break;
    case K_POW: { const t = (x - PM_MIN[i]) / PM_SPAN[i]; n = t > 0 ? Math.pow(t, PM_INVK[i]) : 0; break; }
    case K_ENUM: n = PM_MAX[i] > 0 ? x / PM_MAX[i] : 0; break;
    default: n = x >= 0.5 ? 1 : 0;
  }
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Normalised 0..1 → DSP numeric value (enum index, bool 0/1, int rounded). Clamps. */
export function denormOf(i, n) {
  n = n < 0 ? 0 : n > 1 ? 1 : n;
  let x;
  switch (PM_KIND[i]) {
    case K_LIN: x = PM_MIN[i] + PM_SPAN[i] * n; break;
    case K_EXP: x = n >= 1 ? PM_MAX[i] : PM_MIN[i] * Math.exp(PM_LNR[i] * n); break;
    case K_POW: x = PM_MIN[i] + PM_SPAN[i] * Math.pow(n, PM_K[i]); break;
    case K_ENUM: return Math.round(n * PM_MAX[i]);
    default: return n >= 0.5 ? 1 : 0;
  }
  return PM_INT[i] ? Math.round(x) : x;
}

/**
 * Allocation-free variants for the audio path: out[oi] = normOf(pi, src[si]) / denormOf(pi, src[si]).
 * (A double argument or return value of a non-inlined call is boxed into a HeapNumber by V8 — these take
 * and return only arrays and small integers.)
 */
export function normTo(out, oi, pi, src, si) {
  const x = src[si];
  let n;
  switch (PM_KIND[pi]) {
    case K_LIN: n = PM_SPAN[pi] > 0 ? (x - PM_MIN[pi]) / PM_SPAN[pi] : 0; break;
    case K_EXP: n = x > 0 ? Math.log(x / PM_MIN[pi]) / PM_LNR[pi] : 0; break;
    case K_POW: { const t = (x - PM_MIN[pi]) / PM_SPAN[pi]; n = t > 0 ? Math.pow(t, PM_INVK[pi]) : 0; break; }
    case K_ENUM: n = PM_MAX[pi] > 0 ? x / PM_MAX[pi] : 0; break;
    default: n = x >= 0.5 ? 1 : 0;
  }
  out[oi] = n < 0 ? 0 : n > 1 ? 1 : n;
}

export function denormTo(out, oi, pi, src, si) {
  let n = src[si];
  n = n < 0 ? 0 : n > 1 ? 1 : n;
  let x;
  switch (PM_KIND[pi]) {
    case K_LIN: x = PM_MIN[pi] + PM_SPAN[pi] * n; break;
    case K_EXP: x = n >= 1 ? PM_MAX[pi] : PM_MIN[pi] * Math.exp(PM_LNR[pi] * n); break;
    case K_POW: x = PM_MIN[pi] + PM_SPAN[pi] * Math.pow(n, PM_K[pi]); break;
    case K_ENUM: x = Math.round(n * PM_MAX[pi]); break;
    default: x = n >= 0.5 ? 1 : 0;
  }
  out[oi] = PM_INT[pi] && PM_KIND[pi] <= K_POW ? Math.round(x) : x;
}

// ───────────────────────── constants ─────────────────────────

/** Mix gain per voice: osc saw (±1) at level 0.8, vel 1, 0 dB → ≈ −12 dBFS peak in the synth mix. */
export const VOICE_GAIN = 0.25118864 / 0.8;

export const SRC_NONE = 0;
const S_LFO1 = MOD_SOURCES.indexOf('lfo1');
const S_LFO2 = MOD_SOURCES.indexOf('lfo2');
const S_MENV = MOD_SOURCES.indexOf('menv');
const S_FENV = MOD_SOURCES.indexOf('fenv');
const S_AENV = MOD_SOURCES.indexOf('aenv');
const S_VEL = MOD_SOURCES.indexOf('velocity');
const S_NOTE = MOD_SOURCES.indexOf('note');
const S_WHEEL = MOD_SOURCES.indexOf('wheel');
const S_AT = MOD_SOURCES.indexOf('aftertouch');
const S_BEND = MOD_SOURCES.indexOf('bend');
const S_RANDOM = MOD_SOURCES.indexOf('random');

export const SYNC_BEATS = Float64Array.from(SYNC_DIVS.map(divToBeats));

const SOURCES = ['osc1', 'osc2', 'fm', 'phys', 'noise'];
const NSRC = SOURCES.length;
const LOG2_1000 = Math.log2(1000); // one normalised unit of an exp 20..20k param, in octaves

const P_NONE = 0, P_START = 1, P_RETRIG = 2, P_LEGATO = 3;

// Control-rate parameter smoothing. Parameters arrive as steps (UI knobs at pointer rate, macros, sequencer
// `param` events, S&H modulation). Linear ramps across one 16-sample block turn a step into a 0.33 ms edge, which
// zippers audibly on sustained tones (measured HF bursts −32 dB re signal while turning a level knob, vs −92 dB
// steady). Gains, the base cutoff, res/drive/vowel and filter 2 therefore follow a one-pole (time constant
// SMOOTH_SEC) evaluated per block, still linearly interpolated inside the block. Envelope → cutoff stays unsmoothed.
const SMOOTH_SEC = 0.006;
const SNAP = 1e-6;
const FILTER_XFADE_SEC = 0.005;   // filter / filter 2 on ↔ off crossfade

// indices resolved once
const I = {
  pitch: idx('voice.pitch'), glide: idx('voice.glide'), bendRange: idx('voice.bend'), spread: idx('voice.spread'),
  vibDepth: idx('vib.depth'), vibRate: idx('vib.rate'), vibDelay: idx('vib.delay'), vibWheel: idx('vib.wheel'),
  ampLevel: idx('amp.level'), ampVel: idx('amp.vel'), ampPan: idx('amp.pan'),
  fOn: idx('filter.on'), fType: idx('filter.type'), fCut: idx('filter.cutoff'), fRes: idx('filter.res'),
  fDrive: idx('filter.drive'), fKey: idx('filter.key'), fEnv: idx('filter.env'), fVel: idx('filter.vel'),
  fVowel: idx('filter.vowel'),
  f2Type: idx('filter2.type'), f2Cut: idx('filter2.cutoff'), f2Res: idx('filter2.res'),
};
const ENV_IDS = ['aenv', 'fenv', 'menv'].map(e => Int32Array.from(['a', 'd', 's', 'r', 'curve'].map(k => idx(`${e}.${k}`))));
const LFO_IDS = ['lfo1', 'lfo2'].map(l => ({
  shape: idx(`${l}.shape`), rate: idx(`${l}.rate`), sync: idx(`${l}.sync`), fade: idx(`${l}.fade`),
  mode: idx(`${l}.mode`), phase: idx(`${l}.phase`),
}));
const SRC_ON = Int32Array.from(SOURCES.map(s => idx(`${s}.on`)));
const SRC_LVL = Int32Array.from(SOURCES.map(s => idx(`${s}.level`)));
const SRC_PAN = Int32Array.from(SOURCES.map(s => idx(`${s}.pan`)));
const SRC_FILT = Int32Array.from(SOURCES.map(s => idx(`${s}.filt`)));
const S_PHYS = SOURCES.indexOf('phys');
const I_PHYS_EXC = idx('phys.exciter');
// Loudness make-up for the physical model. Its strikes are peak-normalised (≈ ±1) but have a 14–26 dB crest
// factor, so at equal `level` a pluck/mallet sounded 11–13 dB (momentary loudness) below a saw, and bow/breath
// 3–5 dB below. Transient exciters get +6 dB (peaks ≈ ±2 pre-level; the output limiter has the headroom),
// continuous ones +3 dB. Index = phys.exciter option: pluck, mallet, bow, breath.
const PHYS_TRIM = new Float64Array([2, 2, 1.4125375, 1.4125375]);

// spread positions for successive notes: alternating sides, varied widths (balanced over 8 notes)
const SPREAD_PATTERN = new Float64Array([-0.85, 0.85, -0.35, 0.55, -0.6, 0.3, -0.15, 0.7, -0.7, 0.15, -0.3, 0.6, -0.55, 0.35, -0.95, 0.95]);
export function spreadPosition(counter) { return SPREAD_PATTERN[counter & 15]; }

// ───────────────────────── Voice ─────────────────────────

export class Voice {
  /**
   * @param {number} sampleRate
   * @param {object} ctx  the owning Synth: reads ctx.eff, ctx.effVersion, ctx.bpm, ctx.clockBeat,
   *                      ctx.ctlWheel/ctlAt/ctlBend (smoothed), ctx.monoLfo (Float64Array(2)),
   *                      ctx.modN, ctx.modSrc, ctx.modDstU, ctx.modAmt, ctx.modUniq, ctx.modUniqN, ctx.modNormEff
   * @param {number} index voice index (seeds)
   * @param {number} seed
   */
  constructor(sampleRate, ctx, index, seed = 1) {
    this.sr = sampleRate;
    this.ctx = ctx;
    this.index = index;
    this.v = new Float64Array(PARAM_COUNT);
    this.vVersion = -1;

    // distinct deterministic seeds per voice/engine (drift, random phase, noise decorrelated between voices)
    const s0 = ((seed >>> 0) * 747796405 + index * 2891336453) >>> 0;
    const es = k => (Math.imul(s0 ^ (k * 0x85ebca6b), 0x9e3779b1) >>> 0) || (k + 1);
    this.engines = [
      new OscEngine(sampleRate, 'osc1', es(1)),
      new OscEngine(sampleRate, 'osc2', es(2)),
      new FmEngine(sampleRate, 'fm'),
      new PhysEngine(sampleRate, 'phys', es(4)),
      new NoiseEngine(sampleRate, 'noise', es(5)),
    ];
    this.started = new Uint8Array(NSRC);   // engine has had noteOn for the current note
    this.proc = new Uint8Array(NSRC);      // engine processed this block
    // per source: [filtL, filtR, dryL, dryR] gains at block start (g0) and block end (g1)
    this.g0 = new Float64Array(NSRC * 4);
    this.g1 = new Float64Array(NSRC * 4);
    this.panCache = new Float64Array(NSRC).fill(NaN);
    this.panL = new Float64Array(NSRC);
    this.panR = new Float64Array(NSRC);

    this.filter = new VoiceFilter(sampleRate);
    this.filter2 = new SVFilter(sampleRate);
    this.aenv = new Env(sampleRate, true);
    this.fenv = new Env(sampleRate, false);
    this.menv = new Env(sampleRate, false);
    this.lfo = [new Lfo(sampleRate, (s0 ^ 0x1234567) >>> 0 || 3, CR), new Lfo(sampleRate, (s0 ^ 0x7654321) >>> 0 || 5, CR)];
    this.rng = new Rng((s0 ^ 0x9e3779b9) >>> 0 || 11);
    for (let k = 0; k < 8; k++) this.rng.nextU32(); // decorrelate from the seed

    this.tL = new Float32Array(CR); this.tR = new Float32Array(CR);
    this.fL = new Float32Array(CR); this.fR = new Float32Array(CR);
    this.dL = new Float32Array(CR); this.dR = new Float32Array(CR);
    this.envBuf = new Float32Array(CR);
    this.src = new Float64Array(MOD_SOURCES.length);
    this.modSum = new Float64Array(MOD_SLOTS);

    // lifecycle
    this.active = false;   // allocated
    this.gate = false;     // key logically down
    this.pending = P_NONE;
    this.pendingRelease = false;
    this.controlled = false;
    this.fading = false;
    this.fadeGain = 1;
    this.fadeT = 0;
    this.fadeStep = 1 / (0.002 * sampleRate);
    this.note = 60;
    this.vel = 0.8;
    this.velPow = 1;
    this.serial = 0;
    this.releaseSerial = 0;
    this.ageSamples = 0;
    this.spreadPos = 0;
    this.rand = 0;
    this.silentBlocks = 0;
    this.minGate = Math.round(0.003 * sampleRate);

    // pitch
    this.glideOff = 0;
    this.glideT = -1;
    this.glideCoef = 0;
    this.vibPhase = 0;
    this.freq = 261.63;
    this.cutNote = 60;

    // filter
    this.cut0 = 1000; this.cut1 = 1000;
    this.filtIdle = 1e9;
    this.filtIdleLimit = Math.ceil((0.3 * sampleRate) / CR);
    this.fType = 0; this.f2Mode = -1;
    this.fRes = 0; this.fDrive = 0; this.fVowel = 0; this.f2Cut = 1000; this.f2Res = 0;
    this.kSm = 1 - Math.exp(-CR / (SMOOTH_SEC * sampleRate));
    this.lcS = 10;        // smoothed log2(filter.cutoff) (base value, before key/env/vel/matrix)
    this.l2S = 10;        // smoothed log2(filter2.cutoff)
    // filter on/off and filter 2 off/on crossfades (mix at block start / end); f2Run = mode used while fading out
    this.fMix0 = 1; this.fMix1 = 1; this.f2Mix0 = 0; this.f2Mix1 = 0; this.f2Run = 0;
    this.fMixStep = CR / (FILTER_XFADE_SEC * sampleRate);
    // DC blocker after the main filter (8 Hz one-pole high-pass). A driven, resonant ladder saturates an
    // asymmetric (low-passed saw) waveform and produced a DC offset of up to ≈ 20 % of the peak (−16 dB of
    // sub-30 Hz energy, a thump at every note-on/off); at 8 Hz it is −0.2 dB at 30 Hz.
    this.dcR = Math.exp(-2 * Math.PI * 8 / sampleRate);
    this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
    this.fParked = false; this.f2Parked = false; // filter state cleared after fading out
    this.xL = new Float32Array(CR); this.xR = new Float32Array(CR); // dry copy for the crossfades

    // amp (L/R gain incl. pan) at block start / end
    this.a0L = 0; this.a0R = 0; this.a1L = 0; this.a1R = 0;
    this.ampPanCache = NaN; this.apL = 1; this.apR = 1;
    this.blockEnergy = 0;
  }

  // ───────────── events (applied at the next control block) ─────────────

  /** Fresh note on a free voice. glideFrom: previous note (semitones) to glide from, or NaN. */
  start(note, vel, glideFrom, spreadPos, serial) {
    this.active = true;
    this.gate = true;
    this.fading = false;
    this.fadeGain = 1;
    this.note = note;
    this.vel = vel;
    this.velPow = Math.pow(vel, 1.6);
    this.serial = serial;
    this.spreadPos = spreadPos;
    this.glideOff = glideFrom === glideFrom ? glideFrom - note : 0;
    this.pending = P_START;
    this.pendingRelease = false;
    this.controlled = false;
    this.silentBlocks = 0;
  }

  /** Mono/legato: move this (active) voice to a new note; glides from its current pitch. */
  retrigger(note, vel, legato, serial) {
    const cur = this.note + this.glideOff;
    this.note = note;
    this.glideOff = cur - note;
    this.gate = true;
    if (!legato) { this.vel = vel; this.velPow = Math.pow(vel, 1.6); }
    this.serial = serial;
    this.silentBlocks = 0;
    if (this.pending === P_START) return; // still starting: just start on the new note
    if (this.pending !== P_RETRIG) this.pending = legato ? P_LEGATO : P_RETRIG;
    this.pendingRelease = false;
  }

  /** Key up (release phase). */
  release(serial) {
    if (!this.gate) return;
    this.gate = false;
    this.releaseSerial = serial;
    this.pendingRelease = true;
  }

  /** Voice stealing: ~2 ms smoothstep fade (zero slope at both ends → no corner), then free. */
  startFade(timeSec = 0.002) {
    if (!this.fading) { this.fadeT = 0; this.fadeGain = 1; }
    this.gate = false;
    this.fading = true;
    this.fadeStep = 1 / Math.max(1, timeSec * this.sr);
  }

  /** Immediate hard stop (no fade). */
  hardStop() {
    this.active = false;
    this.gate = false;
    this.fading = false;
    this.pending = P_NONE;
    this.pendingRelease = false;
    this.controlled = false;
    for (let s = 0; s < NSRC; s++) { this.engines[s].reset(); this.started[s] = 0; }
    this.filter.reset(); this.filter2.reset();
    this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0;
    this.aenv.reset(); this.fenv.reset(); this.menv.reset();
    this.g0.fill(0); this.g1.fill(0);
    this.a0L = this.a0R = this.a1L = this.a1R = 0;
    this.glideOff = 0;
  }

  get stageName() {
    if (this.fading) return 'release';
    if (this.pending === P_START) return 'attack';
    return ENV_STAGE_NAMES[this.aenv.stage];
  }
  get level() { return this.fading ? this.aenv.level * this.fadeGain : this.aenv.level; }
  get age() { return this.ageSamples / this.sr; }

  // ───────────── control block ─────────────

  control() {
    const ctx = this.ctx;
    const sr = this.sr;
    const pend = this.pending;
    // fresh note: always start from eff (a reused voice may still hold the last note's modulated values)
    if (this.vVersion !== ctx.effVersion || pend === P_START) { this.v.set(ctx.eff); this.vVersion = ctx.effVersion; }
    const v = this.v;

    if (pend === P_START) {
      this.aenv.reset(); this.fenv.reset(); this.menv.reset();
      this.ageSamples = 0;
      this.vibPhase = 0;
      this.rand = this.rng.bipolar();
      this.silentBlocks = 0;
      this._setEnvs(v);
      this.aenv.gateOn(true); this.fenv.gateOn(true); this.menv.gateOn(true);
      for (let l = 0; l < 2; l++) {
        const L = LFO_IDS[l];
        this.lfo[l].reset(v[L.phase], v[L.shape] | 0);
      }
      this.filtIdle = 1e9;
      this.cut1 = NaN; // initialise cutoff ramp without a sweep
    } else if (pend === P_RETRIG) {
      this.ageSamples = 0;
      this._setEnvs(v);
      this.aenv.gateOn(true); this.fenv.gateOn(true); this.menv.gateOn(true);
    } else if (pend === P_LEGATO) {
      this._setEnvs(v);
      // legato after full release (not overlapping) still needs a new attack
      this.aenv.gateOn(false); this.fenv.gateOn(false); this.menv.gateOn(false);
    }

    // ── mod sources ──
    const src = this.src;
    const age = this.ageSamples / sr;
    this.fenv.advance(CR);
    this.menv.advance(CR);
    src[S_FENV] = this.fenv.level;
    src[S_MENV] = this.menv.level;
    src[S_AENV] = this.aenv.level;
    src[S_VEL] = this.vel;
    let nn = (this.note - 60) / 48;
    src[S_NOTE] = nn < -1 ? -1 : nn > 1 ? 1 : nn;
    src[S_WHEEL] = ctx.ctlWheel;
    src[S_AT] = ctx.ctlAt;
    src[S_BEND] = ctx.ctlBend;
    src[S_RANDOM] = this.rand;
    for (let l = 0; l < 2; l++) {
      const L = LFO_IDS[l];
      let val;
      if (v[L.mode] >= 0.5) {
        val = ctx.monoLfo[l];
      } else {
        const beats = SYNC_BEATS[v[L.sync] | 0];
        const lf = this.lfo[l];
        lf.hz = beats > 0 ? ctx.bpm / (60 * beats) : v[L.rate];
        lf.advance(CR, v[L.shape] | 0);
        val = lf.value;
      }
      const fade = v[L.fade];
      if (fade > 0 && age < fade) val *= age / fade;
      src[l === 0 ? S_LFO1 : S_LFO2] = val;
    }

    // ── mod matrix (normalised, additive) ──
    let cutMod = 0;
    const nU = ctx.modUniqN;
    if (nU > 0) {
      const ms = this.modSum;
      for (let u = 0; u < nU; u++) ms[u] = 0;
      const nS = ctx.modN, mSrc = ctx.modSrc, mDst = ctx.modDstU, mAmt = ctx.modAmt;
      for (let k = 0; k < nS; k++) ms[mDst[k]] += mAmt[k] * src[mSrc[k]];
      const uniq = ctx.modUniq, ne = ctx.modNormEff;
      for (let u = 0; u < nU; u++) {
        const pi = uniq[u];
        if (pi === I.fCut) { cutMod = ms[u]; continue; }
        ms[u] += ne[u];
        denormTo(v, pi, pi, ms, u);
      }
    }
    this._setEnvs(v);

    // ── pitch ──
    const glide = v[I.glide];
    if (this.glideOff !== 0) {
      if (glide <= 0) this.glideOff = 0;
      else {
        if (glide !== this.glideT) { this.glideT = glide; this.glideCoef = Math.exp(-(3 * CR) / (glide * sr)); }
        this.glideOff *= this.glideCoef;
        if (this.glideOff < 1e-4 && this.glideOff > -1e-4) this.glideOff = 0;
      }
    }
    let vibCents = 0;
    const vd = v[I.vibDelay];
    let vf = vd > 0 ? age / vd : 1;
    if (vf > 1) vf = 1;
    const depth = v[I.vibDepth] * vf * vf + v[I.vibWheel] * ctx.ctlWheel;
    this.vibPhase += (v[I.vibRate] * CR) / sr;
    if (this.vibPhase >= 1) this.vibPhase -= Math.floor(this.vibPhase);
    if (depth > 0) vibCents = depth * Math.sin(PI2 * this.vibPhase);
    let pitch = this.note + this.glideOff + v[I.pitch] + ctx.ctlBend * v[I.bendRange] + vibCents * 0.01;
    if (pitch < -36) pitch = -36; else if (pitch > 150) pitch = 150;
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    this.freq = freq;
    this.cutNote = this.note + this.glideOff;
    // engines read the block pitch from a field (render()): a double call argument would be boxed per call
    const eng = this.engines;
    for (let s = 0; s < NSRC; s++) eng[s].freqIn = freq;

    // ── pending engine events ──
    if (pend !== P_NONE) {
      const legato = pend === P_LEGATO;
      for (let s = 0; s < NSRC; s++) {
        if (v[SRC_ON[s]] >= 0.5) {
          eng[s].noteOn(this.note, this.vel, this.freq, v, legato && this.started[s] === 1);
          this.started[s] = 1;
        } else if (pend === P_START) {
          this.started[s] = 0;
        }
      }
      if (pend === P_START) { this.g0.fill(0); this.g1.fill(0); } // (targets are jumped to below)
      this.pending = P_NONE;
      this.controlled = true;
    }
    // (min gate ≈3 ms: a note released within the same block as its note-on still speaks)
    if (this.pendingRelease && this.ageSamples >= this.minGate) {
      this.pendingRelease = false;
      this.aenv.gateOff(); this.fenv.gateOff(); this.menv.gateOff();
      for (let s = 0; s < NSRC; s++) if (this.started[s]) eng[s].noteOff();
    }

    // ── source gains (smoothed; see SMOOTH_SEC) ──
    const g0 = this.g0, g1 = this.g1;
    const fresh = pend === P_START;
    const kS = this.kSm;
    let filtUsed = false;
    for (let s = 0; s < NSRC; s++) {
      const b = s * 4;
      g0[b] = g1[b]; g0[b + 1] = g1[b + 1]; g0[b + 2] = g1[b + 2]; g0[b + 3] = g1[b + 3];
      let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
      const on = v[SRC_ON[s]] >= 0.5;
      if (on && !this.started[s] && this.gate) {
        // enabled while the note is held: start it now (gain ramps up from 0)
        eng[s].noteOn(this.note, this.vel, this.freq, v, false);
        this.started[s] = 1;
      }
      if (on && this.started[s]) {
        let lvl = v[SRC_LVL[s]];
        if (s === S_PHYS) lvl *= PHYS_TRIM[v[I_PHYS_EXC] & 3];
        const pan = v[SRC_PAN[s]];
        if (pan !== this.panCache[s]) {
          this.panCache[s] = pan;
          const a = ((pan < -1 ? -1 : pan > 1 ? 1 : pan) + 1) * 0.25 * Math.PI;
          this.panL[s] = Math.cos(a) * Math.SQRT2;
          this.panR[s] = Math.sin(a) * Math.SQRT2;
        }
        let filt = v[SRC_FILT[s]];
        filt = filt < 0 ? 0 : filt > 1 ? 1 : filt;
        const gl = lvl * this.panL[s], gr = lvl * this.panR[s];
        t0 = gl * filt; t1 = gr * filt;
        t2 = gl * (1 - filt); t3 = gr * (1 - filt);
      }
      if (fresh) {
        g0[b] = g1[b] = t0; g0[b + 1] = g1[b + 1] = t1; g0[b + 2] = g1[b + 2] = t2; g0[b + 3] = g1[b + 3] = t3;
      } else {
        let x = g1[b] + (t0 - g1[b]) * kS; g1[b] = x - t0 < SNAP && t0 - x < SNAP ? t0 : x;
        x = g1[b + 1] + (t1 - g1[b + 1]) * kS; g1[b + 1] = x - t1 < SNAP && t1 - x < SNAP ? t1 : x;
        x = g1[b + 2] + (t2 - g1[b + 2]) * kS; g1[b + 2] = x - t2 < SNAP && t2 - x < SNAP ? t2 : x;
        x = g1[b + 3] + (t3 - g1[b + 3]) * kS; g1[b + 3] = x - t3 < SNAP && t3 - x < SNAP ? t3 : x;
      }
      const active = g0[b] + g0[b + 1] + g0[b + 2] + g0[b + 3] + g1[b] + g1[b + 1] + g1[b + 2] + g1[b + 3] > 0;
      this.proc[s] = this.started[s] && active ? 1 : 0;
      if (!on && !active && this.started[s]) { this.started[s] = 0; } // fully faded out after disable
      if (this.proc[s] && (g0[b] + g0[b + 1] + g1[b] + g1[b + 1]) > 0) filtUsed = true;
    }

    // ── filter ──
    if (filtUsed) {
      if (this.filtIdle >= this.filtIdleLimit) { this.filter.reset(); this.filter2.reset(); this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0; }
      this.filtIdle = 0;
    } else if (this.filtIdle < 1e9) this.filtIdle++;
    const fenvAmt = v[I.fEnv];
    const lb = Math.log2(v[I.fCut]);
    if (fresh || !(this.lcS === this.lcS)) this.lcS = lb;
    else { const x = this.lcS + (lb - this.lcS) * kS; this.lcS = x - lb < 1e-5 && lb - x < 1e-5 ? lb : x; }
    let lc = this.lcS
      + v[I.fKey] * (this.cutNote - 60) / 12
      + fenvAmt * 6 * src[S_FENV]
      + v[I.fVel] * 3 * this.vel
      + cutMod * LOG2_1000;
    let cut = Math.pow(2, lc);
    const maxCut = 0.45 * sr;
    if (cut < 20) cut = 20; else if (cut > maxCut) cut = maxCut;
    if (this.cut1 !== this.cut1) this.cut1 = cut; // NaN → first block
    this.cut0 = this.cut1;
    this.cut1 = cut;
    this.fType = v[I.fType] | 0;
    const tRes = v[I.fRes], tDrive = v[I.fDrive], tVowel = v[I.fVowel];
    let c2 = v[I.f2Cut];
    if (c2 > maxCut) c2 = maxCut;
    const l2 = Math.log2(c2 > 1 ? c2 : 1), tRes2 = v[I.f2Res];
    const m2 = (v[I.f2Type] | 0) - 1;
    this.f2Mode = m2;
    if (m2 >= 0) this.f2Run = m2;
    const fOnT = v[I.fOn] >= 0.5 ? 1 : 0, f2OnT = m2 >= 0 ? 1 : 0;
    if (fresh) {
      this.fRes = tRes; this.fDrive = tDrive; this.fVowel = tVowel; this.l2S = l2; this.f2Res = tRes2;
      this.fMix0 = this.fMix1 = fOnT; this.f2Mix0 = this.f2Mix1 = f2OnT;
    } else {
      this.fRes += (tRes - this.fRes) * kS; this.fDrive += (tDrive - this.fDrive) * kS;
      this.fVowel += (tVowel - this.fVowel) * kS; this.l2S += (l2 - this.l2S) * kS; this.f2Res += (tRes2 - this.f2Res) * kS;
      const st = this.fMixStep;
      this.fMix0 = this.fMix1;
      if (fOnT > this.fMix1) this.fMix1 = Math.min(1, this.fMix1 + st);
      else if (fOnT < this.fMix1) this.fMix1 = Math.max(0, this.fMix1 - st);
      this.f2Mix0 = this.f2Mix1;
      if (f2OnT > this.f2Mix1) this.f2Mix1 = Math.min(1, this.f2Mix1 + st);
      else if (f2OnT < this.f2Mix1) this.f2Mix1 = Math.max(0, this.f2Mix1 - st);
    }
    this.f2Cut = Math.pow(2, this.l2S);
    // a filter that has faded out restarts from a clean state when faded back in
    if (this.fMix0 === 0 && this.fMix1 === 0) { if (!this.fParked) { this.filter.reset(); this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0; this.fParked = true; } } else this.fParked = false;
    if (this.f2Mix0 === 0 && this.f2Mix1 === 0) { if (!this.f2Parked) { this.filter2.reset(); this.f2Parked = true; } } else this.f2Parked = false;

    // ── amp gain + pan ──
    const lvlDb = v[I.ampLevel];
    const velG = 1 + (this.velPow - 1) * v[I.ampVel];
    const gain = VOICE_GAIN * Math.pow(10, lvlDb * 0.05) * velG;
    let pan = v[I.ampPan] + v[I.spread] * this.spreadPos;
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    if (pan !== this.ampPanCache) {
      this.ampPanCache = pan;
      const a = (pan + 1) * 0.25 * Math.PI;
      this.apL = Math.cos(a) * Math.SQRT2;
      this.apR = Math.sin(a) * Math.SQRT2;
    }
    const aTL = gain * this.apL, aTR = gain * this.apR;
    if (fresh) { this.a0L = this.a1L = aTL; this.a0R = this.a1R = aTR; }
    else {
      this.a0L = this.a1L; this.a0R = this.a1R;
      let x = this.a1L + (aTL - this.a1L) * kS; this.a1L = x - aTL < SNAP && aTL - x < SNAP ? aTL : x;
      x = this.a1R + (aTR - this.a1R) * kS; this.a1R = x - aTR < SNAP && aTR - x < SNAP ? aTR : x;
    }

    this.ageSamples += CR;
    this.blockEnergy = 0;
  }

  _setEnvs(v) {
    this.aenv.setFrom(v, ENV_IDS[0]);
    this.fenv.setFrom(v, ENV_IDS[1]);
    this.menv.setFrom(v, ENV_IDS[2]);
  }

  // ───────────── audio ─────────────

  /**
   * Render samples [bpos, bpos+len) of the current control block, ADDING into outL/outR[off..off+len).
   * Returns true while the voice stays allocated.
   */
  render(outL, outR, off, len, bpos) {
    if (!this.controlled) return this.active;
    const v = this.v;
    const tL = this.tL, tR = this.tR, fL = this.fL, fR = this.fR, dL = this.dL, dR = this.dR;
    const filterLive = this.filtIdle < this.filtIdleLimit;
    for (let i = 0; i < len; i++) { fL[i] = 0; fR[i] = 0; dL[i] = 0; dR[i] = 0; }
    const invCR = 1 / CR;
    const g0 = this.g0, g1 = this.g1;
    for (let s = 0; s < NSRC; s++) {
      if (!this.proc[s]) continue;
      this.engines[s].render(v, tL, tR, 0, len);
      const b = s * 4;
      const sFL = (g1[b] - g0[b]) * invCR, sFR = (g1[b + 1] - g0[b + 1]) * invCR;
      const sDL = (g1[b + 2] - g0[b + 2]) * invCR, sDR = (g1[b + 3] - g0[b + 3]) * invCR;
      let gfl = g0[b] + sFL * bpos, gfr = g0[b + 1] + sFR * bpos;
      let gdl = g0[b + 2] + sDL * bpos, gdr = g0[b + 3] + sDR * bpos;
      if (filterLive) {
        for (let i = 0; i < len; i++) {
          const xl = tL[i], xr = tR[i];
          fL[i] += xl * gfl; fR[i] += xr * gfr; dL[i] += xl * gdl; dR[i] += xr * gdr;
          gfl += sFL; gfr += sFR; gdl += sDL; gdr += sDR;
        }
      } else {
        for (let i = 0; i < len; i++) {
          dL[i] += tL[i] * gdl; dR[i] += tR[i] * gdr;
          gdl += sDL; gdr += sDR;
        }
      }
    }

    if (filterLive) {
      const xL = this.xL, xR = this.xR;
      const m0 = this.fMix0, m1 = this.fMix1;
      if (m0 > 0 || m1 > 0) {
        const xf = m0 < 1 || m1 < 1; // on ↔ off crossfade: keep a dry copy
        if (xf) for (let i = 0; i < len; i++) { xL[i] = fL[i]; xR[i] = fR[i]; }
        let c0 = this.cut0, c1 = this.cut1;
        if (bpos !== 0 || len !== CR) {
          const r = this.cut1 / this.cut0;
          c0 = this.cut0 * Math.pow(r, bpos * invCR);
          c1 = this.cut0 * Math.pow(r, (bpos + len) * invCR);
        }
        // numeric block params through the filter's input array (allocation-free; see VoiceFilter.run)
        const fi = this.filter.inp;
        fi[0] = c0; fi[1] = c1; fi[2] = this.fRes; fi[3] = this.fDrive; fi[4] = this.fVowel;
        this.filter.run(fL, fR, 0, len, this.fType);
        {
          const r = this.dcR;
          let xl = this.dcxL, yl = this.dcyL, xr = this.dcxR, yr = this.dcyR;
          for (let i = 0; i < len; i++) {
            const a = fL[i], b = fR[i];
            yl = a - xl + r * yl; xl = a; fL[i] = yl;
            yr = b - xr + r * yr; xr = b; fR[i] = yr;
          }
          if (yl < 1e-25 && yl > -1e-25) yl = 0;
          if (yr < 1e-25 && yr > -1e-25) yr = 0;
          this.dcxL = xl; this.dcyL = yl; this.dcxR = xr; this.dcyR = yr;
        }
        if (xf) {
          const dm = (m1 - m0) * invCR;
          let m = m0 + dm * bpos;
          for (let i = 0; i < len; i++) { m += dm; fL[i] = xL[i] + (fL[i] - xL[i]) * m; fR[i] = xR[i] + (fR[i] - xR[i]) * m; }
        }
      }
      const n0 = this.f2Mix0, n1 = this.f2Mix1;
      if (n0 > 0 || n1 > 0) {
        const xf = n0 < 1 || n1 < 1;
        if (xf) for (let i = 0; i < len; i++) { xL[i] = fL[i]; xR[i] = fR[i]; }
        const f2 = this.filter2, fi2 = f2.inp;
        fi2[0] = this.f2Cut; fi2[1] = this.f2Res;
        f2.run(fL, fR, 0, len, this.f2Run);
        if (xf) {
          const dm = (n1 - n0) * invCR;
          let m = n0 + dm * bpos;
          for (let i = 0; i < len; i++) { m += dm; fL[i] = xL[i] + (fL[i] - xL[i]) * m; fR[i] = xR[i] + (fR[i] - xR[i]) * m; }
        }
      }
      for (let i = 0; i < len; i++) { dL[i] += fL[i]; dR[i] += fR[i]; }
    }

    const env = this.envBuf;
    this.aenv.process(env, 0, len);
    const sL = (this.a1L - this.a0L) * invCR, sR = (this.a1R - this.a0R) * invCR;
    let gl = this.a0L + sL * bpos, gr = this.a0R + sR * bpos;
    let energy = 0;
    if (this.fading) {
      let t = this.fadeT, fg = this.fadeGain;
      const fs = this.fadeStep;
      for (let i = 0; i < len; i++) {
        t += fs;
        if (t > 1) t = 1;
        fg = 1 - t * t * (3 - 2 * t);
        const e = env[i] * fg;
        const l = dL[i] * e * gl, r = dR[i] * e * gr;
        outL[off + i] += l; outR[off + i] += r;
        energy += l * l + r * r;
        gl += sL; gr += sR;
      }
      this.fadeT = t;
      this.fadeGain = fg;
    } else {
      for (let i = 0; i < len; i++) {
        const e = env[i];
        const l = dL[i] * e * gl, r = dR[i] * e * gr;
        outL[off + i] += l; outR[off + i] += r;
        energy += l * l + r * r;
        gl += sL; gr += sR;
      }
    }
    this.blockEnergy += energy;

    if (bpos + len >= CR) return this._endOfBlock();
    return this.active;
  }

  /** Voice lifetime checks at the end of each control block. */
  _endOfBlock() {
    const e = this.blockEnergy;
    if (!(e === e) || e === Infinity) { this.hardStop(); return false; } // NaN/Inf guard
    if (this.fading && this.fadeGain <= 0) { this.hardStop(); return false; }
    if (this.aenv.done && this.pending === P_NONE) {
      // amp envelope finished → voice is silent
      this.active = false; this.gate = false;
      for (let s = 0; s < NSRC; s++) this.started[s] = 0;
      return false;
    }
    // engines rung out (e.g. plucked phys / one-shot noise) and output silent → free early
    let anyActive = false;
    for (let s = 0; s < NSRC; s++) {
      if (this.started[s] && this.engines[s].isActive()) { anyActive = true; break; }
    }
    if (!anyActive && e < 1e-12 && this.aenv.stage !== ENV_ATTACK) {
      if (++this.silentBlocks > 48) {
        this.active = false; this.gate = false;
        for (let s = 0; s < NSRC; s++) this.started[s] = 0;
        this.aenv.reset(); this.fenv.reset(); this.menv.reset();
        return false;
      }
    } else this.silentBlocks = 0;
    return true;
  }
}
