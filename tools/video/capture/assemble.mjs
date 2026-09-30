// Assembly: captured frames + lossless audio tap → constant-frame-rate video with aligned audio.
//
// Video timing. Every frame the director draws its page time (rAF frame time) into a timecode strip below the stage;
// decodeTimecodes() reads it back from each captured JPEG, so we know exactly which moment each captured frame
// shows, independent of the capture pipeline's (variable, 25–45 ms) latency. pickByContentTime() then builds the
// CFR sequence: output frame k shows the latest frame whose content time ≤ start + k/fps.
// Audio timing. The director posts a 'mark' to the audio tap every 50 ms, stamped with the page clock; the tap
// answers with the context frame of the first render quantum after it — the quantum in which a note posted from the
// same task starts. The median offset maps context frames to page time (jitter = one audio callback, ≈5 ms).
// White-square "sync pulses" (pre-/post-roll) are decoded too: they verify the result and are the fallback when the
// timecode is unreadable (then compositor timestamps − median pulse lag are used as content times).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFrame } from './screencast.mjs';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';

/** Run ffmpeg; stdinWriter(stream) may feed stdin. Resolves { code, stderr, stdout(Buffer) }. */
export function ffmpeg(args, { stdinWriter = null, collectStdout = false, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...(quiet ? ['-loglevel', 'error'] : []), ...args].filter(a => a !== '-nostdin' || !stdinWriter), { stdio: [stdinWriter ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let err = '';
    const out = [];
    p.stderr.on('data', d => { err = (err + d).slice(-200000); });
    p.stdout.on('data', d => { if (collectStdout) out.push(d); });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stderr: err, stdout: Buffer.concat(out) }));
    if (stdinWriter) {
      p.stdin.on('error', () => {});
      Promise.resolve(stdinWriter(p.stdin)).then(() => p.stdin.end(), (e) => { p.stdin.destroy(e); });
    }
  });
}

/** write with back-pressure */
export function writeAsync(stream, buf) {
  return new Promise((res) => { if (stream.write(buf)) res(); else stream.once('drain', res); });
}

/**
 * Mean luma (0..255) of a crop region for a list of frames (decoded by ffmpeg in one pass).
 * @returns {Promise<number[]>}
 */
export async function regionLuma(framesFile, frames, { x, y, w, h }) {
  if (!frames.length) return [];
  const fd = fs.openSync(framesFile, 'r');
  try {
    const r = await ffmpeg(['-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], {
      collectStdout: true,
      stdinWriter: async (stdin) => { for (const fr of frames) await writeAsync(stdin, readFrame(fd, fr)); },
    });
    if (r.code !== 0) throw new Error(`ffmpeg luma failed: ${r.stderr.slice(-800)}`);
    return [...r.stdout];
  } finally { fs.closeSync(fd); }
}

/**
 * First captured frame showing a white mark after each trigger.
 * @param {{ id, wall }[]} triggers  page wall times (s) of the triggers
 * @returns {Promise<{ id, wall, t: number|null, lag: number|null, index: number }[]>}  t = compositor time of onset frame
 */
export async function detectOnsets(framesFile, index, triggers, region, { before = 0.15, after = 0.6, on = 170, off = 110 } = {}) {
  const out = [];
  for (const tr of triggers) {
    const lo = tr.wall - before, hi = tr.wall + after;
    const i0 = index.findIndex(f => f.t >= lo);
    if (i0 < 0) { out.push({ ...tr, t: null, lag: null, index: -1 }); continue; }
    let i1 = i0;
    while (i1 < index.length && index[i1].t <= hi) i1++;
    const cand = index.slice(i0, i1);
    const luma = await regionLuma(framesFile, cand, region);
    let hit = -1;
    for (let i = 0; i < luma.length; i++) {
      if (luma[i] >= on && (i === 0 ? true : luma[i - 1] <= off) && cand[i].t >= tr.wall - 0.02) { hit = i; break; }
    }
    out.push({ ...tr, t: hit >= 0 ? cand[hit].t : null, lag: hit >= 0 ? cand[hit].t - tr.wall : null, index: hit >= 0 ? i0 + hit : -1, prevT: hit > 0 ? cand[hit - 1].t : null });
  }
  return out;
}

/**
 * Decode the director's timecode strip (32 blocks of 8×8 px at (0, y)) from every captured frame.
 * @returns {Promise<(number|null)[]>}  page time in ms (performance.timeOrigin-based) of each frame's content, or null
 */
export async function decodeTimecodes(framesFile, index, { y = 1080, w = 256, h = 8 } = {}) {
  if (!index.length) return [];
  const fd = fs.openSync(framesFile, 'r');
  let raw;
  try {
    const r = await ffmpeg(['-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0', '-vf', `crop=${w}:${h}:0:${y},format=gray`, '-f', 'rawvideo', 'pipe:1'], {
      collectStdout: true,
      stdinWriter: async (stdin) => { for (const fr of index) await writeAsync(stdin, readFrame(fd, fr)); },
    });
    if (r.code !== 0) throw new Error(`ffmpeg timecode decode failed: ${r.stderr.slice(-800)}`);
    raw = r.stdout;
  } finally { fs.closeSync(fd); }
  const per = w * h;
  const n = Math.floor(raw.length / per);
  const out = new Array(index.length).fill(null);
  for (let i = 0; i < Math.min(n, index.length); i++) {
    const base = i * per;
    let word = 0;
    let ambiguous = false;
    for (let b = 0; b < 32; b++) {
      let sum = 0;
      for (let yy = 2; yy < 6; yy++) for (let xx = 2; xx < 6; xx++) sum += raw[base + yy * w + b * 8 + xx];
      const m = sum / 16;
      if (m > 60 && m < 195) ambiguous = true;
      word = (word * 2) + (m >= 128 ? 1 : 0);
    }
    const v = Math.floor(word / 16), chk = word % 16;
    let c = 0;
    for (let k = 0; k < 7; k++) c ^= Math.floor(v / 16 ** k) % 16;
    out[i] = !ambiguous && c === chk ? v / 10 : null; // 0.1 ms units → ms (mod 2^28 × 0.1 ms ≈ 7.5 h)
  }
  return out;
}

