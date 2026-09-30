// Sound-tour timeline helpers (pure ES module: no DOM, no Node APIs — used by the UI tour player and by
// offline checks in Node). See ./index.js for the tour format.

import { PARAM_BY_ID, PARAMS, DEFAULTS, toNorm, fromNorm } from '../../dsp/params.js';

const PATCH_IDS = PARAMS.filter(p => p.scope !== 'global').map(p => p.id);
const MACRO_IDS = ['macro1', 'macro2', 'macro3', 'macro4'];

/** Phrase helper: [[beat, note, dur, vel], …] → sequencer 'on' events. */
export function notes(list) {
  return list.map(([beat, note, dur, vel = 0.8]) => ({ beat, type: 'on', note, dur, vel }));
}

/** Chord helper: same beat, several notes (optional strum in beats). */
export function chordAt(beat, list, dur, vel = 0.7, strum = 0) {
  return list.map((note, i) => [beat + i * strum, note, dur - i * strum, vel - i * 0.01]);
}

/** Smooth ease for ramps (0..1 → 0..1). */
export const ease = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Native value of param `id` part-way (t 0..1, already eased) through a ramp from `from` to `to`
 * (both native). Interpolates in normalised space so exp params (Hz, seconds) sweep musically.
 */
export function rampValue(id, from, to, t) {
  const p = PARAM_BY_ID[id];
  if (!p) return to;
  if (p.type === 'enum' || p.type === 'bool') return t >= 1 ? to : from;
  const a = toNorm(p, from), b = toNorm(p, to);
  const v = fromNorm(p, a + (b - a) * t);
  return p.type === 'int' ? Math.round(v) : v;
}

/** Look up a preset by name (exact, then case-insensitive). */
export function findPreset(presets, name) {
  if (!name || !Array.isArray(presets)) return null;
  return presets.find(p => p.name === name) || presets.find(p => p.name.toLowerCase() === String(name).toLowerCase()) || null;
}

/** The tour's starting patch as a preset-like object { name, category, description, params, macros }. */
export function startPatch(tour, presets = []) {
  const st = tour.start || {};
  const base = findPreset(presets, st.preset);
  const params = { ...(base ? base.params : {}), ...(st.params || {}) };
  return {
    name: tour.title || tour.id,
    category: st.category || (base && base.category) || null,
    description: typeof tour.description === 'object' ? tour.description.zh : tour.description || '',
    tags: ['tour'],
    params,
    macros: st.macros || (base && base.macros) || [],
  };
}

/** Full native value map (patch scope only) for a params object. */
export function patchValues(params = {}) {
  const out = {};
  for (const id of PATCH_IDS) out[id] = params[id] !== undefined ? params[id] : DEFAULTS[id];
  return out;
}

/**
 * Normalised copy of a tour: steps sorted by beat, every action list present, total length in beats.
 * { tour, steps:[{ i, beat, caption, set, ramp, macro, focus, captionIndex }], captionCount, endBeat, bpm }
 */
export function compileTour(tour) {
  const steps = (tour.steps || []).map((s, i) => ({
    i,
    beat: Math.max(0, Number(s.beat) || 0),
    caption: s.caption || null,
    set: s.set || null,
    ramp: Array.isArray(s.ramp) ? s.ramp.filter(r => r && PARAM_BY_ID[r.id]) : [],
    macro: Array.isArray(s.macro) ? s.macro.filter(m => m && m.index >= 0 && m.index < 4) : [],
    focus: s.focus || null,
  })).sort((a, b) => a.beat - b.beat || a.i - b.i);
  let n = 0;
  for (const s of steps) s.captionIndex = s.caption ? n++ : n - 1;
  let end = 0;
  for (const s of steps) {
    end = Math.max(end, s.beat);
    for (const r of s.ramp) end = Math.max(end, s.beat + (r.beats || 0));
    for (const m of s.macro) end = Math.max(end, s.beat + (m.beats || 0));
  }
  const phraseLen = (tour.phrase && tour.phrase.lengthBeats) || 8;
  // hold the last caption for at least one phrase pass (≥ 8 beats) before the "keep / revert" card
  const endBeat = Math.max(end + Math.min(16, Math.max(8, phraseLen)), tour.endBeat || 0);
  return { tour, steps, captionCount: n, endBeat, bpm: tour.bpm || (tour.phrase && tour.phrase.bpm) || 100 };
}

/** Values after every step ran to completion: { values (patch scope, native), macros:[4] }. */
export function finalState(tour, presets = []) {
  const sp = startPatch(tour, presets);
  const values = patchValues(sp.params);
  for (const s of compileTour(tour).steps) {
    if (s.set) for (const id in s.set) if (PARAM_BY_ID[id]) values[id] = s.set[id];
    for (const r of s.ramp) values[r.id] = r.to;
    for (const m of s.macro) values[MACRO_IDS[m.index]] = m.to;
  }
  return { values, macros: sp.macros };
}

/**
 * Timed control events for an offline render of the whole tour (tools, tests):
 * [{time, type:'params', values}] sampled at `rate` Hz along every ramp, matching what the UI player sends.
 */
export function tourControlEvents(tour, { rate = 30 } = {}) {
  const c = compileTour(tour);
  const spb = 60 / c.bpm;
  const cur = {};
  const out = [];
  const valOf = (id, sp) => (id in cur ? cur[id] : sp[id] !== undefined ? sp[id] : DEFAULTS[id]);
  const sp = (tour.start && tour.start.params) || {};
  // ramps expand into sampled points; apply in time order together with sets
  const timeline = [];
  for (const s of c.steps) {
    if (s.set) timeline.push({ beat: s.beat, kind: 'set', set: s.set });
    for (const r of s.ramp) timeline.push({ beat: s.beat, kind: 'ramp', id: r.id, to: r.to, beats: r.beats || 0 });
    for (const m of s.macro) timeline.push({ beat: s.beat, kind: 'ramp', id: MACRO_IDS[m.index], to: m.to, beats: m.beats || 0 });
  }
  timeline.sort((a, b) => a.beat - b.beat);
  const active = [];
  const lastBeat = c.endBeat;
  const dtBeats = (c.bpm / 60) / rate;
  let ti = 0;
  for (let b = 0; b <= lastBeat + 1e-9; b += dtBeats) {
    const values = {};
    while (ti < timeline.length && timeline[ti].beat <= b + 1e-9) {
      const e = timeline[ti++];
      if (e.kind === 'set') for (const id in e.set) { cur[id] = e.set[id]; values[id] = e.set[id]; }
      else {
        for (let k = active.length - 1; k >= 0; k--) if (active[k].id === e.id) active.splice(k, 1);
        active.push({ id: e.id, from: valOf(e.id, sp), to: e.to, b0: e.beat, beats: e.beats });
      }
    }
    for (let k = active.length - 1; k >= 0; k--) {
      const r = active[k];
      const t = r.beats > 0 ? ease((b - r.b0) / r.beats) : 1;
      const v = rampValue(r.id, r.from, r.to, t);
      cur[r.id] = v;
      values[r.id] = v;
      if (t >= 1) active.splice(k, 1);
    }
    if (Object.keys(values).length) out.push({ time: b * spb, type: 'params', values });
  }
  return out;
}
