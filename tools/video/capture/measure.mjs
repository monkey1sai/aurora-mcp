#!/usr/bin/env node
// Measure a recorded clip: frame rate / duplicates, A/V sync (white-flash onsets vs audio onsets), audio health.
//
//   node tools/video/capture/measure.mjs renders/video/calibration.mp4 [--flash x,y,w,h] [--frames 1.0,7.5,11.5] [--json]
//
// A/V sync needs flashes that are triggered in the same task as the notes (director.noteFlash(true), default
// region = the top-right #noteflash square). For every flash onset frame it finds the audio attack nearest to it
// and reports audio − video in ms (positive = sound after picture). Frames listed in --frames are written as PNG
// next to the clip (<clip>.f<seconds>.png) for visual inspection.

import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './assemble.mjs';

const args = process.argv.slice(2);
const file = path.resolve(args.find(a => !a.startsWith('--') && !/^[\d.,]+$/.test(a)) || 'renders/video/calibration.mp4');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flashRegion = (opt('--flash', '1816,16,88,88')).split(',').map(Number);
const shots = (opt('--frames', '') || '').split(',').filter(Boolean).map(Number);
const asJson = args.includes('--json');

async function probe() {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,pix_fmt,sample_rate,channels,bit_rate,profile,color_space,color_range:format=duration,bit_rate', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

const median = a => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

async function main() {
  const info = await probe();
  const v = info.streams.find(s => s.codec_type === 'video');
  const a = info.streams.find(s => s.codec_type === 'audio');
  const [fn, fd] = v.r_frame_rate.split('/').map(Number);
  const fps = fn / fd;

  // ── per-frame: small grey thumbnails (duplicate detection) + flash region luma ──
  const TW = 240, TH = 136;
  const thumbs = await ffmpeg(['-i', file, '-vf', `scale=${TW}:${TH}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { collectStdout: true });
  const nFrames = thumbs.stdout.length / (TW * TH);
  const [fx, fy, fw, fh] = flashRegion;
  const fl = await ffmpeg(['-i', file, '-vf', `crop=${fw}:${fh}:${fx}:${fy},scale=1:1:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { collectStdout: true });
  const flash = [...fl.stdout];
  // duplicates: mean abs diff of consecutive thumbs, ignoring the flash corner
  const diffs = [];
  for (let i = 1; i < nFrames; i++) {
    const A = thumbs.stdout.subarray((i - 1) * TW * TH, i * TW * TH), B = thumbs.stdout.subarray(i * TW * TH, (i + 1) * TW * TH);
    let s = 0;
    for (let j = 0; j < A.length; j++) s += Math.abs(A[j] - B[j]);
    diffs.push(s / A.length);
  }
  const dupes = diffs.map((d, i) => ({ i: i + 1, d })).filter(x => x.d < 0.02);
  const runs = [];
  for (let i = 0, run = 0; i <= diffs.length; i++) {
    if (i < diffs.length && diffs[i] < 0.02) run++; else { if (run) runs.push({ endFrame: i, frames: run }); run = 0; }
  }

  // ── audio (decoded from the delivered file: includes the AAC edit list / priming handling) ──
  const sr = 48000;
  const au = await ffmpeg(['-i', file, '-map', '0:a:0', '-f', 'f32le', '-ac', '2', '-ar', String(sr), 'pipe:1'], { collectStdout: true });
  const pcm = new Float32Array(au.stdout.buffer, au.stdout.byteOffset, au.stdout.byteLength / 4);
  const nA = pcm.length / 2;
  const mono = new Float32Array(nA);
  for (let i = 0; i < nA; i++) mono[i] = (pcm[2 * i] + pcm[2 * i + 1]) * 0.5;
  // attack envelope: energy of the first difference (emphasises transients) in 1 ms windows, 0.25 ms hop
  const hop = sr / 4000, win = sr / 1000;
  const env = new Float32Array(Math.floor(nA / hop));
  for (let k = 0; k < env.length; k++) {
    const s0 = Math.floor(k * hop);
    let e = 0;
    for (let i = s0 + 1; i < Math.min(nA, s0 + win); i++) { const d = mono[i] - mono[i - 1]; e += d * d; }
    env[k] = e / win;
  }
  const envAt = t => env[Math.max(0, Math.min(env.length - 1, Math.round(t * 4000)))];

  // ── flash onsets → nearest audio attack ──
  const onsets = [];
  for (let i = 1; i < flash.length; i++) if (flash[i] >= 170 && flash[i - 1] <= 110) onsets.push(i);
  const pairs = [];
  for (const f of onsets) {
    const tv = f / fps; // frame f is shown during [f/fps, (f+1)/fps)
    // baseline: 60..15 ms before the picture; search −40..+90 ms for a ≥ 12 dB jump of the attack envelope
    const base = [];
    for (let t = tv - 0.06; t < tv - 0.015; t += 0.00025) base.push(envAt(t));
    const b = Math.max(median(base), 1e-12);
    let ta = null;
    for (let t = tv - 0.04; t < tv + 0.09; t += 0.00025) {
      if (envAt(t) > b * 16 && envAt(t) > 1e-9) { ta = t; break; }
    }
    pairs.push({ frame: f, videoS: +tv.toFixed(4), audioS: ta == null ? null : +ta.toFixed(4), offsetMs: ta == null ? null : +((ta - tv) * 1000).toFixed(1) });
  }
  const offs = pairs.filter(p => p.offsetMs != null).map(p => p.offsetMs);

  // ── audio health: clicks (2nd-difference outliers), DC, loudness ──
  let clicks = 0, peak = 0, dc = 0;
  const blk = 480;
  for (let s = 0; s + blk < nA; s += blk) {
    let m = 0;
    const d2 = new Float32Array(blk);
    for (let i = 2; i < blk; i++) { const x = mono[s + i] - 2 * mono[s + i - 1] + mono[s + i - 2]; d2[i] = Math.abs(x); m += d2[i]; }
    m /= blk;
    for (let i = 2; i < blk; i++) if (d2[i] > 0.05 && d2[i] > m * 40) { clicks++; break; }
  }
  for (let i = 0; i < mono.length; i++) { peak = Math.max(peak, Math.abs(mono[i])); dc += mono[i]; }
  dc /= mono.length || 1;
  const eb = await ffmpeg(['-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { quiet: false });
  const lufs = (eb.stderr.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop();
  const tp = (eb.stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g) || []).pop();
  // longest digital silence inside the clip (dropouts)
  let sil = 0, maxSil = 0;
  for (let i = 0; i < nA; i++) { if (Math.abs(pcm[2 * i]) < 1e-7 && Math.abs(pcm[2 * i + 1]) < 1e-7) { sil++; maxSil = Math.max(maxSil, sil); } else sil = 0; }

  for (const t of shots) {
    const png = file.replace(/\.[^.]+$/, `.f${t.toFixed(2)}.png`);
    await ffmpeg(['-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
  }

  const res = {
    file: path.relative(process.cwd(), file),
    video: { codec: v.codec_name, profile: v.profile, size: `${v.width}x${v.height}`, pix_fmt: v.pix_fmt, color: `${v.color_space}/${v.color_range}`, fps, frames: nFrames, seconds: +(nFrames / fps).toFixed(3), bitrateMbps: +(info.format.bit_rate / 1e6).toFixed(1),
      identicalToPrevious: dupes.length, holds: runs.filter(r => r.frames >= 2).map(r => `${(r.endFrame / fps).toFixed(2)}s×${r.frames + 1}`) },
    audio: { codec: a.codec_name, sampleRate: +a.sample_rate, channels: a.channels, seconds: +(nA / sr).toFixed(3), peakDbfs: +(20 * Math.log10(peak || 1e-9)).toFixed(2), dc: +dc.toExponential(2), clickBlocks: clicks, longestDigitalSilenceMs: +(maxSil / sr * 1000).toFixed(1), loudness: lufs, truePeak: tp },
    sync: { flashes: onsets.length, matched: offs.length, medianMs: +median(offs).toFixed(1), minMs: Math.min(...offs), maxMs: Math.max(...offs), meanAbsMs: +(offs.reduce((s, x) => s + Math.abs(x), 0) / (offs.length || 1)).toFixed(1), withinOneFrame: offs.filter(x => Math.abs(x) <= 1000 / fps).length, pairs },
  };
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`${res.file}: ${res.video.size} ${res.video.codec}/${res.video.profile} ${res.video.fps} fps · ${res.video.frames} frames · ${res.video.bitrateMbps} Mb/s · ${res.video.color}`);
    console.log(`  frames identical to the previous: ${res.video.identicalToPrevious}${res.video.holds.length ? ' · holds: ' + res.video.holds.join(' ') : ''}`);
    console.log(`  audio: ${res.audio.codec} ${res.audio.sampleRate} Hz ${res.audio.channels}ch · peak ${res.audio.peakDbfs} dBFS · ${res.audio.loudness} · true ${res.audio.truePeak} · click blocks ${res.audio.clickBlocks} · longest digital silence ${res.audio.longestDigitalSilenceMs} ms`);
    console.log(`  A/V sync over ${res.sync.matched}/${res.sync.flashes} flashes: median ${res.sync.medianMs} ms, range ${res.sync.minMs}…${res.sync.maxMs} ms, mean |off| ${res.sync.meanAbsMs} ms, within 1 frame: ${res.sync.withinOneFrame}/${res.sync.matched}`);
    console.log('  per flash (audio − video, ms):', pairs.map(p => `${p.videoS}s:${p.offsetMs}`).join('  '));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
