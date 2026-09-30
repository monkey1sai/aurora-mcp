// AURORA 極光 — "magic" sound moods: context-aware recipes that nudge the current patch toward a mood
// (brighter, warmer, wider, dreamier …), plus a small zh/en natural-language parser ("不要那麼亮" → darker).
//
// Pure ES module (browser + Node, no DOM): everything works on native value objects (store.values /
// resolveParams(preset.params)) and returns { id: newNativeValue } changes. The UI animates them in with
// store.animate() and records one undo step.
//
// Design rules for every recipe
//  • context-aware: only touches what is audible in this patch (engines that are on, the filter only if the
//    sources go through it, FX only if enabled — or enables an FX in a safe starting state);
//  • diminishing returns: continuous params move a fraction of the way toward a musical limit, so applying a
//    mood again intensifies it but never runs off to an extreme (limits are chosen so it never clips or silences);
//  • never away from the mood: a "raise" never lowers a value that is already beyond its limit;
//  • loudness-aware: amp.level compensates the expected level change (measured with tools/analyze.mjs so that
//    moods stay within ±3 LU of the original unless the mood is about level, e.g. softer).

import { PARAM_BY_ID, toNorm, fromNorm } from '../dsp/params.js';

/* ═══════════════════════════════ mood catalogue ═══════════════════════════════ */

/**
 * @typedef {{ id:string, zh:string, en:string, icon:string, svg:string, color:string, desc:string, descEn:string }} Mood
 * icon: emoji (plain-text contexts); svg: inner markup of a 24×24 stroke icon (currentColor).
 */
