// Performance layer: scale lock → chord memory → arpeggiator, plus input-level sustain pedal.
// Pure ES module, allocation-free after construction.
//
// Input notes (live keys, MIDI, sequencer) enter via noteOn/noteOff. Each input note is expanded once at
// note-on (scale snap + chord) and the expansion is remembered, so a note-off always releases exactly what
// its note-on produced — even if the scale/chord settings changed in between (no stuck notes).
// Output goes to `target.voiceOn(note, vel)` / `target.voiceOff(note)` (the synth's voice allocator).
//
// The arpeggiator clock runs in beats from `global.bpm`, is advanced once per control block by `tick()`
// (events fire on control-block boundaries → sample-accurate to CR), and restarts on the first note of
// a new phrase so live playing and sequenced chords land on the grid.

import { SCALES, CHORDS, PARAM_BY_ID, idx, divToBeats } from './params.js';
import { Rng } from './util.js';

// Indexed by the enum option index (the DSP value), so build from the schema's option order.
const SCALE_LIST = PARAM_BY_ID['scale.type'].options.map(k => SCALES[k]);
const CHORD_LIST = PARAM_BY_ID['chord.type'].options.map(k => CHORDS[k]);
const ARP_RATE_BEATS = PARAM_BY_ID['arp.rate'].options.map(divToBeats);

const MAXC = 8;          // max notes per input expansion
const POOL = 64;         // max arp pool entries
const PAT = POOL * 4 * 2;

export const ARP_UP = 0;
export const ARP_DOWN = 1;
export const ARP_UPDOWN = 2;
export const ARP_RANDOM = 3;
export const ARP_ORDER = 4;
export const ARP_CHORD = 5;

export class Performance {
  /**
   * @param {number} sampleRate
   * @param {{voiceOn(note:number, vel:number):void, voiceOff(note:number):void}} target
   * @param {number} seed
   */
  constructor(sampleRate, target, seed = 1) {
    this.sr = sampleRate;
    this.target = target;
    this.rng = new Rng((seed * 2654435761) >>> 0 || 7);

    this.iArpOn = idx('arp.on'); this.iArpMode = idx('arp.mode'); this.iArpRate = idx('arp.rate');
    this.iArpOct = idx('arp.oct'); this.iArpGate = idx('arp.gate'); this.iArpSwing = idx('arp.swing');
    this.iArpLatch = idx('arp.latch'); this.iChord = idx('chord.type');
    this.iScaleType = idx('scale.type'); this.iScaleRoot = idx('scale.root');

    // config cache
    this.arpOn = false; this.mode = ARP_UP; this.rateBeats = 0.25; this.oct = 1;
    this.gate = 0.6; this.swing = 0; this.latch = false;
    this.chordIdx = 0; this.scaleIdx = 0; this.root = 0;
    this.snap = new Int8Array(12);

    // input notes
    this.down = new Uint8Array(128);   // key (or sequencer) currently down
    this.sus = new Uint8Array(128);    // released while sustain pedal down (still sounding)
    this.expN = new Uint8Array(128);
    this.exp = new Int16Array(128 * MAXC);
    this.expVel = new Float64Array(128);
    this.toArp = new Uint8Array(128);  // expansion routed to the arp pool (vs direct voices)
    this.nHeld = 0;                    // count of notes with down|sus
    this.sustain = false;

    // arp pool (insertion order)
    this.pNote = new Int16Array(POOL); this.pVel = new Float64Array(POOL); this.pSrc = new Int16Array(POOL);
    this.pLen = 0;
    this.latchArmed = false;

    // pattern
    this.patNote = new Int16Array(PAT); this.patVel = new Float64Array(PAT); this.patLen = 0;
    this.patDirty = true;
    this.uN = new Int16Array(POOL); this.uV = new Float64Array(POOL); this.uLen = 0; // dedup, insertion order
    this.sN = new Int16Array(POOL); this.sV = new Float64Array(POOL);                // sorted ascending

    // clock
    this.bpm = 110.5; this.bpm = 110;
    this.running = false;
    this.beat = 0;       // arp beat position since the phrase started
    this.nextStep = 0;
    this.stepCount = 0;
    this.arpPos = 0;
    this.arpStep = -1;   // pattern index of the last step (UI)
    this.lastArpNote = -1;

    // currently sounding arp notes
    this.onNotes = new Int16Array(POOL * 2);
    this.tieNotes = new Int16Array(POOL * 2);
    this.onLen = 0;
    this.offBeat = Infinity;
  }

  // ───────────────────────── configuration ─────────────────────────

