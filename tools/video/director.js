// AURORA video director — the page the recorder films (tools/video/record.mjs). Reference: tools/video/README.md.
//
//   /tools/video/director.html?lang=en|zh&overlay=./overlays/overlay.js|none&autostart=1|0&cursor=overlay|builtin|none&tc=1
//
// A fixed 1920×1080 stage: the live app in an <iframe> (/index.html?video=1) inside a "camera" wrapper that is
// CSS-transformed for zooms / pans, and an overlay root above it for motion graphics (tools/video/overlays).
// tc=1 (the recorder) adds an 8-px timecode strip below the stage: every rendered frame carries its page time.
//
// window.director = {
//   lang, stage, camera, iframe, overlayRoot, overlay,       // overlay = createOverlay(root, { lang, director }) or null
//   app, appDoc, aurora,                                      // iframe window / document / window.__aurora
//   ready, state,                                             // Promise: app booted, audio running, fonts + overlay loaded
//   audioClock(), waitAudio(t), wallNow(), waitWall(ms),      // app AudioContext seconds / page clock ms
//   cam: { zoomTo(target, scale?, ms?, ease?, opts?), to({s,x,y}, ms?, ease?), reset(ms?, ease?), set({s,x,y}), get(), frameFor(), stop() },
//   toStage(x, y), rectToStage(rect), selectorRect(sel),      // app coordinates → stage coordinates (camera applied)
//   pointer(x, y, type), cursorMode, cursor,                  // cursor notifications (overlay.onPointer / built-in arrow)
//   tap: { install(), start(), stop(), mark(id), read(offset, count), free() },   // lossless audio tap (recorder)
//   clockMarks: { start(ms), stop() }, probe: { start(), stop() },               // sync marks, frame-time probe
//   syncPulse(id, ms), noteFlash(on, ms), prewarmFonts(text), focusApp(), log(...), logs
// }

const params = new URLSearchParams(location.search);
const LANG = params.get('lang') === 'zh' ? 'zh' : 'en';
const OVERLAY_SPEC = params.has('overlay') ? params.get('overlay') : './overlays/overlay.js';
const AUTOSTART = params.get('autostart') !== '0';
const CURSOR_MODE = params.get('cursor') || 'overlay'; // overlay | builtin | none
const TC = params.get('tc') === '1'; // recorder: per-frame timecode strip below the stage
const W = 1920, H = 1080;

const $ = s => document.querySelector(s);
const stage = $('#stage'), camera = $('#camera'), iframe = $('#app'), overlayRoot = $('#overlay-root');
const syncEl = $('#sync'), noteFlashEl = $('#noteflash'), dcursor = $('#dcursor');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wallNow = () => performance.timeOrigin + performance.now();
const logs = [];
const log = (...a) => { const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logs.push(s); console.log('[director]', s); };

/* ── preview in an ordinary window: scale the stage to fit (the recorder's viewport is exactly 1920×1080) ── */
function fitStage() {
  if (TC) { stage.style.transform = ''; return; } // the recorder's viewport: 1920 × (1080 + strip)
  const s = Math.min(innerWidth / W, innerHeight / H);
  stage.style.transform = Math.abs(s - 1) < 1e-3 ? '' : `translate(${(innerWidth - W * s) / 2}px, ${(innerHeight - H * s) / 2}px) scale(${s})`;
}
addEventListener('resize', fitStage);
fitStage();
// belt and braces: nothing may scroll the director page or the stage (scrollIntoView() in the app propagates up)
const pinScroll = () => { if (stage.scrollTop || stage.scrollLeft) { stage.scrollTop = 0; stage.scrollLeft = 0; } if (scrollX || scrollY) scrollTo(0, 0); };
stage.addEventListener('scroll', pinScroll, { passive: true });
addEventListener('scroll', pinScroll, { passive: true });

/* ── the app: language via its own storage key (read by src/ui/app/i18n.js at load), video mode via ?video=1 ── */
try { localStorage.setItem('aurora.lang', LANG); } catch { /* ignore */ }
iframe.src = `../../index.html?video=1&lang=${LANG}`;