export const MOODS = [
  { id: 'brighter', zh: '更明亮', en: 'Brighter', icon: '☀️', color: '#ffd76b',
    desc: '打開濾波器與高頻，泛音更閃亮', descEn: 'Opens the filter and the highs for more sparkle',
    svg: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>' },
  { id: 'darker', zh: '更暗', en: 'Darker', icon: '🌑', color: '#8f9cff',
    desc: '收起高頻與泛音，聲音更深沉', descEn: 'Rolls off highs and harmonics for a deeper tone',
    svg: '<path d="M19.5 14.2A7.8 7.8 0 019.8 4.5a7.8 7.8 0 109.7 9.7z"/>' },
  { id: 'warmer', zh: '更溫暖', en: 'Warmer', icon: '🔥', color: '#ffa36b',
    desc: '柔化高頻、加一點低中頻、類比漂移與管式飽和', descEn: 'Softer highs, fuller low-mids, analog drift and tube glow',
    svg: '<path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3.3 2.6-5 3.4-8.4.2-.8 1.1-1 1.5-.3C12.6 9.4 13 11 13 11s1-1.2 1.2-3c.1-.7 1-.9 1.4-.3C17 9.6 18 12 18 15.4 18 18.6 15.6 21 12 21z"/><path d="M12 21c-1.5 0-2.6-1.1-2.6-2.6 0-1.8 1.6-2.6 2.6-4.4 1 1.8 2.6 2.6 2.6 4.4 0 1.5-1.1 2.6-2.6 2.6z"/>' },
  { id: 'softer', zh: '更柔和', en: 'Softer', icon: '☁️', color: '#b9c7ff',
    desc: '起音變慢、去掉尖銳與失真，更圓潤', descEn: 'Gentler attack, less bite and grit',
    svg: '<path d="M7.2 18.5h9.6a4 4 0 00.6-7.95A5.5 5.5 0 006.9 9.2a4.7 4.7 0 00.3 9.3z"/>' },
  { id: 'punchier', zh: '更有衝擊', en: 'Punchier', icon: '👊', color: '#ff7b6b',
    desc: '更快的起音、濾波包絡咬勁、壓縮黏合', descEn: 'Snappier attack, filter-envelope bite, glue compression',
    svg: '<path d="M12 2.8l1.9 5.2 5.4-1.6-3.3 4.6 4.6 3.1-5.6.4.7 5.6L12 16.3 8.3 20.1l.7-5.6-5.6-.4L8 11 4.7 6.4l5.4 1.6z"/>' },
  { id: 'aggressive', zh: '更激烈', en: 'Aggressive', icon: '⚡', color: '#ff5a7a',
    desc: '失真、共振與中頻咬勁，張力全開', descEn: 'Drive, resonance and mid bite — full tension',
    svg: '<path d="M13.5 2.8L5.5 13.4h5.6l-1.3 7.8 8.7-11.3h-5.9z"/>' },
  { id: 'fatter', zh: '更厚實', en: 'Fatter', icon: '🐘', color: '#ff8fd0',
    desc: '齊奏加厚、低八度副振盪器、低頻與黏合', descEn: 'Unison, a sub oscillator an octave down, low end and glue',
    svg: '<path d="M3 8.5c3-2.4 6-2.4 9 0s6 2.4 9 0"/><path d="M3 13c3-2.4 6-2.4 9 0s6 2.4 9 0" stroke-width="2.6"/><path d="M3 17.5c3-2.4 6-2.4 9 0s6 2.4 9 0" stroke-width="3.4"/>' },
  { id: 'wider', zh: '更寬闊', en: 'Wider', icon: '↔️', color: '#5cf2ff',
    desc: '立體齊奏、聲部展開與合唱，聲場更開', descEn: 'Stereo unison, voice spread and chorus',
    svg: '<path d="M2.8 12h18.4"/><path d="M6.6 8L2.8 12l3.8 4M17.4 8l3.8 4-3.8 4"/><path d="M12 6.5v11" opacity=".45"/>' },
  { id: 'focused', zh: '更集中', en: 'Focused', icon: '🎯', color: '#7ad8ff',
    desc: '收窄聲場、減少合唱與殘響，聲音往前站', descEn: 'Narrower image, less chorus and reverb — more upfront',
    svg: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/>' },
  { id: 'ethereal', zh: '更空靈', en: 'Ethereal', icon: '✨', color: '#c4a8ff',
    desc: '大空間殘響、微光、慢起音與長釋放', descEn: 'Big reverb, shimmer, slow swell and long release',
    svg: '<path d="M12 3.2l1.6 4.6 4.6 1.6-4.6 1.6L12 15.6l-1.6-4.6-4.6-1.6 4.6-1.6z"/><path d="M18.5 14.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7zM6 15.5l.6 1.6 1.6.6-1.6.6L6 20l-.6-1.7-1.6-.6 1.6-.6z"/>' },
  { id: 'dreamy', zh: '更夢幻', en: 'Dreamy', icon: '🫧', color: '#ff9ff0',
    desc: '合奏合唱、磁帶延遲與朦朧的濾波', descEn: 'Ensemble chorus, tape echoes and a hazy filter',
    svg: '<circle cx="9" cy="14" r="5"/><circle cx="16.8" cy="8.2" r="3"/><circle cx="18" cy="16.5" r="1.8"/><path d="M6.8 12.2a2.6 2.6 0 012-1.6" opacity=".6"/>' },
  { id: 'cleaner', zh: '更乾淨', en: 'Cleaner', icon: '💧', color: '#6bf0d0',
    desc: '減少殘響延遲與失真，乾淨俐落', descEn: 'Less reverb, echo and grit — dry and clear',
    svg: '<path d="M12 3.2c3.2 4.1 5.6 7.2 5.6 10.4a5.6 5.6 0 01-11.2 0C6.4 10.4 8.8 7.3 12 3.2z"/><path d="M9.4 14.2a2.8 2.8 0 002.4 2.6" opacity=".6"/>' },
  { id: 'vintage', zh: '更復古', en: 'Vintage', icon: '📼', color: '#ffc46b',
    desc: '類比漂移、管式溫暖、Juno 式合唱與磁帶抖動', descEn: 'Analog drift, tube warmth, Juno-style chorus, tape wobble',
    svg: '<rect x="3" y="6" width="18" height="12" rx="2.2"/><circle cx="8.3" cy="11.4" r="1.9"/><circle cx="15.7" cy="11.4" r="1.9"/><path d="M8.3 13.3h7.4M7 18l1.5-2.6h7L17 18"/>' },
  { id: 'futuristic', zh: '更未來', en: 'Futuristic', icon: '🛸', color: '#3ef0b0',
    desc: '硬同步、相位掃頻、共振與數位微光', descEn: 'Hard sync, phaser sweeps, resonance and digital shimmer',
    svg: '<circle cx="12" cy="12" r="4.6"/><ellipse cx="12" cy="12" rx="10" ry="3.4" transform="rotate(-18 12 12)"/>' },
  { id: 'motion', zh: '更有動感', en: 'More motion', icon: '🌊', color: '#5ce1ff',
    desc: '加入 LFO 讓濾波、波形或聲像持續流動', descEn: 'Adds LFO movement to the filter, wavetable or pan',
    svg: '<path d="M2.8 12c1.8-4.4 3.6-4.4 5.4 0s3.6 4.4 5.4 0 3.6-4.4 5.4 0"/><path d="M18.4 7.8l2.8 4.2-4.6 1.2" opacity=".7"/>' },
  { id: 'steady', zh: '更穩定', en: 'Steadier', icon: '⚓', color: '#9fb4d8',
    desc: '減少 LFO 起伏、顫音與漂移，穩穩的', descEn: 'Less LFO wobble, vibrato and drift',
    svg: '<path d="M3 12h18"/><path d="M6.5 8.5v7M17.5 8.5v7" opacity=".6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>' },
];
export const MOOD_BY_ID = Object.fromEntries(MOODS.map(m => [m.id, m]));
// Each mood also carries its recipe: mood.recipe(values, schema?, amount?, info?) → { id: newNativeValue }
// (schema defaults to PARAM_BY_ID; see applyMood). Assigned below, once applyMood exists.


/** Clickable examples for the "describe your sound" box. */
export const MOOD_EXAMPLES = [
  { zh: '溫暖一點，再寬一點', en: 'warmer and a bit wider' },
  { zh: '像在大教堂裡', en: 'like in a cathedral' },
  { zh: '不要那麼亮', en: 'not so bright' },
  { zh: '80 年代復古', en: '80s retro' },
  { zh: '超級有衝擊力', en: 'super punchy' },
  { zh: '夢幻又空靈', en: 'dreamy and ethereal' },
  { zh: '乾淨一點、少一點殘響', en: 'cleaner, less reverb' },
  { zh: '太空科幻感', en: 'sci-fi space' },
];

/* ═══════════════════════════════ helpers ═══════════════════════════════ */

const P = PARAM_BY_ID;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = x => clamp(x, 0, 1);
const LP = new Set(['ladder24', 'ladder12', 'lp']);
const SOURCES = ['osc1', 'osc2', 'fm', 'phys', 'noise'];
const OSCS = ['osc1', 'osc2'];
const FM_CARRIERS = { 1: [1], 2: [1], 3: [1, 3], 4: [1], 5: [1, 2, 3], 6: [1, 2, 3], 7: [1, 3, 4], 8: [1, 2, 3, 4] };
/** Wavetables whose frame position runs dark → bright. */
const BRIGHT_TABLES = new Set(['analog', 'harmonic', 'glass', 'strings', 'sync', 'pulse']);
const SAW = 2 / 3;
const TRI = 1 / 3;
export const DEFAULT_AMOUNT = 0.6;

function sameVal(a, b) {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
}
/** Coerce to the param's native form (enum id, boolean, clamped/rounded number). */
function coerce(p, v) {
  if (p.type === 'enum') {
    if (typeof v === 'number') return p.options[clamp(Math.round(v), 0, p.options.length - 1)];
    return p.options.includes(v) ? v : p.options.includes(String(v)) ? String(v) : p.def;
  }
  if (p.type === 'bool') return !!v;
  let x = Number(v);
  if (!Number.isFinite(x)) x = p.def;
  x = clamp(x, p.min, p.max);
  return p.type === 'int' ? Math.round(x) : Math.round(x * 1e6) / 1e6;
}

/** Recipe context over a native values object: reads see earlier writes; writes are collected in `out`. */
function makeCtx(values, amount, info = {}) {
  const out = {};
  let gainDb = 0;
  const c = {
    amount,
    info,
    out,
    get: id => (id in out ? out[id] : values[id] !== undefined ? values[id] : P[id].def),
    orig: id => (values[id] !== undefined ? values[id] : P[id].def),
    n: id => toNorm(P[id], c.get(id)),
    set(id, v) {
      const p = P[id];
      if (!p) return;
      v = coerce(p, v);
      if (sameVal(v, c.orig(id))) delete out[id]; else out[id] = v;
    },
    setN(id, n) { c.set(id, fromNorm(P[id], clamp01(n))); },
    /** Raise the normalised value toward `lim` by k·amount of the remaining distance (never lowers). */
    up(id, lim, k) {
      const n = c.n(id);
      if (n >= lim - 1e-4) return 0;
      const nn = n + (lim - n) * clamp01(k * amount);
      c.setN(id, nn);
      return nn - n;
    },
    /** Lower the normalised value toward `lim` (never raises). */
    down(id, lim, k) {
      const n = c.n(id);
      if (n <= lim + 1e-4) return 0;
      const nn = n - (n - lim) * clamp01(k * amount);
      c.setN(id, nn);
      return n - nn;
    },
    /** Native-unit versions (dB, cents, bipolar amounts). */
    upTo(id, lim, k) { const v = c.get(id); if (v >= lim) return 0; const nv = v + (lim - v) * clamp01(k * amount); c.set(id, nv); return nv - v; },
    downTo(id, lim, k) { const v = c.get(id); if (v <= lim) return 0; const nv = v - (v - lim) * clamp01(k * amount); c.set(id, nv); return v - nv; },
    toward(id, lim, k) { const v = c.get(id); c.set(id, v + (lim - v) * clamp01(k * amount)); },
    /** Raise/lower a native value toward a native limit in normalised space. */
    upN: (id, native, k) => c.up(id, toNorm(P[id], native), k),
    downN: (id, native, k) => c.down(id, toNorm(P[id], native), k),
    on: g => !!c.get(`${g}.on`),
    gain(db) { gainDb += db; },
    get gainDb() { return gainDb; },
  };
  return c;
}

/* ── patch analysis ── */

/** Sources that sound (on, audible level). */
function activeSources(c) { return SOURCES.filter(s => c.on(s) && c.get(`${s}.level`) > 0.01); }
/** Level-weighted share of the sound that goes through the main filter (0 when the filter is off). */
function filterShare(c) {
  if (!c.get('filter.on')) return 0;
  let tot = 0, f = 0;
  for (const s of activeSources(c)) { const l = c.get(`${s}.level`); tot += l; f += l * c.get(`${s}.filt`); }
  return tot > 0 ? f / tot : 0;
}
/** Share that would go through the filter if it were on. */
function routedShare(c) {
  let tot = 0, f = 0;
  for (const s of activeSources(c)) { const l = c.get(`${s}.level`); tot += l; f += l * c.get(`${s}.filt`); }
  return tot > 0 ? f / tot : 0;
}
const filterType = c => c.get('filter.type');
/** Filter where cutoff = brightness (low-pass family, band-pass, formant voice size). */
const cutoffIsTone = c => { const t = filterType(c); return LP.has(t) || t === 'bp' || t === 'formant'; };
const fmModulators = c => [1, 2, 3, 4].filter(i => !FM_CARRIERS[c.get('fm.algo')]?.includes(i) && c.get(`fm.op${i}.level`) > 0.02);
/** Long, sustained notes (slow attacks suit it); arps, keys, plucks, bells and drums are treated as short notes. */
const SUSTAINED_CATS = new Set(['pad', 'strings', 'fx']);
const sustained = c => (c.info.category ? SUSTAINED_CATS.has(c.info.category) && !c.get('arp.on')
  : c.get('aenv.s') >= 0.5 && c.get('aenv.a') >= 0.05 && !c.get('arp.on'));
/** Low-register / bass sound: stereo tricks (chorus, detune) would thin out or cancel its low end. */
const isBassy = c => c.info.category === 'bass' || c.info.category === 'drum'
  || (c.get('voice.mode') !== 'poly' && (OSCS.some(o => c.on(o) && c.get(`${o}.oct`) < 0) || (c.get('filter.on') && LP.has(c.get('filter.type')) && c.get('filter.cutoff') < 800)));
/** Sub-like oscillator (sine-ish): unison detune only makes it beat. */
const subLike = (c, o) => c.get(`${o}.mode`) === 'classic' && c.get(`${o}.shape`) < 0.25;
/** Stack unison voices. 'reset' phase starts the voices on a fixed spread that partly cancels on short notes
 *  (measured −2.7 LU with 3 voices), so stacked voices run free. */
function stackUnison(c, o, n) {
  c.set(`${o}.unison`, n);
  if (c.get(`${o}.phase`) === 'reset') c.set(`${o}.phase`, 'free');
}
const lfoSources = new Set(['lfo1', 'lfo2']);
const activeSlot = (c, k) => c.get(`mod${k}.src`) !== 'none' && c.get(`mod${k}.dst`) !== 'none' && c.get(`mod${k}.amt`) !== 0;
function freeSlot(c) {
  for (let k = 1; k <= 8; k++) if (!activeSlot(c, k)) return k;
  return 0;
}
function lfoInUse(c, lfo) {
  for (let k = 1; k <= 8; k++) if (activeSlot(c, k) && c.get(`mod${k}.src`) === lfo) return true;
  return false;
}
function findRoute(c, dst) {
  for (let k = 1; k <= 8; k++) if (activeSlot(c, k) && c.get(`mod${k}.dst`) === dst && lfoSources.has(c.get(`mod${k}.src`))) return k;
  return 0;
}

/** Enable an FX / engine with a safe starting setup (the animation fades its mix/level in from 0). */
function enable(c, group, setup) {
  if (c.on(group)) return false;
  c.set(`${group}.on`, true);
  for (const id in setup) c.set(id, setup[id]);
  return true;
}
/** Switch an FX off once its mix is negligible. */
function offIfTiny(c, group, mixId, lim) {
  if (c.on(group) && c.get(mixId) < lim) {
    c.set(`${group}.on`, false);
    c.set(mixId, c.orig(mixId)); // keep the stored mix; the effect is off anyway
  }
}
/** Lowest main-filter cutoff a "less bright" move may reach: a filter-2 high/band-pass in series would otherwise
 *  leave nothing to hear (e.g. hi-hats: BP at 6 kHz into HP at 5.5 kHz). */
function cutoffFloorHz(c, hz) {
  const t2 = c.get('filter2.type');
  return t2 === 'hp' || t2 === 'bp' ? Math.max(hz, Math.min(12000, c.get('filter2.cutoff') * 1.3)) : hz;
}
/** Lower the main cutoff toward `hz` (respecting cutoffFloorHz). */
const lowerCutoff = (c, hz, k) => c.downN('filter.cutoff', cutoffFloorHz(c, hz), k);
/** Main-filter cutoff move that respects the filter family (comb cutoff is a pitch — never touched). */
function cutoffUp(c, lim, k) { return c.get('filter.on') && cutoffIsTone(c) ? c.up('filter.cutoff', lim, k) : 0; }
function cutoffDownHz(c, hz, k) { return c.get('filter.on') && cutoffIsTone(c) ? lowerCutoff(c, hz, k) : 0; }
/** Resonance is the tone itself (whistling / pitched noise: no pitched engine, strong resonance): leave it alone. */
const resIsTone = c => c.get('filter.res') > 0.4 && activeSources(c).every(s => s === 'noise');
/** Soften the resonance toward `lim` unless it is the tone. */
function lowerRes(c, lim, k) { if (!resIsTone(c)) c.downTo('filter.res', lim, k); }
/** A delay this short (unsynced, < 40 ms) is part of the sound (flams, claps, combs), not an echo. */
const delayIsTone = c => c.get('delay.sync') === 'off' && c.get('delay.time') < 0.04;
/** A delay that is heard as echoes (safe to tweak its mix/feedback/wobble). */
const hasEcho = c => c.on('delay') && !delayIsTone(c);
/** EQ mid band: claim it (move the frequency) only while it is flat. */
function eqMid(c, freq, db, k) {
  if (Math.abs(c.orig('eq.mid')) < 0.3 && Math.abs(c.get('eq.mid')) < 0.3) c.set('eq.midfreq', freq);
  else if (Math.abs(Math.log2(c.get('eq.midfreq') / freq)) > 1.2) return;
  if (db > 0) c.upTo('eq.mid', db, k); else c.downTo('eq.mid', db, k);
}

/* ═══════════════════════════════ recipes ═══════════════════════════════ */

const RECIPES = {
  brighter(c) {
    const share = filterShare(c);
    let d = 0;
    if (share > 0.05) {
      d += cutoffUp(c, 0.965, 0.3) * share;
      if (c.get('filter.env') > 0.02) c.upTo('filter.env', 0.6, 0.1);
    }
    if (c.get('filter2.type') === 'lp') d += c.up('filter2.cutoff', 0.97, 0.35) * 0.5;
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      if (c.get(`${o}.mode`) === 'classic' || c.get(`${o}.table`) === 'analog') { if (c.get(`${o}.shape`) < SAW) c.up(`${o}.shape`, SAW, 0.35); }
      else if (BRIGHT_TABLES.has(c.get(`${o}.table`))) c.up(`${o}.shape`, 0.85, 0.15);
    }
    if (c.on('fm')) for (const i of fmModulators(c)) d += c.up(`fm.op${i}.level`, 0.8, 0.12) * 0.5;
    if (c.on('phys')) { c.up('phys.brightness', 0.95, 0.3); c.up('phys.hardness', 0.8, 0.12); }
    if (c.on('noise')) c.upTo('noise.color', 0.6, 0.2);
    const eqd = c.upTo('eq.high', share > 0.3 ? 6 : 8, share > 0.3 ? 0.4 : 0.55);
    if (c.on('reverb')) c.down('reverb.damp', 0.18, 0.25);
    if (hasEcho(c)) c.up('delay.tone', 0.8, 0.25);
    c.gain(-d * 4 - eqd * 0.08);
  },

  darker(c) {
    const share = filterShare(c);
    let d = 0;
    if (share > 0.05) {
      if (filterType(c) === 'hp') c.downN('filter.cutoff', 20, 0.3);
      else d += cutoffDownHz(c, 230, 0.3) * share;
      if (c.get('filter.env') > 0.02) c.downTo('filter.env', 0, 0.15);
    } else if (!c.get('filter.on') && routedShare(c) > 0.5 && c.amount >= 0.4) {
      // no filter yet: bring in a gentle 12 dB ladder, starting fairly open (the animation sweeps it in)
      c.set('filter.on', true);
      if (!LP.has(filterType(c))) c.set('filter.type', 'ladder12');
      c.set('filter.cutoff', 4200 - 1600 * c.amount);
      c.set('filter.res', Math.min(c.get('filter.res'), 0.1));
      c.set('filter.drive', 0);
      c.set('filter.env', 0);
      c.set('filter.vel', 0);
      d += 0.12;
    }
    if (c.get('filter2.type') === 'lp') d += c.downN('filter2.cutoff', 400, 0.3) * 0.5;
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      const sh = c.get(`${o}.shape`);
      if (c.get(`${o}.mode`) === 'classic' || c.get(`${o}.table`) === 'analog') { if (sh > TRI && sh <= SAW + 0.01) c.down(`${o}.shape`, TRI, 0.3); }
      else if (BRIGHT_TABLES.has(c.get(`${o}.table`))) c.down(`${o}.shape`, 0.1, 0.15);
      c.downTo(`${o}.sync`, 0, 0.3);
    }
    if (c.on('fm')) {
      for (const i of fmModulators(c)) d += c.down(`fm.op${i}.level`, 0.15, 0.15) * 0.5;
      c.downTo('fm.feedback', 0, 0.2);
    }
    if (c.on('phys')) { c.down('phys.brightness', 0.1, 0.3); c.down('phys.hardness', 0.15, 0.2); } // peak-normalised strikes: no make-up
    if (c.on('noise')) c.downTo('noise.color', -0.7, 0.25);
    const eqd = c.downTo('eq.high', -9, 0.4);
    if (c.on('reverb')) c.up('reverb.damp', 0.85, 0.3);
    if (hasEcho(c)) c.down('delay.tone', 0.2, 0.3);
    c.gain(Math.min(1.5, d * 4 + eqd * 0.15));
  },

  warmer(c) {
    const share = filterShare(c);
    const eqh = c.downTo('eq.high', -5, 0.3);
    const eql = c.upTo('eq.low', 3.5, 0.3);
    eqMid(c, 380, 2.5, 0.3);
    if (share > 0.2 && cutoffIsTone(c)) {
      lowerCutoff(c, 650, 0.12);
      lowerRes(c, 0.05, 0.2);
    }
    for (const o of OSCS) if (c.on(o)) c.upTo(`${o}.drift`, 0.4, 0.35);
    if (c.on('drive')) {
      if (c.get('drive.type') === 'soft' || c.get('drive.type') === 'tube') { c.upTo('drive.amount', 0.45, 0.15); c.downTo('drive.tone', 0.35, 0.25); }
    } else if (c.amount >= 0.35) {
      enable(c, 'drive', { 'drive.type': 'tube', 'drive.amount': 0.12 + 0.12 * c.amount, 'drive.tone': 0.38, 'drive.mix': 1 });
    }
    if (c.on('phys')) { c.down('phys.brightness', 0.35, 0.15); c.upTo('phys.body', 0.65, 0.25); }
    if (c.on('fm')) for (const i of fmModulators(c)) c.down(`fm.op${i}.level`, 0.3, 0.08);
    if (c.on('noise')) c.downTo('noise.color', -0.3, 0.2);
    if (c.on('reverb')) c.up('reverb.damp', 0.65, 0.2);
    if (hasEcho(c)) c.down('delay.tone', 0.35, 0.2);
    c.gain(eqh * 0.15 - eql * 0.3 - (c.get('eq.mid') - c.orig('eq.mid')) * 0.15);
  },

  softer(c) {
    const share = filterShare(c);
    if (sustained(c)) { c.upN('aenv.a', 0.35, 0.35); c.upN('aenv.r', 2.5, 0.15); } else { c.upN('aenv.a', 0.03, 0.3); c.upN('aenv.r', 0.8, 0.15); }
    c.upTo('aenv.curve', 0.62, 0.3);
    let d = 0;
    if (share > 0.2 && cutoffIsTone(c)) {
      d += lowerCutoff(c, 900, 0.15) * share;
      lowerRes(c, 0.03, 0.35);
      if (c.get('filter.env') > 0) c.downTo('filter.env', 0, 0.25);
    }
    c.downTo('filter.drive', 0, 0.5);
    if (c.on('drive')) { c.downTo('drive.amount', 0, 0.4); offIfTiny(c, 'drive', 'drive.amount', 0.06); }
    c.downTo('comp.amount', 0, 0.3);
    const eqh = c.downTo('eq.high', -4, 0.3);
    if (c.get('eq.mid') > 0) c.downTo('eq.mid', 0, 0.4);
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      if (c.get(`${o}.mode`) === 'classic' && c.get(`${o}.shape`) > TRI + 0.01) c.down(`${o}.shape`, TRI, 0.2);
      c.downTo(`${o}.sync`, 0, 0.4);
    }
    if (c.on('phys')) c.down('phys.hardness', 0.05, 0.35);
    if (c.on('fm')) for (const i of fmModulators(c)) d += c.down(`fm.op${i}.level`, 0.2, 0.1) * 0.5;
    c.gain(d * 2.5 + eqh * 0.08);
  },

  punchier(c) {
    const share = filterShare(c);
    c.downN('aenv.a', 0.001, 0.5);
    c.downTo('aenv.curve', 0.25, 0.35);
    if (share > 0.2 && LP.has(filterType(c)) && c.get('filter.env') >= 0) { // envelope "bite" on low-pass families only
      c.upTo('filter.env', 0.45, 0.25);
      c.downN('fenv.a', 0.001, 0.5);
      c.toward('fenv.d', 0.25, 0.3);
      c.downTo('fenv.s', 0.15, 0.25);
      c.down('filter.cutoff', Math.max(0.35, toNorm(P['filter.cutoff'], cutoffFloorHz(c, 20))), 0.05);
    }
    c.upTo('comp.amount', 0.6, 0.3);
    for (const o of OSCS) if (c.on(o) && c.get(`${o}.phase`) === 'free' && c.amount >= 0.4) c.set(`${o}.phase`, 'reset');
    if (c.on('phys')) c.up('phys.hardness', 0.85, 0.25);
    if (!c.on('noise') && c.amount >= 0.55 && (c.on('osc1') || c.on('osc2') || c.on('fm'))) {
      // a short noise "chiff" on the attack
      enable(c, 'noise', { 'noise.level': 0.16 + 0.08 * c.amount, 'noise.decay': 0.035, 'noise.color': 0.25, 'noise.filt': 0, 'noise.width': 0.6, 'noise.pan': 0 });
    }
    const eql = c.upTo('eq.low', 2.5, 0.25);
    if (c.on('reverb') && c.get('reverb.mix') > 0.2) c.downTo('reverb.mix', 0.15, 0.15);
    if (c.on('reverb')) c.upTo('reverb.predelay', 0.03, 0.3);
    c.gain(0.3 - eql * 0.2 - (c.get('comp.amount') - c.orig('comp.amount')) * 1.5);
  },

  aggressive(c) {
    const share = filterShare(c);
    if (c.on('drive')) c.upTo('drive.amount', c.get('drive.type') === 'crush' ? 0.6 : 0.85, 0.25);
    else if (c.amount >= 0.3) enable(c, 'drive', { 'drive.type': 'soft', 'drive.amount': 0.22 + 0.15 * c.amount, 'drive.tone': 0.55, 'drive.mix': 1 });
    let d = 0;
    if (share > 0.2 && (LP.has(filterType(c)) || filterType(c) === 'bp')) {
      c.upTo('filter.res', 0.55, 0.25);
      if (filterType(c).startsWith('ladder')) c.upTo('filter.drive', 0.6, 0.3);
      if (LP.has(filterType(c))) {
        d += c.up('filter.cutoff', 0.85, 0.1) * share;
        if (c.get('filter.env') >= 0) c.upTo('filter.env', 0.5, 0.15);
      }
    }
    for (const o of OSCS) {
      if (!c.on(o) || c.get(`${o}.mode`) !== 'classic') continue;
      if (c.get(`${o}.shape`) < SAW) c.up(`${o}.shape`, SAW, 0.3);
      if (c.get(`${o}.sync`) > 0.01) c.upTo(`${o}.sync`, 0.4, 0.15);
    }
    if (c.on('fm')) { c.upTo('fm.feedback', 0.6, 0.2); for (const i of fmModulators(c)) d += c.up(`fm.op${i}.level`, 0.8, 0.1) * 0.5; }
    if (c.on('phys')) c.up('phys.hardness', 0.9, 0.3);
    c.upTo('comp.amount', 0.6, 0.3);
    eqMid(c, 1800, 4, 0.3);
    c.downN('aenv.a', 0.002, 0.4);
    if (c.on('reverb')) c.downTo('reverb.mix', 0.12, 0.2);
    c.gain(-d * 2.5 - (c.get('eq.mid') - c.orig('eq.mid')) * 0.15 - (c.get('comp.amount') - c.orig('comp.amount')) * 1);
  },

  fatter(c) {
    let db = 0;
    const osc1 = c.on('osc1'), osc2 = c.on('osc2');
    const bassy = isBassy(c);
    for (const o of OSCS) {
      if (!c.on(o) || subLike(c, o) || (bassy && o === 'osc1' && c.get('osc1.unison') === 1)) continue;
      const u = c.get(`${o}.unison`);
      if (u === 1 && c.amount >= 0.3) {
        stackUnison(c, o, 3);
        if (c.get(`${o}.detune`) < 0.12) c.set(`${o}.detune`, 0.12);
        c.upTo(`${o}.spread`, 0.8, 0.3);
      } else if (u > 1 && u < 7) stackUnison(c, o, Math.min(7, u + (c.amount >= 0.5 ? 2 : 1)));
      c.upTo(`${o}.detune`, 0.35, 0.2);
    }
    const subSetup = (o, ref) => ({
      [`${o}.on`]: true, [`${o}.mode`]: 'classic', [`${o}.shape`]: 0.18, [`${o}.oct`]: Math.max(-3, (ref ? c.get(`${ref}.oct`) : 0) - 1),
      [`${o}.semi`]: ref ? c.get(`${ref}.semi`) : 0, [`${o}.fine`]: 0, [`${o}.unison`]: 1, [`${o}.sync`]: 0, [`${o}.pan`]: 0,
      [`${o}.phase`]: 'reset', [`${o}.drift`]: 0.05, [`${o}.filt`]: ref ? c.get(`${ref}.filt`) : 0,
      [`${o}.level`]: ref ? clamp(c.get(`${ref}.level`) * (0.35 + 0.15 * c.amount), 0.15, 0.5) : 0.22 + 0.1 * c.amount,
    });
    if (c.amount >= 0.4) {
      if (osc1 && !osc2 && !bassy) { const s = subSetup('osc2', 'osc1'); for (const id in s) c.set(id, s[id]); db -= 0.6; }
      else if (!osc1 && !osc2 && (c.on('fm') || c.on('phys'))) { const s = subSetup('osc1', null); for (const id in s) c.set(id, s[id]); db -= 0.5; }
      else if (osc2 && c.get('osc2.oct') < c.get('osc1.oct')) c.upTo('osc2.level', 0.7, 0.12);
    }
    if (c.get('filter.on') && filterType(c).startsWith('ladder')) c.upTo('filter.drive', 0.35, 0.2);
    const eql = c.upTo('eq.low', 4.5, 0.35);
    c.upTo('comp.amount', 0.45, 0.25);
    if (c.on('phys')) { c.upTo('phys.body', 0.7, 0.2); c.upTo('phys.spread', 0.55, 0.2); }
    if (c.on('drive') && (c.get('drive.type') === 'soft' || c.get('drive.type') === 'tube')) c.upTo('drive.amount', 0.4, 0.1);
    c.gain(db - eql * 0.1 - (c.get('comp.amount') - c.orig('comp.amount')) * 1.5);
  },

  wider(c) {
    const bassy = isBassy(c);
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      if (c.get(`${o}.unison`) === 1 && c.amount >= 0.3 && !bassy) {
        stackUnison(c, o, 2);
        if (c.get(`${o}.detune`) < 0.1) c.set(`${o}.detune`, 0.1);
        c.set(`${o}.spread`, Math.max(c.get(`${o}.spread`), 0.9));
        c.gain(0.5);
      } else {
        c.upTo(`${o}.spread`, 1, 0.5);
        c.upTo(`${o}.blend`, 0.62, 0.2);
      }
    }
    if (c.get('voice.mode') === 'poly') c.upTo('voice.spread', 0.8, 0.35);
    if (c.on('phys')) c.upTo('phys.spread', 0.85, 0.35);
    if (c.on('noise')) c.upTo('noise.width', 1, 0.5);
    let fx = 0;
    if (c.on('chorus')) { c.upTo('chorus.mix', 0.55, 0.2); c.upTo('chorus.depth', 0.75, 0.2); }
    else if (c.amount >= 0.3 && !bassy) { enable(c, 'chorus', { 'chorus.mode': 'chorus', 'chorus.rate': 0.45, 'chorus.depth': 0.45, 'chorus.feedback': 0, 'chorus.mix': 0.22 + 0.12 * c.amount }); fx += 0.2; }
    if (c.on('reverb')) { c.upTo('reverb.width', 1, 0.6); c.upTo('reverb.mix', 0.45, 0.08); }
    if (hasEcho(c)) c.upTo('delay.pingpong', 0.9, 0.4);
    c.gain(-fx);
  },

  focused(c) {
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      c.downTo(`${o}.spread`, 0.25, 0.4);
      if (c.get(`${o}.unison`) > 1) c.downTo(`${o}.detune`, 0.08, 0.2);
    }
    c.downTo('voice.spread', 0, 0.5);
    if (c.on('phys')) c.downTo('phys.spread', 0.1, 0.4);
    if (c.on('noise')) c.downTo('noise.width', 0.3, 0.4);
    if (c.on('chorus')) { c.downTo('chorus.mix', 0, 0.4); offIfTiny(c, 'chorus', 'chorus.mix', 0.08); }
    if (c.on('phaser')) { c.downTo('phaser.mix', 0, 0.3); offIfTiny(c, 'phaser', 'phaser.mix', 0.06); }
    let wet = 0;
    if (c.on('reverb')) { c.downTo('reverb.width', 0.45, 0.35); wet += c.downTo('reverb.mix', 0.12, 0.2); }
    if (hasEcho(c)) { c.downTo('delay.pingpong', 0.15, 0.4); wet += c.downTo('delay.mix', 0.06, 0.15); }
    eqMid(c, 1500, 2, 0.2);
    c.gain(wet * 3 - (c.get('eq.mid') - c.orig('eq.mid')) * 0.2);
  },

  ethereal(c) {
    let wet = 0;
    if (c.on('reverb')) {
      wet += c.upTo('reverb.mix', 0.6, 0.3);
      c.upTo('reverb.size', 0.95, 0.25);
      c.upN('reverb.decay', 14, 0.2);
      c.upTo('reverb.shimmer', 0.55, 0.25);
      c.upTo('reverb.predelay', 0.06, 0.2);
      c.downTo('reverb.damp', 0.25, 0.2);
    } else {
      enable(c, 'reverb', {
        'reverb.size': 0.82, 'reverb.decay': 5.5, 'reverb.predelay': 0.04, 'reverb.damp': 0.35, 'reverb.mod': 0.45, 'reverb.width': 1,
        'reverb.shimmer': c.amount >= 0.5 ? 0.12 : 0, 'reverb.mix': 0.18 + 0.2 * c.amount,
      });
      wet += c.get('reverb.mix');
    }
    if (sustained(c)) { c.upN('aenv.a', 0.9, 0.3); c.upN('aenv.r', 5, 0.3); } else { c.upN('aenv.a', 0.012, 0.3); c.upN('aenv.r', 3, 0.3); }
    if (c.on('phys')) c.upN('phys.decay', 8, 0.2);
    lowerRes(c, 0.05, 0.2);
    const eqh = c.upTo('eq.high', 3, 0.25);
    c.downTo('eq.low', -2, 0.2);
    if (hasEcho(c)) { c.upTo('delay.feedback', 0.6, 0.15); wet += c.upTo('delay.mix', 0.3, 0.1) * 0.5; }
    c.gain(-wet * 3.2 - eqh * 0.2);
  },

  dreamy(c) {
    let wet = 0;
    const bassy = isBassy(c);
    if (c.on('chorus')) { c.upTo('chorus.mix', bassy ? 0.3 : 0.5, 0.2); c.upTo('chorus.depth', 0.7, 0.15); c.downN('chorus.rate', 0.3, 0.15); }
    else if (!bassy) enable(c, 'chorus', { 'chorus.mode': 'ensemble', 'chorus.rate': 0.35, 'chorus.depth': 0.6, 'chorus.feedback': 0, 'chorus.mix': 0.2 + 0.15 * c.amount });
    if (hasEcho(c)) {
      c.upTo('delay.feedback', 0.55, 0.15);
      c.upTo('delay.wobble', 0.45, 0.25);
      wet += c.upTo('delay.mix', 0.32, 0.15);
      c.down('delay.tone', 0.35, 0.15);
    } else if (c.amount >= 0.35) {
      enable(c, 'delay', { 'delay.sync': '1/4D', 'delay.feedback': 0.4, 'delay.pingpong': 0.75, 'delay.tone': 0.35, 'delay.wobble': 0.35, 'delay.mix': 0.12 + 0.1 * c.amount });
      wet += c.get('delay.mix');
    }
    if (c.on('reverb')) { wet += c.upTo('reverb.mix', 0.45, 0.12); c.upN('reverb.decay', 8, 0.1); }
    else if (c.amount >= 0.5) { enable(c, 'reverb', { 'reverb.size': 0.75, 'reverb.decay': 4, 'reverb.damp': 0.5, 'reverb.width': 1, 'reverb.mix': 0.22 }); wet += 0.22; }
    if (filterShare(c) > 0.2 && cutoffIsTone(c)) { lowerCutoff(c, 1500, 0.1); lowerRes(c, 0.05, 0.2); }
    if (sustained(c)) { c.upN('aenv.a', 0.25, 0.25); c.upN('aenv.r', 3, 0.2); } else c.upN('aenv.r', 1.5, 0.2);
    const eqh = c.downTo('eq.high', -2, 0.2);
    c.gain(-wet * 1.2 + eqh * 0.15);
  },

  cleaner(c) {
    let wet = 0;
    const FXMIX = [['reverb', 'reverb.mix', 0.05], ['delay', 'delay.mix', 0.04], ['chorus', 'chorus.mix', 0.05], ['phaser', 'phaser.mix', 0.05]];
    for (const [g, id, lim] of FXMIX) {
      if (!c.on(g) || (g === 'delay' && delayIsTone(c))) continue;
      const dd = c.downTo(id, 0, 0.45);
      if (g === 'reverb' || g === 'delay') wet += dd;
      offIfTiny(c, g, id, lim);
    }
    if (c.on('drive')) { c.downTo('drive.amount', 0, 0.45); offIfTiny(c, 'drive', 'drive.amount', 0.05); }
    c.downTo('filter.drive', 0, 0.5);
    if (c.get('filter.res') <= 0.4) lowerRes(c, 0.05, 0.25);
    if (c.on('noise') && c.get('noise.decay') === 0 && activeSources(c).length > 1 && c.info.category !== 'drum') {
      c.downTo('noise.level', 0, 0.5);
      if (c.get('noise.level') < 0.02 && activeSources(c).length > 1) { c.set('noise.on', false); c.set('noise.level', c.orig('noise.level')); }
    }
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      c.downTo(`${o}.drift`, 0.02, 0.4);
      if (c.get(`${o}.unison`) > 1) c.downTo(`${o}.detune`, 0.1, 0.2);
    }
    for (const b of ['eq.low', 'eq.mid', 'eq.high']) c.toward(b, 0, 0.4);
    c.downTo('comp.amount', 0, 0.3);
    c.gain(Math.min(3, wet * 3));
  },

  vintage(c) {
    for (const o of OSCS) {
      if (!c.on(o)) continue;
      c.upTo(`${o}.drift`, 0.55, 0.35);
      if (c.get(`${o}.unison`) > 1) c.upTo(`${o}.detune`, 0.3, 0.1);
    }
    if (c.on('drive')) {
      c.downTo('drive.tone', 0.3, 0.3);
      if (c.get('drive.type') === 'soft' || c.get('drive.type') === 'tube') c.upTo('drive.amount', 0.4, 0.1);
    } else if (c.amount >= 0.3) enable(c, 'drive', { 'drive.type': 'tube', 'drive.amount': 0.15 + 0.12 * c.amount, 'drive.tone': 0.35, 'drive.mix': 1 });
    if (!c.on('chorus') && c.amount >= 0.45 && !isBassy(c)) enable(c, 'chorus', { 'chorus.mode': 'chorus', 'chorus.rate': 0.5, 'chorus.depth': 0.5, 'chorus.feedback': 0, 'chorus.mix': 0.28 });
    if (hasEcho(c)) { c.upTo('delay.wobble', 0.6, 0.35); c.down('delay.tone', 0.3, 0.3); }
    const eqh = c.downTo('eq.high', -6, 0.35);
    if (c.get('filter2.type') === 'off' && c.amount >= 0.55 && !isBassy(c)) { c.set('filter2.type', 'hp'); c.set('filter2.cutoff', 70); c.set('filter2.res', 0.05); }
    if (c.on('reverb')) c.up('reverb.damp', 0.7, 0.25);
    if (c.get('vib.depth') < 1) { c.set('vib.rate', 0.9); c.set('vib.delay', 0); c.upTo('vib.depth', 7, 0.4); }
    c.gain(eqh * 0.2 + 0.6);
  },

  futuristic(c) {
    for (const o of OSCS) if (c.on(o) && c.get(`${o}.mode`) === 'classic') c.upTo(`${o}.sync`, 0.35, 0.15);
    if (c.on('phaser')) { c.upTo('phaser.feedback', 0.8, 0.2); c.upTo('phaser.mix', 0.5, 0.15); }
    else if (c.amount >= 0.3 && enable(c, 'phaser', { 'phaser.rate': 0.18, 'phaser.depth': 0.75, 'phaser.feedback': 0.55, 'phaser.stages': '8', 'phaser.mix': 0.28 + 0.1 * c.amount })) c.gain(2.4);
    if (filterShare(c) > 0.2 && LP.has(filterType(c))) c.upTo('filter.res', 0.45, 0.25);
    if (c.on('fm')) c.upTo('fm.feedback', 0.35, 0.15);
    if (c.on('reverb')) c.upTo('reverb.shimmer', 0.4, 0.25);
    if (hasEcho(c)) { c.upTo('delay.pingpong', 0.9, 0.3); c.up('delay.tone', 0.75, 0.2); }
    const eqh = c.upTo('eq.high', 3, 0.3);
    if (!c.on('drive') && c.amount >= 0.75) enable(c, 'drive', { 'drive.type': 'crush', 'drive.amount': 0.25, 'drive.tone': 0.6, 'drive.mix': 0.3 });
    c.gain(-eqh * 0.2);
  },

  motion(c) {
    const share = filterShare(c);
    const bassy = isBassy(c);
    let primary = 'amp.pan', amt = 0.35;
    // a moving band-pass centre into a filter-2 high/band-pass (hi-hats) would just empty the sound
    const t2 = c.get('filter2.type');
    if (share > 0.3 && cutoffIsTone(c) && (LP.has(filterType(c)) || (t2 !== 'hp' && t2 !== 'bp'))) { primary = 'filter.cutoff'; amt = 0.13; }
    else if (c.on('osc1') && c.get('osc1.mode') === 'wavetable') { primary = 'osc1.shape'; amt = 0.25; }
    else if (c.on('osc2') && c.get('osc2.mode') === 'wavetable') { primary = 'osc2.shape'; amt = 0.25; }
    else if (c.get('filter.on') && filterType(c) === 'formant' && share > 0.3) { primary = 'filter.vowel'; amt = 0.3; }
    else if (bassy && c.on('osc1') && c.get('osc1.mode') === 'classic') { primary = 'osc1.shape'; amt = 0.08; } // keep the low end centred
    const addRoute = (dst, a) => {
      const k = findRoute(c, dst);
      if (k) { // already moving: deepen it
        const cur = c.get(`mod${k}.amt`);
        const lim = Math.sign(cur || 1) * Math.max(Math.abs(cur), a * 2.4);
        c.toward(`mod${k}.amt`, lim, 0.3);
        return 'deepened';
      }
      const slot = freeSlot(c);
      if (!slot) return null;
      let lfo = !lfoInUse(c, 'lfo2') ? 'lfo2' : !lfoInUse(c, 'lfo1') ? 'lfo1' : null;
      if (lfo) {
        const arp = !!c.get('arp.on');
        c.set(`${lfo}.shape`, dst === 'amp.pan' ? 'smooth' : 'sine');
        c.set(`${lfo}.mode`, dst === 'amp.pan' ? 'poly' : 'mono');
        c.set(`${lfo}.fade`, 0);
        if (arp) { c.set(`${lfo}.sync`, dst === 'amp.pan' ? '1/1' : '2/1'); }
        else { c.set(`${lfo}.sync`, 'off'); c.set(`${lfo}.rate`, dst === 'amp.pan' ? 0.35 : sustained(c) ? 0.16 : 0.45); }
      } else {
        lfo = c.get('lfo1.rate') <= c.get('lfo2.rate') ? 'lfo1' : 'lfo2'; // share the slower LFO untouched
      }
      c.set(`mod${slot}.src`, lfo);
      c.set(`mod${slot}.dst`, dst);
      c.set(`mod${slot}.amt`, a * (0.6 + 0.6 * c.amount));
      return 'added';
    };
    const r1 = addRoute(primary, amt);
    if ((r1 !== 'added' || c.amount >= 0.85) && primary !== 'amp.pan' && !bassy) addRoute('amp.pan', 0.3);
    if (c.on('phaser')) c.upTo('phaser.depth', 0.9, 0.2);
    if (c.on('chorus')) c.upN('chorus.rate', 1.2, 0.15);
  },

  steady(c) {
    for (let k = 1; k <= 8; k++) {
      if (!activeSlot(c, k)) continue;
      const src = c.get(`mod${k}.src`);
      if (!lfoSources.has(src) && src !== 'random') continue;
      c.toward(`mod${k}.amt`, 0, 0.45);
      if (Math.abs(c.get(`mod${k}.amt`)) < 0.008) c.set(`mod${k}.amt`, 0);
    }
    c.downTo('vib.depth', 0, 0.45);
    for (const o of OSCS) if (c.on(o)) c.downTo(`${o}.drift`, 0.03, 0.4);
    if (c.on('chorus')) c.downN('chorus.rate', 0.25, 0.3);
    if (c.on('phaser')) c.downN('phaser.rate', 0.08, 0.3);
    if (hasEcho(c)) c.downTo('delay.wobble', 0, 0.5);
    if (c.on('reverb')) c.downTo('reverb.mod', 0.15, 0.3);
  },
};

