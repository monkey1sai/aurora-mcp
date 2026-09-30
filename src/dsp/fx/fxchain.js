// Global effects chain: drive → chorus → phaser → delay → reverb → eq → comp (all in place, stereo).
// `eff` is the Synth's Float64Array of effective (DSP-encoded) parameter values indexed by idx(id).
// Processing is split into ≤ 32-sample chunks so every effect updates its smoothed parameters /
// modulation at least that often regardless of the host block size. Effects that are off (and whose tails
// have died) are skipped at ~zero cost.
import { idx } from '../params.js';
import { Drive } from './drive.js';
import { Chorus } from './chorus.js';
import { Phaser } from './phaser.js';
import { Delay } from './delay.js';
import { Reverb } from './reverb.js';
import { EQ } from './eq.js';
import { Comp } from './comp.js';

export { Drive, Chorus, Phaser, Delay, Reverb, EQ, Comp };
export { Limiter } from './limiter.js';

const CHUNK = 32;

export class FxChain {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.drive = new Drive(sampleRate);
    this.chorus = new Chorus(sampleRate);
    this.phaser = new Phaser(sampleRate);
    this.delay = new Delay(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.eq = new EQ(sampleRate);
    this.comp = new Comp(sampleRate);
    this.iBpm = idx('global.bpm');
    this.iDriveOn = idx('drive.on'); this.iChorusOn = idx('chorus.on'); this.iPhaserOn = idx('phaser.on');
    this.iDelayOn = idx('delay.on'); this.iReverbOn = idx('reverb.on');
    this.iEqLow = idx('eq.low'); this.iEqMid = idx('eq.mid'); this.iEqHigh = idx('eq.high');
    this.iComp = idx('comp.amount');
    this.inQuiet = 0; // samples since the chain input was last above −120 dBFS
    this.quietLimit = Math.round(0.5 * sampleRate);
  }

  /** In place on L/R[0..n). bpm defaults to eff[global.bpm]. */
  process(L, R, n, eff, bpm) {
    if (!(bpm > 0)) bpm = eff[this.iBpm];
    this.delay.bpm = bpm; // field, not an argument: keeps the per-chunk calls free of boxed doubles
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const a = L[i], b = R[i];
      const m = (a < 0 ? -a : a) + (b < 0 ? -b : b);
      if (m > pk) pk = m;
    }
    if (pk > 1e-6) this.inQuiet = 0; else if (this.inQuiet < 1e9) this.inQuiet += n;
    // Gate here (hot, optimised code) rather than inside each effect: an effect that is off and idle is
    // not even called, so its possibly-unoptimised early-return path can't box parameter reads.
    const dOn = eff[this.iDriveOn] >= 0.5, cOn = eff[this.iChorusOn] >= 0.5, pOn = eff[this.iPhaserOn] >= 0.5;
    const yOn = eff[this.iDelayOn] >= 0.5, rOn = eff[this.iReverbOn] >= 0.5;
    const eOn = eff[this.iEqLow] !== 0 || eff[this.iEqMid] !== 0 || eff[this.iEqHigh] !== 0;
    const kOn = eff[this.iComp] > 0;
    const drive = this.drive, chorus = this.chorus, phaser = this.phaser, delay = this.delay;
    const reverb = this.reverb, eq = this.eq, comp = this.comp;
    for (let off = 0; off < n; off += CHUNK) {
      const m = n - off < CHUNK ? n - off : CHUNK;
      if (dOn || drive.active) drive.process(L, R, off, m, eff);
      if (cOn || chorus.active) chorus.process(L, R, off, m, eff);
      if (pOn || phaser.active) phaser.process(L, R, off, m, eff);
      if (yOn || delay.active) delay.process(L, R, off, m, eff);
      if (rOn || reverb.active) reverb.process(L, R, off, m, eff);
      if (eOn || eq.busy) eq.process(L, R, off, m, eff);
      if (kOn || comp.amt > 0) comp.process(L, R, off, m, eff);
    }
  }

  reset() {
    this.drive.reset();
    this.chorus.reset();
    this.phaser.reset();
    this.delay.reset();
    this.reverb.reset();
    this.eq.reset();
    this.comp.reset();
    this.inQuiet = 0;
  }

  /** True while any effect still has internal state that can produce output (e.g. delay/reverb tails). */
  tailActive() {
    if (this.delay.tailActive() || this.reverb.tailActive()) return true;
    const mod = this.drive.tailActive() || this.chorus.tailActive() || this.phaser.tailActive();
    return mod && this.inQuiet < this.quietLimit;
  }

  /** Glue-compressor gain reduction in dB (≤ 0), for meters. */
  getCompReduction() { return this.comp.getReduction(); }
}
