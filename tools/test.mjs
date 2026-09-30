#!/usr/bin/env node
// AURORA test runner — `npm test`
//
// Loads every DSP module in Node and checks it hard: engines through all enum options × extreme params ×
// sample rates × notes, filters through sweeps/fast modulation, the FX chain with everything on at extreme
// settings, the Synth API, stress/fuzz renders, every factory preset with its demo phrase, and the
// AudioWorklet processor through a shim. Also static checks: DSP purity, import graph, syntax, schema.
//
//   node tools/test.mjs [--quick | --full] [--only engines,filters,…] [--preset <name>] [--jobs N]
//                       [--json report.json] [--verbose] [--no-color]
//
// Suites: tools modules purity syntax params engines filters fx synth presets worklet songs magic compat ui
// Exit code 1 if anything FAILs. A missing module or a module that throws is reported as FAIL; the rest
// of the run continues.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PerformanceObserver } from 'node:perf_hooks';
import { getFFT, makeWindow, loudness } from './analyze.mjs';
import { PHRASES, getPhrase, phraseToTimedEvents } from './phrases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AURORA_ROOT ? path.resolve(process.env.AURORA_ROOT) : path.resolve(HERE, '..');
const SELF = fileURLToPath(import.meta.url);
const url = rel => pathToFileURL(path.join(ROOT, rel)).href;

const cpuMs = () => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const dB = x => (x > 1e-12 ? 20 * Math.log10(x) : -240);
const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : Number.isFinite(x) ? x.toFixed(d) : String(x));
const fmtDb = x => (x <= -200 ? '-inf' : x.toFixed(1));

class Rand {
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  next() { let s = this.s; s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; this.s = s; return s / 4294967296; }
  bi() { return this.next() * 2 - 1; }
  pick(a) { return a[Math.floor(this.next() * a.length) % a.length]; }
}

// ───────────────────────── Module registry ─────────────────────────
const DSP_MODULES = [
  'src/dsp/params.js', 'src/dsp/util.js', 'src/dsp/env.js', 'src/dsp/lfo.js', 'src/dsp/filter.js',
  'src/dsp/engines/wavetables.js', 'src/dsp/engines/osc.js', 'src/dsp/engines/fm.js', 'src/dsp/engines/phys.js', 'src/dsp/engines/noise.js',
  'src/dsp/fx/drive.js', 'src/dsp/fx/chorus.js', 'src/dsp/fx/phaser.js', 'src/dsp/fx/delay.js', 'src/dsp/fx/reverb.js',
  'src/dsp/fx/eq.js', 'src/dsp/fx/comp.js', 'src/dsp/fx/limiter.js', 'src/dsp/fx/fxchain.js',
  'src/dsp/voice.js', 'src/dsp/performance.js', 'src/dsp/sequencer.js', 'src/dsp/synth.js',
  'src/presets/index.js',
];
const EXPECTED_EXPORTS = {
  'src/dsp/params.js': ['PARAMS', 'idx', 'toValueArray', 'resolveParams'],
  'src/dsp/util.js': ['Rng', 'mtof', 'fastTanh', 'polyBlep', 'onePoleCoef'],
  'src/dsp/filter.js': ['VoiceFilter', 'SVFilter', 'filterResponse'],
  'src/dsp/engines/osc.js': ['OscEngine'], 'src/dsp/engines/fm.js': ['FmEngine'],
  'src/dsp/engines/phys.js': ['PhysEngine'], 'src/dsp/engines/noise.js': ['NoiseEngine'],
  'src/dsp/fx/fxchain.js': ['FxChain'],
  'src/dsp/synth.js': ['Synth'],
  'src/presets/index.js': ['PRESETS', 'CATEGORIES'],
};
const ENGINES = [
  { file: 'src/dsp/engines/osc.js', cls: 'OscEngine', prefix: 'osc1', label: 'osc' },
  { file: 'src/dsp/engines/fm.js', cls: 'FmEngine', prefix: 'fm', label: 'fm' },
  { file: 'src/dsp/engines/phys.js', cls: 'PhysEngine', prefix: 'phys', label: 'phys' },
  { file: 'src/dsp/engines/noise.js', cls: 'NoiseEngine', prefix: 'noise', label: 'noise' },
];
const CATEGORY_IDS = ['keys', 'pad', 'bass', 'lead', 'pluck', 'bell', 'strings', 'arp', 'fx', 'drum'];

const modCache = new Map();
function load(rel) {
  if (!modCache.has(rel)) modCache.set(rel, import(url(rel)));
  return modCache.get(rel);
}
async function tryLoad(rel) {
  try { return await load(rel); } catch { return null; }
}

// Find an engine class even if the export name differs from the spec.
function engineClass(mod, name) {
  if (!mod) return null;
  if (typeof mod[name] === 'function') return mod[name];
  for (const v of Object.values(mod)) if (typeof v === 'function' && v.prototype && typeof v.prototype.process === 'function' && typeof v.prototype.noteOn === 'function') return v;
  return null;
}

// ───────────────────────── Row helpers ─────────────────────────
const row = (suite, name, status, detail = '', data) => ({ suite, name, status, detail, data });
const worst = statuses => (statuses.includes('FAIL') ? 'FAIL' : statuses.includes('WARN') ? 'WARN' : statuses.includes('PASS') ? 'PASS' : statuses[0] || 'SKIP');

/** Aggregates many renders into one summary row with the worst findings. */
class Agg {
  constructor(suite, name) { this.suite = suite; this.name = name; this.n = 0; this.peak = 0; this.peakAt = ''; this.dc = 0; this.nan = 0; this.fails = []; this.warns = []; this.notes = []; this.t0 = performance.now(); }
  sample(where, st) {
    this.n++;
    if (st.peak > this.peak) { this.peak = st.peak; this.peakAt = where; }
    if (Math.abs(st.dc) > Math.abs(this.dc)) this.dc = st.dc;
    this.nan += st.nan;
  }
  fail(msg) { if (this.fails.length < 50) this.fails.push(msg); }
  warn(msg) { if (this.warns.length < 50) this.warns.push(msg); }
  info(msg) { this.notes.push(msg); }
  row() {
    const status = this.fails.length ? 'FAIL' : this.warns.length ? 'WARN' : 'PASS';
    const parts = [`${this.n} renders`, `peak ${fmt(this.peak, 2)}${this.peakAt && this.peak > 1.5 ? ` @${this.peakAt}` : ''}`, `|DC| ${fmt(Math.abs(this.dc), 4)}`];
    if (this.nan) parts.push(`NaN/Inf ${this.nan}`);
    parts.push(...this.notes);
    parts.push(`${((performance.now() - this.t0) / 1000).toFixed(1)}s`);
    const uniq = a => [...new Set(a)];
    const detail = [parts.join(' · '), ...uniq(this.fails).slice(0, 4).map(f => `✗ ${f}`), ...uniq(this.warns).slice(0, 3).map(w => `! ${w}`)];
    if (uniq(this.fails).length > 4) detail.push(`… ${uniq(this.fails).length - 4} more failures`);
    return row(this.suite, this.name, status, detail.join('\n'));
  }
}

function stats(L, R, from = 0, to = L.length) {
  let peak = 0, nan = 0, s = 0, c = 0;
  for (let i = from; i < to; i++) {
    const l = L[i], r = R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; continue; }
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    s += l + r; c += 2;
  }
  return { peak, nan, dc: c ? s / c : 0 };
}
function rmsOf(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
function peakOf(L, R, from, to) {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(L.length, to); i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i]));
  return p;
}

// ───────────────────────── Static suites (main thread) ─────────────────────────
function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

function stripComments(src) {
  // Good enough for our sources: removes /* */ and // comments outside of simple string literals.
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += d ?? ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    out += c; i++;
  }
  return out;
}

function importsOf(src) {
  const code = stripComments(src);
  const specs = [];
  const re = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code))) specs.push(m[1] || m[2]);
  return specs;
}

