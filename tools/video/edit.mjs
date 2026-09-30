#!/usr/bin/env node
// Cut the X film together from its takes (tools/video/timelines/*.mjs → renders/video/takes/*-<lang>.mp4).
//
//   node tools/video/edit.mjs --lang en            → renders/video/aurora-x-en.mp4 (+ .json edit report)
//   node tools/video/edit.mjs --lang zh --takes renders/video/takes --out renders/video/aurora-x-zh.mp4
//   options: --fps 60 · --crf 17 · --preset slow · --lufs -14 · --tp -1.5 (true-peak ceiling, wins over --lufs) · --suffix -test (take file suffix) · --no-audio-norm
//
// The film's clock is its soundtrack: Neon Nights, song beats 188 → 260 (renders/video/assets/bed-neon-b188-260.wav,
// the offline render by the app's own engine with two arrangement mutes, trimmed so that beat onsets are ON the
// grid — tools/video/make-bed.mjs). Every segment is cut on that beat grid, frame-exact:
//   film frame of song beat b = round((b − 188) · 60/104 · fps)
// In-points: UI/proof takes → their 'shot' marks (the timeline scheduled beat 0 of each shot at that take time);
// the songs take (the app played the same song live) → cross-correlation of the take's lossless audio with the
// song render, i.e. the exact video time of each song beat in that take. Beats 216–220 are a 2×2 grid of four
// shots (E1–E4) with a caption still (tools/video/make-label.mjs) on top.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { decodeWav } = await import(pathToFileURL(path.join(ROOT, 'tools/wav.mjs')).href);
const BPM = 104, BEAT = 60 / BPM, B0 = 188, B1 = 260, SR = 48000;

const args = (() => {
  const o = { lang: 'en', fps: 60, crf: 17, preset: 'slow', lufs: -14, tp: -1.5, suffix: '', takes: 'renders/video/takes', out: null, norm: true };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i], v = () => a[++i];
    if (k === '--lang') o.lang = v(); else if (k === '--fps') o.fps = +v(); else if (k === '--crf') o.crf = +v();
    else if (k === '--preset') o.preset = v(); else if (k === '--lufs') o.lufs = +v(); else if (k === '--tp') o.tp = +v();
    else if (k === '--suffix') o.suffix = v(); else if (k === '--takes') o.takes = v(); else if (k === '--out') o.out = v();
    else if (k === '--no-audio-norm') o.norm = false; else if (k === '--bed') o.bed = v();
    else throw new Error(`unknown option ${k}`);
  }
  o.out = path.resolve(ROOT, o.out || `renders/video/aurora-x-${o.lang}.mp4`);
  o.takesDir = path.resolve(ROOT, o.takes);
  o.bed = path.resolve(ROOT, o.bed || 'renders/video/assets/bed-neon-b188-260.wav');
  return o;
})();
const log = (...a) => console.log('[edit]', ...a);
const F = b => Math.round((b - B0) * BEAT * args.fps);          // film frame of song beat b

function run(cmd, argv, { quiet = true } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (!quiet) process.stderr.write(d); });
    p.on('close', c => (c === 0 ? res({ out, err }) : rej(new Error(`${cmd} exited ${c}\n${err.slice(-3000)}`))));
  });
}

const take = name => {
  const base = path.join(args.takesDir, `${name}-${args.lang}${args.suffix}`);
  const mp4 = base + '.mp4', json = base + '.json', wav = base + '.wav';
  for (const f of [mp4, json]) if (!fs.existsSync(f)) throw new Error(`missing take ${f}`);
  return { name, mp4, wav, json, report: JSON.parse(fs.readFileSync(json, 'utf8')) };
};
const marks = (t, label) => t.report.events.filter(e => e.type === 'mark' && (!label || e.label === label));

