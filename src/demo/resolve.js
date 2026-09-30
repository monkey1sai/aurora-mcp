// Song definition → engine-ready song (src/dsp/ensemble.js). Pure ES module (browser + Node).
//
//   import { resolveSong, songDuration } from './resolve.js';
//   import { PRESETS } from '../presets/index.js';
//   const song = resolveSong(SONGS[0], PRESETS);   // throws a readable Error on problems
//   audio.songLoad(song); audio.songPlay();
//
// Song definition (docs/SONGS.md):
//   { id, title, zh, genre, zhGenre, description, descriptionEn?, bpm, key: {root, scale}, lengthBeats, loop,
//     cover: {colors: [3 hex]}, sections: [{beat, name, zh}],
//     parts: [{ name, zh, preset: '<factory preset name>' | [candidates…], fallback?: '<category id>',
//               params?: {id: native}, macros?: [m1, m2, m3, m4] /*initial values 0..1*/,
//               gain /*dB*/, pan /*-1..1*/, role, events }] }
// Engine-ready song: same metadata + parts: [{ name, zh, role, preset /*resolved name*/, patch: {params, macros},
//   gain, pan, events }] (+ warnings: [] when a fallback preset was used).

import { PARAM_BY_ID, SCALES } from '../dsp/params.js';

export const SONG_MAX_PARTS = 8; // = ENSEMBLE_MAX_PARTS (drum presets are single instruments: kick, snare, hats … are parts)
export const SONG_ROLES = ['pad', 'bass', 'lead', 'drums', 'arp', 'keys', 'fx'];
const EVENT_TYPES = new Set(['on', 'off', 'param', 'ramp', 'macro', 'ramp-macro']);
const BPM = PARAM_BY_ID['global.bpm'];

/**
 * Find a factory preset: exact name, then case-insensitive name. `name` may be an array of candidates
 * (first match wins). Returns null when none matches.
 */
export function findPreset(PRESETS, name) {
  const list = Array.isArray(name) ? name : [name];
  for (const n of list) {
    if (typeof n !== 'string') continue;
    const p = PRESETS.find(x => x && x.name === n) || PRESETS.find(x => x && String(x.name).toLowerCase() === n.toLowerCase());
    if (p) return p;
  }
  return null;
}