/* ── easing: named curves → CSS timing functions (the camera runs as a compositor animation) ── */
const BEZIER = {
  linear: 'linear',
  inOutCubic: 'cubic-bezier(0.65, 0, 0.35, 1)',
  outCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
  inCubic: 'cubic-bezier(0.32, 0, 0.67, 0)',
  inOutSine: 'cubic-bezier(0.37, 0, 0.63, 1)',
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  outExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  inOutExpo: 'cubic-bezier(0.87, 0, 0.13, 1)',
  inOutQuart: 'cubic-bezier(0.76, 0, 0.24, 1)',
  outBack: 'cubic-bezier(0.34, 1.36, 0.64, 1)',
};
const cssEase = e => (typeof e === 'string' && /^(cubic-bezier|steps|linear)/.test(e) ? e : BEZIER[e] || BEZIER.inOutCubic);

/* ── camera: stage = app · s + (x, y)   (transform-origin 0 0) ──
   Moves run as Web Animations on the wrapper's transform: they are composited (smooth even while the app's main
   thread is busy) and Chrome rasterises the iframe at the animation's largest scale, so text stays crisp. */
const cam = (() => {
  let st = { s: 1, x: 0, y: 0 }; // target / resting state
  let anim = null;
  const tf = c => (c.s === 1 && c.x === 0 && c.y === 0 ? 'none' : `translate(${c.x.toFixed(3)}px, ${c.y.toFixed(3)}px) scale(${c.s.toFixed(5)})`);
  const apply = () => { camera.style.transform = tf(st) === 'none' ? '' : tf(st); };
  /** clamp so the scaled app always covers the stage (no black edges) unless opts.free */
  const clampSt = (s, x, y) => ({ s, x: Math.min(0, Math.max(W - W * s, x)), y: Math.min(0, Math.max(H - H * s, y)) });
  function resolveRect(target) {
    if (target == null) return { x: 0, y: 0, w: W, h: H };
    if (typeof target === 'string') {
      const el = appDoc() && appDoc().querySelector(target);
      if (!el) throw new Error(`camera: no element ${target}`);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    if (Array.isArray(target)) return { x: target[0], y: target[1], w: target[2] || 0, h: target[3] || 0 };
    return { x: target.x ?? target.left ?? 0, y: target.y ?? target.top ?? 0, w: target.w ?? target.width ?? 0, h: target.h ?? target.height ?? 0 };
  }
  /** state that frames `rect` (app coordinates) at `scale` (default: fit with margin), centred */
  function frameFor(target, scale, opts = {}) {
    const r = resolveRect(target);
    const margin = opts.margin ?? 0.08;
    let s = scale;
    if (!s) s = r.w && r.h ? Math.min(W / (r.w * (1 + 2 * margin)), H / (r.h * (1 + 2 * margin))) : 1;
    s = Math.max(opts.free ? 0.1 : 1, Math.min(8, s));
    const cx = r.x + r.w / 2 + (opts.dx || 0), cy = r.y + r.h / 2 + (opts.dy || 0);
    const ax = opts.anchorX ?? 0.5, ay = opts.anchorY ?? 0.5; // where the target centre lands on the stage (0..1)
    const x = W * ax - cx * s, y = H * ay - cy * s;
    return opts.free ? { s, x, y } : clampSt(s, x, y);
  }
  /** the transform actually on screen (mid-animation too) */
  function current() {
    const t = getComputedStyle(camera).transform;
    if (!t || t === 'none') return { s: 1, x: 0, y: 0 };
    const m = new DOMMatrixReadOnly(t);
    return { s: m.a, x: m.e, y: m.f };
  }
  function tweenTo(to, ms = 900, ease = 'inOutCubic') {
    const from = current();
    if (anim) { try { anim.cancel(); } catch { /* ignore */ } anim = null; }
    st = { ...to };
    if (!ms || ms <= 0) { apply(); return Promise.resolve(get()); }
    camera.style.transform = tf(from) === 'none' ? '' : tf(from);
    const a = camera.animate([{ transform: tf(from) === 'none' ? 'translate(0px, 0px) scale(1)' : tf(from) }, { transform: tf(to) === 'none' ? 'translate(0px, 0px) scale(1)' : tf(to) }],
      { duration: ms, easing: cssEase(ease), fill: 'forwards' });
    anim = a;
    return a.finished.then(() => {
      if (anim !== a) return get();
      apply();
      a.cancel();
      anim = null;
      return get();
    }, () => get());
  }
  const get = () => current();
  return {
    get, frameFor, current,
    set(s) { if (anim) { anim.cancel(); anim = null; } const c = current(); st = { s: s.s ?? c.s, x: s.x ?? c.x, y: s.y ?? c.y }; apply(); return get(); },
    /** zoomTo(selector | {x,y,w,h} | [x,y,w,h] in app coords, scale?, ms?, ease?, { margin, anchorX, anchorY, dx, dy, free }) */
    zoomTo(target, scale, ms = 900, ease = 'inOutCubic', opts = {}) { return tweenTo(frameFor(target, scale, opts), ms, ease); },
    /** pan/zoom to an explicit state { s, x, y } */
    to(state, ms = 900, ease = 'inOutCubic') { const c = current(); return tweenTo({ s: state.s ?? c.s, x: state.x ?? c.x, y: state.y ?? c.y }, ms, ease); },
    reset(ms = 900, ease = 'inOutCubic') { return tweenTo({ s: 1, x: 0, y: 0 }, ms, ease); },
    stop() { if (anim) { const c = current(); anim.cancel(); anim = null; st = c; apply(); } },
  };
})();

const toStage = (x, y) => { const c = cam.get(); return { x: x * c.s + c.x, y: y * c.s + c.y }; };
const rectToStage = r => { const c = cam.get(); return { x: r.x * c.s + c.x, y: r.y * c.s + c.y, w: r.w * c.s, h: r.h * c.s }; };
const appDoc = () => { try { return iframe.contentDocument; } catch { return null; } };
const appWin = () => iframe.contentWindow;

/** App element → { app: rect, stage: rect, cx, cy (stage centre) } or null. opts.scroll: scroll into view first. */
function selectorRect(sel, { scroll = false } = {}) {
  const d = appDoc();
  const el = d && d.querySelector(sel);
  if (!el) return null;
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const app = { x: r.x, y: r.y, w: r.width, h: r.height };
  const s = rectToStage(app);
  return { app, stage: s, cx: s.x + s.w / 2, cy: s.y + s.h / 2, visible: r.width > 0 && r.height > 0 };
}

/* ── overlay module (optional) ── */
let overlay = null;
async function loadOverlay() {
  if (!OVERLAY_SPEC || OVERLAY_SPEC === 'none') return null;
  try {
    const url = new URL(OVERLAY_SPEC, location.href);
    if (url.origin !== location.origin) { log('overlay must be same-origin; ignored', url.href); return null; }
    const mod = await import(url.href);
    const create = mod.createOverlay || mod.default;
    if (typeof create !== 'function') { log('overlay module has no createOverlay export'); return null; }
    const ov = await create(overlayRoot, { lang: LANG, director: api });
    if (ov && ov.ready && typeof ov.ready.then === 'function') await Promise.race([ov.ready, sleep(8000)]);
    log('overlay loaded', OVERLAY_SPEC);
    return ov;
  } catch (e) {
    log('overlay not loaded:', String(e && e.message ? e.message : e));
    return null;
  }
}

/* ── cursor: notify the overlay (or draw the built-in arrow) ── */
let cursorMode = CURSOR_MODE;
const cursorState = { x: W * 0.62, y: H * 0.72, shown: false };
function pointer(x, y, type = 'move') {
  cursorState.x = x; cursorState.y = y;
  window.dispatchEvent(new CustomEvent('director:pointer', { detail: { x, y, type } }));
  if (overlay && typeof overlay.onPointer === 'function') { try { overlay.onPointer({ x, y, type }); } catch (e) { console.error(e); } }
  const useBuiltin = cursorMode === 'builtin' || (cursorMode === 'overlay' && !(overlay && overlay.cursor));
  if (useBuiltin && cursorMode !== 'none') {
    dcursor.style.transform = `translate(${x}px, ${y}px)`;
    if (type === 'hide') dcursor.classList.remove('is-on');
    else dcursor.classList.add('is-on');
    dcursor.classList.toggle('is-down', type === 'down' || type === 'drag');
  }
}

/* ── lossless audio tap (see tools/video/capture/tap-worklet.js) ── */
const tap = (() => {
  let node = null, ctx = null, chunks = [], marks = [], started = null, stopped = null, merged = null, info = null;
  let markWaiters = [], recording = false, installing = false;
  return {
    get node() { return node; },
    get marks() { return marks.slice(); },
    async install() {
      if (node) return true;
      const A = appWin().__aurora;
      ctx = A.ctx;
      if (!ctx) throw new Error('tap: audio engine not started');
      await ctx.audioWorklet.addModule(new URL('./capture/tap-worklet.js', location.href).href);
      // construct in the app's realm (the context lives there); 1 silent output to the destination keeps it pulled
      node = new (appWin().AudioWorkletNode)(ctx, 'aurora-video-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      A.master.connect(node);
      node.connect(ctx.destination);
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'data') chunks.push(m);
        else if (m.type === 'mark') { marks.push({ id: m.id, frame: m.frame }); for (const w of markWaiters) w(m); }
        else if (m.type === 'started') started = m;
        else if (m.type === 'stopped') stopped = m;
      };
      return true;
    },
    async start() {
      chunks = []; marks = []; started = null; stopped = null; merged = null; info = null;
      recording = true;
      if (!node) {
        // ?autostart=0: the splash is still up — install and start the tap the moment the app's engine exists
        const poll = setInterval(async () => {
          const A = appWin() && appWin().__aurora;
          if (!recording) { clearInterval(poll); return; }
          if (A && A.ctx && A.master && !installing) {
            clearInterval(poll);
            installing = true;
            try { await this.install(); node.port.postMessage({ type: 'start' }); } catch (e) { log('late tap install failed', String(e)); }
          }
        }, 5);
        return { sampleRate: null, pending: true };
      }
      node.port.postMessage({ type: 'start' });
      for (let i = 0; i < 200 && !started; i++) await sleep(5);
      return { sampleRate: ctx.sampleRate, startFrame: started ? started.frame : null };
    },
    mark(id) { if (node) node.port.postMessage({ type: 'mark', id }); },
    waitMark(id, ms = 2000) {
      const hit = marks.find(m => m.id === id);
      if (hit) return Promise.resolve(hit);
      return new Promise((res) => {
        const t = setTimeout(() => { markWaiters = markWaiters.filter(w => w !== fn); res(null); }, ms);
        const fn = (m) => { if (m.id === id) { clearTimeout(t); markWaiters = markWaiters.filter(w => w !== fn); res(m); } };
        markWaiters.push(fn);
      });
    },
    async stop() {
      recording = false;
      if (!node) { merged = new Float32Array(0); info = { sampleRate: 48000, firstFrame: 0, frames: 0, capturedFrames: 0, gapFrames: 0, overlaps: 0, bytes: 0, marks: [] }; return info; }
      node.port.postMessage({ type: 'stop' });
      for (let i = 0; i < 400 && !stopped; i++) await sleep(5);
      await sleep(30); // the final chunk is posted before 'stopped'; let it land
      chunks.sort((a, b) => a.frame - b.frame);
      let total = 0, gaps = 0, overlaps = 0;
      for (let i = 0; i < chunks.length; i++) {
        total += chunks[i].frames;
        if (i) { const exp = chunks[i - 1].frame + chunks[i - 1].frames; if (chunks[i].frame > exp) gaps += chunks[i].frame - exp; else if (chunks[i].frame < exp) overlaps++; }
      }
      const first = chunks.length ? chunks[0].frame : 0;
      const last = chunks.length ? chunks[chunks.length - 1].frame + chunks[chunks.length - 1].frames : 0;
      const frames = last - first;
      merged = new Float32Array(frames * 2);
      for (const c of chunks) merged.set(c.data, (c.frame - first) * 2);
      chunks = [];
      info = { sampleRate: ctx.sampleRate, firstFrame: first, frames, capturedFrames: total, gapFrames: gaps, overlaps, bytes: merged.byteLength, marks: marks.slice() };
      return info;
    },
    /** base64 of merged float32 interleaved samples [offset, offset+count) in bytes */
    read(offset, count) {
      const u8 = new Uint8Array(merged.buffer, offset, Math.min(count, merged.byteLength - offset));
      if (typeof u8.toBase64 === 'function') return u8.toBase64();
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    },
    free() { merged = null; },
    get info() { return info; },
  };
})();