/* ── song-sync by cross-correlation: the take's lossless audio vs the song render ── */
let SONG = null;
function songMono() {
  if (SONG) return SONG;
  const w = decodeWav(fs.readFileSync(path.join(ROOT, 'renders/video/assets/neon-nights.wav')));
  const [L, R] = w.channels;
  SONG = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) SONG[i] = 0.5 * (L[i] + R[i]);
  return SONG;
}
/**
 * Video time of song beat `b` in a take where the app played Neon Nights from its top.
 * est = the timeline's own estimate (engine state, ±1 callback); window [w0, w1] = take seconds to correlate.
 */
function beatClock(t, est, w0, w1) {
  const w = decodeWav(fs.readFileSync(t.wav));
  const [L, R] = w.channels;
  if (w.sampleRate !== SR) throw new Error(`${t.wav}: ${w.sampleRate} Hz`);
  const x = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) x[i] = 0.5 * (L[i] + R[i]);
  const y = songMono();
  // estimate: take sample i ↔ song sample i + D0 (est = { beat, t }: song beat `beat` shows at take time `t`)
  const D0 = Math.round(est.beat * BEAT * SR - est.t * SR);
  const i0 = Math.max(0, Math.round(w0 * SR)), N = Math.min(Math.round((w1 - w0) * SR), x.length - i0);
  const corr = (D, step = 1) => {
    let s = 0, ex = 0, ey = 0;
    for (let i = 0; i < N; i += step) { const a = x[i0 + i], c = y[i0 + i + D] || 0; s += a * c; ex += a * a; ey += c * c; }
    return s / Math.sqrt(ex * ey + 1e-20);
  };
  let best = -2, bestD = D0;
  const range = Math.round(0.08 * SR);
  for (let d = -range; d <= range; d += 8) { const c = corr(D0 + d, 4); if (c > best) { best = c; bestD = D0 + d; } }
  const coarse = bestD;
  for (let d = -12; d <= 12; d++) { const c = corr(coarse + d, 1); if (c > best) { best = c; bestD = coarse + d; } }
  const peak = corr(bestD, 1);
  const beatT = b => (b * BEAT * SR - bestD) / SR;
  log(`${t.name}: song sync by correlation r=${peak.toFixed(4)} over ${(N / SR).toFixed(1)} s · correction ${(((bestD - D0) / SR) * 1000).toFixed(1)} ms vs the timeline's estimate`);
  if (peak < 0.5) throw new Error(`${t.name}: weak correlation ${peak.toFixed(3)} — did the song play?`);
  return { beatT, corr: +peak.toFixed(4), correctionMs: +(((bestD - D0) / SR) * 1000).toFixed(2) };
}

