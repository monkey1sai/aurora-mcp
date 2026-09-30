// Stereo tape-flavoured delay: tempo sync (divToBeats × 60/bpm) or free time, ping-pong cross-feed,
// feedback-path tone (2-pole LP + 1-pole HP, darker as tone → 0), gentle loop saturation, wow + flutter
// wobble, and slewed (rate-limited) delay-time changes that glide like tape instead of zippering.
// Turning the delay off gates only its input: echoes already in the loop keep ringing out naturally.
import { idx, PARAM_BY_ID, divToBeats } from '../params.js';
import { DENORMAL } from '../util.js';
import { nextPow2 } from './common.js';

const TWO_PI = Math.PI * 2;
const MAX_TIME = 3.1; // seconds (1/2 note at 40 BPM = 3 s)

export class Delay {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.iOn = idx('delay.on');
    this.iTime = idx('delay.time');
    this.iSync = idx('delay.sync');
    this.iFb = idx('delay.feedback');
    this.iPP = idx('delay.pingpong');
    this.iTone = idx('delay.tone');
    this.iWob = idx('delay.wobble');
    this.iMix = idx('delay.mix');
    this.iBpm = idx('global.bpm');
    const opts = PARAM_BY_ID['delay.sync'].options;
    this.syncBeats = new Float64Array(opts.length);
    for (let i = 0; i < opts.length; i++) this.syncBeats[i] = divToBeats(opts[i]);

