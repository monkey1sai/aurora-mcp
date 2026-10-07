import { SCALES, DEFAULTS, PARAM_BY_ID, toNorm, fromNorm } from '../dsp/params.js';
import { PRESETS } from '../presets/index.js';
import { makeRng, generateJam, suggestBacking, roleForPreset, checkJam, STYLE_IDS, JAM_SCALE_IDS } from '../demo/generator.js';
import { MOODS, applyMoods, parseMoodText } from '../demo/moods.js';
import { SONGS } from '../demo/songs/index.js';
import { resolveSong } from '../demo/resolve.js';
import { TOURS, startPatch, finalState, tourControlEvents, compileTour } from '../demo/tours/index.js';
import { PHRASES, DEMO_FOR_CATEGORY, getPhrase } from '../../tools/phrases.mjs';
import { planMacroRides, withMacroRides, presetDemoSong } from '../ui/demo/automation.js';
import { driftNoise, reflect, evolveTargets } from '../demo/drift.js';
import { randomPatch, mutate, makeRng as patchRng } from '../ui/app/patchTools.js';
import { morphPatch, presetValues, effectiveValues } from '../demo/morph.js';
import { PATCH_IDS, STRUCTURAL, blendValues, structuralChange, sanitizeValue, diffFromDefaults } from '../ui/app/store.js';
import { songDuration } from '../demo/resolve.js';
import { CATEGORIES } from '../presets/index.js';
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
export const RANDOM_CATEGORIES = ['pad', 'lead', 'bass', 'pluck', 'keys', 'bell', 'strings', 'arp', 'fx'];
/** category: 'track' keeps the track's category (original behaviour); 'any' lets the generator pick like the website with no browser filter; or a recipe id. */
export function mutateProject(project, { amount = 0.06, seed = project.seed, random = false, index = 0, category = 'track' } = {}) {
  bounded(amount, 0, 1, 'amount'); bounded(seed, 1, 4294967295, 'seed', true); choice(category, ['track', 'any', ...RANDOM_CATEGORIES], 'category');
  return edited(project, p => {
    const t = track(p, index), rng = patchRng(seed);
    if (random) {
      const g = randomPatch({ rng, category: category === 'track' ? t.patch.category : category === 'any' ? undefined : category });
      t.patch = { name: category === 'track' ? 'Random patch' : String(g.name || 'Random patch').slice(0, 100), category: category === 'track' ? t.patch.category : g.category, params: Object.fromEntries(Object.entries(g.params || g).filter(([id]) => PARAM_BY_ID[id]?.scope !== 'global')), macros: g.macros || [] };
    }
    else Object.assign(t.patch.params, mutate({ ...DEFAULTS, ...t.patch.params }, { amount, rng }));
  });
}
/** Website 🎲 random B: any factory preset except A (and the current B), seeded instead of Math.random. */
export function randomPreset(seed, exclude = []) {
  bounded(seed, 1, 4294967295, 'seed', true);
  const skip = new Set(exclude.filter(Boolean).map(n => String(n).toLowerCase())), pool = PRESETS.filter(p => !skip.has(p.name.toLowerCase()));
  return pool[Math.floor(patchRng(seed).next() * pool.length) % pool.length].name;
}
const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
const r6 = v => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v;
/**
 * Website auto-morph sweep as replayable automation: t = ½ − ½·cos(2π·phase) over `period` seconds, the effective
 * (macro-baked) A/B blend written as 'params' events, and the website's engine duck (level → 0, switch, level back,
 * ≈35 ms apart) around osc mode/table and physical model/exciter switches.
 */