async function suiteModules() {
  const rows = [];
  const found = new Set(walk(path.join(ROOT, 'src/dsp'), ['.js']).map(rel));
  for (const f of walk(path.join(ROOT, 'src/presets'), ['.js'])) found.add(rel(f));
  const list = [...new Set([...DSP_MODULES, ...found])];
  for (const f of list) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { rows.push(row('modules', f, 'FAIL', 'missing file')); continue; }
    const t0 = performance.now();
    try {
      const m = await load(f);
      const ms = performance.now() - t0;
      const exp = EXPECTED_EXPORTS[f] || [];
      const missing = exp.filter(k => !(k in m));
      const names = Object.keys(m);
      const detail = `${names.length} exports${names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}` : ''} · ${ms.toFixed(0)} ms`;
      if (missing.length) rows.push(row('modules', f, 'FAIL', `missing export(s): ${missing.join(', ')}\n${detail}`));
      else rows.push(row('modules', f, ms > 1500 ? 'WARN' : 'PASS', ms > 1500 ? `slow import (${ms.toFixed(0)} ms)\n${detail}` : detail));
    } catch (e) {
      rows.push(row('modules', f, 'FAIL', `import threw: ${String(e?.message || e).split('\n')[0]}`));
    }
  }
  return rows;
}

async function suitePurity() {
  const rows = [];
  const files = walk(path.join(ROOT, 'src/dsp'), ['.js', '.mjs']);
  if (!files.length) return [row('purity', 'src/dsp', 'SKIP', 'no DSP sources')];
  const rules = [
    [/\bMath\.random\s*\(/, 'FAIL', 'Math.random() (use util.js Rng)'],
    [/(^|[^.\w$])(window|document|navigator|localStorage|sessionStorage)\s*[.[]/, 'FAIL', 'browser global'],
    [/(^|[^.\w$])process\s*\.\s*(env|argv|exit|cwd|hrtime|nextTick|stdout|stderr|memoryUsage|cpuUsage)\b/, 'FAIL', 'Node `process` global'],
    [/\b(AudioContext|OfflineAudioContext|AudioWorkletNode)\b/, 'FAIL', 'Web Audio API in DSP'],
    [/\brequire\s*\(/, 'FAIL', 'require()'],
    [/\b(setTimeout|setInterval|requestAnimationFrame|fetch)\s*\(/, 'FAIL', 'timer/network API in DSP'],
    [/\bconsole\.(log|warn|error|info)\s*\(/, 'WARN', 'console output in DSP'],
    [/\bdebugger\b/, 'WARN', 'debugger statement'],
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const code = stripComments(src).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    const probs = [];
    let st = 'PASS';
    for (const [re, sev, msg] of rules) {
      const lines = code.split('\n');
      const hit = lines.findIndex(l => re.test(l));
      if (hit >= 0) { probs.push(`${sev === 'FAIL' ? '✗' : '!'} ${msg} (line ~${hit + 1})`); st = worst([st, sev]); }
    }
    for (const spec of importsOf(src)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) { probs.push(`✗ non-relative import '${spec}'`); st = 'FAIL'; continue; }
      if (!spec.endsWith('.js')) { probs.push(`✗ import without .js extension '${spec}'`); st = 'FAIL'; continue; }
      if (!fs.existsSync(path.resolve(path.dirname(f), spec))) { probs.push(`✗ import target missing '${spec}'`); st = 'FAIL'; }
    }
    rows.push(row('purity', rel(f), st, probs.join('\n')));
  }
  const pass = rows.filter(r => r.status === 'PASS');
  const other = rows.filter(r => r.status !== 'PASS');
  return [row('purity', `${pass.length}/${rows.length} DSP files clean`, other.length ? worst(other.map(r => r.status)) : 'PASS',
    'no Math.random / browser or Node globals / timers; relative .js imports that resolve'), ...other];
}

function nodeCheck(file) {
  return new Promise(resolve => execFile(process.execPath, ['--check', file], { timeout: 20000 }, (err, _o, stderr) => resolve(err ? (stderr || err.message).trim() : null)));
}

async function suiteSyntax() {
  const rows = [];
  const files = [...walk(path.join(ROOT, 'src'), ['.js', '.mjs']), ...walk(path.join(ROOT, 'tools'), ['.js', '.mjs'])];
  const errs = [];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < files.length) {
      const f = files[i++];
      const e = await nodeCheck(f);
      if (e) errs.push([f, e]);
    }
  }));
  const brief = e => {
    const lines = e.split('\n');
    const loc = (lines[0].match(/:(\d+)$/) || [])[1];
    const msg = lines.find(l => /^\w*Error\b/.test(l)) || lines.filter(Boolean).slice(-1)[0];
    return `${loc ? `line ${loc}: ` : ''}${msg}`;
  };
  rows.push(row('syntax', `node --check (${files.length} files)`, errs.length ? 'FAIL' : 'PASS', errs.map(([f, e]) => `✗ ${rel(f)} ${brief(e)}`).join('\n')));
  // Import graph of browser-side code (ui, worklet, presets): relative targets must exist, no bare specifiers.
  const probs = [];
  const browser = [...walk(path.join(ROOT, 'src'), ['.js', '.mjs'])];
  for (const f of browser) {
    const src = fs.readFileSync(f, 'utf8');
    for (const spec of importsOf(src)) {
      if (/^(https?:)?\/\//.test(spec)) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) { probs.push(`✗ ${rel(f)}: bare import '${spec}' (no bundler)`); continue; }
      const target = spec.startsWith('/') ? path.join(ROOT, spec) : path.resolve(path.dirname(f), spec);
      if (!fs.existsSync(target)) probs.push(`✗ ${rel(f)}: import target missing '${spec}'`);
    }
    // new URL('x', import.meta.url) references (worklet module, assets)
    const re = /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    let m;
    while ((m = re.exec(src))) if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) probs.push(`✗ ${rel(f)}: URL target missing '${m[1]}'`);
  }
  rows.push(row('syntax', `import graph (${browser.length} files under src/)`, probs.length ? 'FAIL' : 'PASS', probs.slice(0, 12).join('\n')));
  // index.html references
  const index = path.join(ROOT, 'index.html');
  if (!fs.existsSync(index)) rows.push(row('syntax', 'index.html', 'FAIL', 'missing index.html'));
  else {
    const html = fs.readFileSync(index, 'utf8');
    const refs = [...html.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"'#?]+)[^"']*["']/gi)].map(m => m[1]).filter(r => !/^(https?:|data:|mailto:|\/\/)/.test(r));
    const missing = refs.filter(r => !fs.existsSync(path.join(ROOT, r.startsWith('/') ? r : r)));
    const inline = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m => importsOf(m[1]));
    const missInline = inline.filter(s => s.startsWith('.') || s.startsWith('/')).filter(s => !fs.existsSync(path.join(ROOT, s)));
    const all = [...missing, ...missInline];
    rows.push(row('syntax', `index.html (${refs.length + inline.length} local refs)`, all.length ? 'FAIL' : 'PASS', all.map(m => `✗ missing ${m}`).join('\n')));
  }
  return rows;
}

async function suiteParams() {
  const P = await tryLoad('src/dsp/params.js');
  if (!P) return [row('params', 'schema', 'SKIP', 'params.js unavailable')];
  const probs = [], warns = [];
  const ids = new Set();
  for (const p of P.PARAMS) {
    if (ids.has(p.id)) probs.push(`duplicate id ${p.id}`);
    ids.add(p.id);
    if (!p.label || !p.zh) warns.push(`${p.id}: missing label/zh`);
    if (p.type === 'enum') { if (!p.options.includes(p.def)) probs.push(`${p.id}: default '${p.def}' not an option`); continue; }
    if (p.type === 'bool') continue;
    if (!(p.def >= p.min && p.def <= p.max)) probs.push(`${p.id}: default ${p.def} outside [${p.min}, ${p.max}]`);
    if (p.curve === 'exp' && !(p.min > 0)) probs.push(`${p.id}: exp curve needs min > 0`);
    const rt = P.fromNorm(p, P.toNorm(p, p.def));
    if (Math.abs(rt - p.def) > 1e-6 * Math.max(1, Math.abs(p.def)) + (p.type === 'int' ? 0.5 : 0)) probs.push(`${p.id}: toNorm/fromNorm round-trip ${p.def} → ${rt}`);
    if (P.GROUPS && p.group && !P.GROUPS[p.group]) warns.push(`${p.id}: group '${p.group}' not in GROUPS`);
  }
  for (const d of P.MOD_DESTS || []) if (d !== 'none' && !ids.has(d)) probs.push(`MOD_DESTS: unknown ${d}`);
  const arr = P.toValueArray(P.resolveParams({}));
  if (arr.length !== P.PARAM_COUNT || [...arr].some(x => !Number.isFinite(x))) probs.push('toValueArray(defaults) not finite/complete');
  return [row('params', `schema (${P.PARAMS.length} params, ${(P.MOD_DESTS || []).length - 1} mod dests)`, probs.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS',
    [...probs.slice(0, 8).map(x => `✗ ${x}`), ...warns.slice(0, 5).map(x => `! ${x}`)].join('\n'))];
}

async function suiteTools() {
  const rows = [];
  const A = await import('./analyze.mjs');
  const W = await import('./wav.mjs');
  const G = await import('./png.mjs');
  const check = (name, fn) => {
    try { const [ok, detail] = fn(); rows.push(row('tools', name, ok ? 'PASS' : 'FAIL', detail)); }
    catch (e) { rows.push(row('tools', name, 'FAIL', `threw ${e.message}`)); }
  };
  const sine = (f, a, sec, sr = 48000, ph = 0) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => a * Math.sin(2 * Math.PI * f * i / sr + ph));
  check('analyze: FFT vs direct DFT', () => {
    const n = 64, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.7); im[i] = 0.2 * Math.sin(i); }
    const r0 = re.slice(), i0 = im.slice();
    A.getFFT(n).transform(re, im);
    let err = 0;
    for (let k = 0; k < n; k++) {
      let a = 0, b = 0;
      for (let t = 0; t < n; t++) { const w = (-2 * Math.PI * k * t) / n; a += r0[t] * Math.cos(w) - i0[t] * Math.sin(w); b += r0[t] * Math.sin(w) + i0[t] * Math.cos(w); }
      err = Math.max(err, Math.abs(a - re[k]), Math.abs(b - im[k]));
    }
    return [err < 1e-9, `max error ${err.toExponential(1)}`];
  });
  check('analyze: BS.1770 loudness references', () => {
    const x = sine(997, 1, 3), q = sine(997, 0.1, 3), z = new Float32Array(x.length);
    const a = A.loudness(x, x, 48000).integrated, b = A.loudness(q, q, 48000).integrated, c = A.loudness(x, z, 48000).integrated;
    const x44 = sine(997, 1, 3, 44100), a44 = A.loudness(x44, x44, 44100).integrated;
    return [Math.abs(a) < 0.05 && Math.abs(b + 20) < 0.05 && Math.abs(c + 3.01) < 0.05 && Math.abs(a44) < 0.05,
      `0 dBFS 997 Hz stereo ${a.toFixed(3)} LUFS (ref 0) · −20 dBFS ${b.toFixed(3)} (ref −20) · L only ${c.toFixed(3)} (ref −3.01) · @44.1k ${a44.toFixed(3)}`];
  });
  check('analyze: true peak (fs/4 sine at 45°)', () => {
    const x = sine(12000, 1, 0.1, 48000, Math.PI / 4);
    const tp = A.truePeak(x);
    return [Math.abs(tp - 1) < 0.02, `sample peak 0.707 → true peak ${tp.toFixed(4)} (ideal 1.0)`];
  });
  check('analyze: metrics on a synthetic note', () => {
    const sr = 48000, n = 3 * sr, L = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr; const env = t < 0.05 ? t / 0.05 : t < 1.5 ? 1 : Math.exp(-(t - 1.5) * 6.9078); L[i] = 0.5 * env * Math.sin(2 * Math.PI * 440 * t); }
    const m = A.analyze(L, L, sr, { lastNoteOff: 1.5 });
    const ok = Math.abs(m.peakDb + 6.02) < 0.1 && Math.abs(m.attackTime - 0.04) < 0.005 && Math.abs(m.release.t60 - 1) < 0.05 && Math.abs(m.peakFreqHz - 440) < 1 && m.correlation > 0.999 && m.width < 1e-3;
    return [ok, `peak ${m.peakDb} dBFS · attack ${m.attackTime}s (ref 0.04) · release T60 ${m.release.t60}s (ref 1.0) · peak freq ${m.peakFreqHz} Hz · corr ${m.correlation}`];
  });
  check('wav: 16/24/32-bit round trip', () => {
    const L = sine(440, 0.9, 0.2), R = sine(660, -0.5, 0.2);
    const errs = [16, 24, 32].map(bitDepth => {
      const d = W.decodeWav(W.encodeWav([L, R], 48000, { bitDepth }));
      let e = 0;
      for (let i = 0; i < L.length; i++) e = Math.max(e, Math.abs(d.channels[0][i] - L[i]), Math.abs(d.channels[1][i] - R[i]));
      return e;
    });
    return [errs[0] < 1.2e-4 && errs[1] < 3e-7 && errs[2] === 0, `max error 16-bit ${errs[0].toExponential(1)} · 24-bit ${errs[1].toExponential(1)} · float ${errs[2]}`];
  });
  check('png: encode/decode + spectrogram', () => {
    const r = new G.Raster(64, 32, '#07080d');
    r.line(0, 0, 63, 31, '#5cf2ff'); r.text(2, 2, 'Hz 440', '#ffffff');
    const d = G.decodePng(r.toPng());
    let same = d.width === 64 && d.height === 32;
    for (let i = 0; i < r.data.length && same; i++) same = r.data[i] === d.pixels[i];
    const x = sine(440, 0.5, 0.5);
    const spec = G.decodePng(A.spectrogram(x, x, 48000, { width: 400, height: 160 }));
    return [same && spec.width === 400 && spec.height === 160, `lossless round trip ${same} · spectrogram ${spec.width}×${spec.height}`];
  });
  check('phrases: sequencer format & timing', () => {
    const probs = [];
    for (const [id, p] of Object.entries(PHRASES)) {
      if (!(p.bpm > 0) || !(p.lengthBeats > 0) || !Array.isArray(p.events)) probs.push(`${id}: bad header`);
      for (const e of p.events) if (e.type !== 'on' || !(e.dur > 0) || !(e.vel > 0 && e.vel <= 1) || !(e.note >= 0 && e.note <= 127) || e.beat < 0 || e.beat >= p.lengthBeats) probs.push(`${id}: bad event ${JSON.stringify(e)}`);
      const held = new Map();
      for (const e of phraseToTimedEvents(p)) {
        const k = held.get(e.note) || 0;
        if (e.type === 'on' && k) probs.push(`${id}: note ${e.note} retriggered while held at ${e.time}s`);
        held.set(e.note, k + (e.type === 'on' ? 1 : -1));
      }
    }
    return [!probs.length, probs.length ? probs.slice(0, 4).join('; ') : `${Object.keys(PHRASES).length} phrases: ${Object.keys(PHRASES).join(', ')}`];
  });
  return rows;
}

// ───────────────────────── Engine jobs ─────────────────────────
function groupParams(P, prefix) {
  return P.PARAMS.filter(p => p.id.startsWith(prefix + '.') && !/\.(on|level|pan|filt)$/.test(p.id));
}

function paramSets(P, prefix, fixed, mode) {
  const ps = groupParams(P, prefix);
  const numeric = ps.filter(p => (p.type === 'float' || p.type === 'int') && !(p.id in fixed));
  const sets = [['default', {}]];
  const minS = {}, maxS = {};
  for (const p of numeric) { minS[p.id] = p.min; maxS[p.id] = p.max; }
  sets.push(['min', minS], ['max', maxS]);
  // every option of every enum/bool not fixed by the config, on top of defaults
  for (const p of ps) {
    if (p.id in fixed || (p.type !== 'enum' && p.type !== 'bool')) continue;
    for (const o of p.type === 'enum' ? p.options : [true, false]) if (o !== p.def) sets.push([`${p.id.split('.').pop()}=${o}`, { [p.id]: o }]);
  }
  const nRand = mode === 'quick' ? 1 : mode === 'full' ? 6 : 3;
  const rnd = new Rand(0xabc + prefix.length);
  for (let k = 0; k < nRand; k++) {
    const s = {};
    for (const p of ps) {
      if (p.id in fixed) continue;
      if (p.type === 'enum') s[p.id] = rnd.pick(p.options);
      else if (p.type === 'bool') s[p.id] = rnd.next() < 0.5;
      else {
        const u = rnd.next();
        let v = u < 0.3 ? p.min : u < 0.6 ? p.max : p.curve === 'exp' ? p.min * (p.max / p.min) ** rnd.next() : p.min + (p.max - p.min) * rnd.next();
        if (p.type === 'int') v = Math.round(v);
        s[p.id] = v;
      }
    }
    sets.push([`rand${k + 1}`, s]);
  }
  return sets;
}

function engineConfigs(P, e) {
  const on = { [`${e.prefix}.on`]: true, [`${e.prefix}.level`]: 1 };
  if (e.label === 'osc') {
    const c = [['classic', { ...on, 'osc1.mode': 'classic' }]];
    for (const t of P.PARAM_BY_ID['osc1.table'].options) c.push([`wavetable/${t}`, { ...on, 'osc1.mode': 'wavetable', 'osc1.table': t }]);
    return c;
  }
  if (e.label === 'fm') return Array.from({ length: 8 }, (_, i) => [`algo ${i + 1}`, { ...on, 'fm.algo': i + 1 }]);
  if (e.label === 'phys') {
    const c = [];
    for (const m of P.PARAM_BY_ID['phys.model'].options) for (const x of P.PARAM_BY_ID['phys.exciter'].options) c.push([`${m}/${x}`, { ...on, 'phys.model': m, 'phys.exciter': x }]);
    return c;
  }
  return [['noise', on]];
}

function renderEngineOnce(Cls, P, prefix, values, { sr, note, vel = 0.8, hold = 0.2, rel = 0.15, rapid = null, legatoAt = -1 }) {
  const eng = new Cls(sr, prefix);
  const v = P.toValueArray(P.resolveParams(values));
  const f = 440 * 2 ** ((note - 69) / 12);
  const n = Math.round((hold + rel) * sr), off = Math.round(hold * sr), leg = legatoAt > 0 ? Math.round(legatoAt * sr) : -1;
  const L = new Float32Array(n), R = new Float32Array(n);
  eng.noteOn(note, vel, f, v, false);
  let freq = f, released = false, legDone = false;
  for (let pos = 0; pos < n; pos += 16) {
    const m = Math.min(16, n - pos);
    if (!released && pos >= off) { eng.noteOff(); released = true; }
    if (!legDone && leg > 0 && pos >= leg) { freq = f * 1.5; eng.noteOn(note + 7, vel, freq, v, true); legDone = true; }
    if (rapid) rapid(v);
    eng.process(v, freq, L, R, pos, m);
  }
  return { L, R, eng, v, off };
}

async function jobEngineConfig({ engine, configName, config, mode }) {
  const P = await load('src/dsp/params.js');
  const mod = await tryLoad(engine.file);
  const Cls = engineClass(mod, engine.cls);
  const agg = new Agg('engines', `${engine.label} ${configName}`);
  if (!Cls) return [row('engines', `${engine.label} ${configName}`, 'SKIP', `${engine.file} unavailable`)];
  const notes = mode === 'quick' ? [24, 60, 108] : mode === 'full' ? [24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96, 102, 108] : [24, 48, 72, 96, 108];
  const sets = paramSets(P, engine.prefix, config, mode);
  const hold = engine.label === 'phys' ? 0.25 : 0.2;
  const run = (setName, vals, sr, note, extra = {}) => {
    const where = `${setName}/n${note}/${sr / 1000}k${extra.tag ? '/' + extra.tag : ''}`;
    let res;
    try {
      res = renderEngineOnce(Cls, P, engine.prefix, { ...vals, ...config }, { sr, note, hold, vel: setName === 'min' ? 0.01 : setName === 'max' ? 1 : 0.8, ...extra });
    } catch (e) { agg.fail(`${where}: threw ${String(e?.message || e).split('\n')[0]}`); return null; }
    const st = stats(res.L, res.R);
    agg.sample(where, st);
    if (st.nan) agg.fail(`${where}: ${st.nan} NaN/Inf samples`);
    else if (st.peak > 16) agg.fail(`${where}: unbounded output (peak ${st.peak.toFixed(1)})`);
    else if (st.peak > 3) agg.warn(`${where}: hot output (peak ${st.peak.toFixed(2)}; engines should be ≈ ±1)`);
    // DC is only meaningful over many cycles: default params (no octave shift), notes ≥ C3.
    if (setName === 'default' && note >= 48 && !extra.tag) {
      const hs = stats(res.L, res.R, Math.round(0.02 * sr), res.off);
      if (Math.abs(hs.dc) > 0.05) agg.warn(`${where}: DC ${hs.dc.toFixed(3)}`);
    }
    return res;
  };
  for (const [setName, vals] of sets) for (const note of notes) run(setName, vals, 48000, note);
  const srNotes = mode === 'quick' ? [60] : [24, 108];
  for (const sr of [44100, 96000]) for (const [setName, vals] of sets.slice(0, mode === 'quick' ? 2 : 3)) for (const note of srNotes) run(setName, vals, sr, note);
  // rapid modulation of every mod-able param each control block
  const modP = groupParams(P, engine.prefix).filter(p => p.mod && (p.type === 'float' || p.type === 'int'));
  const rnd = new Rand(99);
  const rapid = v => { for (const p of modP) v[p.index] = p.min + (p.max - p.min) * rnd.next(); };
  for (const note of [36, 84]) run('rapid', {}, 48000, note, { rapid, tag: 'rapid-mod' });
  run('legato', {}, 48000, 60, { legatoAt: 0.1, tag: 'legato' });
  // ring-out: engines must report inactive after release, and be quiet when they do
  if (engine.label === 'fm' || engine.label === 'phys') {
    const sr = 48000;
    const eng = new Cls(sr, engine.prefix);
    const v = P.toValueArray(P.resolveParams({ ...config }));
    const L = new Float32Array(16), R = new Float32Array(16);
    eng.noteOn(60, 0.8, 261.63, v, false);
    for (let i = 0; i < sr * 0.3; i += 16) eng.process(v, 261.63, L, R, 0, 16);
    eng.noteOff();
    let t = 0, lastPk = 0, inactiveAt = -1;
    const limit = 12 * sr;
    const recent = new Float32Array(150); // ~50 ms of 16-sample block peaks
    let ri = 0;
    for (; t < limit; t += 16) {
      if (!eng.isActive()) { inactiveAt = t; break; }
      eng.process(v, 261.63, L, R, 0, 16);
      let pk = 0;
      for (let i = 0; i < 16; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
      recent[ri++ % recent.length] = pk;
    }
    for (const x of recent) lastPk = Math.max(lastPk, x);
    if (inactiveAt < 0) agg.warn(`default/${configName}: still isActive() 12 s after noteOff`);
    else {
      agg.info(`inactive ${(inactiveAt / sr).toFixed(2)}s after off`);
      if (lastPk > 0.01) agg.warn(`isActive() → false while output still at ${dB(lastPk).toFixed(0)} dBFS (click when voice is freed)`);
    }
  }
  return [agg.row()];
}

/** Precise frequency of a (nearly) pure tone via upward zero crossings with linear interpolation. */
function zcFreq(x, sr, from, to) {
  let first = -1, last = -1, count = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = t; else count++;
      last = t;
    }
  }
  return count > 0 ? (count * sr) / (last - first) : NaN;
}

/** Frequency of the strongest spectral peak within ±range semitones of `expect` (BH window, parabolic interp.). */
function peakFreqNear(x, sr, expect, from, range = 1) {
  const N = 65536;
  const fft = getFFT(N), w = makeWindow('blackmanharris', N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const len = Math.min(N, x.length - from);
  for (let i = 0; i < len; i++) re[i] = x[from + i] * w[i];
  fft.transform(re, im);
  const mag = k => Math.log(re[k] * re[k] + im[k] * im[k] + 1e-30);
  const k0 = Math.floor(((expect * 2 ** (-range / 12)) / sr) * N), k1 = Math.ceil(((expect * 2 ** (range / 12)) / sr) * N);
  let best = k0, bv = -Infinity;
  for (let k = Math.max(1, k0); k <= Math.min(N / 2 - 2, k1); k++) { const m = mag(k); if (m > bv) { bv = m; best = k; } }
  const a = mag(best - 1), b = mag(best), c = mag(best + 1);
  const d = a - 2 * b + c;
  return ((best + (d ? (0.5 * (a - c)) / d : 0)) * sr) / N;
}

/** Inharmonic (aliasing) energy relative to harmonic energy, in dB. */
function aliasRatio(x, sr, f0, from) {
  const N = 16384;
  const fft = getFFT(N), w = makeWindow('blackmanharris', N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[from + i] ?? 0) * w[i];
  fft.transform(re, im);
  const bin = sr / N;
  let h = 0, a = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = k * bin;
    if (f < 20) continue;
    const p = re[k] * re[k] + im[k] * im[k];
    const hn = Math.max(1, Math.round(f / f0));
    if (Math.abs(f - hn * f0) <= 4.5 * bin) h += p; else a += p;
  }
  return 10 * Math.log10((a + 1e-30) / (h + 1e-30));
}

async function jobEngineQuality({ engine }) {
  const P = await load('src/dsp/params.js');
  const Cls = engineClass(await tryLoad(engine.file), engine.cls);
  if (!Cls) return [row('engines', `${engine.label} quality`, 'SKIP', `${engine.file} unavailable`)];
  const rows = [];
  const pure = {
    osc: { 'osc1.on': true, 'osc1.mode': 'classic', 'osc1.shape': 0, 'osc1.unison': 1, 'osc1.drift': 0, 'osc1.detune': 0, 'osc1.phase': 'reset', 'osc1.fine': 0, 'osc1.sync': 0 },
    fm: { 'fm.on': true, 'fm.algo': 1, 'fm.op2.level': 0, 'fm.op3.level': 0, 'fm.op4.level': 0, 'fm.feedback': 0, 'fm.op1.s': 1, 'fm.op1.d': 20 },
    phys: { 'phys.on': true, 'phys.model': 'string', 'phys.exciter': 'pluck', 'phys.inharm': 0, 'phys.decay': 8, 'phys.spread': 0 },
  }[engine.label];
  // Tuning
  if (pure) {
    const devs = [];
    let worstC = 0, worstAt = '';
    for (const sr of [44100, 48000, 96000]) {
      for (const note of engine.label === 'phys' ? [36, 48, 60, 72, 84, 96] : [33, 45, 57, 69, 81, 93, 105]) {
        const { L } = renderEngineOnce(Cls, P, engine.prefix, pure, { sr, note, hold: 0.8, rel: 0.01 });
        const expect = 440 * 2 ** ((note - 69) / 12);
        const f = engine.label === 'phys' ? peakFreqNear(L, sr, expect, Math.round(0.05 * sr)) : zcFreq(L, sr, Math.round(0.1 * sr), Math.round(0.75 * sr));
        const c = 1200 * Math.log2(f / expect);
        devs.push(c);
        if (!(Math.abs(c) <= Math.abs(worstC))) { worstC = c; worstAt = `n${note}@${sr / 1000}k`; }
      }
    }
    const bad = Number.isNaN(worstC) || Math.abs(worstC) > 20;
    rows.push(row('engines', `${engine.label} tuning`, bad ? 'FAIL' : Math.abs(worstC) > 3 ? 'WARN' : 'PASS',
      `worst ${fmt(worstC, 2)} cents (${worstAt}) over ${devs.length} notes × 44.1/48/96 kHz${engine.label === 'phys' ? ' (string fundamental)' : ''}`));
  }
  // Aliasing indicator (osc): saw at high notes
  if (engine.label === 'osc') {
    try {
      const r2 = renderEngineOnce(Cls, P, 'osc2', { 'osc2.on': true, 'osc2.unison': 4, 'osc2.mode': 'wavetable', 'osc2.table': 'growl' }, { sr: 48000, note: 48, hold: 0.2, rel: 0.05 });
      const st = stats(r2.L, r2.R);
      rows.push(row('engines', "osc with prefix 'osc2'", st.nan ? 'FAIL' : st.peak < 1e-3 ? 'FAIL' : 'PASS', `peak ${st.peak.toFixed(2)}${st.nan ? ` · ${st.nan} NaN` : ''}${st.peak < 1e-3 ? ' · silent (reads osc1.* instead of osc2.*?)' : ''}`));
    } catch (e) { rows.push(row('engines', "osc with prefix 'osc2'", 'FAIL', `threw ${e.message}`)); }
    const parts = [];
    for (const [name, vals] of [
      ['classic saw', { 'osc1.on': true, 'osc1.mode': 'classic', 'osc1.shape': 2 / 3, 'osc1.unison': 1, 'osc1.drift': 0, 'osc1.detune': 0 }],
      ['classic square', { 'osc1.on': true, 'osc1.mode': 'classic', 'osc1.shape': 1, 'osc1.unison': 1, 'osc1.drift': 0, 'osc1.detune': 0 }],
      ['wavetable analog', { 'osc1.on': true, 'osc1.mode': 'wavetable', 'osc1.table': 'analog', 'osc1.shape': 2 / 3, 'osc1.unison': 1, 'osc1.drift': 0, 'osc1.detune': 0 }],
      ['classic sync 0.5', { 'osc1.on': true, 'osc1.mode': 'classic', 'osc1.shape': 2 / 3, 'osc1.unison': 1, 'osc1.drift': 0, 'osc1.detune': 0, 'osc1.sync': 0.5 }],
    ]) {
      const res = [84, 96, 103].map(note => {
        const { L } = renderEngineOnce(Cls, P, 'osc1', vals, { sr: 44100, note, hold: 0.5, rel: 0.01 });
        return `${aliasRatio(L, 44100, 440 * 2 ** ((note - 69) / 12), 4410).toFixed(0)}`;
      });
      parts.push(`${name}: ${res.join('/')} dB`);
    }
    rows.push(row('engines', 'osc aliasing (inharmonic/harmonic @44.1k, C6/C7/G7)', 'INFO', parts.join(' · ')));
  }
  // CPU cost per voice (thread CPU time)
  const cpuCases = {
    osc: [['classic saw ×1', { 'osc1.on': true }], ['classic saw ×7', { 'osc1.on': true, 'osc1.unison': 7 }], ['wavetable ×7', { 'osc1.on': true, 'osc1.mode': 'wavetable', 'osc1.table': 'vowels', 'osc1.unison': 7 }]],
    fm: [['algo 1', { 'fm.on': true, 'fm.algo': 1 }], ['algo 8 + fb', { 'fm.on': true, 'fm.algo': 8, 'fm.feedback': 0.5 }]],
    phys: [['string/pluck', { 'phys.on': true }], ['bell/mallet', { 'phys.on': true, 'phys.model': 'bell', 'phys.exciter': 'mallet' }], ['plate/bow', { 'phys.on': true, 'phys.model': 'plate', 'phys.exciter': 'bow' }]],
    noise: [['noise', { 'noise.on': true }]],
  }[engine.label];
  const cpu = [];
  for (const [name, vals] of cpuCases) {
    for (let k = 0; k < 3; k++) renderEngineOnce(Cls, P, engine.prefix, vals, { sr: 48000, note: 60, hold: 0.3, rel: 0 }); // JIT warm-up
    const c0 = cpuMs();
    renderEngineOnce(Cls, P, engine.prefix, vals, { sr: 48000, note: 60, hold: 2, rel: 0 });
    const ns = ((cpuMs() - c0) * 1e6) / (2 * 48000);
    cpu.push(`${name} ${ns.toFixed(0)} ns/smp (${((ns * 48000) / 1e7).toFixed(2)}% core)`);
  }
  rows.push(row('engines', `${engine.label} CPU per voice @48k`, 'INFO', cpu.join(' · ')));
  // Loudness vs osc saw through the full voice (the voice applies the phys PHYS_TRIM make-up, voice.js), same
  // `level`, FX + filter off, C4, velocity 1: momentary-max LUFS difference (spec: loudness-matched within a few
  // LU) and the peak-to-loudness ratio (PLR = sample peak − momentary-max LUFS). The old check rendered the bare
  // engine (no PHYS_TRIM) and compared 1 s RMS of a decaying pluck with a sustained saw: it reported −16 dB for a
  // real gap of ≈ 5 LU and missed the actual issue — a pluck's peaks sit ≈ 9 dB higher than a saw's at equal
  // loudness, so boosting phys presets to match loudness drives the limiter on chords.
  if (engine.label !== 'osc') {
    const S = await tryLoad('src/dsp/synth.js');
    if (S?.renderOffline) {
      const sr = 48000, lvl = P.PARAM_BY_ID['osc1.level'].def;
      const base = { 'reverb.on': false, 'chorus.on': false, 'delay.on': false, 'phaser.on': false, 'drive.on': false, 'comp.amount': 0, 'filter.on': false, 'filter2.on': false, 'aenv.s': 1, 'aenv.r': 0.05 };
      const measure = p => {
        const { L, R } = S.renderOffline({ params: { ...base, ...p }, macros: [] }, [{ time: 0, type: 'on', note: 60, vel: 1 }, { time: 1, type: 'off', note: 60 }], 1.2, sr);
        const lu = loudness(L.subarray(0, sr), R.subarray(0, sr), sr);
        const pk = peakOf(L, R, 0, sr);
        return { mom: lu.momentaryMax ?? -120, plr: dB(pk) - (lu.momentaryMax ?? -120) };
      };
      const saw = measure({});
      const off = { 'osc1.on': false, [`${engine.prefix}.on`]: true, [`${engine.prefix}.level`]: lvl };
      const cases = {
        fm: [['default', {}]],
        phys: [['string/pluck', {}], ['bar/mallet', { 'phys.model': 'bar', 'phys.exciter': 'mallet' }], ['string/bow', { 'phys.exciter': 'bow' }]],
        noise: [['white', {}]],
      }[engine.label] || [['default', {}]];
      const parts = [], warns = [];
      for (const [name, p] of cases) {
        const r = measure({ ...off, ...p });
        const d = r.mom - saw.mom, xp = r.plr - saw.plr;
        parts.push(`${name} ${d >= 0 ? '+' : ''}${d.toFixed(1)} LU, PLR ${r.plr.toFixed(1)} dB`);
        if (Math.abs(d) > 6) warns.push(`${name}: ${d.toFixed(1)} LU vs the saw at equal level (spec: loudness-matched)`);
        if (xp > 12) warns.push(`${name}: peaks ${xp.toFixed(1)} dB higher than a saw of the same loudness (limiter on chords)`);
      }
      rows.push(row('engines', `${engine.label} loudness vs osc saw (full voice)`, warns.length ? 'WARN' : 'INFO',
        [`${parts.join(' · ')} (saw PLR ${saw.plr.toFixed(1)} dB; momentary-max LUFS, C4, equal level, FX/filter off)`, ...warns.map(w => `! ${w}`)].join('\n')));
    }
  }
  return rows;
}

// ───────────────────────── Filter jobs ─────────────────────────
async function jobFilter({ kind, type, mode }) {
  const F = await tryLoad('src/dsp/filter.js');
  const P = await load('src/dsp/params.js');
  const name = kind === 'voice' ? `VoiceFilter ${P.FILTER_TYPES[type]}` : `SVFilter ${['lp', 'hp', 'bp', 'notch'][type]}`;
  if (!F || !F.VoiceFilter) return [row('filters', name, 'SKIP', 'filter.js unavailable')];
  const agg = new Agg('filters', name);
  const srs = mode === 'quick' ? [48000] : [44100, 48000, 96000];
  const resList = mode === 'quick' ? [0, 0.9, 1] : [0, 0.5, 0.9, 1];
  const drives = kind === 'voice' ? [0, 1] : [0];
  const mk = sr => (kind === 'voice' ? new F.VoiceFilter(sr) : new F.SVFilter(sr));
  const proc = (flt, L, R, pos, m, c0, c1, res, drive, vowel) => (kind === 'voice'
    ? flt.process(L, R, pos, m, type, c0, c1, res, drive, vowel)
    : flt.process(L, R, pos, m, type, c1, res));
  for (const sr of srs) {
    for (const res of resList) {
      for (const drive of drives) {
        const where = `${sr / 1000}k/res${res}/drv${drive}`;
        try {
          const flt = mk(sr);
          const n = Math.round(0.6 * sr), inEnd = Math.round(0.4 * sr);
          const L = new Float32Array(n), R = new Float32Array(n);
          const rnd = new Rand(7);
          let ph = 0;
          for (let i = 0; i < inEnd; i++) { ph = (ph + 110 / sr) % 1; const s = 0.4 * (2 * ph - 1) + 0.1 * rnd.bi(); L[i] = s; R[i] = s * 0.9 + 0.05 * rnd.bi(); }
          const cmax = Math.min(20000, 0.49 * sr);
          let prevC = 20;
          for (let pos = 0; pos < n; pos += 16) {
            const m = Math.min(16, n - pos);
            const t = Math.min(1, pos / inEnd);
            const c = pos < inEnd ? 20 * (cmax / 20) ** (t < 0.5 ? 2 * t : 2 - 2 * t) : 1000;
            proc(flt, L, R, pos, m, prevC, c, res, drive, t);
            prevC = c;
          }
          const st = stats(L, R);
          agg.sample(where, st);
          if (st.nan) agg.fail(`${where}: ${st.nan} NaN/Inf`);
          else if (st.peak > 50) agg.fail(`${where}: unstable (peak ${st.peak.toFixed(1)})`);
          else if (st.peak > 6) agg.warn(`${where}: hot (peak ${st.peak.toFixed(1)})`);
          const tail = peakOf(L, R, n - Math.round(0.05 * sr), n);
          const combish = kind === 'voice' && P.FILTER_TYPES[type] === 'comb';
          if (res <= 0.5 && !combish && tail > 1e-3 * Math.max(st.peak, 1e-9) && tail > 1e-4) agg.warn(`${where}: does not decay after input stops (tail ${dB(tail).toFixed(0)} dBFS)`);
        } catch (e) { agg.fail(`${where}: threw ${String(e?.message || e).split('\n')[0]}`); }
      }
    }
  }
  // fast modulation: random cutoff jumps every 16 samples, max resonance
  for (const sr of [48000]) {
    const flt = mk(sr);
    const n = sr, L = new Float32Array(n), R = new Float32Array(n);
    const rnd = new Rand(3);
    for (let i = 0; i < n; i++) { L[i] = 0.5 * rnd.bi(); R[i] = 0.5 * rnd.bi(); }
    let prev = 1000;
    try {
      for (let pos = 0; pos < n; pos += 16) {
        const c = 20 * 1000 ** rnd.next();
        proc(flt, L, R, pos, 16, prev, c, 1, 1, rnd.next());
        prev = c;
      }
      const st = stats(L, R);
      agg.sample('fastmod', st);
      if (st.nan) agg.fail(`fast cutoff modulation: NaN/Inf`);
      else if (st.peak > 50) agg.fail(`fast cutoff modulation: unstable (peak ${st.peak.toFixed(1)})`);
    } catch (e) { agg.fail(`fastmod threw ${e.message}`); }
  }
  // out-of-range robustness (warn only)
  try {
    const flt = mk(44100);
    const L = new Float32Array(256).fill(0.5), R = new Float32Array(256).fill(-0.5);
    const bad = [[0, 0], [1e6, 1e6], [-50, 25000], [20000, 30000]];
    let pos = 0;
    for (const [c0, c1] of bad) { proc(flt, L, R, pos, 16, c0, c1, 1.3, 1.5, 1.2); pos += 16; }
    proc(flt, L, R, pos, 16, 1000, 1000, -0.2, -1, -1);
    const st = stats(L, R);
    if (st.nan) agg.warn('out-of-range args (cutoff 0/1e6/−50, res 1.3/−0.2) → NaN (voice clamps, but unsafe)');
  } catch (e) { agg.warn(`out-of-range args threw ${e.message}`); }
  return [agg.row()];
}

async function jobFilterResponse() {
  const F = await tryLoad('src/dsp/filter.js');
  const P = await load('src/dsp/params.js');
  if (!F?.filterResponse || !F?.VoiceFilter) return [row('filters', 'filterResponse', 'SKIP', 'filter.js unavailable')];
  const sr = 48000, rows = [];
  const freqs = new Float32Array(256).map((_, i) => 20 * 1000 ** (i / 255));
  let finite = true, lenOk = true;
  for (let t = 0; t < P.FILTER_TYPES.length; t++) {
    for (const c of [50, 1000, 15000]) for (const r of [0, 0.5, 1]) {
      const out = F.filterResponse(t, c, r, 0.5, 0.5, freqs, sr);
      if (!out || out.length !== freqs.length) lenOk = false;
      else for (const v of out) if (!Number.isFinite(v)) finite = false;
    }
  }
  rows.push(row('filters', 'filterResponse() output', finite && lenOk ? 'PASS' : 'FAIL', `${P.FILTER_TYPES.length} types × 3 cutoffs × 3 res${finite ? '' : ' · non-finite values'}${lenOk ? '' : ' · wrong length'}`));
  // Measured vs predicted magnitude (1/3-octave bands, white noise, linear regime)
  const bands = [];
  for (let k = -16; k <= 13; k++) bands.push(1000 * 2 ** (k / 3));
  const N = 4096, hop = 2048, fft = getFFT(N), w = makeWindow('hann', N);
  const parts = [];
  let worstAll = 0;
  for (let t = 0; t < P.FILTER_TYPES.length; t++) {
    const cutoff = P.FILTER_TYPES[t] === 'comb' ? 220 : 1000;
    const flt = new F.VoiceFilter(sr);
    const n = 3 * sr, X = new Float32Array(n), Y = new Float32Array(n), Yr = new Float32Array(n);
    const rnd = new Rand(11);
    for (let i = 0; i < n; i++) { X[i] = 0.05 * rnd.bi(); Y[i] = X[i]; Yr[i] = X[i]; }
    for (let pos = 0; pos < n; pos += 16) flt.process(Y, Yr, pos, 16, t, cutoff, cutoff, 0.3, 0, 0.5);
    const px = new Float64Array(N / 2), py = new Float64Array(N / 2);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let s = sr; s + N < n; s += hop) {
      for (let i = 0; i < N; i++) { re[i] = X[s + i] * w[i]; im[i] = Y[s + i] * w[i]; }
      fft.transform(re, im);
      for (let k = 1; k < N / 2; k++) {
        const k2 = N - k;
        const xr = 0.5 * (re[k] + re[k2]), xi = 0.5 * (im[k] - im[k2]);
        const yr = 0.5 * (im[k] + im[k2]), yi = 0.5 * (re[k2] - re[k]);
        px[k] += xr * xr + xi * xi; py[k] += yr * yr + yi * yi;
      }
    }
    // Predicted band power: average the analytic response over 16 points per 1/3-octave band.
    const SUB = 16, pf = new Float32Array(bands.length * SUB);
    bands.forEach((fc, bi) => { for (let j = 0; j < SUB; j++) pf[bi * SUB + j] = fc * 2 ** ((j + 0.5) / SUB / 3 - 1 / 6); });
    const pr = F.filterResponse(t, cutoff, 0.3, 0, 0.5, pf, sr);
    const pred = bands.map((_, bi) => { let a = 0; for (let j = 0; j < SUB; j++) a += 10 ** (pr[bi * SUB + j] / 10); return 10 * Math.log10(a / SUB); });
    let worstDev = 0, at = 0;
    bands.forEach((fc, bi) => {
      const k0 = Math.max(1, Math.floor((fc * 2 ** (-1 / 6) / sr) * N)), k1 = Math.min(N / 2 - 1, Math.ceil((fc * 2 ** (1 / 6) / sr) * N));
      let a = 0, b = 0;
      for (let k = k0; k <= k1; k++) { a += py[k]; b += px[k]; }
      if (!(b > 0) || !(pred[bi] > -24)) return;
      const meas = 10 * Math.log10(a / b);
      const dev = meas - pred[bi];
      if (Math.abs(dev) > Math.abs(worstDev)) { worstDev = dev; at = fc; }
    });
    worstAll = Math.max(worstAll, Math.abs(worstDev));
    parts.push(`${P.FILTER_TYPES[t]} ${worstDev >= 0 ? '+' : ''}${worstDev.toFixed(1)}dB@${at >= 1000 ? (at / 1000).toFixed(1) + 'k' : Math.round(at)}`);
  }
  rows.push(row('filters', 'UI curve vs measured (res 0.3, bands > −24 dB)', worstAll > 6 ? 'WARN' : 'PASS', `worst deviation per type: ${parts.join(' · ')}`));
  // Self-oscillation stability (ladder24 @ res 1)
  const flt = new F.VoiceFilter(sr);
  const n = sr, L = new Float32Array(n), R = new Float32Array(n);
  L[0] = 1; R[0] = 1;
  for (let pos = 0; pos < n; pos += 16) flt.process(L, R, pos, 16, 0, 1000, 1000, 1, 0, 0);
  const a1 = peakOf(L, R, Math.round(0.4 * sr), Math.round(0.5 * sr)), a2 = peakOf(L, R, Math.round(0.9 * sr), n);
  const osc = a2 > 1e-3;
  rows.push(row('filters', 'ladder24 self-oscillation @ res 1', !osc ? 'INFO' : Math.abs(dB(a2) - dB(a1)) > 3 ? 'WARN' : 'PASS',
    osc ? `sustains at ${dB(a2).toFixed(1)} dBFS (drift ${(dB(a2) - dB(a1)).toFixed(2)} dB over 0.5 s)` : `does not self-oscillate from an impulse (tail ${dB(a2).toFixed(0)} dBFS)`));
  return rows;
}

// ───────────────────────── FX jobs ─────────────────────────
const FX_GROUPS = ['drive', 'chorus', 'phaser', 'delay', 'reverb', 'eq'];
function fxConfigs(P, mode) {
  const fxP = P.PARAMS.filter(p => FX_GROUPS.includes(p.group) || p.id === 'comp.amount');
  const allOn = Object.fromEntries(['drive', 'chorus', 'phaser', 'delay', 'reverb'].map(g => [`${g}.on`, true]));
  const ext = pick => {
    const s = { ...allOn };
    for (const p of fxP) if ((p.type === 'float' || p.type === 'int') && !p.id.endsWith('.on')) s[p.id] = pick(p);
    return s;
  };
  const cfgs = [['all on · defaults', allOn], ['all on · max', ext(p => p.max)], ['all on · min', ext(p => p.min)]];
  const rnd = new Rand(0x5eed);
  for (let k = 0; k < (mode === 'quick' ? 1 : 3); k++) {
    const s = ext(p => (rnd.next() < 0.5 ? (rnd.next() < 0.5 ? p.min : p.max) : p.min + (p.max - p.min) * rnd.next()));
    for (const p of fxP) if (p.type === 'enum') s[p.id] = rnd.pick(p.options);
    cfgs.push([`all on · random ${k + 1}`, s]);
  }
  for (const t of P.PARAM_BY_ID['drive.type'].options) cfgs.push([`drive ${t} · amount 1`, { 'drive.on': true, 'drive.type': t, 'drive.amount': 1, 'drive.tone': 1 }]);
  for (const m of P.PARAM_BY_ID['chorus.mode'].options) cfgs.push([`chorus ${m} · depth 1 fb .9`, { 'chorus.on': true, 'chorus.mode': m, 'chorus.depth': 1, 'chorus.feedback': 0.9, 'chorus.rate': 10, 'chorus.mix': 1 }]);
  for (const s of P.PARAM_BY_ID['phaser.stages'].options) cfgs.push([`phaser ${s} stages · fb .95`, { 'phaser.on': true, 'phaser.stages': s, 'phaser.feedback': 0.95, 'phaser.depth': 1, 'phaser.mix': 1 }]);
  for (const s of P.PARAM_BY_ID['delay.sync'].options) for (const bpm of mode === 'quick' ? [240] : [40, 240]) {
    cfgs.push([`delay ${s} @${bpm}bpm · fb .95`, { 'delay.on': true, 'delay.sync': s, 'delay.feedback': 0.95, 'delay.pingpong': 1, 'delay.wobble': 1, 'delay.tone': 1, 'delay.mix': 1, 'global.bpm': bpm }]);
  }
  cfgs.push(['reverb huge · shimmer 1', { 'reverb.on': true, 'reverb.size': 1, 'reverb.decay': 30, 'reverb.shimmer': 1, 'reverb.mod': 1, 'reverb.damp': 0, 'reverb.mix': 1 }]);
  cfgs.push(['reverb tiny', { 'reverb.on': true, 'reverb.size': 0, 'reverb.decay': 0.2, 'reverb.predelay': 0, 'reverb.mix': 1 }]);
  cfgs.push(['eq ±12 · glue 1', { 'eq.low': 12, 'eq.mid': -12, 'eq.high': 12, 'eq.midfreq': 8000, 'comp.amount': 1 }]);
  return cfgs;
}

async function jobFx({ name, values, srs, toggle = false, sweep = false }) {
  const F = await tryLoad('src/dsp/fx/fxchain.js');
  const P = await load('src/dsp/params.js');
  if (!F?.FxChain) return [row('fx', name, 'SKIP', 'fxchain.js unavailable')];
  const agg = new Agg('fx', name);
  for (const sr of srs) {
    const where = `${sr / 1000}k`;
    try {
      const fx = new F.FxChain(sr);
      const eff = P.toValueArray(P.resolveParams(values));
      const bpm = eff[P.idx('global.bpm')];
      let T = 0;
      if (eff[P.idx('delay.on')] >= 0.5) {
        const beats = P.divToBeats(P.PARAM_BY_ID['delay.sync'].options[eff[P.idx('delay.sync')]]);
        T = beats > 0 ? (beats * 60) / bpm : eff[P.idx('delay.time')];
      }
      const W = Math.max(0.75, T), t0 = 0.5 + T;
      const n = Math.round((t0 + 3 * W) * sr), inEnd = Math.round(0.5 * sr);
      const L = new Float32Array(n), R = new Float32Array(n);
      const rnd = new Rand(5);
      const fr = [110, 138.6, 164.8];
      for (let i = 0; i < inEnd; i++) {
        let s = 0;
        for (const f of fr) s += 2 * ((i * f / sr) % 1) - 1;
        const env = Math.min(1, i / 200) * Math.min(1, (inEnd - i) / 200);
        L[i] = env * (0.1 * s + 0.05 * rnd.bi()); R[i] = env * (0.1 * s + 0.05 * rnd.bi());
      }
      const dryRms = Math.max(rmsOf(L, 0, inEnd), rmsOf(R, 0, inEnd));
      const onIds = FX_GROUPS.filter(g => g !== 'eq').map(g => P.idx(`${g}.on`));
      const sweepP = P.PARAMS.filter(p => (FX_GROUPS.includes(p.group) || p.id === 'comp.amount') && (p.type === 'float' || p.type === 'int'));
      for (let pos = 0; pos < n; pos += 128) {
        const m = Math.min(128, n - pos);
        if (toggle && (pos / 128) % 8 === 0) for (const i of onIds) eff[i] = rnd.next() < 0.5 ? 1 : 0;
        if (sweep) for (const p of sweepP) eff[p.index] = p.min + (p.max - p.min) * rnd.next();
        const bl = L.subarray(pos, pos + m), br = R.subarray(pos, pos + m);
        fx.process(bl, br, m, eff, bpm);
      }
      const st = stats(L, R);
      agg.sample(where, st);
      if (st.nan) agg.fail(`${where}: ${st.nan} NaN/Inf`);
      else if (st.peak > 8) agg.fail(`${where}: unbounded output (peak ${st.peak.toFixed(1)})`);
      else if (st.peak > 2.5) agg.warn(`${where}: hot output (peak ${st.peak.toFixed(2)})`);
      // Runaway = the tail grows: late window louder than an earlier tail window and not negligible vs the dry input.
      const w = (a, b) => Math.max(rmsOf(L, Math.round(a * sr), Math.round(b * sr)), rmsOf(R, Math.round(a * sr), Math.round(b * sr)));
      const early = w(t0, t0 + W), late = w(t0 + 2 * W, t0 + 3 * W);
      if (!toggle && !sweep && late > 1.4 * early && late > 0.25 * dryRms) agg.fail(`${where}: feedback runaway (tail ${dB(early).toFixed(1)} → ${dB(late).toFixed(1)} dBFS, dry input ${dB(dryRms).toFixed(1)} dBFS)`);
      else if (!toggle && !sweep && late > 2 * dryRms) agg.warn(`${where}: tail louder than the dry input (${dB(late).toFixed(1)} vs ${dB(dryRms).toFixed(1)} dBFS)`);
      if (Math.abs(st.dc) > 0.02) agg.warn(`${where}: DC ${st.dc.toFixed(3)}`);
    } catch (e) { agg.fail(`${where}: threw ${String(e?.message || e).split('\n')[0]}`); }
  }
  return [agg.row()];
}

async function jobFxTailAndCpu() {
  const F = await tryLoad('src/dsp/fx/fxchain.js');
  const P = await load('src/dsp/params.js');
  if (!F?.FxChain) return [row('fx', 'tail & CPU', 'SKIP', 'fxchain.js unavailable')];
  const rows = [];
  const sr = 48000;
  // Default delay+reverb: tail must reach −80 dBFS within 10 s; tailActive() should end.
  const fx = new F.FxChain(sr);
  const eff = P.toValueArray(P.resolveParams({ 'delay.on': true, 'reverb.on': true, 'chorus.on': true }));
  const blk = 128, L = new Float32Array(blk), R = new Float32Array(blk);
  let silentAt = -1, inactiveAt = -1, t = 0;
  const total = 12 * sr;
  for (; t < total; t += blk) {
    for (let i = 0; i < blk; i++) { const on = t + i < sr * 0.5; L[i] = on ? 0.3 * Math.sin((t + i) * 0.05) : 0; R[i] = L[i]; }
    fx.process(L, R, blk, eff, 110);
    let pk = 0;
    for (let i = 0; i < blk; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    if (t > sr * 0.5) {
      if (pk > 1e-4) silentAt = -1; else if (silentAt < 0) silentAt = t;
      if (typeof fx.tailActive === 'function' && !fx.tailActive()) { if (inactiveAt < 0) inactiveAt = t; } else inactiveAt = -1;
    }
  }
  const sil = silentAt < 0 ? null : (silentAt - 0.5 * sr) / sr;
  rows.push(row('fx', 'default delay+reverb tail → −80 dBFS', sil == null || sil > 10 ? 'WARN' : 'PASS',
    `${sil == null ? 'not silent after 11.5 s' : `silent ${sil.toFixed(2)} s after input stops`}${typeof fx.tailActive === 'function' ? ` · tailActive() ${inactiveAt < 0 ? 'still true' : `false after ${((inactiveAt - 0.5 * sr) / sr).toFixed(2)} s`}` : ''}`));
  // §2 denormals: no float32-subnormal values may sit in an effect's buffers while its tail is still processed
  // (regression: reverb diffuser / early-reflection buffers held ≈16k values in stuck limit cycles for ≈5 s;
  // one effect at a time — another effect's tail feeding it would hide the problem)
  {
    const probs = [], seen = [];
    for (const g of ['reverb', 'delay', 'chorus', 'phaser']) {
      const fx2 = new F.FxChain(sr);
      const e2 = P.toValueArray(P.resolveParams({ [`${g}.on`]: true }));
      const bufs = [];
      for (const [name, fxo] of Object.entries(fx2)) if (fxo && typeof fxo === 'object') for (const [k, a] of Object.entries(fxo)) if (a instanceof Float32Array) bufs.push([`${name}.${k}`, a]);
      let subMax = 0, subAt = '', gain = 1;
      for (let t2 = 0; t2 < 8 * sr; t2 += blk) {
        for (let i = 0; i < blk; i++) { const k = t2 + i; if (k > sr) gain *= 0.9995; L[i] = k < 1.5 * sr ? 0.3 * gain * Math.sin(k * 0.05) : 0; R[i] = L[i]; }
        fx2.process(L, R, blk, e2, 110);
        if (t2 > 1.5 * sr && (t2 / blk) % 94 === 0 && (typeof fx2.tailActive !== 'function' || fx2.tailActive())) {
          for (const [k, a] of bufs) {
            let c = 0;
            for (let i = 0; i < a.length; i++) { const x = a[i]; if (x !== 0 && x < 1.1754943508222875e-38 && x > -1.1754943508222875e-38) c++; }
            if (c > subMax) { subMax = c; subAt = `${k} @${(t2 / sr).toFixed(1)} s`; }
          }
        }
      }
      if (subMax) probs.push(`${g}: ${subMax} subnormal values in ${subAt} (flush / +DENORMAL the path)`);
      seen.push(`${g} ${bufs.length}`);
    }
    rows.push(row('fx', 'no float32 subnormals in FX buffers during tails (§2)', probs.length ? 'FAIL' : 'PASS',
      [`Float32 buffers scanned while tailActive(): ${seen.join(' · ')}`, ...probs.map(p => `✗ ${p}`)].join('\n')));
  }
  // CPU
  const cpu = [];
  for (const [name, vals] of [['bypass', {}], ['reverb', { 'reverb.on': true }], ['all on', Object.fromEntries(['drive', 'chorus', 'phaser', 'delay', 'reverb'].map(g => [`${g}.on`, true]).concat([['comp.amount', 0.5]]))]]) {
    const f2 = new F.FxChain(sr);
    const e2 = P.toValueArray(P.resolveParams(vals));
    const rnd = new Rand(1);
    for (let i = 0; i < blk; i++) { L[i] = 0.2 * rnd.bi(); R[i] = 0.2 * rnd.bi(); }
    for (let k = 0; k < 50; k++) f2.process(L, R, blk, e2, 110);
    const c0 = cpuMs();
    const blocks = Math.round((2 * sr) / blk);
    for (let k = 0; k < blocks; k++) { L[0] = 0.1; f2.process(L, R, blk, e2, 110); }
    const ms = cpuMs() - c0;
    cpu.push(`${name} ${((ms / 2000) * 100).toFixed(2)}% core`);
  }
  rows.push(row('fx', 'FxChain CPU @48k (stereo)', 'INFO', cpu.join(' · ')));
  return rows;
}

// ───────────────────────── Synth jobs ─────────────────────────
async function synthMod() {
  const m = await tryLoad('src/dsp/synth.js');
  return m && typeof m.Synth === 'function' ? m : null;
}

function renderSynth(synth, seconds, sr, schedule = [], onBlock = null) {
  const n = Math.round(seconds * sr), blk = 128;
  const L = new Float32Array(n), R = new Float32Array(n), bl = new Float32Array(blk), br = new Float32Array(blk);
  const ev = schedule.slice().sort((a, b) => a.t - b.t);
  let ei = 0;
  for (let pos = 0; pos < n; pos += blk) {
    while (ei < ev.length && ev[ei].t * sr <= pos) ev[ei++].fn(synth);
    const m = Math.min(blk, n - pos);
    if (onBlock) onBlock(synth, pos);
    synth.process(bl, br, m);
    L.set(bl.subarray(0, m), pos); R.set(br.subarray(0, m), pos);
  }
  return { L, R };
}

async function jobSynthApi() {
  const M = await synthMod();
  if (!M) return [row('synth', 'Synth API', 'SKIP', 'synth.js unavailable')];
  const P0 = await load('src/dsp/params.js');
  const rows = [];
  const probs = [], warns = [], notes = [];
  const check = (cond, msg, sev = 'FAIL') => { if (!cond) (sev === 'FAIL' ? probs : warns).push(msg); };
  for (const sr of [44100, 48000, 96000]) {
    try {
      const s = new M.Synth(sr);
      s.loadPatch({ params: {}, macros: [] });
      const quiet = renderSynth(s, 0.1, sr);
      check(stats(quiet.L, quiet.R).peak === 0, `${sr}: output not silent with no notes`, 'WARN');
      const r = renderSynth(s, 1, sr, [{ t: 0.01, fn: x => x.noteOn(60, 0.8) }, { t: 0.5, fn: x => x.noteOff(60) }]);
      const st = stats(r.L, r.R);
      check(!st.nan, `${sr}: NaN in simple note`);
      check(st.peak > 0.01, `${sr}: simple note is silent (peak ${st.peak})`);
      check(st.peak <= 1, `${sr}: simple note peak ${st.peak} > 1`);
      if (sr === 48000) notes.push(`default patch C4 peak ${dB(st.peak).toFixed(1)} dBFS (spec ≈ −12)`);
    } catch (e) { probs.push(`${sr}: ${String(e?.message || e).split('\n')[0]}`); }
  }
  try {
    const sr = 48000, s = new M.Synth(sr);
    s.setParam('filter.type', 'comb');
    check(s.getParam('filter.type') === 'comb', `setParam enum by id → getParam = ${s.getParam('filter.type')}`);
    s.setParam('filter.type', 2);
    check(s.getParam('filter.type') === 'lp', `setParam enum by index → getParam = ${s.getParam('filter.type')}`);
    s.setParam('filter.cutoff', 1234.5);
    check(Math.abs(s.getParam('filter.cutoff') - 1234.5) < 1e-6, `float round-trip = ${s.getParam('filter.cutoff')}`);
    s.setParam('reverb.on', true);
    check(s.getParam('reverb.on') === true || s.getParam('reverb.on') === 1, `bool round-trip = ${s.getParam('reverb.on')}`);
    // malformed values never produce an invalid encoding (regression: phys.model 6 threw in the audio thread)
    s.setParam('filter.type', 99);
    check(s.getParam('filter.type') === P0.PARAM_BY_ID['filter.type'].options.at(-1), `enum index 99 → ${s.getParam('filter.type')} (want clamped to the last option)`);
    s.setParam('filter.type', NaN);
    check(s.getParam('filter.type') === P0.PARAM_BY_ID['filter.type'].def, `enum NaN → ${s.getParam('filter.type')} (want default)`);
    s.setParam('phaser.stages', '8');
    check(s.getParam('phaser.stages') === '8', `numeric-looking enum id '8' → ${s.getParam('phaser.stages')}`);
    for (const [val, want] of [['false', false], ['0', false], ['off', false], ['', false], ['true', true], ['1', true], [0.7, true], [0, false]]) {
      s.setParam('reverb.on', val);
      check(s.getParam('reverb.on') === want, `bool ${JSON.stringify(val)} → ${s.getParam('reverb.on')} (want ${want})`);
    }
    s.setParam('filter.cutoff', '500');
    check(s.getParam('filter.cutoff') === 500, `numeric string '500' → cutoff ${s.getParam('filter.cutoff')}`);
    s.setParam('filter.cutoff', 'abc');
    check(s.getParam('filter.cutoff') === P0.PARAM_BY_ID['filter.cutoff'].def, `non-numeric string → cutoff ${s.getParam('filter.cutoff')} (want default)`);
    {
      const x = new M.Synth(sr);
      x.loadPatch({ params: { 'phys.on': true }, macros: [] });
      let err = '';
      try {
        for (const bad of [6, 11, 1e9, -3]) {
          x.setParam('phys.model', bad); x.setParam('phys.exciter', bad);
          x.noteOn(60, 0.9); const q = renderSynth(x, 0.15, sr); x.noteOff(60);
          const st = stats(q.L, q.R);
          check(!st.nan && st.peak > 1e-3, `phys.model/exciter ${bad}: ${st.nan ? 'NaN' : `peak ${st.peak}`}`);
        }
      } catch (e) { err = String(e?.message || e).split('\n')[0]; }
      check(!err, `phys.model out of range threw: ${err}`);
    }
    s.setParam('filter.cutoff', 1234.5); s.setParam('filter.type', 'lp'); s.setParam('reverb.on', true);
    s.setParams({ 'osc1.unison': 3, 'amp.level': -3 });
    check(s.getParam('osc1.unison') === 3, 'setParams');
    s.setMacro(0, 0.5);
    check(Math.abs(s.getParam('macro1') - 0.5) < 1e-9, `setMacro → macro1 = ${s.getParam('macro1')}`);
    for (const [k, v] of [['wheel', 1], ['aftertouch', 0.5], ['bend', -1], ['bend', 1], ['sustain', 1], ['sustain', 0], ['bend', 0], ['wheel', 0]]) s.setController(k, v);
    // state + voice lifecycle
    s.loadPatch({ params: { 'aenv.r': 0.05 }, macros: [] });
    s.noteOn(60, 0.9);
    renderSynth(s, 0.05, sr);
    const st1 = s.getState();
    check(Array.isArray(st1.voices) && st1.voices.length >= 1, `getState().voices after noteOn = ${st1.voices?.length}`);
    check(Array.isArray(st1.peak) && st1.peak.length === 2, 'getState().peak is [l, r]');
    if (st1.voices?.[0]) check(['attack', 'decay', 'sustain', 'release'].includes(st1.voices[0].stage), `voice stage '${st1.voices[0].stage}'`, 'WARN');
    s.noteOff(60);
    renderSynth(s, 1, sr);
    check(s.getState().voices.length === 0, `voice not freed 1 s after release (aenv.r 50 ms): ${s.getState().voices.length}`);
    // sustain pedal
    s.setController('sustain', 1);
    s.noteOn(64, 0.8); renderSynth(s, 0.05, sr); s.noteOff(64); renderSynth(s, 0.4, sr);
    check(s.getState().voices.length >= 1, 'sustain pedal did not hold the note');
    s.setController('sustain', 0); renderSynth(s, 1, sr);
    check(s.getState().voices.length === 0, 'note not released after sustain pedal up');
    // hard all-notes-off
    s.loadPatch({ params: { 'aenv.r': 5, 'reverb.on': true, 'reverb.decay': 10 }, macros: [] });
    for (const n of [48, 52, 55, 59]) s.noteOn(n, 1);
    renderSynth(s, 0.3, sr);
    s.allNotesOff(true);
    const h = renderSynth(s, 0.1, sr);
    const after = peakOf(h.L, h.R, Math.round(0.03 * sr), h.L.length);
    check(after < 1e-4, `allNotesOff(true): still ${dB(after).toFixed(0)} dBFS 30 ms later`);
    // sequencer
    if (s.sequencer && typeof s.sequencer.load === 'function') {
      s.loadPatch({ params: {}, macros: [] });
      s.sequencer.load({ ...getPhrase('keys'), loop: true });
      s.sequencer.play();
      const q = renderSynth(s, 1.5, sr);
      check(s.sequencer.playing === true, 'sequencer.playing false after play()');
      check(stats(q.L, q.R).peak > 0.01, 'sequencer playback silent');
      check(s.sequencer.beat > 1, `sequencer.beat = ${s.sequencer.beat} after 1.5 s @92 bpm`, 'WARN');
      s.sequencer.stop();
      renderSynth(s, 2, sr);
      check(s.getState().voices.length === 0, `sequencer.stop() left ${s.getState().voices.length} voices`);
      // param / ramp / macro events
      s.sequencer.load({ bpm: 120, loop: false, lengthBeats: 4, events: [
        { beat: 0, type: 'on', note: 60, vel: 0.8, dur: 3 }, { beat: 0, type: 'param', id: 'filter.cutoff', value: 500 },
        { beat: 0.5, type: 'ramp', id: 'filter.cutoff', to: 1, beats: 1 }, { beat: 1, type: 'macro', index: 0, value: 1 },
        { beat: 1.5, type: 'ramp-macro', index: 1, to: 1, beats: 1 },
      ] });
      s.sequencer.play();
      const q2 = renderSynth(s, 2.2, sr);
      check(!stats(q2.L, q2.R).nan, 'sequencer param/ramp/macro events → NaN');
    } else probs.push('synth.sequencer missing load()');
  } catch (e) { probs.push(`API: ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}`); }
  rows.push(row('synth', 'Synth API (params, macros, controllers, state, sustain, panic, sequencer)', probs.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS',
    [notes.join(' · '), ...probs.map(p => `✗ ${p}`), ...warns.map(w => `! ${w}`)].filter(Boolean).join('\n')));
  return rows;
}

async function jobSynthStress() {
  const M = await synthMod();
  const P = await load('src/dsp/params.js');
  if (!M) return [row('synth', 'stress', 'SKIP', 'synth.js unavailable')];
  const rows = [];
  const sr = 48000;
  // Everything maxed: limiter must hold ≤ 1.0
  {
    const agg = new Agg('synth', 'stress: 16 voices, all engines max, +6 dB, drive → limiter ≤ 1.0');
    try {
      const s = new M.Synth(sr);
      s.loadPatch({ params: {
        'voice.poly': 16, 'osc1.unison': 8, 'osc2.on': true, 'osc2.unison': 8, 'osc1.level': 1, 'osc2.level': 1, 'fm.on': true, 'fm.level': 1, 'phys.on': true, 'phys.level': 1,
        'noise.on': true, 'noise.level': 1, 'amp.level': 6, 'filter.res': 1, 'filter.drive': 1, 'drive.on': true, 'drive.amount': 1, 'reverb.on': true, 'delay.on': true, 'delay.feedback': 0.95,
        'chorus.on': true, 'phaser.on': true, 'eq.low': 12, 'eq.high': 12, 'amp.vel': 0,
      }, macros: [] });
      s.setParam('master.volume', 6);
      const sched = [];
      for (let k = 0; k < 16; k++) sched.push({ t: 0.01 * k, fn: x => x.noteOn(24 + k * 5, 1) });
      sched.push({ t: 0.7, fn: x => x.allNotesOff(false) });
      const r = renderSynth(s, 1, sr, sched);
      const st = stats(r.L, r.R);
      agg.sample('max', st);
      if (st.nan) agg.fail('NaN/Inf in output');
      if (st.peak > 1) agg.fail(`output peak ${st.peak.toFixed(4)} > 1.0 (limiter)`);
      agg.info(`peak ${dB(st.peak).toFixed(2)} dBFS`);
    } catch (e) { agg.fail(`threw ${e.message}`); }
    rows.push(agg.row());
  }
  // Voice stealing / mono / legato
  {
    const agg = new Agg('synth', 'voice stealing & mono/legato');
    for (const [name, params, notesN, dt] of [
      ['poly4 × 32 fast notes', { 'voice.poly': 4, 'aenv.r': 2 }, 32, 0.012],
      ['poly16 × 64 notes', { 'voice.poly': 16, 'aenv.r': 3 }, 64, 0.02],
      ['mono glide', { 'voice.mode': 'mono', 'voice.glide': 0.2 }, 12, 0.08],
      ['legato overlap', { 'voice.mode': 'legato', 'voice.glide': 0.1 }, 12, 0.1],
    ]) {
      try {
        const s = new M.Synth(sr);
        s.loadPatch({ params, macros: [] });
        const sched = [];
        let maxV = 0;
        for (let k = 0; k < notesN; k++) {
          const note = 40 + ((k * 7) % 36);
          sched.push({ t: k * dt, fn: x => x.noteOn(note, 0.9) });
          sched.push({ t: k * dt + dt * 1.5, fn: x => x.noteOff(note) });
        }
        const r = renderSynth(s, notesN * dt + 1, sr, sched, (x, pos) => { if (pos % 1024 === 0) { const st = x.getState(); maxV = Math.max(maxV, st.voices.filter(v => v.stage !== 'release').length); } });
        const st = stats(r.L, r.R);
        agg.sample(name, st);
        if (st.nan) agg.fail(`${name}: NaN`);
        if (st.peak > 1) agg.fail(`${name}: peak ${st.peak} > 1`);
        const limit = params['voice.mode'] ? 1 : params['voice.poly'];
        if (maxV > limit) agg.fail(`${name}: ${maxV} sounding (non-release) voices > limit ${limit}`);
      } catch (e) { agg.fail(`${name}: threw ${e.message}`); }
    }
    rows.push(agg.row());
  }
  // Voice stealing must never drop the notes just played (regression: the "quietest held voice" used to be a
  // voice started earlier in the same block (level 0) or still in its attack → new chord notes went silent).
  {
    const agg = new Agg('synth', 'voice stealing keeps new notes (legato chords, pedal, slow attack, full pool, arp tie)');
    const blk = new Float32Array(128), blk2 = new Float32Array(128);
    const run = (s, sec) => { for (let b = 0, n = Math.round(sec * sr / 128); b < n; b++) s.process(blk, blk2, 128); };
    const gated = s => new Set(s.voices.filter(v => v.active && v.gate && !v.fading).map(v => v.note));
    const expectAll = (name, s, want) => {
      const g = gated(s), miss = want.filter(n => !g.has(n));
      if (miss.length) agg.fail(`${name}: new notes ${miss.join(' ')} not sounding (gated: ${[...g].sort((a, b) => a - b).join(' ')})`);
    };
    const mk = params => { const s = new M.Synth(sr); s.loadPatch({ params, macros: [] }); return s; };
    try {
      // legato chord change at poly = chord size + 2 (new chord pressed before the old one is released)
      for (const a of [0.005, 0.3]) {
        const s = mk({ 'voice.poly': 6, 'aenv.a': a, 'aenv.r': 1.5 });
        const A = [48, 55, 64, 71], B = [50, 57, 65, 72];
        A.forEach(n => s.noteOn(n, 0.8)); run(s, 0.8);
        B.forEach(n => s.noteOn(n, 0.8)); run(s, 0.01); A.forEach(n => s.noteOff(n)); run(s, 0.3);
        expectAll(`legato chord change poly 6 (attack ${a * 1000} ms)`, s, B);
      }
      // sustain pedal holding 10 arpeggiated notes, then a 4-note chord in one block / 3 ms apart (poly 12)
      for (const gap of [0, 0.003]) {
        const s = mk({ 'voice.poly': 12, 'aenv.a': 0.3, 'aenv.s': 0.6 });
        s.setController('sustain', 1);
        for (const n of [36, 43, 48, 52, 55, 60, 64, 67, 72, 76]) { s.noteOn(n, 0.8); run(s, 0.12); s.noteOff(n); }
        const C = [41, 53, 57, 65];
        for (const n of C) { s.noteOn(n, 0.8); if (gap) run(s, gap); }
        run(s, 0.2);
        expectAll(`pedal + chord (gap ${gap * 1000} ms)`, s, C);
      }
      // slow-attack pad at poly 4: keys added one by one → the newest held notes survive, the oldest are stolen
      {
        const s = mk({ 'voice.poly': 4, 'aenv.a': 0.7 });
        [48, 52, 55, 59].forEach(n => s.noteOn(n, 0.8)); run(s, 2);
        const N = [62, 65, 69];
        for (const n of N) { s.noteOn(n, 0.8); run(s, 0.15); }
        expectAll('slow attack poly 4', s, N);
        if (!gated(s).has(59)) agg.fail('slow attack poly 4: stole the newest old note (59) instead of the oldest');
      }
      // pool exhausted by fading voices (16 released voices in their tails, then a new 16-note chord)
      for (const [poly, size] of [[12, 12], [16, 16], [16, 14]]) {
        const s = mk({ 'voice.poly': poly, 'aenv.r': 2 });
        const A = Array.from({ length: size }, (_, k) => 40 + k * 3), B = A.map(n => n + 1);
        A.forEach(n => s.noteOn(n, 0.8)); run(s, 0.05); A.forEach(n => s.noteOff(n)); run(s, 0.03);
        B.forEach(n => s.noteOn(n, 0.8)); run(s, 0.01);
        expectAll(`full pool poly ${poly} × ${size}-note chord`, s, B);
        if (s.droppedNotes) agg.fail(`full pool poly ${poly} × ${size}: droppedNotes = ${s.droppedNotes}`);
        // …and no sounding voice cut without its fade (the new notes wait ≤ 2 ms for a stolen voice instead)
        if (s.voicesCut) agg.fail(`full pool poly ${poly} × ${size}: ${s.voicesCut} sounding voices cut without a fade (click)`);
      }
      // bursts that exhaust the 20-voice pool: repeated 12-note chords, arp chord mode with chord memory
      for (const [name, params, keys, every, times] of [
        ['12-note chord ×3, poly 12', { 'voice.poly': 12, 'aenv.r': 2 }, Array.from({ length: 12 }, (_, k) => 48 + k * 3), 0.2, 3],
        ['arp chord 1/16 × maj7 on 2 keys, poly 16', { 'voice.poly': 16, 'arp.on': true, 'arp.mode': 'chord', 'arp.rate': '1/16', 'arp.gate': 0.5, 'chord.type': 'maj7', 'aenv.r': 2, 'global.bpm': 140 }, [60, 67], 3, 1],
      ]) {
        const s = mk(params);
        if (params['global.bpm']) s.setParam('global.bpm', params['global.bpm']);
        for (let t = 0; t < times; t++) { keys.forEach(n => s.noteOn(n, 0.8)); run(s, 0.1); if (times > 1) { keys.forEach(n => s.noteOff(n)); run(s, every - 0.1); } }
        run(s, 1);
        if (s.voicesCut || s.droppedNotes) agg.fail(`${name}: ${s.voicesCut} sounding voices cut without a fade, ${s.droppedNotes} notes dropped`);
      }
      // more notes than voices in one block: the latest notes win, polyphony is respected
      {
        const s = mk({ 'voice.poly': 4 });
        [48, 52, 55, 59, 62, 65].forEach(n => s.noteOn(n, 0.8)); run(s, 0.05);
        const g = gated(s);
        if (g.size !== 4 || ![55, 59, 62, 65].every(n => g.has(n))) agg.fail(`6 notes at poly 4 in one block → gated ${[...g].join(' ')} (want 55 59 62 65)`);
      }
      // arp chord mode with a tied gate (100 %): every step sounds the whole chord
      for (const poly of [4, 6]) {
        const s = mk({ 'voice.poly': poly, 'arp.on': true, 'arp.mode': 'chord', 'arp.oct': 2, 'arp.gate': 1, 'arp.rate': '1/8' });
        [48, 52, 55, 59].forEach(n => s.noteOn(n, 0.8));
        let worst = 4;
        for (let b = 0; b < Math.round(2 * sr / 128); b++) { s.process(blk, blk2, 128); if (b > 40 && b % 7 === 0) worst = Math.min(worst, gated(s).size); }
        if (worst < 4) agg.fail(`arp chord tie poly ${poly}: a step sounded only ${worst} of 4 notes`);
      }
    } catch (e) { agg.fail(`threw ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}`); }
    rows.push(agg.row());
  }
  // Physical-model robustness: model switch mid-note (was a one-sample click, then silence); modal bow/breath
  // with the fundamental above 0.45·fs or under S&H → pitch (was +60…90 dB bursts that ducked the whole mix)
  {
    const agg = new Agg('synth', 'phys: model switch mid-note (no click) · modal bow/breath under pitch modulation (bounded)');
    const physOn = { 'osc1.on': false, 'phys.on': true, 'phys.decay': 5, 'phys.brightness': 0.3, 'phys.damp': 0, 'aenv.s': 1, 'aenv.r': 3 };
    try {
      for (const [from, exc, to, held] of [['bar', 'mallet', 'membrane', true], ['string', 'pluck', 'bar', true], ['bar', 'mallet', 'membrane', false], ['string', 'bow', 'plate', true]]) {
        const ev = [{ time: 0.02, type: 'on', note: 57 }, ...(held ? [] : [{ time: 0.1, type: 'off', note: 57 }]), { time: 0.5, type: 'param', id: 'phys.model', value: to }];
        const { L, R } = M.renderOffline({ params: { ...physOn, 'phys.model': from, 'phys.exciter': exc }, macros: [] }, ev, 0.75, sr);
        const e = Math.round(0.5 * sr / 16) * 16;
        let pre = 0, post = 0, rms = 0;
        for (let i = e - 4800; i < e; i++) pre = Math.max(pre, Math.abs(L[i] - L[i - 1]));
        for (let i = e; i < e + Math.round(0.006 * sr); i++) post = Math.max(post, Math.abs(L[i] - L[i - 1])); // the fade-out
        for (let i = e + Math.round(0.05 * sr); i < e + Math.round(0.2 * sr); i++) rms += L[i] * L[i];
        rms = Math.sqrt(rms / Math.round(0.15 * sr));
        agg.sample(`${from}→${to}`, stats(L, R));
        const name = `${from} ${exc} → ${to} (${held ? 'held' : 'released'})`;
        if (post > 1.5 * pre + 1e-4) agg.fail(`${name}: step ${post.toFixed(4)} at the switch vs ${pre.toFixed(4)} before (click)`);
        if (held && !(rms > 1e-3)) agg.fail(`${name}: held note silent after the switch (RMS ${rms.toExponential(1)})`);
      }
      const voiceRms = (params, notes, secs, ctl) => {
        const s = new M.Synth(sr);
        s.loadPatch({ params: { 'osc1.on': false, 'phys.on': true, 'aenv.s': 1, ...params }, macros: [] });
        for (const n of notes) s.noteOn(n, 1);
        const bl = new Float32Array(128), br = new Float32Array(128);
        let mx = 0, red = 0;
        const blocks = Math.round(secs * sr / 128);
        for (let b = 0; b < blocks; b++) {
          if (ctl) ctl(s, b, blocks);
          s.process(bl, br, 128);
          for (const v of s.voices) if (v.active) mx = Math.max(mx, Math.sqrt(v.blockEnergy / 32));
          red = Math.min(red, s.limiter.getReduction ? s.limiter.getReduction() : 0);
        }
        return { mx, red };
      };
      for (const model of ['bar', 'membrane', 'plate', 'bell']) for (const exc of ['bow', 'breath']) {
        const r = voiceRms({ 'phys.model': model, 'phys.exciter': exc, 'phys.oct': 3 }, [102], 0.5, (s, b, n) => s.setController('bend', -1 + 2 * b / n));
        if (r.mx > 2) agg.fail(`${model} ${exc} oct +3 note 102, bend sweep: voice RMS ${r.mx.toFixed(1)} (normal ≤ 0.7)`);
        const q = voiceRms({ 'phys.model': model, 'phys.exciter': exc, 'phys.pressure': 1, 'lfo1.shape': 'sh', 'lfo1.rate': 50, 'mod1.src': 'lfo1', 'mod1.dst': 'voice.pitch', 'mod1.amt': 1, 'mod2.src': 'lfo1', 'mod2.dst': 'voice.pitch', 'mod2.amt': 1 }, [0, 60, 127], 0.35);
        if (q.mx > 2 || q.red < -3) agg.fail(`${model} ${exc} S&H → pitch: voice RMS ${q.mx.toFixed(1)}, limiter ${q.red.toFixed(1)} dB`);
      }
    } catch (e) { agg.fail(`threw ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}`); }
    rows.push(agg.row());
  }
  // Sample-rate independence of noise sources: level in the audible band (150 Hz–12 kHz) at 96/192 kHz vs
  // 48 kHz (regression: normalised over 0..Nyquist → white noise −3/−6 dB, Lunar Tide −2.7/−5.4 LU at 96/192 kHz)
  {
    const agg = new Agg('synth', 'sample-rate independence: noise / breath level in the audible band at 96 & 192 kHz');
    // measurement band 150 Hz … 12 kHz (RBJ biquads: HP once, LP twice): the high-pass keeps brown noise's
    // few, slow sub-150 Hz excursions from dominating a short window (±1.5 dB run-to-run otherwise)
    const bq = (y, fs, fc, hp) => {
      const w = 2 * Math.PI * fc / fs, al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), n = 1 + al;
      const b0 = (hp ? (1 + c) / 2 : (1 - c) / 2) / n, b1 = (hp ? -(1 + c) : 1 - c) / n, a1 = -2 * c / n, a2 = (1 - al) / n;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) { const xi = y[i], yi = b0 * xi + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi; }
    };
    const lp12 = (x, fs) => { const y = Float64Array.from(x); bq(y, fs, 150, true); bq(y, fs, 12000, false); bq(y, fs, 12000, false); return y; };
    const base = { 'osc1.on': false, 'filter.on': false, 'aenv.s': 1, 'reverb.on': false, 'delay.on': false, 'chorus.on': false };
    const parts = [];
    try {
      for (const [name, p, tol] of [
        ['white', { 'noise.on': true, 'noise.color': 0 }, 1], ['brown', { 'noise.on': true, 'noise.color': -1 }, 1],
        ['color −0.3', { 'noise.on': true, 'noise.color': -0.3 }, 1], ['color +1', { 'noise.on': true, 'noise.color': 1 }, 1],
        ['phys string breath', { 'phys.on': true, 'phys.model': 'string', 'phys.exciter': 'breath' }, 1.5],
      ]) {
        let ref = 0;
        const d = [];
        for (const fs of [48000, 96000, 192000]) {
          const { L, R } = M.renderOffline({ params: { ...base, ...p }, macros: [] }, [{ time: 0, type: 'on', note: 60, vel: 0.8 }], 1.2, fs);
          agg.sample(`${name}@${fs}`, stats(L, R));
          const y = lp12(L, fs);
          let e = 0; const s0 = Math.round(0.4 * fs);
          for (let i = s0; i < y.length; i++) e += y[i] * y[i];
          const db = 10 * Math.log10(e / (y.length - s0) + 1e-30);
          if (fs === 48000) ref = db;
          else { d.push(db - ref); if (Math.abs(db - ref) > tol) agg.fail(`${name}: ${(db - ref).toFixed(2)} dB at ${fs / 1000} kHz vs 48 kHz (audible band, tolerance ±${tol})`); }
        }
        parts.push(`${name} ${d.map(x => (x >= 0 ? '+' : '') + x.toFixed(1)).join('/')}`);
      }
      agg.info(`Δ dB @96/192k: ${parts.join(' · ')}`);
    } catch (e) { agg.fail(`threw ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}`); }
    rows.push(agg.row());
  }
  // Fuzz: random patches
  {
    const agg = new Agg('synth', 'fuzz: random patches × pluck phrase');
    const rnd = new Rand(0xf00d);
    const patchP = P.PARAMS.filter(p => p.scope !== 'global' && !/^mod\d/.test(p.id));
    const modSlots = P.PARAMS.filter(p => /^mod\d\./.test(p.id));
    const events = phraseToTimedEvents(getPhrase('pluck')).filter(e => e.time < 1.6);
    for (let k = 0; k < 8; k++) {
      const params = {};
      for (const p of patchP) {
        if (p.type === 'enum') params[p.id] = rnd.pick(p.options);
        else if (p.type === 'bool') params[p.id] = rnd.next() < 0.5;
        else { let v = p.curve === 'exp' ? p.min * (p.max / p.min) ** rnd.next() : p.min + (p.max - p.min) * rnd.next(); if (p.type === 'int') v = Math.round(v); params[p.id] = v; }
      }
      params['aenv.a'] = Math.min(params['aenv.a'], 0.5); params['aenv.r'] = Math.min(params['aenv.r'], 1);
      for (const p of modSlots) if (p.type === 'enum') params[p.id] = rnd.pick(p.options); else params[p.id] = rnd.bi();
      try {
        const s = new M.Synth(sr, { seed: k + 1 });
        s.loadPatch({ params, macros: [{ name: 'm', targets: [{ id: 'filter.cutoff', amount: 0.5 }] }, { name: 'm2', targets: [] }, { name: 'm3', targets: [] }, { name: 'm4', targets: [] }] });
        const sched = events.map(e => ({ t: e.time, fn: x => (e.type === 'on' ? x.noteOn(e.note, e.vel) : x.noteOff(e.note)) }));
        sched.push({ t: 1.6, fn: x => x.allNotesOff(false) });
        const r = renderSynth(s, 2, sr, sched, (x, pos) => { if (pos % 4096 === 0) x.setMacro(0, rnd.next()); });
        const st = stats(r.L, r.R);
        agg.sample(`seed${k}`, st);
        if (st.nan) agg.fail(`seed ${k}: NaN/Inf`);
        if (st.peak > 1) agg.fail(`seed ${k}: peak ${st.peak} > 1`);
        if (Math.abs(st.dc) > 0.02) agg.warn(`seed ${k}: DC ${st.dc.toFixed(3)}`);
      } catch (e) { agg.fail(`seed ${k}: threw ${String(e?.message || e).split('\n')[0]}`); }
    }
    rows.push(agg.row());
  }
  // Rapid automation of every mod-able parameter
  {
    const agg = new Agg('synth', 'rapid automation (all mod-able params every 128 samples)');
    try {
      const s = new M.Synth(sr);
      s.loadPatch({ params: { 'osc2.on': true, 'fm.on': true, 'noise.on': true, 'phys.on': true }, macros: [] });
      const modP = P.PARAMS.filter(p => p.mod && p.type !== 'enum');
      const rnd = new Rand(77);
      const sched = [48, 55, 60, 64, 67].map((n, i) => ({ t: 0.01 * i, fn: x => x.noteOn(n, 0.8) }));
      sched.push({ t: 1.5, fn: x => x.allNotesOff() });
      const r = renderSynth(s, 2, sr, sched, x => { const p = rnd.pick(modP); x.setParam(p.id, p.curve === 'exp' ? p.min * (p.max / p.min) ** rnd.next() : p.min + (p.max - p.min) * rnd.next()); });
      const st = stats(r.L, r.R);
      agg.sample('auto', st);
      if (st.nan) agg.fail('NaN/Inf');
      if (st.peak > 1) agg.fail(`peak ${st.peak} > 1`);
    } catch (e) { agg.fail(`threw ${e.message}`); }
    rows.push(agg.row());
  }
  return rows;
}

/**
 * Allocation check in a fresh worker: V8 GC exposed at runtime; heap growth over steady-state processing,
 * per component (engines, filters, FX chain, whole Synth). Reports bytes per 128 output samples.
 */
async function jobSynthAlloc() {
  const P = await load('src/dsp/params.js');
  let gc = null;
  try {
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    gc = vm.runInNewContext('gc');
  } catch { /* measure without forced GC */ }
  const sr = 48000;
  // Long warm-up (JIT tiers, lazy init), then the minimum over two windows: one-off costs such as
  // optimised-code allocation land in one window, steady-state allocation shows up in both.
  // (3 windows: under a parallel test run the concurrent JIT can finish late, and code running in the
  // interpreter / baseline tier boxes every double — that transient is not the steady-state audio path)
  const measure = (fn, blocks, samplesPerCall) => {
    for (let k = 0; k < blocks * 6; k++) fn();
    let best = Infinity;
    // Young-generation growth only: garbage from the audio path lands in new space, while code objects that a
    // concurrent JIT compile installs mid-window (old/code space) are not audio-path allocations.
    const young = () => { let u = 0; for (const sp of v8.getHeapSpaceStatistics()) if (/^new_space$|^new_large_object_space$/.test(sp.space_name)) u += sp.space_used_size; return u; };
    for (let w = 0; w < 3; w++) {
      if (gc) { gc(); gc(); }
      const h0 = young();
      for (let k = 0; k < blocks; k++) fn();
      const d = young() - h0;
      if (d >= 0) best = Math.min(best, d); // < 0: a scavenge ran inside the window → no information
    }
    if (best === Infinity) best = 0;
    return Math.max(0, best / ((blocks * samplesPerCall) / 128));
  };
  // Over budget: warm up longer and measure again (twice at most). In a full parallel run every worker shares
  // the process's concurrent-JIT threads, so optimised code can land after all three windows (phys read 134–174 B
  // there vs 3–6 B alone). Steady-state garbage from process() is still there after the extra warm-up.
  const measureStable = (fn, blocks, samplesPerCall) => {
    let b = measure(fn, blocks, samplesPerCall);
    for (let retry = 0; retry < 2 && b > 64; retry++) b = Math.min(b, measure(fn, blocks, samplesPerCall));
    return b;
  };
  const parts = [];
  let worstB = 0, worstName = '';
  const note = (name, b) => { parts.push(`${name} ${b < 1 ? 0 : b.toFixed(0)} B`); if (b > worstB) { worstB = b; worstName = name; } };
  const L16 = new Float32Array(16), R16 = new Float32Array(16);
  for (const e of ENGINES) {
    const Cls = engineClass(await tryLoad(e.file), e.cls);
    if (!Cls) continue;
    try {
      const eng = new Cls(sr, e.prefix);
      const v = P.toValueArray(P.resolveParams({ [`${e.prefix}.on`]: true, ...(e.label === 'osc' ? { 'osc1.unison': 3 } : {}) }));
      eng.noteOn(60, 0.8, 261.63, v, false);
      note(e.label, measureStable(() => eng.process(v, 261.63, L16, R16, 0, 16), 6000, 16));
    } catch (err) { parts.push(`${e.label} threw ${err.message}`); }
  }
  const F = await tryLoad('src/dsp/filter.js');
  if (F?.VoiceFilter) {
    P.FILTER_TYPES.forEach((name, t) => {
      const flt = new F.VoiceFilter(sr);
      note(`filter:${name}`, measureStable(() => { L16[0] = 0.1; flt.process(L16, R16, 0, 16, t, 800, 900, 0.5, 0.3, 0.5); }, 4096, 16));
    });
  }
  if (F?.SVFilter) {
    const svf = new F.SVFilter(sr);
    note('SVFilter', measureStable(() => { L16[0] = 0.1; svf.process(L16, R16, 0, 16, 0, 900, 0.5); }, 4096, 16));
  }
  const FX = await tryLoad('src/dsp/fx/fxchain.js');
  const L = new Float32Array(128), R = new Float32Array(128);
  if (FX?.FxChain) {
    const fx = new FX.FxChain(sr);
    const eff = P.toValueArray(P.resolveParams(Object.fromEntries(['drive', 'chorus', 'phaser', 'delay', 'reverb'].map(g => [`${g}.on`, true]).concat([['comp.amount', 0.5]]))));
    note('FxChain', measureStable(() => { L[0] = 0.1; fx.process(L, R, 128, eff, 110); }, 2000, 128));
  }
  const M = await synthMod();
  if (M) {
    try {
      const s = new M.Synth(sr);
      s.loadPatch({ params: { 'osc1.unison': 5, 'osc2.on': true, 'fm.on': true, 'reverb.on': true, 'delay.on': true, 'chorus.on': true, 'phaser.on': true, 'drive.on': true,
        'lfo1.shape': 'sh', 'mod1.src': 'lfo1', 'mod1.dst': 'filter.cutoff', 'mod1.amt': 0.3, 'mod2.src': 'lfo2', 'mod2.dst': 'osc1.shape', 'mod2.amt': 0.5 }, macros: [] });
      for (const n of [48, 52, 55, 59, 62, 64, 67, 71]) s.noteOn(n, 0.8);
      let gcs = 0;
      const obs = new PerformanceObserver(list => { gcs += list.getEntries().length; });
      const b = measureStable(() => s.process(L, R, 128), 1500, 128);
      obs.observe({ entryTypes: ['gc'] });
      for (let k = 0; k < 1500; k++) s.process(L, R, 128);
      await new Promise(r => setTimeout(r, 30));
      obs.disconnect();
      note('Synth (8 voices, all FX)', b);
      parts.push(`${gcs} GCs in 4 s`);
    } catch (err) { parts.push(`Synth threw ${err.message}`); }
  }
  return [row('synth', 'allocation in audio path (bytes per 128 samples)', worstB > 64 ? 'WARN' : 'PASS',
    `${parts.join(' · ')}${gc ? '' : ' · (gc not exposed)'}${worstB > 64 ? `\n! ${parts.filter(x => / B$/.test(x) && parseFloat(x.split(' ').at(-2)) > 64).join(', ')}\n! worst: ${worstName} allocates ≈${worstB.toFixed(0)} B per 128 samples (boxed doubles / temp arrays / closures in process()) → GC pauses in the AudioWorklet` : ''}`)];
}

// ───────────────────────── Preset jobs ─────────────────────────
function validatePreset(P, preset, categories = []) {
  const errs = [], warns = [];
  if (!preset || typeof preset !== 'object') return { errs: ['not an object'], warns };
  if (typeof preset.name !== 'string' || !preset.name.trim()) errs.push('missing name');
  const cats = new Set([...CATEGORY_IDS, ...categories]);
  if (!cats.has(preset.category)) warns.push(`category '${preset.category}' not one of ${[...cats].join('/')}`);
  if (!preset.demo) warns.push('no demo phrase');
  else if (!PHRASES[preset.demo]) warns.push(`demo '${preset.demo}' is not a known phrase`);
  if (!preset.description) warns.push('no description');
  const params = preset.params || {};
  for (const [id, v] of Object.entries(params)) {
    const p = P.PARAM_BY_ID[id];
    if (!p) { errs.push(`unknown param '${id}'`); continue; }
    if (p.scope === 'global') warns.push(`'${id}' is global-scope (ignored by loadPatch)`);
    if (p.type === 'enum') {
      if (typeof v === 'number' ? !(v >= 0 && v < p.options.length) : !p.options.includes(v)) errs.push(`${id} = ${JSON.stringify(v)} not in [${p.options.join(', ')}]`);
    } else if (p.type === 'bool') {
      if (typeof v !== 'boolean' && v !== 0 && v !== 1) errs.push(`${id} = ${JSON.stringify(v)} is not boolean`);
    } else if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${id} = ${JSON.stringify(v)} is not a number`);
    else if (v < p.min - 1e-9 || v > p.max + 1e-9) errs.push(`${id} = ${v} outside [${p.min}, ${p.max}]`);
  }
  const macros = preset.macros;
  if (!Array.isArray(macros)) errs.push('macros missing');
  else {
    if (macros.length !== 4) warns.push(`${macros.length} macros (spec: exactly 4)`);
    macros.forEach((m, i) => {
      if (!m?.name) warns.push(`macro ${i + 1} has no name`);
      if (!Array.isArray(m?.targets) || !m.targets.length) warns.push(`macro ${i + 1} has no targets`);
      for (const t of m?.targets || []) {
        const p = P.PARAM_BY_ID[t.id];
        if (!p) errs.push(`macro ${i + 1} target '${t.id}' unknown`);
        else if (p.type !== 'float' && p.type !== 'int') errs.push(`macro ${i + 1} target '${t.id}' is ${p.type} (must be float/int)`);
        if (!(t.amount >= -1 && t.amount <= 1)) errs.push(`macro ${i + 1} target '${t.id}' amount ${t.amount} outside −1..1`);
        // a macro on a mod slot's amount only does something if that slot has a source and a destination
        const ms = /^mod(\d)\.amt$/.exec(t.id || '');
        if (ms && (!params[`mod${ms[1]}.src`] || params[`mod${ms[1]}.src`] === 'none' || !params[`mod${ms[1]}.dst`] || params[`mod${ms[1]}.dst`] === 'none')) warns.push(`macro ${i + 1} targets ${t.id} but mod slot ${ms[1]} is not wired`);
      }
      if (m?.name && !/^[\u3400-\u9fff\uf900-\ufaff]+ [A-Za-z]/.test(m.name)) warns.push(`macro ${i + 1} name '${m.name}' is not '中文 English'`);
    });
  }
  // demoMacros: the ▶ 示範 macro ride [{index 0..3, to 0..1, beat ≥ 0, beats > 0}] inside the demo phrase
  if (preset.demoMacros !== undefined) {
    if (!Array.isArray(preset.demoMacros)) errs.push('demoMacros is not an array');
    else {
      const L = PHRASES[preset.demo]?.lengthBeats ?? Infinity;
      preset.demoMacros.forEach((r, k) => {
        if (!r || !Number.isInteger(r.index) || r.index < 0 || r.index > 3) errs.push(`demoMacros[${k}].index ${r?.index} not 0..3`);
        else if (!(preset.macros?.[r.index]?.targets || []).length) warns.push(`demoMacros[${k}] rides macro ${r.index + 1}, which has no targets`);
        if (!(r?.to >= 0 && r?.to <= 1)) errs.push(`demoMacros[${k}].to ${r?.to} not 0..1`);
        if (!(r?.beat >= 0) || !(r?.beats > 0)) errs.push(`demoMacros[${k}] beat/beats invalid (${r?.beat}/${r?.beats})`);
        else if (r.beat + r.beats > L + 1e-9) warns.push(`demoMacros[${k}] ends at beat ${r.beat + r.beats} > phrase length ${L}`);
      });
    }
  }
  return { errs, warns };
}

