#!/usr/bin/env node
// Transparent 1920×1080 PNG stills of overlay captions, for shots the edit composites itself (the 2×2 engine grid:
// its four quadrants are scaled-down takes, so the caption over them cannot be filmed inside a take).
// Same overlay module, fonts and styles as the live takes — rendered in headless Chrome, frozen after the intro.
//
//   node tools/video/make-label.mjs            → renders/video/assets/label-engines-en.png, label-engines-zh.png
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { launchChrome } = await import(pathToFileURL(path.join(ROOT, 'tools/video/capture/chrome.mjs')).href);
const { TEXT } = await import(pathToFileURL(path.join(ROOT, 'tools/video/timelines/lib.mjs')).href);
const SERVER = process.env.AURORA_URL || 'http://localhost:5173';
const OUT = path.join(ROOT, 'renders/video/assets');
const LABELS = { engines: { text: TEXT.engines, opts: { position: 'center', style: 'label', ms: 0, stagger: 0 } } };

const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let port = 9900 + Math.floor(Math.random() * 100);
while (!(await free(port))) port = 9900 + Math.floor(Math.random() * 100);
const chrome = await launchChrome({ port, w: 1920, h: 1080 });
try {
  for (const lang of ['en', 'zh']) {
    await chrome.goto(`${SERVER}/tools/video/overlays/preview.html?clean=1&bg=none&lang=${lang}`);
    await chrome.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const [name, L] of Object.entries(LABELS)) {
      const ok = await chrome.eval(`(async () => {
        const st = document.createElement('style');
        st.textContent = 'html, body, #wrap, #stage, #bg { background: transparent !important; }';
        document.head.append(st);
        await window.ov.ready;
        await window.ov.clear({ ms: 0 });
        await window.ov.preload([${JSON.stringify(L.text[lang])}]);
        window.ov.caption(${JSON.stringify(L.text)}, ${JSON.stringify({ ...L.opts, persist: true })});
        await new Promise(r => setTimeout(r, 2600));
        window.ov.freeze();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      })()`, { timeoutMs: 30000 });
      const r = await chrome.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
      const file = path.join(OUT, `label-${name}-${lang}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(ok, path.relative(ROOT, file));
    }
  }
} finally { await chrome.close(); }
