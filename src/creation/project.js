// Shared portable contract for MCP, browser studio and offline rendering.
import { PARAMS, PARAM_BY_ID, DEFAULTS, SCALES } from '../dsp/params.js';
import { PRESETS, CATEGORIES } from '../presets/index.js';
export const VERSION = '1.0.0';
export const LIMITS = Object.freeze({ seconds: 180, sampleRate: 48000, tracks: 8, events: 8192, automation: 4096, jsonBytes: 1500000, outputBytes: 52000000 });
/** Studio browser render budget in seconds: 3 s of work per planned audio second, 60 s – 10 min (a fixed 60 s could not finish long multi-part jobs). */
export const browserRenderBudget = (project, options = {}) => Math.min(600, Math.max(60, Math.ceil(3 * (project.lengthBeats * 60 / project.globals['global.bpm'] + (options.tailSeconds ?? 2)))));
export const AXES = Object.freeze({
  motive: { zh: '動機與發展', description: 'Intervals, durations, repetition, transposition, inversion, augmentation and fragmentation.', defaults: { intervals: [0, 0, 0, -2], durations: [0.5, 0.5, 0.5, 1.5], development: 'repeat', transpose: 2 } },
  rhythm: { zh: '節奏與張力', description: 'Tempo, density, rests, syncopation and accent strength.', defaults: { bpm: 110, bars: 4, density: 0.8, rest: 0.1, swing: 0.12, tension: 0.6 } },
  harmony: { zh: '和聲與音高', description: 'Key, scale, register, progression; atonal mode for sound effects.', defaults: { root: 0, scale: 'minor', octave: 4, progression: [0, 5, 3, 4], atonal: false } },
  expression: { zh: '力度與表情', description: 'Velocity envelope, articulation and seeded humanisation, independent of master gain.', defaults: { start: 0.45, end: 0.85, articulation: 0.7, humanize: 0.04 } },
  timbre: { zh: '音色與空間', description: 'Preset, brightness, attack, release, stereo spread and reverb.', defaults: { preset: 'Aurora Pad', brightness: 0.55, attack: 0.02, release: 0.5, space: 0.35, width: 0.5 } },
});
export const copy = x => JSON.parse(JSON.stringify(x));
export class CreationError extends Error { constructor(code, message) { super(message); this.code = code; } }
export function fail(code, message) { throw new CreationError(code, message); }
export function bounded(x, lo, hi, path, integer = false) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi || (integer && !Number.isInteger(x))) fail('INVALID_ARGUMENT', path + ': expected ' + (integer ? 'integer ' : 'number ') + lo + '..' + hi);
  return x;
}
export function object(x, path) { if (!x || typeof x !== 'object' || Array.isArray(x)) fail('INVALID_ARGUMENT', path + ': expected object'); return x; }
export function keys(x, allowed, path) { object(x, path); for (const k of Object.keys(x)) if (!allowed.includes(k)) fail('INVALID_ARGUMENT', path + '.' + k + ': unknown field'); }
export function text(x, path, max = 100) { if (typeof x !== 'string' || !x.trim() || x.length > max) fail('INVALID_ARGUMENT', path + ': expected nonempty string, max ' + max); return x; }
export function choice(x, list, path) { if (!list.includes(x)) fail('INVALID_ARGUMENT', path + ': choose ' + list.join(', ')); return x; }
export function bool(x, path) { if (typeof x !== 'boolean') fail('INVALID_ARGUMENT', path + ': expected boolean'); }
function numbers(x, lo, hi, path, max = 32, integer = false) { if (!Array.isArray(x) || !x.length || x.length > max) fail('INVALID_ARGUMENT', path + ': expected 1..' + max + ' values'); x.forEach((v, i) => bounded(v, lo, hi, path + '[' + i + ']', integer)); }
export function validateParams(params = {}, scope = 'all') {
  object(params, 'params');
  for (const [id, v] of Object.entries(params)) {
    const p = PARAM_BY_ID[id];
    if (!p || (scope === 'patch' && p.scope === 'global') || (scope === 'global' && p.scope !== 'global')) fail('INVALID_PARAMETER', 'Parameter ' + id + ' is not in ' + scope + ' scope');
    if (p.type === 'enum') choice(v, p.options, id);
    else if (p.type === 'bool') bool(v, id);
    else bounded(v, p.min, p.max, id, p.type === 'int');
  }
  return params;
}
export function validatePatch(p) {
  keys(p, ['name', 'category', 'params', 'macros'], 'patch');
  if (p.name !== undefined) text(p.name, 'patch.name');
  if (p.category !== undefined && p.category !== null) text(p.category, 'patch.category');
  validateParams(p.params, 'patch');
  if (!Array.isArray(p.macros) || p.macros.length > 4) fail('INVALID_ARGUMENT', 'patch.macros: expected 0..4');
  p.macros.forEach((m, i) => {
    keys(m, ['name', 'targets'], 'macro' + i); text(m.name, 'macro.name');
    if (!Array.isArray(m.targets) || m.targets.length > 64) fail('INVALID_ARGUMENT', 'macro.targets: maximum 64');
    m.targets.forEach(t => { keys(t, ['id', 'amount'], 'target'); const s = PARAM_BY_ID[t.id]; if (!s || s.group === 'macro' || !['float', 'int'].includes(s.type)) fail('INVALID_PARAMETER', 'Invalid macro target ' + t.id); bounded(t.amount, -1, 1, 'target.amount'); });
  });
  if(p.macros.reduce((n,m)=>n+m.targets.length,0)>64)fail('INVALID_ARGUMENT','macros: engine supports 64 total targets');
  return p;
}
export function patchFromPreset(name) {
  const p = PRESETS.find(p => p.name.toLowerCase() === String(name).toLowerCase());
  if (!p) fail('NOT_FOUND', 'Unknown preset ' + name);
  return copy({ name: p.name, category: p.category, params: Object.fromEntries(Object.entries(p.params || {}).filter(([id]) => PARAM_BY_ID[id]?.scope !== 'global')), macros: p.macros || [] });
}
export function axesWithDefaults(input = {}) {
  keys(input, Object.keys(AXES), 'axes'); const out = {};
  for (const [id, axis] of Object.entries(AXES)) { keys(input[id] || {}, Object.keys(axis.defaults), 'axes.' + id); out[id] = { ...copy(axis.defaults), ...input[id] }; }
  const { motive: m, rhythm: r, harmony: h, expression: e, timbre: t } = out;
  numbers(m.intervals, -24, 24, 'motive.intervals', 32, true); numbers(m.durations, 0.0625, 8, 'motive.durations');
  if (m.intervals.length !== m.durations.length) fail('INVALID_ARGUMENT', 'Motif intervals and durations must have equal length');
  choice(m.development, ['repeat', 'transpose', 'invert', 'augment', 'fragment'], 'motive.development'); bounded(m.transpose, -12, 12, 'motive.transpose', true);
  bounded(r.bpm, 40, 240, 'rhythm.bpm'); bounded(r.bars, 1, 16, 'rhythm.bars', true);
  for (const k of ['density', 'rest', 'tension']) bounded(r[k], 0, 1, 'rhythm.' + k); bounded(r.swing, 0, 0.6, 'rhythm.swing');
  bounded(h.root, 0, 11, 'harmony.root', true); choice(h.scale, Object.keys(SCALES).filter(k => k !== 'off'), 'harmony.scale'); bounded(h.octave, 1, 7, 'harmony.octave', true); numbers(h.progression, 0, 6, 'harmony.progression', 16, true); bool(h.atonal, 'harmony.atonal');
  for (const k of ['start', 'end', 'humanize']) bounded(e[k], 0, 1, 'expression.' + k); bounded(e.articulation, 0.05, 1, 'expression.articulation');
  text(t.preset, 'timbre.preset'); for (const k of ['brightness', 'space', 'width']) bounded(t[k], 0, 1, 'timbre.' + k); bounded(t.attack, 0.001, 5, 'timbre.attack'); bounded(t.release, 0.01, 8, 'timbre.release');
  return out;
}
export function validateEvent(e, beats) {
  const on = e.type === 'on';
  keys(e, on ? ['beat', 'type', 'note', 'vel', 'dur'] : ['beat', 'type', 'id', 'value', 'index', 'kind', 'values', 'to', 'beats'], 'event');
  bounded(e.beat, 0, beats, 'event.beat'); choice(e.type, ['on', 'param', 'params', 'macro', 'ctrl', 'ramp', 'ramp-macro'], 'event.type');
  if (on) { bounded(e.note, 0, 127, 'event.note', true); bounded(e.vel, 0.01, 1, 'event.vel'); bounded(e.dur, 0.001, beats, 'event.dur'); if (e.beat + e.dur > beats + 1e-6) fail('INVALID_ARGUMENT', 'Note exceeds project length'); }
  if (e.type === 'param') validateParams({ [e.id]: e.value }, 'patch');
  if (e.type === 'params') validateParams(e.values, 'patch');
  if (e.type === 'macro') { bounded(e.index, 0, 3, 'event.index', true); bounded(e.value, 0, 1, 'event.value'); }
  if (e.type === 'ramp' || e.type === 'ramp-macro') {
    bounded(e.beats, 0, beats, 'event.beats'); if (e.beat + e.beats > beats + 1e-6) fail('INVALID_ARGUMENT', 'Ramp exceeds project length');
    if (e.type === 'ramp-macro') { bounded(e.index, 0, 3, 'event.index', true); bounded(e.to, 0, 1, 'event.to'); }
    else { const p = PARAM_BY_ID[e.id]; if (!p || p.scope === 'global' || !['float', 'int'].includes(p.type)) fail('INVALID_PARAMETER', 'Invalid ramp parameter'); bounded(e.to, p.min, p.max, 'event.to'); }
  }
  if (e.type === 'ctrl') { choice(e.kind, ['wheel', 'aftertouch', 'bend'], 'event.kind'); bounded(e.value, e.kind === 'bend' ? -1 : 0, 1, 'event.value'); }
}
export function validateProject(p) {
  keys(p, ['version', 'title', 'kind', 'seed', 'axes', 'globals', 'lengthBeats', 'tracks', 'revision', 'provenance'], 'project');
  if (p.version !== VERSION) fail('VERSION_MISMATCH', 'Expected project version ' + VERSION);
  text(p.title, 'title'); choice(p.kind, ['music', 'sound', 'sfx'], 'kind'); bounded(p.seed, 1, 4294967295, 'seed', true); bounded(p.revision, 0, 1000000, 'revision', true);
  axesWithDefaults(p.axes);
  for (const [axis, spec] of Object.entries(AXES)) { if (!p.axes[axis]) fail('INVALID_ARGUMENT', 'Project requires complete axes'); for (const key of Object.keys(spec.defaults)) if (p.axes[axis][key] === undefined) fail('INVALID_ARGUMENT', 'Missing axis field ' + axis + '.' + key); }
  validateParams(p.globals, 'global');
  const bpm = p.globals['global.bpm']; bounded(bpm, 40, 240, 'global.bpm'); bounded(p.lengthBeats, 0.05, 720, 'lengthBeats');
  if (p.lengthBeats * 60 / bpm > LIMITS.seconds) fail('RESOURCE_LIMIT', 'Content exceeds 180s; shorten bars or lengthBeats');
  if (!Array.isArray(p.tracks) || !p.tracks.length || p.tracks.length > LIMITS.tracks) fail('RESOURCE_LIMIT', 'Expected 1..8 tracks');
  let events = 0, automation = 0;
  p.tracks.forEach(t => {
    keys(t, ['name', 'role', 'patch', 'gain', 'pan', 'mute', 'events'], 'track'); text(t.name, 'track.name'); text(t.role, 'track.role'); validatePatch(t.patch); bounded(t.gain, -60, 6, 'gain'); bounded(t.pan, -1, 1, 'pan'); bool(t.mute, 'mute');
    if (!Array.isArray(t.events)) fail('INVALID_ARGUMENT', 'track.events must be array');
    events += t.events.length; if (events > LIMITS.events) fail('RESOURCE_LIMIT', 'Maximum 8192 events');
    for (const e of t.events) { validateEvent(e, p.lengthBeats); if (e.type !== 'on') automation++; }
  });
  if (automation > LIMITS.automation) fail('RESOURCE_LIMIT', 'Maximum 4096 automation events');
  if (new TextEncoder().encode(JSON.stringify(p)).length > LIMITS.jsonBytes) fail('RESOURCE_LIMIT', 'Project JSON exceeds byte limit');
  return p;
}
export function createProject({ title = 'Untitled Aurora', kind = 'music', seed = 42, axes = {}, patch } = {}) {
  const a = axesWithDefaults(axes), r = a.rhythm, t = a.timbre;
  const source = patch ? validatePatch(copy(patch)) : patchFromPreset(t.preset);
  if (!patch) source.params = { ...source.params, 'filter.cutoff': 120 * (16000 / 120) ** t.brightness, 'aenv.a': t.attack, 'aenv.r': t.release, 'voice.spread': t.width, 'reverb.on': t.space > 0, 'reverb.mix': t.space * 0.5 };
  return validateProject({ version: VERSION, title, kind, seed, axes: a, globals: { 'global.bpm': r.bpm, 'master.volume': -6, 'scale.root': a.harmony.root, 'scale.type': 'off' }, lengthBeats: r.bars * 4, tracks: [{ name: source.name || 'Main', role: kind === 'music' ? 'lead' : 'fx', patch: source, gain: 0, pan: 0, mute: false, events: [] }], revision: 0, provenance: { engine: 'aurora-synth', source: 'pixbvr/aurora-synth@aa204456' } });
}
export function edited(project, fn, expectedRevision) {
  validateProject(project); if (expectedRevision !== undefined && expectedRevision !== project.revision) fail('REVISION_CONFLICT', 'Expected ' + expectedRevision + ', current ' + project.revision);
  const p = copy(project); fn(p); p.revision++; return validateProject(p);
}
export function track(p, i = 0) { bounded(i, 0, p.tracks.length - 1, 'track', true); return p.tracks[i]; }
export function setParameters(project, values, index = 0, expectedRevision) {
  validateParams(values); return edited(project, p => { const t = track(p, index); for (const [id, v] of Object.entries(values)) (PARAM_BY_ID[id].scope === 'global' ? p.globals : t.patch.params)[id] = v; }, expectedRevision);
}
export function setTrack(project, index, changes, expectedRevision) { keys(changes, ['name', 'role', 'patch', 'gain', 'pan', 'mute', 'events'], 'changes'); return edited(project, p => Object.assign(track(p, index), copy(changes)), expectedRevision); }
export function addTrack(project, value) { return edited(project, p => p.tracks.push(copy(value))); }
export function parameterSchema() { return PARAMS.map(p => ({ ...p })); }
export function presetCatalog() { return { presets: PRESETS.map(p => ({ name: p.name, category: p.category, description: p.description })), categories: CATEGORIES }; }