/* ═══════════════════════════════ public API ═══════════════════════════════ */

/**
 * Changes that move `values` toward a mood.
 * @param {object} values native values (all params, e.g. store.values or resolveParams(preset.params))
 * @param {string} id mood id (see MOODS)
 * @param {number} [amount=0.6] 0..1 intensity (0.3 "a bit", 0.6 normal, 1 "very")
 * @param {{category?:string}} [info] patch context (preset category: 'bass'/'drum' keep the low end mono)
 * @returns {object} { paramId: newNativeValue } — only params that change
 */
export function applyMood(values, id, amount = DEFAULT_AMOUNT, info = {}) {
  const recipe = RECIPES[id];
  if (!recipe) return {};
  const a = clamp(Number.isFinite(+amount) ? +amount : DEFAULT_AMOUNT, 0.05, 1);
  const c = makeCtx(values, a, info || {});
  recipe(c);
  // loudness make-up / trim (bounded so a mood never pushes the level hot)
  const db = clamp(c.gainDb, -4, 3);
  if (Math.abs(db) > 0.05) {
    const lv = c.get('amp.level');
    const ceil = Math.max(c.orig('amp.level'), 2);
    // never below −30 dB because of a mood (a preset that already sits lower keeps its own floor)
    c.set('amp.level', clamp(lv + db, Math.min(-30, c.orig('amp.level')), db > 0 ? Math.min(6, ceil + 1) : 6));
  }
  return guardSafety(values, c.out);
}

