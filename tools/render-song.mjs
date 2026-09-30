#!/usr/bin/env node
// Offline demo-song renderer for mixing work: WAV (24-bit) + spectrogram/waveform PNG + metrics JSON.
// Renders exactly what the browser plays: every part through the Ensemble (src/dsp/ensemble.js) and the
// SafetyBus limiter on the sum (ceiling −0.3 dBFS), with the user's synth silent.
//
//   node tools/render-song.mjs --song neon-nights [--sr 48000] [--out renders/songs] [--loops 1] [--tail 10]
//   node tools/render-song.mjs --song neon-nights --parts bass,drums     # only these parts (by name/zh/role/index)
//   node tools/render-song.mjs --song neon-nights --solo lead            # solo one part (mixer solo)
//   node tools/render-song.mjs --all [--stems] [--no-png] [--bits 16|24|32]
//   node tools/render-song.mjs --song neon-nights --json                 # print metrics JSON only (no files)
//   node tools/render-song.mjs --song neon-nights --beats 32             # only the first 32 beats (quick check)
//   node tools/render-song.mjs --list
//
// Metrics: integrated LUFS, sample/true peak, the sum's pre-limiter peak and deepest limiter reduction
// (mix so it rarely engages), per-part LUFS & peak (post gain/pan stems), per-section LUFS/peak, spectral
// balance, stereo width, CPU (× real time) of the ensemble. Also a library: renderSong(), songMetrics().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeWav } from './wav.mjs';
import { analyze, loudness, spectrogram, waveformPng } from './analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.AURORA_ROOT ? path.resolve(process.env.AURORA_ROOT) : path.resolve(HERE, '..');
const modUrl = rel => pathToFileURL(path.join(ROOT, rel)).href;
const cpuMs = () => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const dB = x => (x > 1e-12 ? 20 * Math.log10(x) : -240);
const r2 = x => (x == null || !Number.isFinite(x) ? x : Math.round(x * 100) / 100);
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'part';

/** Import the song/preset/engine modules (fresh per process). */
export async function loadSongModules() {
  const [songs, resolve, presets, ens] = await Promise.all([
    import(modUrl('src/demo/songs/index.js')), import(modUrl('src/demo/resolve.js')),
    import(modUrl('src/presets/index.js')), import(modUrl('src/dsp/ensemble.js')),
  ]);
  return { SONGS: songs.SONGS, resolveSong: resolve.resolveSong, songDuration: resolve.songDuration, PRESETS: presets.PRESETS, Ensemble: ens.Ensemble, SafetyBus: ens.SafetyBus };
}

/** Engine-ready song repeated `loops` times as one non-looping pass (sections labelled per pass). */
export function unrollSong(song, loops = 1) {
  const n = Math.max(1, loops | 0), L = song.lengthBeats;
  const parts = song.parts.map(p => {
    const events = [];
    for (let k = 0; k < n; k++) for (const e of p.events) if (e.beat < L) events.push({ ...e, beat: e.beat + k * L });
    return { ...p, events };
  });
  const sections = [];
  for (let k = 0; k < n; k++) for (const s of song.sections || []) sections.push({ ...s, beat: s.beat + k * L, name: n > 1 ? `${s.name} ${k + 1}` : s.name });
  return { ...song, parts, sections, lengthBeats: L * n, loop: false };
}

/** Engine-ready song cut to its first `maxBeats` beats (events at/after the cut dropped; notes may ring past it). */
export function clipSong(song, maxBeats) {
  const cut = Number(maxBeats);
  if (!(cut > 0) || cut >= song.lengthBeats) return song;
  return {
    ...song,
    parts: song.parts.map(p => ({ ...p, events: p.events.filter(e => e.beat < cut) })),
    sections: (song.sections || []).filter(s => s.beat < cut),
    lengthBeats: cut, loop: false,
  };
}

