// AURORA video-mode hook. Loaded by src/ui/main.js ONLY when the page URL has ?video=1 (the recorder's director
// page embeds /index.html?video=1). Builds window.__aurora — precise, scriptable handles for the video timeline —
// and tidies the frame for filming: no toasts, no first-run tips (main.js skips those), no OS cursor.
//
// Every method is safe to call from the director / CDP (Runtime.evaluate in the app frame). Everything that
// starts sound goes through the app's own code paths, so the UI reacts exactly as it does for a human.

import { getLang, setLang } from '../../../src/ui/app/i18n.js';

const VIDEO_CSS = `
  /* video mode (tools/video): the overlay draws its own cursor and captions */
  html, body, *, *::before, *::after { cursor: none !important; }
  #toasts, .toasts, .coach { display: none !important; }
  /* the resume prompt (iOS) can never apply in the recorder */
  .resume-prompt { display: none !important; }
  /* headless Chrome has no Web MIDI, so the top bar would strike "MIDI" through (the "unsupported" state); a normal
     desktop Chrome shows the idle, not-struck pill — film that */
  .midi.is-off .midi__txt { text-decoration: none !important; }
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').trim().toLowerCase();

export function install(I) {
  const style = document.createElement('style');
  style.id = 'aurora-video-mode';
  style.textContent = VIDEO_CSS;
  document.head.append(style);
  document.documentElement.classList.add('video-mode');

  // ── JS-triggered note events (QWERTY, on-screen keys, MIDI, __aurora.noteOn): the overlay can react to them ──
  const noteSubs = new Set();
  const emitNote = (type, note, vel) => {
    const ev = { type, note, vel, t: performance.now(), ctxTime: ctxTime() };
    for (const fn of noteSubs) { try { fn(ev); } catch (e) { console.error(e); } }
  };
  let wrapped = null;
  function wrapAudio() {
    const a = I.getAudio();
    if (!a || a.isNull || wrapped === a) return a;
    const on = a.noteOn.bind(a), off = a.noteOff.bind(a);
    // emit first: a subscriber's DOM change and the port message to the synth leave in the same task
    a.noteOn = (n, v = 0.8) => { emitNote('on', n, v); on(n, v); };
    a.noteOff = (n) => { emitNote('off', n, 0); off(n); };
    wrapped = a;
    return a;
  }
  const audio = () => wrapAudio();
  const ctxTime = () => { const a = I.getAudio(); return a && a.ctx ? a.ctx.currentTime : 0; };

  let songsMod = null;
  const songsReady = I.songsModule().then(m => { songsMod = m; return m; }).catch(() => null);
  let toursMod = null;
  const toursReady = import('../../../src/demo/tours/index.js').then(m => { toursMod = m; return m; }).catch(() => null);

  function findPreset(name) {
    const all = I.library.all();
    const n = norm(name);
    return all.find(p => norm(p.name) === n) || all.find(p => norm(p.key) === n) || all.find(p => norm(p.name).includes(n)) || null;
  }
  async function center() {
    const c = I.getCenter();
    if (!c) throw new Error('Demo Center unavailable');
    if (c.ready && typeof c.ready.then === 'function') await c.ready;
    return c;
  }

  const api = {
    version: 1,
    get store() { return I.store; },
    get library() { return I.library; },
    get audio() { return audio(); },
    /** the app's AudioContext (null before start()) */
    get ctx() { const a = audio(); return a && !a.isNull ? a.ctx : null; },
    /** the AudioNode whose output reaches ctx.destination (everything the app plays passes through it) */
    get master() { const a = audio(); return a && !a.isNull ? a.output : null; },
    presets: I.presets,
    categories: I.categories,
    get songs() { return songsMod ? songsMod.SONGS : []; },
    get tours() { return toursMod ? toursMod.TOURS : []; },
    get center() { return I.getCenter(); },
    internals: I,
    lang: () => getLang(),
    setLang: l => setLang(l),

    /** Start the audio engine and dismiss the splash (resolves once the splash is gone). */
    async start() {
      await I.startAudio();
      wrapAudio();
      const splash = document.getElementById('splash');
      for (let i = 0; i < 60 && splash && !splash.hidden; i++) await sleep(50);
      await Promise.all([songsReady, toursReady]);
      const a = audio();
      return { ok: !!(a && !a.isNull), sampleRate: a ? a.sampleRate : 0, state: a && a.ctx ? a.ctx.state : 'none' };
    },
    isReady: () => { const a = I.getAudio(); return !!(a && !a.isNull && a.ctx && a.ctx.state === 'running'); },

    /** Load a factory/user preset by name (case-insensitive; key or substring also match). Returns its name. */
    loadPresetByName(name, opts = {}) {
      const p = findPreset(name);
      if (!p) throw new Error(`preset not found: ${name}`);
      I.loadEntry(p, opts);
      return p.name;
    },
    presetNames: () => I.library.all().map(p => p.name),
    /** Macro knob i (0..3) to v (0..1) — the knob, the XY pad and the sound all follow. */
    setMacro(i, v) { I.store.set(`macro${i + 1}`, Math.max(0, Math.min(1, +v)), { coalesce: true }); return I.store.get(`macro${i + 1}`); },
    getMacro: i => I.store.get(`macro${i + 1}`),
    /** Glide macro i to v over ms (ease in-out); resolves when done. */
    async rampMacro(i, v, ms = 1000) {
      const from = I.store.get(`macro${i + 1}`);
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        api.setMacro(i, from + (v - from) * e);
        if (k >= 1) return;
        await new Promise(r => requestAnimationFrame(r));
      }
    },
    setParam(id, v) { I.store.set(id, v, { coalesce: true }); return I.store.get(id); },
    getParam: id => I.store.get(id),

    noteOn(note, vel = 0.8) { const a = audio(); if (a) a.noteOn(note, vel); },
    noteOff(note) { const a = audio(); if (a) a.noteOff(note); },
    /** fn({ type:'on'|'off', note, vel, t, ctxTime }) for every JS-triggered note → unsubscribe */
    onNote(fn) { noteSubs.add(fn); return () => noteSubs.delete(fn); },

    startDemo: () => I.startDemo(),
    stopDemo: () => I.stopDemo(),

    async openDemoCenter(tab = 'songs') { const c = await center(); c.open(tab); return c.tab; },
    async closeDemoCenter() { const c = await center(); if (c.isOpen) c.close(); },
    /** Play a demo song through the Demo Center's songs view (the UI shows it playing). id: 'aurora-dreams', … */
    async playSong(id, { openCenter = true } = {}) {
      const c = await center();
      await songsReady;
      if (openCenter && !(c.isOpen && c.tab === 'songs')) { c.open('songs'); await sleep(420); }
      else if (!openCenter && !(c.isOpen && c.tab === 'songs')) { c.open('songs'); c.close(); }
      const card = document.querySelector(`.sv-card[data-id="${CSS.escape(id)}"]`);
      if (!card) throw new Error(`song not found: ${id}`);
      card.click();
      await sleep(30);
      const btn = document.querySelector('.svp-play');
      if (!btn) throw new Error('song player not ready');
      btn.click();
      return id;
    },
    /** Start an animated sound tour (knobs turn themselves). id: 'supersaw', 'acid-bass', … (see .tours) */
    async startTour(id) {
      const c = await center();
      await toursReady;
      const tour = toursMod && toursMod.tourById(id);
      if (!tour) throw new Error(`tour not found: ${id}`);
      if (c.isOpen) c.close();
      c.tours.start(tour);
      return id;
    },
    async theater(opts) { const c = await center(); if (c.isOpen) c.close(); c.theater.enter(opts); },
    /** Stop everything that plays (songs, jam, tours, theater, demo phrase, held notes) — no toast. */
    stopAll() {
      const c = I.getCenter();
      if (c) { try { c.stopAll(); } catch (e) { console.error(e); } }
      I.stopDemo();
      const a = I.getAudio();
      if (a) a.allNotesOff(true);
      try { I.dock.releaseAll(); } catch { /* ignore */ }
      try { I.qwerty.releaseAll(); } catch { /* ignore */ }
    },
    setEditMode: (on) => I.setEditMode(on),

    /** Element rect in app (iframe viewport) CSS pixels: { x, y, w, h, cx, cy } or null. */
    rect(sel) {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    },
  };
  wrapAudio();
  globalThis.__aurora = api;
  window.dispatchEvent(new CustomEvent('aurora:video-ready'));
  return api;
}
