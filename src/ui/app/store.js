// Patch state store: the single source of truth for the UI.
//  • values: native values (Hz, s, dB, enum option id, boolean …) for every schema param
//  • macros: the patch's 4 macro definitions [{ name, targets:[{id, amount}] }]
//  • meta:   preset name/category/tags/description/demo/source
// Every edit goes through set()/setMany(), which (a) forwards to the audio sink, (b) notifies bound
// controls, (c) records undo history. Pure logic: no DOM (usable from Node for tests).
//
// Transient edits (demo / "magic" tools: moods, auto-evolve, A/B morph):
//   setTransient(id, v) / setTransientMany(obj)  change the sound and move bound controls (listeners get
//     origin 'transient') without touching undo history or the dirty flag. The store remembers each touched
//     param's committed value until commit(label) records ONE undo step (committed → current) or revert()
//     restores it. A regular set()/setMany() of a transient param commits that param (undo "before" = the
//     committed value) and cancels any animation of it.
//   animate(targets, { ms, ease, commit, onDone }) glides params there via transient writes (engine/FX on-off
//     fades, filter "open" crossfades and mod-route crossfades — see blendValues) → { cancel(), finish(), done }.
//   loadPreset() drops transient state; undo()/redo() first finish committing animations and revert the rest.

import { PARAMS, PARAM_BY_ID, DEFAULTS, toNorm, fromNorm } from '../../dsp/params.js';

export const PATCH_IDS = PARAMS.filter(p => p.scope !== 'global').map(p => p.id);
export const GLOBAL_IDS = PARAMS.filter(p => p.scope === 'global').map(p => p.id);
const MACRO_IDS = ['macro1', 'macro2', 'macro3', 'macro4'];
// macro knob positions are part of the patch (saved in presets): they are undoable and mark the patch modified.
// Only the master volume (a global, like a hardware volume knob) stays out of the history.
const NO_HISTORY = new Set(['master.volume']);
const HISTORY_MAX = 200;
const COALESCE_MS = 900;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Coerce any incoming value into the param's native form (enum id, boolean, clamped number). */
export function sanitizeValue(p, v) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (p.type === 'enum') {
    if (typeof v === 'number' && Number.isFinite(v)) return p.options[Math.max(0, Math.min(p.options.length - 1, Math.round(v)))];
    if (typeof v === 'string' && p.options.includes(v)) return v;
    // enums with numeric-looking option ids (e.g. phaser.stages '4')
    if (v != null && p.options.includes(String(v))) return String(v);
    return p.def;
  }
  if (p.type === 'bool') return v === true || v === 1 || v === '1' || v === 'true';
  let x = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(x)) x = p.def;
  x = x < p.min ? p.min : x > p.max ? p.max : x;
  return p.type === 'int' ? Math.round(x) : x;
}

/** Exactly 4 macro slots with sanitised targets (float/int params only, amount −1..1). */
export function normalizeMacros(macros) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const m = Array.isArray(macros) ? macros[i] : null;
    const targets = [];
    if (m && Array.isArray(m.targets)) {
      for (const t of m.targets) {
        const p = t && PARAM_BY_ID[t.id];
        if (!p || (p.type !== 'float' && p.type !== 'int')) continue;
        const a = Number(t.amount);
        if (!Number.isFinite(a) || a === 0) continue;
        targets.push({ id: t.id, amount: Math.max(-1, Math.min(1, a)) });
      }
    }
    out.push({ name: (m && typeof m.name === 'string' && m.name.trim()) || `巨集 ${i + 1} Macro ${i + 1}`, targets });
  }
  return out;
}

const eq = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

/** Non-default patch-scope params (what a preset stores). */
export function diffFromDefaults(values) {
  const out = {};
  for (const id of PATCH_IDS) {
    const v = values[id];
    if (v === undefined) continue;
    if (!eq(v, DEFAULTS[id])) out[id] = typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
  }
  return out;
}

/* ═══════════════════════ patch blending (animations, morphs) ═══════════════════════ */

