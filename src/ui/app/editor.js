// Tabbed deep editor: 聲源 Sources | 濾波 Filter | 調變 Mod | 效果 FX | 演奏 Perform.
// Panels are generated from the schema on first view (lazy), rebuilt on language change, and animate in.

import { h, createScope, storage } from './dom.js';
import { icon } from './icons.js';
import { bi, t } from './i18n.js';
import { buildSources } from './panelSources.js';
import { buildFilter } from './panelFilter.js';
import { buildMod } from './panelMod.js';
import { buildFx } from './panelFx.js';
import { buildPerform } from './panelPerform.js';
import { MOD_SLOTS } from '../../dsp/params.js';
import { applyParamHelp } from './paramHelp.js';

export const TABS = [
  { id: 'sources', key: 'tabSources', icon: 'osc', accent: 'var(--a-cyan)', build: buildSources },
  { id: 'filter', key: 'tabFilter', icon: 'filter', accent: 'var(--a-violet)', build: buildFilter },
  { id: 'mod', key: 'tabMod', icon: 'mod', accent: 'var(--a-amber)', build: buildMod },
  { id: 'fx', key: 'tabFx', icon: 'fx', accent: 'var(--a-pink)', build: buildFx },
  { id: 'perform', key: 'tabPerform', icon: 'perform', accent: 'var(--a-teal)', build: buildPerform },
];

