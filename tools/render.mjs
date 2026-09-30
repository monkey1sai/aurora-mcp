#!/usr/bin/env node
// Offline preset renderer: WAV (24-bit) + spectrogram PNG + waveform PNG + metrics JSON.
//
//   node tools/render.mjs --preset "Aurora Pad" [--phrase pad] [--note 60] [--sr 48000] [--out renders/]
//                         [--params '{"filter.cutoff":800}'] [--macros 0.5,0,0,1] [--no-ride] [--json]
//   (the preset's own demo phrase includes its demoMacros macro ride, like the ▶ 示範 button; --no-ride = static)
//   node tools/render.mjs --all [--category pad] [--jobs 8]
//   node tools/render.mjs --patch my-patch.json --phrase lead
//   node tools/render.mjs --list
//
// Also a library (used by tools/test.mjs): renderEvents(), renderPhrase(), estimateTail(), findPresets() …
// Env overrides (for testing the tools themselves): AURORA_ROOT (project root).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeWav } from './wav.mjs';
import { analyze, spectrogram, waveformPng, formatMetrics } from './analyze.mjs';
import { PHRASES, DEMO_FOR_CATEGORY, getPhrase, phraseToTimedEvents } from './phrases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** CPU time of the current thread in ms (immune to other processes loading the machine). */
export const cpuMs = () => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
export const ROOT = process.env.AURORA_ROOT ? path.resolve(process.env.AURORA_ROOT) : path.resolve(HERE, '..');
const modUrl = rel => pathToFileURL(path.join(ROOT, rel)).href;

// ───────────────────────── Module loading ─────────────────────────
let synthModPromise = null, presetsPromise = null, paramsPromise = null;

/** Import src/dsp/synth.js (cached). Throws a readable error if missing. */
export function loadSynth() {
  synthModPromise ??= import(modUrl('src/dsp/synth.js')).then(m => {
    if (typeof m.renderOffline !== 'function' && typeof m.Synth !== 'function') throw new Error('src/dsp/synth.js exports neither renderOffline nor Synth');
    return m;
  });
  return synthModPromise;
}

/** Import src/presets/index.js → { PRESETS, CATEGORIES } (empty arrays if absent). */
export function loadPresets() {
  presetsPromise ??= import(modUrl('src/presets/index.js'))
    .then(m => ({ PRESETS: m.PRESETS || m.default || [], CATEGORIES: m.CATEGORIES || [] }))
    .catch(e => {
      if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(e.message))) return { PRESETS: [], CATEGORIES: [], missing: true };
      throw e;
    });
  return presetsPromise;
}

export function loadParams() {
  paramsPromise ??= import(modUrl('src/dsp/params.js'));
  return paramsPromise;
}

// ───────────────────────── Helpers ─────────────────────────
export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s) return s.slice(0, 60);
  let h = 2166136261;
  for (const ch of String(name)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return `preset-${h.toString(36)}`;
}

/** Match presets by exact name, slug, or case-insensitive substring. */
export function findPresets(presets, query) {
  const q = String(query).toLowerCase().trim();
  const exact = presets.filter(p => p.name?.toLowerCase() === q || slugify(p.name) === slugify(q));
  if (exact.length) return exact;
  return presets.filter(p => p.name?.toLowerCase().includes(q));
}

/** Resolve the phrase id for a preset (explicit → preset.demo → category default → keys). */
export function phraseFor(preset, requested) {
  if (requested && PHRASES[requested]) return requested;
  if (requested) throw new Error(`Unknown phrase "${requested}". Available: ${Object.keys(PHRASES).join(', ')}`);
  if (preset?.demo && PHRASES[preset.demo]) return preset.demo;
  return DEMO_FOR_CATEGORY[preset?.category] || 'keys';
}

/** Patch object for loadPatch: preset + param overrides (demoMacros is carried along; loadPatch ignores it). */
export function buildPatch(preset, overrides = {}) {
  return {
    name: preset.name, category: preset.category,
    params: { ...(preset.params || {}), ...overrides },
    macros: preset.macros || [],
    demoMacros: Array.isArray(preset.demoMacros) ? preset.demoMacros : undefined,
  };
}

/**
 * The ▶ 示範 macro ride as timed events: a preset's `demoMacros` [{index, to, beat, beats}] become 'macro'
 * events stepped every `step` samples (linear in normalised space, like the sequencer's 'ramp-macro').
 * Same rules as the UI (src/ui/demo/automation.js planMacroRides + sequencer): rides on macros without targets
 * are skipped, beat/length are clamped to the phrase, a ride starts from the macro's current value and a later
 * ride on the same macro cancels an unfinished one. One pass only (no loop glide-back).
 * @param {Array<{index:number,to:number,beat:number,beats:number}>} demoMacros
 * @param {{ lengthBeats:number, bpm:number, sampleRate?:number, start?:number[], macros?:Array, step?:number }} o
 * @returns {Array<{time:number,type:'macro',index:number,value:number}>}
 */