/**
 * Pitch-modulation depth in cents RMS (macro-effect check: vibrato, tape wow, slides, pitch blips have no
 * loudness/brightness/width signature). Instantaneous frequency of the dominant spectral peak (60 Hz–5 kHz) from
 * the phase advance between two FFTs `lag` samples apart, split into continuous-pitch runs (consecutive frames
 * < 50 ct apart, so note changes start a new run); RMS deviation from each run's median over runs ≥ 8 frames.
 * Measured: steady notes ≈ 1.5–3 ct; ±19 ct vibrato ≈ 12 ct; unison/detuned patches have a noisy baseline.
 */
function pitchWobble(L, R, sr, N = 4096, hop = 256, lag = 64) {
  const fft = getFFT(N), win = makeWindow('hann', N);
  const re1 = new Float64Array(N), im1 = new Float64Array(N), re2 = new Float64Array(N), im2 = new Float64Array(N);
  const n = L.length, track = [];
  let gmax = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(L[i] + R[i]); if (a > gmax) gmax = a; }
  const k0 = Math.max(1, Math.floor(60 * N / sr)), k1 = Math.min(N / 2 - 1, Math.ceil(5000 * N / sr));
  for (let s = 0; s + N + lag <= n; s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const x = 0.5 * (L[s + i] + R[s + i]), y = 0.5 * (L[s + lag + i] + R[s + lag + i]);
      re1[i] = x * win[i]; im1[i] = 0; re2[i] = y * win[i]; im2[i] = 0; e += x * x;
    }
    if (e / N < 1e-7 * gmax * gmax) { track.push(NaN); continue; }
    fft.transform(re1, im1); fft.transform(re2, im2);
    let bk = -1, bm = 0;
    for (let k = k0; k <= k1; k++) { const m = re1[k] * re1[k] + im1[k] * im1[k]; if (m > bm) { bm = m; bk = k; } }
    if (bk < 0) { track.push(NaN); continue; }
    let d = Math.atan2(im2[bk], re2[bk]) - Math.atan2(im1[bk], re1[bk]) - 2 * Math.PI * bk * lag / N;
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    const f = (bk + d * N / (2 * Math.PI * lag)) * sr / N;
    track.push(f > 0 ? 1200 * Math.log2(f / 440) : NaN);
  }
  let ss = 0, cnt = 0, run = [];
  const flush = () => {
    if (run.length >= 8) {
      const sorted = run.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      for (const c of run) { ss += (c - med) ** 2; cnt++; }
    }
    run = [];
  };
  for (const c of track) {
    if (!(c === c)) { flush(); continue; }
    if (run.length && Math.abs(c - run[run.length - 1]) > 50) flush();
    run.push(c);
  }
  flush();
  return cnt >= 8 ? Math.sqrt(ss / cnt) : 0;
}

