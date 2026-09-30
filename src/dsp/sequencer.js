// Event sequencer for demos / autoplay. Sample-accurate at control-rate (CR) resolution.
// Pure ES module; `load()` allocates (parsing), `tick()` (audio path) does not.
//
// song = { bpm, loop, lengthBeats, events: [
//   {beat, type:'on', note, vel, dur}            note on; off after `dur` beats (default 1)
//   {beat, type:'off', note}                     explicit note off
//   {beat, type:'param', id, value}              set a param (native value; enums by id or index)
//   {beat, type:'ramp', id, to, beats[, from]}   linear ramp in normalised space to native `to`
//   {beat, type:'macro', index, value}           macro 0..3 → 0..1
//   {beat, type:'ramp-macro', index, to, beats}
// ] }
// Notes go through synth.noteOn/noteOff (performance layer). Params/macros write through the synth's base
// values (same as setParam/setMacro). `bpm` sets global.bpm on play() (restored on stop like any other change);
// the clock follows global.bpm live.
// When playback ends (stop() or the end of a non-looping song), params/macros the song changed are restored
// to their pre-play values — unless the user changed them meanwhile (restoreOnStop = false disables this).
// stop() also drops arp-latched notes so a latched demo does not keep playing.

import { PARAMS, PARAM_COUNT, PARAM_BY_ID, toNumeric, idx } from './params.js';
import { normOf, denormOf, normTo, denormTo } from './voice.js';

const I_BPM = idx('global.bpm');

const EV_PARAM = 0, EV_RAMP = 1, EV_OFF = 2, EV_ON = 3; // same-beat order: params first, offs, then ons
const MAX_OFFS = 512;
const MAX_RAMPS = 64;
const EPS = 1e-9;
const I_MACRO = [idx('macro1'), idx('macro2'), idx('macro3'), idx('macro4')];

