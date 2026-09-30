// Demo Center 示範中心: a large glass sheet over the app (the keyboard dock stays visible and playable) with
// tabs 示範曲 Songs | 音色導覽 Sound Tours | 自動演奏 Jam | 魔法調音 Magic | 劇院模式 Theater, a live aurora
// visual behind it, and a floating "now playing" pill while something plays with the sheet closed.
// Also owns the transport arbiter (only one of: preset demo / song / tour / jam / theater plays at a time).
//
//   const center = createDemoCenter({ store, getAudio, editor, playView, presets, categories, visuals, phrases,
//                                     library, loadEntry, toast, stopDemo });
//   center.open('songs'); center.close(); center.onState(engineState); center.transport.claim('demo', stopFn);

import { h } from '../app/dom.js';
import { t, getLang, applyI18n } from '../app/i18n.js';
import { icon as appIcon, ICONS } from '../app/icons.js';
import { createTourPlayer } from './tourPlayer.js';
import { createToursView } from './toursView.js';
import { createSongsView } from './songsView.js';
import { createTheater } from './theater.js';

/* ═════════════════════════════ icons (demo-only additions, same 24×24 stroke style) ═════════════════════════════ */
const F = 'fill="currentColor" stroke="none"';
const DEMO_ICONS = {
  pause: `<rect x="6.5" y="5" width="3.8" height="14" rx="1.2" ${F}/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2" ${F}/>`,
  sparkle: '<path d="M12 2.8l1.9 5.6 5.6 1.9-5.6 1.9L12 17.8l-1.9-5.6-5.6-1.9 5.6-1.9z"/><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  songs: `<path d="M9 17.5V6l10.5-2.2v11.2"/><circle cx="6.6" cy="17.6" r="2.6"/><circle cx="17" cy="15.1" r="2.6"/><path d="M9 9.6l10.5-2.2"/>`,
  tours: '<circle cx="12" cy="12" r="8.8"/><path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  jam: '<rect x="3.5" y="6" width="17" height="12" rx="3"/><circle cx="8.5" cy="12" r="1.3" fill="currentColor"/><circle cx="15.5" cy="12" r="1.3" fill="currentColor"/><path d="M12 6V3.5M9 3.5h6"/><path d="M1.5 11v2M22.5 11v2"/>',
  magic: '<path d="M4 20L15.5 8.5"/><path d="M14 4.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/><path d="M19.5 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/><path d="M9 3.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/>',
  theater: '<rect x="2.8" y="4.5" width="18.4" height="12.5" rx="2.2"/><path d="M8.5 20.5h7M12 17v3.5"/><path d="M10.2 8.3v5l4.3-2.5z" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shuffle: '<path d="M3.5 7h3.3c4.6 0 5.8 10 10.4 10h3.3"/><path d="M3.5 17h3.3c1.6 0 2.8-1.2 3.8-2.8M13.4 9.8c1-1.6 2.2-2.8 3.8-2.8h3.3"/><path d="M18 4.5l2.5 2.5-2.5 2.5M18 14.5l2.5 2.5-2.5 2.5"/>',
  keysPlay: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 13.5V19M12 13.5V19M16.5 13.5V19"/><rect x="6.3" y="5" width="2.4" height="8.5" rx=".5" fill="currentColor" stroke="none"/><rect x="10.8" y="5" width="2.4" height="8.5" rx=".5" fill="currentColor" stroke="none"/><rect x="15.3" y="5" width="2.4" height="8.5" rx=".5" fill="currentColor" stroke="none"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  solo: '<circle cx="12" cy="12" r="8.6"/><path d="M14.6 9.2c-.5-1-1.5-1.6-2.7-1.6-1.6 0-2.7.9-2.7 2.1 0 2.9 5.6 1.7 5.6 4.6 0 1.3-1.2 2.2-2.9 2.2-1.3 0-2.4-.6-2.9-1.7"/>',
  wave: '<path d="M2.5 12c1.6-5 3.2-5 4.8 0s3.2 5 4.8 0 3.2-5 4.8 0 3.2 5 4.6 0"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.5V12l3 2"/>',
  steps: '<path d="M4 18.5h4v-4h4v-4h4v-4h4"/><circle cx="4" cy="18.5" r="1" fill="currentColor"/>',
};