async function jobPreset({ index, mode }) {
  const P = await load('src/dsp/params.js');
  const pm = await tryLoad('src/presets/index.js');
  const preset = (pm?.PRESETS || pm?.default || [])[index];
  const R = await import(pathToFileURL(path.join(HERE, 'render.mjs')).href);
  const A = await import(pathToFileURL(path.join(HERE, 'analyze.mjs')).href);
  const name = preset?.name ?? `#${index}`;
  const out = { suite: 'presets', name, status: 'PASS', detail: '', data: { name, category: preset?.category } };
  const fails = [], warns = [];
  const { errs, warns: vw } = validatePreset(P, preset, (pm?.CATEGORIES || []).map(c => c?.id).filter(Boolean));
  fails.push(...errs); warns.push(...vw);
  const M = await synthMod();
  if (!M) warns.unshift('render skipped: synth.js unavailable (see modules)');
  else {
    try {
      const phraseId = R.phraseFor(preset);
      const patch = R.buildPatch(preset);
      const allowed = await R.estimateTail(preset.params, getPhrase(phraseId).bpm);
      // with the preset's demoMacros ride: exactly what the ▶ 示範 button plays
      const res = await R.renderPhrase(patch, phraseId, { sampleRate: 48000, maxTail: allowed, quietDb: -80, synthMod: M, demoMacros: preset.demoMacros });
      const m = A.analyze(res.L, res.R, 48000, { lastNoteOff: res.lastNoteOff });
      Object.assign(out.data, {
        phrase: phraseId, peakDb: m.peakDb, lufs: m.lufs, dc: m.dcMax, nan: m.nanCount + m.infCount, centroid: m.centroidHz,
        tail: m.release?.tailToSilence, truncated: res.tailTruncated, voicesFreed: res.voicesFreed, allowed, width: m.width,
      });
      if (m.nanCount || m.infCount) fails.push(`${m.nanCount + m.infCount} NaN/Inf samples`);
      if (m.peak > 1) fails.push(`peak ${m.peak.toFixed(4)} > 1.0`);
      if (m.dcMax >= 0.01) fails.push(`DC offset ${m.dcMax.toFixed(4)} ≥ 0.01`);
      if (res.tailTruncated) {
        const endDb = m.endPeakDb;
        if (endDb > -60) fails.push(`not silent ${allowed.toFixed(1)} s after all notes off (end ${endDb.toFixed(0)} dBFS)`);
        else warns.push(`tail still ${endDb.toFixed(0)} dBFS after ${allowed.toFixed(1)} s (threshold −80)`);
      }
      if (res.voicesFreed === false) fails.push(`${res.activeVoicesAtEnd} voice(s) never freed`);
      if (m.peakDb < -40) warns.push(`very quiet (peak ${m.peakDb.toFixed(1)} dBFS)`);
    } catch (e) { fails.push(`render threw: ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}`); }
    // Macros: safe at both extremes and audibly doing something (1.5 s excerpt of the demo phrase).
    try {
      const phraseId = R.phraseFor(preset);
      const CUT = 1.5;
      const ev = phraseToTimedEvents(getPhrase(phraseId)).filter(e => e.time < CUT || e.type === 'off')
        .map(e => (e.type === 'off' && e.time > CUT ? { ...e, time: CUT } : e));
      const held = new Set(ev.filter(e => e.type === 'on').map(e => e.note));
      for (let k = ev.length - 1; k >= 0; k--) if (ev[k].type === 'off' && !held.has(ev[k].note)) ev.splice(k, 1);
      const base = R.buildPatch(preset);
      const macroVals = [1, 2, 3, 4].map(i => base.params[`macro${i}`] ?? 0);
      const probe = async (label, vals) => {
        const patch = { ...base, params: { ...base.params, macro1: vals[0], macro2: vals[1], macro3: vals[2], macro4: vals[3] } };
        const r = await R.renderEvents(patch, ev, { sampleRate: 48000, bpm: getPhrase(phraseId).bpm, maxTail: 0.3, synthMod: M });
        const m = A.analyze(r.L, r.R, 48000);
        m.wobble = pitchWobble(r.L, r.R, 48000);
        if (m.nanCount || m.infCount) fails.push(`macros ${label}: NaN/Inf`);
        if (m.peak > 1) fails.push(`macros ${label}: peak ${m.peak.toFixed(3)} > 1`);
        if (m.dcMax >= 0.01) warns.push(`macros ${label}: DC ${m.dcMax.toFixed(3)}`);
        if (m.peakDb < -50) warns.push(`macros ${label}: near-silent (peak ${m.peakDb.toFixed(0)} dBFS)`);
        return m;
      };
      const baseM = await probe('preset values', macroVals);
      await probe('all 0', [0, 0, 0, 0]);
      await probe('all 1', [1, 1, 1, 1]);
      if (mode !== 'quick') {
        const effects = [];
        for (let i = 0; i < 4; i++) {
          const vals = macroVals.slice();
          vals[i] = macroVals[i] < 0.5 ? 1 : 0;
          const m = await probe(`M${i + 1}=${vals[i]}`, vals);
          const dL = Math.abs((m.lufs ?? -70) - (baseM.lufs ?? -70));
          const dC = m.centroidHz && baseM.centroidHz ? Math.abs(Math.log2(m.centroidHz / baseM.centroidHz)) * 12 : 0;
          const dW = Math.abs(m.width - baseM.width);
          const dT = Math.abs((m.t60 ?? 0) - (baseM.t60 ?? 0));
          // pitch modulation (vibrato / wow / slides): change of the dominant partial's pitch deviation (cents RMS)
          const dP = Math.abs(m.wobble - baseM.wobble);
          const pitchFx = dP >= Math.max(1.5, 0.1 * baseM.wobble);
          effects.push(`M${i + 1} ${dL.toFixed(1)}LU/${dC.toFixed(1)}st/${dW.toFixed(2)}w/${dP.toFixed(1)}ct`);
          const hasTargets = (preset.macros?.[i]?.targets || []).length > 0;
          if (hasTargets && dL < 0.3 && dC < 0.25 && dW < 0.02 && dT < 0.1 && !pitchFx) warns.push(`macro ${i + 1} "${preset.macros[i].name}" has no measurable effect in a 1.5 s excerpt (loudness, brightness, width, decay, pitch)`);
        }
        out.data.macros = effects.join(' ');
      }
    } catch (e) { fails.push(`macro renders threw: ${String(e?.message || e).split('\n')[0]}`); }
    // Real-time factor: 8-voice chord, 1.5 s held + 0.5 s release (thread CPU time)
    try {
      const chord = [48, 55, 60, 64, 67, 71, 74, 79];
      const ev = [];
      chord.forEach((n, i) => { ev.push({ time: 0.002 * i, type: 'on', note: n, vel: 0.8 }); ev.push({ time: 1.5, type: 'off', note: n, vel: 0 }); });
      const patch = R.buildPatch(preset);
      M.renderOffline ? M.renderOffline(patch, ev.slice(0, 2), 0.1, 48000) : null; // warm-up
      const c0 = cpuMs();
      if (M.renderOffline) M.renderOffline(patch, ev, 2, 48000);
      else {
        const s = new M.Synth(48000);
        s.loadPatch(patch);
        renderSynth(s, 2, 48000, ev.map(e => ({ t: e.time, fn: x => (e.type === 'on' ? x.noteOn(e.note, e.vel) : x.noteOff(e.note)) })));
      }
      const sec = (cpuMs() - c0) / 1000;
      const rtf = 2 / Math.max(1e-6, sec);
      out.data.rtf = rtf;
      if (rtf < 2) fails.push(`8-voice chord renders at ${rtf.toFixed(2)}× real time (< 2×)`);
      else if (rtf < 4) warns.push(`8-voice chord only ${rtf.toFixed(1)}× real time`);
    } catch (e) { fails.push(`RTF render threw: ${e.message}`); }
  }
  out.status = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS';
  out.detail = [...fails.map(f => `✗ ${f}`), ...warns.slice(0, 4).map(w => `! ${w}`)].join('\n');
  return [out];
}