/** Match part selectors (name / zh / role / index, case-insensitive) → part indices. */
export function selectParts(song, list) {
  const want = String(list).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const idx = new Set();
  for (const w of want) {
    let hit = false;
    song.parts.forEach((p, i) => {
      if (String(i) === w || p.name.toLowerCase() === w || String(p.zh).toLowerCase() === w || String(p.role).toLowerCase() === w) { idx.add(i); hit = true; }
    });
    if (!hit) throw new Error(`No part matches "${w}". Parts: ${song.parts.map((p, i) => `${i}:${p.name}(${p.role})`).join(', ')}`);
  }
  return [...idx];
}

/**
 * Render a song definition (or engine-ready song) offline.
 * @param {object} def song definition from src/demo/songs (or engine-ready with parts[].patch)
 * @param {{sampleRate?:number, loops?:number, tail?:number, parts?:string, solo?:string, seed?:number, maxBeats?:number, mods?:object}} [opts]
 *   maxBeats: render only the first N beats (quick checks of long songs) · profile: false → no per-part CPU
 * @returns {Promise<object>} { L, R, sampleRate, song, stems:[{L,R}], songSeconds, audioSeconds, cpuMs, rtf,
 *   preLimitPeak, limiterMaxReductionDb, built, buildMs }
 */
