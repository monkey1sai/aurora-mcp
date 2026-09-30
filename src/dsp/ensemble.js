// Ensemble: multi-part song engine for demo songs. Pure ES module (AudioWorklet + Node safe).
//
// Every part of a song is a full Synth (own patch, macros, FX chain and limiter) whose sequencer plays the
// part's events. All parts are clocked from the same control-block grid (CR = 16 samples): they start on the
// same sample and their sequencers advance with bit-identical beat arithmetic, so the parts stay
// sample-synchronous forever. The ensemble ADDS its mix into the host's buffers (the host renders the user's
// own Synth first; see src/worklet/processor.js) and a SafetyBus limiter protects the sum.
//
//   const ens = new Ensemble(sampleRate, { maxParts: 8 });
//   ens.load(song); ens.play();           // song = engine-ready (src/demo/resolve.js → resolveSong)
//   ens.process(L, R, n);                 // adds the mix into L/R
//   ens.queue(nextSong);                  // seamless switch at the current loop end
//   ens.setPart(1, { gain: -3, mute: false, solo: false });
//   ens.getState();                       // { playing, beat, lengthBeats, loop, bpm, section, parts:[…] }
//
// Engine-ready song:
//   { id?, title?, zh?, bpm, lengthBeats, loop, sections?: [{beat, name, zh}],
//     parts: [{ name, zh?, role?, patch: {params, macros}, gain /*dB*/, pan /*-1..1*/, events /*§6 sequencer events*/ }] }
//
// Part pool. Constructing a Synth costs ≈2–6 ms (20 voices + FX chain) — more than one 128-sample render
// quantum, so the pool is built lazily and incrementally: one Synth every `buildEvery` process() calls, only
// while the host is idle (host sets `hostIdle`), or — when a loaded/queued song needs more parts than exist —
// regardless of idleness. load()/queue() wait until enough parts exist. Parts are reused across songs via
// loadPatch (at most one loadPatch per process() call while preparing; seamless switches pre-load free parts
// ahead of the boundary).
//
// Audio path: process() is allocation-free (message-time methods — load/queue/setPart — may allocate).

import { Synth } from './synth.js';
import { Sequencer } from './sequencer.js';
import { Limiter } from './fx/limiter.js';
import { CR } from './util.js';
import { PARAM_BY_ID, toNumeric } from './params.js';

// 8: the factory drum presets are single instruments (kick / snare / hats / …), so a groove alone takes 3+ parts.
export const ENSEMBLE_MAX_PARTS = 8;
const MAX_BLOCK = 128;
const EPS = 1e-9; // same tolerance as the sequencer
const BPM_MIN = PARAM_BY_ID['global.bpm'].min, BPM_MAX = PARAM_BY_ID['global.bpm'].max;
// Global-scope params a part patch may set (loadPatch skips global scope). Tempo/master are the ensemble's.
const PART_GLOBALS = ['scale.root', 'scale.type'];
const POLY = PARAM_BY_ID['voice.poly'];
const MODE_LOAD = 1, MODE_QUEUE = 2;


const dbToGain = db => Math.pow(10, db / 20);
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

class Slot {
  constructor(synth, index) {
    this.synth = synth;
    this.index = index;
    this.part = null;      // part (of the current song) this synth plays, or null
    this.reserved = null;  // part of a queued song pre-loaded into this (free) synth
    this.key = '';         // JSON key of the patch currently loaded
    this.quiet = true;     // no voices + FX tails done (skipped when unassigned or stopped)
    this.ul = 0; this.ur = 0;  // target gains without master
    this.tl = 0; this.tr = 0;  // target gains incl. master
    this.gl = 0; this.gr = 0;  // smoothed gains
    this.fade = 1;         // stop/steal fade (linear)
    this.fadeStep = 0;     // per sample (negative = fading out)
    this.holdLeft = -1;    // samples before a pending fade-out starts (-1: none)
    this.resetAtZero = false;
    this.peak = 0;         // post-gain peak since the last getState()
    this.claim = -1;       // scratch for _assign
    this.cpuMs = 0;        // render time in ms (only with Ensemble.profile)
  }
}

/**
 * Multi-part song engine. See the file header for the song format.
 */
