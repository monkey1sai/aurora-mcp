// Demo automation helpers (no DOM):
//  • preset-demo macro rides: the ▶ 示範 phrase gets 'ramp-macro' events so the macro knobs visibly move
//    (preset.demoMacros when the preset has them, otherwise a gentle automatic ride). The engine's
//    sequencer runs the ramps sample-accurately and restores the macros when the demo stops; the play
//    view follows the engine's macro values (main.js → playView.followMacros).
//  • silent patch apply / snapshot / restore / commit for tours and theater mode: the user's undo history
//    is kept, and "keep this sound" becomes exactly one undo step.

import { PARAMS, DEFAULTS } from '../../dsp/params.js';

const PATCH_IDS = PARAMS.filter(p => p.scope !== 'global').map(p => p.id);
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const r3 = x => Math.round(x * 1000) / 1000;

/* ═════════════════════════════ macro rides ═════════════════════════════ */

/**
 * Plan macro ramps for one pass of a phrase.
 * @param {{ lengthBeats:number, demoMacros?:Array<{index,to,beat,beats}>, macros?:Array<{targets:Array}>, values?:number[] }} o
 * @returns {Array<{index:number, to:number, beat:number, beats:number}>}
 */
export function planMacroRides({ lengthBeats, demoMacros = null, macros = [], values = [0, 0, 0, 0] }) {
  const L = Math.max(1, Number(lengthBeats) || 16);
  const usable = i => !!(macros[i] && Array.isArray(macros[i].targets) && macros[i].targets.length);
  const rides = [];
  if (Array.isArray(demoMacros) && demoMacros.length) {
    for (const r of demoMacros) {
      const i = Math.round(Number(r.index));
      if (!(i >= 0 && i < 4) || !usable(i)) continue;
      const beat = Math.max(0, Math.min(L - 0.25, Number(r.beat) || 0));
      rides.push({ index: i, to: clamp01(Number(r.to) || 0), beat, beats: Math.max(0.25, Math.min(L - beat, Number(r.beats) || 2)) });
    }
    return rides;
  }
  // automatic gentle ride: the first usable macro rises and falls over the phrase; the next one swells
  // briefly in the middle. Always ends back at the starting values, so every loop pass moves again.
  const order = [0, 1, 2, 3].filter(usable);
  if (!order.length) return rides;
  const a = order[0], va = clamp01(values[a] || 0);
  const peakA = va < 0.5 ? Math.min(1, va + 0.6) : Math.max(0, va - 0.55);
  rides.push({ index: a, to: r3(peakA), beat: r3(L * 0.06), beats: r3(L * 0.38) });
  rides.push({ index: a, to: va, beat: r3(L * 0.56), beats: r3(L * 0.36) });
  if (order.length > 1) {
    const b = order[1], vb = clamp01(values[b] || 0);
    const peakB = vb < 0.5 ? Math.min(1, vb + 0.4) : Math.max(0, vb - 0.35);
    rides.push({ index: b, to: r3(peakB), beat: r3(L * 0.3), beats: r3(L * 0.22) });
    rides.push({ index: b, to: vb, beat: r3(L * 0.66), beats: r3(L * 0.24) });
  }
  return rides;
}

/**
 * Copy of `song` with the rides added as 'ramp-macro' events. For looping songs, macros that do not end a
 * pass at their starting value glide back during the first beats of the next pass.
 */
export function withMacroRides(song, rides, values = [0, 0, 0, 0]) {
  const L = song.lengthBeats || 16;
  const events = song.events.slice();
  const last = new Map();
  for (const r of rides) {
    events.push({ beat: r.beat, type: 'ramp-macro', index: r.index, to: r.to, beats: r.beats });
    const prev = last.get(r.index);
    if (!prev || r.beat >= prev.beat) last.set(r.index, r);
  }
  if (song.loop !== false) {
    const back = Math.min(1.5, L / 8);
    for (const [i, r] of last) {
      const v0 = clamp01(values[i] || 0);
      if (Math.abs(r.to - v0) < 0.01) continue;
      // at beat 0 of the first pass this is a no-op (the macro is still at its start value)
      const first = rides.filter(x => x.index === i).reduce((m, x) => Math.min(m, x.beat), Infinity);
      if (first < back) continue; // the pass itself starts by moving this macro
      events.push({ beat: 0, type: 'ramp-macro', index: i, to: v0, beats: back });
    }
  }
  events.sort((x, y) => x.beat - y.beat);
  return { ...song, events };
}