for (const m of MOODS) {
  Object.defineProperty(m, 'recipe', {
    value: (values, schema = PARAM_BY_ID, amount = DEFAULT_AMOUNT, info = {}) => { void schema; return applyMood(values, m.id, amount, info); },
    enumerable: false,
  });
}

/** Apply several moods in order ([{id, amount}]); returns the combined changes relative to `values`. */
export function applyMoods(values, list, info = {}) {
  let cur = { ...values };
  const out = {};
  for (const m of list || []) {
    const ch = applyMood(cur, m.id, m.amount, info);
    Object.assign(out, ch);
    cur = { ...cur, ...ch };
  }
  for (const id in out) if (sameVal(out[id], values[id])) delete out[id];
  return out;
}

/** Final safety net: something must stay audible and nothing may leave its range. */
function guardSafety(values, out) {
  const get = id => (id in out ? out[id] : values[id] !== undefined ? values[id] : P[id].def);
  for (const id in out) out[id] = coerce(P[id], out[id]);
  const audible = SOURCES.some(s => get(`${s}.on`) && get(`${s}.level`) > 0.02);
  if (!audible) for (const s of SOURCES) { if (`${s}.on` in out) delete out[`${s}.on`]; if (`${s}.level` in out) delete out[`${s}.level`]; }
  const lv0 = values['amp.level'] ?? P['amp.level'].def;
  const floor = Math.min(-30, lv0); // presets may sit lower (amp.level as a modulation base): never raise them here
  if (get('amp.level') < floor) out['amp.level'] = floor;
  if ('amp.level' in out && sameVal(out['amp.level'], lv0)) delete out['amp.level'];
  // a low-pass that everything goes through must stay open enough to hear the note
  if (get('filter.on') && LP.has(get('filter.type')) && get('filter.cutoff') < 120 && 'filter.cutoff' in out) out['filter.cutoff'] = Math.max(120, values['filter.cutoff'] ?? 120);
  return out;
}

