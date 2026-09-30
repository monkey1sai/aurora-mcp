// Patch utilities: Mutate (small musical variations), Randomize (constrained, always-playable generator),
// preset import validation. Pure logic (no DOM) — testable in Node.

import { PARAMS, PARAM_BY_ID, DEFAULTS, MOD_DESTS, toNorm, fromNorm } from '../../dsp/params.js';
import { Rng } from '../../dsp/util.js';
import { sanitizeValue, normalizeMacros, diffFromDefaults } from './store.js';

export function makeRng(seed) {
  const s = seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
  return new Rng(s || 1);
}

/* ═══════════════════════════════ Mutate ═══════════════════════════════ */

// Never mutated: performance/voice setup, levels that set loudness, pitch structure, routing ids, macros.
const MUTATE_SKIP = /^(?:macro\d|mod\d\.(?:src|dst)|voice\..*|scale\..*|global\..*|master\..*|arp\..*|chord\..*|amp\.level|amp\.vel|.*\.oct|.*\.semi|fm\.op\d\.ratio|fm\.algo|lfo\d\.phase|phys\.damp)$/;
// Mutated gently (fraction of the normal amount)
const GENTLE = /(\.fine|\.detune|\.pan|\.spread|\.drift|\.filt|\.kscale|\.vel|filter\.key|eq\.)/;
// Wet/dry mixes: keep in a sensible window
const MIX = /\.mix$|reverb\.shimmer|comp\.amount/;
const FEEDBACK = /feedback$/;

/** Which schema groups are currently audible/active (inactive groups are left alone). */
function activeGroups(values) {
  const on = id => values[id] === true;
  const g = new Set(['voice', 'vibrato', 'amp', 'filter', 'aenv', 'fenv', 'menv', 'eq']);
  if (on('osc1.on')) g.add('osc1');
  if (on('osc2.on')) g.add('osc2');
  if (on('fm.on')) { g.add('fm'); for (let i = 1; i <= 4; i++) g.add(`fm.op${i}`); }
  if (on('phys.on')) g.add('phys');
  if (on('noise.on')) g.add('noise');
  if (values['filter2.type'] !== 'off') g.add('filter2');
  for (const fx of ['drive', 'chorus', 'phaser', 'delay', 'reverb']) if (on(`${fx}.on`)) g.add(fx);
  // LFOs only if some slot uses them
  for (let i = 1; i <= 8; i++) {
    const src = values[`mod${i}.src`];
    if (src === 'lfo1' || src === 'lfo2') g.add(src);
    if (src !== 'none' && values[`mod${i}.dst`] !== 'none') g.add('mod');
  }
  return g;
}

/**
 * Small, musical random variation of float params in normalised space.
 * @param {object} values  native values (store.values)
 * @param {{amount?:number, rng?:Rng}} opts  amount ≈ standard deviation in normalised units (default 0.07)
 * @returns {object} changed params { id: nativeValue }
 */