export function createEditor(ctx) {
  const { store } = ctx;
  const el = h('section.editor', { 'aria-label': t('regionEditor'), 'data-i18n-aria': 'regionEditor' });
  const nav = h('nav.tabs', { role: 'tablist' });
  const ind = h('span.tabs__ind', { 'aria-hidden': 'true' });
  const panels = h('div.tabpanels');
  const state = {}; // id → { btn, panel, scope, built, badge }
  const shownHooks = new Map();
  ctx.onTabShown = (tab, fn) => {
    let s = shownHooks.get(tab);
    if (!s) { s = new Set(); shownHooks.set(tab, s); }
    s.add(fn);
    return () => s.delete(fn);
  };

  for (const tb of TABS) {
    const badge = h('span.tab__badge');
    const btn = h('button.tab', { type: 'button', role: 'tab', id: `tab-${tb.id}`, 'aria-controls': `panel-${tb.id}`, '--acc': tb.accent, 'data-tab': tb.id },
      h('span.tab__ic', null, icon(tb.icon, 17)), bi(tb.key, 'tab__lbl'), badge);
    btn.addEventListener('click', () => select(tb.id, true));
    const panel = h('div.tabpanel', { role: 'tabpanel', id: `panel-${tb.id}`, 'aria-labelledby': `tab-${tb.id}`, hidden: true, '--acc': tb.accent });
    state[tb.id] = { btn, panel, scope: null, built: false, badge, tab: tb };
    nav.append(btn);
    panels.append(panel);
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
    select(ids[i], true);
    state[ids[i]].btn.focus();
  });
  el.append(nav, panels);

  let current = storage.get('aurora.tab', 'sources');
  if (!state[current]) current = 'sources';

  function build(id) {
    const s = state[id];
    if (s.built) return;
    s.scope = createScope();
    s.panel.textContent = '';
    try {
      s.panel.append(s.tab.build(ctx, s.scope));
    } catch (e) {
      console.error(e);
      s.panel.append(h('div.pane-error', null, `Panel failed to build: ${e.message}`));
    }
    s.built = true;
  }

  function moveIndicator() {
    const b = state[current].btn;
    if (!b.offsetWidth) return;
    ind.style.transform = `translateX(${b.offsetLeft}px)`;
    ind.style.width = `${b.offsetWidth}px`;
    ind.style.setProperty('--acc', state[current].tab.accent);
  }

  function select(id, user) {
    if (!state[id]) return;
    const prev = current;
    current = id;
    storage.set('aurora.tab', id);
    build(id);
    for (const k in state) {
      const s = state[k];
      const on = k === id;
      s.btn.classList.toggle('is-on', on);
      s.btn.setAttribute('aria-selected', String(on));
      s.btn.tabIndex = on ? 0 : -1;
      s.panel.hidden = !on;
    }
    el.style.setProperty('--acc', state[id].tab.accent);
    const p = state[id].panel;
    if (user && prev !== id) {
      const dir = TABS.findIndex(x => x.id === id) > TABS.findIndex(x => x.id === prev) ? 1 : -1;
      p.style.setProperty('--dir', dir);
      p.classList.remove('is-entering');
      void p.offsetWidth;
      p.classList.add('is-entering');
      setTimeout(() => p.classList.remove('is-entering'), 400);
      panels.scrollTop = 0;
    }
    moveIndicator();
    requestAnimationFrame(() => {
      const hooks = shownHooks.get(id);
      if (hooks) for (const fn of hooks) { try { fn(); } catch (e) { console.error(e); } }
    });
  }

  /** Rebuild every panel (language change); keeps the current tab. */
  function rebuild() {
    for (const k in state) {
      const s = state[k];
      if (s.scope) s.scope.dispose();
      s.scope = null;
      s.built = false;
      s.panel.textContent = '';
    }
    select(current, false);
  }

  // tab badges: sources on, active routings, active effects, arp/chord/scale
  const badgeIds = ['osc1.on', 'osc2.on', 'fm.on', 'phys.on', 'noise.on', 'drive.on', 'chorus.on', 'phaser.on', 'delay.on', 'reverb.on', 'arp.on', 'chord.type', 'scale.type'];
  for (let i = 1; i <= MOD_SLOTS; i++) badgeIds.push(`mod${i}.src`, `mod${i}.dst`, `mod${i}.amt`);
  const updBadges = () => {
    const g = id => store.get(id);
    const srcN = ['osc1', 'osc2', 'fm', 'phys', 'noise'].filter(x => g(`${x}.on`)).length;
    let modN = 0;
    for (let i = 1; i <= MOD_SLOTS; i++) if (g(`mod${i}.src`) !== 'none' && g(`mod${i}.dst`) !== 'none' && g(`mod${i}.amt`)) modN++;
    const fxN = ['drive', 'chorus', 'phaser', 'delay', 'reverb'].filter(x => g(`${x}.on`)).length;
    const perf = [g('arp.on') && 'ARP', g('chord.type') !== 'off' && 'CHORD', g('scale.type') !== 'off' && 'SCALE'].filter(Boolean);
    state.sources.badge.textContent = srcN ? String(srcN) : '';
    state.mod.badge.textContent = modN ? String(modN) : '';
    state.fx.badge.textContent = fxN ? String(fxN) : '';
    state.perform.badge.textContent = perf.length ? perf[0] : '';
    state.perform.badge.title = perf.join(' · ');
  };
  let badgeRaf = 0;
  const schedule = () => { if (!badgeRaf) badgeRaf = requestAnimationFrame(() => { badgeRaf = 0; updBadges(); }); };
  for (const id of badgeIds) store.subscribe(id, schedule);
  updBadges();

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => moveIndicator()).observe(nav);
  // jargon explanations (tooltip + screen-reader description) on every control, also after partial re-renders
  let helpRaf = 0;
  const helpSoon = () => { if (!helpRaf) helpRaf = requestAnimationFrame(() => { helpRaf = 0; applyParamHelp(panels); }); };
  // (only element insertions matter: value readouts that change their text during automation are ignored)
  const addsElements = recs => recs.some(r => { for (const n of r.addedNodes) if (n.nodeType === 1) return true; return false; });
  if (typeof MutationObserver === 'function') new MutationObserver((recs) => { if (addsElements(recs)) helpSoon(); }).observe(panels, { childList: true, subtree: true });

  return {
    el,
    select,
    rebuild,
    get current() { return current; },
    init() { select(current, false); },
  };
}