export function autoMorphProject(project, b, { index = 0, period = 12, startBeat = 0, endBeat, steps = 24, start = 0 } = {}) {
  bounded(period, 3, 40, 'period'); bounded(steps, 4, 128, 'steps', true); bounded(start, 0, 1, 'start');
  return edited(project, p => {
    const t = track(p, index), spb = 60 / p.globals['global.bpm'], end = endBeat ?? p.lengthBeats;
    bounded(startBeat, 0, p.lengthBeats, 'startBeat'); bounded(end, startBeat, p.lengthBeats, 'endBeat');
    const aEff = effectiveValues(presetValues(t.patch), t.patch.macros), bEff = effectiveValues(presetValues(b), b.macros);
    const seconds = (end - startBeat) * spb, n = Math.max(1, Math.round(seconds / period * steps)), stepBeats = (end - startBeat) / n;
    const phase0 = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * start))) / (Math.PI * 2), duck = Math.min(0.035 / spb, stepBeats / 3);
    const audible = (g, v) => v[`${g}.on`] && v[`${g}.level`] > 0.001, events = [];
    let prev = presetValues(t.patch);
    for (let i = 0; i <= n; i++) {
      const beat = Math.min(end, startBeat + stepBeats * i), x = 0.5 - 0.5 * Math.cos((phase0 + (beat - startBeat) * spb / period) * Math.PI * 2);
      const out = blendValues(aEff, bEff, x, PATCH_IDS, { dip: false }), changed = {};
      for (const id of PATCH_IDS) if (!same(out[id], prev[id])) changed[id] = r6(out[id]);
      if (!Object.keys(changed).length) continue;
      const switching = Object.keys(STRUCTURAL).filter(g => (audible(g, prev) || audible(g, out)) && structuralChange(g, prev, out));
      // duck ends exactly on the sample beat, so the sample (and a freeze there) holds the plain blend
      if (switching.length && beat - 2 * duck >= 0) {
        events.push({ beat: r6(beat - 2 * duck), type: 'params', values: Object.fromEntries(switching.map(g => [`${g}.level`, 0])) });
        events.push({ beat: r6(beat - duck), type: 'params', values: { ...changed, ...Object.fromEntries(switching.map(g => [`${g}.level`, 0])) } });
        events.push({ beat: r6(beat), type: 'params', values: Object.fromEntries(switching.map(g => [`${g}.level`, r6(out[`${g}.level`])])) });
      } else events.push({ beat: r6(beat), type: 'params', values: changed });
      prev = out;
    }
    t.events = [...t.events, ...events].sort((x, y) => x.beat - y.beat);
  });
}
/**
 * Website ❄ Freeze / Keep: bake what the engine would hold at `beat` (param, params, macro, ramp and ramp-macro with
 * the sequencer's rules: a write cancels that parameter's ramp, a new ramp replaces it from the current value) into
 * the track patch; `clear` removes the automation so the sound stays put, like stopping the evolution.
 */