  /** Pull settings from the effective value array (call once per control block). */
  update(eff) {
    const scaleIdx = eff[this.iScaleType] | 0, root = eff[this.iScaleRoot] | 0;
    if (scaleIdx !== this.scaleIdx || root !== this.root) {
      this.scaleIdx = scaleIdx; this.root = root; this._buildSnap();
    }
    this.chordIdx = eff[this.iChord] | 0;

    const mode = eff[this.iArpMode] | 0, oct = eff[this.iArpOct] | 0;
    if (mode !== this.mode || oct !== this.oct) { this.mode = mode; this.oct = oct < 1 ? 1 : oct; this.patDirty = true; }
    const rb = ARP_RATE_BEATS[eff[this.iArpRate] | 0];
    this.rateBeats = rb > 0 ? rb : 0.25;
    this.gate = eff[this.iArpGate];
    this.swing = eff[this.iArpSwing];

    const latch = eff[this.iArpLatch] >= 0.5;
    if (latch !== this.latch) {
      this.latch = latch;
      if (!latch) {
        // drop latched entries whose keys are no longer held
        for (let i = 0; i < this.pLen; i++) {
          const s = this.pSrc[i];
          if (!this.down[s] && !this.sus[s]) { this._poolRemoveSrc(s); i = -1; }
        }
        this.latchArmed = false;
      } else {
        this.latchArmed = this.nHeld === 0 && this.pLen > 0;
      }
    }

    const arpOn = eff[this.iArpOn] >= 0.5;
    if (arpOn !== this.arpOn) this._switchArp(arpOn);
  }

  _buildSnap() {
    const sc = SCALE_LIST[this.scaleIdx];
    for (let pc = 0; pc < 12; pc++) {
      if (!sc) { this.snap[pc] = 0; continue; }
      let best = 99;
      for (let k = 0; k < sc.length; k++) {
        for (let w = -12; w <= 12; w += 12) {
          const d = sc[k] + w - pc;
          // nearest; ties prefer down (negative offset)
          if (Math.abs(d) < Math.abs(best) || (Math.abs(d) === Math.abs(best) && d < best)) best = d;
        }
      }
      this.snap[pc] = best;
    }
  }

  snapNote(note) {
    if (!SCALE_LIST[this.scaleIdx]) return note;
    const pc = (((note - this.root) % 12) + 12) % 12;
    return note + this.snap[pc];
  }

  _switchArp(on) {
    this.arpOn = on;
    if (on) {
      for (let n = 0; n < 128; n++) {
        if ((this.down[n] || this.sus[n]) && !this.toArp[n]) {
          this._releaseDirect(n);
          this.toArp[n] = 1;
          this._poolAdd(n);
        }
      }
    } else {
      this._arpStop();
      this.pLen = 0; this.patDirty = true; this.latchArmed = false;
      for (let n = 0; n < 128; n++) {
        if ((this.down[n] || this.sus[n]) && this.toArp[n]) {
          this.toArp[n] = 0;
          const b = n * MAXC, v = this.expVel[n];
          for (let k = 0; k < this.expN[n]; k++) this.target.voiceOn(this.exp[b + k], v);
        }
      }
    }
  }

  // ───────────────────────── input ─────────────────────────

  noteOn(note, vel) {
    note = Math.round(note);
    if (!(note >= 0 && note <= 127)) return;
    if (!(vel > 0)) { this.noteOff(note); return; }
    if (vel > 1) vel = 1;
    if (this.down[note] || this.sus[note]) this._releaseInput(note); // re-press: release previous expansion
    this.down[note] = 1;
    this.sus[note] = 0;
    this.nHeld++;

    // expansion: scale lock → chord
    const root = this.snapNote(note);
    const iv = CHORD_LIST[this.chordIdx] || CHORD_LIST[0];
    const b = note * MAXC;
    let m = 0;
    for (let k = 0; k < iv.length && m < MAXC; k++) {
      let x = root + iv[k];
      if (this.chordIdx !== 0 && SCALE_LIST[this.scaleIdx]) x = this.snapNote(x); // keep chord tones in key
      if (x < 0 || x > 127) continue;
      let dup = false;
      for (let j = 0; j < m; j++) if (this.exp[b + j] === x) { dup = true; break; }
      if (!dup) this.exp[b + m++] = x;
    }
    this.expN[note] = m;
    this.expVel[note] = vel;

    if (this.arpOn) {
      this.toArp[note] = 1;
      this._poolAdd(note);
    } else {
      this.toArp[note] = 0;
      for (let k = 0; k < m; k++) this.target.voiceOn(this.exp[b + k], vel);
    }
  }

