// Sound Tour player 音色導覽播放器: plays a tour (src/demo/tours) on the main thread.
//  • the tour's phrase loops in the engine sequencer; a step clock (tour bpm, performance.now) fires steps
//  • params/macros are animated through the store without undo history (store.set({record:false})), so the
//    knobs visibly move and the engine hears every change; a param the user grabs stops being automated
//  • captions (typewriter zh + English) sit over the hero visualizer in the play view; a compact floating
//    caption takes over when the play view is scrolled away; the focused control gets a glowing ring
//  • at the end: 保留 Keep (one undo step) / 還原 Revert / 再聽一次 Replay. Exiting early reverts.

import { h } from '../app/dom.js';
import { t, getLang, nameText } from '../app/i18n.js';
import { dIcon as icon } from './center.js';
import { PARAM_BY_ID, toNorm } from '../../dsp/params.js';
import { compileTour, startPatch, rampValue, ease } from '../../demo/tours/index.js';
import { snapshotPatch, applyPatchSilently, restorePatch, commitPatch } from './automation.js';

const ORIGIN = 'tour';
const MACRO_IDS = ['macro1', 'macro2', 'macro3', 'macro4'];
const GROUP_TAB = {
  osc1: 'sources', osc2: 'sources', fm: 'sources', phys: 'sources', noise: 'sources', amp: 'sources', aenv: 'sources',
  filter: 'filter', filter2: 'filter', fenv: 'filter',
  menv: 'mod', lfo1: 'mod', lfo2: 'mod', mod: 'mod',
  drive: 'fx', chorus: 'fx', phaser: 'fx', delay: 'fx', reverb: 'fx', eq: 'fx',
  voice: 'perform', vibrato: 'perform', arp: 'perform', chord: 'perform', scale: 'perform', global: 'perform',
};
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const btn = (ic, key, onClick, cls = '') => {
  const b = h(`button.tc-btn ${cls}`.trim(), { type: 'button', title: t(key), 'aria-label': t(key) }, icon(ic, 16));
  b.addEventListener('click', onClick);
  return b;
};
const L = pair => (pair ? (getLang() === 'en' ? pair.en || pair.zh : pair.zh || pair.en) : '');
const L2 = pair => (pair ? (getLang() === 'en' ? pair.zh : pair.en) : '');
/** A tour's title in the UI language (also the name of the patch it builds). */
const titleOf = tour => (getLang() === 'en' ? tour.title || tour.zh : tour.zh || tour.title);
const descOf = tour => (typeof tour.description === 'object' && tour.description ? L(tour.description) : tour.description || '');

/**
 * @param {{ store, getAudio: () => object, editor?: {el, select, current}, playView?: {el}, presets?: object[],
 *           transport?: {claim(kind, stop), release(kind)}, toast?: (msg, opts) => void,
 *           setEditorShown?: (on: boolean, opts?: {scroll?: boolean}) => void }} o  (phone layout: open the editor)
 */
