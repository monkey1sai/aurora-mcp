// The `ctx` object handed to a timeline module: `export default async function (ctx) { … }`.
// Everything the director page and the app expose, plus trusted (CDP) input and audio-clock scheduling.
// See tools/video/README.md for the full reference.

const sleep = ms => new Promise(r => setTimeout(r, ms));

// DOM `code` → [key, windowsVirtualKeyCode, text?]
const KEYS = {
  Space: [' ', 32, ' '], Semicolon: [';', 186, ';'], Quote: ["'", 222, "'"], Comma: [',', 188, ','], Period: ['.', 190, '.'],
  Slash: ['/', 191, '/'], Minus: ['-', 189, '-'], Equal: ['=', 187, '='], BracketLeft: ['[', 219, '['], BracketRight: [']', 221, ']'],
  Backslash: ['\\', 220, '\\'], Backquote: ['`', 192, '`'], Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Tab: ['Tab', 9],
  Backspace: ['Backspace', 8], Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  ShiftLeft: ['Shift', 16], ShiftRight: ['Shift', 16], ControlLeft: ['Control', 17], AltLeft: ['Alt', 18], MetaLeft: ['Meta', 91],
};
const CHAR_CODE = { ' ': 'Space', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '`': 'Backquote', '\n': 'Enter' };

/** 'KeyA' | 'a' | 'Space' | ';' → { code, key, keyCode, text } */
export function keyInfo(k, keyOverride) {
  let code = k;
  if (typeof k === 'string' && k.length === 1) {
    if (/[a-z]/i.test(k)) code = 'Key' + k.toUpperCase();
    else if (/\d/.test(k)) code = 'Digit' + k;
    else code = CHAR_CODE[k] || k;
  }
  let key, keyCode, text;
  if (/^Key[A-Z]$/.test(code)) { key = code[3].toLowerCase(); keyCode = code.charCodeAt(3); text = key; }
  else if (/^Digit\d$/.test(code)) { key = code[5]; keyCode = code.charCodeAt(5); text = key; }
  else if (KEYS[code]) { [key, keyCode, text] = KEYS[code]; }
  else { key = code; keyCode = 0; }
  if (keyOverride != null) { key = keyOverride; if (keyOverride.length === 1) text = keyOverride; }
  return { code, key, keyCode, text };
}

const serializeCall = (fn, args) => {
  if (typeof fn === 'function') return `(${fn.toString()})(...${JSON.stringify(args)})`;
  if (args.length) throw new Error('eval: arguments are only supported with a function');
  return String(fn);
};

/**
 * @param {{ chrome, lang, fps, w, h, t0: {wall, ctx}, events: object[], args: object, log: Function }} o
 */