export class Ensemble {
  /**
   * @param {number} sampleRate
   * @param {{maxParts?:number, seed?:number, buildEvery?:number, autoBuild?:boolean, eager?:boolean}} [opts]
   *   maxParts: size of the part pool (default 8; ≈4 MB and ≈2–6 ms construction per part)
   *   buildEvery: process() calls between two part constructions (default 6 ≈ 16 ms at 48 kHz / 128)
   *   autoBuild: pre-build the whole pool while the host is idle (default true)
   *   eager: build every part now (offline tools/tests)
   */
  constructor(sampleRate, { maxParts = ENSEMBLE_MAX_PARTS, seed = 1, buildEvery = 6, autoBuild = true, eager = false } = {}) {
    this.sr = sampleRate;
    this.maxParts = Math.max(1, Math.min(16, maxParts | 0));
    this.seed = seed >>> 0 || 1;
    this.buildEvery = Math.max(1, buildEvery | 0);
    this.autoBuild = autoBuild;
    this.buildTick = 0;
    this.buildMs = 0;          // last measured construction time (ms), when a clock is available
    this.slots = [];
    /** Host → ensemble: true while the host's own output is silent (safe moment to construct parts). */
    this.hostIdle = true;
    /** Linear gain on the whole ensemble (host: follows the user's master volume). */
    this.master = 1;
    this._masterSet = 1;
    /** Optional stem tap (offline tools): (partIndex, L, R, n, offset) — post-gain/pan part signal for
     *  output samples [offset, offset+n) of the current process() call (partIndex −1: an outgoing part). */
    this.tap = null;
    /** Offline tools: a clock () => ms (e.g. thread CPU time) → each part Synth's render time accumulates in
     *  slot.cpuMs (two clock reads per part and block; null = off). */
    this.profile = null;

    // timing (mirrors Sequencer arithmetic exactly)
    this.cpos = 0;             // phase inside the control block grid
    this.pos = 0;              // beat used at the next control-block start (absolute since play)
    this.loopStart = 0;
    this.len = 4;
    this.loop = true;
    this.bpm = 110;
    this.inc = 0;
    this.clockRunning = false;
    this.lastBeat = 0;

    this.cur = null;           // current prepared song
    this.next = null;          // song waiting to become current
    this.nextMode = 0;
    this.playReq = false;
    this._playing = false;
    this.ending = false;       // non-loop song past its end, tails ringing
    this.endSamples = 0;

    // stop behaviour
    this.stopHold = 1.5;       // s: tails ring freely after stop()
    this.stopFade = 1.0;       // s: then fade out
    this.maxEndTail = 12;      // s: a finished (non-loop) song stops at the latest this long after its end
    this.segmentTail = 8;      // s: parts dropped at a queue switch ring this long before fading
    this.fastStep = 1 / (0.008 * sampleRate);
    this.voiceCap = 0;         // 0: patches' own polyphony; else every part is capped (CPU governor)
    this.smooth = 1 - Math.exp(-1 / (0.015 * sampleRate)); // gain smoothing (≈15 ms)

    this.sL = new Float32Array(MAX_BLOCK);
    this.sR = new Float32Array(MAX_BLOCK);
    this.liveCount = 0;
    this._map = new Array(this.maxParts).fill(null); // _assign result (reused: the switch runs in process())

    // reusable state object
    this._st = {
      playing: false, beat: 0, lengthBeats: 0, loop: true, bpm: 0, section: null, sectionIndex: -1,
      id: null, title: '', zh: '', loaded: false, pending: false, queued: null, ending: false,
      built: 0, maxParts: this.maxParts, voiceCap: 0, parts: [],
    };
    this._pst = [];
    for (let i = 0; i < this.maxParts; i++) {
      this._pst.push({ index: i, name: '', zh: '', role: '', peak: 0, notes: [], mute: false, solo: false, gain: 0, active: false });
    }

    if (eager) this.ensureParts(this.maxParts);
  }

  // ───────────────────────── pool ─────────────────────────

  /** Number of part Synths constructed so far. */
  get built() { return this.slots.length; }

  /** Build part Synths synchronously until `n` exist (offline use; in a worklet let process() build lazily). */
  ensureParts(n = this.maxParts) {
    n = Math.min(this.maxParts, n | 0);
    while (this.slots.length < n) this._buildOne();
  }

  _buildOne() {
    const i = this.slots.length;
    const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
    const synth = new Synth(this.sr, { seed: (this.seed * 7919 + (i + 1) * 104729) >>> 0 });
    if (this.cpos !== 0) synth.process(this.sL, this.sR, this.cpos); // align to the ensemble's control grid
    this.slots.push(new Slot(synth, i));
    if (t0) this.buildMs = performance.now() - t0;
  }

  // ───────────────────────── songs ─────────────────────────

  /** Parse an engine-ready song (message time; allocates). Throws on invalid input. */
  _prepare(song) {
    if (!song || typeof song !== 'object') throw new Error('Ensemble: song must be an object');
    const src = Array.isArray(song.parts) ? song.parts : [];
    if (!src.length) throw new Error('Ensemble: song has no parts');
    if (src.length > this.maxParts) throw new Error(`Ensemble: song has ${src.length} parts (max ${this.maxParts})`);
    let bpm = num(song.bpm, 110);
    bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
    let len = num(song.lengthBeats, 0);
    if (!(len > 0)) {
      let end = 0;
      for (const p of src) for (const e of (p && p.events) || []) end = Math.max(end, num(e.beat, 0) + (e.type === 'on' ? num(e.dur, 1) : num(e.beats, 0)));
      len = Math.max(4, Math.ceil((end - EPS) / 4) * 4);
    }
    const loop = song.loop !== false;
    const sections = (Array.isArray(song.sections) ? song.sections : [])
      .filter(s => s && Number.isFinite(Number(s.beat)))
      .map(s => ({ beat: Number(s.beat), name: String(s.name ?? ''), zh: String(s.zh ?? '') }))
      .sort((a, b) => a.beat - b.beat);
    const parts = src.map((p, i) => {
      if (!p || typeof p !== 'object') throw new Error(`Ensemble: part ${i} is not an object`);
      const patch = p.patch && typeof p.patch === 'object' ? p.patch : { params: p.params || {}, macros: p.macros || [] };
      const globals = [];
      const params = patch.params || {};
      // always written (default when absent): loadPatch keeps global-scope values, and a reused part Synth must
      // not keep the previous song's scale lock
      for (const id of PART_GLOBALS) globals.push(id, params[id] !== undefined ? params[id] : PARAM_BY_ID[id].def);
      const seq = new Sequencer(null);
      seq.load({ bpm, loop, lengthBeats: len, events: Array.isArray(p.events) ? p.events : [] });
      return {
        index: i, name: String(p.name ?? `Part ${i + 1}`), zh: String(p.zh ?? ''), role: String(p.role ?? ''),
        patch, key: JSON.stringify(patch), globals,
        gainDb: num(p.gain, 0), pan: Math.min(1, Math.max(-1, num(p.pan, 0))),
        seq, slot: null, loaded: false, trimDb: 0, mute: false, solo: false,
        panOverride: undefined, preSlot: null, jump: false,
        poly: toNumeric(POLY, (patch.params || {})['voice.poly'] ?? POLY.def),
      };
    });
    return {
      song, id: song.id ?? null, title: String(song.title ?? ''), zh: String(song.zh ?? ''),
      bpm, lengthBeats: len, loop, sections, parts, ready: false, fresh: false,
    };
  }

