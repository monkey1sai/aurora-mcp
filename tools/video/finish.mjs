#!/usr/bin/env node
// Deliverables around the cut films (after tools/video/edit.mjs):
//   node tools/video/finish.mjs [--langs en,zh]
//   → renders/video/poster-<lang>.png         frame 0 = X's feed preview: the hook over the live UI
//     renders/video/poster-drop-<lang>.png    alternative: the drop ("A synthesizer built by Claude", t ≈ 3.0 s)
//     renders/video/poster-proof-<lang>.png   alternative: the build log with the noise box (t ≈ 8.0 s)
//     renders/video/contact-<lang>.png        contact sheet, 1 frame per second (6 × 7)
//     renders/video/check600-<lang>.png       one frame per caption, downscaled to 600 px wide (X timeline size)
//     renders/video/check390-<lang>.png       the first 3 s + the drop at 390 px wide (a phone's feed width)
//     renders/video/specs-<lang>.json         ffprobe + loudness (EBU R128 integrated, true peak) of the delivered file
//     renders/video/preview/aurora-x-<lang>-720p.mp4   a light copy for phone viewing (the 1080p60 masters are ~55 MB)
//     renders/video/POST.md                   copy of docs/video/POST.md (the post text)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'renders/video');
const langs = (process.argv.includes('--langs') ? process.argv[process.argv.indexOf('--langs') + 1] : 'en,zh').split(',');
const run = (cmd, argv) => new Promise((res, rej) => {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('close', c => (c === 0 ? res({ out, err }) : rej(new Error(`${cmd} ${c}: ${err.slice(-2000)}`))));
});
const BEAT = 60 / 104, ft = b => (b - 188) * BEAT;
// one moment per caption (film seconds, song beats): the middle of each caption's life
const CHECK = [0.6, ft(193.6), ft(198.6), ft(202.6), ft(206.6), ft(212), ft(218), ft(222.5), ft(226.6), ft(230.5), ft(234.5), ft(241.5), ft(249), ft(255), ft(259)];
const PHONE = [0.02, 1.2, 2.2, ft(192.3), ft(193.5)];
for (const lang of langs) {
  const film = path.join(OUT, `aurora-x-${lang}.mp4`);
  if (!fs.existsSync(film)) { console.log(`skip ${lang}: no ${film}`); continue; }
  await run('ffmpeg', ['-v', 'error', '-y', '-i', film, '-frames:v', '1', path.join(OUT, `poster-${lang}.png`)]);
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', ft(193.6).toFixed(3), '-i', film, '-frames:v', '1', path.join(OUT, `poster-drop-${lang}.png`)]);
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', ft(201.9).toFixed(3), '-i', film, '-frames:v', '1', path.join(OUT, `poster-proof-${lang}.png`)]);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', film, '-vf', 'fps=1,scale=480:-1:flags=lanczos,tile=6x7:padding=4:color=0x07080d', '-frames:v', '1', path.join(OUT, `contact-${lang}.png`)]);
  // 600-px legibility sheet: X's desktop timeline plays the video about 600 px wide (phones: ~390 px)
  const tmp = fs.mkdtempSync(path.join(OUT, '.chk-'));
  for (let i = 0; i < CHECK.length; i++) {
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', CHECK[i].toFixed(3), '-i', film, '-frames:v', '1', '-vf', 'scale=600:-1:flags=area', path.join(tmp, `${String(i).padStart(2, '0')}.png`)]);
  }
  await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, '%02d.png'), '-vf', 'tile=3x5:padding=6:color=0x202020', path.join(OUT, `check600-${lang}.png`)]);
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f));
  // phone feed width: the hook (0–2.3 s) and the drop at 390 px
  for (let i = 0; i < PHONE.length; i++) {
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', PHONE[i].toFixed(3), '-i', film, '-frames:v', '1', '-vf', 'scale=390:-1:flags=area', path.join(tmp, `${String(i).padStart(2, '0')}.png`)]);
  }
  await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, '%02d.png'), '-vf', `tile=${PHONE.length}x1:padding=6:color=0x202020`, path.join(OUT, `check390-${lang}.png`)]);
  fs.rmSync(tmp, { recursive: true, force: true });
  // a light 720p copy for phones / chat previews (same cut, same audio)
  fs.mkdirSync(path.join(OUT, 'preview'), { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-y', '-i', film, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', 'copy', '-movflags', '+faststart', path.join(OUT, 'preview', `aurora-x-${lang}-720p.mp4`)]);
  // specs
  const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', film])).out);
  const r128 = (await run('ffmpeg', ['-hide_banner', '-nostats', '-i', film, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-'])).err;
  const num = re => { const m = r128.match(re); return m ? +m[1] : null; };
  const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
  const specs = {
    file: path.relative(ROOT, film), bytes: +probe.format.size, seconds: +(+probe.format.duration).toFixed(3), bitrateKbps: Math.round(probe.format.bit_rate / 1000),
    video: { codec: v.codec_name, profile: v.profile, level: v.level, width: v.width, height: v.height, fps: v.r_frame_rate, pix_fmt: v.pix_fmt, frames: +v.nb_frames, color: [v.color_primaries, v.color_transfer, v.color_space, v.color_range].join('/'), kbps: Math.round(v.bit_rate / 1000) },
    audio: { codec: a.codec_name, profile: a.profile, sampleRate: +a.sample_rate, channels: a.channels, kbps: Math.round(a.bit_rate / 1000) },
    loudness: { integratedLufs: num(/Integrated loudness:\s*I:\s*(-?[\d.]+)/), lra: num(/Loudness range:\s*LRA:\s*(-?[\d.]+)/), truePeakDbtp: num(/True peak:\s*Peak:\s*(-?[\d.]+)/) },
    faststart: null,
  };
  // +faststart: the moov atom precedes mdat
  const head = fs.readFileSync(film).subarray(0, 1 << 16).toString('latin1');
  specs.faststart = head.indexOf('moov') >= 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat'));
  fs.writeFileSync(path.join(OUT, `specs-${lang}.json`), JSON.stringify(specs, null, 2));
  console.log(JSON.stringify(specs));
}
fs.copyFileSync(path.join(ROOT, 'docs/video/POST.md'), path.join(OUT, 'POST.md'));
console.log('done');