/**
 * The ▶ 示範 song for the current patch: phrase + macro rides.
 * @param {{ phrases: {PHRASES, DEMO_FOR_CATEGORY, getPhrase}, meta:{demo, category}, demoMacros?, macros, values:number[] }} o
 * @returns {{ id:string, song:object, rides:Array, label:{zh:string, en:string} } | null}
 */
export function presetDemoSong({ phrases, meta, demoMacros = null, macros = [], values = [0, 0, 0, 0] }) {
  if (!phrases || !phrases.PHRASES) return null;
  let id = meta && meta.demo && phrases.PHRASES[meta.demo] ? meta.demo : null;
  if (!id) {
    const byCat = phrases.DEMO_FOR_CATEGORY && meta && phrases.DEMO_FOR_CATEGORY[meta.category];
    id = byCat && phrases.PHRASES[byCat] ? byCat : 'keys';
  }
  const base = phrases.getPhrase ? phrases.getPhrase(id) : JSON.parse(JSON.stringify(phrases.PHRASES[id]));
  const rides = planMacroRides({ lengthBeats: base.lengthBeats, demoMacros, macros, values });
  const song = rides.length ? withMacroRides(base, rides, values) : base;
  const ph = phrases.PHRASES[id];
  return { id, song, rides, label: { zh: ph.zh || ph.label || id, en: ph.label || id } };
}

/** Current macro values [4] from the store. */
export const macroValues = store => [1, 2, 3, 4].map(i => +store.get(`macro${i}`) || 0);

/* ═════════════════════════════ silent patch operations ═════════════════════════════ */

/**
 * Everything needed to put the patch back exactly (values, macro definitions, meta, dirty flag).
 * committed: take transient params (magic-tool previews, glides in flight) at their committed value — the
 * user's real patch — instead of what is sounding right now.
 */
export function snapshotPatch(store, { committed = false } = {}) {
  const values = {};
  const get = committed && typeof store.committed === 'function' ? id => store.committed(id) : id => store.get(id);
  for (const id of PATCH_IDS) values[id] = get(id);
  return {
    values,
    macros: JSON.parse(JSON.stringify(store.getMacros())),
    meta: { ...store.getMeta(), tags: [...(store.getMeta().tags || [])] },
    dirty: store.isDirty(),
  };
}

/** Full native value map for a preset-like object (missing → defaults), patch scope only. */
export function presetValues(preset) {
  const params = (preset && preset.params) || {};
  const out = {};
  for (const id of PATCH_IDS) out[id] = params[id] !== undefined ? params[id] : DEFAULTS[id];
  return out;
}

/**
 * Load a preset without touching the undo history or the dirty flag (tours, theater). The engine gets the
 * changed values plus one loadPatch for the macro definitions.
 */
export function applyPatchSilently(store, preset, meta = {}) {
  store.setMany(presetValues(preset), { record: false, origin: 'demo' });
  store.setMacroDefs((preset && preset.macros) || [], { record: false });
  store.setMeta({
    name: preset.name || 'Demo', category: preset.category || null, tags: preset.tags || [],
    description: preset.description || '', demo: preset.demo || null, source: 'demo', key: null, ...meta,
  });
}

/** Put a snapshot back (engine included), still without undo entries. */
export function restorePatch(store, snap) {
  store.setMany(snap.values, { record: false, origin: 'demo' });
  store.setMacroDefs(snap.macros, { record: false });
  store.setMeta(snap.meta);
  if (!snap.dirty) store.markClean();
}

/**
 * Make the current (demo-animated) patch the user's patch as ONE undo step whose "before" is `snap`.
 * The UI state is rewound silently (nothing sent) and re-applied through loadPreset({record:true}).
 */
export function commitPatch(store, snap, meta = {}) {
  const now = snapshotPatch(store);
  store.setMany(snap.values, { record: false, send: false, origin: 'demo' });
  store.setMacroDefs(snap.macros, { record: false, send: false });
  store.setMeta(snap.meta);
  if (!snap.dirty) store.markClean(); // the undo step's "before" is exactly the user's (clean) patch
  const params = {};
  for (const id of PATCH_IDS) params[id] = now.values[id];
  store.loadPreset({
    name: meta.name || now.meta.name, category: meta.category ?? now.meta.category, tags: meta.tags || now.meta.tags || [],
    description: meta.description ?? now.meta.description, demo: meta.demo ?? now.meta.demo, params, macros: now.macros,
  }, { record: true, source: meta.source || 'user-edit', key: meta.key ?? null, dirty: true });
}
