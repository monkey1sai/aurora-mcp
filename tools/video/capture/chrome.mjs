// Headless Chrome launcher + minimal Chrome DevTools Protocol client for the video capture pipeline.
// Zero dependencies (Node ≥ 22: global WebSocket + fetch).
//
//   const chrome = await launchChrome({ port: 9931, w: 1920, h: 1080 });
//   await chrome.goto('http://localhost:5173/tools/video/director.html');
//   const v = await chrome.eval('1 + 1');
//   await chrome.close();            // always — kills the process and removes the temporary profile
//
// Every run gets its own debugging port and its own throw-away profile directory (copied from an optional
// base profile), so several recordings can run side by side without colliding.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Flags for real-time capture of a page that plays Web Audio:
 *  - headless=new is the full browser (tab capture, GPU compositing, real AudioContext clock)
 *  - --auto-accept-this-tab-capture: getDisplayMedia({ preferCurrentTab: true }) resolves without a picker
 *  - --use-fake-ui-for-media-stream: no permission prompts for media streams
 *  - --autoplay-policy=no-user-gesture-required: AudioContext may start without a gesture
 *  - background / occlusion throttling off: timers and rAF keep full rate in a headless, never-focused window
 *  - --mute-audio: nothing comes out of the speakers of the machine (the app's audio is tapped in-page)
 */
export function captureFlags({ w = 1920, h = 1080, mute = true, gpu = true } = {}) {
  return [
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-component-update', '--disable-default-apps', '--disable-popup-blocking', '--disable-translate',
    '--hide-scrollbars', '--force-color-profile=srgb', '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    '--auto-accept-this-tab-capture', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-background-media-suspend',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,MediaSessionService,Translate,OptimizationHints,AutofillServerCommunication',
    ...(gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy'] : ['--disable-gpu']),
    ...(mute ? ['--mute-audio'] : []),
  ];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Launch headless Chrome and attach to its first page.
 * @param {{ port?: number, w?: number, h?: number, dpr?: number, flags?: string[], mute?: boolean, gpu?: boolean,
 *           baseProfile?: string, keepProfile?: boolean, log?: (s:string)=>void }} opts
 */
export async function launchChrome(opts = {}) {
  const { port = 9900 + Math.floor(Math.random() * 100), w = 1920, h = 1080, dpr = 1, mute = true, gpu = true,
    baseProfile = null, keepProfile = false, log = () => {} } = opts;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-video-${port}-`));
  if (baseProfile && fs.existsSync(baseProfile)) {
    try { fs.cpSync(baseProfile, prof, { recursive: true, filter: src => !/Singleton|lockfile|\.lock$/i.test(src) }); } catch (e) { log(`profile copy failed: ${e.message}`); }
  }
  const args = [...captureFlags({ w, h, mute, gpu }), ...(opts.flags || []), `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'];
  const proc = spawn(CHROME_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  let ws = null;
  for (let i = 0; i < 200 && !ws; i++) {
    if (exited) break;
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pg = list.find(t => t.type === 'page');
      if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!ws) await sleep(100);
  }
  if (!ws) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (!keepProfile) { try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ } }
    throw new Error(`Chrome did not start on port ${port}\n${stderr.slice(-2000)}`);
  }
  ws.binaryType = 'arraybuffer';
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('CDP websocket error ' + (e && e.message))); });

  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
    if (d.id && pending.has(d.id)) {
      const { res, rej, method } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) rej(new Error(`${method}: ${d.error.message}${d.error.data ? ' ' + d.error.data : ''}`)); else res(d.result);
    } else if (d.method) {
      for (const l of listeners) { try { l(d); } catch (e) { log(`listener error ${e.message}`); } }
    }
  };
  ws.onclose = () => { for (const { rej, method } of pending.values()) rej(new Error(`${method}: CDP connection closed`)); pending.clear(); };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const once = (method, pred = () => true, timeoutMs = 30000) => new Promise((res, rej) => {
    const t = setTimeout(() => { off(); rej(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
    const off = on((d) => { if (d.method === method && pred(d.params)) { clearTimeout(t); off(); res(d.params); } });
  });

  // default execution context of every frame (frameId → contextId), tracked from the start (evaluate in an iframe)
  const contexts = new Map();
  on((d) => {
    if (d.method === 'Runtime.executionContextCreated') {
      const c = d.params.context;
      if (c.auxData && c.auxData.isDefault) contexts.set(c.auxData.frameId, c.id);
    } else if (d.method === 'Runtime.executionContextDestroyed') {
      for (const [f, id] of contexts) if (id === d.params.executionContextId) contexts.delete(f);
    } else if (d.method === 'Runtime.executionContextsCleared') contexts.clear();
  });
  const logs = [];
  on((d) => {
    let line = null;
    if (d.method === 'Runtime.consoleAPICalled') line = `${d.params.type}: ${d.params.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`;
    else if (d.method === 'Runtime.exceptionThrown') line = `EXC: ${d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text}`;
    else if (d.method === 'Log.entryAdded') line = `LOG ${d.params.entry.level}: ${d.params.entry.text} ${d.params.entry.url || ''}`;
    if (line) { logs.push(line); if (logs.length > 2000) logs.shift(); log(line); }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  // headless windows are never "focused": make the page believe it is (focus-dependent UI, rAF, media)
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* older Chrome */ }

  const api = {
    port, proc, send, on, once, logs, contexts, profileDir: prof,
    async goto(url, { timeoutMs = 30000 } = {}) {
      const p = once('Page.loadEventFired', () => true, timeoutMs);
      const r = await send('Page.navigate', { url });
      if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
      await p;
    },
    /** Evaluate an expression (string) in the top page; awaits promises; returns by value. */
    async eval(expr, { userGesture = true, timeoutMs } = {}) {
      const params = { expression: expr, awaitPromise: true, returnByValue: true, userGesture };
      if (timeoutMs) params.timeout = timeoutMs;
      const r = await send('Runtime.evaluate', params);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async screenshot(file, { format = 'png', quality } = {}) {
      const r = await send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}) });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    stderr: () => stderr,
    async close() {
      try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      if (!exited) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
      if (!keepProfile) { try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ } }
    },
  };
  return api;
}