export async function renderSong(def, opts = {}) {
  const M = opts.mods || (await loadSongModules());
  const sr = opts.sampleRate ?? 48000;
  const resolved = def.parts && def.parts.every(p => p.patch) ? def : M.resolveSong(def, M.PRESETS);
  const song = clipSong(unrollSong(resolved, opts.loops ?? 1), opts.maxBeats);
  const songSeconds = M.songDuration(song);
  const tail = opts.tail ?? 10;
  const ens = new M.Ensemble(sr, { eager: true, seed: opts.seed ?? 1 });
  ens.stopHold = tail; ens.maxEndTail = tail;
  if (opts.profile !== false) ens.profile = cpuMs; // per-part render time in thread CPU ms (slot.cpuMs; ≈ +5 % CPU)
  ens.load(song);
  // audible[i]: part i is heard in this render (not excluded by --parts, and soloed when --solo is used)
  const audible = song.parts.map(() => true);
  if (opts.parts) {
    const keep = new Set(selectParts(song, opts.parts));
    song.parts.forEach((_, i) => { ens.setPart(i, { mute: !keep.has(i) }); audible[i] = keep.has(i); });
  }
  if (opts.solo) {
    const solo = new Set(selectParts(song, opts.solo));
    for (const i of solo) ens.setPart(i, { solo: true });
    song.parts.forEach((_, i) => { audible[i] = audible[i] && solo.has(i); });
  }
  ens.play();
  const bus = new M.SafetyBus(sr);
  bus.engaged = true; bus.reset();

  const maxN = Math.ceil((songSeconds + tail + ens.stopFade + 1) * sr); // end-of-song tail cap + its fade
  const L = new Float32Array(maxN), R = new Float32Array(maxN);
  const stems = song.parts.map(() => ({ L: new Float32Array(maxN), R: new Float32Array(maxN) }));
  let pos = 0;
  ens.tap = (i, sl, sr2, n, off) => { if (i >= 0) { stems[i].L.set(sl.subarray(0, n), pos + off); stems[i].R.set(sr2.subarray(0, n), pos + off); } };
  const B = 128, bl = new Float32Array(B), br = new Float32Array(B);
  let started = false, ensMs = 0;
  // CPU per 0.5 s window (thread CPU time / audio time) → the busiest moment matters for dropouts.
  // Machine-independent proxy: sounding voices summed over all parts (each costs ≈1–1.7 % of an M-series core).
  const win = Math.round(0.5 * sr / B) * B;
  const loads = [];
  let wc = cpuMs(), wpos = 0;
  const c0 = wc;
  const songN = Math.round(songSeconds * sr);
  let vPeak = 0, vSum = 0, vBlocks = 0, partsPeak = 0;
  const countVoices = () => {
    let v = 0, p = 0;
    for (const s of ens.slots) {
      if (s.quiet && !s.part) continue;
      let a = 0;
      for (const vo of s.synth.voices) if (vo.active) a++;
      v += a; if (a || !s.quiet) p++;
    }
    if (v > vPeak) vPeak = v;
    if (p > partsPeak) partsPeak = p;
    vSum += v; vBlocks++;
  };
  while (pos < maxN) {
    const n = Math.min(B, maxN - pos);
    bl.fill(0); br.fill(0);
    const t0 = performance.now();
    ens.process(bl, br, n);
    ensMs += performance.now() - t0;
    bus.process(bl, br, n);
    L.set(bl.subarray(0, n), pos); R.set(br.subarray(0, n), pos);
    pos += n;
    if (pos <= songN) countVoices();
    if (pos - wpos >= win) { const c = cpuMs(); loads.push((c - wc) / (((pos - wpos) / sr) * 1000)); wc = c; wpos = pos; }
    if (ens.playing) started = true;
    if (started && !ens.playing && !ens.active) break;
  }
  const cpu = cpuMs() - c0;
  // per-part share of one core over the whole render (thread CPU time around each part Synth)
  const partCpu = ens.profile === null ? null : song.parts.map((_, i) => { const p = ens.cur && ens.cur.parts[i]; return p && p.slot ? p.slot.cpuMs / (pos / sr * 1000) : 0; });
  // skip the first second (JIT warm-up of freshly used code paths)
  const nWin = Math.max(1, Math.floor(songSeconds * sr / win));
  const songWin = loads.slice(Math.min(2, nWin - 1), nWin);
  // trim: keep 0.25 s after the last sample above −90 dBFS
  const thr = 10 ** (-90 / 20);
  let last = 0;
  for (let i = pos - 1; i >= 0; i--) if (Math.abs(L[i]) > thr || Math.abs(R[i]) > thr) { last = i; break; }
  const keep = Math.min(pos, Math.max(Math.ceil(songSeconds * sr), last + Math.round(0.25 * sr)));
  return {
    L: L.subarray(0, keep), R: R.subarray(0, keep), sampleRate: sr, song, audible, partCpu,
    stems: stems.map(s => ({ L: s.L.subarray(0, keep), R: s.R.subarray(0, keep) })),
    songSeconds, audioSeconds: pos / sr, cpuMs: cpu, ensembleMs: ensMs, rtf: pos / sr / Math.max(1e-6, cpu / 1000),
    cpuPeakLoad: Math.max(0, ...songWin), cpuMeanLoad: songWin.reduce((a, b) => a + b, 0) / Math.max(1, songWin.length),
    voicesPeak: vPeak, voicesMean: vBlocks ? vSum / vBlocks : 0, partsSoundingPeak: partsPeak,
    preLimitPeak: bus.inPeak, limiterMaxReductionDb: bus.takeMaxReduction(), tailTruncated: pos >= maxN,
    built: ens.built, buildMs: ens.buildMs,
  };
}