/* ── sync pulse: a white square + an audio-thread mark in the same task (recorder alignment) ── */
let pulseTimer = 0;
function syncPulse(id, ms = 110) {
  syncEl.classList.add('is-on');
  tap.mark(id);
  const wall = wallNow();
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => syncEl.classList.remove('is-on'), ms);
  return { id, wall };
}

/* ── timecode strip: every rendered frame carries its own page time (rAF frame time, 0.1 ms units) as 32 black /
   white 8×8 blocks (28 data bits + 4 check bits) below the stage — the recorder decodes it from every captured
   frame, so it knows exactly which moment each captured frame shows, whatever the capture pipeline's latency ── */
function startTimecode() {
  document.documentElement.classList.add('tc');
  const cv = document.getElementById('tc');
  const g = cv.getContext('2d', { alpha: false });
  const draw = (ts) => {
    const v = Math.round((performance.timeOrigin + ts) * 10) % 0x10000000; // 28 bits of 0.1 ms
    let chk = 0;
    for (let i = 0; i < 7; i++) chk ^= (v >>> (i * 4)) & 15;
    const word = ((v << 4) | chk) >>> 0; // bit 31..4 value, 3..0 check
    for (let b = 0; b < 32; b++) {
      g.fillStyle = (word >>> (31 - b)) & 1 ? '#fff' : '#000';
      g.fillRect(b * 8, 0, 8, 8);
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
if (TC) startTimecode();

/* ── clock marks: every `ms` a mark to the audio tap, stamped with the page clock (audio ↔ wall mapping) ── */
const clockMarks = (() => {
  let timer = 0, n = 0, list = [];
  return {
    start(ms = 100) {
      clearInterval(timer); n = 0; list = [];
      const tick = () => { const id = `c${n++}`; tap.mark(id); list.push({ id, wall: wallNow() }); };
      tick();
      timer = setInterval(tick, ms);
    },
    stop() { clearInterval(timer); timer = 0; return list.slice(); },
  };
})();

/* ── calibration helper: flash a white square (top-right) whenever a note is triggered from JS ── */
let noteFlashOff = null;
function noteFlash(on = true, ms = 100) {
  if (noteFlashOff) { noteFlashOff(); noteFlashOff = null; }
  if (!on) return false;
  const A = appWin().__aurora;
  let tm = 0;
  const events = [];
  const off = A.onNote((ev) => {
    if (ev.type !== 'on') return;
    noteFlashEl.classList.add('is-on');
    events.push({ note: ev.note, wall: wallNow(), ctxTime: ev.ctxTime });
    clearTimeout(tm);
    tm = setTimeout(() => noteFlashEl.classList.remove('is-on'), ms);
  });
  noteFlashOff = () => { off(); noteFlashEl.classList.remove('is-on'); };
  api._noteFlashEvents = events;
  return true;
}

/* ── fonts: load every glyph subset the film can show BEFORE recording (no fallback-font pop-in) ── */
async function waitStylesheets(doc, ms = 10000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const links = [...doc.querySelectorAll('link[href*="fonts.googleapis.com/css2"]')];
    if (links.length && links.some(l => l.rel === 'stylesheet' && l.sheet)) return true;
    await sleep(50);
  }
  return false;
}
async function prewarmFonts(text, docs = [document, appDoc()].filter(Boolean)) {
  const chars = [...new Set(String(text || ''))].join('');
  const fams = ['Inter', 'Noto Sans TC', 'JetBrains Mono'];
  const weights = [400, 500, 600, 700, 800];
  const jobs = [];
  for (const d of docs) for (const f of fams) for (const w of weights) jobs.push(d.fonts.load(`${w} 24px "${f}"`, chars || 'A').catch(() => []));
  await Promise.race([Promise.all(jobs), sleep(15000)]);
  await Promise.all(docs.map(d => d.fonts.ready));
}
/** every CJK / symbol character in the app's strings, presets, songs, tours and the overlay sources */
async function filmText() {
  const A = appWin().__aurora;
  const parts = [appDoc().body.innerText, document.body.innerText];
  try { parts.push(JSON.stringify(A.presets), JSON.stringify(A.categories), JSON.stringify(A.songs), JSON.stringify(A.tours)); } catch { /* ignore */ }
  const sources = ['../../src/ui/app/i18n.js'];
  const listDir = async (dir) => {
    try {
      const html = await (await fetch(dir)).text();
      return [...html.matchAll(/href="([^"]+\.(?:m?js|json))"/g)].map(m => new URL(m[1], new URL(dir, location.href)).href);
    } catch { return []; }
  };
  if (OVERLAY_SPEC && OVERLAY_SPEC !== 'none') {
    const base = new URL('.', new URL(OVERLAY_SPEC, location.href)).href;
    sources.push(...await listDir(base), ...await listDir(base + 'lib/'));
  }
  for (const s of sources) { try { parts.push(await (await fetch(s)).text()); } catch { /* ignore */ } }
  const all = parts.join('\n');
  // Latin is covered by one subset request per weight; keep CJK, full-width forms and symbols
  const keep = [...new Set(all)].filter(c => c.codePointAt(0) > 0x2000).join('');
  return 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789.,:;!?()[]{}<>@#%&*+-=/\'"·—–…•' + keep;
}

/* ── performance probe: rAF cadence + long main-thread tasks (director and app), for the recorder's report ── */
const probe = (() => {
  let on = false, last = 0, raf = 0, slow = [], frames = 0, longTasks = [], longFrames = [], observers = [];
  const loop = (t) => {
    if (!on) return;
    if (last && t - last > 24) slow.push({ at: +(performance.timeOrigin + last).toFixed(1), ms: +(t - last).toFixed(1) });
    last = t; frames++;
    raf = requestAnimationFrame(loop);
  };
  const observe = (win, where) => {
    try {
      const po = new win.PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push({ where, at: +(win.performance.timeOrigin + e.startTime).toFixed(1), ms: +e.duration.toFixed(1) });
      });
      po.observe({ type: 'longtask', buffered: false });
      observers.push(po);
    } catch { /* not supported */ }
    try {
      // long animation frames: which part of a slow frame took the time (scripts / style+layout / paint+commit)
      const po2 = new win.PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const end = e.startTime + e.duration;
          longFrames.push({ where, at: +(win.performance.timeOrigin + e.startTime).toFixed(1), ms: +e.duration.toFixed(1),
            blockingMs: +(e.blockingDuration || 0).toFixed(1),
            scriptMs: +(e.scripts || []).reduce((a, x) => a + x.duration, 0).toFixed(1),
            styleLayoutMs: e.styleAndLayoutStart ? +(end - e.styleAndLayoutStart).toFixed(1) : null,
            renderMs: e.renderStart ? +(end - e.renderStart).toFixed(1) : null,
            topScripts: (e.scripts || []).sort((a, b) => b.duration - a.duration).slice(0, 2).map(x => `${x.invoker || x.name} ${x.duration.toFixed(0)}ms ${(x.sourceURL || '').split('/').slice(-2).join('/')}:${x.sourceFunctionName || ''}`) });
        }
      });
      po2.observe({ type: 'long-animation-frame', buffered: false });
      observers.push(po2);
    } catch { /* not supported */ }
  };
  return {
    start() { on = true; last = 0; slow = []; frames = 0; longTasks = []; longFrames = []; observe(window, 'director'); if (appWin()) observe(appWin(), 'app'); raf = requestAnimationFrame(loop); },
    stop() { on = false; cancelAnimationFrame(raf); for (const o of observers) o.disconnect(); observers = []; return { frames, slowFrames: slow, longTasks, longFrames }; },
  };
})();