/* ═══════════════════════════════ describing changes ═══════════════════════════════ */

const FX_GROUPS = { drive: ['失真', 'Drive'], chorus: ['合唱', 'Chorus'], phaser: ['相位器', 'Phaser'], delay: ['延遲', 'Delay'], reverb: ['殘響', 'Reverb'],
  osc1: ['振盪器 1', 'Osc 1'], osc2: ['振盪器 2', 'Osc 2'], fm: ['FM', 'FM'], phys: ['物理模型', 'Physical'], noise: ['噪音', 'Noise'], filter: ['濾波器', 'Filter'] };
const GROUP_ZH = { osc1: '振盪器1', osc2: '振盪器2', fm: 'FM', phys: '物理', noise: '噪音', filter: '濾波', filter2: '濾波2', aenv: '音量包絡', fenv: '濾波包絡',
  menv: '調變包絡', lfo1: 'LFO1', lfo2: 'LFO2', drive: '失真', chorus: '合唱', phaser: '相位', delay: '延遲', reverb: '殘響', eq: 'EQ', amp: '音量', voice: '聲部', vib: '顫音' };

/**
 * Human summary of a change set, most significant first: [{ id, zh, en, dir: +1|-1|0, kind: 'on'|'off'|'value'|'route' }].
 */
export function describeChanges(values, changes) {
  const items = [];
  const seenRoute = new Set();
  // params of an engine/effect that is switched on or off are summarised by that switch
  const switched = new Set(Object.keys(changes).filter(id => id.endsWith('.on')).map(id => id.split('.')[0]));
  if ('filter2.type' in changes && (changes['filter2.type'] === 'off') !== (values['filter2.type'] === 'off')) switched.add('filter2');
  const SKIP = new Set(['eq.midfreq', 'amp.level', 'vib.delay']);
  for (const id in changes) {
    const p = P[id];
    if (!p || SKIP.has(id)) continue;
    const g = id.split('.')[0];
    if (switched.has(g) && !id.endsWith('.on') && id !== 'filter2.type') continue;
    if (id === 'filter2.type' && switched.has('filter2')) {
      const on = changes[id] !== 'off';
      items.push({ id, zh: `${on ? '開啟' : '關閉'} 濾波器 2`, en: `Filter 2 ${on ? 'on' : 'off'}`, dir: on ? 1 : -1, kind: on ? 'on' : 'off', w: 1.2 });
      continue;
    }
    if (/^lfo\d\./.test(id)) continue;
    if (id.endsWith('.on') && FX_GROUPS[g]) {
      items.push({ id, zh: `${changes[id] ? '開啟' : '關閉'} ${FX_GROUPS[g][0]}`, en: `${FX_GROUPS[g][1]} ${changes[id] ? 'on' : 'off'}`, dir: changes[id] ? 1 : -1, kind: changes[id] ? 'on' : 'off', w: 2 });
      continue;
    }
    if (/^mod\d\./.test(id)) {
      const slot = g;
      if (seenRoute.has(slot)) continue;
      seenRoute.add(slot);
      const src = changes[`${slot}.src`] ?? values[`${slot}.src`];
      const dst = changes[`${slot}.dst`] ?? values[`${slot}.dst`];
      const dp = P[dst];
      if (!dp) continue;
      const amtNow = changes[`${slot}.amt`] ?? values[`${slot}.amt`], amt0 = values[`${slot}.amt`];
      items.push({ id: `${slot}.amt`, zh: `${String(src).toUpperCase()} → ${dp.zh}`, en: `${src} → ${dp.label}`, dir: Math.abs(amtNow) >= Math.abs(amt0) ? 1 : -1, kind: 'route', w: 1.5 });
      continue;
    }
    if (p.type === 'enum' || p.type === 'bool') {
      items.push({ id, zh: `${GROUP_ZH[g] ? GROUP_ZH[g] + ' ' : ''}${p.zh}`, en: p.label, dir: 0, kind: 'value', w: 0.4, to: changes[id] });
      continue;
    }
    const d = toNorm(p, changes[id]) - toNorm(p, values[id] ?? p.def);
    if (Math.abs(d) < 0.004) continue;
    items.push({ id, zh: `${GROUP_ZH[g] && !p.zh.startsWith(GROUP_ZH[g]) ? GROUP_ZH[g] + ' ' : ''}${p.zh}`, en: p.label, dir: Math.sign(d), kind: 'value', w: Math.abs(d) * (id === 'amp.level' ? 0.3 : 1) });
  }
  return items.sort((a, b) => b.w - a.w);
}