/** Sources and FX that have an on switch plus a gain (level / mix) we can fade instead of clicking. */
const GATES = {
  osc1: 'osc1.level', osc2: 'osc2.level', fm: 'fm.level', phys: 'phys.level', noise: 'noise.level',
  drive: 'drive.mix', chorus: 'chorus.mix', phaser: 'phaser.mix', delay: 'delay.mix', reverb: 'reverb.mix',
};
/** Enums that rebuild an engine (not crossfaded inside the DSP): dip that engine's level around the switch. */
export const STRUCTURAL = { osc1: ['osc1.mode', 'osc1.table'], osc2: ['osc2.mode', 'osc2.table'], phys: ['phys.model', 'phys.exciter'] };
/** Would going from values X to Y rebuild engine g (osc mode, wavetable in use, phys model/exciter)? */
export function structuralChange(g, X, Y) {
  if (g === 'osc1' || g === 'osc2') {
    const mx = X[`${g}.mode`], my = Y[`${g}.mode`];
    return mx !== my || ((mx === 'wavetable' || my === 'wavetable') && X[`${g}.table`] !== Y[`${g}.table`]);
  }
  return !!STRUCTURAL[g] && STRUCTURAL[g].some(id => X[id] !== Y[id]);
}
const LP_TYPES = new Set(['ladder24', 'ladder12', 'lp']);
/** Int params that must not glide through intermediate values (pitch, algorithm, polyphony …). */
const STEP_INTS = new Set(['fm.algo', 'voice.poly', 'voice.bend', 'arp.oct']);

/** Group key of a param id: 'osc1.shape' → 'osc1', 'fm.op2.level' → 'fm', 'mod3.amt' → 'mod3', 'macro1' → 'macro1'. */
export function groupOf(id) {
  const d = id.indexOf('.');
  return d < 0 ? id : id.slice(0, d);
}
const GROUP_IDS = {};
for (const id of PATCH_IDS) (GROUP_IDS[groupOf(id)] ||= []).push(id);
const EXPAND = new Set([...Object.keys(GATES), 'filter', 'filter2', 'lfo1', 'lfo2', ...Object.keys(GROUP_IDS).filter(g => /^mod\d+$/.test(g))]);

/**
 * Params an animation of `ids` has to drive together: engines/FX, filters, LFOs and mod slots are blended
 * as whole groups (so e.g. switching an effect on can fade its mix in from 0).
 */
export function affectedIds(ids) {
  const out = new Set();
  for (const id of ids) {
    if (!PARAM_BY_ID[id] || PARAM_BY_ID[id].scope === 'global') continue;
    const g = groupOf(id);
    if (EXPAND.has(g)) for (const x of GROUP_IDS[g]) out.add(x);
    else out.add(id);
  }
  return [...out];
}

const smooth01 = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** Level dip around t = 0.5 (±6 %) for engine rebuilds. */
const dip = t => smooth01(Math.abs(t - 0.5) / 0.06);

/** Interpolate one param's native value: normalised-space lerp for continuous params, a switch at ½ otherwise. */
export function lerpParam(p, a, b, t) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (a === undefined) return b;
  if (b === undefined || eq(a, b)) return a;
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (p.type === 'float') {
    if (p.unit === 'st') return t < 0.5 ? a : b; // voice pitch: no audible glide across a morph
    const na = toNorm(p, a);
    return fromNorm(p, na + (toNorm(p, b) - na) * t);
  }
  if (p.type === 'int') {
    if (p.unit === 'oct' || p.unit === 'st' || STEP_INTS.has(p.id)) return t < 0.5 ? a : b;
    return Math.round(a + (b - a) * t);
  }
  return t < 0.5 ? a : b;
}

