#!/usr/bin/env node
// Headless-Chrome bench for the overlay layer (zero dependencies: Chrome DevTools Protocol over WebSocket).
//
//   node tools/video/overlays/verify.mjs fonts                                   which web fonts really loaded
//   node tools/video/overlays/verify.mjs shots  --scene swarm --at 800,2700,4800 freeze-frame PNGs at exact scene times
//   node tools/video/overlays/verify.mjs perf   [--scenes hook,swarm] [--bg app]  per-frame cost + frame pacing per scene
//   node tools/video/overlays/verify.mjs render [--scene film] [--fps 60]         deterministic frame-stepped MP4 of a preview scene
//
// Common flags: --lang en|zh  --bg shot|app|gradient|none  --port 9968  --url http://localhost:5173  --out <path>
// Output goes to renders/video/ (gitignored). Needs the dev server (node tools/serve.mjs) and Google Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'shots';
const opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; opt[k] = v; }
const lang = opt.lang || 'en', bg = opt.bg || 'shot', base = (opt.url || 'http://localhost:5173').replace(/\/$/, '');
const port = +(opt.port || 9968);
const CHROME = opt.chrome || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function launch(w = 1920, h = 1080) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-ovl-${port}-`));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required', `--window-size=${w},${h}`, 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { proc.kill(); } catch {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
  process.on('exit', kill); for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { kill(); process.exit(130); });
  let ws;
  for (let i = 0; i < 120 && !ws; i++) {
    try { const pg = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl); } catch {}
    if (!ws) await new Promise(r => setTimeout(r, 150));
  }
  if (!ws) { kill(); throw new Error(`Chrome did not start on port ${port}`); }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const on = []; const logs = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const { res, rej } = pend.get(d.id); pend.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } else on.forEach(f => f(d)); };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  on.push(d => {
    if (d.method === 'Runtime.consoleAPICalled' && /warn|error/.test(d.params.type)) logs.push(`${d.params.type}: ${d.params.args.map(a => a.value ?? a.description).join(' ')}`);
    if (d.method === 'Runtime.exceptionThrown') logs.push(`EXC: ${d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text}`);
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const api = {
    send, logs,
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    async goto(url) { const p = new Promise(r => on.push(d => d.method === 'Page.loadEventFired' && r())); await send('Page.navigate', { url }); await p; },
    async shot(format = 'png', quality) { const r = await send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}) }); return Buffer.from(r.data, 'base64'); },
    wait: ms => new Promise(r => setTimeout(r, ms)),
    async close() { try { await send('Browser.close'); } catch {} kill(); },
  };
  return api;
}

async function openPreview(c) {
  await c.goto(`${base}/tools/video/overlays/preview.html?clean=1&bg=${bg}&lang=${lang}`);
  for (let i = 0; i < 150; i++) { if (await c.eval(`document.documentElement.dataset.ready === '1'`)) return; await c.wait(100); }
  throw new Error('preview did not become ready (dev server running? see README)');
}

const outDir = p => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };

async function main() {
  const c = await launch();
  try {
    await openPreview(c);
    if (mode === 'fonts') {
      console.log(JSON.stringify(await c.eval('ov.fontReport()'), null, 2));
      console.log('webgl:', await c.eval('ov.backdrop.renderer || "fallback"'));
    } else if (mode === 'shots') {
      // freeze-frame screenshots at exact scene times (the overlay clock and all animations hold while capturing)
      const scene = opt.scene || 'hook';
      const at = String(opt.at || '300,900,2000').split(',').map(Number);
      const dir = opt.out || path.join(ROOT, 'renders/video/overlay-check');
      await c.eval(`ov.freeze(); window.__done = false; window.scene(${JSON.stringify(scene)}).then(() => window.__done = true); 1`);
      let t = 0;
      for (const target of at) {
        while (t + 1000 / 60 <= target) { await c.eval('ov.step(1000 / 60)'); t += 1000 / 60; }
        const f = outDir(path.join(dir, `${scene}-${lang}-${String(target).padStart(5, '0')}.png`));
        fs.writeFileSync(f, await c.shot('png')); console.log(f);
      }
    } else if (mode === 'perf') {
      await c.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      if (bg === 'app') await c.wait(3000);
      const rows = [];
      for (const sc of String(opt.scenes || 'hook,captions,cursor,counter,stats,swarm,end').split(',')) {
        await c.eval(`window.__dts = []; window.__stop = false; (() => { let l = performance.now(); const f = t => { window.__dts.push(t - l); l = t; if (!window.__stop) requestAnimationFrame(f); }; requestAnimationFrame(f); })(); ov.perfReset(); 1`);
        const m0 = await metrics();
        await c.eval(`window.scene(${JSON.stringify(sc)})`);
        const m1 = await metrics();
        const r = await c.eval(`(() => { window.__stop = true; const d = window.__dts.slice(2).sort((a, b) => a - b); const n = d.length; const p = ov.perf(); return { n, avg: d.reduce((a, b) => a + b, 0) / n, p95: d[Math.floor(n * .95)], max: d[n - 1], slow: d.filter(x => x > 25).length, ov: p }; })()`);
        const per = k => +(((m1[k] - m0[k]) * 1000) / (r.n || 1)).toFixed(2);
        rows.push({ scene: sc, frames: r.n, fps: +(1000 / r.avg).toFixed(1), 'frame p95 ms': +r.p95.toFixed(1), 'frame max ms': +r.max.toFixed(1), 'frames >25ms': r.slow,
          'overlay js p95 ms': +r.ov.p95.toFixed(2), 'overlay js max ms': +r.ov.max.toFixed(2), 'main thread ms/frame': per('TaskDuration'), 'script ms/frame': per('ScriptDuration'), 'style+layout ms/frame': +(per('RecalcStyleDuration') + per('LayoutDuration')).toFixed(2) });
        await c.eval('ov.clear({ ms: 100 })'); await c.wait(300);
      }
      console.table(rows);
      console.log('webgl:', await c.eval('ov.backdrop.renderer || "fallback"'));
    } else if (mode === 'render') {
      // deterministic: every frame advances the overlay by exactly 1/fps, whatever the capture speed
      const scene = opt.scene || 'film', fps = +(opt.fps || 60), maxS = +(opt.seconds || 90);
      const out = outDir(opt.out || path.join(ROOT, `renders/video/overlay-preview-${scene}-${lang}.mp4`));
      const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
      await c.eval(`ov.freeze(); window.__done = false; window.scene(${JSON.stringify(scene)}).then(() => window.__done = true); 1`);
      let n = 0, tail = Math.round(fps * (opt.tail != null ? +opt.tail : .5));
      const t0 = Date.now();
      while (n < maxS * fps) {
        await c.eval(`ov.step(${1000 / fps})`);
        const jpg = await c.shot('jpeg', 94);
        if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
        n++;
        if (n % (fps * 5) === 0) process.stdout.write(`  ${n / fps}s rendered (${((Date.now() - t0) / 1000).toFixed(0)}s wall)\n`);
        if (await c.eval('window.__done') && --tail <= 0) break;
      }
      ff.stdin.end(); await new Promise(r => ff.on('close', r));
      console.log(`${out}  (${n} frames, ${(n / fps).toFixed(2)} s @ ${fps} fps)`);
    } else throw new Error('unknown mode ' + mode);
    if (c.logs.length) console.log(c.logs.slice(0, 20).join('\n'));
  } finally { await c.close(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