/* ═══════════════════════════════ natural-language parser ═══════════════════════════════ */

/** Keyword lexicon: each entry maps words (zh substrings or en word stems) to one or more moods. */
const LEXICON = [
  { m: { brighter: 1 }, zh: ['明亮', '光亮', '清亮', '清脆', '閃亮', '閃耀', '晶瑩', '通透', '亮麗', '亮晶晶', '高頻', '亮'], en: ['bright(?:er|ness)?', 'crisp(?:er|y)?', 'sparkl(?:e|y|ier)', 'shiny', 'shinier', 'treble', 'brilliant'] },
  { m: { darker: 1 }, zh: ['黑暗', '陰暗', '暗沉', '低沉', '深沉', '沉悶', '悶', '暗'], en: ['dark(?:er|ness)?', 'dull(?:er)?', 'muffled', 'murky', 'gloomy', 'deep(?:er)?', 'mellow(?:er)?'] },
  { m: { warmer: 1 }, zh: ['溫暖', '溫潤', '暖和', '圓潤', '暖'], en: ['warm(?:er|th)?', 'cozy', 'round(?:er)?'] },
  { m: { softer: 1 }, zh: ['柔和', '柔軟', '輕柔', '柔順', '平滑', '圓滑', '細膩', '柔', '軟'], en: ['soft(?:er)?', 'gentle(?:r)?', 'smooth(?:er)?', 'delicate', 'subtle'] },
  { m: { softer: 0.7, warmer: 0.35 }, zh: ['溫柔'], en: ['tender'] },
  { m: { punchier: 1 }, zh: ['衝擊力', '衝擊', '有力', '力道', '打擊感', '有勁', '爆發力', '俐落', '扎實'], en: ['punch(?:y|ier)?', 'snappy', 'snappier', 'tight(?:er)?', 'impact(?:ful)?', 'attack'] },
  { m: { aggressive: 1 }, zh: ['激烈', '兇猛', '兇', '猛烈', '狂暴', '狂野', '暴力', '粗暴', '憤怒', '攻擊性', '失真', '破音', '髒', '炸'], en: ['aggressive', 'angry', 'harsh(?:er)?', 'gritty', 'grittier', 'distort(?:ed|ion)?', 'dirt(?:y|ier)', 'edg(?:y|ier)', 'nasty', 'brutal', 'wild(?:er)?', 'fierce', 'rock'] },
  { m: { fatter: 1 }, zh: ['厚實', '飽滿', '渾厚', '厚重', '厚', '肥', '胖', '粗', '低音'], en: ['fat(?:ter)?', 'phat', 'thick(?:er)?', 'big(?:ger)?', 'huge', 'massive', 'full(?:er)?', 'beef(?:y|ier)', 'heav(?:y|ier)', 'bass(?:y|ier)?', 'rich(?:er)?'] },
  { m: { wider: 1 }, zh: ['寬闊', '寬廣', '開闊', '立體', '環繞', '寬'], en: ['wide(?:r)?', 'width', 'broad(?:er)?', 'stereo', 'spread'] },
  { m: { wider: 0.6, dreamy: 0.3 }, zh: ['合唱', '齊奏'], en: ['chorus(?:ed)?', 'ensemble', 'unison'] },
  { m: { motion: 0.6 }, zh: ['顫音', '抖音'], en: ['vibrato', 'tremolo'] },
  { m: { focused: 1 }, zh: ['集中', '聚焦', '單聲道', '窄', '緊密', '往前'], en: ['narrow(?:er)?', 'focus(?:ed)?', 'mono', 'cent(?:er|re)d?', 'upfront', 'direct'] },
  { m: { ethereal: 1 }, zh: ['空靈', '飄渺', '縹緲', '天堂', '天使', '仙氣', '殘響', '空間感', '空間', '大廳', '飄'], en: ['ethereal', 'air(?:y|ier)', 'heavenly', 'angelic', 'spacious', 'reverb(?:y|erant)?', 'celestial', 'atmospheric', 'ambient', 'float(?:y|ing)', 'hall'] },
  { m: { ethereal: 1, wider: 0.35 }, zh: ['教堂', '大教堂'], en: ['cathedral', 'church'] },
  { m: { dreamy: 1 }, zh: ['夢幻', '夢境', '迷幻', '朦朧', '迷濛', '慵懶', '夢', '回音'], en: ['dream(?:y|ier|like)?', 'hazy', 'haze', 'lush(?:er)?', 'psychedelic', 'wash(?:y)?', 'echo(?:es|ey)?', 'shoegaze'] },
  { m: { cleaner: 1 }, zh: ['乾淨', '純淨', '清楚', '清晰', '簡單', '乾'], en: ['clean(?:er)?', 'dry', 'drier', 'dryer', 'pure(?:r)?', 'clear(?:er)?', 'simple(?:r)?'] },
  { m: { vintage: 1 }, zh: ['復古', '懷舊', '老派', '類比', '卡帶', '磁帶', '黑膠', '年代感', '老'], en: ['vintage', 'retro', 'old(?:-school| school)?', 'analog(?:ue)?', 'lo-?fi', 'tape', 'cassette', 'vinyl', 'nostalgic'] },
  { m: { vintage: 1 }, re: ['[789]0\\s*年代', '八[〇零]年代'], en: ["[789]0'?s", 'eighties', 'seventies'] },
  { m: { futuristic: 1 }, zh: ['未來', '科幻', '數位', '賽博', '機械', '電子感', '外星'], en: ['futur(?:e|istic)', 'sci-?fi', 'digital', 'cyber(?:punk)?', 'robot(?:ic)?', 'alien', 'metallic', 'glitch(?:y)?'] },
  { m: { ethereal: 0.6, futuristic: 0.5 }, zh: ['太空', '宇宙', '星空'], en: ['space', 'cosmic', 'galaxy'] },
  { m: { motion: 1 }, zh: ['動感', '流動', '律動', '起伏', '搖擺', '波動', '變化', '活潑', '生動', '動'], en: ['motion', 'moving', 'movement', 'animated', 'alive', 'evolving', 'wobbl(?:e|y)', 'puls(?:e|ing)', 'groov(?:e|y)', 'lively', 'sweep(?:ing)?'] },
  { m: { steady: 1 }, zh: ['穩定', '平穩', '靜止', '不動', '穩'], en: ['steady', 'steadier', 'static', 'stable', 'still', 'calm(?:er)?'] },
  { m: { darker: 0.6, motion: 0.5, dreamy: 0.3 }, zh: ['水底', '水下', '深海', '水裡', '水中'], en: ['underwater', 'under water'] },
  { m: { darker: 0.4, dreamy: 0.5 }, zh: ['夜晚', '深夜', '午夜'], en: ['night', 'midnight'] },
  { m: { wider: 0.6, ethereal: 0.5 }, zh: ['電影', '史詩'], en: ['cinematic', 'epic'] },
  { m: { brighter: 0.6, ethereal: 0.4 }, zh: ['水晶', '玻璃'], en: ['crystal(?:line)?', 'glass(?:y)?'] },
  { m: { brighter: 0.5, futuristic: 0.3 }, zh: ['冰冷', '冷'], en: ['cold(?:er)?', 'icy', 'cool(?:er)?'] },
  { m: { punchier: 0.6, fatter: 0.5 }, zh: ['舞曲', '夜店'], en: ['club', 'dance', 'edm'] },
  // words with their own opposite ("太薄" → fatter, not the opposite of cleaner)
  { m: { cleaner: 0.5, focused: 0.5 }, opp: { fatter: 1 }, zh: ['單薄', '纖細', '薄'], en: ['thin(?:ner)?'] },
  { m: { brighter: 0.6, aggressive: 0.4 }, zh: ['刺耳', '尖銳', '銳利', '犀利', '尖'], en: ['sharp(?:er)?', 'shrill', 'piercing', 'bite', 'biting'] },
  { m: { aggressive: 0.6, punchier: 0.3 }, zh: ['吵雜', '吵鬧', '吵'], en: ['noisy', 'loud(?:er)?'] },
  { m: { darker: 0.6, fatter: 0.4 }, zh: ['混濁', '渾濁', '模糊', '糊'], en: ['mudd(?:y|ier)', 'boomy', 'boxy', 'blurry'] },
  { m: { brighter: 0.5, ethereal: 0.5 }, zh: ['空氣感', '空氣'], en: ['breathy', 'breath'] },
  { m: { ethereal: 0.7, darker: 0.3 }, zh: ['遙遠', '遠方', '遠處', '遠'], en: ['distant', 'far[- ]?away', 'f[au]rther(?: away)?', 'remote'] },
  { m: { focused: 0.6, cleaner: 0.5 }, zh: ['貼近', '親密', '靠近', '近'], en: ['close(?:r)?', 'intimate', 'near(?:er)?', 'in your face'] },
  { m: { vintage: 0.6, aggressive: 0.4 }, zh: ['顆粒感', '顆粒', '粗糙', '沙沙'], en: ['grain(?:y|ier)?', 'crunch(?:y|ier)?', 'bit-?crush(?:ed)?'] },
];

