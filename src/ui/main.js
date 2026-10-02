// AURORA 極光 — application entry point.
// Builds the shell (top bar, preset browser, play view, tabbed editor, keyboard dock), restores the last
// session, and starts the audio engine on the first user gesture (splash). Optional modules (visuals,
// DSP helpers for the UI, demo phrases, presets) are imported dynamically so a failure in one of them
// degrades that feature instead of breaking the app.

import { createAudio, createNullAudio } from './audio.js';
import { attachQwerty, attachMidi } from './keyboard.js';
import { h, storage, debounce, isTyping } from './app/dom.js';
import { t, setLang, getLang, onLangChange, applyI18n } from './app/i18n.js';
import { createStore } from './app/store.js';
import { createBinder } from './app/controls.js';
import { createLibrary } from './app/library.js';
import { createPresetBrowser } from './app/presetBrowser.js';
import { createTopbar } from './app/topbar.js';
import { createPlayView } from './app/playView.js';
import { createEditor } from './app/editor.js';
import { createKeyboardDock } from './app/keyboardDock.js';
import { toast, openModal, openMenu, confirmDialog } from './app/modals.js';
import { mutate, randomPatch, parsePresetFile, makeRng } from './app/patchTools.js';
import * as fallbackVisuals from './app/fallbackVisuals.js';
import { applySplashCompat, attachResumePrompt, createWakeLock, midiSupported, midiPermission, watchMidiPermission, isAppleMobile } from './compat.js';

const FALLBACK_CATEGORIES = [
  ['keys', 'Keys', '鍵盤', '#5cf2ff'], ['pad', 'Pad', '鋪底', '#a78bfa'], ['bass', 'Bass', '貝斯', '#ff6bd6'], ['lead', 'Lead', '主奏', '#ffc46b'],
  ['pluck', 'Pluck', '撥弦', '#3ef0b0'], ['bell', 'Bell', '鐘琴', '#8fd8ff'], ['strings', 'Strings & Winds', '弦樂/管樂', '#ffb38a'],
  ['arp', 'Arp & Groove', '琶音/律動', '#6bffd2'], ['fx', 'FX & Texture', '音效/質感', '#ff8fe0'], ['drum', 'Drum', '打擊', '#ff6b81'],
].map(([id, label, zh, color]) => ({ id, label, zh, icon: id, color }));

async function tryImport(spec) {
  try { return await import(spec); } catch (e) { console.warn(`[aurora] optional module ${spec} unavailable:`, e); return null; }
}

// ?video=1: the app runs inside the scripted video recorder (tools/video/director.html). Only then: no first-run
// tips, no session restore/autosave (the recording starts clean and never touches the viewer's saved sound), and
// tools/video/capture/app-hook.js gets the handles it scripts (window.__aurora). Without ?video=1 nothing changes.
const REPO_URL = 'https://github.com/pixbvr/aurora-synth';

const VIDEO = (() => { try { return new URLSearchParams(location.search).get('video') === '1'; } catch { return false; } })();

/** visuals.js factories wrapped so a throwing factory falls back to the minimal Canvas2D version. */
function safeVisuals(mod) {
  const out = {};
  for (const name of Object.keys(fallbackVisuals)) {
    const real = mod && typeof mod[name] === 'function' ? mod[name] : null;
    out[name] = (...a) => {
      if (real) {
        try { return real(...a); } catch (e) { console.error(`[aurora] visuals.${name} failed, using fallback`, e); }
      }
      return fallbackVisuals[name](...a);
    };
  }
  return out;
}