// Library-wide playing checks (regressions of sound-quality review items):
//  • chords: a 5-note two-hand chord (C3 G3 C4 E4 G4, velocity 0.9) must not push the synth's output limiter
//    more than 1.5 dB (phys plucks/mallets used to squash it by up to 6 dB);
//  • repeats: the same key played 8× must stay within 3 LU (Faded Summer's free-running osc vs FM carrier cancelled
//    by up to 10 LU; Bowed Nocturne's chorus/reverb combing by 5.5 LU);
//  • pedal: a "Pedal" macro at 1 must at least double the release tail (time to −40 dB) it has at 0.
async function jobPresetPlaying() {
  const pm = await tryLoad('src/presets/index.js');
  const M = await synthMod();
  const R = await import(pathToFileURL(path.join(HERE, 'render.mjs')).href);
  const A = await import(pathToFileURL(path.join(HERE, 'analyze.mjs')).href);
  const list = pm?.PRESETS || [];
  if (!M || !list.length) return [row('presets', 'playing checks', 'SKIP', 'synth.js or presets unavailable')];
  const sr = 48000, blk = 128;
  const rows = [];
  // chords
  {
    const fails = [], warns = [], worst = [];
    const L = new Float32Array(blk), Rb = new Float32Array(blk);
    for (const p of list) {
      if (p.category === 'drum') continue;
      const s = new M.Synth(sr, { seed: 1 });
      s.loadPatch(R.buildPatch(p));
      let red = 0;
      for (let b = 0; b < Math.round(0.6 * sr / blk); b++) {
        if (b === 2) for (const n of [48, 55, 60, 64, 67]) s.noteOn(n, 0.9);
        s.process(L, Rb, blk);
        red = Math.min(red, s.limiter.getReduction());
      }
      worst.push([p.name, red]);
      if (red < -1.5) fails.push(`${p.name}: limiter pulls ${(-red).toFixed(1)} dB on a 5-note chord (limit 1.5)`);
      else if (red < -1) warns.push(`${p.name}: limiter pulls ${(-red).toFixed(1)} dB on a 5-note chord`);
    }
    worst.sort((a, b) => a[1] - b[1]);
    rows.push(row('presets', 'playing: 5-note chord vs limiter', fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS',
      [`deepest: ${worst.slice(0, 3).map(([n, r]) => `${n} ${r.toFixed(2)} dB`).join(', ')}`, ...fails.map(f => `✗ ${f}`), ...warns.map(w => `! ${w}`)].join('\n')));
  }
  // repeats
  {
    const fails = [], notes = [];
    for (const name of ['Faded Summer', 'Bowed Nocturne']) {
      const p = list.find(x => x.name === name);
      if (!p) { fails.push(`${name}: preset missing`); continue; }
      const evs = [];
      for (let k = 0; k < 8; k++) evs.push({ time: k * 1.2, type: 'on', note: 64, vel: 0.8 }, { time: k * 1.2 + 1.0, type: 'off', note: 64 });
      const r = await R.renderEvents(R.buildPatch(p), evs, { maxTail: 1, bpm: 120, synthMod: M });
      const v = [];
      for (let k = 0; k < 8; k++) { const a = Math.round((k * 1.2 + 0.1) * sr), b = Math.round((k * 1.2 + 0.9) * sr); v.push(A.loudness(r.L.subarray(a, b), r.R.subarray(a, b), sr).integrated); }
      const spread = Math.max(...v) - Math.min(...v);
      notes.push(`${name} ${spread.toFixed(1)} LU`);
      if (!(spread <= 3)) fails.push(`${name}: the same E4 played 8× spreads ${spread.toFixed(1)} LU (limit 3)`);
    }
    rows.push(row('presets', 'playing: same key 8× loudness', fails.length ? 'FAIL' : 'PASS', [notes.join(' · '), ...fails.map(f => `✗ ${f}`)].join('\n')));
  }
  // pedal macros
  {
    const fails = [], notes = [];
    const tailTo40 = async (p, mi, val) => {
      const evs = [{ time: 0, type: 'on', note: 60, vel: 0.8 }, { time: 0.4, type: 'off', note: 60 }];
      const r = await R.renderEvents(R.buildPatch(p, { [`macro${mi + 1}`]: val }), evs, { maxTail: 8, bpm: 100, synthMod: M });
      const seg = (t0, t1) => { let e = 0; const i0 = Math.round(t0 * sr), i1 = Math.min(r.L.length, Math.round(t1 * sr)); for (let i = i0; i < i1; i++) e += r.L[i] * r.L[i] + r.R[i] * r.R[i]; return 10 * Math.log10(e / Math.max(1, i1 - i0) / 2 + 1e-20); };
      const held = seg(0.3, 0.4);
      for (let t = 0.4; t < 8; t += 0.05) if (seg(t, t + 0.05) < held - 40) return t - 0.4;
      return 8;
    };
    for (const p of list) {
      const mi = (p.macros || []).findIndex(m => /\bPedal\b/.test(m?.name || ''));
      if (mi < 0) continue;
      const t0 = await tailTo40(p, mi, 0), t1 = await tailTo40(p, mi, 1);
      notes.push(`${p.name} ${t0.toFixed(2)}→${t1.toFixed(2)} s`);
      if (!(t1 >= 2 * t0)) fails.push(`${p.name}: Pedal = 1 only stretches the release tail ${t0.toFixed(2)} → ${t1.toFixed(2)} s (want ≥ 2×)`);
    }
    rows.push(row('presets', 'playing: Pedal macros sustain', fails.length ? 'FAIL' : 'PASS', [notes.join(' · ') || 'no Pedal macros', ...fails.map(f => `✗ ${f}`)].join('\n')));
  }
  return rows;
}

