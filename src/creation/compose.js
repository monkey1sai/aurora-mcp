import { SCALES, DEFAULTS, PARAM_BY_ID, toNorm, fromNorm } from '../dsp/params.js';
import { PRESETS } from '../presets/index.js';
import { makeRng, generateJam, suggestBacking, roleForPreset, checkJam, STYLE_IDS, JAM_SCALE_IDS } from '../demo/generator.js';
import { MOODS, applyMoods, parseMoodText } from '../demo/moods.js';
import { SONGS } from '../demo/songs/index.js';
import { resolveSong } from '../demo/resolve.js';
import { TOURS, startPatch, finalState, tourControlEvents, compileTour } from '../demo/tours/index.js';
import { PHRASES, DEMO_FOR_CATEGORY } from '../../tools/phrases.mjs';
import { planMacroRides, withMacroRides } from '../ui/demo/automation.js';
import { driftNoise, reflect, evolveTargets } from '../demo/drift.js';
import { randomPatch, mutate, makeRng as patchRng } from '../ui/app/patchTools.js';
import { morphPatch, presetValues } from '../demo/morph.js';
import { AXES, copy, bounded, choice, fail, validateProject, createProject, edited, track, axesWithDefaults, patchFromPreset, presetCatalog } from './project.js';

export function compose(project) {
  return edited(project, p => {
    const { motive: m, rhythm: r, harmony: h, expression: e } = p.axes, rng = makeRng(p.seed), scale = SCALES[h.scale];
    const root = (h.octave + 1) * 12 + h.root, length = p.lengthBeats;
    const quantize = n => {
      n = Math.max(0, Math.min(127, Math.round(n))); if (h.atonal) return n;
      let best = n, dist = 100;
      for (let k = 0; k < 128; k++) if (scale.includes(((k - h.root) % 12 + 12) % 12) && Math.abs(k - n) < dist) { dist = Math.abs(k - n); best = k; }
      return best;
    };
    const events = []; let beat = 0, cycle = 0;
    while (beat < length - 0.001) {
      const count = m.development === 'fragment' && cycle % 2 ? Math.max(1, Math.ceil(m.intervals.length / 2)) : m.intervals.length;
      for (let i = 0; i < count && beat < length - 0.001; i++) {
        const factor = m.development === 'augment' && cycle % 2 ? 2 : 1;
        const step = m.durations[i] * factor / Math.max(0.25, r.density * 1.5);
        const start = Math.min(length - 0.001, beat + (i % 2 ? r.swing * Math.min(0.5, step) : 0));
        const interval = m.development === 'invert' && cycle % 2 ? -m.intervals[i] : m.intervals[i];
        const trans = m.development === 'transpose' ? cycle % 4 * m.transpose : 0;
        const degree = h.progression[Math.floor(beat / 4) % h.progression.length], chordRoot = scale[degree % scale.length];
        const v = e.start + (e.end - e.start) * beat / length + (i === 0 ? r.tension * 0.12 : 0) + rng.tri() * e.humanize;
        if (rng.next() >= r.rest) events.push({ beat: start, type: 'on', note: quantize(root + chordRoot + interval + trans), vel: Math.max(0.01, Math.min(1, v)), dur: Math.max(0.001, Math.min(length - start, step * e.articulation)) });
        beat += step;
      }
      cycle++;
    }
    track(p).events = events;
  });
}
export const SFX_TYPES = ['impact', 'whoosh', 'riser', 'downer', 'ambience', 'ui', 'alarm', 'footstep', 'laser'];
export function designSfx({ type = 'impact', seconds = 2, seed = 42, axes = {}, title = type } = {}) {
  choice(type, SFX_TYPES, 'sfx.type'); bounded(seconds, 0.1, 30, 'sfx.seconds');
  const a = axesWithDefaults({ ...axes, harmony: { ...axes.harmony, atonal: true } });
  const p = createProject({ title, kind: 'sfx', seed, axes: a }); p.lengthBeats = seconds * p.globals['global.bpm'] / 60;
  const tonal = ['ui', 'alarm', 'laser'].includes(type), ambience = type === 'ambience';
  p.tracks[0].patch = { name: type, category: 'fx', macros: [], params: {
    'osc1.on': tonal, 'osc1.mode': 'classic', 'osc1.shape': 0, 'osc1.level': 0.75, 'osc2.on': false, 'fm.on': false, 'phys.on': false,
    'noise.on': !tonal, 'noise.level': 0.8, 'noise.color': 0.3, 'filter.cutoff': 120 * (16000 / 120) ** a.timbre.brightness, 'filter.res': 0.1,
    'aenv.a': ['whoosh', 'riser', 'ambience'].includes(type) ? Math.min(5, seconds * 0.35) : 0.001, 'aenv.d': Math.min(5, seconds * 0.3), 'aenv.s': ambience ? 0.7 : 0.15, 'aenv.r': Math.min(8, seconds * 0.25),
    'reverb.on': a.timbre.space > 0, 'reverb.mix': a.timbre.space * 0.5, 'voice.spread': a.timbre.width,
  } };
  const spb = 60 / p.globals['global.bpm'];
  p.tracks[0].events = [{ beat: 0, type: 'on', note: tonal ? 72 : 36, vel: a.expression.end || 0.01, dur: p.lengthBeats * (ambience ? 0.95 : 0.6) }];
  if (['riser', 'downer', 'whoosh', 'laser'].includes(type)) for (let i = 0; i <= 48; i++) {
    const x = i / 48, up = type === 'riser' || type === 'whoosh';
    p.tracks[0].events.push({ beat: x * p.lengthBeats * 0.9, type: 'param', id: tonal ? 'voice.pitch' : 'filter.cutoff', value: tonal ? -24 * x : 120 + 13000 * (up ? x : 1 - x) ** 2 });
  }
  if (type === 'footstep' || type === 'alarm') {
    p.tracks[0].events = [];
    for (let s = 0; s < seconds - 0.001; s += type === 'footstep' ? 0.5 : 0.3) p.tracks[0].events.push({ beat: s / spb, type: 'on', note: type === 'alarm' ? (Math.round(s / 0.3) % 2 ? 79 : 72) : 36, vel: Math.max(0.01, a.expression.start + (a.expression.end - a.expression.start) * s / seconds), dur: Math.min(0.12 / spb, p.lengthBeats - s / spb) });
  }
  return validateProject(p);
}
export function moodProject(project, moods, amount = 0.6, index = 0) {
  const parsed = typeof moods === 'string' ? parseMoodText(moods) : moods;
  const list = Array.isArray(parsed) ? parsed : parsed?.moods;
  if (!Array.isArray(list) || !list.length || list.length > 8) fail('INVALID_ARGUMENT', 'No recognised moods; use catalog mood IDs');
  const entries = list.map(m => typeof m === 'string' ? { id: m, amount } : { ...m, amount: m.amount ?? amount });
  for (const m of entries) { choice(m.id, MOODS.map(x => x.id), 'mood'); bounded(m.amount, 0.05, 1, 'amount'); }
  return edited(project, p => { const t = track(p, index); Object.assign(t.patch.params, applyMoods({ ...DEFAULTS, ...t.patch.params }, entries, { category: t.patch.category })); });
}
export function morphProject(project, preset, position, index = 0) {
  bounded(position, 0, 1, 'position'); const b = typeof preset === 'object' && preset ? copy(preset) : patchFromPreset(preset);
  return edited(project, p => {
    const t = track(p, index), a = t.patch;
    const m = morphPatch({ values: presetValues(a), macros: a.macros }, { values: presetValues(b), macros: b.macros }, position);
    t.patch = { name: (a.name || 'Patch').slice(0, 90) + ' morph', category: a.category || 'fx', params: m.values, macros: m.macros };
  });
}
export function mutateProject(project, { amount = 0.06, seed = project.seed, random = false, index = 0 } = {}) {
  bounded(amount, 0, 1, 'amount'); bounded(seed, 1, 4294967295, 'seed', true);
  return edited(project, p => {
    const t = track(p, index), rng = patchRng(seed);
    if (random) { const g = randomPatch({ rng, category: t.patch.category }); t.patch = { name: 'Random patch', category: t.patch.category, params: Object.fromEntries(Object.entries(g.params || g).filter(([id]) => PARAM_BY_ID[id]?.scope !== 'global')), macros: g.macros || [] }; }
    else Object.assign(t.patch.params, mutate({ ...DEFAULTS, ...t.patch.params }, { amount, rng }));
  });
}
export function evolveProject(project, { index = 0, amount = 0.1, steps = 32 } = {}) {
  bounded(amount, 0, 0.5, 'amount'); bounded(steps, 2, 128, 'steps', true);
  return edited(project, p => {
    const t = track(p, index), rng = makeRng(p.seed);
    for (const id of ['filter.cutoff', 'filter.res', 'osc1.shape', 'reverb.mix']) {
      const param = PARAM_BY_ID[id], base = toNorm(param, t.patch.params[id] ?? param.def), phase = rng.next() * Math.PI * 2;
      for (let i = 0; i < steps; i++) t.events.push({ beat: p.lengthBeats * i / steps, type: 'param', id, value: fromNorm(param, Math.max(0, Math.min(1, base + Math.sin(phase + i / steps * Math.PI * 2) * amount))) });
    }
  });
}
export function fromSong(song, title, axes = {}, seed = 42) {
  const p = createProject({ title, axes, seed }); p.globals['global.bpm'] = song.bpm; p.lengthBeats = song.lengthBeats;
  p.tracks = song.parts.map(t => ({
    name: t.name, role: t.role || 'music',
    patch: { name: t.name, category: 'keys', params: Object.fromEntries(Object.entries(t.patch.params || {}).filter(([id]) => PARAM_BY_ID[id]?.scope !== 'global')), macros: t.patch.macros || [] },
    gain: t.gain ?? 0, pan: t.pan ?? 0, mute: false,
    events: t.events.filter(e => e.type !== 'on' || song.lengthBeats - e.beat >= 0.001).map(e => { const x = { ...e }; delete x.label; if (x.type === 'on') { x.dur = Math.min(x.dur, song.lengthBeats - x.beat); delete x.time; } return x; }),
  }));
  return validateProject(p);
}
const presetOrNull = (v, auto) => v === undefined ? auto : v === null || v === false ? null : PRESETS.find(p => p.name.toLowerCase() === String(v).toLowerCase()) || fail('NOT_FOUND', 'Unknown preset ' + v);
/** Website Jam panel options: variation (endless-mode pass), lead preset/role, drums, pad/bass/extra backing (preset name, or null to mute). */
export function jamSong({ style = 'ambient', seed = 42, axes = {}, title = 'Generated Jam', variation = 0, leadPreset, leadRole, drums = true, backing = {} } = {}) {
  choice(style, STYLE_IDS, 'style'); bounded(variation, 0, 9999, 'variation', true); const p = createProject({ title, seed, axes }); choice(p.axes.harmony.scale, JAM_SCALE_IDS, 'jam.scale');
  choice(p.axes.rhythm.bars, [4, 8, 16], 'jam.bars (website generator supports 4, 8, 16)');
  const leadPatch = leadPreset ? patchFromPreset(leadPreset) : p.tracks[0].patch, lead = { name: leadPatch.name, patch: leadPatch, role: leadRole || roleForPreset(leadPatch) }, s = suggestBacking(style, PRESETS, { lead });
  const extra = presetOrNull(backing.extra, s.extra);
  const song = generateJam({ style, seed, variation, key: p.axes.harmony.root, scale: p.axes.harmony.scale, bpm: p.axes.rhythm.bpm, bars: p.axes.rhythm.bars, intensity: p.axes.rhythm.tension, lead,
    backing: { drums, bass: presetOrNull(backing.bass, s.bass), pad: presetOrNull(backing.pad, s.pad), extra: extra ? { patch: extra, role: roleForPreset(extra) } : null } });
  return { song, project: fromSong(song, title, p.axes, seed) };
}
export function jamProject(options = {}) { return jamSong(options).project; }
export function jamReport(options = {}) {
  const { song, project } = jamSong(options), c = checkJam(song);
  return { project, check: { ok: c.ok, issues: c.issues.slice(0, 50), stats: c.stats }, parts: song.parts.map(t => ({ name: t.name, role: t.role })) };
}
/** Website auto-evolve: curated targets, two-octave drift noise and reflect bounds, sampled into replayable automation. */
export function evolveWebsiteProject(project, { index = 0, intensity = 0.55, speed = 0.4, groups = { macros: true, timbre: true, space: false }, steps = 64 } = {}) {
  bounded(intensity, 0, 1, 'intensity'); bounded(speed, 0, 1, 'speed'); bounded(steps, 2, 512, 'steps', true);
  return edited(project, p => {
    const t = track(p, index), values = { ...DEFAULTS, ...t.patch.params }, targets = evolveTargets(values, t.patch.macros, groups);
    if (!targets.length) fail('INVALID_ARGUMENT', 'Nothing to evolve: enable a group whose engine or effect is on');
    const seconds = p.lengthBeats * 60 / p.globals['global.bpm'], rate = 0.04 * 2 ** (speed * 4.4);
    for (const g of targets) {
      const param = PARAM_BY_ID[g.id], nb = toNorm(param, values[g.id]), macro = /^macro[1-4]$/.test(g.id);
      for (let i = 0; i < steps; i++) {
        const n = reflect(nb + driftNoise(seconds * i / steps * rate + (g.seed % 997) * 0.731, g.seed) * g.depth * intensity * 1.25, g.lo, g.hi), beat = p.lengthBeats * i / steps;
        t.events.push(macro ? { beat, type: 'macro', index: +g.id.slice(5) - 1, value: Math.max(0, Math.min(1, n)) } : { beat, type: 'param', id: g.id, value: fromNorm(param, n) });
      }
    }
  });
}
export function loadSong(id, excerptBeats) {
  const d = SONGS.find(s => s.id === id); if (!d) fail('NOT_FOUND', 'Unknown song ' + id);
  const song = resolveSong(d, PRESETS);
  if (excerptBeats !== undefined) {
    bounded(excerptBeats, 0.05, song.lengthBeats, 'excerptBeats'); song.lengthBeats = excerptBeats;
    song.parts.forEach(t => { t.events = t.events.filter(e => e.beat < excerptBeats).map(e => e.type === 'on' ? { ...e, dur: Math.min(e.dur, excerptBeats - e.beat) } : e.type === 'ramp-macro' || e.type === 'ramp' ? { ...e, beats: Math.min(e.beats, excerptBeats - e.beat) } : e); });
  }
  return fromSong(song, d.title);
}
export function loadTour(id, mode = 'final') {
  const t = TOURS.find(t => t.id === id); if (!t) fail('NOT_FOUND', 'Unknown tour ' + id); choice(mode, ['final', 'timeline'], 'mode');
  const p = createProject({ title: t.title, axes: { rhythm: { bpm: t.bpm || 100 } } });
  const patch = mode === 'final' ? finalState(t, PRESETS) : { values: startPatch(t, PRESETS).params, macros: startPatch(t, PRESETS).macros };
  p.tracks[0].patch = { name: t.title, category: t.start?.category || 'keys', params: patch.values, macros: patch.macros || [] };
  p.lengthBeats = mode === 'final' ? t.phrase.lengthBeats : compileTour(t).endBeat;
  const events = [];
  for (let b = 0; b < p.lengthBeats; b += t.phrase.lengthBeats) for (const e of t.phrase.events) if (b + e.beat < p.lengthBeats) events.push({ beat: b + e.beat, type: 'on', note: e.note, vel: e.vel ?? 0.8, dur: Math.min(e.dur, p.lengthBeats - b - e.beat) });
  if (mode === 'timeline') for (const e of tourControlEvents(t, { rate: 16 })) events.push({ beat: e.time * p.globals['global.bpm'] / 60, type: e.type, values: e.values });
  p.tracks[0].events = events; return validateProject(p);
}
/** Preset audition phrase; 'auto' picks the website ▶ demo phrase for the patch, macroRides adds its moving macro knobs. */
export function applyPhrase(project, phrase = 'auto', index = 0, { macroRides = false, demoMacros } = {}) {
  const t0 = track(project, index), factory = PRESETS.find(x => x.name === t0.patch.name);
  if (phrase === 'auto') phrase = factory?.demo && PHRASES[factory.demo] ? factory.demo : DEMO_FOR_CATEGORY[t0.patch.category] || 'keys';
  const def = PHRASES[phrase]; if (!def) fail('NOT_FOUND', 'Unknown phrase ' + phrase);
  return edited(project, p => {
    const t = track(p, index); p.lengthBeats = def.lengthBeats; p.globals['global.bpm'] = def.bpm; t.events = copy(def.events);
    if (macroRides) {
      const values = [1, 2, 3, 4].map(i => +(t.patch.params['macro' + i] ?? 0));
      const rides = planMacroRides({ lengthBeats: def.lengthBeats, demoMacros: demoMacros ?? factory?.demoMacros ?? null, macros: t.patch.macros, values });
      t.events = withMacroRides({ ...def, events: t.events, loop: false }, rides, values).events;
    }
  });
}
export function catalog() {
  return { axes: AXES, ...presetCatalog(), styles: STYLE_IDS, scales: Object.keys(SCALES), moods: MOODS.map(m => ({ id: m.id, zh: m.zh, en: m.en })),
    songs: SONGS.map(s => ({ id: s.id, title: s.title, bpm: s.bpm, seconds: s.lengthBeats * 60 / s.bpm })), tours: TOURS.map(t => ({ id: t.id, title: t.title })), phrases: Object.keys(PHRASES), sfx: SFX_TYPES };
}