function lfoUsed(V, lfo) {
  for (let k = 1; GROUP_IDS[`mod${k}`]; k++) {
    if (V[`mod${k}.src`] === lfo && V[`mod${k}.dst`] !== 'none' && V[`mod${k}.amt`]) return true;
  }
  return false;
}
const pickGroup = (V, g) => { const o = {}; for (const id of GROUP_IDS[g]) o[id] = V[id]; return o; };
function lerpGroup(X, Y, u, g) {
  const o = {};
  for (const id of GROUP_IDS[g]) o[id] = lerpParam(PARAM_BY_ID[id], X[id], Y[id], u);
  return o;
}
/** Filter state that sounds like "no filter" for this type (LP fully open / HP fully down), or null. */
function neutralFilter(V, g) {
  const type = g === 'filter' ? V['filter.type'] : V['filter2.type'];
  const kind = (g === 'filter' ? LP_TYPES.has(type) : type === 'lp') ? 'lp' : type === 'hp' ? 'hp' : null;
  if (!kind) return null;
  const o = pickGroup(V, g);
  o[`${g}.cutoff`] = kind === 'lp' ? 20000 : 20;
  o[`${g}.res`] = 0;
  if (g === 'filter') { o['filter.on'] = true; o['filter.drive'] = 0; o['filter.env'] = 0; o['filter.vel'] = 0; }
  return o;
}
function blendFilterGroup(A, B, t, g) {
  const isOn = V => (g === 'filter' ? !!V['filter.on'] : V['filter2.type'] !== 'off');
  const typeOf = V => V[`${g}.type`];
  const onA = isOn(A), onB = isOn(B);
  const sw = () => pickGroup(t < 0.5 ? A : B, g);
  if (!onA && !onB) return lerpGroup(A, B, t, g);
  if (onA && onB) {
    const ta = typeOf(A), tb = typeOf(B);
    if (ta === tb || (g === 'filter' && LP_TYPES.has(ta) && LP_TYPES.has(tb))) return lerpGroup(A, B, t, g);
    // different families: open A up to "neutral", switch type there, close into B
    const nA = neutralFilter(A, g), nB = neutralFilter(B, g);
    if (t < 0.5) return nA ? lerpGroup(A, nA, t * 2, g) : pickGroup(A, g);
    return nB ? lerpGroup(nB, B, t * 2 - 1, g) : pickGroup(B, g);
  }
  if (onA) { const nA = neutralFilter(A, g); return nA ? lerpGroup(A, nA, t, g) : sw(); }
  const nB = neutralFilter(B, g);
  return nB ? lerpGroup(nB, B, t, g) : sw();
}
function blendModSlot(A, B, t, g) {
  const s = `${g}.src`, d = `${g}.dst`, m = `${g}.amt`;
  const act = V => V[s] !== 'none' && V[d] !== 'none' && !!V[m];
  const aA = act(A), aB = act(B);
  const route = (V, amt) => ({ [s]: V[s], [d]: V[d], [m]: amt });
  if (A[s] === B[s] && A[d] === B[d]) return route(A, A[m] + (B[m] - A[m]) * t);
  if (aA && !aB) return route(A, A[m] * (1 - t));
  if (!aA && aB) return route(B, B[m] * t);
  if (aA && aB) return t < 0.5 ? route(A, A[m] * (1 - 2 * t)) : route(B, B[m] * (2 * t - 1));
  return route(t < 0.5 ? A : B, A[m] + (B[m] - A[m]) * t);
}

/**
 * Blend two complete native value sets: t = 0 → exactly A, t = 1 → exactly B, and in between something that
 * never clicks or jumps needlessly:
 *  • continuous params interpolate in normalised space (log for Hz, curves for times); enums/bools/pitch ints
 *    switch at ½;
 *  • an engine or effect that is on in only one side stays on and fades its level/mix instead (its other params
 *    come from the side where it is audible); engines whose model/table changes dip their level around ½;
 *  • a filter that is on in only one side sweeps to fully open (LP) / fully down (HP) instead of switching;
 *    different filter families cross over through that neutral point;
 *  • mod-matrix slots fade their amount (different routes cross through zero at ½);
 *  • LFO settings come from the side that actually uses the LFO.
 * @param {object} A native values   @param {object} B native values   @param {number} t 0..1
 * @param {Iterable<string>} [ids=PATCH_IDS] which params to return
 * @param {{dip?: boolean}} [opts] dip: false → no level dip for engine rebuilds (callers that can rest at t = ½,
 *   e.g. a morph slider, duck the engine in time instead — see morph.js)
 * @returns {object} { id: native value }
 */
export function blendValues(A, B, t, ids = PATCH_IDS, opts = {}) {
  const useDip = !opts || opts.dip !== false;
  const out = {};
  if (!(t > 0) || t >= 1) {
    const S = t >= 1 ? B : A;
    for (const id of ids) out[id] = S[id];
    return out;
  }
  const cache = new Map();
  const group = (g, fn) => { let o = cache.get(g); if (!o) { o = fn(); cache.set(g, o); } return o; };
  for (const id of ids) {
    const p = PARAM_BY_ID[id];
    if (!p) continue;
    const g = groupOf(id);
    if (g === 'filter' || g === 'filter2') { out[id] = group(g, () => blendFilterGroup(A, B, t, g))[id]; continue; }
    if (/^mod\d+$/.test(g)) { out[id] = group(g, () => blendModSlot(A, B, t, g))[id]; continue; }
    const gate = GATES[g];
    if (gate) {
      const onId = `${g}.on`;
      const onA = !!A[onId], onB = !!B[onId];
      if (onA !== onB) {
        const S = onA ? A : B;
        out[id] = id === onId ? true : id === gate ? S[gate] * (onA ? 1 - t : t) : S[id];
        continue;
      }
      if (onA && id === gate) {
        let lv = lerpParam(p, A[id], B[id], t);
        if (useDip && STRUCTURAL[g] && structuralChange(g, A, B)) lv *= dip(t);
        out[id] = lv;
        continue;
      }
    }
    if (g === 'lfo1' || g === 'lfo2') {
      const ua = lfoUsed(A, g), ub = lfoUsed(B, g);
      if (ua !== ub) { out[id] = (ua ? A : B)[id]; continue; }
    }
    out[id] = lerpParam(p, A[id], B[id], t);
  }
  return out;
}