// ───────────────────────── Worklet job ─────────────────────────
async function jobWorklet() {
  const file = path.join(ROOT, 'src/worklet/processor.js');
  if (!fs.existsSync(file)) return [row('worklet', 'processor.js', 'FAIL', 'missing src/worklet/processor.js')];
  const posted = [];
  const registered = {};
  globalThis.sampleRate = 48000;
  globalThis.currentTime = 0;
  globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => posted.push(m), onmessage: null, start() {}, close() {} }; } };
  globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
  const probs = [], warns = [];
  try {
    await import(pathToFileURL(file).href);
    const Cls = registered['aurora-synth'];
    if (!Cls) return [row('worklet', 'processor.js', 'FAIL', "registerProcessor('aurora-synth', …) was not called")];
    const proc = new Cls({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: {} });
    if (!posted.some(m => m?.type === 'ready')) warns.push("no {type:'ready'} message after construction");
    const send = data => proc.port.onmessage && proc.port.onmessage({ data });
    const pm = await tryLoad('src/presets/index.js');
    const preset = (pm?.PRESETS || [])[0];
    send({ type: 'patch', patch: preset || { params: {}, macros: [] } });
    send({ type: 'param', id: 'filter.cutoff', value: 3000 });
    send({ type: 'macro', index: 0, value: 0.5 });
    send({ type: 'ctrl', kind: 'wheel', value: 0.3 });
    send({ type: 'noteOn', note: 60, vel: 0.9 });
    send({ type: 'noteOn', note: 64, vel: 0.9 });
    const L = new Float32Array(128), R = new Float32Array(128);
    let peak = 0, nan = 0, keep = true;
    const run = blocks => {
      for (let k = 0; k < blocks; k++) {
        keep = proc.process([], [[L, R]], {}) !== false && keep;
        globalThis.currentFrame += 128; globalThis.currentTime = globalThis.currentFrame / 48000;
        for (let i = 0; i < 128; i++) { if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nan++; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
      }
    };
    run(375); // 1 s
    const playPeak = peak;
    const states = posted.filter(m => m?.type === 'state');
    if (!keep) probs.push('process() returned false (processor would be garbage-collected)');
    if (nan) probs.push(`${nan} NaN/Inf samples`);
    if (peak > 1) probs.push(`peak ${peak} > 1`);
    if (peak < 1e-3) probs.push('no sound after noteOn messages');
    if (states.length < 20) warns.push(`${states.length} state messages in 1 s (expected ≈30)`);
    else if (!Array.isArray(states.at(-1).state?.voices)) probs.push('state message lacks voices[]');
    send({ type: 'seqLoad', song: getPhrase('pluck') });
    send({ type: 'seqPlay' });
    run(200);
    send({ type: 'seqStop' });
    send({ type: 'allOff', hard: true });
    peak = 0;
    run(40);
    peak = 0; run(10);
    if (peak > 1e-4) warns.push(`output ${dB(peak).toFixed(0)} dBFS 100 ms after allOff(hard)`);
    const errors = posted.filter(m => m?.type === 'error');
    if (errors.length) probs.push(`error messages: ${errors.slice(0, 2).map(e => String(e.message).split('\n')[0]).join(' | ')}`);
    // mono output bus
    const M1 = new Float32Array(128);
    proc.process([], [[M1]], {});
    if (!M1.every(Number.isFinite)) probs.push('mono output bus → NaN');
    return [row('worklet', "AudioWorkletProcessor 'aurora-synth' (shimmed)", probs.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS',
      [`${states.length} state msgs/s · playing peak ${dB(Math.max(playPeak, 1e-12)).toFixed(1)} dBFS · ${dB(Math.max(peak, 1e-12)).toFixed(0)} dBFS 100 ms after panic`, ...probs.map(p => `✗ ${p}`), ...warns.map(w => `! ${w}`)].join('\n'))];
  } catch (e) {
    return [row('worklet', 'processor.js', 'FAIL', `threw: ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}`)];
  }
}

// ───────────────────────── Songs suite (demo songs · src/dsp/ensemble.js · src/demo) ─────────────────────────
// songlib helpers, every song in src/demo/songs resolved + rendered through the Ensemble + SafetyBus (as the
// browser plays it), engine behaviour (sample sync, seamless queue, lazy pool, stop/tails, mixer, allocation),
// and the worklet song messages.
const SONG_CEIL = 10 ** (-0.3 / 20);

async function songMods() {
  const [songs, resolve, lib, ens, pm, rs] = await Promise.all([
    load('src/demo/songs/index.js'), load('src/demo/resolve.js'), load('src/demo/songlib.js'),
    load('src/dsp/ensemble.js'), load('src/presets/index.js'), load('tools/render-song.mjs'),
  ]);
  return { SONGS: songs.SONGS, R: resolve, L: lib, E: ens, PRESETS: pm.PRESETS || [], RS: rs };
}