/* ── boot ── */
async function waitFor(pred, ms, what) {
  const t0 = performance.now();
  for (;;) {
    try { const v = pred(); if (v) return v; } catch { /* not yet */ }
    if (performance.now() - t0 > ms) throw new Error(`director: timeout waiting for ${what}`);
    await sleep(40);
  }
}

const api = {
  lang: LANG, stage, camera, iframe, overlayRoot,
  get app() { return appWin(); },
  get appDoc() { return appDoc(); },
  get aurora() { return appWin() && appWin().__aurora; },
  get overlay() { return overlay; },
  cam, toStage, rectToStage, selectorRect, pointer,
  get cursorMode() { return cursorMode; },
  set cursorMode(m) { cursorMode = m; if (m === 'none') dcursor.classList.remove('is-on'); },
  get cursor() { return { ...cursorState }; },
  tap, probe, clockMarks, syncPulse, noteFlash, prewarmFonts, log, logs,
  wallNow,
  audioClock() { const A = appWin() && appWin().__aurora; const c = A && A.ctx; return c ? c.currentTime : 0; },
  /** resolves when the audio clock reaches t (seconds); precision ≈ one audio callback */
  async waitAudio(t) {
    for (;;) {
      const now = api.audioClock();
      const left = t - now;
      if (left <= 0) return now;
      if (left > 0.03) await sleep(Math.min(250, (left - 0.02) * 1000));
      else await new Promise(r => setTimeout(r, 1));
    }
  },
  /** resolves when the page clock (performance.timeOrigin + now, ms) reaches ms */
  async waitWall(ms) {
    for (;;) {
      const left = ms - wallNow();
      if (left <= 0) return wallNow();
      await new Promise(r => setTimeout(r, left > 30 ? Math.min(250, left - 15) : 1));
    }
  },
  focusApp() { try { iframe.focus(); appWin().focus(); } catch { /* ignore */ } return appDoc() && appDoc().hasFocus(); },
  state: 'booting',
  ready: null,
};
window.director = api;

