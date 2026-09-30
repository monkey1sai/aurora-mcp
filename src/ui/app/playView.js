// "Play" view: hero visualizer (full-bleed), preset title, 4 big macro knobs named by the preset,
// XY pad bound to macro 1 (x) / macro 2 (y), and small scope + spectrum.

import { h, createScope, storage } from './dom.js';
import { icon } from './icons.js';
import { t, nameLabel, paramLabel, tx, getLang } from './i18n.js';
import { createKnob, createXYPad } from '../components.js';
import { PARAM_BY_ID } from '../../dsp/params.js';
import { MACRO_COLORS } from './controls.js';

export function createPlayView(ctx) {
  const { store } = ctx;
  const el = h('section.play', { 'aria-label': t('regionPlay'), 'data-i18n-aria': 'regionPlay' });
  const aurora = h('div.play__aurora', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const heroHost = h('div.play__hero', { 'aria-hidden': 'true' });
  const catChip = h('span.cat-chip');
  const nameEl = h('h1.play__name');
  const dirtyEl = h('span.play__dirty', { title: t('modified') });
  const descEl = h('p.play__desc');
  const tagsEl = h('div.play__tags');
  const info = h('div.play__info', null, h('div.play__meta', null, catChip, dirtyEl), nameEl, descEl, tagsEl);
  const macrosEl = h('div.play__macros.glass', { role: 'group', 'aria-label': t('macros') });
  const xyHost = h('div.play__xy');
  const scopeHost = h('div.mini-vis.mini-vis--scope', { title: t('scope') }, h('span.mini-vis__lbl', null, tx('scope')));
  const specHost = h('div.mini-vis.mini-vis--spec', { title: t('spectrum') }, h('span.mini-vis__lbl', null, tx('spectrum')));
  const collapse = h('button.icon-btn.play__collapse', { type: 'button', 'data-i18n-title': 'collapse', title: t('collapse') }, icon('up', 18));
  el.append(aurora, heroHost, h('div.play__left', null, info, macrosEl), h('div.play__side', null, xyHost, h('div.play__minis', null, scopeHost, specHost)), collapse);

  let collapsed = !!storage.get('aurora.playCollapsed', false);
  const hero = { inst: null };
  const heroPause = new Set(); // reasons to stop the hero (Demo Center / theater draw their own visual)
  const syncHero = () => { if (!hero.inst) return; if (collapsed || heroPause.size) hero.inst.stop(); else hero.inst.start(); };
  function applyCollapsed() {
    document.documentElement.classList.toggle('play-collapsed', collapsed);
    collapse.title = t(collapsed ? 'expand' : 'collapse');
    collapse.dataset.i18nTitle = collapsed ? 'expand' : 'collapse';
    collapse.firstChild.replaceWith(icon(collapsed ? 'down' : 'up', 18));
    syncHero();
    requestAnimationFrame(() => ctx.onLayout && ctx.onLayout());
  }
  collapse.addEventListener('click', () => { collapsed = !collapsed; storage.set('aurora.playCollapsed', collapsed); applyCollapsed(); });
  applyCollapsed();

  /* ── macros + XY ── */
  let mScope = null;
  let lastUser = -1e9;
  let knobs = [];
  let xy = null;
  function buildMacros() {
    if (mScope) mScope.dispose();
    mScope = createScope();
    macrosEl.textContent = '';
    xyHost.textContent = '';
    const macros = store.getMacros();
    knobs = macros.map((m, i) => {
      const id = `macro${i + 1}`;
      let kn = null;
      kn = createKnob({
        param: PARAM_BY_ID[id], value: store.get(id), size: 'xl', accent: MACRO_COLORS[i], label: nameLabel(m.name),
        onChange: (v) => { lastUser = performance.now(); store.set(id, v, { origin: kn }); },
      });
      const targets = h('ul.macro__targets');
      for (const tg of m.targets) {
        const p = PARAM_BY_ID[tg.id];
        if (!p) continue;
        const nm = paramLabel(p); // English first in English mode (rebuilt on a language switch)
        targets.append(h('li', null, h('span', null, nm.zh), h('small', null, nm.en), h('b', { class: tg.amount < 0 ? 'neg' : '' }, `${tg.amount > 0 ? '+' : ''}${Math.round(tg.amount * 100)}%`)));
      }
      if (!m.targets.length) targets.append(h('li.muted', null, '—'));
      // "what does this knob move": on hover / keyboard focus, and on touch by tapping the M1…M4 badge
      const badge = h('button.macro__n', { type: 'button', 'aria-expanded': 'false', title: `${t('macroTargets')} — M${i + 1}`, 'aria-label': `M${i + 1} ${t('macroTargets')}` }, `M${i + 1}`);
      const wrap = h('div.macro', { '--acc': MACRO_COLORS[i] }, badge, kn.el, targets);
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = !wrap.classList.contains('is-info');
        for (const x of macrosEl.querySelectorAll('.macro.is-info')) { x.classList.remove('is-info'); x.querySelector('.macro__n').setAttribute('aria-expanded', 'false'); }
        wrap.classList.toggle('is-info', on);
        badge.setAttribute('aria-expanded', String(on));
      });
      macrosEl.append(wrap);
      mScope.add(store.subscribe(id, (v, origin) => {
        if (origin !== kn) kn.setValue(v);
        if (xy && i < 2 && origin !== 'xy') { const [x, y] = xy.getXY(); xy.setXY(i === 0 ? v : x, i === 1 ? v : y); }
      }));
      mScope.add(() => kn.destroy());
      return kn;
    });
    xy = createXYPad({
      x: store.get('macro1'), y: store.get('macro2'), accent: 'aurora',
      labelX: nameLabel(macros[0].name), labelY: nameLabel(macros[1].name),
      // one message + one (coalesced) undo step for both axes of a drag
      onChange: (x, y) => { lastUser = performance.now(); store.setMany({ macro1: x, macro2: y }, { origin: 'xy', coalesce: 'xy', label: 'xy' }); },
    });
    xyHost.append(xy.el);
    mScope.add(() => xy.destroy());
  }

  /* ── preset info ── */
  function renderInfo() {
    const meta = store.getMeta();
    const cat = ctx.categories.find(c => c.id === meta.category);
    catChip.textContent = '';
    if (cat) {
      catChip.style.setProperty('--c', cat.color || 'var(--a-cyan)');
      const en = getLang() === 'en';
      catChip.append(icon(cat.icon, 14), h('span', null, en ? cat.label : cat.zh), h('small', null, en ? cat.zh : cat.label));
    }
    if (meta.source === 'user') catChip.append(h('span.src-badge', null, t('user')));
    if (meta.source === 'random') catChip.append(h('span.src-badge', null, t('random')));
    nameEl.textContent = meta.name;
    descEl.textContent = meta.description || '';
    tagsEl.textContent = '';
    for (const tg of meta.tags || []) tagsEl.append(h('span.tag', null, `#${tg}`));
  }
  // hero palette follows the preset category
  const PALETTE_FOR = { keys: 'aurora', pad: 'aurora', bass: 'sunset', lead: 'sunset', pluck: 'ocean', bell: 'ocean', strings: 'sunset', arp: 'ocean', fx: 'aurora', drum: 'sunset' };
  function applyPalette() {
    if (!hero.inst || !hero.inst.setPalette) return;
    try { hero.inst.setPalette(PALETTE_FOR[store.getMeta().category] || 'aurora'); } catch (e) { console.error(e); }
  }
  store.onPatch(() => { renderInfo(); buildMacros(); applyPalette(); });
  store.onMacros(() => buildMacros());
  store.onDirty(d => el.classList.toggle('is-dirty', d));

  /* ── visualisers (need audio) ── */
  const vis = { scope: null, spec: null };
  function mountVisuals(audio, visuals) {
    try {
      if (visuals.createHeroVisualizer && audio.analyser) {
        hero.inst = visuals.createHeroVisualizer({ analyser: audio.analyser, analyserL: audio.analyserL, analyserR: audio.analyserR, getState: () => audio.getState() });
        heroHost.append(hero.inst.el);
        syncHero();
        el.classList.add('has-hero');
        applyPalette();
      }
    } catch (e) { console.error('hero visualizer failed', e); }
    try {
      if (visuals.createScope && audio.analyserL) {
        vis.scope = visuals.createScope({ analyserL: audio.analyserL, analyserR: audio.analyserR, mode: storage.get('aurora.scopeMode', 'wave') });
        scopeHost.append(vis.scope.el);
        vis.scope.start();

      }
    } catch (e) { console.error('scope failed', e); }
    try {
      if (visuals.createSpectrum && audio.analyser) {
        vis.spec = visuals.createSpectrum({ analyser: audio.analyser });
        specHost.append(vis.spec.el);
        vis.spec.start();
      }
    } catch (e) { console.error('spectrum failed', e); }
  }

  /** Macro values automated by the engine (sequencer) → follow without echoing back. */
  function followMacros(values) {
    if (performance.now() - lastUser < 700 || el.querySelector('.ac-knob.is-dragging, .ac-xy.is-dragging')) return;
    for (let i = 0; i < 4; i++) {
      const v = values[i];
      if (typeof v !== 'number') continue;
      const id = `macro${i + 1}`;
      if (Math.abs(v - store.get(id)) > 0.002) store.set(id, v, { send: false, record: false, origin: 'engine' });
    }
  }

  // a tap anywhere else closes an open macro target list
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('.macro__n')) return;
    for (const x of macrosEl.querySelectorAll('.macro.is-info')) { x.classList.remove('is-info'); x.querySelector('.macro__n').setAttribute('aria-expanded', 'false'); }
  }, true);

  renderInfo();
  buildMacros();
  return {
    el, mountVisuals, followMacros,
    /** Pause/resume the hero visualizer for a reason (e.g. 'dc', 'theater'); it runs when no reason is set. */
    setHeroPaused(key, on) { if (on) heroPause.add(key); else heroPause.delete(key); syncHero(); },
    rebuild() { renderInfo(); buildMacros(); },
    isDragging: () => !!el.querySelector('.ac-knob.is-dragging, .ac-xy.is-dragging'),
  };
}