  /**
   * Load a song (stops the current one; its tails ring out). Returns true when the song is loaded now,
   * false when it waits for the part pool (it loads automatically once enough parts exist).
   */
  load(song) {
    const prep = this._prepare(song);
    this.stop();
    this._clearReservations();
    this.next = prep;
    this.nextMode = MODE_LOAD;
    this.playReq = false;
    return this._tryLoad();
  }

  /**
   * Start the next song/segment seamlessly at the end of the current loop (or at the end of a non-looping
   * song). When nothing is playing: load + play at once. Mixer settings carry over for parts with the same name.
   */
  queue(song) {
    if (!this._playing || !this.cur) {
      this.load(song);
      this.play();
      return;
    }
    const prep = this._prepare(song);
    this._clearReservations();
    for (const p of prep.parts) {
      const old = this.cur.parts.find(q => q.name === p.name);
      if (old) { p.trimDb = old.trimDb; p.mute = old.mute; p.solo = old.solo; }
    }
    this.next = prep;
    this.nextMode = MODE_QUEUE;
  }

  /** Play the loaded song from the top (restarts when playing). Deferred until the song is ready. */
  play() {
    if (this.next && this.nextMode === MODE_LOAD) { this.playReq = true; return; }
    if (!this.cur) return;
    if (this._playing) this.stop();
    if (!this.cur.fresh) {
      this.cur.ready = false;
      for (const p of this.cur.parts) p.loaded = false;
    }
    this.playReq = true;
  }

  /**
   * Stop: release every note, let tails ring for `stopHold` s, then fade them out over `stopFade` s.
   * hard: fade out within ≈8 ms (panic). A queued song is cancelled; the current song stays loaded.
   */
  stop(hard = false) {
    this.playReq = false;
    if (this.next && this.nextMode === MODE_QUEUE) { this._clearReservations(); this.next = null; }
    if (this.cur && this._playing) this.lastBeat = this.beat;
    this._playing = false;
    this.clockRunning = false;
    this.ending = false;
    if (this.cur) {
      this.cur.fresh = false;
      for (const p of this.cur.parts) {
        p.seq.stop();
        const s = p.slot;
        if (!s) continue;
        s.synth.allNotesOff(false);
        this._scheduleFade(s, hard ? 0 : this.stopHold, hard);
      }
    }
    if (hard) {
      for (const s of this.slots) if (!s.quiet) this._scheduleFade(s, 0, true);
    }
  }

  get playing() { return this._playing; }

  /** Beat position inside the current song (0 … lengthBeats). */
  get beat() {
    if (!this.cur) return 0;
    if (this._playing && this.clockRunning) {
      const b = this.pos - this.loopStart;
      return b < 0 ? 0 : b;
    }
    return this._playing && this.ending ? this.len : this.lastBeat;
  }

  /** True while the ensemble produces (or is about to produce) sound. */
  get active() { return this._playing || this.playReq || (this.next !== null && this.nextMode === MODE_LOAD) || this.liveCount > 0; }

  /**
   * Mixer: gain = trim in dB added to the song's part gain (0 = as composed), mute, solo, pan (override, −1..1;
   * null restores the song's pan). `i` = part index or part name.
   */
  setPart(i, opts = {}) {
    const song = this.next && this.nextMode === MODE_LOAD ? this.next : this.cur;
    if (!song) return;
    const p = typeof i === 'string' ? song.parts.find(q => q.name === i || q.zh === i) : song.parts[i | 0];
    if (!p) return;
    if (opts.gain !== undefined) p.trimDb = Math.max(-60, Math.min(12, num(opts.gain, 0)));
    if (opts.mute !== undefined) p.mute = !!opts.mute;
    if (opts.solo !== undefined) p.solo = !!opts.solo;
    if (opts.pan !== undefined) p.panOverride = opts.pan === null ? undefined : Math.min(1, Math.max(-1, num(opts.pan, 0)));
    this._targets(this.cur);
  }

  /**
   * Cap every part's polyphony at `n` voices (0 = each patch's own value). Used by the host as a CPU governor
   * on slow machines: fewer overlapping release tails, same notes.
   */
  setVoiceCap(n) {
    n = Math.max(0, Math.min(16, n | 0));
    if (n === this.voiceCap) return;
    this.voiceCap = n;
    for (let j = 0; j < this.slots.length; j++) { const s = this.slots[j]; if (s.part) this._applyCap(s, s.part); }
  }