async function boot() {
  document.documentElement.lang = getLang() === 'zh' ? 'zh-Hant' : 'en';
  const [presetsMod, visualsMod, filterMod, fmMod, wtMod, phrasesMod, centerMod, automationMod] = await Promise.all([
    tryImport('../presets/index.js'),
    tryImport('./visuals.js'),
    tryImport('../dsp/filter.js'),
    tryImport('../dsp/engines/fm.js'),
    tryImport('../dsp/engines/wavetables.js'),
    tryImport('../../tools/phrases.mjs'),
    tryImport('./demo/center.js'),
    tryImport('./demo/automation.js'),
  ]);
  if (!visualsMod) toast(t('visualsFailed'), { kind: 'warn' });
  const categories = (presetsMod && presetsMod.CATEGORIES) || FALLBACK_CATEGORIES;
  const factory = (presetsMod && presetsMod.PRESETS) || [];
  const visuals = safeVisuals(visualsMod);
  const phrases = phrasesMod && phrasesMod.PHRASES ? phrasesMod : null;

  /* ── state ── */
  const store = createStore({ globals: storage.get('aurora.globals', null) });
  store.onGlobals(g => storage.set('aurora.globals', g));
  const binder = createBinder(store);
  const library = createLibrary({ factory, categories });
  let audio = createNullAudio();
  const sink = {
    setParam: (id, v) => audio.setParam(id, v),
    setParams: o => audio.setParams(o),
    loadPatch: p => audio.loadPatch(p),
    setMacro: (i, v) => audio.setMacro(i, v),
  };
  const stateSubs = new Set();
  // demo sequencer state (startedAt: the first state message after seqPlay may still report seqPlaying=false)
  const demo = { playing: false, id: null, length: 16, stoppedAt: -1e9, startedAt: 0 };
  let audioFailed = false;
  let audioError = ''; // technical reason of the last failed start (shown behind 詳細資訊 in the Demo Center)
  let center = null; // Demo Center 示範中心 (src/ui/demo/center.js), created after the views
  const ctx = {
    store, binder, categories, visuals,
    ui: storage.get('aurora.ui', {}) || {},
    dsp: {
      filterResponse: filterMod && filterMod.filterResponse ? filterMod.filterResponse : null,
      FM_ALGORITHMS: fmMod && fmMod.FM_ALGORITHMS ? fmMod.FM_ALGORITHMS : null,
      getWavetableFrame: wtMod && wtMod.getWavetableFrame ? wtMod.getWavetableFrame : null,
    },
    sampleRate: () => audio.sampleRate || 48000,
    onState(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); },
    onTabShown: () => () => {},
  };

  /* ── views ── */
  const app = document.getElementById('app') || document.body.appendChild(h('div.app', { id: 'app' }));
  app.textContent = '';
  const catOf = id => categories.find(c => c.id === id);

  const topbar = createTopbar({
    store,
    actions: {
      prev: () => browser.step(-1), next: () => browser.step(1),
      fav: () => { const k = store.getMeta().key; if (k) { library.toggleFav(k); refreshTopbar(); } },
      save: () => openSave(), undo: () => doUndo(), redo: () => doRedo(),
      mutate: () => doMutate(), random: () => doRandom(), demo: () => toggleDemo(),
      center: () => { if (center) center.toggle(); else toast(t('dcSoon'), { kind: 'warn' }); },
      toggleDrawer: () => {
        if (matchMedia('(max-width: 1279px)').matches) document.documentElement.classList.toggle('drawer-open');
        else browser.focusSearch();
      },
      toggleEdit: () => setEditMode(!document.documentElement.classList.contains('show-editor')),
      toggleLang: () => setLang(getLang() === 'zh' ? 'en' : 'zh'),
      midi: () => connectMidi(true),
      retryAudio: () => startAudio(),
      menu: anchor => openMenu(anchor, [
        { label: 'MCP 創作室 / Creation Studio', icon: 'save', onClick: () => {
          try { sessionStorage.setItem('aurora.mcp.fromSynth', JSON.stringify({ patch: store.toPatch(), globals: store.globals() })); } catch { /* studio can still open */ }
          location.href = 'studio.html';
        } },
        // compact (phone) layout hides these top-bar buttons: offer them here
        ...(matchMedia('(max-width: 899px)').matches ? [
          { label: t('save'), icon: 'save', onClick: () => openSave() },
          { label: t('undo'), icon: 'undo', onClick: () => doUndo(), disabled: !store.canUndo() },
          { label: t('redo'), icon: 'redo', onClick: () => doRedo(), disabled: !store.canRedo() },
          { label: t('mutate'), icon: 'mutate', onClick: () => doMutate() },
          ...(matchMedia('(max-width: 380px)').matches ? [{ label: t('random'), icon: 'dice', onClick: () => doRandom() }] : []),
          { sep: true },
        ] : []),
        { label: t('exportJson'), icon: 'download', onClick: exportJson },
        { label: t('importJson'), icon: 'upload', onClick: importJson },
        { sep: true },
        // the top-bar MIDI button is hidden on narrow screens until a device is connected: keep a way to connect
        ...(midiSupported() ? [{ label: t('midiConnect'), icon: 'midi', onClick: () => connectMidi(true) }] : []),
        { label: getLang() === 'en' ? 'Init patch' : '初始化音色 Init', icon: 'sliders', onClick: initPatch },
        { label: t('panic'), icon: 'panic', onClick: panic, hint: 'Esc Esc' },
        { sep: true },
        { label: t('help'), icon: 'help', onClick: openHelp, hint: '?' },
        { label: getLang() === 'en' ? '中文介面' : 'English UI', icon: 'globe', onClick: () => setLang(getLang() === 'zh' ? 'en' : 'zh') },
        { label: getLang() === 'en' ? 'Source on GitHub' : 'GitHub 原始碼', icon: 'github', onClick: () => window.open(REPO_URL, '_blank', 'noopener') },
      ]),
    },
  });
  const browser = createPresetBrowser({
    library, categories,
    onSelect: (p) => { loadEntry(p); if (matchMedia('(max-width: 1279px)').matches) document.documentElement.classList.remove('drawer-open'); },
    onDemo: (p) => { loadEntry(p); startDemo(); },
  });
  const playView = createPlayView(ctx);
  const editor = createEditor(ctx);
  const dock = createKeyboardDock({
    store,
    noteOn: (n, v) => audio.noteOn(n, v),
    noteOff: n => audio.noteOff(n),
    controller: (k, v) => audio.setController(k, v),
  });
  const scrim = h('div.scrim', { 'aria-hidden': 'true' });
  scrim.addEventListener('click', () => document.documentElement.classList.remove('drawer-open'));
  app.append(topbar.el, browser.el, h('main.main', null, playView.el, editor.el), dock.el, scrim);
  editor.init();

  /* ── Demo Center 示範中心: songs, sound tours, jam, magic, theater (optional module) ── */
  const wakeLock = createWakeLock(); // screen stays on while anything plays (see onTransport)
  if (centerMod && typeof centerMod.createDemoCenter === 'function') {
    try {
      center = centerMod.createDemoCenter({
        store, getAudio: () => audio, editor, playView, presets: factory, categories, visuals, phrases, library, toast,
        loadEntry: (p, opts) => loadEntry(p, opts),
        audioStatus: () => ({ state: audioFailed ? 'failed' : audio.isNull ? 'off' : 'ok', error: audioError }),
        retryAudio: () => startAudio(),
        setEditorShown: (on, opts) => setEditMode(on, opts),
        // keep the screen on while a song / jam / tour / theater plays (a locked phone also stops iOS audio)
        onTransport: (kind) => { if (topbar.setCenterLive) topbar.setCenterLive(kind); wakeLock.set('transport', !!kind); },
        onOpenChange: () => topbar.setCenterLive && topbar.setCenterLive(center ? center.transport.kind : null),
      });
    } catch (e) { console.error('[aurora] demo center failed', e); center = null; }
  }
  applyI18n(document);
  app.removeAttribute('aria-busy');

  /* ── preset loading & session ── */
  function refreshTopbar() {
    const meta = store.getMeta();
    topbar.setPreset(meta, catOf(meta.category), meta.key ? library.isFav(meta.key) : false);
    document.title = `${meta.name} — AURORA 極光`;
  }
  store.onPatch(refreshTopbar);
  store.onPatch(meta => browser.setCurrent(meta.key || null)); // keeps ◀ ▶ navigation in sync after undo/random
  library.onChange(refreshTopbar);
  store.onDirty(d => topbar.setDirty(d));
  store.onHistory(hs => topbar.setHistory(hs));
  topbar.setHistory({ canUndo: false, canRedo: false });

  function loadEntry(p, opts = {}) {
    releaseBorrowed();
    // leaving a modified patch (◀ ▶, arrow keys, a click in the browser …) stays recoverable: the switch becomes
    // one undo step (the history is kept) instead of silently dropping the edits
    const keepEdits = store.isDirty() && opts.record === undefined && store.getMeta().source !== 'demo';
    store.loadPreset(p, { source: p.source || (p.user ? 'user' : 'factory'), key: p.key || null, ...(keepEdits ? { record: true, dirty: false } : null), ...opts });
    browser.setCurrent(p.key || null);
    if (demo.playing) startDemo();
    saveSession();
    if (keepEdits) toast(t('editsUndoable'), { ms: 3200 });
  }
  /**
   * A sound tour / theater mode borrows the patch (meta.source 'demo'): before the user's own action replaces
   * it, put the user's patch back (silently), so undo history and autosave see the user's sound, never the
   * half-built demo patch.
   */
  function releaseBorrowed() {
    if (!center || store.getMeta().source !== 'demo') return;
    try {
      if (center.tours && center.tours.isActive()) center.tours.stop({ revert: true, silent: true });
      if (center.theater && center.theater.isOpen()) center.theater.exit();
    } catch (e) { console.error('[aurora] releasing the demo patch failed', e); }
  }

  const saveSession = debounce(() => {
    if (VIDEO) return;
    const meta = store.getMeta();
    // a sound tour / theater mode is borrowing the patch: keep the user's own session until it ends
    if (meta.source === 'demo') return;
    const preset = store.toPreset();
    // auto-evolve drift / a morph in progress are transient (not in the undo history): save the committed values
    if (store.isTransient && store.isTransient()) {
      const cv = store.committedValues();
      for (const id of store.transientIds()) preset.params[id] = cv[id];
    }
    storage.set('aurora.session', { preset, key: meta.key, source: meta.source, dirty: store.isDirty() });
  }, 700);
  store.onAny(() => saveSession());
  store.onMacros(() => saveSession());
  addEventListener('beforeunload', () => { saveSession.flush(); storage.set('aurora.ui', ctx.ui); });

  const hadSession = !!storage.get('aurora.session', null); // returning user: no first-run tips
  (function restore() {
    const sess = VIDEO ? null : storage.get('aurora.session', null);
    if (sess && sess.preset && sess.preset.params) {
      const lib = sess.key ? library.get(sess.key) : null;
      if (lib && !sess.dirty) { loadEntry(lib); return; }
      // an edited library preset: load the saved preset first so it is the clean reference (editing back to it,
      // or undoing later edits past the restored state, then reads as unmodified again)
      if (lib) store.loadPreset(lib, { source: lib.source || 'factory', key: lib.key || null });
      store.loadPreset(sess.preset, { source: sess.source || 'factory', key: sess.key || null, dirty: !!sess.dirty });
      browser.setCurrent(sess.key || null);
      return;
    }
    const first = library.all().find(p => p.name === 'Aurora Pad') || library.all()[0];
    if (first) loadEntry(first);
    else initPatch();
  })();
  refreshTopbar();

  function initPatch() {
    releaseBorrowed();
    store.loadPreset({ name: 'Init', category: null, params: {}, macros: [] }, { source: 'init', record: true, dirty: false });
    browser.setCurrent(null);
  }

  /* ── undo / redo / mutate / random ── */
  // while a tour / theater borrows the patch, undo must not rewind the user's history underneath it:
  // undo ends the tour and puts the user's sound back; in theater mode it does nothing
  function borrowedUndo() {
    if (!center || store.getMeta().source !== 'demo') return false;
    if (center.theater && center.theater.isOpen()) return true;
    if (center.tours && center.tours.isActive()) { center.tours.stop({ revert: true }); return true; }
    return false;
  }
  function doUndo() { if (borrowedUndo()) return; if (store.undo()) toast(t('undone'), { ms: 900 }); }
  function doRedo() { if (borrowedUndo()) return; if (store.redo()) toast(t('redone'), { ms: 900 }); }
  function doMutate() {
    const ch = mutate(store.values, { rng: makeRng() });
    const n = store.setMany(ch, { label: 'mutate' });
    toast(`${t('mutated')} (${n})`, { kind: 'ok', ms: 1600 });
    flash(document.querySelector('.tb-btn--mutate'));
  }
  function doRandom() {
    const cat = browser.getCategory ? browser.getCategory() : null;
    const p = randomPatch({ rng: makeRng(), category: categories.some(c => c.id === cat) ? cat : undefined });
    releaseBorrowed();
    store.loadPreset(p, { record: true, source: 'random', dirty: true });
    browser.setCurrent(null);
    if (demo.playing) startDemo();
    toast(`${t('randomized')}：${p.name}`, { kind: 'ok', ms: 1800 });
    flash(document.querySelector('.tb-btn--random'));
  }
  function flash(el) { if (!el) return; el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash'); }

  /* ── phone layout: the editor below the play view (✎ 編輯 / ✓ 完成) ── */
  /** Show / hide the editor (phone layout). Showing brings it into view; hiding goes back to the play view. */
  function setEditMode(on, { scroll = true } = {}) {
    const was = document.documentElement.classList.contains('show-editor');
    document.documentElement.classList.toggle('show-editor', !!on);
    topbar.setEditing(!!on);
    if (!scroll || was === !!on) return;
    const main = editor.el.closest('.main');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    requestAnimationFrame(() => {
      if (!main) return;
      const top = on ? editor.el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 6 : 0;
      try { main.scrollTo({ top: Math.max(0, top), behavior }); } catch { main.scrollTop = Math.max(0, top); }
    });
  }

  /* ── demo (sequencer) ── */
  function phraseIdFor(meta) {
    if (!phrases) return null;
    if (meta.demo && phrases.PHRASES[meta.demo]) return meta.demo;
    const byCat = phrases.DEMO_FOR_CATEGORY && phrases.DEMO_FOR_CATEGORY[meta.category];
    return byCat && phrases.PHRASES[byCat] ? byCat : 'keys';
  }
  function startDemo() {
    // claim first: the previous owner (a sound tour, theater) puts the user's patch back before the phrase is chosen
    if (center) center.transport.claim('demo', () => stopDemo(true));
    const meta = store.getMeta();
    const id = phraseIdFor(meta);
    if (!id) { if (center) center.transport.release('demo'); toast(t('demoUnavailable'), { kind: 'warn' }); return; }
    let song = phrases.getPhrase ? phrases.getPhrase(id) : JSON.parse(JSON.stringify(phrases.PHRASES[id]));
    // macro rides: the preset's demoMacros, or a gentle automatic ride — the macro knobs move while it plays
    if (automationMod && automationMod.presetDemoSong) {
      try {
        const entry = meta.key ? library.get(meta.key) : null;
        const built = automationMod.presetDemoSong({ phrases, meta: { ...meta, demo: id }, demoMacros: entry && entry.demoMacros, macros: store.getMacros(), values: automationMod.macroValues(store) });
        if (built && built.song) song = built.song;
      } catch (e) { console.error('[aurora] demo automation failed', e); }
    }
    audio.seqStop();
    audio.seqLoad(song);
    audio.seqPlay();
    demo.startedAt = performance.now();
    demo.playing = true;
    demo.id = id;
    demo.length = song.lengthBeats || 16;
    const ph = phrases.PHRASES[id];
    topbar.setDemo(true, 0, getLang() === 'en' ? (ph.label || id) : (ph.zh || ph.label || id));
    document.documentElement.classList.add('demo-playing');
  }
  function stopDemo(fromTransport = false) {
    audio.seqStop();
    if (center && fromTransport !== true && demo.playing) center.transport.release('demo');
    demo.playing = false;
    demo.stoppedAt = performance.now();
    topbar.setDemo(false);
    document.documentElement.classList.remove('demo-playing');
  }
  function toggleDemo() {
    if (audio.isNull && !audioFailed) { startAudio().then(() => { if (!audio.isNull) startDemo(); }); return; }
    if (audio.isNull) { toast(t('audioFailedLong'), { kind: 'warn', ms: 5000 }); return; }
    if (demo.playing) stopDemo(); else startDemo();
  }

  /* ── engine state ── */
  function onState(st) {
    for (const fn of stateSubs) { try { fn(st); } catch (e) { console.error(e); } }
    dock.setActiveFromState(st);
    topbar.onState(st);
    if (demo.playing) {
      if (st.seqPlaying === false && performance.now() - demoStartGuard() > 400) { demo.playing = false; demo.stoppedAt = performance.now(); topbar.setDemo(false); document.documentElement.classList.remove('demo-playing'); if (center) center.transport.release('demo'); }
      else if (typeof st.seqBeat === 'number') topbar.setDemo(true, ((st.seqBeat % demo.length) + demo.length) % demo.length / demo.length, topbarDemoLabel());
    }
    if (st.macros && !(center && center.ownsMacros()) && (st.seqPlaying || performance.now() - demo.stoppedAt < 1500)) playView.followMacros(st.macros);
    if (center) center.onState(st);
  }
  const demoStartGuard = () => demo.startedAt;
  const topbarDemoLabel = () => { const ph = phrases && phrases.PHRASES[demo.id]; return ph ? (getLang() === 'en' ? ph.label : ph.zh) : ''; };

  /* ── input: QWERTY, MIDI, shortcuts ── */
  const qwerty = attachQwerty({
    onNoteOn: (n, v) => { if (splashUp()) { startAudio(); return; } audio.noteOn(n, v); },
    onNoteOff: n => audio.noteOff(n),
    onOctave: (d, base) => {
      dock.setQwertyBase(base);
      // keep the 1½ playable octaves visible on the on-screen keyboard
      const lo = dock.getBase();
      if (base < lo || base + 17 > lo + 48) dock.setBase(base - 12);
    },
    onVelocity: v => dock.setVelocity(v),
  });
  dock.setQwertyBase(qwerty.getBaseNote());
  dock.setVelocity(qwerty.getVelocity());
  dock.onOctave((base) => { qwerty.setBaseNote(base + 12); dock.setQwertyBase(base + 12); });

  let midiRes = null, midiBusy = null;
  async function connectMidi(user) {
    if (midiRes && midiRes.supported) {
      if (user) toast(midiRes.inputs.length ? `MIDI: ${midiRes.inputs.join(', ')}` : t('midiNone'));
      return;
    }
    if (midiBusy) return; // one requestMIDIAccess at a time (the button and a permission change can race)
    midiBusy = attachMidi({
      onNoteOn: (n, v) => { audio.noteOn(n, v); topbar.flashMidi(); },
      onNoteOff: n => audio.noteOff(n),
      onController: (kind, v) => {
        audio.setController(kind, v);
        if (kind === 'wheel') dock.setWheel(v);
        else if (kind === 'bend') dock.setBend(v);
        else if (kind === 'sustain') dock.setSustain(v > 0.5);
        topbar.flashMidi();
      },
      onDevicesChange: () => topbar.setMidi(midiRes),
    });
    try { midiRes = await midiBusy; } finally { midiBusy = null; }
    topbar.setMidi(midiRes);
    if (user && !midiRes.supported) toast(midiRes.error || t('midiUnsupported'), { kind: 'warn' });
  }
  topbar.setMidi(midiSupported() ? null : { supported: false, inputs: [], error: t(globalThis.isSecureContext === false ? 'midiNeedsHttps' : 'midiNoBrowser') });
  // Connect MIDI by itself only when the browser already allows it: requesting access shows a permission prompt
  // (Chrome 124+) or an add-on install (Firefox) on a newcomer's very first tap. Otherwise the MIDI button / ⋯
  // menu asks; allowing it later from the site settings connects right away.
  let midiWatch = null;
  async function autoConnectMidi() {
    if ((await midiPermission()) === 'granted') connectMidi(false);
    if (!midiWatch) midiWatch = watchMidiPermission((st) => { if (st === 'granted' && !(midiRes && midiRes.supported)) connectMidi(false); });
  }

  let lastEsc = 0;
  addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (splashUp() && !mod && !isTyping(e.target)) { if (e.key.length === 1 || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startAudio(); } return; }
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      if (isTyping(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { if (isTyping(e.target)) return; e.preventDefault(); doRedo(); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSave(); return; }
    if (mod || e.altKey || isTyping(e.target)) return;
    const t0 = e.target;
    const onControl = t0 && t0.closest && t0.closest('button, [role="slider"], [role="switch"], [role="radio"], [role="tab"], [role="listbox"], [role="spinbutton"], [role="option"], .ac-dd__pop');
    if (e.key === 'Escape') {
      document.documentElement.classList.remove('drawer-open');
      const now = performance.now();
      if (now - lastEsc < 450) panic();
      lastEsc = now;
      return;
    }
    if (onControl) return;
    if (e.key === ' ') { e.preventDefault(); if (center && center.handleSpace()) return; toggleDemo(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); browser.step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); browser.step(-1); }
    else if (e.key === '/') { e.preventDefault(); document.documentElement.classList.add('drawer-open'); browser.focusSearch(); }
    else if (e.key === '?') { e.preventDefault(); openHelp(); }
  });

  function panic() {
    if (center) center.stopAll();
    stopDemo();
    audio.allNotesOff(true);
    dock.releaseAll();
    qwerty.releaseAll();
    // the engine's all-off drops the sustain pedal: the Hold button must say so (it stayed lit, needing two
    // clicks to sustain again); a pitch bend / aftertouch latched by a MIDI device is reset too
    dock.setSustain(false);
    audio.setController('bend', 0);
    audio.setController('aftertouch', 0);
    dock.setBend(0);
    toast(t('panicDone'), { ms: 1200 });
  }

  /* ── language ── */
  onLangChange(() => {
    editor.rebuild();
    playView.rebuild();
    browser.render();
    topbar.renderLang();
    refreshTopbar();
    if (demo.playing) topbar.setDemo(true, 0, topbarDemoLabel());
    if (center) center.renderLang();
  });

  /* ── save / export / import ── */
  let saveDlg = null; // one Save dialog at a time (⌘S twice used to stack two)
  function openSave() {
    if (saveDlg) { const i = saveDlg.el.querySelector('input'); if (i) i.focus(); return; }
    const meta = store.getMeta();
    const name = h('input.field__input', { type: 'text', value: meta.name, maxlength: 60, required: true });
    const cat = h('select.field__input', null, ...categories.map(c => h('option', { value: c.id, selected: c.id === (meta.category || 'fx') || undefined }, getLang() === 'en' ? `${c.label} ${c.zh}` : `${c.zh} ${c.label}`)));
    const tags = h('input.field__input', { type: 'text', value: (meta.tags || []).join(', '), maxlength: 120 });
    const desc = h('textarea.field__input', { rows: 2, maxlength: 300 }, meta.description || '');
    const form = h('form.form', null,
      h('label.field', null, h('span.field__lbl', null, t('name')), name),
      h('label.field', null, h('span.field__lbl', null, t('category')), cat),
      h('label.field', null, h('span.field__lbl', null, t('tags')), tags),
      h('label.field', null, h('span.field__lbl', null, t('description')), desc));
    let busy = false;
    const doSave = async (close) => {
      if (busy) return false; // an overwrite question is already open
      const nm = name.value.trim();
      if (!nm) { name.focus(); name.classList.add('is-invalid'); return false; }
      if (library.hasUser(nm) && !(meta.source === 'user' && meta.name === nm)) {
        busy = true;
        const ok = await confirmDialog(t('overwrite'));
        busy = false;
        if (!ok) return false;
      }
      const preset = store.toPreset({ name: nm, category: cat.value, tags: tags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean), description: desc.value.trim(), demo: meta.demo || null });
      const entry = library.saveUser(preset);
      if (!entry) { toast(t('storageFull'), { kind: 'error' }); return false; }
      store.setMeta({ name: entry.name, category: entry.category, tags: entry.tags, description: entry.description, source: 'user', key: entry.key });
      store.markClean();
      browser.setCurrent(entry.key);
      saveSession();
      toast(t('saved'), { kind: 'ok' });
      close();
      return true;
    };
    const m = openModal({
      title: t('savePreset'), content: form, cls: 'modal--save',
      actions: [{ label: t('cancel'), kind: 'ghost' }, { label: t('save'), kind: 'primary', onClick: (close) => { doSave(close); return false; } }],
      onClose: () => { saveDlg = null; },
    });
    saveDlg = m;
    form.addEventListener('submit', (e) => { e.preventDefault(); doSave(m.close); });
  }

  function exportJson() {
    const p = store.toPreset();
    const blob = new Blob([JSON.stringify({ format: 'aurora-preset', version: 1, ...p }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${(p.name || 'preset').replace(/[^\w一-鿿-]+/g, '_')}.aurora.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(t('exported'), { kind: 'ok', ms: 1400 });
  }
  function importJson() {
    const inp = h('input', { type: 'file', accept: '.json,application/json', multiple: true, style: 'display:none' });
    document.body.append(inp);
    inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])];
      inp.remove();
      // collect everything first, then ONE storage write + ONE browser re-render (was one per preset: O(n²))
      const batch = [];
      const taken = new Set(library.user().map(p => p.name));
      for (const f of files) {
        try {
          const data = JSON.parse(await f.text());
          const { presets } = parsePresetFile(data);
          for (const p of presets) {
            let nm = p.name, k = 2;
            while (taken.has(nm)) nm = `${p.name} (${k++})`;
            taken.add(nm);
            batch.push({ ...p, name: nm });
          }
        } catch (e) { console.error(e); }
      }
      if (!batch.length) { toast(t('importFailed'), { kind: 'error' }); return; }
      const saved = library.saveMany(batch);
      if (!saved) { toast(t('importStorageFull'), { kind: 'error', ms: 5000 }); return; }
      toast(`${t('imported')} ×${saved.length}`, { kind: 'ok' });
      loadEntry(saved[0]);
    });
    inp.click();
  }

  let helpDlg = null;
  function openHelp() {
    if (helpDlg) return;
    const rows = [
      ['A W S E D F T G Y H U J K O L P ; \'', getLang() === 'en' ? 'Play notes (computer keyboard)' : '電腦鍵盤彈奏'],
      ['Z / X', getLang() === 'en' ? 'Octave down / up' : '降 / 升八度'],
      ['C / V', getLang() === 'en' ? 'Velocity down / up' : '降 / 升力度'],
      ['Space', getLang() === 'en' ? 'Play / stop the demo phrase' : '播放 / 停止示範樂句'],
      ['← / →', getLang() === 'en' ? 'Previous / next preset' : '上一個 / 下一個音色'],
      ['/', getLang() === 'en' ? 'Search presets' : '搜尋音色'],
      ['⌘/Ctrl Z · ⇧⌘Z', getLang() === 'en' ? 'Undo · Redo' : '復原 · 重做'],
      ['⌘/Ctrl S', getLang() === 'en' ? 'Save preset' : '儲存音色'],
      ['Esc Esc', getLang() === 'en' ? 'Panic (all notes off)' : '全部靜音'],
      [getLang() === 'en' ? 'Knobs' : '旋鈕', getLang() === 'en' ? 'Drag ↕ · Shift = fine · double-click = default · wheel · arrows' : '上下拖曳 · Shift 微調 · 雙擊回預設 · 滾輪 · 方向鍵'],
      [getLang() === 'en' ? 'Outer arc' : '外圈亮弧', getLang() === 'en' ? 'Modulation / macro range on a knob' : '旋鈕的調變 / 巨集範圍'],
      [getLang() === 'en' ? 'M1–M4 macros' : 'M1–M4 巨集', getLang() === 'en' ? 'One knob moves several settings at once — hover (or tap M1…M4) to see which' : '一顆旋鈕同時調整好幾個參數 — 滑過（或點 M1…M4）看它控制什麼'],
      [getLang() === 'en' ? 'Mutate · Random' : '突變 · 隨機', getLang() === 'en' ? 'Small variations of this sound · a brand-new sound (both undoable)' : '把目前音色微調出變化 · 生成全新音色（都可以復原）'],
      [getLang() === 'en' ? 'Demo Center' : '示範中心', getLang() === 'en' ? 'Demo songs, sound tours, auto-jam, magic tools and theater mode' : '示範曲、音色導覽、自動演奏、魔法調音與劇院模式'],
      [getLang() === 'en' ? 'Hover a knob' : '滑過旋鈕', getLang() === 'en' ? 'A short explanation of what it does' : '顯示這個參數的白話說明'],
      ...(isAppleMobile() ? [['iPhone / iPad', getLang() === 'en' ? 'Sound plays even with the silent switch on' : '靜音開關開啟時仍可發聲']] : []),
    ];
    helpDlg = openModal({
      onClose: () => { helpDlg = null; },
      title: t('helpTitle'), cls: 'modal--help',
      content: h('div.help', null, h('table.help__table', null, ...rows.map(([k, v]) => h('tr', null, h('th', null, h('kbd', null, k)), h('td', null, v))))),
      actions: [{ label: t('coachShow'), kind: 'ghost', onClick: () => { setTimeout(() => showCoach(true), 240); } }, { label: t('ok'), kind: 'primary' }],
    });
  }

  /* ── first-run tips: play · macros · Demo Center (dismissible, re-open from Help) ── */
  let coachEl = null;
  function showCoach(force = false) {
    if (coachEl) return;
    if (!force && (VIDEO || storage.get('aurora.coachSeen', false))) return;
    const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    const step = (n, txt, onClick) => {
      const li = h('li.coach__step', null, h('b.coach__n', { 'aria-hidden': 'true' }, String(n)), h('span', null, txt));
      if (onClick) { const b = h('button.coach__go', { type: 'button' }, t('coachTry')); b.addEventListener('click', onClick); li.append(b); }
      return li;
    };
    const done = h('button.btn.btn--primary.coach__ok', { type: 'button' }, t('coachOk'));
    const x = h('button.icon-btn.coach__x', { type: 'button', 'aria-label': t('close'), title: t('close') }, '✕');
    coachEl = h('aside.coach', { role: 'dialog', 'aria-modal': 'false', 'aria-label': t('coachTitle') },
      h('div.coach__head', null, h('span.coach__title', null, t('coachTitle')), x),
      h('ol.coach__list', null,
        step(1, t(touch ? 'coachPlayTouch' : 'coachPlay')),
        step(2, t('coachMacros')),
        step(3, t('coachCenter'), center ? () => { close(); center.open('songs'); } : null)),
      done);
    function close() {
      if (!coachEl) return;
      storage.set('aurora.coachSeen', true);
      const el = coachEl;
      coachEl = null;
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 300);
    }
    done.addEventListener('click', close);
    x.addEventListener('click', close);
    document.body.append(coachEl);
    requestAnimationFrame(() => coachEl && coachEl.classList.add('is-in'));
  }

  /* ── audio start (splash) ── */
  const splash = document.getElementById('splash');
  const splashUp = () => !!(splash && !splash.classList.contains('is-out'));
  let starting = null;
  function dismissSplash() {
    if (!splash || splash.classList.contains('is-out')) return;
    splash.classList.add('is-out');
    setTimeout(() => { splash.hidden = true; }, 900);
  }
  function startAudio() {
    if (starting) return starting;
    if (!audio.isNull) return Promise.resolve();
    if (splash) splash.classList.add('is-loading');
    starting = (async () => {
      try {
        const a = await createAudio();
        audio = a;
        audioFailed = false;
        store.attach(sink);
        a.onState(onState);
        a.onError(msg => toast(`${t('audioError')}: ${String(msg).split('\n')[0].slice(0, 140)}`, { kind: 'error' }));
        playView.mountVisuals(a, visuals);
        topbar.mountMeter(visuals, () => a.getState());
        topbar.setAudioStatus('ok');
        audioError = '';
        attachResumePrompt(a); // iOS call / Siri / background: "聲音已暫停 — 點一下恢復"
        const cpuEl = topbar.el.querySelector('.tb-perf .cpu:not(.voices)');
        if (cpuEl) cpuEl.title = `CPU · ${+(a.sampleRate / 1000).toFixed(1)} kHz`;
        autoConnectMidi();
      } catch (e) {
        console.error('[aurora] audio start failed', e);
        audioFailed = true;
        audioError = String(e && e.message ? e.message : e).slice(0, 300);
        topbar.setAudioStatus('error');
        // plain words + what to do; the technical reason stays in the console and behind 詳細資訊 (Demo Center)
        toast(t('audioFailedLong'), { kind: 'error', ms: 9000 });
      } finally {
        dismissSplash();
        starting = null;
        if (center && center.audioChanged) center.audioChanged();
        if (!hadSession) setTimeout(() => showCoach(), 1300); // first visit: three quick tips once the splash is gone
      }
    })();
    return starting;
  }
  if (splash) {
    const btn = splash.querySelector('.splash__start');
    (btn || splash).addEventListener('click', () => startAudio());
    splash.addEventListener('pointerdown', (e) => { if (e.target === splash) startAudio(); });
    applySplashCompat(splash); // http://<LAN-IP>: say up front that sound needs https; no "MIDI" hint without Web MIDI
    splash.classList.add('is-ready');
  }
  topbar.setAudioStatus('off');

  // expose for debugging in the console
  try {
    const raw = sessionStorage.getItem('aurora.mcp.toSynth');
    if (raw) {
      sessionStorage.removeItem('aurora.mcp.toSynth');
      const { validatePatch, validateParams } = await import('../creation/project.js');
      const value = JSON.parse(raw);
      validatePatch(value.patch); validateParams(value.globals || {}, 'global');
      store.loadPreset(value.patch, { source: 'mcp-studio', record: true, dirty: true });
      if (value.globals) store.setMany(value.globals);
    }
  } catch (e) { toast('MCP studio import: ' + e.message, { kind: 'warn' }); }

  // expose for debugging in the console
  globalThis.aurora = { store, library, get audio() { return audio; }, editor, startDemo, stopDemo, get center() { return center; } };

  // video recorder only (?video=1): hand the internals to the capture hook, which builds window.__aurora
  if (VIDEO) {
    const internals = {
      store, library, categories, presets: factory, songsModule: () => import('../demo/songs/index.js'),
      getAudio: () => audio, getCenter: () => center, loadEntry, initPatch, startAudio, dismissSplash, splashUp,
      startDemo, stopDemo, panic, setEditMode, playView, editor, dock, topbar, browser, qwerty,
    };
    import('../../tools/video/capture/app-hook.js')
      .then(m => m.install(internals))
      .catch(e => console.error('[aurora] video hook failed', e));
  }
}

