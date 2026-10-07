// Website preset-library, help and inspection features as pure functions (no DOM): shared by the MCP tools.
// User libraries and favourites stay client-owned values, matching the stateless public server.
import { PARAMS, PARAM_BY_ID, DEFAULTS, GROUPS, CHORDS, SCALES, formatValue } from '../dsp/params.js';
import { PRESETS, CATEGORIES } from '../presets/index.js';
import { parsePresetFile } from '../ui/app/patchTools.js';
import { diffFromDefaults, normalizeMacros } from '../ui/app/store.js';
import { sanitizeUserPresets, sanitizeFavourites } from '../ui/app/library.js';
import { paramHelp } from '../ui/app/paramHelp.js';
import { describeChanges, MOOD_EXAMPLES } from '../demo/moods.js';
import { STYLE_IDS, styleDefaults } from '../demo/generator.js';
import { SONGS } from '../demo/songs/index.js';
import { TOURS } from '../demo/tours/index.js';
import { PHRASE_LIST, DEMO_FOR_CATEGORY } from '../../tools/phrases.mjs';
import { copy, fail, bounded, choice, validatePatch, patchFromPreset } from './project.js';

const patchParams = params => Object.fromEntries(Object.entries(params || {}).filter(([id]) => PARAM_BY_ID[id] && PARAM_BY_ID[id].scope !== 'global'));
const entry = (p, source) => ({ name: p.name, category: p.category || 'fx', tags: p.tags || [], description: p.description || '', source, key: (source === 'user' ? 'u:' : 'f:') + p.name });

/** Same matching rule as the website preset browser: category chip, tag, and every query word in name/description/tags/category. */
export function searchPresets({ query = '', category = 'all', tag = '', library = null, limit = 100 } = {}) {
  bounded(limit, 1, 200, 'limit', true);
  const lib = libraryValue(library), favs = new Set(lib.favourites);
  const all = [...PRESETS.map(p => entry(p, 'factory')), ...lib.presets.map(p => entry(p, 'user'))];
  const chips = ['all', 'fav', 'user', ...CATEGORIES.map(c => c.id)];
  choice(category, chips, 'category');
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = p => {
    if (category === 'fav' && !favs.has(p.key)) return false;
    if (category === 'user' && p.source !== 'user') return false;
    if (!['all', 'fav', 'user'].includes(category) && p.category !== category) return false;
    if (tag && !p.tags.includes(tag)) return false;
    const c = CATEGORIES.find(x => x.id === p.category);
    const hay = `${p.name} ${p.description} ${p.tags.join(' ')} ${c ? `${c.zh} ${c.label}` : ''}`.toLowerCase();
    return words.every(q => hay.includes(q));
  };
  const found = all.filter(matches);
  const counts = Object.fromEntries(chips.map(id => [id, id === 'all' ? all.length : id === 'fav' ? all.filter(p => favs.has(p.key)).length : id === 'user' ? all.filter(p => p.source === 'user').length : all.filter(p => p.category === id).length]));
  const tags = [...new Set(found.flatMap(p => p.tags))].sort();
  return { total: found.length, presets: found.slice(0, limit).map(p => ({ ...p, favourite: favs.has(p.key) })), counts, tags };
}

/** Previous / next preset inside the current filter, wrapping like the website ◀ ▶ buttons. */
export function stepPreset({ name, direction = 1, category = 'all', query = '', tag = '', library = null }) {
  const list = searchPresets({ query, category, tag, library, limit: 200 }).presets;
  if (!list.length) fail('NOT_FOUND', 'No preset matches the filter');
  const i = list.findIndex(p => p.name.toLowerCase() === String(name).toLowerCase());
  const next = list[((i < 0 ? (direction > 0 ? -1 : 0) : i) + (direction > 0 ? 1 : -1) + list.length) % list.length];
  return { preset: next, position: list.indexOf(next) + 1, of: list.length };
}

/** Preset JSON from the website exporter (format 'aurora-preset' v1) for a patch plus metadata. */
export function exportPreset(patch, { tags, description, demo } = {}) {
  validatePatch(patch);
  const factory = PRESETS.find(p => p.name === patch.name);
  return { format: 'aurora-preset', version: 1, name: patch.name || 'Patch', category: patch.category || 'fx', tags: tags ?? factory?.tags ?? [], description: description ?? factory?.description ?? '',
    params: diffFromDefaults({ ...DEFAULTS, ...patchParams(patch.params) }), macros: normalizeMacros(patch.macros), demo: demo ?? factory?.demo ?? null };
}

