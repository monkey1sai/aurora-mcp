#!/usr/bin/env node
// Assets for the X film (tools/video/timelines): the music bed and a large spectrogram of the song it comes from.
//
//   node tools/video/make-assets.mjs            → renders/video/assets/
//     neon-nights.wav                 the whole song, rendered offline by the app's own engine (tools/render-song.mjs)
//     bed-neon-b184-264.wav           the film's soundtrack: song beats 184 → 264 (46.154 s), 24-bit, 8 ms / 60 ms fades
//     neon-nights-spectrogram-2400.png  2400×1000 spectrogram of the song (same renderer as renders/songs/*, bigger)
//     spectrogram.json                where the time axis sits in that image (for the playhead)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'renders/video/assets');
fs.mkdirSync(OUT, { recursive: true });
const { decodeWav } = await import(pathToFileURL(path.join(ROOT, 'tools/wav.mjs')).href);
const { spectrogram } = await import(pathToFileURL(path.join(ROOT, 'tools/analyze.mjs')).href);
const { SONGS } = await import(pathToFileURL(path.join(ROOT, 'src/demo/songs/index.js')).href);

const song = SONGS.find(s => s.id === 'neon-nights');
const tmp = path.join(OUT, 'songs');
const wav = path.join(tmp, 'neon-nights', 'neon-nights.wav');
if (!fs.existsSync(wav) || process.argv.includes('--force')) {
  execFileSync(process.execPath, [path.join(ROOT, 'tools/render-song.mjs'), '--song', 'neon-nights', '--bits', '24', '--out', tmp, '--no-png'], { stdio: 'inherit' });
}
fs.copyFileSync(wav, path.join(OUT, 'neon-nights.wav'));

// ── the bed: beats 184 → 264 at 104 BPM, 48 kHz ──
const SR = 48000, BPM = 104;
const s0 = Math.round(184 * 60 / BPM * SR), s1 = Math.round(264 * 60 / BPM * SR);
const len = (s1 - s0) / SR;
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-af',
  `atrim=start_sample=${s0}:end_sample=${s1},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.008,afade=t=out:st=${(len - 0.06).toFixed(4)}:d=0.06`,
  '-c:a', 'pcm_s24le', path.join(OUT, 'bed-neon-b184-264.wav')]);
console.log(`bed: samples ${s0} → ${s1} (${len.toFixed(4)} s)`);

// ── spectrogram 2400×1000 (tools/analyze.mjs, the renderer behind every image in /renders/) ──
const { channels, sampleRate } = decodeWav(fs.readFileSync(wav));
const [L, R] = channels;
const W = 2400, H = 1000;
const dur = Math.min(L.length, R.length) / sampleRate;
const spb = 60 / BPM;
const markers = (song.sections || []).map(s => ({ t: s.beat * spb, label: s.name }));
markers.push({ t: song.lengthBeats * spb, label: 'end', color: '#ff6b81' });
const png = spectrogram(L, R, sampleRate, { width: W, height: H, title: song.title, subtitle: `${BPM} BPM · ${song.parts.length} parts`, right: '48.0 kHz · rendered by AURORA\'s own engine', markers });
fs.writeFileSync(path.join(OUT, 'neon-nights-spectrogram-2400.png'), png);
// time axis (tools/analyze.mjs spectrogramRaster: margins l 58, r 70, t 30, b 30)
const meta = { width: W, height: H, x0: 58, x1: W - 70, y0: 30, y1: H - 30, duration: dur, bpm: BPM };
fs.writeFileSync(path.join(OUT, 'spectrogram.json'), JSON.stringify(meta, null, 2));
console.log('spectrogram', meta);

// ── the /renders/ gallery as one tall still (1920 × 5200): scrolled on camera as a single composited layer ──
// (a live 4600-px iframe under a moving transform rasterised at ~15 fps; the still is the same page, pixel for pixel)
{
  const { launchChrome } = await import(pathToFileURL(path.join(ROOT, 'tools/video/capture/chrome.mjs')).href);
  const net = await import('node:net');
  const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
  let port = 9900 + Math.floor(Math.random() * 100);
  while (!(await free(port))) port = 9900 + Math.floor(Math.random() * 100);
  const GH = 5200;
  const chrome = await launchChrome({ port, w: 1920, h: GH });
  try {
    await chrome.goto((process.env.AURORA_URL || 'http://localhost:5173') + '/renders/index.html');
    const n = await chrome.eval(`(async () => {
      document.documentElement.style.overflow = 'hidden';
      const imgs = [...document.images]; imgs.forEach(i => { i.loading = 'eager'; });
      await Promise.all(imgs.filter(i => i.getBoundingClientRect().top < ${GH}).map(i => i.complete ? 0 : new Promise(r => { i.onload = r; i.onerror = r; })));
      await Promise.all(imgs.map(i => i.decode ? i.decode().catch(() => 0) : 0));
      await new Promise(r => setTimeout(r, 400));
      return imgs.length;
    })()`, { timeoutMs: 60000 });
    const r = await chrome.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1920, height: GH, scale: 1 } });
    fs.writeFileSync(path.join(OUT, 'renders-gallery-tall.jpg'), Buffer.from(r.data, 'base64'));
    console.log(`gallery: ${n} images → renders-gallery-tall.jpg (1920×${GH})`);
  } finally { await chrome.close(); }
}