boot().catch((e) => {
  console.error('[aurora] boot failed', e);
  const el = document.getElementById('splash');
  if (el) el.classList.add('is-error');
  const msg = document.querySelector('.splash__status');
  if (msg) msg.textContent = `啟動失敗 Boot failed: ${e && e.message ? e.message : e}`;
  offerStorageReset(el && el.querySelector('.splash__content'));
});

/**
 * Last resort after a failed boot: saved data from an older build (or a hand edit) must not brick the app.
 * Downloads a backup of every aurora.* localStorage key, clears them and reloads.
 */
function offerStorageReset(host) {
  let keys = [];
  try { keys = Object.keys(localStorage).filter(k => k.startsWith('aurora.')); } catch { return; }
  if (!host || !keys.length || host.querySelector('.splash__reset')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'splash__reset';
  btn.textContent = '清除已儲存的資料並重新載入 · Reset saved data & reload';
  btn.addEventListener('click', () => {
    if (!confirm('會先下載一份備份，再清除 AURORA 在這個瀏覽器儲存的音色與設定。\nA backup is downloaded first, then AURORA\'s saved presets and settings are cleared.')) return;
    try {
      const backup = {};
      for (const k of keys) backup[k] = localStorage.getItem(k);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      a.download = `aurora-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a); a.click(); a.remove();
      for (const k of keys) localStorage.removeItem(k);
    } catch (err) { console.error(err); }
    setTimeout(() => location.reload(), 400);
  });
  host.append(btn);
}