/** Metrics for a renderSong() result. */
export function songMetrics(res) {
  const { L, R, sampleRate: sr, song } = res;
  const mix = analyze(L, R, sr, { lastNoteOff: res.songSeconds });
  const parts = song.parts.map((p, i) => {
    const s = res.stems[i];
    let pk = 0;
    for (let k = 0; k < s.L.length; k++) { const a = Math.abs(s.L[k]), b = Math.abs(s.R[k]); if (a > pk) pk = a; if (b > pk) pk = b; }
    const lu = loudness(s.L, s.R, sr);
    const muted = !!(res.audible && res.audible[i] === false);
    const notes = p.events.reduce((k, e) => k + (e.type === 'on' ? 1 : 0), 0);
    const cpu = res.partCpu ? r2(res.partCpu[i] * 100) : null; // % of one core (Node), whole render
    return { index: i, name: p.name, zh: p.zh, role: p.role, preset: p.preset, gainDb: p.gain, pan: p.pan, muted, notes, lufs: r2(lu.integrated), shortTermMax: r2(lu.shortTermMax), peakDb: r2(dB(pk)), cpuPct: cpu };
  });
  const spb = 60 / song.bpm;
  const secs = (song.sections && song.sections.length ? song.sections : [{ beat: 0, name: 'Song', zh: '全曲' }]);
  const sections = secs.map((s, i) => {
    const t0 = s.beat * spb, t1 = (i + 1 < secs.length ? secs[i + 1].beat : song.lengthBeats) * spb;
    const a = Math.round(t0 * sr), b = Math.min(L.length, Math.round(t1 * sr));
    let pk = 0;
    for (let k = a; k < b; k++) { const x = Math.abs(L[k]), y = Math.abs(R[k]); if (x > pk) pk = x; if (y > pk) pk = y; }
    const lu = b - a > sr * 0.4 ? loudness(L.subarray(a, b), R.subarray(a, b), sr) : { integrated: null, shortTermMax: null };
    return { name: s.name, zh: s.zh, start: r2(t0), end: r2(t1), lufs: r2(lu.integrated), shortTermMax: r2(lu.shortTermMax), peakDb: r2(dB(pk)) };
  });
  return {
    mix,
    preLimitPeakDb: r2(dB(res.preLimitPeak)),
    limiterMaxReductionDb: r2(res.limiterMaxReductionDb),
    voicesPeak: res.voicesPeak, voicesMean: r2(res.voicesMean),
    parts, sections,
  };
}

/** Human-readable problems worth fixing in a song mix. */
export function songIssues(m) {
  const out = [];
  if (m.mix.nanCount || m.mix.infCount) out.push(`NaN/Inf ${m.mix.nanCount + m.mix.infCount}`);
  if (m.mix.peak > 0.9661) out.push(`peak ${m.mix.peakDb} dBFS above the −0.3 dBFS ceiling`);
  if (m.limiterMaxReductionDb < -3) out.push(`safety limiter pulls ${-m.limiterMaxReductionDb} dB — lower part gains`);
  if (m.mix.lufs != null && m.mix.lufs > -10) out.push(`very loud (${m.mix.lufs} LUFS)`);
  if (m.mix.lufs == null || m.mix.lufs < -24) out.push(`very quiet (${m.mix.lufs} LUFS)`);
  if (m.mix.dcMax > 0.01) out.push(`DC ${m.mix.dcMax}`);
  if (m.voicesPeak > 32) out.push(`${m.voicesPeak} voices sounding at once (budget 32) — cap voice.poly or shorten releases`);
  for (const p of m.parts) if (!p.muted && p.notes > 0 && (p.lufs == null || p.peakDb < -60)) out.push(`part "${p.name}" is silent`);
  return out;
}