async function jobSonglib() {
  const probs = [], notes = [];
  let M;
  try { M = await songMods(); } catch (e) { return [row('songs', 'songlib / resolve', 'FAIL', `import failed: ${e.message}`)]; }
  const { L, R } = M;
  const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) probs.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
  const throws = (name, fn) => { try { fn(); probs.push(`${name}: did not throw`); } catch { /* expected */ } };
  eq('midi names', ['C4', 'C#4', 'Db4', 'Bb3', 'E♭5', 'Cb4', 'B#3', 'A-1', 'G9'].map(L.midi), [60, 61, 61, 58, 75, 59, 60, 9, 127]);
  eq('noteName', [L.noteName(61), L.noteName(61, { flats: true }), L.noteName(0)], ['C#4', 'Db4', 'C-1']);
  throws('midi("H2")', () => L.midi('H2'));
  throws('midi("C10")', () => L.midi('C10'));
  eq('chord Am7', L.chord('Am7'), [69, 72, 76, 79]);
  eq('chord C/E', L.chord('C/E'), [52, 60, 64, 67]);
  eq('chord Fmaj7 drop2', L.chord('Fmaj7', { voicing: 'drop2' }), [60, 65, 69, 76]);
  eq('chord G 1st inv', L.chord('G', { inversion: 1 }), [71, 74, 79]);
  throws('chord Xm', () => L.chord('Xm'));
  throws('chord Cfoo', () => L.chord('Cfoo'));
  const vl = L.voiceLead(['C', 'Am', 'F', 'G'], { range: ['C4', 'C6'] });
  let move = 0;
  for (let i = 1; i < vl.length; i++) for (let k = 0; k < 3; k++) move += Math.abs(vl[i][k] - vl[i - 1][k]);
  if (move > 12) probs.push(`voiceLead C-Am-F-G moves ${move} semitones (expected smooth ≤ 12): ${JSON.stringify(vl)}`);
  if (vl.flat().some(n => n < 60 || n > 84)) probs.push(`voiceLead outside range: ${JSON.stringify(vl)}`);
  eq('degree', [L.degree('D dorian', 0), L.degree({ root: 'A', scale: 'minor' }, 9, 3), L.degree('C major', -1)], [62, 72, 59]);
  eq('steps', L.steps('x.X-|o3', { note: 'C2' }).map(e => [e.beat, e.note, e.vel, e.dur]), [[0, 36, 0.8, 0.125], [0.5, 36, 1, 0.375], [1, 36, 0.4, 0.125], [1.25, 36, 0.3, 0.125]]);
  throws('steps bad char', () => L.steps('x?x'));
  eq('melody degrees', L.melody("1 3 5, 1' . -", { key: 'C major', step: 1 }).map(e => e.note), [60, 64, 55, 72]);
  const arp = L.arpeggiate(['C4', 'E4', 'G4'], { pattern: 'updown', rate: 0.5, beats: 4 });
  eq('arp updown', arp.map(e => e.note), [60, 64, 67, 64, 60, 64, 67, 64]);
  const h1 = JSON.stringify(L.humanize(arp, { seed: 5 })), h2 = JSON.stringify(L.humanize(arp, { seed: 5 })), h3 = JSON.stringify(L.humanize(arp, { seed: 6 }));
  if (h1 !== h2) probs.push('humanize not deterministic for the same seed');
  if (h1 === h3) probs.push('humanize identical for different seeds');
  eq('automate', L.automate('filter.cutoff', [[0, 400], [8, 4000]]).map(e => e.type), ['param', 'ramp']);
  const A = L.arrange([{ name: 'A', bars: 2, parts: { x: L.steps('x...') } }, { name: 'B', bars: 1, parts: { x: b => L.loopTo(L.steps('x.'), 0.5, b.beats) } }]);
  eq('arrange', [A.lengthBeats, A.sections.map(s => s.beat), A.tracks.x.length], [12, [0, 8], 9]);
  eq('loopTo cut', L.loopTo([{ beat: 0, type: 'on', note: 60, vel: 1, dur: 3 }], 2, 3).map(e => [e.beat, e.dur]), [[0, 3], [2, 1]]);
  // resolve: errors are clear
  const bad = { id: 'x', title: 'x', zh: 'x', bpm: 100, lengthBeats: 4, parts: [{ name: 'p', preset: 'No Such Preset', events: [] }] };
  try { R.resolveSong(bad, M.PRESETS); probs.push('resolveSong accepted an unknown preset'); } catch (e) { if (!/unknown preset/.test(e.message)) probs.push(`unclear error: ${e.message}`); }
  const bad2 = { ...bad, parts: [{ name: 'p', preset: M.PRESETS[0]?.name, params: { 'filter.cutof': 1 }, events: [{ beat: 0, type: 'on', note: 60, vel: 0.8, dur: 1 }, { beat: 1, type: 'ramp', id: 'global.bpm', to: 100, beats: 1 }] }] };
  try { R.resolveSong(bad2, M.PRESETS); probs.push('resolveSong accepted unknown/global params'); } catch (e) { if (!/filter\.cutof/.test(e.message) || !/global/.test(e.message)) probs.push(`unclear error: ${e.message.split('\n').slice(0, 3).join(' ')}`); }
  eq('songDuration', R.songDuration({ bpm: 120, lengthBeats: 32 }), 16);
  // purity of src/demo (loaded by the UI, the worklet side never sees it, Node renders it)
  for (const f of walk(path.join(ROOT, 'src/demo'), ['.js'])) {
    const code = stripComments(fs.readFileSync(f, 'utf8')).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    if (/\bMath\.random\s*\(/.test(code)) probs.push(`${rel(f)}: Math.random() (use songlib rngOf)`);
    if (/(^|[^.\w$])(window|document|localStorage|process)\s*[.[]/m.test(code)) probs.push(`${rel(f)}: browser/Node global`);
  }
  notes.push(`${Object.keys(L).length} helpers`, `${M.SONGS.length} songs`);
  return [row('songs', 'songlib + resolve (helpers, errors, purity)', probs.length ? 'FAIL' : 'PASS', [notes.join(' · '), ...probs.slice(0, 10).map(p => `✗ ${p}`)].join('\n'))];
}

async function jobSongRender({ index, mode }) {
  const M = await songMods();
  const def = M.SONGS[index];
  const name = `song ${def?.id ?? index}`;
  const out = { suite: 'songs', name, status: 'PASS', detail: '', data: { song: def?.id } };
  const fails = [], warns = [];
  const v = M.R.validateSong(def, M.PRESETS);
  if (v.errors.length) return [{ ...out, status: 'FAIL', detail: v.errors.slice(0, 6).map(e => `✗ ${e}`).join('\n') }];
  for (const w of v.warnings) warns.push(w.replace(/^song "[^"]+" /, ''));
  let res, ens = null;
  // capture the Ensemble (renderSong does not return it) to read each part Synth's droppedNotes counter
  const Ens = class extends M.E.Ensemble { constructor(...a) { super(...a); ens = this; } };
  // --quick: the first 8 bars only (full-length songs take ≈ songSeconds / 4 of CPU each)
  try { res = await M.RS.renderSong(def, { sampleRate: 48000, tail: mode === 'quick' ? 4 : 8, maxBeats: mode === 'quick' ? 32 : 0, profile: false, mods: { SONGS: M.SONGS, resolveSong: M.R.resolveSong, songDuration: M.R.songDuration, PRESETS: M.PRESETS, Ensemble: Ens, SafetyBus: M.E.SafetyBus } }); }
  catch (e) { return [{ ...out, status: 'FAIL', detail: `✗ render threw: ${String(e?.stack || e).split('\n').slice(0, 2).join(' ')}` }]; }
  // voice stealing must never drop a note before it sounds (regression: overlapping pad/string chords at poly 6)
  const dropped = ens ? ens.slots.reduce((a, s) => a + (s.synth.droppedNotes | 0), 0) : 0;
  if (dropped) fails.push(`${dropped} notes dropped by voice stealing (stolen before they sounded) — voice.poly too low for the chords, or an allocator regression`);
  const m = M.RS.songMetrics(res);
  if (m.mix.nanCount || m.mix.infCount) fails.push(`${m.mix.nanCount + m.mix.infCount} NaN/Inf samples`);
  if (m.mix.peak > SONG_CEIL * 1.0001) fails.push(`peak ${m.mix.peakDb} dBFS above the −0.3 dBFS safety ceiling`);
  if (m.mix.dcMax > 0.01) fails.push(`DC offset ${m.mix.dcMax}`);
  for (const p of m.parts) if (p.notes > 0 && !(p.peakDb > -50)) fails.push(`part "${p.name}" (${p.preset}) is silent (peak ${p.peakDb} dBFS)`);
  if (m.mix.lufs == null || m.mix.lufs < -24 || m.mix.lufs > -10) warns.push(`mix loudness ${m.mix.lufs} LUFS (aim −18…−13)`);
  if (m.limiterMaxReductionDb < -3) warns.push(`safety limiter pulls ${-m.limiterMaxReductionDb} dB (pre-limit peak ${m.preLimitPeakDb} dBFS) — lower part gains`);
  if (res.tailTruncated) warns.push('still sounding at the end of the render (tail cap reached)');
  // CPU: gate on sounding voices (deterministic; each ≈1–1.7 % of an M-series core, Chrome's worklet ≈ ×1.4) —
  // measured thread CPU is informational (parallel test workers land on efficiency cores).
  const load = res.cpuPeakLoad;
  if (res.voicesPeak > 48) fails.push(`${res.voicesPeak} voices sound at once (budget 32) — cap voice.poly per part / shorten releases`);
  else if (res.voicesPeak > 32) warns.push(`${res.voicesPeak} voices sound at once (budget 32) — consider voice.poly caps`);
  if (res.cpuMeanLoad > 1) warns.push(`rendering slower than real time on this machine (${(res.cpuMeanLoad * 100).toFixed(0)} % of a core after warm-up)`);
  Object.assign(out.data, { lufs: m.mix.lufs, peakDb: m.mix.peakDb, voicesPeak: res.voicesPeak, cpuPeak: load, cpuMean: res.cpuMeanLoad, rtf: res.rtf });
  out.status = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS';
  out.detail = [`${m.mix.lufs} LUFS · peak ${m.mix.peakDb} dBFS (pre-limit ${m.preLimitPeakDb}) · ${res.song.parts.length} parts · ${res.voicesPeak} voices peak · CPU mean ${(res.cpuMeanLoad * 100).toFixed(0)} % / peak ${(load * 100).toFixed(0)} % of a core · ${res.rtf.toFixed(1)}× RT`,
    ...fails.map(f => `✗ ${f}`), ...warns.slice(0, 5).map(w => `! ${w}`)].join('\n');
  return [out];
}

async function jobEnsemble() {
  const { E } = await songMods();
  const rows = [];
  const add = (name, probs, detail = '') => rows.push(row('songs', `ensemble: ${name}`, probs.length ? 'FAIL' : 'PASS', [detail, ...probs.map(p => `✗ ${p}`)].filter(Boolean).join('\n')));
  const sr = 48000;
  const det = shape => ({ params: { 'osc1.drift': 0, 'osc1.phase': 'reset', 'osc1.shape': shape, 'filter.on': false, 'aenv.a': 0, 'aenv.r': 0.02 }, macros: [] });
  const onsets = (x, thr = 1e-3, gap = 2000) => { const r = []; let q = gap + 1; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > thr && q > gap) r.push(i); q = a > thr ? 0 : q + 1; } return r; };
  const run = (ens, seconds, blockSizes = [128], each = null) => {
    const n = Math.round(seconds * sr), L = new Float32Array(n), R = new Float32Array(n);
    const bl = new Float32Array(256), br = new Float32Array(256);
    let pos = 0, k = 0;
    while (pos < n) {
      const len = Math.min(blockSizes[k++ % blockSizes.length], n - pos);
      bl.fill(0, 0, len); br.fill(0, 0, len);
      if (each) each(pos, ens);
      ens.process(bl, br, len);
      L.set(bl.subarray(0, len), pos); R.set(br.subarray(0, len), pos);
      pos += len;
    }
    return { L, R };
  };
  // 1. sample-synchronous parts (identical deterministic parts, odd host block sizes, 97.3 BPM, looping)
  try {
    const ev = Array.from({ length: 24 }, (_, b) => ({ beat: b * 0.37, type: 'on', note: 60 + (b % 5), vel: 0.8, dur: 0.2 }));
    const ens = new E.Ensemble(44100, { eager: true });
    const stems = [[], [], [], [], []];
    ens.tap = (i, l, r, n) => { if (i >= 0) for (let k = 0; k < n; k++) stems[i].push(l[k]); };
    ens.load({ bpm: 97.3, lengthBeats: 9, loop: true, parts: [0, 1, 2, 3, 4].map(i => ({ name: `p${i}`, patch: det(0), gain: -12, events: ev })) });
    ens.play();
    const n0 = Math.round(8 * 44100); let pos = 0, k = 0; const sizes = [128, 37, 200, 16, 1, 99]; const bl = new Float32Array(256), br = new Float32Array(256);
    while (pos < n0) { const len = sizes[k++ % sizes.length]; bl.fill(0); br.fill(0); ens.process(bl, br, len); pos += len; }
    let diff = 0;
    for (let p = 1; p < 5; p++) for (let i = 0; i < stems[0].length; i++) diff = Math.max(diff, Math.abs(stems[p][i] - stems[0][i]));
    const probs = [];
    if (diff !== 0) probs.push(`parts drift apart: max difference ${diff}`);
    if (!(onsets(Float32Array.from(stems[0])).length > 10)) probs.push('no notes rendered');
    add('5 parts sample-synchronous (odd block sizes, loops)', probs, `${stems[0].length} samples · max |Δ| between parts ${diff}`);
  } catch (e) { add('5 parts sample-synchronous', [`threw ${e.message}`]); }
  // 2. seamless queue at the loop end (and tempo change)
  try {
    const A = { id: 'A', bpm: 123, lengthBeats: 4, loop: true, parts: [{ name: 'x', patch: det(0), gain: -6, events: [{ beat: 0, type: 'on', note: 60, vel: 1, dur: 1 }] }, { name: 'y', patch: det(0.33), gain: -6, events: [{ beat: 2, type: 'on', note: 67, vel: 1, dur: 1 }] }] };
    const B = { id: 'B', bpm: 90, lengthBeats: 3, loop: true, parts: [{ name: 'z', patch: det(1), gain: -6, events: [{ beat: 0, type: 'on', note: 72, vel: 1, dur: 0.5 }] }, { name: 'x', patch: det(0), gain: -6, events: [{ beat: 0, type: 'on', note: 48, vel: 1, dur: 0.5 }] }] };
    const mk = queue => { const ens = new E.Ensemble(sr, { eager: true }); ens.load(A); ens.play(); let q = false; return { ens, out: run(ens, 6, [128], (pos, en) => { if (queue && !q && pos >= sr * 0.5) { en.queue(B); q = true; } }) }; };
    const ref = mk(false), q = mk(true);
    const oRef = onsets(ref.out.L), oQ = onsets(q.out.L);
    const probs = [];
    // second pass of A (ref) starts where B starts (q); then B repeats every 3 beats at 90 BPM (2 s)
    // onsets: [A.x beat 0, A.y beat 2, loop boundary (ref: A.x again · queued: B), …]
    if (!(Math.abs(oQ[2] - oRef[2]) <= 2)) probs.push(`switch at ${oQ[2]} but loop boundary at ${oRef[2]}`);
    if (!(Math.abs(oQ[3] - oQ[2] - 2 * sr) <= 2)) probs.push(`queued song period ${(oQ[3] - oQ[2])} samples, want ${2 * sr}`);
    if (q.ens.getState().id !== 'B') probs.push(`state.id ${q.ens.getState().id} after the switch`);
    add('queue → seamless switch at the loop end', probs, `loop boundary sample ${oRef[2]} · switch ${oQ[2]} · next ${oQ[3]}`);
  } catch (e) { add('queue → seamless switch', [`threw ${e.message}`]); }
  // 3. lazy, incremental pool; load waits for parts
  try {
    const probs = [];
    const ens = new E.Ensemble(sr, { buildEvery: 4 });
    ens.hostIdle = false;
    const bl = new Float32Array(128), br = new Float32Array(128);
    for (let i = 0; i < 40; i++) ens.process(bl, br, 128);
    if (ens.built !== 0) probs.push(`built ${ens.built} parts while the host was busy and nothing needed them`);
    const song = { bpm: 120, lengthBeats: 4, parts: [0, 1, 2].map(i => ({ name: `p${i}`, patch: det(0.5), events: [{ beat: 0, type: 'on', note: 60, vel: 0.8, dur: 1 }] })) };
    if (ens.load(song) !== false) probs.push('load() reported ready without parts');
    ens.play();
    let calls = 0, maxPerCall = 0, prev = ens.built, peak = 0;
    while (!ens.playing && calls < 200) { bl.fill(0); ens.process(bl, br, 128); calls++; maxPerCall = Math.max(maxPerCall, ens.built - prev); prev = ens.built; }
    for (let i = 0; i < 100; i++) { bl.fill(0); ens.process(bl, br, 128); for (const x of bl) peak = Math.max(peak, Math.abs(x)); }
    if (!ens.playing) probs.push('song never started');
    if (ens.built !== 3) probs.push(`built ${ens.built} parts for a 3-part song while busy (want exactly 3)`);
    if (maxPerCall > 1) probs.push(`${maxPerCall} parts constructed in one process() call`);
    if (!(peak > 1e-3)) probs.push('no sound after the deferred start');
    const idle = new E.Ensemble(sr, { buildEvery: 3 });
    for (let i = 0; i < 3 * 6 + 2; i++) idle.process(bl, br, 128);
    if (idle.built !== 6) probs.push(`idle pre-build made ${idle.built}/6 parts in ${3 * 6 + 2} calls`);
    add('lazy part pool (one Synth per N calls; load waits)', probs, `3-part song started after ${calls} calls · construction ≈${ens.buildMs.toFixed(1)} ms/part`);
  } catch (e) { add('lazy part pool', [`threw ${e.message}`]); }
  // 4. stop / tails / hard stop / one-shot end / mixer
  try {
    const probs = [];
    const pad = { params: { 'aenv.a': 0.01, 'aenv.r': 0.5, 'reverb.on': true, 'reverb.decay': 6, 'reverb.mix': 0.4 }, macros: [] };
    const song = { bpm: 120, lengthBeats: 8, loop: true, parts: [{ name: 'pad', patch: pad, gain: -6, events: [{ beat: 0, type: 'on', note: 60, vel: 0.8, dur: 8 }] }, { name: 'b', patch: det(0.6), gain: -6, events: [0, 1, 2, 3].map(b => ({ beat: b * 2, type: 'on', note: 48, vel: 0.9, dur: 1 })) }] };
    const ens = new E.Ensemble(sr, { eager: true });
    ens.stopHold = 0.5; ens.stopFade = 0.5;
    ens.load(song); ens.play();
    run(ens, 1);
    const pk = ens.getState().parts.map(p => p.peak);
    if (!(pk[0] > 0.01 && pk[1] > 0.01)) probs.push(`part peaks ${pk} while playing`);
    ens.setPart('b', { mute: true });
    let o = run(ens, 0.5);
    ens.getState();
    o = run(ens, 0.3);
    const mutedPeak = ens.getState().parts[1].peak;
    if (mutedPeak > 1e-4) probs.push(`muted part still at ${dB(mutedPeak).toFixed(0)} dBFS`);
    ens.setPart('b', { mute: false }); ens.setPart(0, { solo: true });
    run(ens, 0.3); ens.getState(); run(ens, 0.3);
    if (ens.getState().parts[1].peak > 1e-4) probs.push('solo did not silence the other part');
    ens.setPart(0, { solo: false });
    ens.stop();
    o = run(ens, 0.3);
    let p1 = 0; for (const x of o.L) p1 = Math.max(p1, Math.abs(x));
    if (!(p1 > 1e-4)) probs.push('tails cut immediately on stop()');
    o = run(ens, 1.2);
    let p2 = 0; for (let i = o.L.length - 4800; i < o.L.length; i++) p2 = Math.max(p2, Math.abs(o.L[i]));
    if (p2 > 1e-5 || ens.active) probs.push(`still ${dB(p2).toFixed(0)} dBFS / active=${ens.active} 1.5 s after stop (hold 0.5 + fade 0.5)`);
    ens.play(); run(ens, 0.5); ens.stop(true);
    o = run(ens, 0.03);
    let p3 = 0; for (let i = o.L.length - 480; i < o.L.length; i++) p3 = Math.max(p3, Math.abs(o.L[i]));
    if (p3 > 1e-4) probs.push(`hard stop: ${dB(p3).toFixed(0)} dBFS after 20 ms`);
    const shot = new E.Ensemble(sr, { eager: true });
    shot.maxEndTail = 8;
    shot.load({ ...song, loop: false, lengthBeats: 4 }); shot.play();
    run(shot, 2.2);
    if (!shot.playing) probs.push('one-shot song stopped before its tails ended');
    run(shot, 12);
    if (shot.playing || shot.beat !== 4) probs.push(`one-shot song: playing=${shot.playing} beat=${shot.beat} after its end + tails`);
    // a part's scale lock (global-scope param) must not leak into the next song on the same (reused) Synth
    const one = new E.Ensemble(sr, { eager: true, maxParts: 1 });
    const sc = params => ({ bpm: 120, lengthBeats: 4, parts: [{ name: 'k', patch: { params: { ...det(0).params, ...params }, macros: [] }, events: [{ beat: 0, type: 'on', note: 61, vel: 0.8, dur: 2 }] }] });
    one.load(sc({ 'scale.type': 'major', 'scale.root': 0 })); one.play(); run(one, 0.2);
    const n1 = one.getState().parts[0].notes.join();
    one.load(sc({})); one.play(); run(one, 0.2);
    const n2 = one.getState().parts[0].notes.join();
    if (n1 !== '60' || n2 !== '61') probs.push(`part scale lock: C# → ${n1} (C major lock), then ${n2} in the next song without a lock (want 60, 61)`);
    add('stop tails / hard stop / one-shot end / mute / solo / reuse', probs);
  } catch (e) { add('stop / mixer', [`threw ${e.stack}`]); }
  // 5. SafetyBus: ceiling holds for a hot sum, bypass is transparent
  try {
    const probs = [];
    const bus = new E.SafetyBus(sr);
    const L = new Float32Array(128), R = new Float32Array(128);
    let pk = 0;
    for (let b = 0; b < 400; b++) {
      bus.engaged = b >= 5 && b < 300;
      for (let i = 0; i < 128; i++) { const t = b * 128 + i; L[i] = 2.5 * Math.sin(t * 0.05); R[i] = -2 * Math.sin(t * 0.031); }
      bus.process(L, R, 128);
      if (b >= 5 && b < 300) for (let i = 0; i < 128; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    }
    if (pk > SONG_CEIL * 1.0001) probs.push(`engaged/crossfading output ${dB(pk).toFixed(2)} dBFS > −0.3`);
    // disengaged under a continuous signal: aligned (delayed) until the input has been silent ≥ 2 × latency
    L.fill(0); R.fill(0); bus.process(L, R, 128); L.fill(0); R.fill(0); bus.process(L, R, 128);
    L.fill(0.25); bus.process(L, R, 128);
    if (L[5] !== 0.25) probs.push('disengaged bus is not a bypass after silence');
    // no comb filter at engage (from silence) / disengage (held tone): the crossfades mix time-aligned copies
    // (regression: dry vs 1.5 ms-late limited → −24 dB dips on a held 1 kHz tone at song start / end)
    const combDip = (engageAt, disengageAt, startAt) => {
      const b2 = new E.SafetyBus(sr), N = Math.round(0.6 * sr), out = new Float32Array(N);
      const f = 1000, lat = b2.latency;
      for (let b = 0; b * 128 < N; b++) {
        b2.engaged = b * 128 >= engageAt && b * 128 < disengageAt;
        for (let i = 0; i < 128; i++) { const t = b * 128 + i; L[i] = R[i] = t >= startAt ? 0.25 * Math.sin(2 * Math.PI * f * t / sr) : 0; }
        b2.process(L, R, 128);
        out.set(L.subarray(0, Math.min(128, N - b * 128)), b * 128);
      }
      let worst = 0; // 1 ms (= one period) RMS, from 5 ms after the tone starts to the end
      for (let s0 = startAt + lat + 240; s0 + 48 <= N; s0 += 12) { let e = 0; for (let i = s0; i < s0 + 48; i++) e += out[i] * out[i]; worst = Math.min(worst, 20 * Math.log10(Math.sqrt(e / 48) / (0.25 / Math.SQRT2) + 1e-12)); }
      return worst;
    };
    const dDis = combDip(0, 128 * 131, 128 * 19), dEng = combDip(128 * 38, 1e9, 128 * 38); // (block boundaries)
    if (dDis < -1) probs.push(`disengage with a held 1 kHz tone dips ${dDis.toFixed(1)} dB (comb: dry vs delayed limiter output)`);
    if (dEng < -1) probs.push(`engage from silence (tone starts with the song) dips ${dEng.toFixed(1)} dB`);
    add('SafetyBus ceiling + bypass + comb-free crossfades', probs, `peak ${dB(pk).toFixed(2)} dBFS while engaged · 1 kHz dip at disengage ${dDis.toFixed(1)} dB · at engage from silence ${dEng.toFixed(1)} dB`);
  } catch (e) { add('SafetyBus', [`threw ${e.message}`]); }
  // 6. allocation in the audio path: the ensemble's own overhead (osc-only parts: engines that don't allocate),
  //    then a real song for information (phys-model presets allocate inside the Synth, not in the ensemble)
  try {
    let gc = null;
    try { const vm = await import('node:vm'); v8.setFlagsFromString('--expose-gc'); gc = vm.runInNewContext('gc'); } catch { /* none */ }
    const young = () => { let u = 0; for (const sp of v8.getHeapSpaceStatistics()) if (/^new_space$|^new_large_object_space$/.test(sp.space_name)) u += sp.space_used_size; return u; };
    const perBlock = step => {
      for (let k = 0; k < 3000; k++) step();
      let best = Infinity;
      for (let w = 0; w < 3; w++) {
        if (gc) { gc(); gc(); }
        const h0 = young();
        for (let k = 0; k < 1000; k++) step();
        const d = young() - h0;
        if (d >= 0) best = Math.min(best, d);
      }
      return (best === Infinity ? 0 : best) / 1000;
    };
    const L = new Float32Array(128), R = new Float32Array(128);
    // getState() at the processor's rate (every 12th block ≈ 30 Hz), like the worklet's state messages
    const mk = song => { const ens = new E.Ensemble(sr, { eager: true }); ens.load(song); ens.play(); const bus = new E.SafetyBus(sr); bus.engaged = true; let k = 0; return () => { L.fill(0); R.fill(0); ens.process(L, R, 128); bus.process(L, R, 128); if (++k % 12 === 0) ens.getState(); }; };
    const ev = Array.from({ length: 16 }, (_, b) => ({ beat: b * 0.5, type: 'on', note: 48 + (b * 5) % 24, vel: 0.8, dur: 0.4 }));
    const own = perBlock(mk({ bpm: 128, lengthBeats: 8, loop: true, parts: [0, 1, 2, 3, 4].map(i => ({ name: `p${i}`, patch: { params: { 'reverb.on': true, 'delay.on': true, 'chorus.on': true, 'osc1.unison': 3 }, macros: [] }, events: ev })) }));
    const { SONGS, R: Rv, PRESETS } = await songMods();
    const real = perBlock(mk(Rv.resolveSong(SONGS[0], PRESETS)));
    rows.push(row('songs', 'ensemble: allocation in the audio path', own > 160 ? 'WARN' : 'PASS',
      `ensemble + safety bus + getState@30 Hz: ${own.toFixed(0)} B per 128 samples (5 osc parts, all FX; a bare Synth + sequencer ≈ 30 B) · song "${SONGS[0].id}": ${real.toFixed(0)} B (from its part Synths)${gc ? '' : ' · gc not exposed'}` +
      (own > 160 ? '\n! allocation in Ensemble.process/getState → GC pauses in the AudioWorklet' : '')));
  } catch (e) { add('allocation', [`threw ${e.message}`]); }
  return rows;
}

async function jobSongWorklet() {
  const file = path.join(ROOT, 'src/worklet/processor.js');
  const posted = [];
  const registered = {};
  globalThis.sampleRate = 48000; globalThis.currentTime = 0; globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => posted.push(m), onmessage: null, start() {}, close() {} }; } };
  globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
  const probs = [], info = [];
  try {
    await import(pathToFileURL(file).href);
    const Cls = registered['aurora-synth'];
    const proc = new Cls({ processorOptions: {} });
    const send = data => proc.port.onmessage && proc.port.onmessage({ data });
    const { SONGS, R: Rv, PRESETS } = await songMods();
    const L = new Float32Array(128), R = new Float32Array(128);
    let peak = 0, nan = 0;
    const run = blocks => { for (let k = 0; k < blocks; k++) { proc.process([], [[L, R]], {}); globalThis.currentFrame += 128; globalThis.currentTime = globalThis.currentFrame / 48000; for (let i = 0; i < 128; i++) { if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nan++; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); } } };
    const lastState = () => posted.filter(m => m?.type === 'state').at(-1)?.state;
    // JIT warm-up (UI 'warmup' message): runs on a borrowed free pool Synth once the pool is built (no private
    // ≈9 MB Synth) and must hand it back silent, FX-clean and with its patch key cleared when a song message
    // arrives mid-warm-up (a song part must never inherit warm-up voices / tails / a stale patch)
    const warmPats = PRESETS.slice(0, 4).map(p => ({ params: p.params || {}, macros: p.macros || [] }));
    send({ type: 'warmup', patches: warmPats });
    run(90); // idle: the part pool builds in the background, then the warm-up starts
    const built = lastState()?.song?.built;
    if (!(built >= 5)) probs.push(`only ${built} song parts built after 240 ms idle`);
    const borrowed = proc.warmSlot;
    if ('warmSynth' in proc && proc.warmSynth) probs.push('warm-up constructed a private Synth (should borrow a free pool Synth)');
    if (!borrowed) info.push('(warm-up not running at 240 ms: borrow check skipped)');
    // user's synth: loud chord, then a song on top
    send({ type: 'patch', patch: { params: { 'amp.level': 6, 'osc1.unison': 3 }, macros: [] } });
    for (const n of [48, 55, 60, 64, 67]) send({ type: 'noteOn', note: n, vel: 1 });
    const song = Rv.resolveSong(SONGS[1], PRESETS);
    send({ type: 'songLoad', song });
    if (borrowed) {
      const act = borrowed.synth.voices.filter(v => v.active).length;
      if (proc.warmSlot) probs.push('songLoad did not hand the warm-up Synth back');
      if (act || borrowed.key !== '' || borrowed.synth.fx.tailActive()) probs.push(`warm-up Synth handed back dirty (${act} voices, key ${JSON.stringify(borrowed.key)}, FX tail ${borrowed.synth.fx.tailActive()})`);
    }
    send({ type: 'songPlay' });
    peak = 0; run(375 * 2);
    let st = lastState();
    if (!st?.song?.playing) probs.push('state.song.playing is not true 2 s after songPlay');
    const partPeaks = [];
    for (let k = 0; k < 8; k++) { run(12); st = lastState(); st.song.parts.forEach((p, i) => { partPeaks[i] = Math.max(partPeaks[i] || 0, p.peak); }); }
    if (!partPeaks.length || partPeaks.some(p => !(p > 0))) probs.push(`part peaks ${partPeaks.map(p => p.toFixed(3))}`);
    if (!(st.voices.length >= 5)) probs.push(`user's synth voices ${st.voices.length} while the song plays (want the held chord)`);
    if (st.bpm !== song.bpm) probs.push(`user's synth tempo ${st.bpm} ≠ song ${song.bpm}`);
    if (peak > SONG_CEIL * 1.0001) probs.push(`output ${dB(peak).toFixed(2)} dBFS above the −0.3 dBFS ceiling`);
    info.push(`song+synth peak ${dB(peak).toFixed(1)} dBFS · ${st.song.parts.length} parts · section ${st.song.section?.zh ?? '—'}`);
    send({ type: 'songPart', part: 0, mute: true });
    // the part fader glides with a 15 ms one-pole: a unit-level hit needs ≈140 ms to fall below −80 dB, so check
    // the state window 185–213 ms after the mute (the old 100–133 ms window failed whenever a kick hit landed in it)
    run(60); lastState(); run(20);
    if (lastState().song.parts[0].peak > 1e-4 || !lastState().song.parts[0].mute) probs.push('songPart mute had no effect');
    send({ type: 'songQueue', song: Rv.resolveSong(SONGS[4], PRESETS) });
    if (lastState().song.queued !== null && lastState().song.queued !== undefined) { /* reported next state */ }
    run(20);
    if (lastState().song.queued !== SONGS[4].id) probs.push(`state.song.queued = ${lastState().song.queued}`);
    send({ type: 'songStop' });
    run(20);
    if (lastState().song.playing) probs.push('songStop did not stop');
    if (lastState().bpm === song.bpm) probs.push('user tempo not restored after songStop');
    send({ type: 'songPlay' }); run(100);
    send({ type: 'allOff', hard: true });
    peak = 0; run(40); peak = 0; run(10);
    if (peak > 1e-4) probs.push(`panic (allOff hard) leaves ${dB(peak).toFixed(0)} dBFS after 100 ms`);
    if (lastState().song.playing) probs.push('panic did not stop the song');
    send({ type: 'songLoad', song: { parts: [] } });
    const errs = posted.filter(m => m?.type === 'error');
    if (!errs.some(e => /no parts/.test(e.message))) probs.push('invalid song did not report an error message');
    if (errs.length > 1) probs.push(`unexpected errors: ${errs.slice(0, 2).map(e => String(e.message).split('\n')[0]).join(' | ')}`);
    if (nan) probs.push(`${nan} NaN/Inf samples`);
    return [row('songs', "worklet: song messages (songLoad/Play/Part/Queue/Stop)", probs.length ? 'FAIL' : 'PASS', [info.join(' · '), ...probs.map(p => `✗ ${p}`)].join('\n'))];
  } catch (e) {
    return [row('songs', 'worklet: song messages', 'FAIL', `threw: ${String(e?.stack || e).split('\n').slice(0, 3).join(' ')}`)];
  }
}