const EASES = {
  linear: t => t,
  in: t => t * t * t,
  out: t => 1 - (1 - t) ** 3,
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  sine: t => 0.5 - 0.5 * Math.cos(Math.PI * t),
};

export function createStore({ globals = null } = {}) {
  const values = { ...DEFAULTS };
  if (globals) for (const id of GLOBAL_IDS) if (globals[id] !== undefined) values[id] = sanitizeValue(PARAM_BY_ID[id], globals[id]);
  let macros = normalizeMacros(null);
  let meta = { name: 'Init', category: null, tags: [], description: '', demo: null, source: 'init', key: null };
  let dirty = false;
  let cleanKey = '';
  let sink = null;

  const subs = new Map();      // id → Set<fn(value, origin)>
  const anySubs = new Set();   // fn(id, value, origin)
  const patchSubs = new Set(); // fn(meta)
  const histSubs = new Set();  // fn({canUndo, canRedo})
  const dirtySubs = new Set(); // fn(dirty)
  const macroSubs = new Set(); // fn(macros)
  const globalSubs = new Set();// fn(globalsObject)
  const undoStack = [];
  const redoStack = [];
  const tx = new Map();        // transient params: id → committed value
  const txSubs = new Set();    // fn({type:'begin'|'commit'|'revert'|'clear', owner, ids})
  const anims = new Set();     // running animate() jobs
  let animTimer = null;

  const call = (set, ...a) => { for (const fn of set) { try { fn(...a); } catch (e) { console.error(e); } } };

  function emit(id, v, origin) {
    const s = subs.get(id);
    if (s) for (const fn of s) { try { fn(v, origin); } catch (e) { console.error(e); } }
    call(anySubs, id, v, origin);
  }
  function emitAll(origin) { for (const p of PARAMS) emit(p.id, values[p.id], origin); }
  const historyChanged = () => call(histSubs, { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  function setDirty(d) { if (d !== dirty) { dirty = d; call(dirtySubs, dirty); } }
  function globalsObj() { const o = {}; for (const id of GLOBAL_IDS) o[id] = values[id]; return o; }

  function push(entry) {
    undoStack.push(entry);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
    historyChanged();
  }
  function recordParam(id, before, after, coalesce) {
    const last = undoStack[undoStack.length - 1];
    const t = now();
    if (coalesce && last && last.kind === 'param' && last.id === id && t - last.t < COALESCE_MS && !redoStack.length) {
      last.after = after;
      last.t = t;
      return;
    }
    push({ kind: 'param', id, before, after, t });
  }

  function sendParam(id, v) {
    if (!sink) return;
    const mi = MACRO_IDS.indexOf(id);
    if (mi >= 0) sink.setMacro(mi, v);
    else sink.setParam(id, v);
  }

  /**
   * Set one param. opts: { origin (passed to listeners, e.g. the control itself), record = true,
   * send = true, coalesce = true (merge rapid edits of the same param into one undo step) }.
   */
  /** A regular (non-transient) write of `id`: it stops being transient/animated. Returns the committed value. */
  function claimReal(id) {
    for (const a of anims) a.ids.delete(id);
    if (!tx.has(id)) return values[id];
    const c = tx.get(id);
    tx.delete(id);
    return c;
  }

  function set(id, v, opts = {}) {
    const p = PARAM_BY_ID[id];
    if (!p) return false;
    v = sanitizeValue(p, v);
    const prev = claimReal(id);
    if (eq(values[id], v) && eq(prev, v)) return false;
    values[id] = v;
    const rec = opts.record !== false && !NO_HISTORY.has(id) && !eq(prev, v);
    if (rec && p.scope !== 'global') recordParam(id, prev, v, opts.coalesce !== false);
    if (opts.send !== false) sendParam(id, v);
    if (p.scope === 'global') call(globalSubs, globalsObj());
    else if (rec) setDirty(true);
    emit(id, v, opts.origin);
    return true;
  }

  /** Set several params as one undoable step (one message to the audio thread). */
  function setMany(obj, opts = {}) {
    const changes = [];
    for (const id in obj) {
      const p = PARAM_BY_ID[id];
      if (!p) continue;
      const v = sanitizeValue(p, obj[id]);
      const prev = claimReal(id); // committed value (differs from values[id] while transient)
      if (eq(values[id], v) && eq(prev, v)) continue;
      changes.push([id, prev, v]);
      values[id] = v;
    }
    if (!changes.length) return 0;
    if (opts.record !== false) {
      const hist = changes.filter(([id, b, a]) => !NO_HISTORY.has(id) && PARAM_BY_ID[id].scope !== 'global' && !eq(b, a));
      if (hist.length) {
        const last = undoStack[undoStack.length - 1];
        const t = now();
        if (opts.coalesce && last && last.kind === 'bulk' && last.key === opts.coalesce && t - last.t < COALESCE_MS && !redoStack.length) {
          // continuous gesture (e.g. envelope node drag): merge into one undo step
          for (const [id, b, a] of hist) {
            const ex = last.changes.find(c => c[0] === id);
            if (ex) ex[2] = a; else last.changes.push([id, b, a]);
          }
          last.t = t;
        } else {
          push({ kind: 'bulk', changes: hist, label: opts.label || '', key: opts.coalesce || null, t });
        }
        setDirty(true);
      }
    }
    if (opts.send !== false && sink) {
      const o = {};
      for (const [id, , v] of changes) o[id] = v;
      sink.setParams(o);
    }
    if (changes.some(([id]) => PARAM_BY_ID[id].scope === 'global')) call(globalSubs, globalsObj());
    for (const [id, , v] of changes) emit(id, v, opts.origin);
    return changes.length;
  }

  function toPatch() {
    return { name: meta.name, category: meta.category, params: diffFromDefaults(values), macros: macros.map(m => ({ name: m.name, targets: m.targets.map(t => ({ ...t })) })) };
  }

  /** Current patch as a preset object (for saving/export). */
  function toPreset(extra = {}) {
    const p = toPatch();
    return {
      name: extra.name ?? meta.name,
      category: extra.category ?? meta.category ?? 'fx',
      tags: extra.tags ?? meta.tags ?? [],
      description: extra.description ?? meta.description ?? '',
      params: p.params,
      macros: p.macros,
      demo: extra.demo ?? meta.demo ?? null,
    };
  }

  function snapshot() {
    const v = {};
    for (const id of PATCH_IDS) v[id] = values[id];
    // clean: the saved/loaded state this snapshot's dirty flag is measured against (undo across a preset switch
    // must compare later edits with THAT patch, not with the one loaded afterwards)
    return { values: v, macros: JSON.parse(JSON.stringify(macros)), meta: { ...meta, tags: [...(meta.tags || [])] }, dirty, clean: cleanKey };
  }
  /** snapshot() with transient params at their committed values (what undo history knows). */
  function committedSnapshot() {
    const snap = snapshot();
    for (const [id, c] of tx) snap.values[id] = c;
    return snap;
  }
  function restoreSnapshot(snap) {
    for (const id of PATCH_IDS) values[id] = snap.values[id];
    macros = JSON.parse(JSON.stringify(snap.macros));
    meta = { ...snap.meta };
    if (typeof snap.clean === 'string') cleanKey = snap.clean;
    if (sink) sink.loadPatch(toPatch());
    setDirty(snap.dirty);
    call(macroSubs, macros);
    call(patchSubs, meta);
    emitAll('history');
  }

  /**
   * Load a preset (factory, user, imported or generated). Global params are untouched.
   * opts: { record = false (true → undoable, e.g. Randomize, or leaving an edited patch), source, key,
   *         dirty (default: false, or true when recorded) }
   * A load with dirty:false makes the loaded patch the new clean reference (undoing back to it clears the
   * modified flag); a recorded load keeps the history, the undo step restores the previous patch AND its flag.
   */
  function loadPreset(preset, opts = {}) {
    const before = opts.record ? committedSnapshot() : null;
    dropTransient();
    const params = (preset && preset.params) || {};
    for (const id of PATCH_IDS) {
      const p = PARAM_BY_ID[id];
      values[id] = sanitizeValue(p, params[id] !== undefined ? params[id] : p.def);
    }
    macros = normalizeMacros(preset && preset.macros);
    meta = {
      name: (preset && preset.name) || 'Untitled',
      category: (preset && preset.category) || null,
      tags: Array.isArray(preset && preset.tags) ? [...preset.tags] : [],
      description: (preset && preset.description) || '',
      demo: (preset && preset.demo) || null,
      source: opts.source || (preset && preset.user ? 'user' : 'factory'),
      key: opts.key ?? null,
    };
    if (sink) sink.loadPatch(toPatch());
    if (opts.record) {
      const d = opts.dirty ?? true;
      if (!d) cleanKey = patchKey();
      setDirty(d);
      push({ kind: 'patch', before, after: snapshot() }); // after the flag: redo restores it too
    } else {
      undoStack.length = 0;
      redoStack.length = 0;
      historyChanged();
      setDirty(!!opts.dirty);
      if (!opts.dirty) cleanKey = patchKey();
    }
    call(macroSubs, macros);
    call(patchSubs, meta);
    emitAll('preset');
  }

  const patchKey = () => JSON.stringify(toPatch());
  function applyEntry(entry, dir) {
    if (entry.kind === 'param') {
      const v = dir < 0 ? entry.before : entry.after;
      values[entry.id] = v;
      sendParam(entry.id, v);
      emit(entry.id, v, 'history');
    } else if (entry.kind === 'bulk') {
      const o = {};
      for (const [id, b, a] of entry.changes) { const v = dir < 0 ? b : a; values[id] = v; o[id] = v; }
      if (sink) sink.setParams(o);
      for (const id in o) emit(id, o[id], 'history');
    } else if (entry.kind === 'patch') {
      restoreSnapshot(dir < 0 ? entry.before : entry.after);
      return;
    } else if (entry.kind === 'macros') {
      macros = JSON.parse(JSON.stringify(dir < 0 ? entry.before : entry.after));
      if (sink) sink.loadPatch(toPatch());
      call(macroSubs, macros);
    }
    // undoing back to the saved/loaded state makes the patch clean again
    setDirty(patchKey() !== cleanKey);
  }
  function undo() {
    settleTransient();
    const e = undoStack.pop();
    if (!e) return false;
    applyEntry(e, -1);
    redoStack.push(e);
    historyChanged();
    return true;
  }
  function redo() {
    settleTransient();
    const e = redoStack.pop();
    if (!e) return false;
    applyEntry(e, +1);
    undoStack.push(e);
    historyChanged();
    return true;
  }

  /** Replace the macro definitions (undoable; record:false = a silent demo apply/restore, dirty flag untouched). */
  function setMacroDefs(defs, opts = {}) {
    const before = JSON.parse(JSON.stringify(macros));
    macros = normalizeMacros(defs);
    if (opts.record !== false) push({ kind: 'macros', before, after: JSON.parse(JSON.stringify(macros)) });
    if (sink && opts.send !== false) sink.loadPatch(toPatch());
    if (opts.record !== false) setDirty(true);
    call(macroSubs, macros);
  }

  /* ── transient edits & animation ── */
  const txEvent = (type, extra = {}) => call(txSubs, { type, owner: null, ...extra });

  /** Transient write of several params (one sink message, no history, no dirty flag). Returns #changed. */
  function setTransientMany(obj, opts = {}) {
    const changed = [];
    const began = tx.size === 0;
    for (const id in obj) {
      const p = PARAM_BY_ID[id];
      if (!p || p.scope === 'global') continue;
      const v = sanitizeValue(p, obj[id]);
      if (eq(values[id], v)) continue;
      if (!tx.has(id)) tx.set(id, values[id]);
      values[id] = v;
      changed.push(id);
    }
    if (!changed.length) return 0;
    if (opts.send !== false && sink) {
      const o = {};
      for (const id of changed) o[id] = values[id];
      sink.setParams(o);
    }
    if (began) txEvent('begin', { owner: opts.owner || null, ids: changed });
    const origin = opts.origin === undefined ? 'transient' : opts.origin;
    for (const id of changed) emit(id, values[id], origin);
    return changed.length;
  }

  /**
   * Record the transient changes as ONE undo step (committed value → current value) and make them permanent.
   * opts: { ids (default: all transient params), owner, macros (also replace macro definitions), meta (merge) }.
   * With macros/meta the step is a whole-patch step that includes every transient param.
   * Returns the number of params recorded.
   */
  function commit(label = '', opts = {}) {
    if (opts.macros !== undefined || opts.meta) {
      const before = committedSnapshot();
      const ids = [...tx.keys()];
      tx.clear();
      const oldMacros = JSON.stringify(macros);
      if (opts.macros !== undefined) macros = normalizeMacros(opts.macros);
      if (opts.meta) meta = { ...meta, ...opts.meta };
      setDirty(true);
      push({ kind: 'patch', before, after: snapshot(), label });
      if (sink && JSON.stringify(macros) !== oldMacros) sink.loadPatch(toPatch());
      call(macroSubs, macros);
      call(patchSubs, meta);
      txEvent('commit', { owner: opts.owner || null, ids, label });
      return ids.length;
    }
    const ids = [...(opts.ids || tx.keys())].filter(id => tx.has(id));
    const changes = [];
    for (const id of ids) {
      const b = tx.get(id);
      tx.delete(id);
      if (!NO_HISTORY.has(id) && !eq(b, values[id])) changes.push([id, b, values[id]]);
    }
    if (changes.length) {
      push({ kind: 'bulk', changes, label, key: null, t: now() });
      setDirty(true);
    }
    if (ids.length) txEvent('commit', { owner: opts.owner || null, ids, label });
    return changes.length;
  }

  function restoreCommitted(ids, opts = {}) {
    const o = {};
    for (const id of ids) {
      if (!tx.has(id)) continue;
      const c = tx.get(id);
      tx.delete(id);
      if (!eq(values[id], c)) { values[id] = c; o[id] = c; }
    }
    if (sink && Object.keys(o).length) sink.setParams(o);
    for (const id in o) emit(id, o[id], 'transient');
    txEvent(opts.type || 'revert', { owner: opts.owner || null, ids });
  }

  /**
   * Put transient params back to their committed values. opts: { ids, ms (glide there first), ease, owner, onDone }.
   * Returns the animation handle when ms > 0, else null.
   */
  function revert(opts = {}) {
    const ids = [...(opts.ids || tx.keys())].filter(id => tx.has(id));
    if (!ids.length) { if (opts.onDone) opts.onDone(true); return null; }
    for (const a of anims) for (const id of ids) a.ids.delete(id);
    if (opts.ms > 0) {
      const targets = {};
      for (const id of ids) targets[id] = tx.get(id);
      return animate(targets, {
        ms: opts.ms, ease: opts.ease, owner: opts.owner,
        onDone: (ok) => { if (ok) restoreCommitted(ids, opts); if (opts.onDone) opts.onDone(ok); },
      });
    }
    restoreCommitted(ids, opts);
    if (opts.onDone) opts.onDone(true);
    return null;
  }

  function scheduleAnims() {
    if (animTimer || !anims.size) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (typeof requestAnimationFrame === 'function' && !hidden) animTimer = { raf: requestAnimationFrame(tickAnims) };
    else animTimer = { to: setTimeout(tickAnims, 16) };
  }
  function cancelTimer() {
    if (!animTimer) return;
    if (animTimer.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animTimer.raf);
    if (animTimer.to) clearTimeout(animTimer.to);
    animTimer = null;
  }
  function endAnim(a, completed) {
    if (!anims.delete(a)) return;
    // only params this animation actually drove (targets + group companions it had to move)
    const mine = [...a.ids].filter(id => a.touched.has(id));
    if (completed && a.opts.commit) commit(typeof a.opts.commit === 'string' ? a.opts.commit : 'animate', { ids: mine, owner: a.opts.owner });
    else if (completed) for (const id of mine) if (tx.has(id) && eq(tx.get(id), values[id])) tx.delete(id); // back where it was
    if (a.opts.onDone) { try { a.opts.onDone(completed); } catch (e) { console.error(e); } }
    a.resolve(completed);
  }
  function tickAnims() {
    cancelTimer();
    const t = now();
    const out = {};
    const ended = [];
    let owner = null;
    for (const a of anims) {
      const p = a.force ? 1 : a.ms > 0 ? Math.min(1, Math.max(0, (t - a.t0) / a.ms)) : 1;
      const e = p >= 1 ? 1 : a.ease(p);
      if (a.ids.size) {
        const b = blendValues(a.from, a.to, e, a.ids);
        for (const id in b) {
          // companions (other params of a blended group) are written only when the blend moves them
          if (a.targets.has(id) || a.touched.has(id) || !eq(b[id], a.from[id])) { out[id] = b[id]; a.touched.add(id); }
        }
      }
      owner = owner || a.opts.owner || null;
      if (a.opts.onFrame) { try { a.opts.onFrame(e); } catch (err) { console.error(err); } }
      if (p >= 1) ended.push(a);
    }
    setTransientMany(out, { owner: owner || 'animate' });
    for (const a of ended) endAnim(a, true);
    scheduleAnims();
  }

  /**
   * Glide params to native `targets` through transient writes (see blendValues for on/off, filter and
   * mod-route handling). opts: { ms = 700, ease 'inOut'|'out'|'in'|'sine'|'linear' | fn, commit: false | label
   * (record one undo step when done), owner, onFrame(e), onDone(completed) }.
   * A later animation or a regular set() of the same param takes that param over.
   * @returns {{ ids: Set<string>, cancel(): void, finish(): void, done: Promise<boolean> }}
   */
  function animate(targets, opts = {}) {
    const to0 = {};
    for (const id in targets || {}) {
      const p = PARAM_BY_ID[id];
      if (p && p.scope !== 'global') to0[id] = sanitizeValue(p, targets[id]);
    }
    const ids = affectedIds(Object.keys(to0));
    for (const a of anims) {
      for (const id of ids) a.ids.delete(id);
      if (!a.ids.size) endAnim(a, false);
    }
    const from = { ...values };
    const a = {
      ids: new Set(ids), targets: new Set(Object.keys(to0)), touched: new Set(), from, to: { ...from, ...to0 }, t0: now(), ms: Math.max(0, +opts.ms || (opts.ms === 0 ? 0 : 700)),
      ease: typeof opts.ease === 'function' ? opts.ease : EASES[opts.ease] || EASES.inOut, opts, force: false,
    };
    a.done = new Promise(r => { a.resolve = r; });
    anims.add(a);
    if (a.ms === 0) tickAnims(); else scheduleAnims();
    return {
      ids: a.ids,
      done: a.done,
      cancel() { endAnim(a, false); },
      finish() { if (anims.has(a)) { a.force = true; tickAnims(); } },
    };
  }

  /** Stop animations: commitPending → run committing ones to their end (and commit); others are cancelled. */
  function stopAnimations(commitPending = true) {
    for (const a of [...anims]) {
      if (commitPending && a.opts.commit) a.force = true;
      else endAnim(a, false);
    }
    if (anims.size) tickAnims();
    cancelTimer();
  }
  /** Before undo/redo: finish committing animations, put every other transient param back (event 'clear'). */
  function settleTransient() {
    if (anims.size) stopAnimations(true);
    if (tx.size) restoreCommitted([...tx.keys()], { type: 'clear' });
  }
  /** Loading a patch: transient state is meaningless afterwards. */
  function dropTransient() {
    if (anims.size) stopAnimations(false);
    if (tx.size) { const ids = [...tx.keys()]; tx.clear(); txEvent('clear', { ids }); }
  }

  const on = (set, fn) => { set.add(fn); return () => set.delete(fn); };

  return {
    /** Native value of a param. */
    get: id => values[id],
    /** Live values object (read only!). */
    values,
    getMacros: () => macros,
    getMeta: () => meta,
    setMeta(partial) { meta = { ...meta, ...partial }; call(patchSubs, meta); },
    isDirty: () => dirty,
    markClean() {
      // saving keeps what is heard: transient values become the committed state (no undo step)
      if (tx.size) { const ids = [...tx.keys()]; tx.clear(); txEvent('clear', { ids, absorbed: true }); }
      cleanKey = patchKey();
      setDirty(false);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    set, setMany, loadPreset, undo, redo, setMacroDefs, toPatch, toPreset, snapshot, globals: globalsObj,
    /** Normalised 0..1 (base) value. */
    norm(id) { const p = PARAM_BY_ID[id]; return p ? toNorm(p, values[id]) : 0; },
    /**
     * Attach the audio sink { setParam, setParams, loadPatch, setMacro }: pushes the full current state
     * (patch + global params) so the engine matches the UI.
     */
    attach(s) {
      sink = s;
      if (!sink) return;
      sink.loadPatch(toPatch());
      sink.setParams(globalsObj());
    },
    subscribe(id, fn) {
      let s = subs.get(id);
      if (!s) { s = new Set(); subs.set(id, s); }
      s.add(fn);
      return () => s.delete(fn);
    },
    onAny: fn => on(anySubs, fn),
    onPatch: fn => on(patchSubs, fn),
    onHistory: fn => on(histSubs, fn),
    onDirty: fn => on(dirtySubs, fn),
    onMacros: fn => on(macroSubs, fn),
    onGlobals: fn => on(globalSubs, fn),

    /* transient / animation API (demo & magic tools) */
    setTransient: (id, v, opts) => setTransientMany({ [id]: v }, opts) > 0,
    setTransientMany,
    animate,
    commit,
    revert,
    stopAnimations,
    /** Committed (undo-history) value of a param: differs from get() while the param is transient. */
    committed: id => (tx.has(id) ? tx.get(id) : values[id]),
    /** All patch values at their committed state (native). */
    committedValues() { const o = { ...values }; for (const [id, c] of tx) o[id] = c; return o; },
    isTransient: id => (id === undefined ? tx.size > 0 : tx.has(id)),
    transientIds: () => [...tx.keys()],
    isAnimating(id) { for (const a of anims) if (id === undefined || (a.ids.has(id) && (a.targets.has(id) || a.touched.has(id)))) return true; return false; },
    /** fn({ type: 'begin'|'commit'|'revert'|'clear'|'claim'|'release', owner, ids, label, exclusive }) */
    onTransient: fn => on(txSubs, fn),
    /**
     * Coordination between transient tools (no state change by itself): a tool announces it is taking over the
     * sound — exclusive (A/B compare, morph: others should pause/reset) or not (a one-shot mood animation) —
     * and releases it when done. Listeners see { type: 'claim'|'release', owner, exclusive }.
     */
    claim(owner, opts = {}) { txEvent('claim', { owner, exclusive: opts.exclusive !== false }); },
    release(owner) { txEvent('release', { owner }); },
  };
}