const OPPOSITE = {
  brighter: [['darker', 1]], darker: [['brighter', 1]],
  warmer: [['brighter', 0.5], ['cleaner', 0.4]],
  softer: [['punchier', 0.8]], punchier: [['softer', 1]], aggressive: [['softer', 1]],
  fatter: [['cleaner', 0.5], ['brighter', 0.3]],
  wider: [['focused', 1]], focused: [['wider', 1]],
  ethereal: [['cleaner', 1]], dreamy: [['cleaner', 0.8], ['focused', 0.3]],
  cleaner: [['ethereal', 0.6], ['dreamy', 0.4]],
  vintage: [['futuristic', 0.6], ['cleaner', 0.4]], futuristic: [['vintage', 1]],
  motion: [['steady', 1]], steady: [['motion', 1]],
};

const CJK = /[㐀-鿿豈-﫿]/;
// compiled matchers: { re (global, sticky-free), moods, len }
const MATCHERS = [];
for (const e of LEXICON) {
  for (const w of e.zh || []) MATCHERS.push({ re: new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), m: e.m, opp: e.opp });
  for (const w of e.en || []) MATCHERS.push({ re: new RegExp(`\\b${w}\\b`, 'gi'), m: e.m, opp: e.opp });
  for (const w of e.re || []) MATCHERS.push({ re: new RegExp(w, 'gi'), m: e.m, opp: e.opp });
}

