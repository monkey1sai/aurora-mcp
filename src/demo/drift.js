// AURORA 極光 — Auto-evolve core (pure, no DOM): smooth deterministic drift noise and the curated, context-aware
// list of params that glide cleanly. Shared by the website panel (src/ui/demo/evolve.js) and the MCP server.

import { PARAM_BY_ID, toNorm } from '../dsp/params.js';

const MACRO_COLORS = ['#3ef0b0', '#5cf2ff', '#a78bfa', '#ff6bd6'];
const TIMBRE_COLORS = ['#a78bfa', '#5cf2ff', '#8fb4ff', '#c4a8ff', '#6be4ff'];
const SPACE_COLORS = ['#ff6bd6', '#ff9ff0', '#ffc46b', '#ff8fb1'];
const LP = new Set(['ladder24', 'ladder12', 'lp', 'bp', 'formant']);
const FM_CARRIERS = { 1: [1], 2: [1], 3: [1, 3], 4: [1], 5: [1, 2, 3], 6: [1, 2, 3], 7: [1, 3, 4], 8: [1, 2, 3, 4] };

/* ── smooth deterministic noise ── */
function hash(i, seed) {
  let x = Math.imul(i | 0, 374761393) ^ Math.imul(seed | 0, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
function grad1(x, seed) {
  const i = Math.floor(x), f = x - i;
  const g0 = hash(i, seed) * 2 - 1, g1 = hash(i + 1, seed) * 2 - 1;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (g0 * f * (1 - u) + g1 * (f - 1) * u) * 2.2;
}
/** Two-octave gradient noise, roughly −1..1, C² smooth. */
export function driftNoise(x, seed) {
  const n = grad1(x, seed) * 0.8 + grad1(x * 2.13 + 17.1, seed + 101) * 0.35;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}
export const strSeed = s => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return x >>> 0; };
/** Reflect x into [lo, hi] (continuous, keeps motion alive near the edges). */
export const reflect = (x, lo, hi) => {
  if (hi <= lo) return lo;
  const span = hi - lo;
  let y = (x - lo) % (2 * span);
  if (y < 0) y += 2 * span;
  return lo + (y > span ? 2 * span - y : y);
};

/**
 * The curated, context-aware list of params to evolve for a patch.
 * @returns {{id, group, depth, lo, hi, seed, color}[]} depth = max excursion in normalised units at intensity 1
 */
export function evolveTargets(values, macros, groups = { macros: true, timbre: true, space: false }) {
  const out = [];
  const n = id => toNorm(PARAM_BY_ID[id], values[id]);
  const add = (id, group, depth, lo = 0, hi = 1, color) => {
    const nb = n(id);
    out.push({ id, group, depth, lo: Math.min(lo, nb), hi: Math.max(hi, nb), seed: strSeed(id), color });
  };
  if (groups.macros) {
    (macros || []).forEach((m, i) => { if (m && m.targets && m.targets.length) add(`macro${i + 1}`, 'macros', 0.42, 0, 1, MACRO_COLORS[i]); });
  }
  if (groups.timbre) {
    let c = 0;
    const tc = () => TIMBRE_COLORS[c++ % TIMBRE_COLORS.length];
    if (values['filter.on'] && LP.has(values['filter.type'])) {
      add('filter.cutoff', 'timbre', 0.11, 0.3, 0.97, tc());
      add('filter.res', 'timbre', 0.06, 0, 0.78, tc());
      if (values['filter.type'] === 'formant') add('filter.vowel', 'timbre', 0.35, 0, 1, tc());
    }
    for (const o of ['osc1', 'osc2']) {
      if (!values[`${o}.on`]) continue;
      add(`${o}.shape`, 'timbre', values[`${o}.mode`] === 'wavetable' ? 0.2 : 0.12, 0, 1, tc());
      if (values[`${o}.unison`] > 1) add(`${o}.detune`, 'timbre', 0.1, 0.02, 0.6, tc());
      if (values[`${o}.mode`] === 'classic' && values[`${o}.shape`] > 0.8) add(`${o}.pw`, 'timbre', 0.18, 0.1, 0.9, tc());
    }
    if (values['fm.on']) {
      const car = FM_CARRIERS[values['fm.algo']] || [1];
      for (let i = 1; i <= 4; i++) if (!car.includes(i) && values[`fm.op${i}.level`] > 0.02) add(`fm.op${i}.level`, 'timbre', 0.07, 0, 0.9, tc());
    }
    if (values['phys.on']) { add('phys.brightness', 'timbre', 0.12, 0.05, 1, tc()); add('phys.position', 'timbre', 0.1, 0.05, 0.95, tc()); }
    if (values['noise.on']) add('noise.color', 'timbre', 0.18, 0, 1, tc());
    if (['lp', 'hp', 'bp'].includes(values['filter2.type'])) add('filter2.cutoff', 'timbre', 0.07, 0.1, 0.97, tc());
  }
  if (groups.space) {
    let c = 0;
    const sc = () => SPACE_COLORS[c++ % SPACE_COLORS.length];
    if (values['reverb.on']) {
      add('reverb.mix', 'space', 0.09, 0.04, 0.7, sc());
      add('reverb.damp', 'space', 0.15, 0.1, 0.9, sc());
      if (values['reverb.shimmer'] > 0.01) add('reverb.shimmer', 'space', 0.12, 0, 0.7, sc());
    }
    if (values['delay.on']) { add('delay.mix', 'space', 0.07, 0.02, 0.5, sc()); add('delay.feedback', 'space', 0.1 / 0.95, 0.05, 0.8 / 0.95, sc()); }
    if (values['chorus.on']) { add('chorus.mix', 'space', 0.12, 0.05, 0.85, sc()); add('chorus.depth', 'space', 0.15, 0.1, 1, sc()); }
    if (values['phaser.on']) add('phaser.mix', 'space', 0.14, 0.05, 0.9, sc());
    add('amp.pan', 'space', 0.2, 0.25, 0.75, sc());
  }
  return out;
}