export function rideEvents(demoMacros, { lengthBeats, bpm, sampleRate = 48000, start = [0, 0, 0, 0], macros = null, step = 32 }) {
  if (!Array.isArray(demoMacros) || !demoMacros.length) return [];
  const L = Math.max(1, Number(lengthBeats) || 16), spb = 60 / (bpm || 120);
  const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
  const usable = i => !macros || !!(macros[i] && Array.isArray(macros[i].targets) && macros[i].targets.length);
  const rides = [];
  demoMacros.forEach((r, k) => {
    const i = Math.round(Number(r.index));
    if (!(i >= 0 && i < 4) || !usable(i)) return;
    const beat = Math.max(0, Math.min(L - 0.25, Number(r.beat) || 0));
    rides.push({ k, index: i, to: clamp01(Number(r.to) || 0), beat, beats: Math.max(0.25, Math.min(L - beat, Number(r.beats) || 2)) });
  });
  rides.sort((a, b) => a.beat - b.beat || a.k - b.k);
  const out = [], dt = step / sampleRate, us = x => Math.round(x * 1e6) / 1e6;
  for (let i = 0; i < 4; i++) {
    const mine = rides.filter(r => r.index === i);
    let v = clamp01(Number(start[i]) || 0);
    mine.forEach((r, j) => {
      const t0 = r.beat * spb, t1 = (r.beat + r.beats) * spb;
      const next = mine[j + 1] ? mine[j + 1].beat * spb : Infinity;
      const from = v;
      for (let t = t0; ; t += dt) {
        const done = t >= t1 - 1e-9;
        if (t >= next - 1e-9) break;                // cancelled by the next ride on this macro
        v = done ? r.to : from + (r.to - from) * ((t - t0) / (t1 - t0));
        out.push({ time: us(t), type: 'macro', index: i, value: Math.round(v * 1e6) / 1e6 });
        if (done) break;
      }
    });
  }
  out.sort((a, b) => a.time - b.time || a.index - b.index);
  return out;
}

/**
 * Conservative estimate (seconds) of how long a patch may keep sounding after the last note-off
 * until it is below −80 dBFS (amp release, phys ring-out, FM op release, delay/reverb tails).
 */
export async function estimateTail(params, bpm) {
  const { resolveParams, divToBeats } = await loadParams();
  const P = resolveParams(params || {});
  if (bpm) P['global.bpm'] = bpm;
  const on = v => v === true || v === 1;
  let t = 1.5 + 5 * P['aenv.r'];
  if (on(P['phys.on'])) t = Math.max(t, 1 + P['phys.decay'] * 1.5 * (1 - 0.8 * P['phys.damp']));
  if (on(P['fm.on'])) t = Math.max(t, 1 + 5 * Math.max(P['fm.op1.r'], P['fm.op2.r'], P['fm.op3.r'], P['fm.op4.r']));
  if (on(P['reverb.on'])) t += 1 + P['reverb.decay'] * (1.4 + P['reverb.shimmer']);
  if (on(P['delay.on'])) {
    const bpm = P['global.bpm'] || 110;
    const beats = divToBeats(P['delay.sync']);
    const time = beats > 0 ? (beats * 60) / bpm : P['delay.time'];
    const fb = Math.min(0.99, P['delay.feedback']);
    const repeats = fb > 0.01 ? 80 / (-20 * Math.log10(fb)) : 1;
    t += Math.min(60, repeats * time + 0.5);
  }
  if (on(P['chorus.on']) || on(P['phaser.on'])) t += 0.5;
  return Math.min(90, t);
}

// ───────────────────────── Rendering ─────────────────────────
/**
 * Render timed note events through the synth, continuing after the last event until the output has been
 * below `quietDb` for `quietHold` seconds and all voices are free (or `maxTail` seconds have passed).
 * @param {object} patch  { params, macros }
 * @param {{time:number,type:string,note?:number,vel?:number}[]} events  (seconds)
 * @param {object} [opts] { sampleRate=48000, bpm, maxTail=8, quietDb=-80, quietHold=0.3, seed=1,
 *                          allOffAtEnd=true, keepQuiet=0.25, synthMod }
 * @returns {Promise<{L:Float32Array,R:Float32Array,sampleRate:number,lastNoteOff:number,audioSeconds:number,
 *          renderMs:number,renderCpuMs:number,rtf:number (audio s per CPU s),rtfWall:number,tailTruncated:boolean,voicesFreed:boolean|null,activeVoicesAtEnd:number|null,
 *          engine:string, synth:any}>}
 */