// Magic sound tools (tools/magic-checks.mjs): moods × presets, mood text parser, store transient API, morph, evolve.
async function jobMagic() {
  try {
    const { magicChecks } = await import(pathToFileURL(path.join(ROOT, 'tools/magic-checks.mjs')).href);
    return (await magicChecks(ROOT)).map(c => row('magic', c.name, c.probs.length ? 'FAIL' : 'PASS', [c.info, ...c.probs.map(p => `✗ ${p}`)].filter(Boolean).join('\n')));
  } catch (e) {
    return [row('magic', 'magic tools', 'FAIL', `threw: ${String(e?.stack || e).split('\n').slice(0, 3).join(' ')}`)];
  }
}

// App shell logic (tools/ui-checks.mjs): store undo/dirty semantics, preset library storage, MIDI unplug, a11y names, layout guards.
async function jobUi() {
  try {
    const { uiChecks } = await import(pathToFileURL(path.join(ROOT, 'tools/ui-checks.mjs')).href);
    return (await uiChecks(ROOT)).map(c => row('ui', c.name, c.probs.length ? 'FAIL' : 'PASS', [c.info, ...c.probs.map(p => `✗ ${p}`)].filter(Boolean).join('\n')));
  } catch (e) {
    return [row('ui', 'ui shell', 'FAIL', `threw: ${String(e?.stack || e).split('\n').slice(0, 3).join(' ')}`)];
  }
}

/** Platform compatibility (tools/compat-checks.mjs): https dev server, src/ui/compat.js, createAudio() rate cap, saved-data shapes, DSP at 16–192 kHz. */
async function jobCompat({ part, mode }) {
  try {
    const { compatChecks } = await import(pathToFileURL(path.join(ROOT, 'tools/compat-checks.mjs')).href);
    return (await compatChecks(ROOT, { part, mode })).map(c => row('compat', c.name, c.probs.length ? 'FAIL' : 'PASS', [c.info, ...c.probs.map(p => `✗ ${p}`)].filter(Boolean).join('\n')));
  } catch (e) {
    return [row('compat', `compat ${part}`, 'FAIL', `threw: ${String(e?.stack || e).split('\n').slice(0, 3).join(' ')}`)];
  }
}

// ───────────────────────── Job dispatch ─────────────────────────
const JOBS = {
  engineConfig: jobEngineConfig, engineQuality: jobEngineQuality, filter: jobFilter, filterResponse: jobFilterResponse,
  fx: jobFx, fxTail: jobFxTailAndCpu, synthApi: jobSynthApi, synthStress: jobSynthStress, synthAlloc: jobSynthAlloc, preset: jobPreset, presetPlaying: jobPresetPlaying, worklet: jobWorklet,
  songlib: jobSonglib, songRender: jobSongRender, ensemble: jobEnsemble, songWorklet: jobSongWorklet, magic: jobMagic,
  compat: jobCompat, ui: jobUi,
};

async function runJob(job) {
  try {
    return await JOBS[job.kind](job.args);
  } catch (e) {
    return [row(job.suite, job.name || job.kind, 'FAIL', `test harness error: ${String(e?.stack || e).split('\n').slice(0, 3).join(' ')}`)];
  }
}

async function buildJobs(suites, mode, presetFilter) {
  const jobs = [];
  const P = await tryLoad('src/dsp/params.js');
  if (!P) return jobs;
  if (suites.has('presets')) {
    const pm = await tryLoad('src/presets/index.js');
    const list = pm?.PRESETS || pm?.default || [];
    list.forEach((p, i) => {
      if (presetFilter && !String(p?.name).toLowerCase().includes(presetFilter.toLowerCase())) return;
      jobs.push({ suite: 'presets', kind: 'preset', name: p?.name, weight: 10, args: { index: i, mode } });
    });
    // library-wide playing checks (`--preset playing` runs only these)
    if ((!presetFilter && mode !== 'quick') || /^playing/i.test(presetFilter || '')) jobs.push({ suite: 'presets', kind: 'presetPlaying', name: 'playing checks', weight: 12, args: {} });
  }
  if (suites.has('engines')) {
    for (const e of ENGINES) {
      if (!fs.existsSync(path.join(ROOT, e.file))) { jobs.push({ suite: 'engines', kind: 'engineQuality', name: `${e.label} quality`, weight: 1, args: { engine: e } }); continue; }
      for (const [configName, config] of engineConfigs(P, e)) jobs.push({ suite: 'engines', kind: 'engineConfig', name: `${e.label} ${configName}`, weight: e.label === 'phys' ? 4 : 3, args: { engine: e, configName, config, mode } });
      jobs.push({ suite: 'engines', kind: 'engineQuality', name: `${e.label} quality`, weight: 6, args: { engine: e } });
    }
  }
  if (suites.has('filters')) {
    for (let t = 0; t < P.FILTER_TYPES.length; t++) jobs.push({ suite: 'filters', kind: 'filter', weight: 2, args: { kind: 'voice', type: t, mode } });
    for (let t = 0; t < 4; t++) jobs.push({ suite: 'filters', kind: 'filter', weight: 1, args: { kind: 'svf', type: t, mode } });
    jobs.push({ suite: 'filters', kind: 'filterResponse', weight: 3, args: {} });
  }
  if (suites.has('fx')) {
    for (const [name, values] of fxConfigs(P, mode)) {
      const heavy = name.startsWith('all on · defaults') || name.startsWith('all on · max');
      jobs.push({ suite: 'fx', kind: 'fx', name, weight: 1, args: { name, values, srs: heavy && mode !== 'quick' ? [44100, 48000, 96000] : [48000] } });
    }
    const allOn = Object.fromEntries(['drive', 'chorus', 'phaser', 'delay', 'reverb'].map(g => [`${g}.on`, true]));
    jobs.push({ suite: 'fx', kind: 'fx', name: 'toggle effects on/off every 21 ms', weight: 1, args: { name: 'toggle effects on/off every 21 ms', values: allOn, srs: [48000], toggle: true } });
    jobs.push({ suite: 'fx', kind: 'fx', name: 'random FX params every block', weight: 1, args: { name: 'random FX params every block', values: allOn, srs: [48000], sweep: true } });
    jobs.push({ suite: 'fx', kind: 'fxTail', weight: 3, args: {} });
  }
  if (suites.has('synth')) {
    jobs.push({ suite: 'synth', kind: 'synthApi', weight: 4, args: {} });
    jobs.push({ suite: 'synth', kind: 'synthStress', weight: 8, args: {} });
    jobs.push({ suite: 'synth', kind: 'synthAlloc', weight: 3, args: {}, isolate: true });
  }
  if (suites.has('worklet')) jobs.push({ suite: 'worklet', kind: 'worklet', weight: 2, args: {}, isolate: true });
  if (suites.has('songs')) {
    jobs.push({ suite: 'songs', kind: 'songlib', weight: 1, args: {} });
    jobs.push({ suite: 'songs', kind: 'ensemble', weight: 8, args: {}, isolate: true });
    jobs.push({ suite: 'songs', kind: 'songWorklet', weight: 4, args: {}, isolate: true });
    const sm = await tryLoad('src/demo/songs/index.js');
    (sm?.SONGS || []).forEach((s, i) => jobs.push({ suite: 'songs', kind: 'songRender', name: `song ${s?.id ?? i}`, weight: 9, args: { index: i, mode } }));
    if (!sm) jobs.push({ suite: 'songs', kind: 'songlib', name: 'src/demo/songs/index.js', weight: 1, args: {} });
  }
  if (suites.has('magic')) jobs.push({ suite: 'magic', kind: 'magic', weight: 2, args: {}, isolate: true });
  if (suites.has('ui')) jobs.push({ suite: 'ui', kind: 'ui', weight: 1, args: {}, isolate: true }); // swaps localStorage
  if (suites.has('compat')) {
    jobs.push({ suite: 'compat', kind: 'compat', name: 'compat core', weight: 1, args: { part: 'core', mode }, isolate: true }); // swaps globals
    jobs.push({ suite: 'compat', kind: 'compat', name: 'compat sample rates', weight: 5, args: { part: 'rates', mode } });
  }
  return jobs.sort((a, b) => b.weight - a.weight);
}

const JOB_TIMEOUT_MS = Number(process.env.AURORA_TEST_TIMEOUT_MS) || 180000;

async function runPool(jobs, nWorkers, onRows) {
  if (!jobs.length) return;
  const isolated = jobs.filter(j => j.isolate);
  const shared = jobs.filter(j => !j.isolate);
  if (nWorkers <= 1) {
    for (const j of shared) onRows(j, await runJob(j));
    for (const j of isolated) await runInFreshWorker(j, onRows).catch(async () => onRows(j, await runJob(j)));
    return;
  }
  let next = 0;
  const spawn = () => new Worker(SELF, { workerData: { kind: 'aurora-test-worker', root: ROOT } });
  // One lane per worker; a hung or crashed job fails alone and the lane continues on a fresh worker.
  const lane = () => new Promise(resolve => {
    let w = spawn(), cur = null, timer = null, settled = false;
    const finish = rows => {
      clearTimeout(timer);
      if (cur && !settled) { settled = true; onRows(cur, rows); }
      feed();
    };
    const attach = () => {
      w.on('message', msg => finish(msg.rows));
      w.on('error', e => {
        const rows = [row(cur?.suite ?? '?', cur?.name || cur?.kind || '?', 'FAIL', `worker crashed: ${String(e?.message || e).split('\n')[0]}`)];
        w = spawn(); attach();
        finish(rows);
      });
    };
    const feed = () => {
      if (next >= shared.length) { w.terminate().then(resolve); return; }
      cur = shared[next++]; settled = false;
      timer = setTimeout(() => {
        const job = cur;
        w.removeAllListeners(); w.terminate();
        w = spawn(); attach();
        finish([row(job.suite, job.name || job.kind, 'FAIL', `timed out after ${JOB_TIMEOUT_MS / 1000} s (infinite loop or extremely slow DSP?)`)]);
      }, JOB_TIMEOUT_MS);
      w.postMessage({ job: cur });
    };
    attach();
    feed();
  });
  await Promise.all([
    ...Array.from({ length: Math.min(nWorkers, shared.length) }, lane),
    ...isolated.map(j => runInFreshWorker(j, onRows).catch(async () => onRows(j, await runJob(j)))),
  ]);
}

function runInFreshWorker(job, onRows) {
  return new Promise((resolve, reject) => {
    const w = new Worker(SELF, { workerData: { kind: 'aurora-test-worker', root: ROOT } });
    const timer = setTimeout(() => {
      w.removeAllListeners(); w.terminate();
      onRows(job, [row(job.suite, job.name || job.kind, 'FAIL', `timed out after ${JOB_TIMEOUT_MS / 1000} s`)]);
      resolve();
    }, JOB_TIMEOUT_MS);
    w.once('message', msg => { clearTimeout(timer); onRows(job, msg.rows); w.terminate().then(resolve); });
    w.once('error', e => { clearTimeout(timer); reject(e); });
    w.postMessage({ job });
  });
}

// ───────────────────────── Output ─────────────────────────
function makeStyle(color) {
  const c = code => s => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    PASS: c('32'), WARN: c('33'), FAIL: c('31;1'), SKIP: c('2'), INFO: c('36'), dim: c('2'), bold: c('1'), head: c('1;36'),
  };
}
const ICON = { PASS: '✓', WARN: '!', FAIL: '✗', SKIP: '–', INFO: 'i' };

function wrapText(text, w) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/(\s+)/)) {
    if ((line + word).length > w && line.trim()) { out.push(line.trimEnd()); line = word.trimStart(); }
    else line += word;
    while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.length ? out : [''];
}

function printRow(S, r, width, verbose) {
  const tag = S[r.status](`${ICON[r.status]} ${r.status.padEnd(4)}`);
  const lines = String(r.detail || '').split('\n').filter(Boolean);
  const nameW = Math.min(46, Math.max(24, Math.floor(width * 0.34)));
  const name = r.name.length > nameW ? r.name.slice(0, nameW - 1) + '…' : r.name.padEnd(nameW);
  const avail = Math.max(24, width - nameW - 13);
  const full = verbose || r.status !== 'PASS';
  const shown = full ? lines : lines.slice(0, 1);
  const out = [];
  for (const l of shown) for (const piece of full ? wrapText(l, avail) : [l.length > avail ? l.slice(0, avail - 1) + '…' : l]) out.push([l, piece]);
  const pad = `  ${' '.repeat(7)}  ${' '.repeat(nameW)} `;
  const paint = (src, t) => (src.startsWith('✗') ? S.FAIL(t) : src.startsWith('!') ? S.WARN(t) : S.dim(t));
  console.log(`  ${tag}  ${name} ${out.length ? paint(out[0][0], out[0][1]) : ''}`);
  for (const [src, piece] of out.slice(1)) console.log(pad + paint(src, piece));
}

function printPresetTable(S, rows) {
  const data = rows.filter(r => r.data?.phrase || r.data?.rtf);
  if (!data.length) return;
  console.log(S.dim(`  ${'preset'.padEnd(26)} ${'cat'.padEnd(8)} ${'phrase'.padEnd(7)} ${'peak'.padStart(6)} ${'LUFS'.padStart(6)} ${'cent'.padStart(6)} ${'width'.padStart(5)} ${'tail'.padStart(6)} ${'RTF'.padStart(6)}  status`));
  for (const r of data) {
    const d = r.data;
    const tail = d.tail == null ? (d.truncated ? '>max' : '—') : `${d.tail.toFixed(1)}s`;
    console.log(`  ${String(d.name).slice(0, 26).padEnd(26)} ${String(d.category ?? '').padEnd(8)} ${String(d.phrase ?? '').padEnd(7)} ${fmt(d.peakDb, 1).padStart(6)} ${fmt(d.lufs, 1).padStart(6)} ${String(d.centroid ?? '—').padStart(6)} ${fmt(d.width, 2).padStart(5)} ${tail.padStart(6)} ${(d.rtf ? d.rtf.toFixed(0) + '×' : '—').padStart(6)}  ${S[r.status](r.status)}`);
  }
}

// ───────────────────────── Main ─────────────────────────
const ALL_SUITES = ['tools', 'modules', 'purity', 'syntax', 'params', 'engines', 'filters', 'fx', 'synth', 'presets', 'worklet', 'songs', 'magic', 'compat', 'ui'];

function parseArgs(argv) {
  const a = { mode: 'default', only: null, preset: null, jobs: null, json: null, verbose: false, color: process.stdout.isTTY && !process.env.NO_COLOR };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--quick') a.mode = 'quick';
    else if (t === '--full') a.mode = 'full';
    else if (t === '--only') a.only = argv[++i];
    else if (t.startsWith('--only=')) a.only = t.slice(7);
    else if (t === '--preset') a.preset = argv[++i];
    else if (t === '--jobs') a.jobs = Number(argv[++i]);
    else if (t === '--json') a.json = argv[++i];
    else if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t === '--no-color') a.color = false;
    else if (t === '--help' || t === '-h') a.help = true;
    else ALL_SUITES.includes(t) ? (a.only = a.only ? `${a.only},${t}` : t) : null;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`AURORA tests\n  node tools/test.mjs [--quick|--full] [--only ${ALL_SUITES.join(',')}] [--preset <name>] [--jobs N] [--json file] [--verbose]`);
    return 0;
  }
  const S = makeStyle(args.color);
  const width = Math.max(90, Math.min(160, process.stdout.columns || 120));
  const suites = new Set(args.only ? args.only.split(',').map(s => s.trim()) : ALL_SUITES);
  const t0 = performance.now();
  const nWorkers = Math.max(1, args.jobs ?? Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));
  console.log(`${S.head('AURORA 極光 · test suite')} ${S.dim(`mode=${args.mode} · ${nWorkers} workers · node ${process.version} · ${os.cpus()[0]?.model ?? ''} · load ${os.loadavg()[0].toFixed(1)}`)}`);
  const all = [];
  const bySuite = new Map();
  const add = rows => { for (const r of rows) { all.push(r); if (!bySuite.has(r.suite)) bySuite.set(r.suite, []); bySuite.get(r.suite).push(r); } };

  // Fast static suites first (inline)
  const staticSuites = [['tools', suiteTools], ['modules', suiteModules], ['purity', suitePurity], ['syntax', suiteSyntax], ['params', suiteParams]];
  for (const [name, fn] of staticSuites) {
    if (!suites.has(name)) continue;
    const ts = performance.now();
    let rows;
    try { rows = await fn(); } catch (e) { rows = [row(name, name, 'FAIL', `suite crashed: ${e?.stack || e}`)]; }
    add(rows);
    console.log(`\n${S.bold(name)} ${S.dim(`(${((performance.now() - ts) / 1000).toFixed(1)}s)`)}`);
    for (const r of rows) printRow(S, r, width, args.verbose);
  }

  // Heavy suites through the worker pool
  const jobs = await buildJobs(suites, args.mode, args.preset);
  const heavy = ALL_SUITES.filter(s => suites.has(s) && !staticSuites.some(([n]) => n === s));
  if (!(await tryLoad('src/dsp/params.js'))) for (const s of heavy) add([row(s, s, 'SKIP', 'params.js unavailable')]);
  if (suites.has('presets') && !jobs.some(j => j.suite === 'presets')) {
    const pm = await tryLoad('src/presets/index.js');
    add([row('presets', 'factory presets', pm ? 'SKIP' : 'FAIL', pm ? (args.preset ? `no preset matches "${args.preset}"` : 'PRESETS is empty') : 'src/presets/index.js unavailable')]);
  }
  if (suites.has('presets')) {
    const pm = await tryLoad('src/presets/index.js');
    const list = pm?.PRESETS || pm?.default || [];
    if (list.length) {
      const byCat = {};
      for (const p of list) byCat[p?.category] = (byCat[p?.category] || 0) + 1;
      const names = list.map(p => String(p?.name).toLowerCase());
      const dups = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      const declared = new Set((pm.CATEGORIES || []).map(c => c?.id));
      const emptyCats = [...declared].filter(c => !byCat[c]);
      const demos = {};
      for (const p of list) demos[p?.demo ?? '—'] = (demos[p?.demo ?? '—'] || 0) + 1;
      const thin = [...declared].filter(c => byCat[c] && byCat[c] < 8);
      const probs = [...dups.map(d => `! duplicate preset name "${d}"`), ...emptyCats.map(c => `! category '${c}' has no presets`),
        ...thin.map(c => `! category '${c}' has only ${byCat[c]} presets (< 8)`)];
      add([row('presets', `catalog: ${list.length} presets in ${Object.keys(byCat).length} categories`, probs.length ? 'WARN' : 'PASS',
        [Object.entries(byCat).map(([c, n]) => `${c} ${n}`).join(' · ') + `  |  demo phrases: ${Object.entries(demos).map(([d, n]) => `${d} ${n}`).join(' · ')}`, ...probs].join('\n'))]);
    }
  }
  const jobRows = new Map();
  let done = 0;
  const tj = performance.now();
  const progress = () => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\r${S.dim(`  running ${done}/${jobs.length} jobs… ${((performance.now() - tj) / 1000).toFixed(0)}s`)}   `);
  };
  progress();
  await runPool(jobs, nWorkers, (job, rows) => { jobRows.set(job, rows); done++; progress(); });
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  for (const s of heavy) {
    const sj = jobs.filter(j => j.suite === s);
    const rows = sj.flatMap(j => jobRows.get(j) || [row(s, j.name || j.kind, 'FAIL', 'job produced no result')]);
    add(rows);
  }
  for (const s of heavy) {
    const rows = bySuite.get(s) || [];
    if (!rows.length) continue;
    console.log(`\n${S.bold(s)}`);
    if (s === 'presets') {
      printPresetTable(S, rows);
      for (const r of rows.filter(x => x.status === 'FAIL' || x.status === 'WARN' || !x.data?.phrase)) printRow(S, r, width, args.verbose);
    } else for (const r of rows) printRow(S, r, width, args.verbose);
  }

  // Summary
  const counts = st => all.filter(r => r.status === st).length;
  console.log(`\n${S.bold('summary')}`);
  console.log(S.dim(`  ${'suite'.padEnd(10)} ${'pass'.padStart(5)} ${'warn'.padStart(5)} ${'fail'.padStart(5)} ${'skip'.padStart(5)} ${'info'.padStart(5)}`));
  for (const s of ALL_SUITES) {
    const rows = bySuite.get(s);
    if (!rows) continue;
    const c = st => rows.filter(r => r.status === st).length;
    const line = `  ${s.padEnd(10)} ${String(c('PASS')).padStart(5)} ${String(c('WARN')).padStart(5)} ${String(c('FAIL')).padStart(5)} ${String(c('SKIP')).padStart(5)} ${String(c('INFO')).padStart(5)}`;
    console.log(c('FAIL') ? S.FAIL(line) : c('WARN') ? S.WARN(line) : line);
  }
  const fails = all.filter(r => r.status === 'FAIL');
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (fails.length) {
    console.log(`\n${S.FAIL(`✗ ${fails.length} FAILED`)} ${S.dim(`· ${counts('WARN')} warnings · ${counts('PASS')} passed · ${secs}s`)}`);
    for (const f of fails.slice(0, 40)) console.log(`  ${S.FAIL('✗')} ${f.suite}/${f.name}: ${String(f.detail).split('\n').find(l => l.startsWith('✗')) || String(f.detail).split('\n')[0]}`);
    if (fails.length > 40) console.log(`  … ${fails.length - 40} more`);
  } else {
    console.log(`\n${S.PASS(`✓ all passed`)} ${S.dim(`· ${counts('WARN')} warnings · ${counts('PASS')} passed · ${secs}s`)}`);
  }
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ mode: args.mode, seconds: Number(secs), rows: all }, null, 2));
    console.log(S.dim(`  report → ${args.json}`));
  }
  return fails.length ? 1 : 0;
}

if (!isMainThread && workerData?.kind === 'aurora-test-worker') {
  parentPort.on('message', async ({ job }) => {
    const rows = await runJob(job);
    parentPort.postMessage({ rows });
  });
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().then(code => { process.exitCode = code; }, e => { console.error(e?.stack || e); process.exitCode = 1; });
}