/** Unwrap 28-bit timecodes (0.1 ms) to the full page clock, using a reference page time (ms). */
export function unwrapTimecodes(codes, refMs) {
  const P = 0x10000000 / 10;
  return codes.map(c => (c == null ? null : c + Math.round((refMs - c) / P) * P));
}

/**
 * Output frame k (content time P_k = start + k·1000/fps) shows the captured frame with the latest content time
 * ≤ P_k (+ 1 ms). Frames without a readable timecode are skipped.
 */
export function pickByContentTime(times, startMs, n, fps) {
  const order = times.map((t, i) => ({ t, i })).filter(x => x.t != null).sort((a, b) => a.t - b.t || a.i - b.i);
  const picks = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const P = startMs + (k * 1000) / fps + 1;
    while (j + 1 < order.length && order[j + 1].t <= P) j++;
    picks[k] = order[j].i;
  }
  let dup = 0, run = 1, maxRun = 1, skipped = 0;
  const pos = new Map(order.map((x, q) => [x.i, q]));
  for (let k = 1; k < n; k++) {
    if (picks[k] === picks[k - 1]) { dup++; run++; maxRun = Math.max(maxRun, run); } else { skipped += pos.get(picks[k]) - pos.get(picks[k - 1]) - 1; run = 1; }
  }
  const inRange = order.filter(x => x.t >= startMs - 1 && x.t <= startMs + (n * 1000) / fps);
  const dts = inRange.slice(1).map((x, q) => x.t - inRange[q].t);
  return {
    picks,
    stats: {
      outputFrames: n, uniqueSourceFrames: new Set(picks).size, duplicatedOutputFrames: dup, skippedSourceFrames: skipped, longestHold: maxRun,
      sourceFramesInRange: inRange.length, sourceFps: dts.length ? +((dts.length * 1000) / (inRange.at(-1).t - inRange[0].t)).toFixed(2) : 0,
      renderGapsOver1_5Frames: dts.filter(d => d > 1500 / fps).length, maxRenderGapMs: dts.length ? +Math.max(...dts).toFixed(1) : 0,
    },
  };
}


/** Float32 interleaved stereo segment [start, start+len) of the tap buffer, zero padded outside. */
export function sliceAudio(buf, start, len, channels = 2) {
  const out = new Float32Array(len * channels);
  const total = buf.length / channels;
  const a = Math.max(0, start), b = Math.min(total, start + len);
  if (b > a) out.set(buf.subarray(a * channels, b * channels), (a - start) * channels);
  return out;
}

export const ENCODERS = {
  // X / web delivery: H.264 High, BT.709 limited range, AAC. aq-mode 3 protects the dark aurora gradients.
  '.mp4': ({ crf = 14, fps = 60, preset = 'slow' }) => ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high', '-level:v', fps > 30 ? '4.2' : '4.1',
    '-x264-params', 'aq-mode=3:aq-strength=0.9:deblock=-1,-1:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv', '-g', String(Math.round(fps * 2)), '-bf', '2',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart'],
  '.webm': ({ crf = 18 }) => ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'libopus', '-b:a', '256k'],
  // editing intermediate: ProRes 422 HQ + 24-bit PCM
  '.mov': () => ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s24le'],
  // near-lossless H.264 + FLAC
  '.mkv': ({ fps = 60 }) => ['-c:v', 'libx264', '-preset', 'medium', '-crf', '6', '-pix_fmt', 'yuv444p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv', '-g', String(Math.round(fps * 2)), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'flac'],
};

/**
 * Encode the CFR video (frames piped in pick order) + the aligned audio.
 * JPEG frames are full-range BT.601 (JFIF); the output is BT.709 limited range (what players expect for HD).
 */
export async function encode({ framesFile, index, picks, fps, audioRaw, sampleRate, out, crf, preset, w = 1920, h = 1080, cropH = null }) {
  const ext = path.extname(out).toLowerCase();
  const enc = ENCODERS[ext];
  if (!enc) throw new Error(`unsupported output type ${ext} (use .mp4, .webm, .mov or .mkv)`);
  const vf = `${cropH ? `crop=${w}:${cropH}:0:0,` : ''}scale=${w}:${h}:flags=lanczos:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv`;
  const fd = fs.openSync(framesFile, 'r');
  try {
    const args = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', audioRaw,
      '-map', '0:v:0', '-map', '1:a:0', '-vf', vf, '-r', String(fps), ...enc({ crf, fps, preset }), '-shortest', out];
    const r = await ffmpeg(args, {
      stdinWriter: async (stdin) => {
        let last = -1, lastBuf = null;
        for (const i of picks) {
          if (i !== last) { lastBuf = readFrame(fd, index[i]); last = i; }
          await writeAsync(stdin, lastBuf);
        }
      },
    });
    if (r.code !== 0) throw new Error(`ffmpeg encode failed (${r.code}): ${r.stderr.slice(-1500)}`);
  } finally { fs.closeSync(fd); }
}

/** 24-bit WAV of the aligned audio (for mixing / editing). */
export async function writeWav(audioRaw, sampleRate, out) {
  const r = await ffmpeg(['-y', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', audioRaw, '-c:a', 'pcm_s24le', out]);
  if (r.code !== 0) throw new Error(`wav failed: ${r.stderr.slice(-500)}`);
}