/** Render one song definition to files. */
export async function renderSongToFiles(def, opts = {}) {
  const res = await renderSong(def, opts);
  const m = songMetrics(res);
  const id = res.song.id || slug(res.song.title);
  const suffix = [opts.solo ? `solo-${slug(opts.solo)}` : '', opts.parts ? `parts-${slug(opts.parts)}` : '', (opts.loops ?? 1) > 1 ? `x${opts.loops}` : '', opts.maxBeats > 0 ? `b${opts.maxBeats}` : ''].filter(Boolean).join('-');
  const base = suffix ? `${id}-${suffix}` : id;
  const summary = {
    song: { id, title: res.song.title, zh: res.song.zh, bpm: res.song.bpm, key: res.song.key, lengthBeats: res.song.lengthBeats, seconds: r2(res.songSeconds) },
    sampleRate: res.sampleRate, files: {},
    render: {
      audioSeconds: r2(res.audioSeconds), cpuMs: r2(res.cpuMs), ensembleMs: r2(res.ensembleMs), realtimeFactor: r2(res.rtf),
      // fraction of one core while the song plays (mean / busiest 0.5 s); Chrome's AudioWorklet ≈ 1.3–1.5× this
      cpuMeanLoad: r2(res.cpuMeanLoad), cpuPeakLoad: r2(res.cpuPeakLoad),
      // sounding voices summed over all parts while the song plays (deterministic CPU proxy; budget ≤ 32 peak)
      voicesPeak: res.voicesPeak, voicesMean: r2(res.voicesMean),
      parts: res.song.parts.length, tailTruncated: res.tailTruncated,
    },
    metrics: m,
    issues: songIssues(m),
  };
  if (opts.json) return summary;
  const outDir = path.resolve(opts.out || path.join(ROOT, 'renders', 'songs'), id);
  fs.mkdirSync(outDir, { recursive: true });
  const bits = opts.bits ?? 24;
  writeWav(path.join(outDir, `${base}.wav`), [res.L, res.R], res.sampleRate, { bitDepth: bits });
  summary.files.wav = `${base}.wav`;
  if (opts.png !== false) {
    const spb = 60 / res.song.bpm;
    const markers = (res.song.sections || []).map(s => ({ t: s.beat * spb, label: s.name }));
    markers.push({ t: res.songSeconds, label: 'end', color: '#ff6b81' });
    const title = res.song.title || id;
    const sub = `${res.song.bpm} BPM · ${res.song.parts.length} parts${suffix ? ` · ${suffix}` : ''}`;
    const right = `${(res.sampleRate / 1000).toFixed(1)} kHz · peak ${m.mix.peakDb.toFixed(1)} dBFS · ${m.mix.lufs == null ? '—' : m.mix.lufs.toFixed(1)} LUFS`;
    fs.writeFileSync(path.join(outDir, `${base}-spectrogram.png`), spectrogram(res.L, res.R, res.sampleRate, { title, subtitle: sub, right, markers, colormap: opts.colormap }));
    fs.writeFileSync(path.join(outDir, `${base}-waveform.png`), waveformPng(res.L, res.R, res.sampleRate, { title, subtitle: sub, markers }));
    summary.files.spectrogram = `${base}-spectrogram.png`;
    summary.files.waveform = `${base}-waveform.png`;
  }
  if (opts.stems) {
    summary.files.stems = [];
    res.song.parts.forEach((p, i) => {
      const f = `${base}-stem-${i}-${slug(p.name)}.wav`;
      writeWav(path.join(outDir, f), [res.stems[i].L, res.stems[i].R], res.sampleRate, { bitDepth: bits });
      summary.files.stems.push(f);
    });
  }
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(summary, null, 2));
  summary.files.dir = outDir;
  return summary;
}