export async function renderEvents(patch, events, opts = {}) {
  const mod = opts.synthMod || (await loadSynth());
  const sr = opts.sampleRate ?? 48000;
  const maxTail = opts.maxTail ?? 8;
  const thr = 10 ** ((opts.quietDb ?? -80) / 20);
  const quietHold = Math.round((opts.quietHold ?? 0.3) * sr);
  const keepQuiet = Math.round((opts.keepQuiet ?? 0.25) * sr);
  // lastT = last note event (the release point); macro-ride steps may run past it (lastAny)
  let lastT = 0, lastAny = 0;
  for (const e of events) {
    lastAny = Math.max(lastAny, e.time || 0);
    if (e.type !== 'macro') lastT = Math.max(lastT, e.time || 0);
  }
  const params = { ...(patch.params || {}) };
  if (opts.bpm) params['global.bpm'] = opts.bpm;
  const p = { ...patch, params };
  const evs = events.slice();
  if (opts.allOffAtEnd !== false) evs.push({ time: lastT, type: 'allOff', hard: false });

  const chunks = [];
  let total = 0, lastLoud = -1, renderMs = 0, renderCpu = 0, synth = null, engine;
  const scan = (L, R, offset) => {
    for (let i = L.length - 1; i >= 0; i--) {
      const a = L[i], b = R[i];
      if (a > thr || a < -thr || b > thr || b < -thr || a !== a || b !== b) { lastLoud = Math.max(lastLoud, offset + i); break; }
    }
  };
  const push = (L, R) => { scan(L, R, total); chunks.push([L, R]); total += L.length; };
  const chunkSec = 0.25;
  const endSamples = Math.ceil(Math.max(lastAny + chunkSec, lastT + maxTail) * sr);

  if (typeof mod.renderOffline === 'function' && opts.engine !== 'synth') {
    engine = 'renderOffline';
    let t0 = performance.now(), c0 = cpuMs();
    const first = mod.renderOffline(p, evs, lastAny + chunkSec, sr, { seed: opts.seed ?? 1 });
    renderMs += performance.now() - t0; renderCpu += cpuMs() - c0;
    synth = first.synth || null;
    push(first.L, first.R);
    if (!synth) {
      // Cannot continue incrementally: re-render once with the full tail length.
      t0 = performance.now(); c0 = cpuMs();
      const full = mod.renderOffline(p, evs, Math.max(lastAny + chunkSec, lastT + maxTail), sr, { seed: opts.seed ?? 1 });
      renderMs = performance.now() - t0; renderCpu = cpuMs() - c0;
      chunks.length = 0; total = 0; lastLoud = -1;
      push(full.L, full.R);
    } else {
      while (total < endSamples) {
        if (total - (lastLoud + 1) >= quietHold && voiceCount(synth) === 0) break;
        t0 = performance.now(); c0 = cpuMs();
        const c = mod.renderOffline(null, [], Math.min(chunkSec, (endSamples - total) / sr), sr, { synth });
        renderMs += performance.now() - t0; renderCpu += cpuMs() - c0;
        push(c.L, c.R);
      }
    }
  } else {
    engine = 'Synth';
    synth = new mod.Synth(sr, { seed: opts.seed ?? 1 });
    synth.loadPatch(p);
    for (const id in params) if (/^(global|scale)\./.test(id)) synth.setParam(id, params[id]);
    const blk = 128, bl = new Float32Array(blk), br = new Float32Array(blk);
    const L = new Float32Array(endSamples), R = new Float32Array(endSamples);
    const sorted = evs.slice().sort((a, b) => a.time - b.time);
    let pos = 0, ei = 0;
    const t0 = performance.now(), c0 = cpuMs();
    while (pos < endSamples) {
      while (ei < sorted.length && Math.round(sorted[ei].time * sr) <= pos) {
        const e = sorted[ei++];
        if (e.type === 'on') synth.noteOn(e.note, e.vel ?? 0.8);
        else if (e.type === 'off') synth.noteOff(e.note);
        else if (e.type === 'macro') synth.setMacro(e.index, e.value);
        else if (e.type === 'allOff') synth.allNotesOff(!!e.hard);
      }
      let n = Math.min(blk, endSamples - pos);
      if (ei < sorted.length) n = Math.min(n, Math.round(sorted[ei].time * sr) - pos);
      synth.process(bl, br, n);
      L.set(bl.subarray(0, n), pos); R.set(br.subarray(0, n), pos);
      scan(bl.subarray(0, n), br.subarray(0, n), pos);
      pos += n;
      if (ei >= sorted.length && pos % (blk * 32) === 0 && pos - (lastLoud + 1) >= quietHold && voiceCount(synth) === 0) break;
    }
    renderMs = performance.now() - t0; renderCpu = cpuMs() - c0;
    chunks.push([L.subarray(0, pos), R.subarray(0, pos)]);
    total = pos;
  }

  const tailTruncated = total >= endSamples && total - (lastLoud + 1) < quietHold;
  const keep = tailTruncated ? total : Math.min(total, Math.max(Math.ceil(lastT * sr), lastLoud + 1) + keepQuiet);
  const L = new Float32Array(keep), R = new Float32Array(keep);
  let o = 0;
  for (const [cl, cr] of chunks) {
    if (o >= keep) break;
    const n = Math.min(cl.length, keep - o);
    L.set(cl.subarray(0, n), o); R.set(cr.subarray(0, n), o);
    o += n;
  }
  const active = synth ? voiceCount(synth) : null;
  const audioSeconds = total / sr;
  return {
    L, R, sampleRate: sr, lastNoteOff: lastT, audioSeconds, renderMs, renderCpuMs: renderCpu,
    rtf: renderCpu > 0 ? audioSeconds / (renderCpu / 1000) : Infinity,
    rtfWall: renderMs > 0 ? audioSeconds / (renderMs / 1000) : Infinity,
    tailTruncated, voicesFreed: active == null ? null : active === 0, activeVoicesAtEnd: active, engine, synth,
  };
}