export function freezeProject(project, { index = 0, beat, clear = true } = {}) {
  return edited(project, p => {
    const t = track(p, index); bounded(beat, 0, p.lengthBeats, 'beat');
    const values = presetValues(t.patch), ramps = new Map(), isRamp = e => e.type === 'ramp' || e.type === 'ramp-macro';
    const at = (id, x) => { const r = ramps.get(id); if (!r) return values[id]; const k = r.len > 0 ? Math.max(0, Math.min(1, (x - r.start) / r.len)) : 1; return sanitizeValue(PARAM_BY_ID[id], fromNorm(PARAM_BY_ID[id], r.from + (r.to - r.from) * k)); };
    const cancel = (id, x) => { if (ramps.has(id)) { values[id] = at(id, x); ramps.delete(id); } };
    const write = (id, v, x) => { const prm = PARAM_BY_ID[id]; if (!prm || prm.scope === 'global') return; cancel(id, x); values[id] = sanitizeValue(prm, v); };
    const list = t.events.map((e, k) => ({ e, k })).filter(({ e }) => e.type !== 'on' && e.type !== 'ctrl' && e.beat <= beat)
      .sort((a, b) => a.e.beat - b.e.beat || isRamp(a.e) - isRamp(b.e) || a.k - b.k);
    for (const { e } of list) {
      for (const [id, r] of ramps) if (e.beat >= r.start + r.len) cancel(id, r.start + r.len);
      if (e.type === 'param') write(e.id, e.value, e.beat);
      else if (e.type === 'params') for (const [id, v] of Object.entries(e.values)) write(id, v, e.beat);
      else if (e.type === 'macro') write('macro' + (e.index + 1), e.value, e.beat);
      else {
        const id = e.type === 'ramp' ? e.id : 'macro' + (e.index + 1), prm = PARAM_BY_ID[id];
        if (!prm || prm.scope === 'global' || prm.type === 'enum' || prm.type === 'bool') continue;
        cancel(id, e.beat);
        const from = toNorm(prm, e.from !== undefined ? e.from : values[id]), to = toNorm(prm, e.to);
        if (!(e.beats > 0)) values[id] = sanitizeValue(prm, e.to); else ramps.set(id, { start: e.beat, len: e.beats, from, to });
      }
    }
    for (const id of [...ramps.keys()]) cancel(id, beat);
    t.patch.params = diffFromDefaults(values);
    if (clear) t.events = t.events.filter(e => e.type === 'on' || e.type === 'ctrl');
  });
}
const FADE_OUT = 0.65, FADE_IN = 0.9;
/** Website theater order and dwell: all presets, one category or the demo songs; seeded shuffle; whole phrase passes for ≈secs. */
export function theaterProgram({ source = 'all', secs = 24, shuffle = false, seed = 42 } = {}) {
  choice(source, ['all', 'songs', ...CATEGORIES.map(c => c.id)], 'source'); bounded(secs, 20, 30, 'secs'); bounded(seed, 1, 4294967295, 'seed', true);
  let list = source === 'songs' ? SONGS.slice() : source === 'all' ? PRESETS.slice() : PRESETS.filter(p => p.category === source);
  if (shuffle) { const rng = patchRng(seed); for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  let start = 0;
  const items = list.map((item, index) => {
    if (source === 'songs') { const seconds = songDuration(resolveSong(item, PRESETS)) + 1.2, x = { index, id: item.id, title: item.title, start, seconds }; start += seconds; return x; }
    const demo = theaterDemo(item), pass = demo.song.lengthBeats * 60 / (demo.song.bpm || 120), passes = pass > secs * 1.5 ? 1 : Math.max(1, Math.round(secs / pass));
    const x = { index, name: item.name, category: item.category, description: item.description || '', phrase: demo.id, passes, seconds: pass * passes, start, macroRides: demo.rides.length }; start += x.seconds; return x;
  });
  return { source, secs, shuffle, seed: shuffle ? seed : null, mode: source === 'songs' ? 'songs' : 'presets', fadeOut: FADE_OUT, fadeIn: FADE_IN, totalSeconds: start, items };
}
function theaterDemo(preset) {
  const macros = preset.macros || [], values = [1, 2, 3, 4].map(i => +(preset.params?.['macro' + i] ?? 0));
  return presetDemoSong({ phrases: { PHRASES, DEMO_FOR_CATEGORY, getPhrase }, meta: preset, demoMacros: preset.demoMacros, macros, values });
}
/** A renderable stretch of the preset theater: one track per preset playing its demo passes, with the website's output dip between presets. */
export function theaterMedley(options = {}, { from = 0, count, bpm = 120, tailSeconds = 2 } = {}) {
  const prog = theaterProgram(options); if (prog.mode !== 'presets') fail('INVALID_ARGUMENT', 'Medley renders preset theater; songs are separate multi-part projects (use load_demo_song)');
  bounded(from, 0, prog.items.length - 1, 'from', true); bounded(bpm, 40, 240, 'bpm');
  const room = 180 - tailSeconds, picked = [];
  for (const it of prog.items.slice(from)) { if (picked.length >= Math.min(8, count ?? 8) || it.seconds + picked.reduce((s, x) => s + x.seconds, 0) > room) break; picked.push(it); }
  if (!picked.length) fail('RESOURCE_LIMIT', 'The first preset does not fit 180 s');
  const p = createProject({ title: 'Theater medley', axes: { rhythm: { bpm } } }), spb = 60 / bpm;
  let at = 0;
  p.tracks = picked.map(it => {
    const preset = PRESETS.find(x => x.name === it.name), patch = patchFromPreset(preset.name), demo = theaterDemo(preset), k = bpm / (demo.song.bpm || 120), events = [];
    const startBeat = at / spb, endBeat = (at + it.seconds) / spb, level = patch.params['amp.level'] ?? PARAM_BY_ID['amp.level'].def;
    for (let pass = 0; pass < it.passes; pass++) for (const e of demo.song.events) {
      const beat = startBeat + (pass * demo.song.lengthBeats + e.beat) * k; if (beat >= endBeat - 1e-6) continue;
      if (e.type === 'on') events.push({ beat: r6(beat), type: 'on', note: e.note, vel: e.vel ?? 0.8, dur: r6(Math.min((e.dur ?? 1) * k, endBeat - beat)) });
      else if (e.type === 'ramp-macro') events.push({ beat: r6(beat), type: 'ramp-macro', index: e.index, to: e.to, beats: r6(Math.min(e.beats * k, endBeat - beat)) });
    }
    events.push({ beat: r6(startBeat), type: 'param', id: 'amp.level', value: -36 }, { beat: r6(startBeat), type: 'ramp', id: 'amp.level', to: level, beats: r6(FADE_IN / spb) });
    events.push({ beat: r6(Math.max(startBeat, endBeat - FADE_OUT / spb)), type: 'ramp', id: 'amp.level', to: -36, beats: r6(Math.min(FADE_OUT / spb, endBeat - startBeat)) });
    at += it.seconds;
    return { name: it.name.slice(0, 100), role: it.category, patch, gain: 0, pan: 0, mute: false, events: events.sort((x, y) => x.beat - y.beat) };
  });
  p.lengthBeats = r6(at / spb);
  return { project: validateProject(p), items: picked, program: { ...prog, items: undefined, itemCount: prog.items.length } };
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