/** Icon element: demo icons first, then the app icon set. */
export function dIcon(name, size = 18, cls = '') {
  if (!DEMO_ICONS[name]) return appIcon(name, size, cls);
  const e = document.createElement('span');
  e.className = `ic-wrap ${cls}`.trim();
  e.innerHTML = `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${DEMO_ICONS[name]}</svg>`;
  return e;
}
export const hasIcon = n => !!(DEMO_ICONS[n] || ICONS[n]);

/* ═════════════════════════════ transport arbiter ═════════════════════════════ */
/** Only one demo source plays at a time: claiming stops the previous owner (its stop callback runs). */
export function createTransport() {
  let owner = null;
  const subs = new Set();
  const emit = () => { for (const fn of subs) { try { fn(owner ? owner.kind : null); } catch (e) { console.error(e); } } };
  return {
    claim(kind, stop) {
      if (owner && owner.kind !== kind) {
        const o = owner;
        owner = null;
        try { o.stop(); } catch (e) { console.error(e); }
      }
      owner = { kind, stop };
      emit();
    },
    release(kind) { if (owner && (!kind || owner.kind === kind)) { owner = null; emit(); } },
    stopAll() { if (owner) { const o = owner; owner = null; try { o.stop(); } catch (e) { console.error(e); } emit(); } },
    get kind() { return owner ? owner.kind : null; },
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/* ═════════════════════════════ live audio proxy ═════════════════════════════ */
/**
 * An audio-shaped object that always forwards to the current engine (the real one is created after the
 * splash). onState() subscriptions survive the swap. `onPlay(method)` runs before seq/song playback starts,
 * so panels that play something claim the transport.
 */
function liveAudio(getAudio, stateSubs, onPlay, onSilent = null) {
  const PLAY = new Set(['seqPlay', 'songPlay']);
  return new Proxy({}, {
    get(_, k) {
      if (k === 'onState') return (cb) => { stateSubs.add(cb); return () => stateSubs.delete(cb); };
      if (k === 'isLive') return true;
      const a = getAudio();
      const v = a ? a[k] : undefined;
      if (typeof v !== 'function') return v;
      if (PLAY.has(k)) {
        return (...args) => {
          // no engine (it failed to start): say so instead of "playing" in silence
          if (a.isNull) { if (onSilent) onSilent(); return undefined; }
          try { onPlay(k); } catch (e) { console.error(e); }
          return v.apply(a, args);
        };
      }
      return v.bind(a);
    },
    has(_, k) { const a = getAudio(); return k === 'onState' || !!(a && k in a); },
  });
}

async function tryImport(spec) {
  try { return await import(spec); } catch (e) { console.warn(`[aurora demo] optional module ${spec} unavailable:`, e && e.message ? e.message : e); return null; }
}

const TABS = [
  { id: 'songs', key: 'dcSongs', desc: 'dcSongsDesc', icon: 'songs', accent: 'var(--a-cyan)' },
  { id: 'tours', key: 'dcTours', desc: 'dcToursDesc', icon: 'tours', accent: 'var(--a-teal)' },
  { id: 'jam', key: 'dcJam', desc: 'dcJamDesc', icon: 'jam', accent: 'var(--a-amber)' },
  { id: 'magic', key: 'dcMagic', desc: 'dcMagicDesc', icon: 'magic', accent: 'var(--a-violet)' },
  { id: 'theater', key: 'dcTheater', desc: 'dcTheaterDesc', icon: 'theater', accent: 'var(--a-pink)' },
];

/**
 * @param {{ store, getAudio: () => object, editor, playView, presets: object[], categories: object[], visuals,
 *           phrases, library, loadEntry: (entry, opts) => void, toast, stopDemo?: () => void }} ctx
 */
export function createDemoCenter(ctx) {
  const { store, getAudio } = ctx;
  const transport = createTransport();
  const stateSubs = new Set();
  const panels = {}; // jam / smart / evolve / morph instances
  // each panel family gets its own live audio: when it starts playback it becomes the transport owner
  const audioFor = kind => liveAudio(getAudio, stateSubs, () => transport.claim(kind, () => stopPanels(kind)), () => audioGate());
  const audio = audioFor('magic');
  const jamAudio = audioFor('jam');
  function stopPanels(kind) {
    const list = kind === 'jam' ? [panels.jam] : [panels.smart, panels.evolve, panels.morph];
    for (const p of list) {
      if (!p) continue;
      for (const fn of ['stop', 'stopAuto']) if (typeof p[fn] === 'function') { try { p[fn](); } catch (e) { console.error(e); } }
    }
    const a = getAudio();
    if (a && kind === 'jam') { try { a.seqStop(); } catch { /* ignore */ } }
  }

  let songsData = null; // { SONGS, resolveSong, songDuration } once loaded

  /* ── tour player, theater ── */
  const tours = createTourPlayer({
    store, getAudio, editor: ctx.editor, playView: ctx.playView, presets: ctx.presets || [], transport, toast: ctx.toast,
    setEditorShown: ctx.setEditorShown || null,
  });
  const theater = createTheater({
    store, getAudio, presets: ctx.presets || [], categories: ctx.categories || [], visuals: ctx.visuals, phrases: ctx.phrases,
    library: ctx.library, loadEntry: ctx.loadEntry, transport, playView: ctx.playView, toast: ctx.toast,
    songsData: () => songsData, audioGate: () => audioGate(),
  });

  /* ── audio engine status: demos need a running engine ── */
  const audioState = () => {
    const a = getAudio();
    if (a && !a.isNull) return { state: 'ok', error: '' };
    return ctx.audioStatus ? ctx.audioStatus() : { state: 'off', error: '' };
  };
  const bannerMsg = h('span.dc-audio__msg');
  const bannerRetry = h('button.btn.btn--primary.dc-audio__retry', { type: 'button' }, dIcon('loop', 14), h('span'));
  const bannerDetail = h('code.dc-audio__code');
  const bannerSum = h('summary');
  const banner = h('div.dc-audio', { role: 'alert', hidden: true },
    h('span.dc-audio__ic', { 'aria-hidden': 'true' }, dIcon('mute', 18)),
    h('div.dc-audio__txt', null, bannerMsg, h('details.dc-audio__more', null, bannerSum, bannerDetail)),
    bannerRetry);
  bannerRetry.addEventListener('click', () => {
    if (!ctx.retryAudio) return;
    bannerRetry.disabled = true;
    Promise.resolve(ctx.retryAudio()).finally(() => { bannerRetry.disabled = false; updAudio(); });
  });
  function updAudio() {
    const st = audioState();
    banner.hidden = st.state !== 'failed';
    if (banner.hidden) return;
    bannerMsg.textContent = t('audioFailedDemo');
    bannerRetry.lastChild.textContent = t('audioRetry');
    bannerSum.textContent = t('audioDetails');
    bannerDetail.textContent = st.error || '—';
    bannerDetail.parentElement.hidden = !st.error;
  }
  /**
   * Before a demo plays: true when the engine runs. Otherwise explains (engine failed → the banner + a toast
   * that says so, with a retry) or starts it (never started: this click is the user gesture) and returns false.
   */
  let lastGateToast = 0;
  function audioGate() {
    const st = audioState();
    if (st.state === 'ok') return true;
    if (st.state === 'failed' || !ctx.retryAudio) {
      updAudio();
      const now = performance.now();
      if (ctx.toast && now - lastGateToast > 1500) { lastGateToast = now; ctx.toast(t(st.state === 'failed' ? 'audioFailedDemo' : 'songNeedsAudio'), { kind: 'warn', ms: 4200 }); }
    } else ctx.retryAudio();
    return false;
  }

  /* ── sheet DOM ── */
  const bgHost = h('div.dc__hero', { 'aria-hidden': 'true' });
  const sky = h('div.dc__sky', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  const titleMain = h('span.dc__titleMain');
  const titleSub = h('span.dc__titleSub');
  const tagline = h('p.dc__tagline');
  const brand = h('div.dc__brand', null, h('span.dc__mark', { 'aria-hidden': 'true' }), h('h2.dc__title', { id: 'dc-title' }, titleMain, titleSub));
  const nav = h('nav.dc__tabs', { role: 'tablist', 'aria-label': 'Demo Center' });
  const ind = h('span.dc__ind', { 'aria-hidden': 'true' });
  const closeBtn = h('button.icon-btn.dc__close', { type: 'button' }, dIcon('x', 18));
  closeBtn.addEventListener('click', () => close());
  const head = h('header.dc__head', null, h('div.dc__headL', null, brand, tagline), nav, closeBtn);
  const body = h('div.dc__body');
  const sheet = h('div.dc__sheet', null, head, banner, body);
  const el = h('div.dc', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'dc-title', hidden: true }, sky, bgHost, h('div.dc__veil', { 'aria-hidden': 'true' }), sheet);

  const tabState = {};
  for (const tb of TABS) {
    const main = h('span.dc-tab__main');
    const sub = h('span.dc-tab__sub');
    const b = h('button.dc-tab', { type: 'button', role: 'tab', id: `dc-tab-${tb.id}`, 'aria-controls': `dc-panel-${tb.id}`, '--acc': tb.accent, 'data-tab': tb.id },
      h('span.dc-tab__ic', null, dIcon(tb.icon, 18)), h('span.dc-tab__txt', null, main, sub), h('span.dc-tab__live', { 'aria-hidden': 'true' }));
    b.addEventListener('click', () => select(tb.id, true));
    const panel = h('section.dc-panel', { role: 'tabpanel', id: `dc-panel-${tb.id}`, 'aria-labelledby': `dc-tab-${tb.id}`, hidden: true, '--acc': tb.accent });
    tabState[tb.id] = { btn: b, panel, main, sub, built: false, tab: tb };
    nav.append(b);
    body.append(panel);
  }
  nav.append(ind);
  nav.addEventListener('keydown', (e) => {
    const ids = TABS.map(x => x.id);
    let i = ids.indexOf(current);
    if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = ids.length - 1;
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    select(ids[i], true);
    tabState[ids[i]].btn.focus();
  });

  /* ── now-playing pill ── */
  const pillIc = h('span.np__ic', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  const pillKind = h('span.np__kind');
  const pillTitle = h('span.np__title');
  const pillSub = h('span.np__sub');
  const pillRing = h('span.np__ring', { 'aria-hidden': 'true' });
  const pillOpen = h('button.np__open', { type: 'button' }, pillIc, h('span.np__txt', null, h('span.np__row', null, pillKind, pillSub), pillTitle));
  const pillStop = h('button.np__stop', { type: 'button' }, pillRing, dIcon('stop', 14));
  const pill = h('div.np', { role: 'status', hidden: true }, pillOpen, pillStop);
  pillOpen.addEventListener('click', () => open(transport.kind === 'jam' ? 'jam' : transport.kind === 'magic' ? 'magic' : 'songs'));
  pillStop.addEventListener('click', () => transport.stopAll());

  /* ── songs / tours views ── */
  const songsView = createSongsView({
    store, getAudio, transport, presets: ctx.presets || [], library: ctx.library, loadEntry: ctx.loadEntry, toast: ctx.toast,
    categories: ctx.categories || [], getData: () => songsData, onPlayAlong: () => {}, onUseSound: () => {}, audioGate: () => audioGate(),
  });
  const toursView = createToursView({
    tours: null, // loading
    onStart: (tour) => { if (!audioGate()) return; close(); setTimeout(() => tours.start(tour), 120); }, player: tours, categories: ctx.categories || [],
  });
  // tours do not wait for the (larger) song data: each list shows as soon as its own module is in
  const toursReady = tryImport('../../demo/tours/index.js').then((toursMod) => {
    toursView.setTours(toursMod && toursMod.TOURS ? toursMod.TOURS : []);
  });
  const dataReady = (async () => {
    const [songsMod, resolveMod] = await Promise.all([tryImport('../../demo/songs/index.js'), tryImport('../../demo/resolve.js')]);
    if (songsMod && resolveMod && (songsMod.SONGS || songsMod.default)) {
      songsData = { SONGS: songsMod.SONGS || songsMod.default, resolveSong: resolveMod.resolveSong, songDuration: resolveMod.songDuration, sectionAt: resolveMod.sectionAt };
    }
    songsView.dataChanged();
    await toursReady;
  })();

  /* ── lazy panels ── */
  async function buildPanel(id) {
    const s = tabState[id];
    if (s.built) return;
    s.built = true;
    const intro = h('div.dc-intro', null, h('p.dc-intro__txt', { 'data-i18n': s.tab.desc }, t(s.tab.desc)));
    s.panel.append(intro);
    if (id === 'songs') { s.panel.append(songsView.el); return; }
    if (id === 'tours') { s.panel.append(toursView.el); return; }
    if (id === 'theater') { s.panel.append(theater.launcherEl); return; }
    const host = h('div.dc-mount');
    s.panel.append(host);
    const args = { store, audio, presets: ctx.presets || [], categories: ctx.categories || [] };
    if (id === 'jam') {
      const mod = await tryImport('./jam.js');
      mountOne(host, mod, 'createJamPanel', 'jam', { ...args, audio: jamAudio }, { title: 'dcJam', icon: 'jam', bare: true });
    } else if (id === 'magic') {
      host.classList.add('dc-mount--magic');
      const [sm, ev, mo] = await Promise.all([tryImport('./smart.js'), tryImport('./evolve.js'), tryImport('./morph.js')]);
      // the magic panels bring their own headers (css/demo-tools.css); only placeholders get a card
      mountOne(host, sm, 'createSmartPanel', 'smart', args, { title: 'magicSmart', icon: 'magic', bare: true });
      mountOne(host, ev, 'createEvolvePanel', 'evolve', args, { title: 'magicEvolve', icon: 'wave', bare: true });
      mountOne(host, mo, 'createMorphPanel', 'morph', args, { title: 'magicMorph', icon: 'sparkle', bare: true });
    }
  }
  function mountOne(host, mod, factory, key, args, { title, icon: ic, bare = false }) {
    const fn = mod && mod[factory];
    // a single full-width panel (Jam) brings its own chrome; the Magic trio sits in titled cards
    const card = bare && typeof fn === 'function' ? h('div.dc-bare', { 'data-panel': key })
      : h('div.dc-card', { 'data-panel': key }, h('header.dc-card__head', null, h('span.dc-card__ic', null, dIcon(ic, 17)), h('h3.dc-card__title', { 'data-i18n': title }, t(title))));
    host.append(card);
    if (typeof fn !== 'function') {
      card.classList.add('is-soon');
      card.append(h('div.dc-soon', null, dIcon('sparkle', 26), h('p', { 'data-i18n': 'dcSoon' }, t('dcSoon'))));
      return;
    }
    try {
      const inst = fn(args);
      panels[key] = inst;
      card.append(inst.el);
    } catch (e) {
      console.error(`[aurora demo] ${factory} failed`, e);
      card.classList.add('is-soon');
      card.append(h('div.dc-soon', null, dIcon('panic', 22), h('p', null, `${t('dcPanelFailed')}: ${String(e && e.message ? e.message : e).slice(0, 120)}`)));
    }
  }

  /* ── tabs ── */
  let current = null;
  try { current = localStorage.getItem('aurora.dcTab'); } catch { /* ignore */ }
  if (!tabState[current]) current = 'songs';
  function moveIndicator() {
    const b = tabState[current] && tabState[current].btn;
    if (!b || !b.offsetWidth) return;
    ind.style.transform = `translateX(${b.offsetLeft}px)`;
    ind.style.width = `${b.offsetWidth}px`;
    ind.style.setProperty('--acc', tabState[current].tab.accent);
  }
  function select(id, user) {
    if (!tabState[id]) return;
    const prev = current;
    current = id;
    try { localStorage.setItem('aurora.dcTab', id); } catch { /* ignore */ }
    buildPanel(id);
    for (const k in tabState) {
      const s = tabState[k];
      const on = k === id;
      s.btn.classList.toggle('is-on', on);
      s.btn.setAttribute('aria-selected', String(on));
      s.btn.tabIndex = on ? 0 : -1;
      s.panel.hidden = !on;
    }
    el.style.setProperty('--acc', tabState[id].tab.accent);
    const p = tabState[id].panel;
    if (user && prev !== id) {
      p.classList.remove('is-entering');
      void p.offsetWidth;
      p.classList.add('is-entering');
      setTimeout(() => p.classList.remove('is-entering'), 450);
      body.scrollTop = 0;
    }
    songsView.setVisible(isOpen && id === 'songs');
    toursView.setVisible(isOpen && id === 'tours');
    theater.setLauncherVisible(isOpen && id === 'theater');
    moveIndicator();
  }

  /* ── stage hero (live visual behind the sheet) ── */
  let hero = null;
  function ensureHero() {
    const a = getAudio();
    if (hero || !a || !a.analyser || !ctx.visuals || !ctx.visuals.createHeroVisualizer) return;
    try {
      hero = ctx.visuals.createHeroVisualizer({ analyser: a.analyser, analyserL: a.analyserL, analyserR: a.analyserR, getState: () => a.getState() });
      bgHost.append(hero.el);
      if (hero.setPalette) hero.setPalette('aurora');
    } catch (e) { console.error('[aurora demo] hero failed', e); hero = null; }
  }

  /* ── open / close ── */
  let isOpen = false;
  let prevFocus = null;
  function open(tab) {
    if (tab && tabState[tab]) select(tab, isOpen);
    if (isOpen) return;
    isOpen = true;
    prevFocus = document.activeElement;
    el.hidden = false;
    document.documentElement.classList.add('dc-open');
    setCoveredInert(true);
    updAudio();
    ensureHero();
    if (hero) hero.start();
    if (ctx.playView && ctx.playView.setHeroPaused) ctx.playView.setHeroPaused('dc', true);
    requestAnimationFrame(() => { el.classList.add('is-in'); moveIndicator(); });
    select(current, false);
    updPill();
    setTimeout(() => { const b = tabState[current].btn; if (b && el.contains(document.activeElement) === false) b.focus({ preventScroll: true }); }, 60);
    if (ctx.onOpenChange) ctx.onOpenChange(true);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove('is-in');
    document.documentElement.classList.remove('dc-open');
    setCoveredInert(false);
    songsView.setVisible(false);
    toursView.setVisible(false);
    theater.setLauncherVisible(false);
    setTimeout(() => { if (!isOpen) { el.hidden = true; if (hero) hero.stop(); } }, 380);
    if (ctx.playView && ctx.playView.setHeroPaused) ctx.playView.setHeroPaused('dc', false);
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    updPill();
    if (ctx.onOpenChange) ctx.onOpenChange(false);
  }

  /**
   * The sheet covers the top bar, preset drawer and editor: while it is open they are inert, so Tab never
   * walks onto hidden controls (the keyboard dock stays visible and playable, so it stays reachable).
   */
  function setCoveredInert(on) {
    for (const sel of ['#app > .topbar', '#app > .sidebar', '#app > .main', '#app > .scrim']) {
      const e = document.querySelector(sel);
      if (e) e.inert = !!on;
    }
  }

  /* ── keyboard (capture phase: runs before main.js's shortcuts) ── */
  function onKey(e) {
    if (theater.isOpen()) return; // theater has its own handler
    if (!isOpen) return;
    const typing = e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === 'Escape') {
      if (document.querySelector('.modal-back, .menu')) return; // a dialog/menu on top handles Esc
      e.preventDefault(); e.stopImmediatePropagation(); close();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const onControl = e.target && e.target.closest && e.target.closest('button, [role="slider"], [role="switch"], [role="radio"], [role="tab"], [role="option"], a');
    if (e.key === ' ' && !onControl) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (current === 'songs') songsView.togglePlay();
      else if (current === 'jam' && panels.jam) {
        try { if (panels.jam.playing) panels.jam.stop(); else if (typeof panels.jam.play === 'function') panels.jam.play(); } catch (err) { console.error(err); }
      }
      return;
    }
    // arrows / slash / ? would drive the app behind the sheet: keep them inside the center
    if (!onControl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === '/' || e.key === '?')) { e.stopImmediatePropagation(); }
  }
  document.addEventListener('keydown', onKey, true);

  /* ── state + pill ── */
  let lastPill = '';
  function updPill() {
    const kind = transport.kind;
    const show = !isOpen && !theater.isOpen() && (kind === 'song' || kind === 'jam' || kind === 'magic');
    pill.hidden = !show;
    document.documentElement.classList.toggle('np-visible', show);
    if (!show) return;
    const lang = getLang();
    let title = '', sub = '', kindTxt = '';
    if (kind === 'song') {
      const info = songsView.nowPlaying();
      title = info ? (lang === 'en' ? info.title : info.zh) : '';
      sub = info && info.section ? info.section : '';
      kindTxt = t('dcSongs');
      pill.style.setProperty('--np-p', info ? info.progress.toFixed(3) : '0');
      if (info && info.colors) { pill.style.setProperty('--np1', info.colors[0]); pill.style.setProperty('--np2', info.colors[1] || info.colors[0]); }
    } else {
      kindTxt = t(kind === 'jam' ? 'dcJam' : 'dcMagic');
      title = t(kind === 'jam' ? 'npJam' : 'npMagic');
      pill.style.setProperty('--np-p', '0');
      pill.style.setProperty('--np1', kind === 'jam' ? '#ffc46b' : '#a78bfa');
      pill.style.setProperty('--np2', '#ff6bd6');
    }
    const key = `${kindTxt}|${title}|${sub}`;
    if (key !== lastPill) {
      lastPill = key;
      pillKind.textContent = kindTxt;
      pillTitle.textContent = title;
      pillSub.textContent = sub;
      pillOpen.title = `${t('dcOpen')} — ${title}`;
      pillStop.title = t('songStop');
      pillStop.setAttribute('aria-label', t('songStop'));
    }
  }
  transport.on((kind) => {
    // tours and theater mode borrow the patch: auto-evolve / auto-morph must not keep changing it underneath
    if (kind === 'tour' || kind === 'theater') stopPanels('magic');
    for (const k in tabState) tabState[k].btn.classList.toggle('is-live', (k === 'songs' && kind === 'song') || (k === 'jam' && kind === 'jam') || (k === 'magic' && kind === 'magic') || (k === 'tours' && kind === 'tour') || (k === 'theater' && kind === 'theater'));
    updPill();
    if (ctx.onTransport) ctx.onTransport(kind);
  });

  // Jam / Magic panels stop by themselves (their own stop buttons): release the transport once they are idle
  let idleSince = 0;
  function watchPanels(st) {
    const k = transport.kind;
    if (k !== 'jam' && k !== 'magic') { idleSince = 0; return; }
    let busy;
    const song = st && st.song;
    if (k === 'jam') busy = !!((panels.jam && panels.jam.playing) || (song && song.playing && /^jam/.test(String(song.id || ''))));
    else busy = !!(st && (st.seqPlaying || (song && song.playing)));
    const now = performance.now();
    if (busy) idleSince = 0;
    else if (!idleSince) idleSince = now;
    else if (now - idleSince > 1200) { idleSince = 0; transport.release(k); }
  }

  function onState(st) {
    for (const fn of stateSubs) { try { fn(st); } catch (e) { console.error(e); } }
    watchPanels(st);
    songsView.onState(st);
    theater.onState(st);
    if (!pill.hidden) updPill();
  }

  function renderLang() {
    titleMain.textContent = t('dcTitle');
    titleSub.textContent = getLang() === 'en' ? '示範中心' : 'Demo Center';
    tagline.textContent = t('dcTagline');
    closeBtn.title = `${t('dcClose')} (Esc)`;
    closeBtn.setAttribute('aria-label', t('dcClose'));
    for (const k in tabState) {
      const s = tabState[k];
      s.main.textContent = t(s.tab.key);
      s.sub.textContent = t(s.tab.key, getLang() === 'en' ? 'zh' : 'en');
      s.btn.setAttribute('aria-label', `${t(s.tab.key)} — ${t(s.tab.desc)}`);
      s.btn.title = t(s.tab.key);
    }
    applyI18n(el);
    updAudio();
    songsView.renderLang();
    toursView.renderLang();
    theater.renderLang();
    tours.renderLang();
    lastPill = '';
    updPill();
    requestAnimationFrame(moveIndicator);
  }
  renderLang();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => moveIndicator()).observe(nav);

  document.body.append(el, pill);

  return {
    el, transport, tours, theater, audio,
    open, close,
    toggle(tab) { if (isOpen && (!tab || tab === current)) close(); else open(tab); },
    get isOpen() { return isOpen; },
    get tab() { return current; },
    onState, renderLang,
    /** main.js: the audio engine started / failed (refreshes the in-sheet banner). */
    audioChanged: () => updAudio(),
    ownsMacros: () => tours.ownsMacros() || theater.ownsMacros(),
    /**
     * Space pressed in the app (outside the sheet): pauses/resumes a running tour, or stops a playing song /
     * jam / magic run (instead of starting the preset demo on top). Returns true when handled.
     */
    handleSpace() {
      if (tours.isActive()) { tours.togglePause(); return true; }
      const k = transport.kind;
      if (k === 'song' || k === 'jam' || k === 'magic') { transport.stopAll(); return true; }
      return false;
    },
    stopAll() { transport.stopAll(); },
    ready: dataReady,
  };
}