  _applyCap(s, p) {
    const cap = this.voiceCap;
    s.synth.setParam('voice.poly', cap > 0 && cap < p.poly ? cap : p.poly);
  }

  // ───────────────────────── internals (message/boundary time) ─────────────────────────

  _scheduleFade(s, holdSec, fast) {
    if (fast) { s.holdLeft = -1; s.fadeStep = -this.fastStep; }
    else if (s.fadeStep >= 0) { s.holdLeft = Math.max(1, Math.round(holdSec * this.sr)); s.fadeStep = 0; }
    s.resetAtZero = true;
  }

  _clearReservations() {
    for (const s of this.slots) s.reserved = null;
    if (this.next) for (const p of this.next.parts) p.preSlot = null;
  }

  /** Pending load → current, when enough parts exist. */
  _tryLoad() {
    const prep = this.next;
    if (!prep || this.nextMode !== MODE_LOAD) return false;
    if (this.slots.length < prep.parts.length) return false;
    if (this.cur) for (const p of this.cur.parts) { if (p.slot && p.slot.part === p) p.slot.part = null; p.slot = null; }
    const map = this._assign(prep, false);
    for (let i = 0; i < prep.parts.length; i++) {
      const p = prep.parts[i], s = map[i];
      s.part = p; p.slot = s; p.loaded = false;
    }
    this.cur = prep;
    this.next = null;
    this.nextMode = 0;
    prep.ready = false;
    this.ending = false;
    this.lastBeat = 0;
    this._targets(prep);
    return true;
  }

  /**
   * Choose a synth for every part of `prep`. seamless: parts keep playing synths with an identical patch
   * (continuity across segments), then pre-loaded reservations. Then free silent synths, free ringing ones
   * (most faded first), then synths of the outgoing song. Returns an array of slots (or null: not enough).
   */
  _assign(prep, seamless) {
    const n = prep.parts.length, slots = this.slots, ns = slots.length;
    if (ns < n) return null;
    const map = this._map;
    for (let i = 0; i < map.length; i++) map[i] = null;
    for (let j = 0; j < ns; j++) slots[j].claim = -1;
    if (seamless) {
      for (let i = 0; i < n; i++) {
        const p = prep.parts[i];
        for (let j = 0; j < ns; j++) {
          const s = slots[j];
          if (s.claim >= 0 || !s.part || s.key !== p.key) continue;
          map[i] = s; s.claim = i; break;
        }
      }
      for (let i = 0; i < n; i++) {
        const s = prep.parts[i].preSlot;
        if (map[i] || !s || s.claim >= 0 || s.reserved !== prep.parts[i]) continue;
        map[i] = s; s.claim = i;
      }
    }
    for (let i = 0; i < n; i++) {
      if (map[i]) continue;
      const p = prep.parts[i];
      let best = null, bestScore = Infinity;
      for (let j = 0; j < ns; j++) {
        const s = slots[j];
        if (s.claim >= 0) continue;
        if (seamless && s.reserved && s.reserved !== p) continue;
        let score = s.part ? (s.quiet ? 3 : 4) : s.quiet ? 0 : 2 - (s.fade < 1 ? 1 - s.fade : 0);
        if (s.key === p.key) score -= 0.5;
        if (score < bestScore) { bestScore = score; best = s; }
      }
      if (!best) { // reserved synths of the queued song are the last resort
        for (let j = 0; j < ns; j++) if (slots[j].claim < 0) { best = slots[j]; break; }
      }
      map[i] = best; best.claim = i;
    }
    return map;
  }

  _loadPatch(s, p) {
    const syn = s.synth;
    syn.loadPatch(p.patch);
    for (let k = 0; k < p.globals.length; k += 2) syn.setParam(p.globals[k], p.globals[k + 1]);
    if (this.voiceCap > 0) this._applyCap(s, p);
    s.key = p.key;
    s.fade = 1; s.fadeStep = 0; s.holdLeft = -1; s.resetAtZero = false;
  }

  /** Recompute per-slot target gains for a song's parts (mute/solo/gain/pan/master). */
  _targets(song) {
    if (!song) return;
    let anySolo = false;
    for (const p of song.parts) if (p.solo) anySolo = true;
    for (const p of song.parts) {
      const s = p.slot;
      if (!s || s.part !== p) continue;
      const audible = !p.mute && (!anySolo || p.solo);
      const g = audible ? dbToGain(p.gainDb + p.trimDb) : 0;
      const pan = p.panOverride !== undefined ? p.panOverride : p.pan;
      s.ul = g * (pan > 0 ? Math.cos(pan * Math.PI * 0.5) : 1);
      s.ur = g * (pan < 0 ? Math.cos(-pan * Math.PI * 0.5) : 1);
      s.tl = s.ul * this.master; s.tr = s.ur * this.master;
    }
  }

  _alignSlot(s) {
    const syn = s.synth;
    if (syn.cpos !== this.cpos) syn.process(this.sL, this.sR, (this.cpos - syn.cpos + CR) % CR);
  }

  /** Bind the part's sequencer to its synth and start it (song start / seamless switch). */
  _startPart(p, jumpGain) {
    const s = p.slot, syn = s.synth;
    this._alignSlot(s);
    syn.setParam('global.bpm', this.bpm);
    syn.getEffective('global.bpm'); // brings synth.bpm up to date before the first sequencer tick
    p.seq.synth = syn;
    syn.sequencer = p.seq;
    p.seq.play();
    if (jumpGain) { s.gl = s.tl; s.gr = s.tr; }
    s.quiet = false;
  }

