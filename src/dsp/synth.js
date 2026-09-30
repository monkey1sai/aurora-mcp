// Synth: voices, allocation, macros, mod-matrix tables, performance layer, sequencer, FX chain, limiter.
// Pure ES module (AudioWorklet + Node safe). The audio path (process) is allocation-free.
//
//   notes ─▶ Performance (scale → chord → arp) ─▶ voice allocator ─▶ Σ voices ─▶ FxChain ─▶ master ─▶ Limiter
//
// Parameter values: `base` = patch values, `eff` = base + macros (recomputed only when something changed),
// each voice holds `v` = eff + per-voice modulation. See docs/ARCHITECTURE.md §2, §3, §6.

import {
  PARAMS, PARAM_COUNT, PARAM_BY_ID, idx, toNumeric, fromNumeric, resolveParams, toValueArray,
  MOD_DESTS, MOD_SLOTS, MOD_SOURCES,
} from './params.js';
import { CR, onePoleCoef } from './util.js';
import { Voice, normTo, denormTo, spreadPosition, SYNC_BEATS } from './voice.js';
import { ENV_ATTACK } from './env.js';
import { Lfo } from './lfo.js';
import { Performance } from './performance.js';
import { Sequencer } from './sequencer.js';
import { FxChain } from './fx/fxchain.js';
import { Limiter } from './fx/limiter.js';

export const MAX_POLY = 16;
const POOL_SIZE = MAX_POLY + 4;  // spare voices: a stolen voice fades out while the new note starts at once
const QMAX = MAX_POLY;           // deferred note starts (pool exhausted by fading voices: wait ≤ 2 ms for one)
const MAX_BLOCK = 128;
const MAX_MACRO_TARGETS = 64;

const MODE_POLY = 0, MODE_MONO = 1, MODE_LEGATO = 2;

const MOD_DEST_PARAM = Int32Array.from(MOD_DESTS.map(d => (d === 'none' ? -1 : idx(d))));
const I_MACRO = [idx('macro1'), idx('macro2'), idx('macro3'), idx('macro4')];
const I_MOD_SRC = [], I_MOD_DST = [], I_MOD_AMT = [];
for (let k = 1; k <= MOD_SLOTS; k++) {
  I_MOD_SRC.push(idx(`mod${k}.src`)); I_MOD_DST.push(idx(`mod${k}.dst`)); I_MOD_AMT.push(idx(`mod${k}.amt`));
}
const I_BPM = idx('global.bpm');
const I_MASTER = idx('master.volume');
const I_MODE = idx('voice.mode');
const I_POLY = idx('voice.poly');
const I_GLIDE = idx('voice.glide');
const LFO_G = ['lfo1', 'lfo2'].map(l => ({
  shape: idx(`${l}.shape`), rate: idx(`${l}.rate`), sync: idx(`${l}.sync`), phase: idx(`${l}.phase`), mode: idx(`${l}.mode`),
}));
// Mod sources that exist once for the whole synth (not per voice): they can modulate a global (mono) LFO's rate.
// Per-voice sources (envelopes, velocity, key, random, poly LFOs) cannot — there is only one global LFO.
const MS_LFO1 = MOD_SOURCES.indexOf('lfo1'), MS_LFO2 = MOD_SOURCES.indexOf('lfo2');
const MS_WHEEL = MOD_SOURCES.indexOf('wheel'), MS_AT = MOD_SOURCES.indexOf('aftertouch'), MS_BEND = MOD_SOURCES.indexOf('bend');