function parseVel(v) {
  let x = Number(v);
  if (!Number.isFinite(x)) return 0.8;
  if (x > 1) x /= 127; // tolerate MIDI velocities
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export class Sequencer {
  constructor(synth) {
    this.synth = synth;
    this.scr = new Float64Array(2); // ramp scratch: [normalised value, DSP value]
    this.events = [];
    this.songBpm = 0;
    this.loop = true;
    this.lengthBeats = 4;
    this.playing = false;
    this.pos = 0;        // absolute beats since play()
    this.loopStart = 0;  // absolute beat where the current loop pass started
    this.cursor = 0;
    this.lastBeat = 0;

    this.offNote = new Int16Array(MAX_OFFS);
    this.offBeat = new Float64Array(MAX_OFFS);
    this.offLen = 0;

    this.rParam = new Int32Array(MAX_RAMPS);
    this.rFrom = new Float64Array(MAX_RAMPS);   // normalised; NaN → take current value at start
    this.rTo = new Float64Array(MAX_RAMPS);
    this.rStart = new Float64Array(MAX_RAMPS);
    this.rLen = new Float64Array(MAX_RAMPS);
    this.rN = 0;

    // params touched by the song: value before play, and the last value the song wrote
    this.restoreOnStop = true;
    this.touched = new Uint8Array(PARAM_COUNT);
    this.touchedList = new Int32Array(PARAM_COUNT);
    this.touchedN = 0;
    this.saved = new Float64Array(PARAM_COUNT);
    this.written = new Float64Array(PARAM_COUNT);
  }

  /** Parse and load a song (stops playback). Unknown params/types are skipped. */
  load(song) {
    this.stop();
    const out = [];
    let maxEnd = 0;
    const src = (song && Array.isArray(song.events)) ? song.events : [];
    for (let k = 0; k < src.length; k++) {
      const e = src[k];
      if (!e) continue;
      const beat = Number(e.beat) || 0;
      if (beat < 0) continue;
      switch (e.type) {
        case 'on': {
          const note = Math.round(Number(e.note));
          if (!(note >= 0 && note <= 127)) break;
          const dur = Number.isFinite(Number(e.dur)) && Number(e.dur) > 0 ? Number(e.dur) : 1;
          out.push({ beat, order: EV_ON, k, kind: EV_ON, note, vel: parseVel(e.vel ?? e.velocity), dur, pi: -1, value: 0, to: 0, from: NaN, beats: 0 });
          maxEnd = Math.max(maxEnd, beat + dur);
          break;
        }
        case 'off': {
          const note = Math.round(Number(e.note));
          if (!(note >= 0 && note <= 127)) break;
          out.push({ beat, order: EV_OFF, k, kind: EV_OFF, note, vel: 0, dur: 0, pi: -1, value: 0, to: 0, from: NaN, beats: 0 });
          maxEnd = Math.max(maxEnd, beat);
          break;
        }
        case 'param': {
          const p = PARAM_BY_ID[e.id];
          if (!p) break;
          out.push({ beat, order: EV_PARAM, k, kind: EV_PARAM, note: 0, vel: 0, dur: 0, pi: p.index, value: toNumeric(p, e.value), to: 0, from: NaN, beats: 0 });
          maxEnd = Math.max(maxEnd, beat);
          break;
        }
        case 'macro': {
          const i = Math.round(Number(e.index));
          if (!(i >= 0 && i < 4)) break;
          const val = Math.min(1, Math.max(0, Number(e.value) || 0));
          out.push({ beat, order: EV_PARAM, k, kind: EV_PARAM, note: 0, vel: 0, dur: 0, pi: I_MACRO[i], value: val, to: 0, from: NaN, beats: 0 });
          maxEnd = Math.max(maxEnd, beat);
          break;
        }
        case 'ramp':
        case 'ramp-macro': {
          let pi;
          if (e.type === 'ramp') {
            const p = PARAM_BY_ID[e.id];
            if (!p || p.type === 'enum' || p.type === 'bool') break;
            pi = p.index;
          } else {
            const i = Math.round(Number(e.index));
            if (!(i >= 0 && i < 4)) break;
            pi = I_MACRO[i];
          }
          const to = normOf(pi, toNumeric(PARAMS[pi], e.to));
          const from = e.from !== undefined ? normOf(pi, toNumeric(PARAMS[pi], e.from)) : NaN;
          const beats = Math.max(0, Number(e.beats) || 0);
          out.push({ beat, order: EV_RAMP, k, kind: EV_RAMP, note: 0, vel: 0, dur: 0, pi, value: 0, to, from, beats });
          maxEnd = Math.max(maxEnd, beat + beats);
          break;
        }
      }
    }
    out.sort((a, b) => a.beat - b.beat || a.order - b.order || a.k - b.k);
    this.events = out;
    this.songBpm = song && Number(song.bpm) > 0 ? Number(song.bpm) : 0;
    this.loop = song ? song.loop !== false : true;
    const lb = song && Number(song.lengthBeats);
    this.lengthBeats = lb > 0 ? lb : Math.max(4, Math.ceil((maxEnd - EPS) / 4) * 4);
    this.lastBeat = 0;
    return this;
  }

  get loaded() { return this.events.length > 0; }

  /** Beat position inside the song/loop. */
  get beat() { return this.playing ? this.pos - this.loopStart : this.lastBeat; }

  play() {
    if (this.playing) this.stop();
    if (this.events.length === 0) return;
    this.pos = 0;
    this.loopStart = 0;
    this.cursor = 0;
    this.touchedN = 0;
    this.touched.fill(0);
    // the song tempo is a change like any other: restored on stop (unless the user changed the tempo meanwhile),
    // so a demo phrase no longer leaves the user's arp / synced LFOs and delays at the phrase's tempo
    if (this.songBpm > 0) this._write(I_BPM, toNumeric(PARAM_BY_ID['global.bpm'], this.songBpm));
    this.playing = true;
    this.synth.clockBeat = 0; // tempo-synced global LFOs lock to the song
  }

  /** Stop and release every note the sequencer is holding; cancel ramps; restore touched params. */
  stop() {
    const wasPlaying = this.playing;
    this.lastBeat = this.playing ? this.pos - this.loopStart : this.lastBeat;
    this.playing = false;
    const synth = this.synth;
    const hadNotes = this.offLen > 0;
    for (let i = 0; i < this.offLen; i++) synth.noteOff(this.offNote[i]);
    this.offLen = 0;
    this.rN = 0;
    if (wasPlaying || hadNotes) synth.perf.clearLatched();
    this._restore();
  }

  /** _write(pi, this.scr[1]) without a double argument (audio-path ramps). */
  _writeS(pi) {
    const x = this.scr[1];
    if (!this.touched[pi]) {
      this.touched[pi] = 1;
      this.touchedList[this.touchedN++] = pi;
      this.saved[pi] = this.synth.base[pi];
    }
    this.written[pi] = x;
    const synth = this.synth, base = synth.base;
    if (base[pi] !== x) { base[pi] = x; synth.effDirty = true; }
  }

  _write(pi, x) {
    if (!this.touched[pi]) {
      this.touched[pi] = 1;
      this.touchedList[this.touchedN++] = pi;
      this.saved[pi] = this.synth.base[pi];
    }
    this.written[pi] = x;
    this.synth._setParamIndex(pi, x);
  }

  _restore() {
    const synth = this.synth;
    for (let k = 0; k < this.touchedN; k++) {
      const pi = this.touchedList[k];
      // only if the user has not changed it since the song last wrote it
      if (this.restoreOnStop && synth.base[pi] === this.written[pi]) synth._setParamIndex(pi, this.saved[pi]);
      this.touched[pi] = 0;
    }
    this.touchedN = 0;
  }

  /** Called by the synth at the start of each control block of n samples. */
  tick(n) {
    if (!this.playing && this.offLen === 0 && this.rN === 0) return;
    const synth = this.synth;
    const now = this.pos;

    // due note-offs
    for (let i = 0; i < this.offLen; i++) {
      if (this.offBeat[i] <= now + EPS) {
        const note = this.offNote[i];
        this.offLen--;
        this.offNote[i] = this.offNote[this.offLen];
        this.offBeat[i] = this.offBeat[this.offLen];
        i--;
        synth.noteOff(note);
      }
    }

    if (this.playing) {
      const evs = this.events;
      for (let pass = 0; pass < 4; pass++) {
        while (this.cursor < evs.length) {
          const e = evs[this.cursor];
          const t = this.loopStart + e.beat;
          if (t > now + EPS) break;
          if (e.beat < this.lengthBeats - EPS) this._fire(e, t);
          this.cursor++;
        }
        if (now + EPS >= this.loopStart + this.lengthBeats) {
          if (this.loop) { this.loopStart += this.lengthBeats; this.cursor = 0; continue; }
          this.lastBeat = this.lengthBeats;
          this.playing = false; // pending offs / ramps still finish
        }
        break;
      }
    }

    // ramps (normalised linear, written once per control block; values pass through the scratch array so no
    // double crosses a call boundary → no per-block garbage)
    const S = this.scr;
    for (let r = 0; r < this.rN; r++) {
      const pi = this.rParam[r];
      if (this.rFrom[r] !== this.rFrom[r]) normTo(this.rFrom, r, pi, synth.base, pi);
      let t = this.rLen[r] > 0 ? (now - this.rStart[r]) / this.rLen[r] : 1;
      if (t < 0) continue;
      if (t > 1) t = 1;
      S[0] = this.rFrom[r] + (this.rTo[r] - this.rFrom[r]) * t;
      denormTo(S, 1, pi, S, 0);
      this._writeS(pi);
      if (t >= 1) { this._removeRamp(r); r--; }
    }
    // natural end of a one-shot song: once everything has finished, restore touched params
    if (!this.playing && this.offLen === 0 && this.rN === 0 && this.touchedN > 0) this._restore();

    this.pos += (n * synth.bpm) / (60 * synth.sr);
  }

  _fire(e, t) {
    const synth = this.synth;
    switch (e.kind) {
      case EV_ON: {
        // a re-struck note ends its previous pending off (the retrigger already released it)
        for (let i = 0; i < this.offLen; i++) {
          if (this.offNote[i] === e.note) {
            this.offLen--;
            this.offNote[i] = this.offNote[this.offLen];
            this.offBeat[i] = this.offBeat[this.offLen];
            break;
          }
        }
        synth.noteOn(e.note, e.vel);
        if (this.offLen < MAX_OFFS) {
          this.offNote[this.offLen] = e.note;
          this.offBeat[this.offLen] = t + e.dur;
          this.offLen++;
        } else {
          synth.noteOff(e.note); // table full: never leave a stuck note
        }
        break;
      }
      case EV_OFF: {
        for (let i = 0; i < this.offLen; i++) {
          if (this.offNote[i] === e.note) {
            this.offLen--;
            this.offNote[i] = this.offNote[this.offLen];
            this.offBeat[i] = this.offBeat[this.offLen];
            break;
          }
        }
        synth.noteOff(e.note);
        break;
      }
      case EV_PARAM:
        this._cancelRamp(e.pi);
        this._write(e.pi, e.value);
        break;
      case EV_RAMP: {
        this._cancelRamp(e.pi);
        if (e.beats <= 0) { this._write(e.pi, denormOf(e.pi, e.to)); break; }
        if (this.rN >= MAX_RAMPS) break;
        const r = this.rN++;
        this.rParam[r] = e.pi;
        this.rFrom[r] = e.from === e.from ? e.from : normOf(e.pi, synth.base[e.pi]);
        this.rTo[r] = e.to;
        this.rStart[r] = t;
        this.rLen[r] = e.beats;
        break;
      }
    }
  }

  _cancelRamp(pi) {
    for (let r = 0; r < this.rN; r++) if (this.rParam[r] === pi) { this._removeRamp(r); r--; }
  }

  _removeRamp(r) {
    const last = --this.rN;
    if (r !== last) {
      this.rParam[r] = this.rParam[last]; this.rFrom[r] = this.rFrom[last]; this.rTo[r] = this.rTo[last];
      this.rStart[r] = this.rStart[last]; this.rLen[r] = this.rLen[last];
    }
  }
}