  _startClock(song) {
    this.bpm = song.bpm;
    this.inc = (CR * this.bpm) / (60 * this.sr); // identical to Sequencer.tick's (n * bpm) / (60 * sr)
    this.pos = 0;
    this.loopStart = 0;
    this.len = song.lengthBeats;
    this.loop = song.loop;
    this.clockRunning = true;
    this.ending = false;
    this.endSamples = 0;
  }

  _start() {
    const song = this.cur;
    this._startClock(song);
    this._targets(song);
    for (let i = 0; i < song.parts.length; i++) this._startPart(song.parts[i], true);
    this._playing = true;
    this.playReq = false;
    song.fresh = false;
  }

  /** Seamless switch to the queued song at a control-block boundary. Returns false when not possible yet. */
  _switch() {
    const prep = this.next, old = this.cur;
    const map = this._assign(prep, true);
    if (!map) return false;
    // outgoing parts that no synth continues: release, ring out, fade
    for (let i = 0; i < old.parts.length; i++) {
      const p = old.parts[i], s = p.slot;
      p.seq.stop();
      if (!s) continue;
      if (s.claim < 0) {
        s.synth.allNotesOff(false);
        s.part = null;
        this._scheduleFade(s, this.segmentTail, false);
      }
      p.slot = null;
    }
    this._startClock(prep);
    for (let i = 0; i < prep.parts.length; i++) {
      const p = prep.parts[i], s = map[i];
      const fresh = s.quiet && !s.part; // silent free synth: start at full gain
      if (s.key !== p.key) this._loadPatch(s, p);
      else { s.fade = 1; s.fadeStep = 0; s.holdLeft = -1; s.resetAtZero = false; this._applyCap(s, p); }
      s.part = p; s.reserved = null; p.slot = s; p.loaded = true; p.preSlot = null;
      p.jump = fresh;
    }
    this._targets(prep);
    for (let i = 0; i < prep.parts.length; i++) this._startPart(prep.parts[i], prep.parts[i].jump);
    for (let j = 0; j < this.slots.length; j++) this.slots[j].reserved = null;
    this.cur = prep;
    prep.ready = true;
    prep.fresh = false;
    this.next = null;
    this.nextMode = 0;
    this._playing = true;
    return true;
  }

  // ───────────────────────── audio ─────────────────────────

  /** Per-call housekeeping: pool building, pending loads, preparation, deferred start. */
  _maintain() {
    // pool
    if (this.slots.length < this.maxParts) {
      const demand = Math.max(this.cur ? this.cur.parts.length : 0, this.next ? this.next.parts.length : 0);
      const need = demand > this.slots.length;
      const idle = this.autoBuild && this.hostIdle && !this._playing && this.liveCount === 0;
      if (need || idle) {
        // demand (a song waits): every buildEvery/2 calls; idle pre-build: every buildEvery calls
        if (++this.buildTick >= (need ? Math.max(1, this.buildEvery >> 1) : this.buildEvery)) {
          this.buildTick = 0;
          this._buildOne();
        }
      } else this.buildTick = 0;
    }
    if (this.master !== this._masterSet) {
      this._masterSet = this.master;
      for (let j = 0; j < this.slots.length; j++) { const s = this.slots[j]; s.tl = s.ul * this.master; s.tr = s.ur * this.master; }
    }
    if (this.next) {
      if (this.nextMode === MODE_LOAD) this._tryLoad();
      else if (this.nextMode === MODE_QUEUE) this._reserveOne();
    }
    const song = this.cur;
    if (song && !song.ready) {
      let done = true, loadedOne = false;
      for (let i = 0; i < song.parts.length; i++) {
        const p = song.parts[i];
        if (p.loaded) continue;
        const s = p.slot;
        done = false;
        if (!s.quiet) { // still ringing (previous song / restart): fast fade → reset → load
          if (s.fadeStep !== -this.fastStep) { s.holdLeft = -1; s.fadeStep = -this.fastStep; s.resetAtZero = true; }
          continue;
        }
        if (loadedOne) continue;
        this._loadPatch(s, p);
        p.loaded = true;
        loadedOne = true;
      }
      if (done) { song.ready = true; song.fresh = true; }
    }
    if (this.playReq && song && song.ready && !(this.next && this.nextMode === MODE_LOAD)) this._start();
  }

  /** Queued song: pre-load one free silent synth per call so the boundary switch does little work. */
  _reserveOne() {
    const prep = this.next, slots = this.slots;
    for (let i = 0; i < prep.parts.length; i++) {
      const p = prep.parts[i];
      if (p.preSlot) continue;
      // a playing synth with the same patch will be continued: nothing to pre-load
      let cont = false;
      for (let j = 0; j < slots.length; j++) if (slots[j].part && slots[j].key === p.key) { cont = true; break; }
      if (cont) continue;
      for (let j = 0; j < slots.length; j++) {
        const s = slots[j];
        if (s.part || s.reserved || !s.quiet) continue;
        s.reserved = p;
        p.preSlot = s;
        if (s.key !== p.key) this._loadPatch(s, p);
        return;
      }
      return; // no free synth: the switch reuses outgoing ones
    }
  }