export class Synth {
  constructor(sampleRate, { seed = 1 } = {}) {
    this.sampleRate = sampleRate;
    this.sr = sampleRate;
    this.seed = seed >>> 0 || 1;

    this.base = toValueArray(resolveParams());
    this.eff = new Float64Array(PARAM_COUNT);
    this.eff.set(this.base);
    this.effVersion = 0;
    this.effDirty = true;
    this.bpm = this.base[I_BPM];

    // macros: flat target table + unique-param list
    this.macroNames = ['Macro 1', 'Macro 2', 'Macro 3', 'Macro 4'];
    this.mtN = 0;
    this.mtMacro = new Int32Array(MAX_MACRO_TARGETS);
    this.mtAmt = new Float64Array(MAX_MACRO_TARGETS);
    this.mtU = new Int32Array(MAX_MACRO_TARGETS);
    this.mtUniq = new Int32Array(MAX_MACRO_TARGETS);
    this.mtUniqN = 0;
    this.mtAcc = new Float64Array(MAX_MACRO_TARGETS);

    // mod matrix tables (read by voices every control block)
    this.modN = 0;
    this.modSrc = new Int32Array(MOD_SLOTS);
    this.modDstU = new Int32Array(MOD_SLOTS);
    this.modAmt = new Float64Array(MOD_SLOTS);
    this.modUniq = new Int32Array(MOD_SLOTS);
    this.modUniqN = 0;
    this.modNormEff = new Float64Array(MOD_SLOTS);

    // controllers (targets + control-rate smoothed values read by voices)
    this.tWheel = 0; this.tAt = 0; this.tBend = 0;
    this.ctlWheel = 0; this.ctlAt = 0; this.ctlBend = 0;
    this.ctlCoef = 1 - Math.exp(-CR / (0.006 * sampleRate));

    // global (mono) LFOs + beat clock
    this.monoLfoObj = [new Lfo(sampleRate, (this.seed * 0x2545f491) >>> 0 || 13, CR), new Lfo(sampleRate, (this.seed * 0x9e3779b1) >>> 0 || 17, CR)];
    this.monoLfo = new Float64Array(2);
    this.monoRateScr = new Float64Array(2); // [normalised rate, Hz] (no double crosses a call boundary)
    this.clockBeat = 0;

    // voices
    this.voices = [];
    for (let i = 0; i < POOL_SIZE; i++) this.voices.push(new Voice(sampleRate, this, i, this.seed));
    this.serial = 0;
    this.droppedNotes = 0; // diagnostics: notes stolen before they sounded (more notes in one block than voice.poly)
    this.voicesCut = 0;    // diagnostics: audible voices cut without a fade (deferred-start queue full)
    // Deferred note starts: when every pool voice is busy (the stolen ones still fading), a new note waits for the
    // first voice to finish its ≈2 ms steal fade instead of cutting a sounding voice (a click) or dropping the note.
    this.qN = 0;
    this.qNote = new Int16Array(QMAX); this.qVel = new Float32Array(QMAX); this.qFrom = new Float64Array(QMAX);
    this.qSpread = new Float64Array(QMAX); this.qSerial = new Float64Array(QMAX); this.qRel = new Uint8Array(QMAX);
    this.spreadCounter = 0;
    this.lastNote = NaN;
    this.refCount = new Uint8Array(128);
    this.voiceMode = MODE_POLY;
    this.monoVoice = null;
    this.stackNote = new Int16Array(128);
    this.stackVel = new Float32Array(128);
    this.stackLen = 0;

    // performance layer (closures created once, here)
    this.perf = new Performance(sampleRate, {
      voiceOn: (n, v) => this._voiceOn(n, v),
      voiceOff: n => this._voiceOff(n),
    }, this.seed);
    this.sequencer = new Sequencer(this);

    // output chain
    this.fx = new FxChain(sampleRate);
    this.limiter = new Limiter(sampleRate, { ceilingDb: -0.3, lookaheadMs: 1.5 });
    this.bufL = new Float32Array(MAX_BLOCK);
    this.bufR = new Float32Array(MAX_BLOCK);
    this.cpos = 0;
    this.masterGain = Math.pow(10, this.base[I_MASTER] / 20);
    this.idleSamples = 0;
    this.idleAfter = Math.round(0.05 * sampleRate); // 50 ms of silence (≫ limiter lookahead) → bypass
    this.masterCoef = onePoleCoef(0.015, sampleRate);
    // panic: 0 idle, 1 fading out, 2 fading back in
    this.panicStage = 0;
    this.panicGain = 1;
    this.panicStep = 1 / (0.005 * sampleRate);

    // meters (since last getState)
    this.mPeakL = 0; this.mPeakR = 0; this.mSumL = 0; this.mSumR = 0; this.mCount = 0;
    this.cpuLoad = 0;

    // reusable state object
    this._vsPool = [];
    for (let i = 0; i < POOL_SIZE; i++) this._vsPool.push({ note: 0, velocity: 0, level: 0, stage: 'idle', age: 0, index: i });
    this._state = {
      voices: [], peak: [0, 0], rms: [0, 0], held: [], arpStep: -1, beat: 0, bpm: 110,
      reduction: 0, cpuLoad: 0, activeVoices: 0, macros: [0, 0, 0, 0],
      // newest voice's modulation state (UI playheads: envelope editors, LFO view, filter view)
      focus: {
        active: false, note: 0, cutoff: 0, lfo1: 0, lfo2: 0,
        aenv: 0, aenvStage: 'idle', fenv: 0, fenvStage: 'idle', menv: 0, menvStage: 'idle',
      },
    };

    this._recomputeEff();
    this.perf.update(this.eff);
  }

  // ───────────────────────── parameters ─────────────────────────