async function main() {
  const B = take('ui'), C = take('songs'), D = take('proof');
  const segs = [];
  const add = (src, b0, b1, inT, label, extra = {}) => segs.push({ src, b0, b1, inT, label, ...extra });

  // ── C: songs (S) — placed by correlation with the song render ──
  const cSync = marks(C, 'sync')[0];
  const cClock = beatClock(C, { beat: cSync.b0, t: cSync.sb0 }, 0.5, C.report.duration - 0.3);
  // ── B / D: shot marks ──
  const shot = (t, id) => { const m = marks(t, 'shot').find(e => e.id === id); if (!m) throw new Error(`${t.name}: no shot ${id}`); return m.start; };

  add(B, 188, 192, shot(B, 'H'), 'H hook');
  add(B, 192, 200, shot(B, 'D'), 'D drop → browser tab');
  add(D, 200, 208, shot(D, 'L'), 'L build log');
  add(B, 208, 216, shot(B, 'P'), 'P presets');
  add(B, 216, 220, shot(B, 'E1'), 'E engines 2×2', { grid: ['E1', 'E2', 'E3', 'E4'].map(id => ({ id, inT: shot(B, id) })) });
  add(B, 220, 224, shot(B, 'T'), 'T tour');
  add(B, 224, 228, shot(B, 'M'), 'M mood');
  add(C, 228, 232, cClock.beatT(cSync.b0), 'S songs');
  add(D, 232, 252, shot(D, 'NAX'), 'NAX spectrogram → agents → numbers');
  add(B, 252, 256, shot(B, 'Q'), 'Q never heard');
  add(B, 256, 260, shot(B, 'Z'), 'Z end card');

  // frames: film grid → source in-frame (the source take's frame at the in-point)
  const fps = args.fps;
  const window = (src, inT, frames, label) => {
    const inFrame = Math.round(inT * fps), srcFrames = Math.round(src.report.duration * fps);
    if (inFrame < 0 || inFrame + frames > srcFrames) throw new Error(`${label}: [${inFrame}, ${inFrame + frames}) outside ${src.name} (${srcFrames} frames)`);
    // held frames inside the window (from the recorder's render-gap list)
    const t0 = inFrame / fps, t1 = (inFrame + frames) / fps;
    const renderGaps = (src.report.perf?.renderGaps || []).filter(g => g.t >= t0 - 0.02 && g.t < t1);
    return { inFrame, renderGaps };
  };
  for (const s of segs) {
    s.frames = F(s.b1) - F(s.b0);
    Object.assign(s, window(s.src, s.inT, s.frames, s.label));
    if (s.grid) for (const g of s.grid) Object.assign(g, window(s.src, g.inT, s.frames, `${s.label} ${g.id}`));
  }
  const total = F(B1);
  log(`${segs.length} segments, ${total} frames = ${(total / fps).toFixed(3)} s at ${fps} fps`);
  for (const s of segs) {
    const gaps = s.grid ? s.grid.flatMap(g => g.renderGaps) : s.renderGaps;
    log(`  ${String(F(s.b0)).padStart(5)}  ${s.label.padEnd(36)} ${s.src.name.padEnd(6)} in ${s.inT.toFixed(3)} s (frame ${s.inFrame}) × ${s.frames}${s.grid ? ` [${s.grid.map(g => `${g.id}@${g.inFrame}`).join(' ')}]` : ''}${gaps.length ? `  gaps: ${gaps.map(g => `${g.t}s/${g.ms}ms`).join(' ')}` : ''}`);
  }

  // ── audio: the bed, loudness-normalised with ONE static gain (EBU R128 integrated → target; no compressor or
  //    limiter: the bed's dynamics — the quiet pre-drop, the breakdown bar — stay exactly as rendered) ──
  const work = fs.mkdtempSync(path.join(path.dirname(args.out), '.edit-'));
  let audio = args.bed, loud = null;
  if (args.norm) {
    const measure = async f => {
      const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
      const num = re => { const m = r.err.match(re); return m ? +m[1] : null; };
      return { I: num(/Integrated loudness:\s*I:\s*(-?[\d.]+)/), LRA: num(/Loudness range:\s*LRA:\s*(-?[\d.]+)/), TP: num(/True peak:\s*Peak:\s*(-?[\d.]+)/) };
    };
    const inp = await measure(args.bed);
    // toward the loudness target, but never past the true-peak ceiling (the AAC encode adds a few tenths of a dB)
    const gainDb = +Math.min(args.lufs - inp.I, args.tp - inp.TP).toFixed(2);
    audio = path.join(work, 'bed-norm.wav');
    await run('ffmpeg', ['-hide_banner', '-nostats', '-y', '-i', args.bed, '-af', `volume=${gainDb}dB`, '-c:a', 'pcm_s24le', audio]);
    const out = await measure(audio);
    loud = { input: inp, gainDb, output: out, type: 'static gain' };
    log(`audio: ${inp.I} LUFS / ${inp.TP} dBTP / LRA ${inp.LRA} → gain ${gainDb} dB → ${out.I} LUFS / ${out.TP} dBTP`);
  }

  // ── video: frame-exact trims of every take, concatenated, one encode ──
  const srcs = [...new Set(segs.map(s => s.src))];
  const inputs = srcs.flatMap(s => ['-i', s.mp4]);
  // pieces cut from each source: plain segments + every quadrant of a grid segment
  const pieces = [];
  segs.forEach((x, si) => {
    if (x.grid) x.grid.forEach((g, gi) => pieces.push({ src: x.src, inFrame: g.inFrame, frames: x.frames, pad: `q${si}_${gi}` }));
    else pieces.push({ src: x.src, inFrame: x.inFrame, frames: x.frames, pad: `v${si}` });
  });
  const labelPng = path.join(ROOT, `renders/video/assets/label-engines-${args.lang}.png`);
  const hasGrid = segs.some(x => x.grid);
  if (hasGrid && !fs.existsSync(labelPng)) throw new Error(`missing ${labelPng} (node tools/video/make-label.mjs)`);
  const lblIdx = srcs.length, aIdx = srcs.length + (hasGrid ? 1 : 0);
  const extraIn = hasGrid ? ['-loop', '1', '-framerate', String(fps), '-i', labelPng] : [];
  const fc = [];
  srcs.forEach((s, i) => {
    const mine = pieces.filter(p => p.src === s);
    fc.push(`[${i}:v]fps=${fps},split=${mine.length}${mine.map((_, k) => `[s${i}_${k}]`).join('')}`);
    mine.forEach((p, k) => fc.push(`[s${i}_${k}]trim=start_frame=${p.inFrame}:end_frame=${p.inFrame + p.frames},setpts=PTS-STARTPTS[${p.pad}]`));
  });
  // 2×2 grid: 954×536 quadrants, 12/8 px gutters on the app's own background colour, the caption still on top
  segs.forEach((x, si) => {
    if (!x.grid) return;
    x.grid.forEach((_, gi) => fc.push(`[q${si}_${gi}]scale=954:536:flags=lanczos,setsar=1[qs${si}_${gi}]`));
    fc.push(`${x.grid.map((_, gi) => `[qs${si}_${gi}]`).join('')}xstack=inputs=4:layout=0_0|966_0|0_544|966_544:fill=0x07080d[g${si}]`);
    fc.push(`[${lblIdx}:v]format=rgba,trim=end_frame=${x.frames},setpts=PTS-STARTPTS,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[l${si}]`);
    fc.push(`[g${si}][l${si}]overlay=0:0:format=auto,format=yuv420p[v${si}]`);
  });
  fc.push(`${segs.map((_, si) => `[v${si}]`).join('')}concat=n=${segs.length}:v=1:a=0,format=yuv420p[vout]`);
  fc.push(`[${aIdx}:a]atrim=end_sample=${Math.round((total / fps) * SR)},asetpts=PTS-STARTPTS[aout]`);
  const tmp = args.out.replace(/\.mp4$/, '.tmp.mp4');
  const argv = ['-hide_banner', '-y', ...inputs, ...extraIn, '-i', audio, '-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', args.preset, '-crf', String(args.crf), '-profile:v', 'high', '-level:v', '4.2', '-pix_fmt', 'yuv420p',
    '-x264-params', 'aq-mode=3:keyint=120:min-keyint=30', '-r', String(fps),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-frames:v', String(total), tmp];
  log('encoding…');
  await run('ffmpeg', argv);
  fs.renameSync(tmp, args.out);
  fs.rmSync(work, { recursive: true, force: true });
  const report = {
    out: path.relative(ROOT, args.out), lang: args.lang, fps, frames: total, seconds: +(total / fps).toFixed(3), loudness: loud,
    sync: { songs: { corr: cClock.corr, correctionMs: cClock.correctionMs } },
    segments: segs.map(s => ({ label: s.label, beats: [s.b0, s.b1], filmFrame: F(s.b0), frames: s.frames, take: path.relative(ROOT, s.src.mp4), inSeconds: +s.inT.toFixed(4), inFrame: s.inFrame, renderGaps: s.renderGaps,
      ...(s.grid ? { grid: s.grid.map(g => ({ id: g.id, inSeconds: +g.inT.toFixed(4), inFrame: g.inFrame, renderGaps: g.renderGaps })) } : {}) })),
  };
  fs.writeFileSync(args.out.replace(/\.mp4$/, '.json'), JSON.stringify(report, null, 2));
  log(`done: ${path.relative(ROOT, args.out)}`);
}

main().catch(e => { console.error('[edit] FAILED:', e.stack || e); process.exit(1); });