function voiceCount(synth) {
  try {
    const st = synth.getState();
    return Array.isArray(st?.voices) ? st.voices.length : 0;
  } catch { return 0; }
}

/**
 * Render a phrase (by id) for a patch.
 * opts: renderEvents opts + { phrase, note (for 'single'), transpose, bpm, demoMacros }
 *   demoMacros: the preset's macro ride (see rideEvents) — played on top of the phrase, starting from the
 *   patch's macro values, exactly like the ▶ 示範 button. Omit for a static render.
 * Returns the renderEvents result + { phrase, bpm, events (notes), rideEvents (count) }.
 */
export async function renderPhrase(patch, phraseId, opts = {}) {
  const phrase = getPhrase(phraseId);
  if (phraseId === 'single' && opts.note != null) phrase.events[0].note = Number(opts.note);
  const bpm = opts.bpm ?? phrase.bpm;
  const events = phraseToTimedEvents(phrase, { transpose: opts.transpose ?? 0, bpm });
  const P = patch.params || {};
  const ride = opts.demoMacros ? rideEvents(opts.demoMacros, {
    lengthBeats: phrase.lengthBeats, bpm, sampleRate: opts.sampleRate ?? 48000, macros: patch.macros,
    start: [1, 2, 3, 4].map(i => P[`macro${i}`] ?? 0),
  }) : [];
  const res = await renderEvents(patch, ride.length ? events.concat(ride) : events, { ...opts, bpm });
  return { ...res, phrase: phraseId, bpm, events, rideEvents: ride.length };
}

// ───────────────────────── Output ─────────────────────────
function fadeTail(L, R, sr, sec = 0.03) {
  const n = Math.min(L.length, Math.round(sec * sr));
  const Lc = L.slice(), Rc = R.slice();
  for (let i = 0; i < n; i++) {
    const g = 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / n);
    Lc[L.length - n + i] *= g; Rc[R.length - n + i] *= g;
  }
  return [Lc, Rc];
}

const relPath = p => {
  const r = path.relative(process.cwd(), p);
  return !r ? '.' : r.startsWith('..') || path.isAbsolute(r) ? p : r;
};

/**
 * Render one preset to files. Returns a summary object (also written as JSON).
 * opts: { phrase, note, transpose, bpm, sampleRate, out, params, bits, png=true, colormap, maxTail, seed, engine, slug }
 */