function checkParamValue(p, v) {
  if (p.type === 'enum') return typeof v === 'number' ? v >= 0 && v < p.options.length : p.options.includes(v);
  if (p.type === 'bool') return typeof v === 'boolean' || v === 0 || v === 1;
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Check a song definition. Returns { errors: string[], warnings: string[] } (never throws).
 * @param {object} def song definition
 * @param {object[]} PRESETS factory presets (src/presets/index.js)
 */
export function validateSong(def, PRESETS = []) {
  const errors = [], warnings = [];
  const tag = def && def.id ? `song "${def.id}"` : 'song';
  if (!def || typeof def !== 'object') return { errors: ['song definition must be an object'], warnings };
  if (!def.id || typeof def.id !== 'string') errors.push(`${tag}: missing id`);
  if (!def.title) warnings.push(`${tag}: missing title`);
  if (!def.zh) warnings.push(`${tag}: missing zh title`);
  const bpm = Number(def.bpm);
  if (!(bpm >= BPM.min && bpm <= BPM.max)) errors.push(`${tag}: bpm ${def.bpm} outside ${BPM.min}–${BPM.max}`);
  const len = Number(def.lengthBeats);
  if (!(len > 0)) errors.push(`${tag}: lengthBeats must be > 0`);
  if (def.key !== undefined) {
    const k = def.key;
    if (!k || typeof k.root !== 'string' || !/^[A-G][#b]?$/.test(k.root)) errors.push(`${tag}: key.root must be a note letter like 'C', 'F#', 'Bb'`);
    if (!k || !(k.scale in SCALES) || k.scale === 'off') warnings.push(`${tag}: key.scale '${k && k.scale}' is not a scale-lock option (${Object.keys(SCALES).filter(s => s !== 'off').join(', ')})`);
  }
  if (def.cover !== undefined && !(def.cover && Array.isArray(def.cover.colors) && def.cover.colors.every(c => /^#[0-9a-f]{3,8}$/i.test(c)))) warnings.push(`${tag}: cover.colors should be hex colours`);
  if (Array.isArray(def.sections)) {
    def.sections.forEach((s, i) => {
      if (!s || !Number.isFinite(Number(s.beat))) errors.push(`${tag}: section ${i} needs a numeric beat`);
      else if (len > 0 && (s.beat < 0 || s.beat >= len)) errors.push(`${tag}: section '${s.name}' at beat ${s.beat} outside the song`);
    });
  }
  const parts = Array.isArray(def.parts) ? def.parts : [];
  if (!parts.length) errors.push(`${tag}: no parts`);
  if (parts.length > SONG_MAX_PARTS) errors.push(`${tag}: ${parts.length} parts (max ${SONG_MAX_PARTS})`);
  const names = new Set();
  parts.forEach((part, i) => {
    const pt = `${tag} part ${i}${part && part.name ? ` "${part.name}"` : ''}`;
    if (!part || typeof part !== 'object') { errors.push(`${pt}: not an object`); return; }
    if (!part.name) errors.push(`${pt}: missing name`);
    else if (names.has(part.name)) errors.push(`${pt}: duplicate part name`);
    names.add(part.name);
    if (part.role !== undefined && !SONG_ROLES.includes(part.role)) warnings.push(`${pt}: role '${part.role}' not one of ${SONG_ROLES.join('|')}`);
    if (!part.patch) {
      const preset = findPreset(PRESETS, part.preset);
      if (!preset) {
        const fb = part.fallback && PRESETS.find(p => p && p.category === part.fallback);
        if (fb) warnings.push(`${pt}: preset ${JSON.stringify(part.preset)} not found — using '${fb.name}' (fallback '${part.fallback}')`);
        else errors.push(`${pt}: unknown preset ${JSON.stringify(part.preset)}${part.fallback ? ` (and no preset in fallback category '${part.fallback}')` : ''}`);
      }
    }
    for (const [id, v] of Object.entries(part.params || {})) {
      const p = PARAM_BY_ID[id];
      if (!p) errors.push(`${pt}: unknown param '${id}'`);
      else if (!checkParamValue(p, v)) errors.push(`${pt}: bad value ${JSON.stringify(v)} for '${id}'`);
    }
    if (part.macros !== undefined && !(Array.isArray(part.macros) && part.macros.length <= 4 && part.macros.every(v => v === null || v === undefined || (typeof v === 'number' && v >= 0 && v <= 1)))) {
      errors.push(`${pt}: macros must be an array of ≤ 4 initial values 0..1`);
    }
    if (part.gain !== undefined && !(Number.isFinite(part.gain) && part.gain >= -60 && part.gain <= 12)) errors.push(`${pt}: gain ${part.gain} dB outside −60…+12`);
    if (part.pan !== undefined && !(Number.isFinite(part.pan) && part.pan >= -1 && part.pan <= 1)) errors.push(`${pt}: pan ${part.pan} outside −1…1`);
    const evs = part.events;
    if (!Array.isArray(evs)) { errors.push(`${pt}: events must be an array`); return; }
    let notes = 0, bad = 0;
    for (const e of evs) {
      const where = () => `${pt}: event at beat ${e && e.beat}`;
      if (!e || !EVENT_TYPES.has(e.type)) { if (bad++ < 3) errors.push(`${where()} has unknown type ${JSON.stringify(e && e.type)}`); continue; }
      if (!(Number(e.beat) >= 0)) { if (bad++ < 3) errors.push(`${where()}: beat must be ≥ 0`); continue; }
      if (len > 0 && e.beat >= len) { if (bad++ < 3) warnings.push(`${where()}: after the song end (${len}) — never plays`); continue; }
      if (e.type === 'on') {
        notes++;
        if (!(Number.isInteger(e.note) && e.note >= 0 && e.note <= 127)) { if (bad++ < 3) errors.push(`${where()}: note ${e.note} not a MIDI number`); }
        if (e.vel !== undefined && !(e.vel >= 0 && e.vel <= 1)) { if (bad++ < 3) errors.push(`${where()}: vel ${e.vel} outside 0..1`); }
        if (e.dur !== undefined && !(e.dur > 0)) { if (bad++ < 3) errors.push(`${where()}: dur must be > 0`); }
      } else if (e.type === 'param' || e.type === 'ramp') {
        const p = PARAM_BY_ID[e.id];
        if (!p) { if (bad++ < 3) errors.push(`${where()}: unknown param '${e.id}'`); continue; }
        if (p.scope === 'global') { if (bad++ < 3) errors.push(`${where()}: '${e.id}' is global (tempo/master belong to the song)`); continue; }
        if (e.type === 'ramp' && (p.type === 'enum' || p.type === 'bool')) { if (bad++ < 3) errors.push(`${where()}: cannot ramp ${p.type} '${e.id}'`); }
        const v = e.type === 'ramp' ? e.to : e.value;
        if (!checkParamValue(p, v)) { if (bad++ < 3) errors.push(`${where()}: bad value ${JSON.stringify(v)} for '${e.id}'`); }
      } else if (e.type === 'macro' || e.type === 'ramp-macro') {
        if (!(Number.isInteger(e.index) && e.index >= 0 && e.index < 4)) { if (bad++ < 3) errors.push(`${where()}: macro index ${e.index} not 0..3`); }
        const v = e.type === 'macro' ? e.value : e.to;
        if (!(v >= 0 && v <= 1)) { if (bad++ < 3) errors.push(`${where()}: macro value ${v} outside 0..1`); }
      }
    }
    if (bad > 3) errors.push(`${pt}: … ${bad - 3} more event problems`);
    if (!notes) warnings.push(`${pt}: no notes`);
  });
  return { errors, warnings };
}

/**
 * Resolve a song definition against the factory presets → engine-ready song for Ensemble / audio.songLoad().
 * Unknown presets, params or malformed events throw an Error listing every problem.
 * @param {object} def song definition (docs/SONGS.md)
 * @param {object[]} PRESETS factory presets
 * @returns {object} engine-ready song
 */
export function resolveSong(def, PRESETS = []) {
  const { errors, warnings } = validateSong(def, PRESETS);
  if (errors.length) {
    const e = new Error(`Cannot resolve ${def && def.id ? `song "${def.id}"` : 'song'}:\n  - ${errors.join('\n  - ')}`);
    e.errors = errors;
    throw e;
  }
  const parts = def.parts.map(part => {
    let patch, presetName;
    if (part.patch) {
      patch = { params: { ...(part.patch.params || {}) }, macros: part.patch.macros || [] };
      presetName = part.preset || null;
    } else {
      const preset = findPreset(PRESETS, part.preset) || PRESETS.find(p => p && p.category === part.fallback);
      presetName = preset.name;
      const params = { ...(preset.params || {}), ...(part.params || {}) };
      if (Array.isArray(part.macros)) part.macros.forEach((v, i) => { if (typeof v === 'number') params[`macro${i + 1}`] = v; });
      delete params['global.bpm'];
      delete params['master.volume'];
      patch = { params, macros: (preset.macros || []).map(m => ({ name: m.name, targets: (m.targets || []).map(t => ({ ...t })) })) };
    }
    return {
      name: part.name, zh: part.zh || part.name, role: part.role || '', preset: presetName,
      patch, gain: part.gain ?? 0, pan: part.pan ?? 0,
      events: part.events.map(e => ({ ...e })),
    };
  });
  const out = {
    id: def.id, title: def.title || def.id, zh: def.zh || def.title || def.id,
    genre: def.genre || '', zhGenre: def.zhGenre || '', description: def.description || '', descriptionEn: def.descriptionEn || '',
    bpm: Number(def.bpm), key: def.key ? { ...def.key } : null,
    lengthBeats: Number(def.lengthBeats), loop: def.loop !== false,
    cover: def.cover ? { ...def.cover, colors: (def.cover.colors || []).slice() } : null,
    sections: (def.sections || []).map(s => ({ beat: Number(s.beat), name: s.name || '', zh: s.zh || s.name || '' })).sort((a, b) => a.beat - b.beat),
    parts,
  };
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Length of one pass of the song in seconds (lengthBeats at bpm). */
export function songDuration(song) {
  const bpm = Number(song && song.bpm) || 120;
  return ((Number(song && song.lengthBeats) || 0) * 60) / bpm;
}

/** Seconds → beat position for a song. */
export function secondsToBeat(song, sec) { return (sec * (Number(song.bpm) || 120)) / 60; }

/** Section active at `beat` (last section starting at or before it), or null. */
export function sectionAt(song, beat) {
  let cur = null;
  for (const s of song.sections || []) if (s.beat <= beat + 1e-6) cur = s;
  return cur;
}