api.ready = (async () => {
  await new Promise(r => (iframe.contentDocument && iframe.contentDocument.readyState === 'complete' && iframe.contentWindow.location.href !== 'about:blank' ? r() : iframe.addEventListener('load', r, { once: true })));
  await waitFor(() => appWin().__aurora, 20000, 'the app video hook (window.__aurora)');
  api.state = 'app';
  const [ovl] = await Promise.all([loadOverlay(), waitStylesheets(appDoc()), waitStylesheets(document)]);
  overlay = ovl;
  if (AUTOSTART) {
    const r = await appWin().__aurora.start();
    if (!r.ok) throw new Error('director: the audio engine did not start');
    await tap.install();
  }
  api.state = 'fonts';
  try { await prewarmFonts(await filmText()); } catch (e) { log('font prewarm failed', String(e)); }
  api.focusApp();
  // let the app settle (splash fade, first visuals, JIT warm-up of the DSP)
  await sleep(400);
  api.state = 'ready';
  log('ready', { lang: LANG, overlay: !!overlay, audio: AUTOSTART ? appWin().__aurora.ctx.sampleRate : 'not started' });
  return true;
})();
api.ready.catch(e => { api.state = 'error'; api.error = String(e && e.message ? e.message : e); log('ready failed', api.error); });