export async function renderPresetToFiles(preset, opts = {}) {
  const phraseId = phraseFor(preset, opts.phrase);
  const slug = opts.slug || slugify(preset.name);
  const outDir = path.resolve(opts.out || path.join(ROOT, 'renders'), slug);
  const base = path.join(outDir, `${slug}-${phraseId}`);
  const patch = buildPatch(preset, opts.params);
  // the preset's own demo phrase plays with its macro ride (as the ▶ 示範 button does) unless --no-ride
  const ride = opts.ride !== false && phraseId === phraseFor(preset) && Array.isArray(preset.demoMacros) && preset.demoMacros.length > 0;
  const res = await renderPhrase(patch, phraseId, { ...opts, demoMacros: ride ? preset.demoMacros : undefined });
  const t0 = performance.now();
  const metrics = analyze(res.L, res.R, res.sampleRate, { lastNoteOff: res.lastNoteOff });
  const analyzeMs = performance.now() - t0;
  fs.mkdirSync(outDir, { recursive: true });
  const [wl, wr] = res.tailTruncated ? fadeTail(res.L, res.R, res.sampleRate) : [res.L, res.R];
  writeWav(`${base}.wav`, [wl, wr], res.sampleRate, { bitDepth: opts.bits ?? 24 });
  const files = { wav: path.basename(`${base}.wav`) };
  if (opts.png !== false) {
    const markers = [{ t: res.lastNoteOff, label: 'release' }];
    const title = pngTitle(preset.name, slug);
    const sub = `${preset.category || 'patch'} · ${phraseId}${res.rideEvents ? ' + macro ride' : ''} · ${Math.round(res.bpm)} BPM`;
    const right = `${(res.sampleRate / 1000).toFixed(1)} kHz · peak ${metrics.peakDb.toFixed(1)} dBFS · ${metrics.lufs == null ? '—' : metrics.lufs.toFixed(1)} LUFS`;
    fs.writeFileSync(`${base}-spectrogram.png`, spectrogram(res.L, res.R, res.sampleRate, { title, subtitle: sub, right, markers, colormap: opts.colormap }));
    fs.writeFileSync(`${base}-waveform.png`, waveformPng(res.L, res.R, res.sampleRate, { title, subtitle: sub, markers }));
    files.spectrogram = path.basename(`${base}-spectrogram.png`);
    files.waveform = path.basename(`${base}-waveform.png`);
  }
  const summary = {
    preset: { name: preset.name, category: preset.category, tags: preset.tags, description: preset.description, demo: preset.demo },
    phrase: phraseId, macroRide: res.rideEvents > 0, bpm: res.bpm, sampleRate: res.sampleRate, bitDepth: opts.bits ?? 24,
    overrides: opts.params && Object.keys(opts.params).length ? opts.params : undefined,
    files,
    render: {
      engine: res.engine, audioSeconds: round(res.audioSeconds, 3), renderMs: round(res.renderMs, 1), renderCpuMs: round(res.renderCpuMs, 1),
      realtimeFactor: round(res.rtf, 1), realtimeFactorWall: round(res.rtfWall, 1),
      analyzeMs: round(analyzeMs, 1), lastNoteOff: round(res.lastNoteOff, 3), tailTruncated: res.tailTruncated,
      voicesFreed: res.voicesFreed, activeVoicesAtEnd: res.activeVoicesAtEnd, fileSeconds: round(res.L.length / res.sampleRate, 3),
    },
    metrics,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
  summary.files.dir = outDir;
  return summary;
}

/** The PNG bitmap font is Latin-only: keep printable ASCII (+ a few symbols); fall back to the slug. */
function pngTitle(name, slug) {
  const t = [...String(name ?? '')].filter(ch => (ch >= ' ' && ch <= '~') || '·×→♯♭°'.includes(ch)).join('').replace(/\s+/g, ' ').trim();
  return t.length >= 2 ? t : slug;
}

const round = (x, d) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** Issues worth flagging in a render summary. */
export function renderIssues(s) {
  const m = s.metrics, out = [];
  if (m.nanCount || m.infCount) out.push(`NaN/Inf ${m.nanCount + m.infCount}`);
  if (m.peak > 1) out.push(`peak>1 (${m.peak})`);
  if (m.dcMax > 0.01) out.push(`DC ${m.dcMax}`);
  if (s.render.tailTruncated) out.push('tail>max');
  if (s.render.voicesFreed === false) out.push(`voices stuck ${s.render.activeVoicesAtEnd}`);
  if (m.peakDb < -40) out.push('very quiet');
  return out;
}

// ───────────────────────── Gallery ─────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Rebuild <out>/index.html + index.json from every <out>/<slug>/*.json summary. */
export function writeGallery(outRoot) {
  const items = [];
  if (!fs.existsSync(outRoot)) return null;
  for (const d of fs.readdirSync(outRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(outRoot, d.name))) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(outRoot, d.name, f), 'utf8'));
        if (s?.metrics && s?.files?.wav) items.push({ dir: d.name, ...s });
      } catch { /* ignore */ }
    }
  }
  items.sort((a, b) => String(a.preset?.category).localeCompare(String(b.preset?.category)) || String(a.preset?.name).localeCompare(String(b.preset?.name)));
  fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(items.map(s => ({
    name: s.preset?.name, category: s.preset?.category, phrase: s.phrase, dir: s.dir, files: s.files,
    peakDb: s.metrics.peakDb, lufs: s.metrics.lufs, centroidHz: s.metrics.centroidHz, rtf: s.render?.realtimeFactor,
  })), null, 2));
  const cats = [...new Set(items.map(s => s.preset?.category || 'patch'))];
  const card = s => {
    const m = s.metrics, u = f => `${encodeURIComponent(s.dir)}/${encodeURIComponent(f)}`;
    const issues = renderIssues(s);
    return `<article class="card" data-cat="${esc(s.preset?.category)}" data-name="${esc((s.preset?.name || '').toLowerCase())}">
  <header><h2>${esc(s.preset?.name)}</h2><span class="cat">${esc(s.preset?.category)} · ${esc(s.phrase)}</span></header>
  ${s.preset?.description ? `<p class="desc">${esc(s.preset.description)}</p>` : ''}
  ${s.files.spectrogram ? `<img loading="lazy" src="${u(s.files.spectrogram)}" alt="spectrogram of ${esc(s.preset?.name)}">` : ''}
  <audio controls preload="none" src="${u(s.files.wav)}"></audio>
  <dl>
    <div><dt>Peak</dt><dd>${m.peakDb?.toFixed(1)} dBFS</dd></div>
    <div><dt>LUFS</dt><dd>${m.lufs == null ? '—' : m.lufs.toFixed(1)}</dd></div>
    <div><dt>Centroid</dt><dd>${m.centroidHz ?? '—'} Hz</dd></div>
    <div><dt>Width</dt><dd>${m.width?.toFixed(2)}</dd></div>
    <div><dt>Tail</dt><dd>${m.release?.tailToSilence == null ? '&gt;end' : m.release.tailToSilence.toFixed(1) + ' s'}</dd></div>
    <div><dt>RTF</dt><dd>${s.render?.realtimeFactor ?? '—'}×</dd></div>
  </dl>
  ${issues.length ? `<p class="warn">⚠ ${esc(issues.join(' · '))}</p>` : ''}
</article>`;
  };
  const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aurora Renders</title>