export function mutate(values, { amount = 0.06, rng = makeRng() } = {}) {
  const groups = activeGroups(values);
  const out = {};
  for (const p of PARAMS) {
    if (p.scope === 'global' || p.type !== 'float' || MUTATE_SKIP.test(p.id)) continue;
    if (p.group === 'mod') {
      // only amounts of active slots
      const slot = p.id.split('.')[0];
      if (!p.id.endsWith('.amt') || values[`${slot}.src`] === 'none' || values[`${slot}.dst`] === 'none') continue;
    } else if (!groups.has(p.group)) continue;
    if (p.group === 'filter' && p.id === 'filter.vowel' && values['filter.type'] !== 'formant') continue;
    if (p.group.startsWith('osc') && p.id.endsWith('.pw') && values[p.id.replace('.pw', '.mode')] !== 'classic') continue;
    if (rng.next() < 0.5) continue; // leave about half the params untouched for coherence
    const n0 = toNorm(p, values[p.id]);
    let amt = amount * (GENTLE.test(p.id) ? 0.35 : 1);
    if (p.group.endsWith('env')) amt *= 0.8;
    let n = n0 + rng.gauss() * amt;
    // keep inside safe windows (but never pull an already-extreme value further out)
    let lo = 0.02, hi = 0.98;
    if (MIX.test(p.id)) hi = Math.max(0.6, n0);
    if (FEEDBACK.test(p.id)) hi = Math.max(0.75, n0);
    if (p.id === 'filter.res' || p.id === 'filter2.res') hi = Math.max(0.8, n0);
    if (p.id === 'filter.cutoff' && /ladder|lp/.test(values['filter.type'])) lo = Math.min(0.3, n0);
    if (p.id === 'reverb.decay') hi = Math.max(0.75, n0);
    if (p.id.endsWith('.a') && p.group.endsWith('env')) hi = Math.max(0.55, n0); // attacks ≤ ~1.7 s
    if (p.id.endsWith('.level') && p.group !== 'mod') lo = Math.min(0.25, n0);
    if (p.group === 'mod') { lo = -1; hi = 1; n = Math.max(-0.6, Math.min(0.6, values[p.id] + rng.gauss() * amount * 0.6)); out[p.id] = round(n); continue; }
    n = n < lo ? lo : n > hi ? hi : n;
    const v = sanitizeValue(p, fromNorm(p, n));
    if (Math.abs(toNorm(p, v) - n0) > 1e-4) out[p.id] = round(v);
  }
  return out;
}

const round = v => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

/* ═══════════════════════════════ Randomize ═══════════════════════════════ */

const ADJ = ['Polar', 'Velvet', 'Neon', 'Glass', 'Silent', 'Solar', 'Crystal', 'Midnight', 'Hollow', 'Amber', 'Frozen', 'Distant', 'Liquid', 'Electric', 'Dusty', 'Golden', 'Lunar', 'Tidal', 'Paper', 'Cobalt', 'Silver', 'Misty', 'Wild', 'Soft'];
const NOUN = ['Drift', 'Bloom', 'Echo', 'Pulse', 'Veil', 'Tide', 'Ember', 'Halo', 'Orbit', 'Mirage', 'Ripple', 'Spark', 'Nebula', 'Current', 'Garden', 'Signal', 'Comet', 'Lantern', 'Canyon', 'Horizon', 'Prism', 'Whisper', 'Aurora', 'Harbor'];
const ADJ_ZH = { Polar: '極地', Velvet: '絲絨', Neon: '霓虹', Glass: '玻璃', Silent: '靜謐', Solar: '日光', Crystal: '水晶', Midnight: '午夜', Hollow: '空谷', Amber: '琥珀', Frozen: '冰封', Distant: '遠方', Liquid: '流動', Electric: '電光', Dusty: '塵封', Golden: '金色', Lunar: '月光', Tidal: '潮汐', Paper: '紙質', Cobalt: '鈷藍', Silver: '銀色', Misty: '薄霧', Wild: '狂野', Soft: '柔軟' };
const NOUN_ZH = { Drift: '漂流', Bloom: '綻放', Echo: '回聲', Pulse: '脈衝', Veil: '薄紗', Tide: '浪潮', Ember: '餘燼', Halo: '光暈', Orbit: '軌道', Mirage: '幻影', Ripple: '漣漪', Spark: '火花', Nebula: '星雲', Current: '洋流', Garden: '花園', Signal: '訊號', Comet: '彗星', Lantern: '燈籠', Canyon: '峽谷', Horizon: '地平線', Prism: '稜鏡', Whisper: '低語', Aurora: '極光', Harbor: '港灣' };

const CAT_ZH = { keys: '鍵盤', pad: '鋪底', bass: '貝斯', lead: '主奏', pluck: '撥弦', bell: '鐘琴', strings: '弦樂', arp: '琶音', fx: '音效', drum: '打擊' };
const RECIPES = ['pad', 'lead', 'bass', 'pluck', 'keys', 'bell', 'strings', 'arp', 'fx'];

/**
 * Constrained random patch generator. Picks a recipe (category) and draws every parameter from musically
 * sensible ranges; gain-staged by the number of active sources so it is always playable.
 * @returns preset object { name, category, tags, description, params, macros, demo, generated: true }
 */
