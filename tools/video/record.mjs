#!/usr/bin/env node
// Record the REAL running app (real-time AudioWorklet audio + WebGL/DOM visuals) as a video, driven by a script.
//
//   node tools/video/record.mjs --timeline <module.mjs> --out renders/video/<name>.mp4
//        [--lang en|zh] [--fps 60|30] [--w 1920 --h 1080] [--dpr 1|2] [--takes 1] [--min-unique 0.985]
//        [--quality 80] [--crf 14] [--preset slow] [--overlay ./overlays/overlay.js|none] [--cursor overlay|builtin|none]
//        [--tail 0.5] [--loudness -16] [--keep] [--no-wav] [--no-autostart] [--port 99xx] [--dry] [--set key=value …]
//   --loudness L gain toward L LUFS integrated (never past −1 dBFS peak); default: the app's own level, untouched
//   --takes N    record up to N takes, keep the smoothest (stops early once a take reaches --min-unique)
//   --score shots  rank takes by held frames inside the timeline's 'shot' windows only (default: the whole take)
//   --dry        rehearse the timeline without capturing; prints slow frames and what made them slow
//   --set k=v    free parameters for the timeline (ctx.args)
//   output: <out> (.mp4 H.264+AAC · .webm VP9+Opus · .mov ProRes 422 HQ+PCM · .mkv near-lossless H.264+FLAC)
//           + <out>.wav (24-bit, aligned) + <out>.json (report: frame stats, sync, events, slow frames)
//
// How: headless Chrome (real GPU, muted — nothing plays on the speakers) opens tools/video/director.html: a
// 1920×1080 stage with the app in an iframe under a CSS "camera", the overlay above, and a per-frame timecode strip
// below (cropped away). Video = CDP screencast of every compositor frame (JPEG); the timecode says which moment each
// captured frame shows. Audio = a lossless AudioWorklet tap on the app's master node, with 50 ms clock marks mapping
// the AudioContext clock to the page clock. Assembly = frames resampled to constant frame rate on their timecodes,
// audio cut on the same clock (±½ frame), ffmpeg encode. See tools/video/README.md.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from './capture/chrome.mjs';
import { startScreencast } from './capture/screencast.mjs';
import { detectOnsets, decodeTimecodes, unwrapTimecodes, pickByContentTime, sliceAudio, encode, writeWav, ffmpeg } from './capture/assemble.mjs';
import { createContext } from './capture/context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = process.env.AURORA_URL || 'http://localhost:5173';
const SYNC_REGION = { x: 16, y: 16, w: 88, h: 88 }; // inside the director's #sync square (0,0,120,120)
const TC_H = 8; // timecode strip below the stage (cropped away)
const median = a => { const q = a.slice().sort((x, y) => x - y); const n = q.length; return n ? (n % 2 ? q[(n - 1) / 2] : (q[n / 2 - 1] + q[n / 2]) / 2) : NaN; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0Run = Date.now();
const log = (...a) => console.log(`[record ${((Date.now() - t0Run) / 1000).toFixed(1).padStart(5)}s]`, ...a);

function parseArgs(argv) {
  const o = { fps: 60, w: 1920, h: 1080, dpr: 1, lang: 'en', quality: 80, crf: 14, preset: 'slow', tail: null, overlay: null, cursor: null,
    keep: false, wav: true, autostart: true, takes: 1, minUnique: 0.985, set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--timeline') o.timeline = next();
    else if (a === '--out') o.out = next();
    else if (a === '--fps') o.fps = +next();
    else if (a === '--w') o.w = +next();
    else if (a === '--h') o.h = +next();
    else if (a === '--dpr') o.dpr = +next();
    else if (a === '--lang') o.lang = next();
    else if (a === '--quality') o.quality = +next();
    else if (a === '--crf') o.crf = +next();
    else if (a === '--preset') o.preset = next();
    else if (a === '--tail') o.tail = +next();
    else if (a === '--overlay') o.overlay = next();
    else if (a === '--cursor') o.cursor = next();
    else if (a === '--port') o.port = +next();
    else if (a === '--takes') o.takes = Math.max(1, +next());
    else if (a === '--min-unique') o.minUnique = +next();
    else if (a === '--score') o.score = next();
    else if (a === '--every') o.every = +next();
    else if (a === '--loudness') o.loudness = +next();
    else if (a === '--keep') o.keep = true;
    else if (a === '--no-wav') o.wav = false;
    else if (a === '--no-autostart') o.autostart = false;
    else if (a === '--allow-missing-overlay') o.allowMissingOverlay = true;
    else if (a === '--dry') o.dry = true;
    else if (a === '--set') { const [k, ...v] = next().split('='); o.set[k] = v.join('='); }
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** a debugging port in 9900–9999 that nobody listens on */
async function freePort(preferred) {
  const tryPort = p => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
  });
  if (preferred && await tryPort(preferred)) return preferred;
  const start = Math.floor(Math.random() * 100);
  for (let i = 0; i < 100; i++) { const p = 9900 + ((start + i) % 100); if (await tryPort(p)) return p; }
  throw new Error('no free debugging port in 9900–9999');
}

async function ensureServer() {
  const up = async () => { try { const r = await fetch(SERVER + '/index.html', { method: 'HEAD' }); return r.ok; } catch { return false; } };
  if (await up()) return;
  log(`dev server not reachable at ${SERVER} — starting tools/serve.mjs`);
  const p = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--quiet'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 50; i++) { await sleep(200); if (await up()) return; }
  throw new Error(`could not reach ${SERVER}`);
}

/** open the director and wait until the app, audio, fonts and overlay are ready */
async function openDirector(o, env) {
  const port = await freePort(o.port);
  const chrome = await launchChrome({ port, w: o.w, h: o.h + TC_H, dpr: o.dpr });
  try {
    const q = new URLSearchParams({ lang: env.lang, overlay: env.overlaySpec, cursor: env.cursor, autostart: o.autostart ? '1' : '0', tc: '1' });
    await chrome.goto(`${SERVER}/tools/video/director.html?${q}`);
    const ready = await chrome.eval(`director.ready.then(() => ({ ok: true, overlay: !!director.overlay, sr: director.aurora && director.aurora.ctx ? director.aurora.ctx.sampleRate : 0 }), e => ({ ok: false, error: String(e && e.message || e) }))`, { timeoutMs: 90000 });
    if (!ready.ok) throw new Error(`director not ready: ${ready.error}`);
    if (!ready.overlay && env.overlaySpec !== 'none' && !o.allowMissingOverlay) {
      const why = (await chrome.eval('director.logs.filter(l => /overlay/.test(l)).join(" | ")')) || 'unknown';
      throw new Error(`the overlay module ${env.overlaySpec} did not load (${why}) — fix it, or pass --overlay none / --allow-missing-overlay`);
    }
    const gpu = await chrome.eval(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g && g.getExtension('WEBGL_debug_renderer_info'); return g ? (e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : 'none'; })()`);
    // every glyph the timeline's own strings need (captions live there): load the font slices before filming
    const text = [...new Set(fs.readFileSync(env.timelinePath, 'utf8') + (env.meta.preload || []).join(''))].filter(c => c.codePointAt(0) > 0x2000).join('');
    if (text) {
      await chrome.eval(`director.prewarmFonts(${JSON.stringify(text)})`, { timeoutMs: 30000 });
      if (ready.overlay) await chrome.eval(`(async () => { const o = director.overlay; if (o && typeof o.preload === 'function') await o.preload([${JSON.stringify(text)}]); })()`, { timeoutMs: 30000 });
    }
    log(`director ready on port ${port} (overlay: ${ready.overlay ? env.overlaySpec : 'none'}, ${ready.sr} Hz, ${gpu})`);
    return { chrome, ready, gpu };
  } catch (e) { await chrome.close(); throw e; }
}

async function runTimeline(chrome, o, env, report, t0, take) {
  const ctx = createContext({ chrome, lang: env.lang, fps: o.fps, w: o.w, h: o.h, t0, events: report.events, args: { ...o.set, take }, log: s => log('[timeline]', s), out: env.out });
  try { await env.run(ctx); return null; } catch (e) { log('TIMELINE ERROR', e && e.stack || e); return e; }
}

/** rehearsal: timeline + performance probe, no capture */
async function dryRun(o, env) {
  const { chrome } = await openDirector(o, env);
  try {
    if (env.prepare) {
      const p0 = await chrome.eval(`({ wall: director.wallNow() / 1000, ctx: director.audioClock() })`);
      await env.prepare(createContext({ chrome, lang: env.lang, fps: o.fps, w: o.w, h: o.h, t0: p0, events: [], args: { ...o.set, prepare: true }, log: s => log('[prepare]', s), out: env.out }));
    }
    await chrome.eval('director.probe.start()');
    const t0 = await chrome.eval(`({ wall: director.wallNow() / 1000, ctx: director.audioClock() })`);
    const failure = await runTimeline(chrome, o, env, { events: [] }, t0, 0);
    const perf = await chrome.eval('director.probe.stop()');
    const rel = x => +((x / 1000 - t0.wall)).toFixed(3);
    log(`dry run: ${perf.frames} frames rendered; slow frames: ${perf.slowFrames.map(f => `${rel(f.at)}s:${f.ms}ms`).join(' ') || 'none'}`);
    for (const f of perf.longFrames) log(`  long frame ${rel(f.at)}s ${f.ms}ms [${f.where}] script ${f.scriptMs} · style/layout ${f.styleLayoutMs} · render ${f.renderMs} ${f.topScripts.join(' | ')}`);
    const logs = chrome.logs.filter(l => /error|warn|EXC/i.test(l)).slice(-40);
    if (logs.length) log('chrome logs:\n' + logs.join('\n'));
    if (failure) process.exitCode = 1;
  } finally { await chrome.close(); }
}

/** one take: capture + analysis (no encode yet). Returns a take object with a score. */
async function captureTake(o, env, take) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-rec-${path.basename(env.out).replace(/\W+/g, '_')}-t${take}-`));
  const report = { out: env.out, timeline: path.relative(ROOT, env.timelinePath), take, lang: env.lang, fps: o.fps, size: [o.w, o.h], dpr: o.dpr, jpegQuality: o.quality, started: new Date().toISOString(), events: [] };
  const { chrome, ready, gpu } = await openDirector(o, env);
  report.overlay = ready.overlay ? env.overlaySpec : null;
  report.gpu = gpu;
  let cast = null;
  try {
    // ── optional off-camera set-up: `export async function prepare(ctx)` in the timeline module ──
    if (env.prepare) {
      const p0 = await chrome.eval(`({ wall: director.wallNow() / 1000, ctx: director.audioClock() })`);
      const pctx = createContext({ chrome, lang: env.lang, fps: o.fps, w: o.w, h: o.h, t0: p0, events: [], args: { ...o.set, take, prepare: true }, log: s => log('[prepare]', s), out: env.out });
      await env.prepare(pctx);
    }
    // ── capture on: audio tap, screencast, probe, clock marks; warm-up; pre-roll pulses ──
    await chrome.eval('director.tap.start()');
    cast = await startScreencast(chrome, { dir: work, quality: o.quality, w: o.w, h: o.h + TC_H, everyNthFrame: o.every || Math.max(1, Math.round(60 / o.fps)) });
    await chrome.eval('director.probe.start()');
    await chrome.eval('director.clockMarks.start(50)');
    await sleep(1200); // the first screencast frames arrive irregularly
    const pulses = [];
    for (let i = 0; i < 5; i++) { pulses.push(await chrome.eval(`director.syncPulse('pre${i}')`)); await sleep(230 + i * 17); }
    await sleep(250);

    // ── the timeline ──
    const t0 = await chrome.eval(`({ wall: director.wallNow() / 1000, ctx: director.audioClock() })`);
    log(`take ${take}: timeline start (${path.basename(env.timelinePath)}, ${env.lang})`);
    const failure = await runTimeline(chrome, o, env, report, t0, take);
    await sleep(env.tail * 1000);
    const t1 = await chrome.eval(`({ wall: director.wallNow() / 1000, ctx: director.audioClock() })`);
    log(`take ${take}: timeline end after ${(t1.wall - t0.wall).toFixed(2)} s`);

    // ── post-roll pulses, capture off ──
    await sleep(150);
    for (let i = 0; i < 3; i++) { pulses.push(await chrome.eval(`director.syncPulse('post${i}')`)); await sleep(230 + i * 17); }
    await sleep(300);
    const perf = await chrome.eval('director.probe.stop()');
    const clock = await chrome.eval('director.clockMarks.stop()');
    const { index, file: framesFile } = await cast.stop();
    cast = null;
    const tapInfo = await chrome.eval('director.tap.stop()');
    const audio = Buffer.alloc(tapInfo.bytes);
    const CH = 6 * 1024 * 1024;
    for (let off = 0; off < tapInfo.bytes; off += CH) Buffer.from(await chrome.eval(`director.tap.read(${off}, ${CH})`), 'base64').copy(audio, off);
    await chrome.eval('director.tap.free()');
    report.chromeLogs = chrome.logs.filter(l => /error|warn|EXC/i.test(l)).slice(-40);
    await chrome.close();
    log(`take ${take}: ${index.length} frames, ${(tapInfo.frames / tapInfo.sampleRate).toFixed(2)} s of audio (gaps ${tapInfo.gapFrames} samples)`);
    report.sampleRate = tapInfo.sampleRate;
    report.tap = { sampleRate: tapInfo.sampleRate, frames: tapInfo.frames, gapFrames: tapInfo.gapFrames, overlaps: tapInfo.overlaps };
    if (failure) report.timelineError = String(failure && failure.stack || failure);

    // ── audio clock: page time (ms) of context frame 0, from the clock marks (jitter = one audio callback) ──
    const sr = tapInfo.sampleRate;
    const markFrame = new Map(tapInfo.marks.map(m => [m.id, m.frame]));
    const oc = clock.filter(c => markFrame.has(c.id)).map(c => ({ wall: c.wall, o: c.wall - (markFrame.get(c.id) / sr) * 1000 }));
    if (oc.length < 4) throw new Error('audio clock marks missing — the audio engine never started (with --no-autostart the timeline must start it: ctx.aurora.start() or a click on the splash)');
    const oMed = median(oc.map(x => x.o));
    const env1 = [];
    for (let i = 0; i < oc.length; i += 20) env1.push(Math.max(...oc.slice(i, i + 20).map(x => x.o)));
    const wanderMs = Math.max(...env1) - Math.min(...env1); // a step here = the audio clock slipped

    // ── video: which moment each captured frame shows (timecode strip); fallback: compositor time − pulse lag ──
    const codes = await decodeTimecodes(framesFile, index, { y: o.h });
    let times = unwrapTimecodes(codes, t0.wall * 1000);
    const validTc = times.filter(t => t != null).length;
    const onsets = await detectOnsets(framesFile, index, pulses.map(p => ({ id: p.id, wall: p.wall / 1000 })), SYNC_REGION);
    let method = 'timecode';
    if (validTc < index.length * 0.5) {
      method = 'pulses';
      const lags = onsets.filter(x => x.lag != null).map(x => x.lag);
      const lag = lags.length ? median(lags) : 0.05;
      times = index.map(f => (f.t - lag) * 1000);
      log(`WARNING: timecode readable in only ${validTc}/${index.length} frames — using compositor timestamps (pulse lag ${(lag * 1000).toFixed(1)} ms)`);
    }
    // output grid on the render cadence, from the first frame rendered at/after the timeline start
    const sorted = times.filter(t => t != null).sort((a, b) => a - b);
    const tStart = sorted.find(t => t >= t0.wall * 1000 - 0.5) ?? t0.wall * 1000;
    const nOut = Math.max(1, Math.round(((t1.wall * 1000 - tStart) * o.fps) / 1000));
    const { picks, stats } = pickByContentTime(times, tStart, nOut, o.fps);
    report.video = stats;
    // output time τ ↔ page time tStart + τ − ½ frame: an event's sound lands mid-way into the first frame that shows it
    const aStartCtx = Math.round((((tStart - 500 / o.fps) - oMed) / 1000) * sr);
    const pulseCheck = onsets.map((x) => {
      const m = markFrame.get(x.id);
      if (x.index < 0 || m == null || times[x.index] == null) return { id: x.id, avMs: null };
      return { id: x.id, avMs: +((m * 1000) / sr + oMed + 500 / o.fps - times[x.index]).toFixed(2) };
    });
    report.sync = {
      method, timecodeFrames: `${validTc}/${index.length}`,
      audioClockJitterMs: +(Math.max(...oc.map(x => x.o)) - Math.min(...oc.map(x => x.o))).toFixed(2), audioClockWanderMs: +wanderMs.toFixed(2),
      pulseAvMs: pulseCheck, undetectedPulses: onsets.filter(x => x.t == null).map(x => x.id),
      captureLatencyMs: onsets.filter(x => x.index >= 0 && times[x.index] != null).map(x => +((index[x.index].t * 1000 - times[x.index])).toFixed(1)),
    };
    const avs = pulseCheck.filter(p => p.avMs != null).map(p => p.avMs);
    log(`take ${take}: sync by ${method} (timecode ${validTc}/${index.length}) · audio clock jitter ${report.sync.audioClockJitterMs} ms, wander ${report.sync.audioClockWanderMs} ms · pulse audio−picture ${avs.join(' ')} ms`);
    if (wanderMs > 6) log(`WARNING: the audio clock wandered ${wanderMs.toFixed(1)} ms against the page clock`);

    const rel = x => +((x - tStart) / 1000).toFixed(3);
    const t1ms = tStart + (nOut * 1000) / o.fps;
    report.perf = {
      rafFrames: perf.frames,
      renderGaps: sorted.slice(1).map((t, i) => ({ t: rel(sorted[i]), ms: +(t - sorted[i]).toFixed(1) })).filter(g => g.ms > 1500 / o.fps && g.t >= 0 && g.t <= (t1ms - tStart) / 1000),
      longTasks: perf.longTasks.filter(f => f.at >= tStart - 500 && f.at <= t1ms).map(f => ({ t: rel(f.at), ms: f.ms, where: f.where })),
      longAnimationFrames: perf.longFrames.filter(f => f.at >= tStart - 500 && f.at <= t1ms).map(f => ({ ...f, t: rel(f.at), at: undefined })),
    };
    for (const e of report.events) if (e.wall) e.t = e.t ?? rel(e.wall * 1000);

    // ── audio segment ──
    const f32 = new Float32Array(audio.buffer, audio.byteOffset, audio.byteLength / 4);
    const aLen = Math.round((nOut / o.fps) * sr);
    const seg = sliceAudio(f32, aStartCtx - tapInfo.firstFrame, aLen, 2);
    const audioRaw = path.join(work, 'audio.f32');
    fs.writeFileSync(audioRaw, Buffer.from(seg.buffer, seg.byteOffset, seg.byteLength));
    let peak = 0, sum = 0;
    for (let i = 0; i < seg.length; i++) { const v = Math.abs(seg[i]); if (v > peak) peak = v; sum += seg[i] * seg[i]; }
    if (o.loudness != null && Number.isFinite(o.loudness)) {
      // plain gain toward the target integrated loudness, never past −1 dBFS sample peak (no limiter: no pumping, no latency)
      const r = await ffmpeg(['-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', audioRaw, '-af', 'ebur128', '-f', 'null', '-'], { quiet: false });
      const m = r.stderr.match(/Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/);
      const measured = m ? +m[1] : null;
      if (measured != null && measured > -70) {
        const peakDb = 20 * Math.log10(peak || 1e-9);
        const gainDb = Math.min(o.loudness - measured, -1 - peakDb);
        const g = 10 ** (gainDb / 20);
        for (let i = 0; i < seg.length; i++) seg[i] *= g;
        fs.writeFileSync(audioRaw, Buffer.from(seg.buffer, seg.byteOffset, seg.byteLength));
        peak *= g; sum *= g * g;
        report.loudness = { targetLufs: o.loudness, measuredLufs: measured, gainDb: +gainDb.toFixed(2), resultLufs: +(measured + gainDb).toFixed(1), peakLimited: gainDb < o.loudness - measured - 0.01 };
        log(`take ${take}: loudness ${measured} LUFS → ${report.loudness.resultLufs} LUFS (gain ${report.loudness.gainDb} dB${report.loudness.peakLimited ? ', held back by the −1 dBFS peak' : ''})`);
      }
    }
    report.audio = { sampleRate: sr, seconds: +(aLen / sr).toFixed(3), peakDbfs: +(20 * Math.log10(peak || 1e-9)).toFixed(2), rmsDbfs: +(10 * Math.log10(sum / seg.length || 1e-18)).toFixed(2),
      paddedSamples: Math.max(0, tapInfo.firstFrame - aStartCtx) + Math.max(0, aStartCtx + aLen - (tapInfo.firstFrame + tapInfo.frames)) };
    report.duration = +(nOut / o.fps).toFixed(3);
    report.timeline0 = { ...t0, videoStartMs: tStart };
    if (o.keep) fs.writeFileSync(path.join(work, 'capture.json'), JSON.stringify({ pulses, onsets, marks: tapInfo.marks, clock, t0, t1, tStart, oMed, times, picks, sampleRate: sr }));
    const score = stats.uniqueSourceFrames / stats.outputFrames;
    log(`take ${take}: ${stats.uniqueSourceFrames}/${stats.outputFrames} unique frames (${(score * 100).toFixed(1)}%) · held ${stats.duplicatedOutputFrames} · longest render gap ${stats.maxRenderGapMs} ms`);
    return { take, work, report, framesFile, index, picks, nOut, audioRaw, sr, score, failure };
  } catch (e) {
    if (cast) { try { await cast.stop(); } catch { /* ignore */ } }
    await chrome.close();
    if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

async function finishTake(t, o, env) {
  const out = env.out;
  log(`encoding take ${t.take}: ${t.nOut} frames (${t.report.duration} s) → ${path.relative(ROOT, out)}`);
  await encode({ framesFile: t.framesFile, index: t.index, picks: t.picks, fps: o.fps, audioRaw: t.audioRaw, sampleRate: t.sr, out, crf: o.crf, preset: o.preset, w: o.w, h: o.h, cropH: o.h });
  if (o.wav) await writeWav(t.audioRaw, t.sr, out.replace(/\.[^.]+$/, '.wav'));
  t.report.finished = new Date().toISOString();
  t.report.workDir = o.keep ? t.work : null;
  fs.writeFileSync(out.replace(/\.[^.]+$/, '.json'), JSON.stringify(t.report, null, 2));
  if (!o.keep) fs.rmSync(t.work, { recursive: true, force: true });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.timeline || !o.out) {
    { const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); }
    process.exit(o.help ? 0 : 2);
  }
  const timelinePath = path.resolve(o.timeline);
  const tl = await import(pathToFileURL(timelinePath).href);
  if (typeof tl.default !== 'function') throw new Error('the timeline module must `export default async function (ctx) {…}`');
  const meta = tl.meta || {};
  const env = {
    run: tl.default, prepare: typeof tl.prepare === 'function' ? tl.prepare : null, timelinePath, meta,
    lang: o.lang === 'zh' ? 'zh' : 'en',
    overlaySpec: o.overlay ?? meta.overlay ?? './overlays/overlay.js',
    cursor: o.cursor ?? meta.cursor ?? 'overlay',
    tail: o.tail ?? meta.tail ?? 0.5,
    out: path.resolve(o.out),
  };
  fs.mkdirSync(path.dirname(env.out), { recursive: true });
  await ensureServer();
  if (o.dry) { await dryRun(o, env); return; }

  const takes = [];
  let best = null;
  // --score shots: rank takes by the frames held INSIDE the timeline's 'shot' windows (what the edit uses) — hitches
  // in the set-up gaps between shots do not count
  const shotScore = t => {
    const win = (t.report.events || []).filter(e => e.type === 'mark' && e.label === 'shot' && e.start != null).map(e => [e.start, e.start + e.dur]);
    if (!win.length) return t.score;
    const fr = 1000 / o.fps;
    const held = (t.report.perf?.renderGaps || []).filter(g => win.some(([a, b]) => g.t >= a - 0.02 && g.t < b)).reduce((n, g) => n + Math.max(0, Math.round(g.ms / fr) - 1), 0);
    const frames = win.reduce((n, [a, b]) => n + (b - a) * o.fps, 0);
    return 1 - held / frames;
  };
  for (let k = 1; k <= o.takes; k++) {
    const t = await captureTake(o, env, k);
    if (o.score === 'shots') { t.overall = t.score; t.score = shotScore(t); log(`take ${k}: ${(t.score * 100).toFixed(2)}% unique frames inside the shot windows`); }
    takes.push(t);
    if (!best || t.score > best.score + 1e-9 || (t.score === best.score && t.report.video.maxRenderGapMs < best.report.video.maxRenderGapMs)) best = t;
    if (t.failure || best.score >= o.minUnique) break;
    if (k < o.takes) log(`take ${k} below ${(o.minUnique * 100).toFixed(1)}% unique frames — recording another take`);
  }
  best.report.takes = takes.map(t => ({ take: t.take, uniqueRatio: +t.score.toFixed(4), maxRenderGapMs: t.report.video.maxRenderGapMs }));
  await finishTake(best, o, env);
  for (const t of takes) if (t !== best && !o.keep) fs.rmSync(t.work, { recursive: true, force: true });
  log(`done: ${path.relative(ROOT, env.out)} (take ${best.take}/${takes.length}, ${(best.score * 100).toFixed(1)}% unique frames)`);
  if (best.failure) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error('[record] FAILED:', e && e.stack || e); process.exit(1); });