export function createTourPlayer({ store, getAudio, editor = null, playView = null, presets = [], transport = null, toast = null, setEditorShown = null }) {
  let S = null; // active session
  let releasedAt = -1e9; // engine state messages already in flight still carry the tour's macro values
  let raf = 0;
  let guard = 0; // >0 while we change the store ourselves (patch/meta events to ignore)
  const subs = new Set();
  const emit = () => { for (const fn of subs) { try { fn(api.status()); } catch (e) { console.error(e); } } };

  /* ── caption UI (built once) ── */
  const capTitle = h('span.tc__title');
  const capCount = h('span.tc__count');
  const capText = h('p.tc__text', { 'aria-live': 'polite' });
  const capSub = h('p.tc__sub');
  const barFill = h('i.tc__fill');
  const ticks = h('span.tc__ticks', { 'aria-hidden': 'true' });
  const bar = h('div.tc__bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, barFill, ticks);
  const bPause = btn('pause', 'tourPause', () => api.togglePause(), 'tc-btn--pause');
  const bNext = btn('next', 'tourNext', () => api.skip());
  const bRestart = btn('loop', 'tourRestart', () => api.restart());
  const bExit = btn('x', 'tourExit', () => api.stop({ revert: true }));
  const ctl = h('div.tc__ctl', null, bPause, bNext, bRestart, bExit);
  const bKeep = h('button.btn.btn--primary.tc__keep', { type: 'button' }, icon('check', 15), h('span'));
  const bRevert = h('button.btn.btn--ghost.tc__revert', { type: 'button' }, icon('undo', 15), h('span'));
  const bReplay = h('button.btn.btn--ghost.tc__replay', { type: 'button' }, icon('loop', 15), h('span'));
  bKeep.addEventListener('click', () => api.keep());
  bRevert.addEventListener('click', () => api.stop({ revert: true }));
  bReplay.addEventListener('click', () => api.restart());
  const endRow = h('div.tc__end', null, bKeep, bRevert, bReplay);
  const cap = h('section.tourcap', { role: 'region', 'aria-label': t('tourBadge') },
    h('div.tc__top', null, h('span.tc__badge', null, icon('fx', 13), h('span.tc__badgeTxt')), capTitle, capCount),
    capText, capSub, h('div.tc__foot', null, bar, ctl), endRow);
  // compact floating caption (when the play view is scrolled out of sight or collapsed)
  const fText = h('span.tcf__text');
  const fCount = h('span.tcf__count');
  const fPause = btn('pause', 'tourPause', () => api.togglePause());
  const fNext = btn('next', 'tourNext', () => api.skip());
  const fExit = btn('x', 'tourExit', () => api.stop({ revert: true }));
  const fFill = h('i.tcf__fill');
  const fKeep = h('button.tcf__keep', { type: 'button' }, icon('check', 14), h('span'));
  const fRevert = h('button.tcf__revert', { type: 'button' }, icon('undo', 14), h('span'));
  fKeep.addEventListener('click', () => api.keep());
  fRevert.addEventListener('click', () => api.stop({ revert: true }));
  const float = h('div.tourcap-float', { role: 'status', 'aria-live': 'polite' }, h('span.tcf__dot', { 'aria-hidden': 'true' }), fCount, fText, h('span.tcf__btns', null, fPause, fNext, fExit), h('span.tcf__end', null, fKeep, fRevert), fFill);
  float.hidden = true;
  let io = null;
  let capVisible = true;

  function mountUi() {
    const host = playView && playView.el;
    if (host && !cap.isConnected) host.append(cap);
    if (!float.isConnected) document.body.append(float);
    if (host) host.classList.add('is-touring');
    document.documentElement.classList.add('tour-active');
    if (!io && typeof IntersectionObserver === 'function') {
      // watch the caption TEXT (not the whole card): the float takes over as soon as any of it is clipped by the
      // scrolled .main (the card could be >50 % visible while its text sat under the top bar)
      io = new IntersectionObserver((es) => {
        const e = es[es.length - 1];
        capVisible = e.isIntersecting && e.intersectionRatio >= 0.97;
        updFloat();
      }, { threshold: [0, 0.5, 0.97, 1] });
      io.observe(capText);
    }
    requestAnimationFrame(() => cap.classList.add('is-in'));
  }
  function unmountUi(s = null) {
    if (s && s.openedEditor && setEditorShown) setEditorShown(false);
    cap.classList.remove('is-in', 'is-ended', 'is-paused');
    float.classList.remove('is-ended');
    if (playView && playView.el) playView.el.classList.remove('is-touring');
    document.documentElement.classList.remove('tour-active');
    float.hidden = true;
    if (io) { io.disconnect(); io = null; }
    setTimeout(() => { if (!S) { cap.remove(); float.remove(); } }, 400);
    clearFocus();
  }
  function updFloat() {
    const collapsed = document.documentElement.classList.contains('play-collapsed');
    float.hidden = !S || (capVisible && !collapsed && cap.offsetParent !== null);
  }
  function renderLabels() {
    cap.querySelector('.tc__badgeTxt').textContent = t('tourBadge');
    bKeep.lastChild.textContent = t('tourKeep');
    bRevert.lastChild.textContent = t('tourRevert');
    bReplay.lastChild.textContent = t('tourReplay');
    fKeep.lastChild.textContent = t('tourKeep');
    fRevert.lastChild.textContent = t('tourRevert');
    for (const [b, k] of [[bNext, 'tourNext'], [bRestart, 'tourRestart'], [bExit, 'tourExit'], [fNext, 'tourNext'], [fExit, 'tourExit']]) { b.title = t(k); b.setAttribute('aria-label', t(k)); }
    setPauseIcon();
    if (S) { capTitle.textContent = titleOf(S.tour); showCaption(S.capStep, true); }
  }
  function setPauseIcon() {
    const paused = !!(S && S.paused);
    for (const b of [bPause, fPause]) {
      b.replaceChildren(icon(paused ? 'play' : 'pause', 16));
      b.title = t(paused ? 'tourResume' : 'tourPause');
      b.setAttribute('aria-label', b.title);
    }
    cap.classList.toggle('is-paused', paused);
    float.classList.toggle('is-paused', paused);
  }

  /* ── typewriter ── */
  let typeTimer = 0;
  function showCaption(step, instant = false) {
    if (!S) return;
    clearInterval(typeTimer);
    const c = S.c;
    const idx = step ? step.captionIndex : -1;
    capCount.textContent = idx >= 0 ? `${idx + 1} / ${c.captionCount}` : '';
    fCount.textContent = capCount.textContent;
    const main = step ? L(step.caption) : '';
    const sub = step ? L2(step.caption) : '';
    fText.textContent = main;
    capSub.textContent = sub;
    capSub.classList.remove('is-in');
    if (instant || reducedMotion()) {
      capText.textContent = main;
      capSub.classList.add('is-in');
      return;
    }
    const chars = [...main];
    let n = 0;
    capText.textContent = '';
    const cursor = h('span.tc__cursor', { 'aria-hidden': 'true' });
    const txt = document.createTextNode('');
    capText.append(txt, cursor);
    capText.setAttribute('aria-label', main);
    typeTimer = setInterval(() => {
      n = Math.min(chars.length, n + (getLang() === 'en' ? 2 : 1));
      txt.data = chars.slice(0, n).join('');
      if (n >= chars.length) {
        clearInterval(typeTimer);
        setTimeout(() => cursor.remove(), 900);
        capSub.classList.add('is-in');
      }
    }, getLang() === 'en' ? 22 : 38);
  }
  function renderTicks() {
    ticks.textContent = '';
    if (!S) return;
    for (const s of S.c.steps) if (s.caption) ticks.append(h('b', { style: `left:${(100 * s.beat / S.c.endBeat).toFixed(2)}%` }));
  }

  /* ── focus ring on a control ── */
  let focused = null;
  function clearFocus() {
    if (focused) { focused.classList.remove('is-tour-focus'); delete focused.dataset.tourLabel; focused = null; }
  }
  function focusParam(id) {
    clearFocus();
    const p = PARAM_BY_ID[id];
    if (!p) return;
    if (MACRO_IDS.includes(id)) { focusMacro(id); return; }
    if (!editor || !editor.el) return;
    const g = p.group || '';
    const tab = g.startsWith('fm.op') ? 'sources' : GROUP_TAB[g];
    if (!tab) return;
    // phone layout hides the editor under a ✎ button: open it for the tour (closed again when the tour ends),
    // so the knob the caption talks about is shown turning and glowing there too
    if (!editor.el.offsetParent && setEditorShown && S) {
      setEditorShown(true, { scroll: false });
      if (editor.el.offsetParent) S.openedEditor = true;
    }
    if (!editor.el.offsetParent) return; // editor hidden
    if (editor.current !== tab) editor.select(tab, true);
    const src = g.startsWith('fm') ? 'fm' : ['osc1', 'osc2', 'phys', 'noise'].includes(g) ? g : null;
    const token = S && S.token;
    requestAnimationFrame(() => {
      if (!S || S.token !== token) return;
      if (src) {
        const tg = editor.el.querySelector(`.src-strip [data-param="${src}.on"]`);
        const strip = tg && tg.closest('.src-strip');
        if (strip && !strip.classList.contains('is-selected')) { const sel = strip.querySelector('.src-strip__sel'); if (sel) sel.click(); }
      }
      requestAnimationFrame(() => {
        if (!S || S.token !== token) return;
        let el = editor.el.querySelector(`[data-param="${id}"]`);
        if (el && !el.offsetParent) el = null;
        if (!el) { // icon pickers (e.g. the physical-model chooser) are radiogroups labelled "<zh> <en>"
          const lbl = `${p.zh} ${p.label}`;
          el = [...editor.el.querySelectorAll('[role="radiogroup"][aria-label]')].find(x => x.getAttribute('aria-label') === lbl && x.offsetParent) || null;
        }
        if (!el) el = editor.el.querySelector(`[data-group="${g}"]`);
        if (!el) return;
        focused = el;
        el.dataset.tourLabel = getLang() === 'en' ? `${p.label}` : `${p.zh} ${p.label}`;
        el.classList.add('is-tour-focus');
        reveal(el);
      });
    });
  }

  /** Ring a macro knob in the play view (labelled with the macro's name). */
  function focusMacro(id) {
    const host = playView && playView.el;
    const knob = host && host.querySelector(`.play__macros [data-param="${id}"]`);
    const el = knob; // the knob itself: .macro uses its ::before for the contrast pool
    if (!el || !el.offsetParent) return;
    const i = MACRO_IDS.indexOf(id);
    const m = store.getMacros()[i];
    const name = String((m && m.name) || `Macro ${i + 1}`);
    focused = el;
    el.dataset.tourLabel = `M${i + 1} ${getLang() === 'en' ? nameText(name) || name : name}`;
    el.classList.add('is-tour-focus');
    // bring the whole play view (caption card + macro knobs) back into sight
    const main = host.closest('.main');
    if (main && main.scrollTop > 0) { try { main.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch { main.scrollTop = 0; } }
  }

  /** Scroll the editor just enough to show a control (left alone when it is already mostly visible). */
  function reveal(el) {
    const behavior = reducedMotion() ? 'auto' : 'smooth';
    const rack = el.closest('.fx-rack');
    if (rack) {
      const r = el.getBoundingClientRect(), k = rack.getBoundingClientRect();
      if (r.left < k.left || r.right > k.right) { try { rack.scrollBy({ left: r.left < k.left ? r.left - k.left - 16 : r.right - k.right + 16, behavior }); } catch { /* ignore */ } }
    }
    const main = el.closest('.main');
    if (!main) return;
    const r = el.getBoundingClientRect(), m = main.getBoundingClientRect();
    // below the sticky tab strip; above the floating caption only when it is (or will be) shown — it covers the
    // bottom ≈76 px of the editor once the caption card has scrolled away
    const top = m.top + 60;
    const capTop = captionTop(main);
    const fits = b => Math.max(0, Math.min(r.bottom, b) - Math.max(r.top, top)) >= r.height * 0.7;
    let bottom = m.bottom - (capTop === null ? 84 : 10);
    if (fits(bottom)) return;
    let dy = r.bottom > bottom ? r.bottom - bottom + 8 : r.top - top - 12;
    // scrolling down must not push the caption's text under the top bar when a smaller move is not enough:
    // then the floating caption takes over, so keep the control clear of it
    if (dy > 0 && capTop !== null && dy > capTop - m.top - 2) {
      bottom = m.bottom - 84;
      if (fits(bottom)) return;
      dy = r.bottom > bottom ? r.bottom - bottom + 8 : r.top - top - 12;
    }
    try { main.scrollBy({ top: dy, behavior }); } catch { main.scrollTop += dy; }
  }
  /** Top of the caption card's heading + text while it is fully in sight inside `main`, else null. */
  function captionTop(main) {
    if (!cap.isConnected || cap.offsetParent === null || document.documentElement.classList.contains('play-collapsed')) return null;
    const head = cap.querySelector('.tc__top') || capText;
    const m = main.getBoundingClientRect(), a = head.getBoundingClientRect(), b = capText.getBoundingClientRect();
    return a.top >= m.top - 0.5 && b.bottom <= m.bottom ? a.top : null;
  }

  /* ── engine ── */
  const audio = () => (getAudio ? getAudio() : null);
  function playPhrase() {
    const a = audio();
    if (!a || !S) return;
    a.seqStop();
    a.seqLoad({ ...S.tour.phrase, bpm: S.c.bpm, loop: true });
    a.seqPlay();
  }
  // writes are batched per frame: one store call → one engine message. The store's transient API (no undo
  // history, no dirty flag, undo() settles it) is used when present; plain non-recorded sets otherwise.
  let pend = null;
  function write(id, v) {
    const cur = store.get(id);
    if (typeof v === 'number' && typeof cur === 'number' && Math.abs(v - cur) < 1e-7) { if (pend) delete pend[id]; return; }
    if (v === cur) { if (pend) delete pend[id]; return; }
    (pend || (pend = {}))[id] = v;
  }
  const curVal = id => (pend && id in pend ? pend[id] : store.get(id));
  function flush() {
    if (!pend) return;
    const o = pend;
    pend = null;
    guard++;
    try {
      if (typeof store.setTransientMany === 'function') store.setTransientMany(o, { origin: ORIGIN, owner: 'tour' });
      else store.setMany(o, { record: false, origin: ORIGIN });
    } finally { guard--; }
  }

  /* ── clock ── */
  const nowBeat = () => (S.paused ? S.pausedBeat : ((performance.now() - S.t0) / 60000) * S.c.bpm);
  function fire(step, instant) {
    if (step.set) for (const id in step.set) { if (PARAM_BY_ID[id]) { S.ramps.delete(id); write(id, step.set[id]); } }
    for (const r of step.ramp) {
      if (instant || !(r.beats > 0)) { S.ramps.delete(r.id); write(r.id, r.to); continue; }
      S.ramps.set(r.id, { from: curVal(r.id), to: r.to, b0: step.beat, beats: r.beats });
    }
    for (const m of step.macro) {
      const id = MACRO_IDS[m.index];
      if (instant || !(m.beats > 0)) { S.ramps.delete(id); write(id, m.to); continue; }
      S.ramps.set(id, { from: curVal(id), to: m.to, b0: step.beat, beats: m.beats });
    }
    if (step.caption) {
      S.capStep = step;
      if (!instant) {
        showCaption(step);
        if (step.focus) focusParam(step.focus); else clearFocus();
      }
    }
  }
  function frame() {
    raf = 0;
    if (!S) return;
    const beat = nowBeat();
    const steps = S.c.steps;
    while (S.next < steps.length && steps[S.next].beat <= beat + 1e-6) fire(steps[S.next++], false);
    for (const [id, r] of S.ramps) {
      const k = ease((beat - r.b0) / r.beats);
      write(id, rampValue(id, r.from, r.to, k));
      if (k >= 1) S.ramps.delete(id);
    }
    flush();
    const prog = Math.min(1, beat / S.c.endBeat);
    barFill.style.width = `${(prog * 100).toFixed(2)}%`;
    fFill.style.width = barFill.style.width;
    bar.setAttribute('aria-valuenow', String(Math.round(prog * 100)));
    if (!S.ended && beat >= S.c.endBeat) {
      S.ended = true;
      cap.classList.add('is-ended');
      float.classList.add('is-ended');
      fText.textContent = L(S.capStep && S.capStep.caption);
      clearFocus();
      // bring the play view (and its keep / revert card) back into sight
      const main = playView && playView.el && playView.el.closest('.main');
      if (main && main.scrollTop > 0) { try { main.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch { main.scrollTop = 0; } }
      emit();
      setTimeout(() => { if (S && S.ended && cap.isConnected) bKeep.focus({ preventScroll: true }); }, 60);
    }
    if (!S.paused) raf = requestAnimationFrame(frame);
  }
  const loop = () => { if (!raf) raf = requestAnimationFrame(frame); };

  /* ── user interaction while touring ── */
  store.onAny((id, v, origin) => {
    if (!S || guard || origin === ORIGIN || origin === 'demo' || origin === 'engine' || origin === 'preset') return;
    if (S.ramps.has(id)) S.ramps.delete(id); // the user took this knob over
  });
  store.onPatch((meta) => {
    // a preset loaded by the user (browser, random, undo to another patch …) ends the tour, keeping the new sound
    if (!S || guard) return;
    if (meta && meta.source !== 'demo') api.stop({ revert: false, silent: true });
  });

  function begin(tour, { keepSnap = null } = {}) {
    const c = compileTour(tour);
    const sp = startPatch(tour, presets);
    const snap = keepSnap || snapshotPatch(store, { committed: true });
    if (S) cancelAnimationFrame(raf), raf = 0;
    const openedEditor = !!(S && S.openedEditor); // a restart keeps "the tour opened the editor"
    S = { tour, c, snap, t0: 0, paused: false, pausedBeat: 0, next: 0, ramps: new Map(), capStep: null, ended: false, token: Symbol('tour'), openedEditor };
    // magic tools (auto-evolve, morph, A/B) pause and settle while a tour owns the sound
    if (typeof store.claim === 'function') store.claim('tour', { exclusive: true });
    guard++;
    try { applyPatchSilently(store, { ...sp, name: titleOf(tour), demo: null }, { source: 'demo' }); } finally { guard--; }
    capTitle.textContent = titleOf(tour);
    cap.style.setProperty('--tc1', (tour.cover && tour.cover.colors && tour.cover.colors[0]) || 'var(--a-teal)');
    cap.style.setProperty('--tc2', (tour.cover && tour.cover.colors && tour.cover.colors[1]) || 'var(--a-cyan)');
    cap.classList.remove('is-ended', 'is-paused');
    float.classList.remove('is-ended');
    renderTicks();
    renderLabels();
    mountUi();
    playPhrase();
    S.t0 = performance.now();
    loop();
    emit();
  }

  const api = {
    /** Start a tour (reverts any running one first, but keeps the user's original patch snapshot). */
    start(tour) {
      if (!tour) return;
      const keep = S ? S.snap : null;
      if (transport) transport.claim('tour', () => api.stop({ revert: true, fromTransport: true }));
      begin(tour, { keepSnap: keep });
    },
    /** End the tour. revert (default true) puts the user's patch back. */
    stop({ revert = true, silent = false, fromTransport = false } = {}) {
      if (!S) return;
      const s = S;
      cancelAnimationFrame(raf); raf = 0;
      clearInterval(typeTimer);
      pend = null;
      S = null;
      releasedAt = performance.now();
      // always stop the phrase: a new owner that plays on the song ensemble (a demo song, the jam) never touches
      // the synth's sequencer, so the tour phrase kept looping under it (owners that use the sequencer reload it)
      { const a = audio(); if (a) a.seqStop(); }
      if (revert) {
        guard++;
        try { restorePatch(store, s.snap); } finally { guard--; }
        if (!silent && toast) toast(t('tourReverted'), { ms: 1600 });
      }
      unmountUi(s);
      if (typeof store.release === 'function') store.release('tour');
      if (transport && !fromTransport) transport.release('tour');
      emit();
    },
    /** Keep the current sound as one undo step, stop playback. */
    keep() {
      if (!S) return;
      const s = S;
      cancelAnimationFrame(raf); raf = 0;
      clearInterval(typeTimer);
      // finish running ramps so the kept patch is the tour's end state (unless the user grabbed a knob)
      for (const [id, r] of s.ramps) write(id, r.to);
      flush();
      S = null;
      releasedAt = performance.now();
      const a = audio();
      if (a) a.seqStop();
      guard++;
      try {
        const sp = startPatch(s.tour, presets);
        commitPatch(store, s.snap, {
          name: titleOf(s.tour), category: sp.category || null, tags: ['tour'], source: 'tour', demo: null,
          description: descOf(s.tour),
        });
      } finally { guard--; }
      if (toast) toast(`${t('tourKept')}`, { kind: 'ok', ms: 2600 });
      unmountUi(s);
      if (typeof store.release === 'function') store.release('tour');
      if (transport) transport.release('tour');
      emit();
    },
    pause() {
      if (!S || S.paused) return;
      S.pausedBeat = nowBeat();
      S.paused = true;
      const a = audio();
      if (a) a.seqStop();
      setPauseIcon();
      emit();
    },
    resume() {
      if (!S || !S.paused) return;
      S.paused = false;
      S.t0 = performance.now() - (S.pausedBeat * 60000) / S.c.bpm;
      playPhrase();
      setPauseIcon();
      loop();
      emit();
    },
    togglePause() { if (S) { if (S.paused) api.resume(); else api.pause(); } },
    /** Jump to the next captioned step (earlier actions complete instantly); the phrase restarts from its top. */
    skip() {
      if (!S) return;
      const steps = S.c.steps;
      const cur = nowBeat();
      const nextCap = steps.find((s, i) => i >= S.next && s.caption && s.beat > cur + 1e-6);
      const target = nextCap ? nextCap.beat : S.c.endBeat;
      for (const [id, r] of S.ramps) write(id, r.to);
      S.ramps.clear();
      while (S.next < steps.length && steps[S.next].beat < target - 1e-6) fire(steps[S.next++], true);
      flush();
      if (S.capStep) showCaption(S.capStep, true);
      S.pausedBeat = target;
      S.t0 = performance.now() - (target * 60000) / S.c.bpm;
      if (!S.paused) { playPhrase(); loop(); } else frame();
      emit();
    },
    restart() {
      if (!S) return;
      const tour = S.tour;
      begin(tour, { keepSnap: S.snap });
    },
    isActive: () => !!S,
    status() {
      if (!S) return { active: false };
      const idx = S.capStep ? S.capStep.captionIndex : -1;
      return { active: true, tour: S.tour, step: idx + 1, total: S.c.captionCount, paused: S.paused, ended: S.ended, progress: Math.min(1, nowBeat() / S.c.endBeat), caption: S.capStep ? S.capStep.caption : null };
    },
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Re-render texts after a language switch (the tour's patch is renamed to the title in the new language). */
    renderLang() {
      renderLabels();
      const meta = S && store.getMeta();
      if (meta && meta.source === 'demo' && (meta.name === S.tour.zh || meta.name === S.tour.title) && meta.name !== titleOf(S.tour)) {
        guard++;
        try { store.setMeta({ name: titleOf(S.tour) }); } finally { guard--; }
      }
    },
    /** True while the tour owns the macro knobs (main.js should not follow engine macro values then). */
    ownsMacros: () => !!S || performance.now() - releasedAt < 900,
  };
  return api;
}

/** Normalised position (0..1) of a param value — exported for tests/visuals. */
export const normOf = (id, v) => (PARAM_BY_ID[id] ? toNorm(PARAM_BY_ID[id], v) : 0);