export function createContext({ chrome, lang, fps, w, h, t0, events, args, log, out }) {
  const send = chrome.send;
  let mouse = { x: w * 0.62, y: h * 0.72, down: false };

  // ── execution context of the app iframe (for evalApp) ──
  async function appContext() {
    const tree = await send('Page.getFrameTree');
    const kids = tree.frameTree.childFrames || [];
    const f = kids.find(k => /index\.html\?video=1/.test(k.frame.url)) || kids[0];
    if (!f) throw new Error('evalApp: the app iframe is not loaded');
    for (let i = 0; i < 100 && !chrome.contexts.has(f.frame.id); i++) await sleep(20);
    const id = chrome.contexts.get(f.frame.id);
    if (id == null) throw new Error('evalApp: app execution context not found');
    return id;
  }
  async function evaluate(expression, contextId) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId != null ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  const evalDirector = (fn, ...a) => evaluate(serializeCall(fn, a));
  const evalApp = async (fn, ...a) => evaluate(serializeCall(fn, a), await appContext());

  const now = async () => (t0.ctx > 0 ? (await evalDirector('director.audioClock()')) - t0.ctx : ((await evalDirector('director.wallNow()')) / 1000 - t0.wall));
  const record = (type, data = {}) => { const e = { type, wall: Date.now() / 1000, ...data }; events.push(e); return e; };

  // ── deep proxy: ctx.overlay.a.b(...args) → director.overlay.a.b(...args) in the page ──
  function remote(rootExpr, label) {
    const make = (pathArr) => new Proxy(function () {}, {
      get(_, k) {
        if (k === 'then' || typeof k === 'symbol') return undefined;
        return make([...pathArr, k]);
      },
      apply(_, __, callArgs) {
        const target = pathArr.slice(0, -1).reduce((e, k) => `${e}[${JSON.stringify(k)}]`, rootExpr);
        const m = JSON.stringify(pathArr[pathArr.length - 1]);
        const expr = `(async () => { const o = ${target}; if (!o) return { __missing: true }; const f = o[${m}]; if (typeof f !== 'function') return { __missing: true }; const r = await f.apply(o, ${JSON.stringify(callArgs)}); try { return JSON.parse(JSON.stringify(r ?? null)); } catch { return null; } })()`;
        const p = evaluate(expr).then((v) => {
          if (v && v.__missing) { log(`[${label}] ${pathArr.join('.')} is not available`); return null; }
          return v;
        });
        p.catch(e => log(`[${label}] ${pathArr.join('.')} failed: ${e.message}`));
        return p;
      },
    });
    return make([]);
  }

  // ── trusted mouse input (stage = page coordinates) ──
  async function mouseEvent(type, x, y, opt = {}) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: opt.button || 'left', buttons: type === 'mouseReleased' ? 0 : (mouse.down || type === 'mousePressed' ? 1 : 0), clickCount: opt.clickCount || 1, ...(opt.deltaY != null ? { deltaX: opt.deltaX || 0, deltaY: opt.deltaY } : {}) });
  }
  const notifyPointer = (x, y, type) => evalDirector(`director.pointer(${x}, ${y}, ${JSON.stringify(type)})`).catch(() => {});
  const overlayHasCursor = async () => !!(await evalDirector(`!!(director.overlay && director.overlay.cursor && director.cursorMode === 'overlay')`));

  const E = {
    linear: t => t, inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2), outCubic: t => 1 - (1 - t) ** 3,
    inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  };
  /** move the real pointer along a path (60 Hz steps) — hover states follow; the cursor visual follows too */
  async function movePointer(x, y, { ms = 0, ease = 'inOutCubic', visual = true } = {}) {
    const x0 = mouse.x, y0 = mouse.y;
    const steps = Math.max(1, Math.round((ms / 1000) * 60));
    const fn = E[ease] || E.inOutCubic;
    const tStart = Date.now();
    for (let i = 1; i <= steps; i++) {
      const k = fn(i / steps);
      const px = x0 + (x - x0) * k, py = y0 + (y - y0) * k;
      mouse.x = px; mouse.y = py;
      await mouseEvent('mouseMoved', px, py);
      if (visual) notifyPointer(px, py, mouse.down ? 'drag' : 'move');
      const due = tStart + (ms * i) / steps;
      const left = due - Date.now();
      if (left > 1) await sleep(left);
    }
  }

  async function resolvePoint(target, opts = {}) {
    if (typeof target === 'string') {
      const r = await evalDirector((sel, scroll) => director.selectorRect(sel, { scroll }), target, !!opts.scroll);
      if (!r) throw new Error(`no element ${target}`);
      if (!r.visible) throw new Error(`element not visible ${target}`);
      return { x: r.cx + (opts.dx || 0), y: r.cy + (opts.dy || 0), rect: r };
    }
    if (Array.isArray(target)) return { x: target[0], y: target[1] };
    return { x: target.x, y: target.y };
  }

  const api = {
    lang, fps, w, h, args, out,
    /** the timeline start: { wall (page clock, s), ctx (app AudioContext time, s; 0 before the engine runs) } */
    t0,
    chrome, cdp: send, send,
    log: (...a) => log(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    events,

    evalDirector, evalApp,
    /** window.__aurora in the app: await ctx.aurora.loadPresetByName('Aurora Pad') */
    aurora: remote('window.director.aurora', 'aurora'),
    /** director.overlay (tools/video/overlays): await ctx.overlay.hook([...]) — no-op + log when not loaded */
    overlay: remote('window.director.overlay', 'overlay'),
    director: remote('window.director', 'director'),

    // ── time ──
    wait: ms => sleep(ms),
    /** seconds since the timeline started, on the app's audio clock */
    now,
    /** resolve when the audio clock reaches `seconds` after the timeline start */
    at: async (seconds) => {
      // the audio clock when the engine ran at the start (it is locked to the page clock within one audio callback),
      // else the page clock (e.g. a take that starts on the splash with --no-autostart)
      if (t0.ctx > 0) await evalDirector(`director.waitAudio(${t0.ctx + seconds})`);
      else await evalDirector(`director.waitWall(${t0.wall * 1000 + seconds * 1000})`);
    },
    waitAudio: async (seconds) => { await evalDirector(`director.waitAudio(director.audioClock() + ${seconds})`); },
    /** add a named marker to the report (chapter points for editors) */
    mark: async (label, data = {}) => record('mark', { label, t: await now(), ...data }),

    // ── camera (targets in app coordinates: selector | {x,y,w,h} | [x,y,w,h]) ──
    camera: {
      zoomTo: (target, scale, ms = 900, ease = 'inOutCubic', opts = {}) => evalDirector((t, s, m, e, o) => director.cam.zoomTo(t, s, m, e, o), target, scale ?? null, ms, ease, opts),
      to: (state, ms = 900, ease = 'inOutCubic') => evalDirector((s, m, e) => director.cam.to(s, m, e), state, ms, ease),
      reset: (ms = 900, ease = 'inOutCubic') => evalDirector((m, e) => director.cam.reset(m, e), ms, ease),
      set: state => evalDirector(s => director.cam.set(s), state),
      get: () => evalDirector('director.cam.get()'),
      frameFor: (target, scale, opts = {}) => evalDirector((t, s, o) => director.cam.frameFor(t, s, o), target, scale ?? null, opts),
    },
    zoomTo: (...a) => api.camera.zoomTo(...a),
    resetCamera: (...a) => api.camera.reset(...a),

    // ── pointer ──
    /** move the pointer (stage coords or app selector). opts: { ms, ease, cursor: true } */
    async moveTo(target, opts = {}) {
      const p = await resolvePoint(target, opts);
      const ms = opts.ms ?? 600;
      if (opts.cursor !== false && await overlayHasCursor()) {
        await Promise.all([
          evalDirector((x, y, o) => director.overlay.cursor.moveTo(x, y, o), p.x, p.y, { ms, arc: opts.arc, ease: undefined }),
          movePointer(p.x, p.y, { ms, ease: opts.ease, visual: false }),
        ]);
      } else await movePointer(p.x, p.y, { ms, ease: opts.ease, visual: opts.cursor !== false });
      return p;
    },
    /** trusted click at stage coords (x, y) */
    async click(x, y, opts = {}) {
      const ovCursor = opts.cursor !== false && await overlayHasCursor();
      // with the overlay's cursor the pointer glides to the target first (450 ms) unless moveMs says otherwise
      const moveMs = opts.moveMs ?? (ovCursor ? 450 : 0);
      if (moveMs) await api.moveTo([x, y], { ms: moveMs, cursor: opts.cursor });
      else if (mouse.x !== x || mouse.y !== y) { mouse.x = x; mouse.y = y; await mouseEvent('mouseMoved', x, y); if (opts.cursor !== false) notifyPointer(x, y, 'move'); }
      if (ovCursor) evalDirector('director.overlay.cursor.click()').catch(() => {});
      else if (opts.cursor !== false) notifyPointer(x, y, 'down');
      mouse.down = true;
      await mouseEvent('mousePressed', x, y, opts);
      await sleep(opts.holdMs ?? 60);
      mouse.down = false;
      await mouseEvent('mouseReleased', x, y, opts);
      if (!ovCursor && opts.cursor !== false) notifyPointer(x, y, 'up');
      record('click', { x, y });
    },
    /** click the centre of an app element (camera zoom taken into account). opts: { moveMs, dx, dy, scroll } */
    async clickSelector(sel, opts = {}) {
      const p = await resolvePoint(sel, opts);
      await api.click(p.x, p.y, opts);
      return p;
    },
    /** press at `from`, drag to `to` over ms (knobs: drag up = increase). from/to: stage point or selector */
    async drag(from, to, opts = {}) {
      const a = await resolvePoint(from, opts);
      const b = typeof to === 'object' && !Array.isArray(to) && to && 'dy' in to && !('x' in to) ? { x: a.x + (to.dx || 0), y: a.y + to.dy } : await resolvePoint(to, opts);
      const ms = opts.ms ?? 900;
      if (opts.moveMs !== 0) await api.moveTo([a.x, a.y], { ms: opts.moveMs ?? 500, cursor: opts.cursor });
      mouse.down = true;
      await mouseEvent('mousePressed', a.x, a.y);
      const ovCursor = opts.cursor !== false && await overlayHasCursor();
      const vis = ovCursor ? evalDirector((x, y, o) => director.overlay.cursor.moveTo(x, y, o), b.x, b.y, { ms, arc: 0 }) : null;
      // same curve as the overlay cursor's own move (inOutCubic), so the arrow and the knob stay together
      await movePointer(b.x, b.y, { ms, ease: opts.ease || 'inOutCubic', visual: !ovCursor && opts.cursor !== false });
      if (vis) await vis;
      mouse.down = false;
      await mouseEvent('mouseReleased', b.x, b.y);
      if (!ovCursor && opts.cursor !== false) notifyPointer(b.x, b.y, 'up');
      record('drag', { from: a, to: b, ms });
    },
    /** mouse wheel over a stage point / selector */
    async wheel(target, deltaY, opts = {}) {
      const p = await resolvePoint(target, opts);
      await mouseEvent('mouseMoved', p.x, p.y);
      await mouseEvent('mouseWheel', p.x, p.y, { deltaY });
    },
    /** show / hide the cursor (the overlay's, else the director's built-in arrow) at the current pointer position */
    async showCursor(on = true) {
      if (await overlayHasCursor()) return on ? api.overlay.cursor.show({ x: mouse.x, y: mouse.y }) : api.overlay.cursor.hide();
      return notifyPointer(mouse.x, mouse.y, on ? 'show' : 'hide');
    },
    /** current pointer position (stage coordinates) */
    pointer: () => ({ ...mouse }),

    // ── keyboard (the app plays with A W S E D F T G Y H U J K O L P ; ') ──
    async keyDown(k, keyOverride) {
      const i = keyInfo(k, keyOverride);
      await send('Input.dispatchKeyEvent', { type: i.text ? 'keyDown' : 'rawKeyDown', code: i.code, key: i.key, text: i.text, unmodifiedText: i.text, windowsVirtualKeyCode: i.keyCode, nativeVirtualKeyCode: i.keyCode });
    },
    async keyUp(k, keyOverride) {
      const i = keyInfo(k, keyOverride);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', code: i.code, key: i.key, windowsVirtualKeyCode: i.keyCode, nativeVirtualKeyCode: i.keyCode });
    },
    /** press + release (holdMs) */
    async key(k, keyOverride, { holdMs = 60 } = {}) {
      await api.keyDown(k, keyOverride);
      await sleep(holdMs);
      await api.keyUp(k, keyOverride);
      record('key', { code: keyInfo(k).code });
    },
    /** hold several keys together (a chord) for ms */
    async holdKeys(keys, ms = 500) {
      await Promise.all(keys.map(k => api.keyDown(k)));
      record('chord', { keys: keys.map(k => keyInfo(k).code), ms });
      await sleep(ms);
      await Promise.all(keys.map(k => api.keyUp(k)));
    },
    /** play a sequence: [[keys|key, ms], …] (keys held for ms, then released) — gapMs between steps */
    async play(seq, { gapMs = 0 } = {}) {
      for (const [k, ms] of seq) { await api.holdKeys(Array.isArray(k) ? k : [k], ms); if (gapMs) await sleep(gapMs); }
    },
    /** type text into the focused field (charMs per character) */
    async type(text, { charMs = 45 } = {}) {
      for (const ch of text) {
        if (/[a-z0-9 ;',./\-=\[\]\\`]/i.test(ch)) {
          const i = keyInfo(ch.toLowerCase(), ch);
          await send('Input.dispatchKeyEvent', { type: 'keyDown', code: i.code, key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: i.keyCode });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', code: i.code, key: ch, windowsVirtualKeyCode: i.keyCode });
        } else {
          await send('Input.insertText', { text: ch }); // CJK and other text without a key
        }
        if (charMs) await sleep(charMs);
      }
      record('type', { text });
    },
    focusApp: () => evalDirector('director.focusApp()'),

    /** PNG of the stage right now (debug / thumbnails; may cost a frame while recording) */
    async screenshot(file) { await chrome.screenshot(file); return file; },
  };
  return api;
}