  /** Samples from the current position to the first control-block start at/after the loop end (≥ maxLen: none). */
  _samplesToBoundary(maxLen) {
    let p = this.pos;
    const lim = this.loopStart + this.len;
    let at = this.cpos === 0 ? 0 : CR - this.cpos;
    while (at < maxLen) {
      if (p + EPS >= lim) return at;
      p += this.inc;
      at += CR;
    }
    return maxLen;
  }

  /** Control-block start bookkeeping (same order as Sequencer.tick: check, then advance). */
  _blockStart() {
    if (!this.clockRunning) return;
    if (this.pos + EPS >= this.loopStart + this.len) {
      if (this.loop) this.loopStart += this.len;
      else { this.clockRunning = false; this.ending = true; this.endSamples = 0; this.lastBeat = this.len; return; }
    }
    this.pos += this.inc;
  }

  _advance(len) {
    let c = this.cpos, left = len;
    while (left > 0) {
      if (c === 0) this._blockStart();
      const step = CR - c < left ? CR - c : left;
      c += step; left -= step;
      if (c >= CR) c = 0;
    }
    this.cpos = c;
  }

  /**
   * Render the ensemble and ADD it into outL/outR[0..n). Any n (internally ≤ 128-sample chunks).
   */
  process(outL, outR, n) {
    this._maintain();
    let off = 0;
    while (off < n) {
      let len = n - off;
      if (len > MAX_BLOCK) len = MAX_BLOCK;
      if (this._playing && this.clockRunning && this.next && this.nextMode === MODE_QUEUE) {
        const at = this._samplesToBoundary(len);
        if (at < len) {
          if (at > 0) { this._render(outL, outR, off, at); off += at; }
          if (this._switch()) continue;
          len = n - off; if (len > MAX_BLOCK) len = MAX_BLOCK;
        }
      } else if (this._playing && !this.clockRunning && this.ending && this.next && this.nextMode === MODE_QUEUE) {
        // queued after a one-shot song already ended: switch now
        if (this._switch()) continue;
      }
      this._render(outL, outR, off, len);
      off += len;
    }
  }

  _render(outL, outR, off, len) {
    const slots = this.slots, sL = this.sL, sR = this.sR, k = this.smooth, playing = this._playing;
    let live = 0;
    for (let si = 0; si < slots.length; si++) {
      const s = slots[si];
      const assignedPlaying = playing && s.part !== null;
      if (!assignedPlaying && s.quiet) continue;
      const syn = s.synth;
      if (syn.cpos !== this.cpos) this._alignSlot(s);
      if (this.profile !== null) {
        const t0 = this.profile();
        syn.process(sL, sR, len);
        s.cpuMs += this.profile() - t0;
      } else syn.process(sL, sR, len);
      live++;
      // hold → fade scheduling
      if (s.holdLeft > 0) {
        s.holdLeft -= len;
        if (s.holdLeft <= 0) { s.holdLeft = -1; s.fadeStep = -1 / (this.stopFade * this.sr); }
      }
      let gl = s.gl, gr = s.gr, f = s.fade, pk = s.peak;
      const tl = s.tl, tr = s.tr, fs = s.fadeStep;
      if (fs === 0 && f === 1 && gl === tl && gr === tr) {
        for (let i = 0; i < len; i++) {
          const a = sL[i] * gl, b = sR[i] * gr;
          sL[i] = a; sR[i] = b;
          outL[off + i] += a; outR[off + i] += b;
          const m = (a < 0 ? -a : a) > (b < 0 ? -b : b) ? (a < 0 ? -a : a) : (b < 0 ? -b : b);
          if (m > pk) pk = m;
        }
      } else {
        for (let i = 0; i < len; i++) {
          gl += (tl - gl) * k; gr += (tr - gr) * k;
          if (fs !== 0) { f += fs; if (f < 0) f = 0; else if (f > 1) f = 1; }
          const a = sL[i] * gl * f, b = sR[i] * gr * f;
          sL[i] = a; sR[i] = b;
          outL[off + i] += a; outR[off + i] += b;
          const m = (a < 0 ? -a : a) > (b < 0 ? -b : b) ? (a < 0 ? -a : a) : (b < 0 ? -b : b);
          if (m > pk) pk = m;
        }
        if (gl - tl < 1e-7 && tl - gl < 1e-7) gl = tl;
        if (gr - tr < 1e-7 && tr - gr < 1e-7) gr = tr;
      }
      s.gl = gl; s.gr = gr; s.fade = f; s.peak = pk;
      if (this.tap !== null) this.tap(s.part ? s.part.index : -1, sL, sR, len, off);
      if (f === 0 && s.resetAtZero) {
        syn.reset();
        s.resetAtZero = false; s.fadeStep = 0; s.holdLeft = -1;
        s.quiet = true;
        if (s.part && !playing) { /* stays assigned to the loaded (stopped) song */ }
      } else {
        s.quiet = syn.idleSamples >= syn.idleAfter;
      }
    }
    this.liveCount = live;
    this._advance(len);

    // end of a one-shot song: stop once every part is silent (or after maxEndTail)
    if (this.ending && playing) {
      this.endSamples += len;
      let allQuiet = true;
      for (let si = 0; si < slots.length; si++) if (slots[si].part !== null && !slots[si].quiet) { allQuiet = false; break; }
      if (allQuiet) {
        this._playing = false;
        this.ending = false;
        this.lastBeat = this.len;
        if (this.cur) this.cur.fresh = false;
      } else if (this.endSamples > this.maxEndTail * this.sr) {
        this.stop();
        for (const s of slots) if (s.part !== null && s.holdLeft > 0) { s.holdLeft = -1; s.fadeStep = -1 / (this.stopFade * this.sr); }
      }
    }
  }