  noteOff(note) {
    note = Math.round(note);
    if (!(note >= 0 && note <= 127) || !this.down[note]) return;
    if (this.sustain) { this.down[note] = 0; this.sus[note] = 1; return; } // still held (by the pedal)
    this._releaseInput(note);
  }

  setSustain(on) {
    on = !!on;
    if (on === this.sustain) return;
    this.sustain = on;
    if (!on) {
      for (let n = 0; n < 128; n++) if (this.sus[n] && !this.down[n]) this._releaseInput(n);
    }
  }

  /** Drop latched arp notes whose keys are no longer held (e.g. when a demo sequence stops). */
  clearLatched() {
    for (let i = 0; i < this.pLen; i++) {
      const s = this.pSrc[i];
      if (!this.down[s] && !this.sus[s]) { this._poolRemoveSrc(s); i = -1; }
    }
    this.latchArmed = false;
  }

  /** Forget everything (does not call voiceOff — the synth silences voices itself). */
  allOff() {
    this.down.fill(0); this.sus.fill(0); this.expN.fill(0); this.toArp.fill(0);
    this.nHeld = 0; this.sustain = false;
    this.pLen = 0; this.patLen = 0; this.patDirty = true; this.latchArmed = false;
    this.onLen = 0; this.offBeat = Infinity;
    this.running = false; this.arpStep = -1; this.lastArpNote = -1;
  }

  /** Fill `out` (plain array, reused) with notes currently held (keys down or sustained). */
  heldNotes(out) {
    out.length = 0;
    if (this.nHeld === 0) return out;
    for (let n = 0; n < 128; n++) if (this.down[n] || this.sus[n]) out.push(n);
    return out;
  }

  _releaseInput(note) {
    const wasHeld = this.down[note] || this.sus[note];
    this.down[note] = 0;
    this.sus[note] = 0;
    if (wasHeld && this.nHeld > 0) this.nHeld--;
    if (this.toArp[note]) {
      this.toArp[note] = 0;
      if (this.latch) { if (this.nHeld === 0) this.latchArmed = true; }
      else this._poolRemoveSrc(note);
    } else {
      this._releaseDirect(note);
    }
  }

  _releaseDirect(note) {
    const b = note * MAXC;
    for (let k = 0; k < this.expN[note]; k++) this.target.voiceOff(this.exp[b + k]);
  }

  // ───────────────────────── arp pool ─────────────────────────

  _poolAdd(src) {
    if (this.latch && this.latchArmed) {
      // fresh phrase after all keys were released: the new chord replaces the latched one
      this.pLen = 0;
      this.latchArmed = false;
    }
    this._poolRemoveSrc(src, true);
    const b = src * MAXC, v = this.expVel[src];
    for (let k = 0; k < this.expN[src] && this.pLen < POOL; k++) {
      this.pNote[this.pLen] = this.exp[b + k];
      this.pVel[this.pLen] = v;
      this.pSrc[this.pLen] = src;
      this.pLen++;
    }
    this.patDirty = true;
    if (!this.running && this.pLen > 0) {
      this.running = true;
      this.beat = 0; this.nextStep = 0; this.stepCount = 0; this.arpPos = 0;
      this.lastArpNote = -1;
    }
  }

  _poolRemoveSrc(src, keepRunning = false) {
    let w = 0;
    for (let r = 0; r < this.pLen; r++) {
      if (this.pSrc[r] === src) continue;
      this.pNote[w] = this.pNote[r]; this.pVel[w] = this.pVel[r]; this.pSrc[w] = this.pSrc[r];
      w++;
    }
    if (w !== this.pLen) { this.pLen = w; this.patDirty = true; }
    if (this.pLen === 0 && !keepRunning) this._arpStop();
  }

  _arpStop() {
    this._releaseArpNotes();
    this.running = false;
    this.arpStep = -1;
  }

  _releaseArpNotes() {
    for (let i = 0; i < this.onLen; i++) this.target.voiceOff(this.onNotes[i]);
    this.onLen = 0;
    this.offBeat = Infinity;
  }