function printSummary(s) {
  const m = s.metrics;
  const lu = x => (x == null ? '   —' : x.toFixed(1).padStart(6));
  console.log(`\n${s.song.title} (${s.song.zh}) · ${s.song.bpm} BPM · ${s.song.seconds}s · ${s.render.parts} parts`);
  console.log(`  mix      ${lu(m.mix.lufs)} LUFS  peak ${m.mix.peakDb.toFixed(1)} dBFS (true ${m.mix.truePeakDb.toFixed(1)})  pre-limit ${m.preLimitPeakDb.toFixed(1)} dBFS  limiter ${m.limiterMaxReductionDb.toFixed(1)} dB`);
  console.log(`           centroid ${m.mix.centroidHz ?? '—'} Hz · low/mid/high ${m.mix.bands.lowPct}/${m.mix.bands.midPct}/${m.mix.bands.highPct} % · width ${m.mix.width} · LRA ${m.mix.lra ?? '—'}`);
  for (const p of m.parts) {
    const name = `${p.name}`.padEnd(9).slice(0, 9);
    if (p.muted) console.log(`  ${name}  (muted)                          gain ${String(p.gainDb).padStart(4)} dB  ${p.preset}`);
    else console.log(`  ${name}${lu(p.lufs)} LUFS  peak ${String(p.peakDb.toFixed(1)).padStart(6)} dBFS  gain ${String(p.gainDb).padStart(4)} dB  cpu ${p.cpuPct == null ? '  —' : `${p.cpuPct.toFixed(1)}%`.padStart(5)}  ${p.preset}`);
  }
  for (const x of m.sections) console.log(`  § ${x.name.padEnd(12).slice(0, 12)} ${String(x.start).padStart(6)}–${String(x.end).padEnd(6)}s ${lu(x.lufs)} LUFS  peak ${x.peakDb.toFixed(1)}`);
  console.log(`  render   ${s.render.audioSeconds}s audio in ${(s.render.cpuMs / 1000).toFixed(2)}s CPU → ${s.render.realtimeFactor}× real time · song CPU mean ${Math.round(s.render.cpuMeanLoad * 100)}% / peak ${Math.round(s.render.cpuPeakLoad * 100)}% of a core (worklet ≈ ×1.4)`);
  console.log(`  voices   peak ${s.render.voicesPeak} · mean ${s.render.voicesMean} sounding voices over all parts (budget: peak ≤ 32)`);
  if (s.issues.length) console.log(`  ! ${s.issues.join('\n  ! ')}`);
  if (s.files.dir) console.log(`  → ${path.relative(process.cwd(), path.join(s.files.dir, s.files.wav))}`);
}

function parseArgs(argv) {
  const a = { png: true };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i], v = () => argv[++i];
    if (t === '--song') a.song = v();
    else if (t === '--all') a.all = true;
    else if (t === '--list') a.list = true;
    else if (t === '--sr') a.sampleRate = Number(v());
    else if (t === '--out') a.out = v();
    else if (t === '--parts') a.parts = v();
    else if (t === '--solo') a.solo = v();
    else if (t === '--loops') a.loops = Number(v());
    else if (t === '--beats') a.maxBeats = Number(v());
    else if (t === '--tail') a.tail = Number(v());
    else if (t === '--bits') a.bits = Number(v());
    else if (t === '--seed') a.seed = Number(v());
    else if (t === '--colormap') a.colormap = v();
    else if (t === '--stems') a.stems = true;
    else if (t === '--no-png') a.png = false;
    else if (t === '--json') a.json = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`Unknown option ${t} (see --help)`);
  }
  return a;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help || (!a.song && !a.all && !a.list)) {
    console.log('node tools/render-song.mjs --song <id> [--sr 48000] [--out renders/songs] [--parts a,b] [--solo <part>]\n' +
      '                            [--loops N] [--beats N] [--tail S] [--stems] [--no-png] [--bits 16|24|32] [--json]\n' +
      '                          --all | --list');
    return 0;
  }
  const M = await loadSongModules();
  if (a.list) {
    for (const s of M.SONGS) console.log(`${s.id.padEnd(16)} ${String(s.bpm).padStart(3)} BPM  ${(s.lengthBeats / 4).toString().padStart(3)} bars  ${s.title} · ${s.zh}  [${s.parts.map(p => p.name).join(', ')}]`);
    return 0;
  }
  const list = a.all ? M.SONGS : M.SONGS.filter(s => s.id === a.song || s.title.toLowerCase() === String(a.song).toLowerCase() || s.zh === a.song);
  if (!list.length) throw new Error(`Unknown song "${a.song}". Songs: ${M.SONGS.map(s => s.id).join(', ')}`);
  let bad = 0;
  const out = [];
  for (const def of list) {
    const s = await renderSongToFiles(def, { ...a, mods: M });
    if (s.issues.some(x => /NaN|ceiling|silent/.test(x))) bad++;
    if (a.json) out.push(s); else printSummary(s);
  }
  if (a.json) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, e => { console.error(e?.stack || e); process.exitCode = 1; });
}