    this.size = nextPow2(Math.ceil((MAX_TIME + 0.05) * sampleRate) + 8);
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size * 2);
    this.w = 0;

    this.fadeStep = 1 / (0.02 * sampleRate);
    this.inG = 0.5;
    this.active = false; this.inited = false;
    this.silent = 0; // consecutive near-silent samples written to the loop

    this.dly = 0.375 * sampleRate;   // current (slewed) delay in samples
    this.dPrev = this.dly;
    this.fb = 0.35; this.pp = 0.5; this.tone = 0.5; this.wob = 0.1; this.mix = 0.25;
    this.gFb = 0.35; this.gPP = 0.5; this.gDry = 1.5; this.gWet = 0.5; this.gC = 1.5; this.gS = 0.5;
    this.bpm = 0.5;  // set by FxChain each block (≤ 1 → fall back to eff[global.bpm])
    this.tgt = 0.5;  // target delay (samples)
    this.maxSlew = 0.45; // |d delay / dt| ≤ 0.45 → tape-like glide within ≈ −10…+6.5 semitones

    // wobble LFOs
    this.wowPh = 0.5; this.flPh = 0.37; this.drift = 0.5; this.driftT = 0.5; this.driftCnt = 0.5;
    this.seed = 0x2468ace1;
    this.modPrevL = 0.5; this.modPrevR = 0.5; this.modL = 0.5; this.modR = 0.5;

    // loop filters: SVF LP (2-pole) + 1-pole HP, per channel
    this.lp = new Float64Array(4); // ic1L, ic2L, ic1R, ic2R
    this.hpL = 0.5; this.hpR = 0.5;
    this.lpG = 0.5; this.lpA1 = 0.5; this.hpG = 0.5;
    this.lpK = 1 / 0.62;
    this.outL = 0.5; this.outR = 0.5;
    this.reset();
  }

  reset() {
    this.buf.fill(0);
    this.w = 0;
    this.inG = 0; this.active = false; this.inited = false; this.silent = 0;
    this.lp.fill(0); this.hpL = this.hpR = 0;
    this.outL = this.outR = 0;
    this.wowPh = 0; this.flPh = 0.37; this.drift = 0; this.driftT = 0; this.driftCnt = 0;
    this.modPrevL = this.modPrevR = this.modL = this.modR = 0;
  }

  /** True while echoes may still be audible (idle, or silent for longer than the loop, → false). */
  tailActive() { return this.active && this.silent < this.dly + 0.1 * this.sr; }

  rnd() {
    let s = this.seed;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this.seed = s;
    return s / 2147483648 - 1;
  }

  /** Target delay in samples → this.tgt (tempo from this.bpm when synced). */
  targetDelay(eff) {
    const si = Math.max(0, Math.min(this.syncBeats.length - 1, eff[this.iSync] | 0));
    let t;
    if (si > 0) {
      let b = this.bpm > 1 ? this.bpm : eff[this.iBpm];
      if (!(b > 1)) b = 110;
      t = (this.syncBeats[si] * 60) / b;
    } else t = eff[this.iTime];
    if (t > MAX_TIME) t = MAX_TIME;
    if (t < 0.005) t = 0.005;
    this.tgt = t * this.sr;
  }

  /** Send-style dry/wet law: dry stays at unity up to mix 0.5, wet reaches unity at 0.5. */
  mixGains() {
    const m = this.mix;
    this.gDry = m <= 0.5 ? 1 : 2 * (1 - m);
    this.gWet = m >= 0.5 ? 1 : 2 * m;
  }

  setFilters() {
    const sr = this.sr, tone = this.tone;
    const fLP = Math.min(0.42 * sr, 1100 * Math.pow(18000 / 1100, tone));
    const fHP = 25 * Math.pow(260 / 25, tone);
    const g = Math.tan((Math.PI * fLP) / sr);
    this.lpG = g;
    this.lpA1 = 1 / (1 + g * (g + this.lpK));
    const h = Math.tan((Math.PI * fHP) / sr);
    this.hpG = h / (1 + h);
  }

  /** In place on L/R[off..off+n). `bpm` (optional) sets the sync tempo; otherwise this.bpm / global.bpm. */
  process(L, R, off, n, eff, bpm) {
    const on = eff[this.iOn] >= 0.5 ? 1 : 0;
    if (!this.active) {
      if (!on) return;
      this.active = true;
      this.inG = 0; this.silent = 0;
      this.inited = false;
    }
    const sr = this.sr;
    if (bpm > 0) this.bpm = bpm;
    this.targetDelay(eff);
    const tgt = this.tgt;
    const tFb = eff[this.iFb], tPP = eff[this.iPP], tTone = eff[this.iTone], tWob = eff[this.iWob], tMix = eff[this.iMix];
    if (!this.inited) {
      this.dly = tgt; this.dPrev = tgt;
      this.fb = tFb; this.pp = tPP; this.tone = tTone; this.wob = tWob; this.mix = tMix;
      this.gFb = tFb; this.gPP = tPP; this.mixGains();
      this.gC = Math.cos(tPP * Math.PI * 0.5); this.gS = Math.sin(tPP * Math.PI * 0.5);
      this.inited = true;
    }
    const k = 1 - Math.exp(-n / (0.05 * sr));
    this.fb += (tFb - this.fb) * k;
    this.pp += (tPP - this.pp) * k;
    this.tone += (tTone - this.tone) * k;
    this.wob += (tWob - this.wob) * k;
    this.mix += (tMix - this.mix) * k;
    this.setFilters();

    // delay-time slew: one-pole (~120 ms) then rate-limited
    this.dPrev = this.dly;
    let step = (tgt - this.dly) * (1 - Math.exp(-n / (0.12 * sr)));
    const lim = this.maxSlew * n;
    if (step > lim) step = lim; else if (step < -lim) step = -lim;
    this.dly += step;
    if (Math.abs(tgt - this.dly) < 0.01) this.dly = tgt;

    // wobble: wow (~0.55 Hz) + flutter (~7.3 Hz) + slow random drift, L/R offset
    this.wowPh += (0.55 * n) / sr; this.wowPh -= Math.floor(this.wowPh);
    this.flPh += (7.3 * n) / sr; this.flPh -= Math.floor(this.flPh);
    this.driftCnt -= n;
    if (this.driftCnt <= 0) { this.driftT = this.rnd(); this.driftCnt = (0.4 + 0.5 * (this.rnd() * 0.5 + 0.5)) * sr; }
    this.drift += (this.driftT - this.drift) * (1 - Math.exp(-n / (0.35 * sr)));
    const wob = this.wob;
    const wowD = wob * 0.0026 * sr, flD = wob * wob * 0.00022 * sr, drD = wob * 0.0012 * sr;
    this.modPrevL = this.modL; this.modPrevR = this.modR;
    this.modL = wowD * Math.sin(TWO_PI * this.wowPh) + flD * Math.sin(TWO_PI * this.flPh) + drD * this.drift;
    this.modR = wowD * Math.sin(TWO_PI * (this.wowPh + 0.19)) + flD * Math.sin(TWO_PI * (this.flPh + 0.31)) + drD * this.drift;

    const inv = 1 / n;
    const d0L = this.dPrev + this.modPrevL, d1L = this.dly + this.modL;
    const d0R = this.dPrev + this.modPrevR, d1R = this.dly + this.modR;
    const pFb = this.gFb, pPP = this.gPP, pDry = this.gDry, pWet = this.gWet, pC = this.gC, pS = this.gS;
    this.gFb = this.fb; this.gPP = this.pp; this.mixGains();
    this.gC = Math.cos(this.pp * Math.PI * 0.5); this.gS = Math.sin(this.pp * Math.PI * 0.5);
    const dFb = (this.gFb - pFb) * inv, dPP = (this.gPP - pPP) * inv, dDry = (this.gDry - pDry) * inv, dWet = (this.gWet - pWet) * inv;
    const dC = (this.gC - pC) * inv, dS = (this.gS - pS) * inv;
    let gFb = pFb, gPP = pPP, gDry = pDry, gWet = pWet, gC = pC, gS = pS;

    const buf = this.buf, mask = this.mask, size = this.size;
    let w = this.w, inG = this.inG;
    const fadeStep = this.fadeStep;
    const lp = this.lp, lpG = this.lpG, lpA1 = this.lpA1, hpG = this.hpG;
    let hpL = this.hpL, hpR = this.hpR, outL = this.outL, outR = this.outR;
    let peak = 0;
    const maxD = this.size - 8;

    for (let i = off, end = off + n, j = 0; i < end; i++, j++) {
      const xL = L[i], xR = R[i];
      if (on) { inG += fadeStep; if (inG > 1) inG = 1; } else { inG -= fadeStep; if (inG < 0) inG = 0; }
      const fr = j * inv;
      let dl = d0L + (d1L - d0L) * fr, dr = d0R + (d1R - d0R) * fr;
      if (dl < 2) dl = 2; else if (dl > maxD) dl = maxD;
      if (dr < 2) dr = 2; else if (dr > maxD) dr = maxD;
      // read line outputs (from previous writes)
      let pos = w - dl, ip = Math.floor(pos), fq = pos - ip;
      let ym1 = buf[(ip - 1) & mask], y0 = buf[ip & mask], y1 = buf[(ip + 1) & mask], y2 = buf[(ip + 2) & mask];
      let rL = ((((0.5 * (y2 - ym1) + 1.5 * (y0 - y1)) * fq + (ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2)) * fq + 0.5 * (y1 - ym1)) * fq) + y0;
      pos = w - dr; ip = Math.floor(pos); fq = pos - ip;
      ym1 = buf[size + ((ip - 1) & mask)]; y0 = buf[size + (ip & mask)]; y1 = buf[size + ((ip + 1) & mask)]; y2 = buf[size + ((ip + 2) & mask)];
      let rR = ((((0.5 * (y2 - ym1) + 1.5 * (y0 - y1)) * fq + (ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2)) * fq + 0.5 * (y1 - ym1)) * fq) + y0;
      // tone: HP (1-pole) then LP (2-pole SVF)
      let v = (rL - hpL) * hpG; let l1 = v + hpL; hpL = l1 + v; rL -= l1;
      v = (rR - hpR) * hpG; l1 = v + hpR; hpR = l1 + v; rR -= l1;
      let v3 = rL - lp[1], v1 = lpA1 * lp[0] + lpG * lpA1 * v3, v2 = lp[1] + lpG * v1;
      lp[0] = 2 * v1 - lp[0]; lp[1] = 2 * v2 - lp[1]; rL = v2;
      v3 = rR - lp[3]; v1 = lpA1 * lp[2] + lpG * lpA1 * v3; v2 = lp[3] + lpG * v1;
      lp[2] = 2 * v1 - lp[2]; lp[3] = 2 * v2 - lp[3]; rR = v2;
      outL = rL; outR = rR;
      // input (ping-pong: mono sum enters the left side and bounces across)
      const sL = xL * inG, sR = xR * inG;
      const mono = (sL + sR) * 0.5;
      const inL = sL + (mono - sL) * gPP;
      const inR = sR * (1 - gPP);
      // feedback cross-feed as an orthogonal rotation (energy-preserving for any L/R correlation;
      // pingpong = 1 → full swap, with one polarity flip per round trip)
      const fL = gC * rL + gS * rR;
      const fR = gC * rR - gS * rL;
      let wL = inL + fL * gFb;
      let wR = inR + fR * gFb;
      // gentle tape-style saturation in the loop (rational tanh-like, unity slope at 0, smooth to ±1.43)
      let q = wL * 0.7;
      q = q > 3 ? 1 : q < -3 ? -1 : (q * (27 + q * q)) / (27 + 9 * q * q);
      wL = q * 1.4286;
      q = wR * 0.7;
      q = q > 3 ? 1 : q < -3 ? -1 : (q * (27 + q * q)) / (27 + 9 * q * q);
      wR = q * 1.4286;
      buf[w] = wL + DENORMAL;
      buf[size + w] = wR + DENORMAL;
      const aw = (wL < 0 ? -wL : wL) + (wR < 0 ? -wR : wR);
      if (aw > peak) peak = aw;
      w = (w + 1) & mask;
      L[i] = xL * (gDry + (1 - gDry) * (1 - inG)) + rL * gWet;
      R[i] = xR * (gDry + (1 - gDry) * (1 - inG)) + rR * gWet;
      gFb += dFb; gPP += dPP; gDry += dDry; gWet += dWet; gC += dC; gS += dS;
    }
    this.w = w; this.inG = inG;
    this.hpL = hpL; this.hpR = hpR; this.outL = outL; this.outR = outR;
    if (peak < 2e-6) this.silent += n; else this.silent = 0;
    if (!on && inG === 0 && this.silent > this.dly + 0.1 * sr + 4 * n) {
      // everything left in the loop is below −110 dBFS: go idle and clear (cheap once)
      this.buf.fill(0);
      this.lp.fill(0); this.hpL = this.hpR = 0;
      this.active = false;
    }
  }
}