// Randomizer output trim per category (dB), see the gain-staging note in randomPatch().
const CAT_TRIM_DB = { bass: 6, pluck: 6, bell: 7, arp: 5.5, keys: 5, fx: 3, drum: 0.5, lead: 0, strings: -1.5, pad: -2.5 };

export function randomPatch({ rng = makeRng(), category } = {}) {
  const r = () => rng.next();
  const pick = a => a[Math.floor(r() * a.length) % a.length];
  const chance = x => r() < x;
  const lin = (a, b) => a + (b - a) * r();
  const exp = (a, b) => a * Math.pow(b / a, r());
  const cat = RECIPES.includes(category) ? category : pick(RECIPES);
  const P = {};
  const set = (id, v) => { P[id] = v; };

  // ── sources ──
  const osc = (o, opts = {}) => {
    set(`${o}.on`, true);
    const wt = opts.wt ?? chance(0.45);
    set(`${o}.mode`, wt ? 'wavetable' : 'classic');
    if (wt) {
      set(`${o}.table`, opts.table || pick(['analog', 'harmonic', 'vowels', 'pulse', 'organ', 'glass', 'sync', 'digital', 'strings', 'growl']));
      set(`${o}.shape`, lin(0.05, 0.85));
    } else {
      set(`${o}.shape`, pick([2 / 3, 2 / 3, 1, 1 / 3, 0.85, 0.5]));
      set(`${o}.pw`, lin(0.25, 0.6));
      if (opts.sync !== false && chance(0.12)) set(`${o}.sync`, lin(0.1, 0.5));
    }
    const uni = opts.unison ?? 1;
    set(`${o}.unison`, uni);
    if (uni > 1) { set(`${o}.detune`, lin(0.08, 0.35)); set(`${o}.spread`, lin(0.5, 1)); }
    set(`${o}.drift`, lin(0.05, 0.3));
    set(`${o}.level`, opts.level ?? lin(0.55, 0.85));
    if (opts.oct) set(`${o}.oct`, opts.oct);
    if (opts.semi) set(`${o}.semi`, opts.semi);
    if (opts.fine) set(`${o}.fine`, opts.fine);
  };
  let nSources = 0;
  const HARM = [0.5, 1, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8];
  const INHARM = [1, 1.41, 2, 2.76, 3.5, 4.2, 5.4, 7, 9.2, 11];
  const fm = (bell) => {
    set('osc1.on', nSources > 0 ? P['osc1.on'] ?? false : false);
    set('fm.on', true);
    const algo = bell ? pick([3, 5, 6, 1]) : pick([1, 2, 3, 3, 4, 5, 6]);
    set('fm.algo', algo);
    set('fm.feedback', chance(0.5) ? lin(0, 0.35) : 0);
    for (let i = 1; i <= 4; i++) {
      set(`fm.op${i}.ratio`, i === 1 ? pick([1, 1, 1, 2, 0.5]) : bell ? pick(INHARM) : pick(HARM));
      set(`fm.op${i}.level`, i === 1 ? 1 : lin(0.15, bell ? 0.5 : 0.6));
      set(`fm.op${i}.a`, bell ? 0.001 : exp(0.001, 0.02));
      set(`fm.op${i}.d`, bell ? exp(1.5, 8) : exp(0.3, 4));
      set(`fm.op${i}.s`, bell ? lin(0, 0.15) : lin(0.05, 0.6));
      set(`fm.op${i}.r`, bell ? exp(1, 4) : exp(0.2, 1));
      set(`fm.op${i}.vel`, lin(0.2, 0.8));
      if (i > 1 && chance(0.3)) set(`fm.op${i}.detune`, lin(-6, 6));
    }
    set('fm.level', 0.85);
    nSources++;
  };

  const flt = (type, cutoff, res, env) => {
    set('filter.type', type);
    set('filter.cutoff', cutoff);
    set('filter.res', res);
    set('filter.env', env);
    set('filter.key', lin(0.2, 0.6));
    if (type.startsWith('ladder') && chance(0.3)) set('filter.drive', lin(0.1, 0.4));
  };
  const env = (e, a, d, s, rel, curve) => { set(`${e}.a`, a); set(`${e}.d`, d); set(`${e}.s`, s); set(`${e}.r`, rel); if (curve !== undefined) set(`${e}.curve`, curve); };
  let slot = 1;
  const modSlot = (src, dst, amt) => { if (slot > 8) return; set(`mod${slot}.src`, src); set(`mod${slot}.dst`, dst); set(`mod${slot}.amt`, amt); slot++; };
  const lfo = (l, shape, rate, extra = {}) => { set(`${l}.shape`, shape); set(`${l}.rate`, rate); for (const k in extra) set(`${l}.${k}`, extra[k]); };
  const reverb = (mix, decay, size, shimmer = 0) => { set('reverb.on', true); set('reverb.mix', mix); set('reverb.decay', decay); set('reverb.size', size); if (shimmer) set('reverb.shimmer', shimmer); set('reverb.damp', lin(0.3, 0.6)); };
  const delay = (mix, fb) => { set('delay.on', true); set('delay.sync', pick(['1/8D', '1/4', '1/8', '3/16', '1/4D'])); set('delay.mix', mix); set('delay.feedback', fb); set('delay.tone', lin(0.3, 0.6)); set('delay.pingpong', lin(0.3, 0.9)); };
  const chorus = (mode, mix) => { set('chorus.on', true); set('chorus.mode', mode); set('chorus.mix', mix); set('chorus.rate', exp(0.2, 1.2)); set('chorus.depth', lin(0.3, 0.7)); };

  switch (cat) {
    case 'pad': {
      osc('osc1', { unison: pick([4, 5, 6, 7]), level: 0.7 }); nSources++;
      if (chance(0.75)) { osc('osc2', { unison: pick([1, 3, 4]), level: lin(0.3, 0.55), oct: pick([0, 1, -1, 0]), semi: pick([0, 0, 7, 12, -12, 5]) }); nSources++; } else set('osc2.on', false);
      if (chance(0.25)) { set('noise.on', true); set('noise.level', lin(0.05, 0.15)); set('noise.color', lin(-0.6, 0.3)); nSources++; }
      flt(pick(['ladder24', 'ladder24', 'lp', 'ladder12']), exp(700, 4000), lin(0.05, 0.35), lin(0, 0.3));
      env('fenv', exp(0.3, 2.5), exp(1, 4), lin(0.3, 0.8), exp(1, 4));
      env('aenv', exp(0.3, 2), exp(1, 3), lin(0.65, 0.95), exp(1.5, 5));
      lfo('lfo1', pick(['sine', 'tri', 'smooth']), exp(0.05, 0.4), { mode: 'mono' });
      modSlot('lfo1', 'filter.cutoff', lin(0.04, 0.12));
      lfo('lfo2', pick(['sine', 'smooth']), exp(0.1, 0.8));
      modSlot('lfo2', pick(['osc1.shape', 'osc2.shape', 'osc1.detune', 'amp.pan']), lin(0.08, 0.25));
      if (chance(0.7)) chorus(pick(['ensemble', 'chorus']), lin(0.25, 0.45));
      reverb(lin(0.28, 0.45), exp(3, 9), lin(0.6, 0.95), chance(0.35) ? lin(0.15, 0.45) : 0);
      if (chance(0.3)) delay(lin(0.1, 0.2), lin(0.25, 0.45));
      break;
    }
    case 'strings': {
      osc('osc1', { wt: chance(0.6), table: 'strings', unison: pick([3, 5, 6]), level: 0.7 }); nSources++;
      osc('osc2', { wt: false, unison: pick([2, 3]), level: lin(0.25, 0.45) }); nSources++;
      flt(pick(['lp', 'ladder12']), exp(1800, 5000), lin(0.05, 0.2), lin(0.05, 0.2));
      env('fenv', exp(0.15, 0.8), exp(0.6, 2), lin(0.5, 0.8), exp(0.5, 1.5));
      env('aenv', exp(0.12, 0.6), exp(0.8, 2), lin(0.8, 0.95), exp(0.5, 1.6));
      set('vib.depth', lin(6, 16)); set('vib.delay', lin(0.25, 0.7)); set('vib.rate', lin(4.6, 6));
      chorus('ensemble', lin(0.3, 0.5));
      reverb(lin(0.25, 0.4), exp(2.5, 5), lin(0.6, 0.85));
      break;
    }
    case 'lead': {
      set('voice.mode', pick(['legato', 'legato', 'mono', 'poly']));
      set('voice.glide', chance(0.7) ? exp(0.02, 0.15) : 0);
      osc('osc1', { unison: pick([1, 2, 3, 4]), level: 0.75 }); nSources++;
      if (chance(0.7)) { osc('osc2', { unison: 1, level: lin(0.2, 0.45), oct: pick([0, 1, -1]), semi: pick([0, 0, 7, 12]), fine: lin(-8, 8) }); nSources++; } else set('osc2.on', false);
      flt(pick(['ladder12', 'ladder24', 'lp']), exp(1500, 6000), lin(0.1, 0.45), lin(0.1, 0.45));
      env('fenv', 0.003, exp(0.2, 1), lin(0.2, 0.6), exp(0.1, 0.4));
      env('aenv', exp(0.002, 0.02), exp(0.2, 1), lin(0.75, 1), exp(0.1, 0.4));
      set('vib.depth', lin(5, 20)); set('vib.delay', lin(0.2, 0.5));
      if (chance(0.3)) { set('drive.on', true); set('drive.type', pick(['soft', 'tube'])); set('drive.amount', lin(0.1, 0.35)); }
      if (chance(0.65)) delay(lin(0.12, 0.25), lin(0.25, 0.45));
      reverb(lin(0.1, 0.25), exp(1.5, 3.5), lin(0.4, 0.7));
      break;
    }
    case 'bass': {
      set('voice.mode', pick(['mono', 'mono', 'legato', 'poly']));
      set('voice.glide', chance(0.5) ? exp(0.015, 0.06) : 0);
      osc('osc1', { unison: pick([1, 1, 2]), level: 0.8, wt: chance(0.3), table: pick(['growl', 'analog', 'digital', 'pulse']) }); nSources++;
      if (chance(0.65)) { osc('osc2', { wt: false, unison: 1, level: lin(0.4, 0.6), oct: -1 }); set('osc2.shape', pick([0, 1 / 3, 1])); nSources++; } else set('osc2.on', false);
      flt(pick(['ladder24', 'ladder24', 'ladder12', 'lp']), exp(150, 700), lin(0.1, 0.5), lin(0.3, 0.7));
      set('filter.key', lin(0.3, 0.7));
      env('fenv', 0.001, exp(0.1, 0.5), lin(0, 0.3), exp(0.05, 0.25));
      env('aenv', exp(0.001, 0.005), exp(0.2, 0.6), lin(0.6, 1), exp(0.05, 0.2));
      if (chance(0.55)) { set('drive.on', true); set('drive.type', pick(['tube', 'soft', 'fold'])); set('drive.amount', lin(0.1, 0.35)); }
      set('comp.amount', lin(0.1, 0.4));
      break;
    }
    case 'pluck': {
      if (chance(0.35)) {
        set('osc1.on', false);
        set('phys.on', true); set('phys.model', 'string'); set('phys.exciter', 'pluck');
        set('phys.hardness', lin(0.3, 0.8)); set('phys.decay', exp(0.8, 4)); set('phys.brightness', lin(0.4, 0.8));
        set('phys.body', lin(0.1, 0.6)); set('phys.position', lin(0.1, 0.4)); set('phys.filt', lin(0, 0.6));
        nSources++;
        if (chance(0.5)) { osc('osc2', { wt: true, unison: 1, level: lin(0.15, 0.3) }); nSources++; } else set('osc2.on', false);
        env('aenv', 0.001, exp(1, 3), lin(0, 0.2), exp(0.3, 1));
      } else {
        osc('osc1', { unison: pick([1, 2, 3]), level: 0.8 }); nSources++;
        if (chance(0.5)) { osc('osc2', { unison: 1, level: lin(0.2, 0.4), oct: pick([0, 1]) }); nSources++; } else set('osc2.on', false);
        env('aenv', 0.001, exp(0.3, 1.2), lin(0, 0.1), exp(0.2, 0.8));
      }
      flt(pick(['lp', 'ladder24', 'ladder12']), exp(400, 1500), lin(0.1, 0.35), lin(0.4, 0.8));
      env('fenv', 0.001, exp(0.15, 0.5), 0, exp(0.1, 0.4));
      if (chance(0.65)) delay(lin(0.15, 0.28), lin(0.3, 0.5));
      reverb(lin(0.15, 0.3), exp(1.5, 4), lin(0.4, 0.8));
      break;
    }
    case 'keys': {
      if (chance(0.55)) { fm(false); set('osc1.on', false); } else {
        osc('osc1', { unison: pick([1, 2]), level: 0.75, wt: chance(0.5), table: pick(['organ', 'harmonic', 'analog']) }); nSources++;
        if (chance(0.4)) { osc('osc2', { unison: 1, level: lin(0.2, 0.4), oct: 1 }); nSources++; } else set('osc2.on', false);
      }
      flt(pick(['lp', 'ladder12']), exp(2500, 10000), lin(0.05, 0.2), lin(0, 0.3));
      env('fenv', 0.001, exp(0.5, 2), lin(0.2, 0.5), 0.4);
      env('aenv', exp(0.001, 0.008), exp(1, 4), lin(0.2, 0.7), exp(0.3, 0.9));
      set('amp.vel', lin(0.5, 0.8));
      if (chance(0.5)) chorus('chorus', lin(0.2, 0.4));
      if (chance(0.3)) { set('phaser.on', true); set('phaser.rate', exp(0.1, 0.6)); set('phaser.mix', lin(0.2, 0.4)); }
      reverb(lin(0.12, 0.25), exp(1.2, 2.5), lin(0.35, 0.6));
      break;
    }
    case 'bell': {
      if (chance(0.5)) { fm(true); set('osc1.on', false); } else {
        set('osc1.on', false);
        set('phys.on', true); set('phys.model', pick(['bell', 'glass', 'bar', 'plate'])); set('phys.exciter', 'mallet');
        set('phys.hardness', lin(0.4, 0.85)); set('phys.decay', exp(1.5, 8)); set('phys.brightness', lin(0.4, 0.8));
        set('phys.inharm', lin(0, 0.35)); set('phys.position', lin(0.15, 0.45)); set('phys.spread', lin(0.2, 0.7));
        nSources++;
      }
      set('filter.cutoff', exp(6000, 16000)); set('filter.key', 0);
      env('aenv', 0.001, exp(3, 8), lin(0, 0.3), exp(1.5, 4));
      reverb(lin(0.25, 0.4), exp(3, 7), lin(0.6, 0.9), chance(0.4) ? lin(0.1, 0.35) : 0);
      if (chance(0.4)) delay(lin(0.1, 0.2), lin(0.3, 0.5));
      break;
    }
    case 'arp': {
      set('arp.on', true); set('arp.mode', pick(['up', 'updown', 'down', 'random', 'order'])); set('arp.rate', pick(['1/16', '1/16', '1/8', '1/16T']));
      set('arp.oct', pick([1, 2, 2, 3])); set('arp.gate', lin(0.3, 0.7)); if (chance(0.3)) set('arp.swing', lin(0.1, 0.3));
      osc('osc1', { unison: pick([1, 2]), level: 0.75 }); nSources++;
      if (chance(0.5)) { osc('osc2', { unison: 1, level: lin(0.25, 0.45), fine: lin(-9, 9) }); nSources++; } else set('osc2.on', false);
      flt(pick(['ladder24', 'lp', 'ladder12']), exp(600, 2000), lin(0.2, 0.5), lin(0.3, 0.6));
      env('fenv', 0.001, exp(0.1, 0.3), lin(0, 0.15), 0.15);
      env('aenv', 0.001, exp(0.15, 0.4), lin(0.1, 0.4), exp(0.1, 0.25));
      lfo('lfo1', pick(['tri', 'sine']), 0.5, { sync: pick(['2/1', '4/1', '1/1']), mode: 'mono' });
      modSlot('lfo1', 'filter.cutoff', lin(0.08, 0.18));
      delay(lin(0.18, 0.3), lin(0.3, 0.5));
      reverb(lin(0.12, 0.25), exp(1.5, 3), lin(0.4, 0.7));
      break;
    }
    default: { // fx
      osc('osc1', { wt: true, unison: pick([2, 4, 6]), level: lin(0.5, 0.7) }); nSources++;
      if (chance(0.6)) { set('noise.on', true); set('noise.level', lin(0.1, 0.3)); set('noise.color', lin(-0.6, 0.5)); nSources++; }
      if (chance(0.4)) { osc('osc2', { wt: true, unison: 1, level: lin(0.2, 0.4), semi: pick([7, 12, -12, 5, 0]) }); nSources++; } else set('osc2.on', false);
      const ft = pick(['comb', 'formant', 'bp', 'ladder24', 'notch']);
      flt(ft, ft === 'comb' ? exp(150, 800) : exp(400, 3000), ft === 'comb' ? lin(0.35, 0.7) : lin(0.2, 0.6), lin(-0.2, 0.3));
      if (ft === 'comb') set('filter.key', lin(0.6, 1));
      if (ft === 'formant') { set('filter.vowel', lin(0, 1)); lfo('lfo2', 'smooth', exp(0.05, 0.3)); modSlot('lfo2', 'filter.vowel', lin(0.2, 0.5)); }
      set('filter2.type', 'lp'); set('filter2.cutoff', exp(3000, 9000));
      env('aenv', exp(0.5, 3), exp(1, 3), lin(0.7, 1), exp(2, 6));
      lfo('lfo1', pick(['smooth', 'sine', 'sh', 'tri']), exp(0.05, 1.5), { mode: 'mono' });
      modSlot('lfo1', 'filter.cutoff', lin(0.08, 0.2));
      modSlot('lfo1', 'osc1.shape', lin(0.15, 0.4));
      if (chance(0.5)) { set('phaser.on', true); set('phaser.rate', exp(0.05, 0.4)); set('phaser.mix', lin(0.25, 0.5)); }
      if (chance(0.7)) delay(lin(0.15, 0.3), lin(0.35, 0.6));
      reverb(lin(0.35, 0.5), exp(5, 14), lin(0.8, 1), chance(0.6) ? lin(0.2, 0.5) : 0);
      set('delay.wobble', lin(0.1, 0.5));
      break;
    }
  }
  if (P['osc1.on'] === undefined) set('osc1.on', false);
  // gain staging: per-category loudness trim (calibrated on 40 random patches × their demo phrases so the
  // categories land near −20 LUFS instead of spanning −30…−16), minus 1.5 dB per extra source
  const lvl = (CAT_TRIM_DB[cat] ?? 0) - 1.5 * Math.max(0, nSources - 1);
  set('amp.level', Math.max(-12, Math.min(6, lvl)));

  // ── macros: always 4 musically safe controls ──
  const macros = [];
  const ftype = P['filter.type'] || 'ladder24';
  const maxAmt = ftype === 'comb' ? 0.18 : ftype === 'bp' || ftype === 'formant' || ftype === 'notch' ? 0.12 : 0.28;
  // never push the cutoff into the top of the range (band-pass/comb patches would thin out to nothing)
  const cutN = toNorm(PARAM_BY_ID['filter.cutoff'], P['filter.cutoff'] ?? DEFAULTS['filter.cutoff']);
  const cutoffAmt = round(Math.max(0.06, Math.min(maxAmt, 0.9 - cutN)));
  const bright = [{ id: 'filter.cutoff', amount: cutoffAmt }];
  if (P['fm.on']) bright.push({ id: 'fm.op2.level', amount: 0.2 });
  else if (P['phys.on']) bright.push({ id: 'phys.brightness', amount: 0.25 });
  else if (/ladder|lp/.test(ftype)) bright.push({ id: 'filter.res', amount: 0.1 });
  macros.push({ name: '亮度 Bright', targets: bright });

  const lfoSlots = [];
  for (let i = 1; i < slot; i++) if (/^lfo/.test(P[`mod${i}.src`])) lfoSlots.push(i);
  if (lfoSlots.length) macros.push({ name: '流動 Motion', targets: lfoSlots.slice(0, 3).map(i => ({ id: `mod${i}.amt`, amount: Math.sign(P[`mod${i}.amt`] || 1) * (P[`mod${i}.dst`] === 'filter.cutoff' ? 0.15 : 0.25) })) });
  else if (cat === 'lead' || cat === 'strings') macros.push({ name: '顫音 Vibrato', targets: [{ id: 'vib.depth', amount: 0.3 }] });
  else if (P['osc1.on'] && (P['osc1.unison'] || 1) > 1) macros.push({ name: '厚度 Width', targets: [{ id: 'osc1.detune', amount: 0.3 }, { id: 'osc1.spread', amount: 0.2 }] });
  else macros.push({ name: '起音 Attack', targets: [{ id: 'aenv.a', amount: 0.2 }] });

  if (P['drive.on']) macros.push({ name: '失真 Drive', targets: [{ id: 'drive.amount', amount: 0.4 }] });
  else if (P['phys.on']) macros.push({ name: '材質 Material', targets: [{ id: 'phys.inharm', amount: 0.35 }] });
  else if (P['fm.on']) macros.push({ name: '金屬 Metal', targets: [{ id: 'fm.feedback', amount: 0.3 }, { id: 'fm.op3.level', amount: 0.2 }] });
  else if (P['osc1.mode'] === 'wavetable') macros.push({ name: '波表 Morph', targets: [{ id: 'osc1.shape', amount: 0.4 }] });
  else macros.push({ name: '共振 Resonance', targets: [{ id: 'filter.res', amount: 0.3 }] });

  const space = [{ id: 'reverb.mix', amount: 0.25 }, { id: 'reverb.decay', amount: 0.12 }];
  if (P['delay.on']) space.push({ id: 'delay.mix', amount: 0.15 });
  macros.push({ name: '空間 Space', targets: space });

  const adj = pick(ADJ);
  let noun = pick(NOUN);
  if (noun === adj) noun = 'Drift';
  const params = {};
  for (const id in P) {
    const p = PARAM_BY_ID[id];
    if (!p) continue;
    params[id] = round(sanitizeValue(p, P[id]));
  }
  return {
    name: `${adj} ${noun}`,
    category: cat,
    tags: ['random', cat],
    description: `隨機生成的${CAT_ZH[cat] || ''}音色「${ADJ_ZH[adj] || adj}${NOUN_ZH[noun] || noun}」`,
    params: diffFromDefaults({ ...DEFAULTS, ...params }),
    macros: normalizeMacros(macros),
    demo: cat,
    generated: true,
  };
}