/** Validate and sanitise preset JSON exactly like the website importer; returns project-ready patches. */
export function importPresets(data) {
  const { presets, warnings } = parsePresetFile(data);
  if (!presets.length) fail('INVALID_ARGUMENT', 'No preset with params found' + (warnings.length ? ': ' + warnings.slice(0, 5).join('; ') : ''));
  return { presets: presets.map(p => ({ preset: p, patch: toPatch(p) })), warnings };
}
export function toPatch(p) {
  const out = { name: String(p.name || 'Imported').slice(0, 100), category: typeof p.category === 'string' ? p.category : 'fx', params: patchParams(p.params), macros: normalizeMacros(p.macros).filter(m => m.targets.length || m.name) };
  validatePatch(out); return out;
}

/** Client-owned user library ({presets, favourites}) with the website's sanitising and name de-duplication. */
export function libraryValue(library) {
  if (library == null) return { presets: [], favourites: [] };
  if (typeof library !== 'object' || Array.isArray(library)) fail('INVALID_ARGUMENT', 'library: expected {presets, favourites}');
  return { presets: sanitizeUserPresets(library.presets ?? []), favourites: sanitizeFavourites(library.favourites ?? []) };
}
export function manageLibrary({ library, action, preset, patch, name, key, overwrite = false }) {
  const lib = copy(libraryValue(library));
  choice(action, ['list', 'save', 'delete', 'toggle_favourite'], 'action');
  if (action === 'save') {
    const src = preset ? importPresets(preset).presets[0].preset : patch ? exportPreset(patch) : fail('INVALID_ARGUMENT', 'save needs preset or patch');
    let nm = String(name || src.name || 'My preset').trim().slice(0, 60) || 'My preset';
    if (!overwrite) { const base = nm; let k = 2; while (lib.presets.some(p => p.name === nm)) nm = `${base} (${k++})`; }
    const stored = { name: nm, category: src.category, tags: src.tags || [], description: src.description || '', params: src.params, macros: src.macros, demo: src.demo ?? null };
    lib.presets = [...lib.presets.filter(p => p.name !== nm), stored];
    if (lib.presets.length > 500) fail('LIBRARY_LIMIT', 'A client library holds at most 500 user presets');
    return { library: lib, saved: { ...stored, key: 'u:' + nm } };
  }
  if (action === 'delete') {
    const nm = key ? String(key).replace(/^u:/, '') : name;
    if (!lib.presets.some(p => p.name === nm)) fail('NOT_FOUND', 'Unknown user preset ' + nm);
    lib.presets = lib.presets.filter(p => p.name !== nm); lib.favourites = lib.favourites.filter(k => k !== 'u:' + nm);
    return { library: lib, deleted: 'u:' + nm };
  }
  if (action === 'toggle_favourite') {
    const k = key || (name && (lib.presets.some(p => p.name === name) ? 'u:' : 'f:') + name);
    if (!k || !(PRESETS.some(p => 'f:' + p.name === k) || lib.presets.some(p => 'u:' + p.name === k))) fail('NOT_FOUND', 'Unknown preset key ' + k);
    const on = !lib.favourites.includes(k); lib.favourites = on ? [...lib.favourites, k] : lib.favourites.filter(x => x !== k);
    return { library: lib, key: k, favourite: on };
  }
  return { library: lib, presets: lib.presets.map(p => ({ ...entry(p, 'user'), favourite: lib.favourites.includes('u:' + p.name) })) };
}
/** A user-library preset as an editable patch. */
export function userPatch(library, name) {
  const p = libraryValue(library).presets.find(p => p.name === name);
  if (!p) fail('NOT_FOUND', 'Unknown user preset ' + name);
  return toPatch(p);
}