  /** Load a patch: { params: {id: native}, macros: [{name, targets:[{id, amount}]}] }. Global-scope params untouched. */
  loadPatch(patch) {
    const params = (patch && patch.params) || {};
    for (let i = 0; i < PARAM_COUNT; i++) {
      const p = PARAMS[i];
      if (p.scope === 'global') continue;
      const val = params[p.id];
      this.base[i] = toNumeric(p, val !== undefined ? val : p.def);
    }
    this._setMacros(patch && patch.macros);
    this.effDirty = true;
    // quick (click-free) fade of sounding voices: engines/filters may change type
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      if (!v.controlled) v.hardStop(); else if (!v.fading) v.startFade(0.006);
    }
    this.refCount.fill(0);
    this.stackLen = 0;
    this.monoVoice = null;
    this.qN = 0;
    this._sync();
  }

  _setMacros(macros) {
    this.mtN = 0; this.mtUniqN = 0;
    for (let m = 0; m < 4; m++) {
      const mac = macros && macros[m];
      this.macroNames[m] = (mac && mac.name) || `Macro ${m + 1}`;
      if (!mac || !Array.isArray(mac.targets)) continue;
      for (const t of mac.targets) {
        const p = t && PARAM_BY_ID[t.id];
        if (!p || (p.type !== 'float' && p.type !== 'int') || p.group === 'macro') continue;
        const amt = Number(t.amount);
        if (!Number.isFinite(amt) || amt === 0 || this.mtN >= MAX_MACRO_TARGETS) continue;
        let u = 0;
        while (u < this.mtUniqN && this.mtUniq[u] !== p.index) u++;
        if (u === this.mtUniqN) this.mtUniq[this.mtUniqN++] = p.index;
        this.mtMacro[this.mtN] = m;
        this.mtAmt[this.mtN] = amt < -1 ? -1 : amt > 1 ? 1 : amt;
        this.mtU[this.mtN] = u;
        this.mtN++;
      }
    }
  }

  /** Macro definitions of the loaded patch (for UI): [{name, targets:[{id, amount}]}×4]. */
  getMacros() {
    const out = [];
    for (let m = 0; m < 4; m++) out.push({ name: this.macroNames[m], targets: [] });
    for (let k = 0; k < this.mtN; k++) {
      out[this.mtMacro[k]].targets.push({ id: PARAMS[this.mtUniq[this.mtU[k]]].id, amount: this.mtAmt[k] });
    }
    return out;
  }

  /** Set a param by id (enum by option id or index, bool by boolean or 0/1). Returns false for unknown ids. */
  setParam(id, value) {
    const p = PARAM_BY_ID[id];
    if (!p) return false;
    this._setParamIndex(p.index, toNumeric(p, value));
    return true;
  }

  /** Numeric (DSP-encoded) write by index — used by the sequencer ramps. */
  _setParamIndex(i, x) {
    if (this.base[i] !== x) { this.base[i] = x; this.effDirty = true; }
  }

  setParams(obj) {
    if (!obj) return;
    for (const k in obj) this.setParam(k, obj[k]);
  }

  /** Native value (base, i.e. without macros). */
  getParam(id) {
    const p = PARAM_BY_ID[id];
    if (!p) return undefined;
    return fromNumeric(p, this.base[p.index]);
  }

  /** Native effective value (base + macros). */
  getEffective(id) {
    const p = PARAM_BY_ID[id];
    if (!p) return undefined;
    if (this.effDirty) this._recomputeEff();
    return fromNumeric(p, this.eff[p.index]);
  }

  /** All base params as a native object (patch + global). */
  getParams() {
    const out = {};
    for (let i = 0; i < PARAM_COUNT; i++) out[PARAMS[i].id] = fromNumeric(PARAMS[i], this.base[i]);
    return out;
  }

  setMacro(i, value) {
    if (!(i >= 0 && i < 4)) return;
    this._setParamIndex(I_MACRO[i | 0], toNumeric(PARAMS[I_MACRO[i | 0]], value));
  }

  _recomputeEff() {
    const base = this.base, eff = this.eff;
    eff.set(base);
    // macros: eff_norm = clamp01(base_norm + Σ amount·macro)
    if (this.mtN > 0) {
      const acc = this.mtAcc;
      for (let u = 0; u < this.mtUniqN; u++) normTo(acc, u, this.mtUniq[u], base, this.mtUniq[u]);
      for (let k = 0; k < this.mtN; k++) acc[this.mtU[k]] += this.mtAmt[k] * base[I_MACRO[this.mtMacro[k]]];
      for (let u = 0; u < this.mtUniqN; u++) {
        const pi = this.mtUniq[u];
        denormTo(eff, pi, pi, acc, u);
      }
    }
    // mod matrix tables
    let n = 0, un = 0;
    for (let k = 0; k < MOD_SLOTS; k++) {
      const s = eff[I_MOD_SRC[k]] | 0, d = eff[I_MOD_DST[k]] | 0, a = eff[I_MOD_AMT[k]];
      if (s <= 0 || d <= 0 || a === 0) continue;
      const pi = MOD_DEST_PARAM[d];
      if (pi < 0) continue;
      let u = 0;
      while (u < un && this.modUniq[u] !== pi) u++;
      if (u === un) this.modUniq[un++] = pi;
      this.modSrc[n] = s; this.modDstU[n] = u; this.modAmt[n] = a;
      n++;
    }
    this.modN = n; this.modUniqN = un;
    for (let u = 0; u < un; u++) normTo(this.modNormEff, u, this.modUniq[u], eff, this.modUniq[u]);
    this.bpm = eff[I_BPM];
    this.effVersion++;
    this.effDirty = false;
  }

  /** Bring eff + performance config + voice mode up to date (cheap when nothing changed). */
  _sync() {
    if (this.effDirty) this._recomputeEff();
    const mode = this.eff[I_MODE] | 0;
    if (mode !== this.voiceMode) {
      this.voiceMode = mode;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.active && v.gate) v.release(++this.serial);
      }
      this.refCount.fill(0);
      this.stackLen = 0;
      this.monoVoice = null;
      this.qN = 0;
    }
    this.perf.update(this.eff);
  }

  // ───────────────────────── notes ─────────────────────────

  noteOn(note, velocity = 0.8) {
    this._sync();
    this.perf.noteOn(note, velocity);
  }

  noteOff(note) {
    this._sync();
    this.perf.noteOff(note);
  }

  /** kind: 'wheel' 0..1 | 'aftertouch' 0..1 | 'bend' -1..1 | 'sustain' 0|1 */
  setController(kind, value) {
    value = Number(value);
    if (!Number.isFinite(value)) value = 0;
    switch (kind) {
      case 'wheel': case 'modwheel': this.tWheel = value < 0 ? 0 : value > 1 ? 1 : value; break;
      case 'aftertouch': case 'pressure': this.tAt = value < 0 ? 0 : value > 1 ? 1 : value; break;
      case 'bend': case 'pitchbend': this.tBend = value < -1 ? -1 : value > 1 ? 1 : value; break;
      case 'sustain': this.perf.setSustain(value >= 0.5); break;
    }
  }

  /** Release everything. hard: silence immediately (≈3–5 ms fades, FX tails cleared, sequencer stopped). */
  allNotesOff(hard = false) {
    if (hard) this.sequencer.stop();
    this.perf.allOff();
    this.refCount.fill(0);
    this.stackLen = 0;
    this.monoVoice = null;
    this.qN = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      if (hard) { if (!v.controlled) v.hardStop(); else if (!v.fading) v.startFade(0.003); }
      else v.release(++this.serial);
    }
    if (hard) {
      this.tBend = 0; this.ctlBend = 0;
      this.panicStage = 1;
    }
  }

  // voice layer (called by the performance layer)
  _voiceOn(note, vel) {
    if (this.refCount[note] < 255) this.refCount[note]++;
    const glide = this.eff[I_GLIDE];
    if (this.voiceMode === MODE_POLY) {
      // re-striking a sounding note: release the old voice, start a fresh one
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.active && v.gate && v.note === note && !v.fading) v.release(++this.serial);
      }
      if (this.qN > 0) this._unqueue(note); // (a deferred start of the same note never sounded: replaced)
      const v = this._allocVoice(true);
      const from = glide > 0 && this.lastNote === this.lastNote ? this.lastNote : NaN;
      const sp = spreadPosition(this.spreadCounter++);
      if (v) v.start(note, vel, from, sp, ++this.serial);
      else { // every voice busy: start as soon as a stolen voice has faded out (≤ ≈2 ms)
        const k = this.qN++;
        this.qNote[k] = note; this.qVel[k] = vel; this.qFrom[k] = from; this.qSpread[k] = sp;
        this.qSerial[k] = ++this.serial; this.qRel[k] = 0;
      }
    } else {
      this._stackRemove(note);
      if (this.stackLen < 128) { this.stackNote[this.stackLen] = note; this.stackVel[this.stackLen] = vel; this.stackLen++; }
      this._monoPlay(note, vel);
    }
    this.lastNote = note;
  }

  _voiceOff(note) {
    if (this.refCount[note] === 0) return;
    if (--this.refCount[note] > 0) return;
    if (this.voiceMode === MODE_POLY) {
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.active && v.gate && v.note === note) v.release(++this.serial);
      }
      for (let k = 0; k < this.qN; k++) if (this.qNote[k] === note) this.qRel[k] = 1; // (starts, then releases)
    } else {
      const wasTop = this.stackLen > 0 && this.stackNote[this.stackLen - 1] === note;
      this._stackRemove(note);
      const mv = this.monoVoice;
      if (this.stackLen === 0) {
        if (mv && mv.active) mv.release(++this.serial);
      } else if (wasTop) {
        const n = this.stackNote[this.stackLen - 1];
        this._monoPlay(n, this.stackVel[this.stackLen - 1]);
        this.lastNote = n;
      }
    }
  }

  _stackRemove(note) {
    let w = 0;
    for (let r = 0; r < this.stackLen; r++) {
      if (this.stackNote[r] === note) continue;
      this.stackNote[w] = this.stackNote[r]; this.stackVel[w] = this.stackVel[r]; w++;
    }
    this.stackLen = w;
  }

  _monoPlay(note, vel) {
    const mv = this.monoVoice;
    if (mv && mv.active && !mv.fading) {
      const legato = this.voiceMode === MODE_LEGATO && mv.gate;
      mv.retrigger(note, vel, legato, ++this.serial);
      return;
    }
    const glide = this.eff[I_GLIDE];
    const v = this._allocVoice();
    const from = glide > 0 && this.lastNote === this.lastNote ? this.lastNote : NaN;
    v.start(note, vel, from, spreadPosition(this.spreadCounter++), ++this.serial);
    this.monoVoice = v;
  }

  /** A free voice (stealing per voice.poly first). canDefer: return null instead of cutting a sounding voice. */
  _allocVoice(canDefer = false) {
    const voices = this.voices;
    const poly = this.voiceMode === MODE_POLY ? Math.max(1, Math.min(MAX_POLY, this.eff[I_POLY] | 0)) : 1;
    let free = null, count = this.qN; // (deferred starts count as sounding notes)
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (!v.active) { if (!free) free = v; } else if (!v.fading) count++;
    }
    while (count >= poly) {
      const victim = this._pickVictim();
      if (!victim) break;
      if (!victim.controlled) { this.droppedNotes++; victim.hardStop(); if (!free) free = victim; }
      else victim.startFade(0.002);
      count--;
    }
    if (!free) {
      // Pool exhausted by fading (stolen) voices: defer the start until one has faded (see _drainQueue) …
      if (canDefer && this.qN < QMAX) return null;
      // … or, with the queue full, cut the quietest fading voice short (a click). Never a voice whose note-on
      // has not rendered yet (level 0 only because it has not started): that would drop a new note.
      let best = null, bl = Infinity;
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (!v.fading) continue;
        const l = v.level; // aenv level × fade gain
        if (l < bl) { bl = l; best = v; }
      }
      if (!best) best = this._pickVictim(); // (defensive: no fading voice → normal steal order)
      if (!best.controlled) this.droppedNotes++;
      else if (best.level > 1e-3) this.voicesCut++;
      best.hardStop();
      free = best;
    }
    return free;
  }

  /** Remove deferred starts of `note` from the queue. */
  _unqueue(note) {
    let w = 0;
    for (let k = 0; k < this.qN; k++) {
      if (this.qNote[k] === note) continue;
      if (w !== k) {
        this.qNote[w] = this.qNote[k]; this.qVel[w] = this.qVel[k]; this.qFrom[w] = this.qFrom[k];
        this.qSpread[w] = this.qSpread[k]; this.qSerial[w] = this.qSerial[k]; this.qRel[w] = this.qRel[k];
      }
      w++;
    }
    this.qN = w;
  }

  /** Start deferred notes on voices freed since (a stolen voice's fade ended). Allocation-free. */
  _drainQueue() {
    const voices = this.voices;
    let w = 0, i = 0;
    for (let k = 0; k < this.qN; k++) {
      while (i < voices.length && voices[i].active) i++;
      if (i >= voices.length) { // still no free voice: keep waiting
        if (w !== k) {
          this.qNote[w] = this.qNote[k]; this.qVel[w] = this.qVel[k]; this.qFrom[w] = this.qFrom[k];
          this.qSpread[w] = this.qSpread[k]; this.qSerial[w] = this.qSerial[k]; this.qRel[w] = this.qRel[k];
        }
        w++;
        continue;
      }
      const v = voices[i];
      v.start(this.qNote[k], this.qVel[k], this.qFrom[k], this.qSpread[k], this.qSerial[k]);
      if (this.qRel[k]) v.release(++this.serial); // released while waiting: still speaks (voice min gate)
    }
    this.qN = w;
  }

  /**
   * Steal order: oldest released voice → quietest held voice (ties → oldest) → oldest not-yet-rendered voice.
   * A held voice still in its attack counts as full level, and a voice whose note-on has not rendered yet
   * (started earlier in this control block, level 0) is not a candidate at all while anything else is: their
   * envelopes have not had time to rise, so "quietest" used to pick the note just played (new chord notes,
   * slow-attack pads, pedal + chord) and keep the old ones. Not-yet-rendered voices are taken only as the last
   * resort (more notes in one block than voice.poly: the latest notes win).
   */
  _pickVictim() {
    const voices = this.voices;
    let rel = null, relSerial = Infinity;
    let quiet = null, quietLevel = Infinity, quietSerial = Infinity;
    let pend = null, pendSerial = Infinity;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (!v.active || v.fading) continue;
      if (!v.controlled) {
        if (v.serial < pendSerial) { pendSerial = v.serial; pend = v; }
      } else if (!v.gate) {
        if (v.releaseSerial < relSerial) { relSerial = v.releaseSerial; rel = v; }
      } else {
        const l = v.aenv.stage === ENV_ATTACK ? 1 : v.aenv.level;
        if (l < quietLevel - 1e-3 || (Math.abs(l - quietLevel) <= 1e-3 && v.serial < quietSerial)) {
          quiet = v; quietLevel = l; quietSerial = v.serial;
        }
      }
    }
    return rel || quiet || pend;
  }

  // ───────────────────────── audio ─────────────────────────

  /** Render n samples (any n). Overwrites outL/outR[0..n). */
  process(outL, outR, n) {
    if (n <= MAX_BLOCK) { this._render(outL, outR, n); return; }
    const bL = this.bufL, bR = this.bufR;
    for (let pos = 0; pos < n; pos += MAX_BLOCK) {
      const len = Math.min(MAX_BLOCK, n - pos);
      this._render(bL, bR, len);
      for (let i = 0; i < len; i++) { outL[pos + i] = bL[i]; outR[pos + i] = bR[i]; }
    }
  }

  _render(L, R, n) {
    for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
    const voices = this.voices, nv = voices.length;
    let pos = 0;
    let anyVoice = false;
    while (pos < n) {
      if (this.cpos === 0) this._control();
      const len = Math.min(CR - this.cpos, n - pos);
      const bpos = this.cpos;
      for (let i = 0; i < nv; i++) {
        const v = voices[i];
        if (v.active) { anyVoice = true; v.render(L, R, pos, len, bpos); }
      }
      this.cpos += len;
      pos += len;
      if (this.cpos >= CR) this.cpos = 0;
    }

    const target = Math.pow(10, this.eff[I_MASTER] / 20);
    // Idle bypass: no voices and no FX tail for a while → the output is silence; skip FX + limiter.
    if (!anyVoice && this.panicStage === 0) {
      if (this.idleSamples < this.idleAfter) {
        const fx = this.fx; // tailActive() is optional in the FxChain contract: without it, never bypass
        if (typeof fx.tailActive !== 'function' || fx.tailActive()) this.idleSamples = 0; else this.idleSamples += n;
      }
    } else this.idleSamples = 0;
    if (this.idleSamples >= this.idleAfter) {
      this.masterGain = target;
      this.mCount += n;
      return;
    }

    // FX chain (reads eff), master volume, limiter
    this.fx.process(L, R, n, this.eff); // bpm from eff[global.bpm] (== this.bpm; no boxed double argument)
    let g = this.masterGain;
    const k = this.masterCoef;
    if (this.panicStage === 0) {
      if (Math.abs(target - g) < 1e-7) {
        g = target;
        for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
      } else {
        for (let i = 0; i < n; i++) { g += (target - g) * k; L[i] *= g; R[i] *= g; }
      }
    } else {
      let pg = this.panicGain;
      const ps = this.panicStep;
      for (let i = 0; i < n; i++) {
        g += (target - g) * k;
        if (this.panicStage === 1) {
          pg -= ps;
          if (pg <= 0) {
            pg = 0;
            this.panicStage = 2;
            this.fx.reset();
          }
        } else if (this.panicStage === 2) {
          pg += ps;
          if (pg >= 1) { pg = 1; this.panicStage = 0; }
        }
        const gg = g * pg;
        L[i] *= gg; R[i] *= gg;
      }
      this.panicGain = pg;
    }
    this.masterGain = g;
    this.limiter.process(L, R, n);

    // safety + meters
    let pl = this.mPeakL, pr = this.mPeakR, sl = 0, sr = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      sl += l * l; sr += r * r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    if (!(sl + sr < Infinity)) {
      // NaN/Inf escaped somewhere: silence and reset the output chain (never propagate garbage)
      for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
      this.fx.reset(); this.limiter.reset();
      sl = 0; sr = 0; pl = this.mPeakL; pr = this.mPeakR;
    }
    this.mPeakL = pl; this.mPeakR = pr;
    this.mSumL += sl; this.mSumR += sr; this.mCount += n;
  }

  _control() {
    this.sequencer.tick(CR);
    this._sync();
    this.perf.bpm = this.bpm;
    this.perf.tick(CR);
    if (this.qN > 0) this._drainQueue();

    const k = this.ctlCoef;
    this.ctlWheel += (this.tWheel - this.ctlWheel) * k;
    this.ctlAt += (this.tAt - this.ctlAt) * k;
    this.ctlBend += (this.tBend - this.ctlBend) * k;
    if (Math.abs(this.ctlBend - this.tBend) < 1e-6) this.ctlBend = this.tBend;

    const eff = this.eff;
    for (let l = 0; l < 2; l++) {
      const G = LFO_G[l];
      const shape = eff[G.shape] | 0;
      const beats = SYNC_BEATS[eff[G.sync] | 0];
      const o = this.monoLfoObj[l];
      if (beats > 0) { o.lockPhase = this.clockBeat / beats + eff[G.phase]; o.lock(shape); }
      else { o.hz = eff[G.rate]; if (this.modN > 0) this._monoRateMod(l); o.advance(CR, shape); }
      this.monoLfo[l] = o.value;
    }
    this.clockBeat += (CR * this.bpm) / (60 * this.sr);

    const voices = this.voices;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.active) v.control();
    }
  }

  /**
   * Global (mono) LFO `l`: add the mod-matrix slots that target its rate from global sources (mod wheel,
   * aftertouch, pitch bend, and the other/same LFO when it is global too) to monoLfoObj[l].hz — e.g. a wheel
   * speeding up a rotary tremolo. Macros already reach it through `eff`. Per-voice sources are ignored here
   * (there is one shared LFO). Normalised additive, like the voice matrix. Allocation-free.
   */
  _monoRateMod(l) {
    const eff = this.eff, G = LFO_G[l];
    if (eff[G.mode] < 0.5) return;
    const un = this.modUniqN, uniq = this.modUniq;
    let u = 0;
    while (u < un && uniq[u] !== G.rate) u++;
    if (u === un) return;
    let s = 0;
    const n = this.modN, src = this.modSrc, dst = this.modDstU, amt = this.modAmt;
    for (let k = 0; k < n; k++) {
      if (dst[k] !== u) continue;
      const sk = src[k];
      let x;
      if (sk === MS_WHEEL) x = this.ctlWheel;
      else if (sk === MS_AT) x = this.ctlAt;
      else if (sk === MS_BEND) x = this.ctlBend;
      else if (sk === MS_LFO1 || sk === MS_LFO2) {
        const j = sk === MS_LFO1 ? 0 : 1;
        if (eff[LFO_G[j].mode] < 0.5) continue;
        x = this.monoLfo[j];
      } else continue;
      s += amt[k] * x;
    }
    if (s === 0) return;
    const S = this.monoRateScr;
    S[0] = this.modNormEff[u] + s;
    denormTo(S, 1, G.rate, S, 0);
    this.monoLfoObj[l].hz = S[1];
  }

  // ───────────────────────── state ─────────────────────────

  /** Cheap snapshot for UI/visuals (objects reused between calls). Resets peak/RMS accumulators. */
  getState() {
    const st = this._state;
    const vs = st.voices;
    let k = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      const o = this._vsPool[k];
      o.note = v.note; o.velocity = v.vel; o.level = v.level; o.stage = v.stageName; o.age = v.age; o.index = i;
      vs[k++] = o;
    }
    vs.length = k;
    st.activeVoices = k;
    st.peak[0] = this.mPeakL; st.peak[1] = this.mPeakR;
    const c = this.mCount || 1;
    st.rms[0] = Math.sqrt(this.mSumL / c); st.rms[1] = Math.sqrt(this.mSumR / c);
    this.mPeakL = this.mPeakR = this.mSumL = this.mSumR = 0; this.mCount = 0;
    this.perf.heldNotes(st.held);
    st.arpStep = this.perf.running ? this.perf.arpStep : -1;
    st.beat = this.sequencer.playing ? this.sequencer.beat : this.perf.running ? this.perf.beat : this.clockBeat;
    st.bpm = this.bpm;
    st.reduction = this.limiter.getReduction ? this.limiter.getReduction() : 0;
    st.cpuLoad = this.cpuLoad;
    for (let m = 0; m < 4; m++) st.macros[m] = this.base[I_MACRO[m]];
    // focus voice: newest gated voice, else newest active one
    let fv = null, fs = -1, fg = false;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active || !v.controlled) continue;
      if ((v.gate && !fg) || (v.gate === fg && v.serial > fs)) { fv = v; fs = v.serial; fg = v.gate; }
    }
    const f = st.focus;
    f.active = fv !== null;
    if (fv) {
      f.note = fv.note; f.cutoff = fv.cut1; f.lfo1 = fv.src[1]; f.lfo2 = fv.src[2];
      f.aenv = fv.aenv.level; f.aenvStage = fv.aenv.stageName;
      f.fenv = fv.fenv.level; f.fenvStage = fv.fenv.stageName;
      f.menv = fv.menv.level; f.menvStage = fv.menv.stageName;
    }
    return st;
  }

  /** Hard reset of all audio state (voices, FX, limiter). */
  reset() {
    this.perf.allOff();
    this.sequencer.stop();
    for (let i = 0; i < this.voices.length; i++) this.voices[i].hardStop();
    this.refCount.fill(0); this.stackLen = 0; this.monoVoice = null; this.qN = 0;
    this.fx.reset(); this.limiter.reset();
    this.panicStage = 0; this.panicGain = 1;
    this.cpos = 0;
  }
}