  // ───────────────────────── state ─────────────────────────

  /**
   * Cheap snapshot for the UI (objects/arrays reused between calls; per-part peaks reset on read).
   * @returns {{playing:boolean, beat:number, lengthBeats:number, loop:boolean, bpm:number,
   *   section:{beat:number,name:string,zh:string}|null, sectionIndex:number, id:any, title:string, zh:string,
   *   loaded:boolean, pending:boolean, queued:any, ending:boolean, built:number, maxParts:number, voiceCap:number,
   *   parts:{index:number,name:string,zh:string,role:string,peak:number,notes:number[],mute:boolean,solo:boolean,gain:number,active:boolean}[]}}
   */
  getState() {
    const st = this._st;
    // a pending load() has already replaced the current song: report it (id, sections, parts) rather than the
    // outgoing one, so the UI never mistakes the old id for "someone else took over" while the pool warms up
    const song = this.next && this.nextMode === MODE_LOAD ? this.next : this.cur;
    st.playing = this._playing;
    st.ending = this.ending;
    st.built = this.slots.length;
    st.voiceCap = this.voiceCap;
    st.loaded = !!(this.cur && this.cur.ready);
    st.pending = !!(this.next && this.nextMode === MODE_LOAD) || !!(this.cur && !this.cur.ready) || this.playReq;
    st.queued = this.next && this.nextMode === MODE_QUEUE ? (this.next.id ?? this.next.title) : null;
    const ps = st.parts;
    if (!song) {
      st.beat = 0; st.lengthBeats = 0; st.loop = true; st.bpm = 0; st.section = null; st.sectionIndex = -1;
      st.id = null; st.title = ''; st.zh = '';
      ps.length = 0;
      return st;
    }
    const beat = song === this.cur ? this.beat : 0;
    st.beat = beat;
    st.lengthBeats = song.lengthBeats;
    st.loop = song.loop;
    st.bpm = song.bpm;
    st.id = song.id; st.title = song.title; st.zh = song.zh;
    let si = -1;
    const secs = song.sections;
    for (let i = 0; i < secs.length; i++) if (secs[i].beat <= beat + 1e-6) si = i;
    st.sectionIndex = si;
    st.section = si >= 0 ? secs[si] : null;
    const n = song.parts.length;
    for (let i = 0; i < n; i++) {
      const p = song.parts[i], o = this._pst[i], s = p.slot;
      o.index = i; o.name = p.name; o.zh = p.zh; o.role = p.role;
      o.mute = p.mute; o.solo = p.solo; o.gain = p.trimDb;
      const notes = o.notes;
      let k = 0;
      if (s && s.part === p) {
        o.peak = s.peak; s.peak = 0;
        o.active = !s.quiet;
        const vs = s.synth.voices;
        for (let v = 0; v < vs.length; v++) {
          const vo = vs[v];
          if (!vo.active || !vo.gate || vo.fading) continue;
          let dup = false;
          for (let j = 0; j < k; j++) if (notes[j] === vo.note) { dup = true; break; }
          if (!dup) notes[k++] = vo.note; // index writes: the backing store is kept between calls
        }
      } else { o.peak = 0; o.active = false; }
      if (notes.length !== k) notes.length = k;
      ps[i] = o;
    }
    ps.length = n;
    return st;
  }
}

/**
 * Safety limiter for the final sum (host synth + ensemble): the shared look-ahead brickwall limiter
 * (src/dsp/fx/limiter.js, ceiling −0.3 dBFS). Engage/disengage crossfade (≈10 ms) between the dry and the
 * limited signal; during a crossfade the output is additionally clamped at the ceiling, so the output never
 * exceeds the ceiling while engaged or crossfading.
 *
 * Latency: the limiter output is `latency` (1.5 ms) late. Crossfading it against the *undelayed* dry signal was a
 * moving comb filter (−24 dB nulls at 333 Hz, 1 kHz, … for ≈1 ms, −6 dB for ≈5 ms) on whatever the user was
 * holding when a song started or ended. So while engaged or crossfading the bus runs *aligned*: the dry path is
 * delayed by the same latency (ring buffer) and the crossfade mixes two time-aligned copies (no comb). The
 * latency itself is added / dropped only where the input has been silent (< −100 dBFS) for ≥ `latency` samples,
 * i.e. where inserting / skipping 1.5 ms is inaudible:
 *   engage   from silence → aligned at once (the usual case: a song starts while the user's synth is quiet);
 *            input sounding → the old crossfade against the undelayed signal (no gap-free alternative);
 *   disengage → aligned crossfade to the delayed dry signal, back to bypass at the next silence.
 * Bypass (disengaged, back at zero latency) costs a silence scan of the block.
 */
const BUS_SILENT = 1e-5; // −100 dBFS