/* ═══════════════════════════════ Import validation ═══════════════════════════════ */

/**
 * Validate/sanitise an imported object (single preset, array of presets, or {presets:[…]}).
 * Unknown params are dropped, values clamped, macros normalised to 4.
 * @returns {{ presets: object[], warnings: string[] }}
 */
export function parsePresetFile(data) {
  const warnings = [];
  let list = Array.isArray(data) ? data : data && Array.isArray(data.presets) ? data.presets : data ? [data] : [];
  const presets = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof raw.params !== 'object' || raw.params === null) { warnings.push('skipped an entry without params'); continue; }
    const params = {};
    for (const id in raw.params) {
      const p = PARAM_BY_ID[id];
      if (!p) { warnings.push(`unknown param ${id}`); continue; }
      if (p.scope === 'global') continue;
      params[id] = sanitizeValue(p, raw.params[id]);
    }
    presets.push({
      name: String(raw.name || 'Imported').slice(0, 60),
      category: typeof raw.category === 'string' ? raw.category : 'fx',
      tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [],
      description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : '',
      params: diffFromDefaults({ ...DEFAULTS, ...params }),
      macros: normalizeMacros(raw.macros),
      demo: typeof raw.demo === 'string' ? raw.demo : null,
    });
  }
  return { presets, warnings };
}

/** Mod destinations list without 'none' (for UIs). */
export const MOD_DEST_IDS = MOD_DESTS.filter(d => d !== 'none');