/**
 * Offline render helper (tools/tests).
 * @param {object|null} patch  preset/patch object; global-scope ids present in patch.params (e.g. 'global.bpm',
 *                             'scale.type') are applied too, which loadPatch alone would skip.
 * @param {Array} events  [{time /*sec*\/, type:'on', note, vel} | {time, type:'off', note} | {time, type:'param', id, value}
 *                        | {time, type:'params', values} | {time, type:'macro', index, value} | {time, type:'ctrl', kind, value}
 *                        | {time, type:'allOff', hard} | {time, type:'patch', patch}
 *                        | {time, type:'seqLoad', song} | {time, type:'seqPlay'} | {time, type:'seqStop'}]
 *                        Events are applied on control-block (CR) boundaries.
 * @param {number} seconds
 * @param {number} sampleRate
 * @param {{seed?:number, synth?:Synth}} [opts]
 * @returns {{L: Float32Array, R: Float32Array, synth: Synth}}
 */
export function renderOffline(patch, events = [], seconds = 2, sampleRate = 48000, opts = {}) {
  const synth = opts.synth || new Synth(sampleRate, { seed: opts.seed ?? 1 });
  if (patch) {
    synth.loadPatch(patch);
    const params = patch.params || {};
    for (const id in params) {
      const p = PARAM_BY_ID[id];
      if (p && p.scope === 'global') synth.setParam(id, params[id]);
    }
  }
  const total = Math.max(0, Math.ceil(seconds * sampleRate));
  const L = new Float32Array(total), R = new Float32Array(total);
  const evs = (events || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0));
  const evSample = e => Math.max(0, Math.round(((e.time || 0) * sampleRate) / CR) * CR);
  const bL = new Float32Array(MAX_BLOCK), bR = new Float32Array(MAX_BLOCK);
  let pos = 0, ei = 0;
  while (pos < total) {
    while (ei < evs.length && evSample(evs[ei]) <= pos) applyEvent(synth, evs[ei++]);
    let len = Math.min(MAX_BLOCK, total - pos);
    if (ei < evs.length) {
      const next = evSample(evs[ei]);
      if (next - pos < len) len = next - pos;
    }
    synth.process(bL, bR, len);
    L.set(bL.subarray(0, len), pos);
    R.set(bR.subarray(0, len), pos);
    pos += len;
  }
  return { L, R, synth };
}

function applyEvent(synth, e) {
  switch (e.type) {
    case 'on': synth.noteOn(e.note, e.vel ?? e.velocity ?? 0.8); break;
    case 'off': synth.noteOff(e.note); break;
    case 'param': synth.setParam(e.id, e.value); break;
    case 'params': synth.setParams(e.values); break;
    case 'macro': synth.setMacro(e.index, e.value); break;
    case 'ctrl': synth.setController(e.kind, e.value); break;
    case 'allOff': synth.allNotesOff(!!e.hard); break;
    case 'patch': synth.loadPatch(e.patch); break;
    case 'seqLoad': synth.sequencer.load(e.song); break;
    case 'seqPlay': synth.sequencer.play(); break;
    case 'seqStop': synth.sequencer.stop(); break;
  }
}