/** Labels, units, ranges, bilingual help and formatted values for parameters (editor tooltips). */
export function parameterHelp({ ids, group, values = {} } = {}) {
  let list = PARAMS;
  if (group) { choice(group, Object.keys(GROUPS), 'group'); list = list.filter(p => p.group === group || p.id.startsWith(group + '.')); }
  if (ids) { for (const id of ids) if (!PARAM_BY_ID[id]) fail('INVALID_ARGUMENT', 'Unknown parameter ' + id); list = ids.map(id => PARAM_BY_ID[id]); }
  return { groups: GROUPS, parameters: list.map(p => {
    const h = paramHelp(p.id), v = values[p.id] ?? p.def;
    return { id: p.id, label: p.label, zh: p.zh, group: p.group, groupLabel: GROUPS[p.group] || null, type: p.type, unit: p.unit, min: p.min, max: p.max, options: p.options, default: p.def,
      help: h ? { zh: h[0], en: h[1] } : null, value: v, formatted: formatValue(p, v) };
  }) };
}

/** A/B comparison of two patches: changed params with formatted values plus the website's ranked change summary. */
export function comparePatches(a, b) {
  validatePatch(a); validatePatch(b);
  const va = { ...DEFAULTS, ...patchParams(a.params) }, vb = { ...DEFAULTS, ...patchParams(b.params) }, changes = {};
  for (const p of PARAMS) if (p.scope !== 'global' && va[p.id] !== vb[p.id] && !(typeof va[p.id] === 'number' && Math.abs(va[p.id] - vb[p.id]) < 1e-9)) changes[p.id] = vb[p.id];
  const differences = Object.keys(changes).map(id => ({ id, label: PARAM_BY_ID[id].label, zh: PARAM_BY_ID[id].zh, group: PARAM_BY_ID[id].group, a: va[id], b: vb[id], aText: formatValue(id, va[id]), bText: formatValue(id, vb[id]) }));
  const summary = describeChanges(va, changes).map(({ id, zh, en, dir, kind }) => ({ id, zh, en, dir, kind }));
  const macros = [0, 1, 2, 3].map(i => ({ index: i, a: a.macros[i]?.name ?? null, b: b.macros[i]?.name ?? null, same: JSON.stringify(a.macros[i] ?? null) === JSON.stringify(b.macros[i] ?? null) }));
  return { a: a.name, b: b.name, changed: differences.length, differences, summary, macros };
}
export const describePatchChanges = (values, changes) => describeChanges({ ...DEFAULTS, ...values }, changes).map(({ id, zh, en, dir, kind }) => ({ id, zh, en, dir, kind }));

/** Demo-song structure: sections with seconds, parts with presets and roles. */
export function songInfo(id) {
  const s = SONGS.find(s => s.id === id); if (!s) fail('NOT_FOUND', 'Unknown song ' + id);
  const spb = 60 / s.bpm;
  return { id: s.id, title: s.title, zh: s.zh, description: s.description, bpm: s.bpm, lengthBeats: s.lengthBeats, seconds: s.lengthBeats * spb, key: s.key, scale: s.scale,
    sections: (s.sections || []).map((x, i, all) => ({ name: x.name, zh: x.zh, beat: x.beat, beats: (all[i + 1]?.beat ?? s.lengthBeats) - x.beat, second: x.beat * spb })),
    parts: (s.parts || []).map(p => ({ name: p.name, preset: p.preset, role: p.role, gain: p.gain ?? 0, pan: p.pan ?? 0 })) };
}
/** Sound-tour lesson: captions, focused controls and changes per step. */
export function tourInfo(id) {
  const t = TOURS.find(t => t.id === id); if (!t) fail('NOT_FOUND', 'Unknown tour ' + id);
  const spb = 60 / (t.bpm || 100);
  return { id: t.id, title: t.title, zh: t.zh, description: t.description, bpm: t.bpm, start: copy(t.start || {}),
    steps: [...t.steps].sort((x, y) => x.beat - y.beat).map(s => ({ beat: s.beat, second: s.beat * spb, caption: s.caption || null, focus: s.focus || null, set: s.set || {}, ramp: s.ramp || [], macro: s.macro || [] })) };
}
/** Catalog extras for website pickers that the original catalog lists only by id. */
export function catalogDetails() {
  return { presetTags: Object.fromEntries(PRESETS.map(p => [p.name, p.tags || []])), phrases: PHRASE_LIST, demoForCategory: DEMO_FOR_CATEGORY, moodExamples: MOOD_EXAMPLES,
    chords: Object.keys(CHORDS), scales: Object.fromEntries(Object.entries(SCALES).map(([k, v]) => [k, v ? v.slice() : null])), styleDefaults: Object.fromEntries(STYLE_IDS.map(s => [s, styleDefaults(s)])) };
}
export { patchFromPreset };
