// AudioWorkletProcessor wrapping the AURORA Synth (the user's instrument) and the demo-song Ensemble.
// registerProcessor('aurora-synth'): 0 inputs, 1 output × 2 channels.
//
// main → worklet (port.postMessage):
//   {type:'noteOn',note,vel} {type:'noteOff',note} {type:'param',id,value} {type:'params',values}
//   {type:'patch',patch} {type:'macro',index,value} {type:'ctrl',kind,value} {type:'allOff',hard}
//   {type:'seqLoad',song} {type:'seqPlay'} {type:'seqStop'}
//   Demo songs (src/dsp/ensemble.js; song = engine-ready, see src/demo/resolve.js):
//   {type:'songLoad',song} {type:'songPlay'} {type:'songStop',hard?} {type:'songQueue',song}
//   {type:'songPart',part,gain?,mute?,solo?,pan?}   part = index or name; gain = trim in dB (0 = as composed)
//   {type:'warmup',patches:[{params,macros}…]}  JIT warm-up (see below)
// worklet → main:
//   {type:'ready', sampleRate} once constructed
//   {type:'state', state:{...synth.getState(), seqPlaying, seqBeat, seqLength, song}} ≈30 Hz
//      song = Ensemble.getState(): {playing, beat, lengthBeats, loop, bpm, section, sectionIndex, id, title, zh,
//             loaded, pending, queued, ending, built, maxParts, parts:[{index,name,zh,role,peak,notes,mute,solo,gain,active}]}
//   {type:'error', message} (audio keeps running; output is silent for a failed block)
//
// CPU governor: while a song plays and the measured render load stays above 72 %, every song part's polyphony
// is capped (8 → 6 → … ≥ 2 voices; state.song.voiceCap) and relaxed again when the load drops.
//
// Mixing: output = user synth + ensemble. While the ensemble is active the sum goes through a safety limiter
// (SafetyBus, ceiling −0.3 dBFS; crossfaded in/out against a latency-matched dry signal, so a note the user holds
// when a song ends is not comb-filtered; the 1.5 ms look-ahead latency is added/dropped only in silence — a song
// that starts while the user's synth sounds still crossfades against the undelayed signal, see SafetyBus).
// The ensemble follows the user's master volume, and while a song plays the user's synth runs at the song's
// tempo (restored on stop unless the user changed it).
// Ensemble part Synths are constructed lazily while the user's synth is silent (see Ensemble), so startup and
// playing never pay for them in one render quantum.
//
// JIT warm-up: the first time any Synth runs a code path (an engine, filter type, FX) V8 interprets it — the first
// demo song of a session rendered ≈20 ms of cold code in its first quantum (7 underruns at its first beat). After
// the part pool is built, and only while everything is silent, a free pool Synth plays each 'warmup' patch (sent by
// the UI: a few factory presets that cover every engine/filter/FX family) for WARM_BLOCKS quanta, one quantum per
// process() call, output discarded. The Synth is borrowed from the Ensemble (a private one kept ≈9 MB for the whole
// session): it is hard-reset and its patch key cleared before any song message and when the warm-up is done, so a
// song never inherits warm-up voices, FX tails or a stale patch.

import { Synth } from '../dsp/synth.js';
import { Ensemble, SafetyBus } from '../dsp/ensemble.js';
import { idx } from '../dsp/params.js';

const STATE_HZ = 30;
const I_MASTER = idx('master.volume');
const I_BPM = idx('global.bpm');
const MASTER_DEFAULT_DB = -3; // part synths keep the default master volume; the user's master scales the ensemble
const BUS_RELEASE_S = 2;      // keep the safety limiter this long after the ensemble went quiet
// CPU governor (slow machines): while a song plays and the smoothed render load exceeds GOV_HIGH, cap every
// song part's polyphony (8, then −2 per step, ≥ 2); relax (+2) after GOV_CALM_TICKS state ticks below GOV_LOW.
const GOV_HIGH = 0.72, GOV_LOW = 0.4, GOV_COOL_TICKS = 15, GOV_CALM_TICKS = 120;
const WARM_BLOCKS = 16;                 // quanta per warm-up patch (chord held for the first 12)
const WARM_NOTES = [48, 60, 64, 67];
const WARM_MAX_PATCHES = 16;

// AudioWorkletGlobalScope has no `performance` in some browsers; fall back to Date.now().
const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

class AuroraProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.synth = null;
    this.ensemble = null;
    this.bus = null;
    this.alive = true;
    this.errCount = 0;
    this.lastErrTime = -1e9;
    this.framesSinceState = 0;
    this.stateEvery = Math.max(128, Math.round(sampleRate / STATE_HZ));
    this.busyMs = 0;
    this.wallFrames = 0;
    this.scratchL = new Float32Array(128);
    this.scratchR = new Float32Array(128);
    this.busIdle = 0;
    this.busRelease = Math.round(BUS_RELEASE_S * sampleRate);
    this.songBpm = 0;        // tempo the song set on the user's synth (0: none)
    this.userBpm = 0;        // user's tempo before the song
    this.masterDb = NaN;
    this.govCap = 0; this.govCool = 0; this.govCalm = 0;
    this.warmQ = null;       // warm-up patches still to play (null: none / done)
    this.warmI = 0;
    this.warmStep = 0;
    this.warmSlot = null;    // Ensemble pool slot borrowed for the warm-up (null: none)
    this.warmL = new Float32Array(128);
    this.warmR = new Float32Array(128);

    try {
      this.synth = new Synth(sampleRate, { seed: opts.seed ?? 1 });
    } catch (e) {
      this._error(e, 'construct');
    }
    try {
      // parts are built lazily inside process() (≈2–6 ms each), never here
      this.ensemble = new Ensemble(sampleRate, { maxParts: opts.maxParts ?? 8, seed: (opts.seed ?? 1) + 1 });
      this.bus = new SafetyBus(sampleRate);
    } catch (e) {
      this.ensemble = null;
      this._error(e, 'construct ensemble');
    }

    this.port.onmessage = ev => this._onMessage(ev.data);
    if (this.synth) this.port.postMessage({ type: 'ready', sampleRate });
  }

  _error(e, where) {
    this.errCount++;
    const t = currentTime;
    if (t - this.lastErrTime < 1 && this.errCount > 3) return; // throttle floods
    this.lastErrTime = t;
    const message = `[${where}] ${(e && (e.stack || e.message)) || String(e)}`;
    try { this.port.postMessage({ type: 'error', message }); } catch { /* port closed */ }
  }

  _onMessage(m) {
    const s = this.synth;
    if (!s || !m || typeof m !== 'object') return;
    try {
      switch (m.type) {
        case 'noteOn': s.noteOn(m.note, m.vel ?? m.velocity ?? 0.8); break;
        case 'noteOff': s.noteOff(m.note); break;
        case 'param': s.setParam(m.id, m.value); break;
        case 'params': s.setParams(m.values); break;
        case 'patch': s.loadPatch(m.patch); break;
        case 'macro': s.setMacro(m.index, m.value); break;
        case 'ctrl': s.setController(m.kind, m.value); break;
        case 'allOff':
          s.allNotesOff(!!m.hard);
          if (m.hard && this.ensemble) { this.ensemble.stop(true); this._restoreTempo(); }
          break;
        case 'seqLoad': s.sequencer.load(m.song); break;
        case 'seqPlay': s.sequencer.play(); break;
        case 'seqStop': s.sequencer.stop(); break;
        case 'songLoad': this._ens().load(m.song); break;
        case 'songPlay': this._ens().play(); break;
        case 'songStop': this._ens().stop(!!m.hard); this._restoreTempo(); break;
        case 'songQueue': this._ens().queue(m.song); break;
        case 'songPart': this._ens().setPart(m.part, m); break;
        case 'warmup':
          this.warmQ = Array.isArray(m.patches) && m.patches.length ? m.patches.slice(0, WARM_MAX_PATCHES) : null;
          this.warmI = 0; this.warmStep = 0;
          break;
        case 'getState': this._postState(); break;
        case 'dispose': this.alive = false; break;
        default: break;
      }
    } catch (e) {
      this._error(e, `message:${m.type}`);
    }
  }

  _ens() {
    if (!this.ensemble) throw new Error('song engine unavailable');
    if (this.warmSlot) this._releaseWarm(); // a song message may claim any free synth: hand it back clean first
    return this.ensemble;
  }

  /** Return the borrowed pool Synth: silent, FX cleared, patch key invalidated (the next part loads its patch). */
  _releaseWarm() {
    const slot = this.warmSlot;
    this.warmSlot = null;
    slot.synth.reset();
    slot.key = '';
    this.warmStep = 0; // an interrupted warm-up patch restarts at the next idle moment
  }

  /** Song tempo → user's synth (arp, synced LFOs/delays follow the song); remembered for restore. */
  _followTempo() {
    const ens = this.ensemble, s = this.synth;
    if (!ens.playing) return;
    const bpm = ens.bpm;
    if (bpm === this.songBpm) return;
    if (this.songBpm === 0) this.userBpm = s.base[I_BPM];
    this.songBpm = bpm;
    s.setParam('global.bpm', bpm);
  }

  _restoreTempo() {
    if (this.songBpm === 0) return;
    const s = this.synth;
    if (s.base[I_BPM] === this.songBpm && this.userBpm > 0) s.setParam('global.bpm', this.userBpm);
    this.songBpm = 0;
  }

  /** One warm-up quantum (only called while the user's synth and the ensemble are silent). */
  _warmBlock() {
    try {
      if (!this.warmSlot) {
        // borrow a free, silent pool Synth (no part, no reservation); none free (an 8-part song loaded): wait
        const slots = this.ensemble.slots;
        for (let j = slots.length - 1; j >= 0; j--) {
          const sl = slots[j];
          if (!sl.part && !sl.reserved && sl.quiet) { this.warmSlot = sl; sl.key = ''; break; }
        }
        if (!this.warmSlot) return;
      }
      const w = this.warmSlot.synth;
      if (this.warmStep === 0) {
        w.loadPatch(this.warmQ[this.warmI]);
        for (let i = 0; i < WARM_NOTES.length; i++) w.noteOn(WARM_NOTES[i], 0.9);
      } else if (this.warmStep === WARM_BLOCKS - 4) w.allNotesOff(false);
      w.process(this.warmL, this.warmR, 128);
      if (++this.warmStep >= WARM_BLOCKS) {
        w.allNotesOff(true);
        this.warmStep = 0;
        if (++this.warmI >= this.warmQ.length) { this.warmQ = null; this._releaseWarm(); }
      }
    } catch (e) {
      this.warmQ = null;
      if (this.warmSlot) try { this._releaseWarm(); } catch { /* ignore */ }
      this._error(e, 'warmup');
    }
  }

  /** CPU governor, evaluated at the state rate (≈30 Hz). */
  _govern(load) {
    const ens = this.ensemble;
    if (!ens) return;
    if (!ens.playing) {
      if (this.govCap) { this.govCap = 0; ens.setVoiceCap(0); }
      this.govCool = 0; this.govCalm = 0;
      return;
    }
    if (this.govCool > 0) { this.govCool--; return; }
    if (load > GOV_HIGH) {
      this.govCap = this.govCap ? Math.max(2, this.govCap - 2) : 8;
      ens.setVoiceCap(this.govCap);
      this.govCool = GOV_COOL_TICKS; this.govCalm = 0;
    } else if (this.govCap && load < GOV_LOW) {
      if (++this.govCalm > GOV_CALM_TICKS) {
        this.govCap += 2;
        if (this.govCap > 12) this.govCap = 0;
        ens.setVoiceCap(this.govCap);
        this.govCalm = 0; this.govCool = GOV_COOL_TICKS;
      }
    } else this.govCalm = 0;
  }

  _postState() {
    const s = this.synth;
    if (!s) return;
    try {
      const st = s.getState();
      this.port.postMessage({
        type: 'state',
        state: {
          ...st, seqPlaying: s.sequencer.playing, seqBeat: s.sequencer.beat, seqLength: s.sequencer.lengthBeats,
          song: this.ensemble ? this.ensemble.getState() : null,
        },
      });
    } catch (e) {
      this._error(e, 'state');
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return this.alive;
    const L = out[0];
    const n = L.length;
    let R = out.length > 1 ? out[1] : null;
    if (!R) {
      if (this.scratchR.length < n) this.scratchR = new Float32Array(n);
      R = this.scratchR;
    }
    const s = this.synth;
    if (!s) { L.fill(0); if (out[1]) out[1].fill(0); return this.alive; }

    const t0 = now();
    try {
      s.process(L, R, n);
    } catch (e) {
      L.fill(0); R.fill(0);
      this._error(e, 'process');
      // try to recover to a clean state so the next blocks can play again
      try { s.reset(); } catch { /* ignore */ }
    }

    const ens = this.ensemble;
    if (ens) {
      try {
        ens.hostIdle = s.idleSamples >= s.idleAfter;
        const mdb = s.base[I_MASTER];
        if (mdb !== this.masterDb) { this.masterDb = mdb; ens.master = Math.pow(10, (mdb - MASTER_DEFAULT_DB) / 20); }
        ens.process(L, R, n);
        if (ens.playing) this._followTempo();
        else if (this.songBpm !== 0 && !ens.active) this._restoreTempo();
      } catch (e) {
        this._error(e, 'ensemble');
        try { ens.stop(true); } catch { /* ignore */ }
      }
      const bus = this.bus;
      if (ens.active) { this.busIdle = 0; bus.engaged = true; }
      else if (bus.engaged && (this.busIdle += n) >= this.busRelease) bus.engaged = false;
      bus.process(L, R, n);
      // JIT warm-up, one quantum at a time, only in silence and once the part pool exists
      if (this.warmQ !== null && ens.hostIdle && !ens.active && ens.built >= ens.maxParts && !s.sequencer.playing) this._warmBlock();
    }

    if (out.length === 1) {
      // mono output: fold down
      for (let i = 0; i < n; i++) L[i] = 0.5 * (L[i] + R[i]);
    }
    const t1 = now();
    this.busyMs += t1 - t0;
    this.wallFrames += n;

    this.framesSinceState += n;
    if (this.framesSinceState >= this.stateEvery) {
      this.framesSinceState = 0;
      const wallMs = (this.wallFrames / sampleRate) * 1000;
      if (wallMs > 0) {
        const load = this.busyMs / wallMs;
        s.cpuLoad = s.cpuLoad * 0.7 + load * 0.3;
      }
      this._govern(s.cpuLoad);
      this.busyMs = 0;
      this.wallFrames = 0;
      this._postState();
    }
    return this.alive;
  }
}

registerProcessor('aurora-synth', AuroraProcessor);