  _buildPattern() {
    this.patDirty = false;
    // dedup (insertion order)
    let u = 0;
    for (let i = 0; i < this.pLen; i++) {
      const n = this.pNote[i];
      let dup = false;
      for (let j = 0; j < u; j++) if (this.uN[j] === n) { dup = true; break; }
      if (!dup) { this.uN[u] = n; this.uV[u] = this.pVel[i]; u++; }
    }
    this.uLen = u;
    // sorted copy (insertion sort, tiny n)
    for (let i = 0; i < u; i++) {
      const n = this.uN[i], v = this.uV[i];
      let j = i - 1;
      while (j >= 0 && this.sN[j] > n) { this.sN[j + 1] = this.sN[j]; this.sV[j + 1] = this.sV[j]; j--; }
      this.sN[j + 1] = n; this.sV[j + 1] = v;
    }
    const oct = this.oct;
    const useOrder = this.mode === ARP_ORDER;
    const srcN = useOrder ? this.uN : this.sN, srcV = useOrder ? this.uV : this.sV;
    let L = 0;
    for (let o = 0; o < oct; o++) {
      for (let i = 0; i < u; i++) {
        const n = srcN[i] + 12 * o;
        if (n > 127) continue;
        this.patNote[L] = n; this.patVel[L] = srcV[i]; L++;
      }
    }
    if (this.mode === ARP_DOWN) {
      for (let i = 0, j = L - 1; i < j; i++, j--) {
        const tn = this.patNote[i]; this.patNote[i] = this.patNote[j]; this.patNote[j] = tn;
        const tv = this.patVel[i]; this.patVel[i] = this.patVel[j]; this.patVel[j] = tv;
      }
    } else if (this.mode === ARP_UPDOWN && L > 2) {
      const L0 = L;
      for (let i = L0 - 2; i >= 1; i--) { this.patNote[L] = this.patNote[i]; this.patVel[L] = this.patVel[i]; L++; }
    }
    this.patLen = L;
    // continue after the last played note where that is meaningful
    if (this.lastArpNote >= 0 && L > 0 && (this.mode === ARP_UP || this.mode === ARP_DOWN || this.mode === ARP_ORDER)) {
      for (let i = 0; i < L; i++) if (this.patNote[i] === this.lastArpNote) { this.arpPos = i + 1; break; }
    }
  }

  // ───────────────────────── clock ─────────────────────────

  /**
   * Called at the start of every control block (n samples long). Fires due note-offs, then due steps.
   * @param {number} n    samples in this control block
   * @param {number} [bpm] tempo; if omitted uses the `bpm` field (hot path: set the field, avoids boxing)
   */
  tick(n, bpm) {
    if (bpm !== undefined) this.bpm = bpm;
    if (!this.running) return;
    if (this.onLen > 0 && this.beat >= this.offBeat - 1e-9) this._releaseArpNotes();
    let guard = 0;
    while (this.beat >= this.nextStep - 1e-9 && guard++ < 8) {
      if (this.patDirty) this._buildPattern();
      const swing = this.swing;
      const stepDur = this.rateBeats * ((this.stepCount & 1) ? 1 - swing : 1 + swing);
      let g = this.gate;
      if (g > 1) g = 1;
      if (g >= 0.999) {
        // gate 100% = tie: the next step starts before the previous notes end
        // (mono/legato voice modes slide between steps without re-attacking)
        const n = this.onLen;
        for (let i = 0; i < n; i++) this.tieNotes[i] = this.onNotes[i];
        this.onLen = 0;
        this._fireStep();
        for (let i = 0; i < n; i++) this.target.voiceOff(this.tieNotes[i]);
        this.offBeat = Infinity;
      } else {
        this._releaseArpNotes();
        this._fireStep();
        this.offBeat = this.nextStep + g * stepDur;
      }
      this.nextStep += stepDur;
      this.stepCount++;
    }
    if (this.onLen > 0 && this.beat >= this.offBeat - 1e-9) this._releaseArpNotes();
    this.beat += (n * this.bpm) / (60 * this.sr);
  }

  _fireStep() {
    const L = this.patLen;
    if (L === 0 || this.uLen === 0) { this.arpStep = -1; return; }
    const t = this.target;
    if (this.mode === ARP_CHORD) {
      const shift = 12 * (this.arpPos % this.oct);
      this.arpStep = this.arpPos % this.oct;
      this.arpPos++;
      for (let i = 0; i < this.uLen; i++) {
        const n = this.sN[i] + shift;
        if (n > 127) continue;
        t.voiceOn(n, this.sV[i]);
        this.onNotes[this.onLen++] = n;
      }
      this.lastArpNote = this.sN[0] + shift;
      return;
    }
    let i;
    if (this.mode === ARP_RANDOM) {
      i = (this.rng.next() * L) | 0;
      if (L > 1 && this.patNote[i] === this.lastArpNote) i = (i + 1 + ((this.rng.next() * (L - 1)) | 0)) % L;
    } else {
      i = this.arpPos % L;
      this.arpPos = i + 1;
    }
    const n = this.patNote[i];
    this.arpStep = i;
    this.lastArpNote = n;
    t.voiceOn(n, this.patVel[i]);
    this.onNotes[this.onLen++] = n;
  }
}