<style>
:root{--bg-0:#07080d;--bg-1:#0c0f18;--panel:rgba(22,28,46,.72);--line:rgba(140,160,220,.14);--text:#e8ecff;--dim:#8e97b8;--faint:#5a6284;
--grad:linear-gradient(120deg,#3ef0b0,#5cf2ff 30%,#a78bfa 65%,#ff6bd6);--amber:#ffc46b}
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#15204a 0,transparent 60%),var(--bg-0);color:var(--text);
font:14px/1.5 Inter,"Noto Sans TC",system-ui,sans-serif;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:28px;letter-spacing:.04em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;width:max-content}
.sub{color:var(--dim);margin:0 0 20px}.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;align-items:center}
.bar button,.bar input{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font:inherit}
.bar button[aria-pressed=true]{border-color:#5cf2ff;box-shadow:0 0 12px rgba(92,242,255,.35)}.bar input{min-width:200px;border-radius:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;backdrop-filter:blur(8px);box-shadow:0 10px 40px rgba(0,0,0,.45)}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.card h2{margin:0;font-size:17px}
.cat{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.desc{color:var(--dim);margin:4px 0 8px}
.card img{width:100%;border-radius:8px;display:block;margin:6px 0 10px;border:1px solid var(--line)}audio{width:100%;height:36px}
dl{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:10px 0 0}dl div{background:rgba(255,255,255,.03);border-radius:8px;padding:4px 6px}
dt{color:var(--faint);font-size:11px}dd{margin:0;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px}.warn{color:var(--amber);margin:8px 0 0;font-size:12px}
@media (max-width:560px){dl{grid-template-columns:repeat(3,1fr)}}
</style></head><body>
<h1>AURORA 極光 · Renders</h1>
<p class="sub">${items.length} renders · 由 <code>node tools/render.mjs</code> 產生 · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}</p>
<div class="bar"><button aria-pressed="true" data-f="">全部 All</button>${cats.map(c => `<button aria-pressed="false" data-f="${esc(c)}">${esc(c)}</button>`).join('')}
<input type="search" placeholder="搜尋 Search…" aria-label="Search"></div>
<main class="grid">
${items.map(card).join('\n')}
</main>
<script>
const btns=[...document.querySelectorAll('.bar button')],q=document.querySelector('.bar input');let cat='';
function apply(){const s=q.value.toLowerCase();document.querySelectorAll('.card').forEach(c=>{c.hidden=!((!cat||c.dataset.cat===cat)&&(!s||c.dataset.name.includes(s)))})}
btns.forEach(b=>b.onclick=()=>{cat=b.dataset.f;btns.forEach(x=>x.setAttribute('aria-pressed',x===b));apply()});q.oninput=apply;
document.addEventListener('play',e=>{document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()})},true);
</script></body></html>`;
  fs.writeFileSync(path.join(outRoot, 'index.html'), html);
  return path.join(outRoot, 'index.html');
}

// ───────────────────────── CLI ─────────────────────────
const USAGE = `AURORA render — offline preset renderer

Usage:
  node tools/render.mjs --preset "<name>" [options]
  node tools/render.mjs --all [--category <cat>] [options]
  node tools/render.mjs --patch file.json [options]
  node tools/render.mjs --list

Options:
  --phrase <id>[,<id>…]  ${Object.keys(PHRASES).join('|')} (default: preset.demo)
  --note <midi>          note for the 'single' phrase (default 60)
  --transpose <st>       transpose the phrase
  --bpm <bpm>            override phrase tempo
  --sr <hz>              sample rate (default 48000)
  --out <dir>            output root (default renders/) → <out>/<slug>/<slug>-<phrase>.{wav,json,png}
  --params '<json>'      param overrides, e.g. '{"filter.cutoff":800}'
  --macros a,b,c,d       macro values 0..1 (blank = keep)
  --bits 16|24|32        WAV bit depth (default 24; 32 = float)
  --tail <s>             max tail after the last note-off (default 8)
  --colormap <name>      inferno|magma|aurora (default inferno)
  --no-png               skip spectrogram/waveform images
  --no-ride              render the demo phrase without the preset's demoMacros ride (static macros)
  --jobs <n>             parallel workers for --all (default: cores−1, max 8)
  --json                 print metrics JSON only (files are still written)
  --seed <n>             synth RNG seed (default 1)