// Modifiers (checked right before / after a keyword)
const ZH_NEG_TOO = /(不要|別|不想要|不想|不需要|不用|避免)(再)?(太|過於|過度)$/;           // "not too X" → a little of the opposite
const ZH_NEG = /(不要|別|不想要|不想|不需要|不用|減少|降低|少一點|少點|去掉|拿掉|去除|沒那麼|不那麼|不太|不再|少|減|避免|不)(再)?(那麼|這麼|那樣|這樣|很)?(的)?$/;
const ZH_TOO = /(太|過於|過度)$/;                                                          // "too X" → the opposite
const ZH_ENOUGH = /不夠$/;                                                                // "not X enough" → more
const ZH_STRONG = /(超級|超|非常|極度|極|特別|十分|相當|好|很|更加|大幅|大量|爆|無敵|最)(的)?(更|再)?$/;
const ZH_WEAK = /(稍微|稍稍|稍|微微|略微|略|有點|有些|一點點|一點|一些|些許|輕微|些微|淡淡|淡)(的)?(更|再)?$/;
const ZH_SUF_TINY = /^(一點點|一丁點|一咪咪)/;
const ZH_SUF_WEAK = /^(一點|一些|點|些|一下)/;
const ZH_SUF_STRONG = /^(很多|非常多|許多|多了|得多|到爆|爆了|一百倍)/;
const ZH_SUF_TOO = /^了/;
const EN_NEG_TOO = /\b(?:not too|not overly)\s+$/i;
const EN_NEG = /\b(?:less|no|without|remove|reduce|lower|cut|kill|lose|fewer|minus|don'?t (?:make it |want it |want |be )?|not|never|nothing)\s+(?:the\s+|so\s+|as\s+|any\s+|much\s+)?$/i;
const EN_TOO = /\b(?:too|overly)\s+(?:much\s+)?$/i;
const EN_STRONG = /\b(?:very|much|really|super|extremely|way|a lot|lots|far|totally|massively|ultra|hugely|seriously|insanely|mega|max(?:imum)?)\s+(?:more\s+)?$/i;
const EN_WEAK = /\b(?:a bit|a little|a touch|slightly|somewhat|kinda|kind of|a tad|little|bit|touch of|hint of|subtly)\s+(?:more\s+|of\s+)?$/i;
const EN_SUF_ENOUGH = /^\s*enough/i;
const EN_SUF_STRONG = /^\s*(?:!{2,}|as hell|af\b)/i;

/**
 * Understand a free-text sound description (Traditional Chinese or English, mixed OK).
 * Intensity words ("一點點 / 有點 / 很 / 超級 / a bit / very") scale the amount; negations and "too …"
 * turn into the opposite mood ("不要那麼亮" → darker, "less reverb" → cleaner).
 * @param {string} text
 * @returns {{id:string, amount:number}[]} in order of appearance (merged per mood, amount 0.05..1)
 */
export function parseMoodText(text) {
  const s = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  // collect keyword hits, longest first at each position, no overlaps
  const hits = [];
  for (const mt of MATCHERS) {
    mt.re.lastIndex = 0;
    let r;
    while ((r = mt.re.exec(s))) {
      hits.push({ i: r.index, len: r[0].length, m: mt.m, opp: mt.opp });
      if (!r[0].length) mt.re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.i - b.i || b.len - a.len);
  const kept = [];
  let end = -1;
  for (const h of hits) { if (h.i >= end) { kept.push(h); end = h.i + h.len; } }

  const acc = new Map(); // id → {amount, order}
  let order = 0;
  const add = (id, amt) => {
    const cur = acc.get(id);
    if (cur) cur.amount = Math.min(1, cur.amount + amt * 0.6);
    else acc.set(id, { amount: Math.min(1, amt), order: order++ });
  };
  const bangs = (s.match(/[!！]/g) || []).length;
  kept.forEach((h, n) => {
    // modifiers must sit between the previous keyword and this one
    const from = n ? kept[n - 1].i + kept[n - 1].len : 0;
    const pre = s.slice(Math.max(from, h.i - 14), h.i);
    const nextStart = n + 1 < kept.length ? kept[n + 1].i : s.length;
    const post = s.slice(h.i + h.len, Math.min(nextStart, h.i + h.len + 10));
    const zh = CJK.test(s.slice(h.i, h.i + h.len));
    let amount = DEFAULT_AMOUNT;
    let flip = false;
    if (zh) {
      const p = pre.replace(/\s+/g, '').replace(/(有|得|地|的)$/, '');
      if (ZH_NEG_TOO.test(p)) { flip = true; amount = 0.35; }
      else if (ZH_ENOUGH.test(p)) amount = 0.7;
      else if (ZH_NEG.test(p)) { flip = true; amount = 0.6; }
      else if (ZH_TOO.test(p)) { flip = true; amount = ZH_SUF_TOO.test(post) ? 0.6 : 0.55; }
      if (!flip || amount >= 0.55) {
        const q = p.replace(ZH_NEG, '').replace(ZH_TOO, '');
        if (ZH_STRONG.test(p) || ZH_STRONG.test(q)) amount = /(超級|極度|爆|無敵|最|超)/.test(p) ? 1 : 0.85;
        else if (ZH_WEAK.test(p) || ZH_WEAK.test(q)) amount = /(一點點|微微|稍稍|淡淡)/.test(p) ? 0.25 : 0.4;
      }
      if (ZH_SUF_TINY.test(post)) amount = Math.min(amount, 0.25);
      else if (ZH_SUF_STRONG.test(post)) amount = Math.max(amount, 0.9);
      else if (ZH_SUF_WEAK.test(post) && amount === DEFAULT_AMOUNT) amount = 0.4;
    } else {
      if (EN_NEG_TOO.test(pre)) { flip = true; amount = 0.35; }
      else if (EN_NEG.test(pre) && !EN_SUF_ENOUGH.test(post)) { flip = true; amount = 0.6; }
      else if (EN_TOO.test(pre)) { flip = true; amount = 0.6; }
      else if (EN_SUF_ENOUGH.test(post)) amount = 0.7;
      if (EN_STRONG.test(pre)) amount = flip ? 0.85 : /\b(super|extremely|massively|ultra|insanely|mega|max)/i.test(pre) ? 1 : 0.85;
      else if (EN_WEAK.test(pre)) amount = flip ? 0.35 : 0.35;
      if (EN_SUF_STRONG.test(post)) amount = Math.max(amount, 0.9);
    }
    if (bangs && !flip) amount = Math.min(1, amount + 0.1 * Math.min(3, bangs));
    if (flip && h.opp) for (const id in h.opp) add(id, amount * h.opp[id]);
    else {
      for (const id in h.m) {
        const w = h.m[id];
        if (flip) for (const [op, ow] of OPPOSITE[id] || []) add(op, amount * w * ow);
        else add(id, amount * w);
      }
    }
  });
  return [...acc.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id, v]) => ({ id, amount: Math.round(clamp(v.amount, 0.05, 1) * 100) / 100 }))
    .filter(x => x.amount >= 0.08);
}