export class SafetyBus {
  constructor(sampleRate, { ceilingDb = -0.3, lookaheadMs = 1.5, releaseMs = 120, xfadeMs = 10 } = {}) {
    this.limiter = new Limiter(sampleRate, { ceilingDb, lookaheadMs, releaseMs });
    this.ceil = Math.pow(10, ceilingDb / 20);
    /** Request: true → limit the sum. */
    this.engaged = false;
    this.mix = 0;
    this.step = 1 / Math.max(1, xfadeMs * 0.001 * sampleRate);
    this.aligned = false;  // output delayed by the limiter latency (limited and/or latency-matched dry)
    this.legacy = false;   // engaging against the undelayed dry signal (the input was not silent)
    const La = this.limiter.latency;
    let rs = 1; while (rs < La + 1) rs <<= 1;
    this.rmask = rs - 1;
    this.rL = new Float32Array(rs); this.rR = new Float32Array(rs); // dry delay line (La samples)
    this.rw = 0;
    this.silentRun = 0x3fffffff; // trailing input samples below BUS_SILENT
    this.dL = new Float32Array(MAX_BLOCK);
    this.dR = new Float32Array(MAX_BLOCK);
    this.inPeak = 0;      // input (pre-limiter) peak, linear — reset by the reader
    this.minGain = 1;     // deepest limiter gain since the last reset by the reader (linear)
  }

  /** Latency (samples) while engaged. */
  get latency() { return this.limiter.latency; }

  /** Trailing-silence counter over the input L/R[off .. off+len) (call before the block is overwritten). */
  _silence(L, R, off, len) {
    let i = off + len - 1;
    for (; i >= off; i--) {
      const a = L[i], b = R[i];
      if (a > BUS_SILENT || a < -BUS_SILENT || b > BUS_SILENT || b < -BUS_SILENT) break;
    }
    if (i < off) { if (this.silentRun < 0x3fffffff) this.silentRun += len; }
    else this.silentRun = off + len - 1 - i;
  }

  _arm(legacy) {
    this.limiter.reset();
    this.rL.fill(0); this.rR.fill(0); this.rw = 0;
    this.aligned = true; this.legacy = legacy; this.mix = 0;
  }

  /** In place on L/R[0..n). */
  process(L, R, n) {
    if (!this.engaged && !this.aligned) { this.mix = 0; this._silence(L, R, 0, n); return; } // bypass
    const lim = this.limiter, ceil = this.ceil, La = lim.latency;
    let pk = this.inPeak;
    for (let off = 0; off < n; off += MAX_BLOCK) {
      const len = n - off < MAX_BLOCK ? n - off : MAX_BLOCK;
      if (!this.aligned) {
        if (!this.engaged) { this.mix = 0; this._silence(L, R, off, len); continue; }
        this._arm(this.silentRun < La);
      }
      for (let i = off; i < off + len; i++) {
        const a = L[i] < 0 ? -L[i] : L[i], b = R[i] < 0 ? -R[i] : R[i];
        if (a > pk) pk = a;
        if (b > pk) pk = b;
      }
      // dry copy: latency-matched (ring buffer) when aligned, the undelayed input for a legacy engage
      const dL = this.dL, dR = this.dR, rL = this.rL, rR = this.rR, rm = this.rmask;
      let rw = this.rw;
      if (this.legacy) {
        for (let i = 0; i < len; i++) { const x = L[off + i], y = R[off + i]; dL[i] = x; dR[i] = y; rL[rw] = x; rR[rw] = y; rw = (rw + 1) & rm; }
      } else {
        for (let i = 0; i < len; i++) {
          const x = L[off + i], y = R[off + i];
          rL[rw] = x; rR[rw] = y;
          const ri = (rw - La) & rm;
          dL[i] = rL[ri]; dR[i] = rR[ri];
          rw = (rw + 1) & rm;
        }
      }
      this.rw = rw;
      this._silence(L, R, off, len);
      lim.process(L, R, len, off);
      let m = this.mix;
      if (!(this.engaged && m >= 1)) {
        const st = this.engaged ? this.step : -this.step;
        for (let i = 0; i < len; i++) {
          m += st; if (m > 1) m = 1; else if (m < 0) m = 0;
          let yl = dL[i] + (L[off + i] - dL[i]) * m, yr = dR[i] + (R[off + i] - dR[i]) * m;
          if (m > 0) {
            if (yl > ceil) yl = ceil; else if (yl < -ceil) yl = -ceil;
            if (yr > ceil) yr = ceil; else if (yr < -ceil) yr = -ceil;
          }
          L[off + i] = yl; R[off + i] = yr;
        }
        this.mix = m;
        if (m >= 1) this.legacy = false; // fully limited: the output is aligned from here on
      }
      if (lim.minGain < this.minGain) this.minGain = lim.minGain;
      // fully disengaged: leave the aligned mode (drop the latency) once the delay line holds only silence
      if (!this.engaged && m <= 0 && (this.legacy || this.silentRun >= 2 * La)) { this.aligned = false; this.legacy = false; }
    }
    this.inPeak = pk;
  }

  /** Gain reduction of the last block in dB (≤ 0). */
  getReduction() { return this.mix > 0 ? this.limiter.getReduction() : 0; }

  /** Deepest reduction (dB, ≤ 0) since the previous call; resets the tracker. */
  takeMaxReduction() {
    const g = this.minGain;
    this.minGain = 1;
    return g < 1 ? 20 * Math.log10(g) : 0;
  }

  reset() {
    this.limiter.reset();
    this.rL.fill(0); this.rR.fill(0); this.rw = 0;
    this.aligned = this.engaged; this.legacy = false; this.mix = this.engaged ? 1 : 0;
    this.silentRun = 0x3fffffff; this.inPeak = 0; this.minGain = 1;
  }
}