`;

function parseArgs(argv) {
  const a = { _: [] };
  const bools = new Set(['all', 'json', 'list', 'no-png', 'no-ride', 'help', 'quiet']);
  for (let i = 0; i < argv.length; i++) {
    let t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    t = t.slice(2);
    let v;
    const eq = t.indexOf('=');
    if (eq >= 0) { v = t.slice(eq + 1); t = t.slice(0, eq); }
    else if (bools.has(t)) v = true;
    else v = argv[++i];
    if (v === undefined) throw new Error(`Missing value for --${t}`);
    a[t] = v;
  }
  return a;
}

async function resolveOverrides(args) {
  const { PARAM_BY_ID } = await loadParams();
  let params = {};
  if (args.params) {
    try { params = JSON.parse(args.params); } catch (e) { throw new Error(`--params is not valid JSON: ${e.message}`); }
    for (const [id, v] of Object.entries(params)) {
      const p = PARAM_BY_ID[id];
      if (!p) { process.stderr.write(`warning: unknown param id "${id}" (ignored by the synth)\n`); continue; }
      // the synth clamps / falls back silently — say so (typos in preset experiments)
      if (p.type === 'enum' && !p.options.includes(v) && !(Number.isInteger(v) && v >= 0 && v < p.options.length)) process.stderr.write(`warning: ${id} = ${JSON.stringify(v)} is not one of [${p.options.join(', ')}] (default used)\n`);
      else if ((p.type === 'float' || p.type === 'int') && (typeof v !== 'number' || v < p.min || v > p.max)) process.stderr.write(`warning: ${id} = ${JSON.stringify(v)} outside ${p.min}…${p.max} (clamped)\n`);
    }
  }
  if (args.macros) {
    String(args.macros).split(',').forEach((s, i) => {
      if (i < 4 && s.trim() !== '') params[`macro${i + 1}`] = Math.max(0, Math.min(1, Number(s)));
    });
  }
  return params;
}

function readPatchFile(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(j) ? j : j.presets || [j.preset || j];
  return list.map((p, i) => ({ name: p.name || `${path.basename(file, '.json')}${list.length > 1 ? `-${i + 1}` : ''}`, category: p.category || 'patch', ...p }));
}

function printLine(s, json) {
  if (json) return;
  const issues = renderIssues(s);
  const r = s.render;
  const head = `${issues.length ? '\x1b[33m!\x1b[0m' : '\x1b[32m✓\x1b[0m'} ${s.preset.name} \x1b[2m(${s.preset.category} · ${s.phrase})\x1b[0m`;
  console.log(`${head} → ${relPath(path.join(s.files.dir, s.files.wav))}  ${r.fileSeconds.toFixed(1)}s  RTF ${Math.round(r.realtimeFactor)}×${s.macroRide ? '  (+ macro ride)' : ''}`);
  console.log(`   ${formatMetrics(s.metrics)}${issues.length ? `  \x1b[33m${issues.join(' · ')}\x1b[0m` : ''}`);
}

async function runJobs(tasks, jobs, onResult) {
  if (jobs <= 1 || tasks.length <= 1) {
    for (const t of tasks) {
      try { onResult(t, await renderPresetToFiles(t.preset, t.opts)); } catch (e) { onResult(t, null, e); }
    }
    return;
  }
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, tasks.length) }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { kind: 'render-worker' } }));
  await Promise.all(workers.map(w => new Promise(resolve => {
    const feed = () => {
      if (next >= tasks.length) { w.terminate().then(resolve); return; }
      const t = tasks[next++];
      w.once('message', msg => { onResult(t, msg.ok ? msg.summary : null, msg.ok ? null : new Error(msg.error)); feed(); });
      w.postMessage({ preset: t.preset, opts: t.opts });
    };
    w.on('error', e => { process.stderr.write(`worker error: ${e.stack || e}\n`); resolve(); });
    feed();
  })));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || (!args.preset && !args.all && !args.patch && !args.list && !args.category)) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }
  const { PRESETS, CATEGORIES, missing } = await loadPresets();
  if (args.list) {
    if (missing) console.log('(src/presets/index.js not found)');
    for (const p of PRESETS) console.log(`${(p.category || '').padEnd(8)} ${String(p.name).padEnd(28)} demo=${phraseFor(p)}  ${p.description || ''}`);
    console.log(`${PRESETS.length} presets${CATEGORIES.length ? ` in ${CATEGORIES.length} categories` : ''}`);
    return 0;
  }
  const params = await resolveOverrides(args);
  let presets = [];
  if (args.patch) presets = readPatchFile(path.resolve(args.patch));
  else if (args.all || args.category) presets = PRESETS.slice();
  else {
    presets = findPresets(PRESETS, args.preset);
    if (!presets.length) {
      console.error(`No preset matches "${args.preset}".${missing ? ' (src/presets/index.js not found)' : ''}`);
      if (PRESETS.length) console.error(`Try: ${PRESETS.slice(0, 12).map(p => p.name).join(', ')}${PRESETS.length > 12 ? ', …' : ''}`);
      return 1;
    }
    if (presets.length > 1 && presets.some(p => p.name.toLowerCase() !== String(args.preset).toLowerCase())) presets = presets.slice(0, 1);
  }
  if (args.category) presets = presets.filter(p => p.category === args.category);
  if (!presets.length) { console.error('Nothing to render.'); return 1; }

  const out = path.resolve(args.out || path.join(ROOT, 'renders'));
  const phrases = args.phrase ? String(args.phrase).split(',').map(s => s.trim()).filter(Boolean) : [null];
  for (const ph of phrases) if (ph && !PHRASES[ph]) { console.error(`Unknown phrase "${ph}". Available: ${Object.keys(PHRASES).join(', ')}`); return 1; }
  const base = {
    out, params, note: args.note != null ? Number(args.note) : undefined, transpose: args.transpose != null ? Number(args.transpose) : 0,
    bpm: args.bpm != null ? Number(args.bpm) : undefined, sampleRate: args.sr ? Number(args.sr) : 48000,
    bits: args.bits ? Number(args.bits) : 24, png: !args['no-png'], ride: !args['no-ride'], colormap: args.colormap, maxTail: args.tail != null ? Number(args.tail) : 8,
    seed: args.seed != null ? Number(args.seed) : 1,
  };
  const slugs = new Map();
  const tasks = [];
  for (const p of presets) {
    let slug = slugify(p.name);
    const k = slugs.get(slug) || 0;
    slugs.set(slug, k + 1);
    if (k) slug = `${slug}-${k + 1}`;
    for (const ph of phrases) tasks.push({ preset: p, opts: { ...base, phrase: ph || undefined, slug } });
  }
  const jobs = Math.max(1, Math.min(tasks.length, args.jobs ? Number(args.jobs) : Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1)));
  const results = [];
  let failed = 0;
  const t0 = performance.now();
  await runJobs(tasks, jobs, (t, s, err) => {
    if (err) {
      failed++;
      if (!args.json) console.error(`\x1b[31m✗ ${t.preset.name}\x1b[0m: ${err.message}`);
      results.push({ preset: { name: t.preset.name, category: t.preset.category }, error: err.message });
      return;
    }
    results.push(s);
    printLine(s, args.json);
  });
  const gallery = writeGallery(out);
  if (args.json) {
    const clean = results.map(r => (r.files ? { ...r, files: { ...r.files, dir: relPath(r.files.dir) } } : r));
    console.log(JSON.stringify(clean.length === 1 ? clean[0] : clean, null, 2));
  } else if (tasks.length > 1) {
    const ok = results.filter(r => r.metrics);
    const lufs = ok.map(r => r.metrics.lufs).filter(v => v != null).sort((a, b) => a - b);
    const med = lufs.length ? lufs[Math.floor(lufs.length / 2)] : null;
    console.log(`\n${ok.length}/${tasks.length} rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s (${jobs} jobs)` +
      (med != null ? ` · median ${med.toFixed(1)} LUFS, range ${lufs[0].toFixed(1)} … ${lufs[lufs.length - 1].toFixed(1)}` : ''));
    const outliers = ok.filter(r => med != null && r.metrics.lufs != null && Math.abs(r.metrics.lufs - med) > 6);
    if (outliers.length) console.log(`Loudness outliers (>6 LU from median): ${outliers.map(r => `${r.preset.name} ${r.metrics.lufs.toFixed(1)}`).join(', ')}`);
    const flagged = ok.filter(r => renderIssues(r).length);
    if (flagged.length) console.log(`Flagged: ${flagged.map(r => `${r.preset.name} [${renderIssues(r).join(', ')}]`).join('; ')}`);
    if (gallery) {
      const rel = path.relative(ROOT, gallery);
      console.log(`Gallery: ${relPath(gallery)}${rel.startsWith('..') ? '' : `  (npm start → http://localhost:5173/${rel.split(path.sep).join('/')})`}`);
    }
  } else if (gallery && !args.json) {
    console.log(`   files: ${relPath(results[0]?.files?.dir ?? out)}/  ·  gallery: ${relPath(gallery)}`);
  }
  return failed ? 1 : 0;
}

// ───────────────────────── Entry points ─────────────────────────
if (!isMainThread && workerData?.kind === 'render-worker') {
  parentPort.on('message', async ({ preset, opts }) => {
    try {
      const summary = await renderPresetToFiles(preset, opts);
      parentPort.postMessage({ ok: true, summary });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: e?.stack || String(e) });
    }
  });
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, e => { console.error(e?.stack || e); process.exitCode = 1; });
}
