// 調變 Mod tab: envelopes (Amp / Filter / Mod), LFO 1 & 2 with live shape view, 8-slot mod matrix with
// source colours, grouped destinations and bipolar amounts.

import { h, createScope } from './dom.js';
import { card, section, row, iconChoice } from './parts.js';
import { t, pairLabel } from './i18n.js';
import { icon } from './icons.js';
import { createSelect } from '../components.js';
import { PARAM_BY_ID, MOD_SLOTS } from '../../dsp/params.js';
import { SOURCE_COLORS } from './controls.js';

const AMBER = '#ffc46b';

const LFO_SHAPES = [
  ['sine', 'M2 12 C6 1, 10 1, 12 12 S18 23, 22 12', '正弦', 'Sine'],
  ['tri', 'M2 12 L7 3 L17 21 L22 12', '三角', 'Tri'],
  ['saw', 'M2 21 L12 3 L12 21 L22 3', '鋸齒↑', 'Saw'],
  ['ramp', 'M2 3 L12 21 L12 3 L22 21', '鋸齒↓', 'Ramp'],
  ['square', 'M2 18 L2 5 L12 5 L12 18 L22 18 L22 5', '方波', 'Square'],
  ['sh', 'M2 15 H6 V6 H10 V17 H14 V9 H18 V13 H22', '取樣保持', 'S&H'],
  ['smooth', 'M2 14 C5 5, 8 6, 10 11 S15 20, 17 12 S21 6, 22 8', '平滑隨機', 'Smooth'],
];

export function buildMod(ctx, scope) {
  const root = h('div.pane.pane--mod');
  root.append(h('div.mod-top', null, buildEnvelopes(ctx, scope).el, buildLfo(ctx, scope, 'lfo1', '#5cf2ff').el, buildLfo(ctx, scope, 'lfo2', '#3ef0b0').el),
    buildMatrix(ctx, scope).el);
  return root;
}

/* ───────────────────────── envelopes ───────────────────────── */
function buildEnvelopes(ctx, scope) {
  const { binder } = ctx;
  const envs = [
    ['aenv', pairLabel('音量', 'Amp')], ['fenv', pairLabel('濾波', 'Filter')], ['menv', pairLabel('調變', 'Mod')],
  ];
  const c = card({ title: pairLabel('包絡', 'Envelopes'), icon: 'env', accent: AMBER, cls: 'card--envs' });
  const seg = createSelect({
    param: { type: 'enum', options: envs.map(e => e[0]), labels: envs.map(e => e[1].zh), def: ctx.ui.env || 'aenv', zh: '顯示的包絡', label: 'Envelope shown' },
    value: ctx.ui.env || 'aenv', label: false, accent: AMBER, variant: 'segmented',
    onChange: v => show(v),
  });
  c.head.append(seg.el);
  const host = h('div.envs-host');
  c.body.append(host);
  let sub = null;
  function show(id) {
    ctx.ui.env = id;
    if (sub) sub.dispose();
    sub = createScope();
    host.textContent = '';
    const ed = binder.envelope(sub, id, { accent: AMBER });
    const k = (pid, o = {}) => binder.knob(sub, pid, { accent: AMBER, ...o }).el;
    const extra = id === 'aenv' ? section(pairLabel('音量', 'Amp'), k('amp.level'), k('amp.vel'))
      : id === 'fenv' ? section(pairLabel('包絡量', 'Env amount'), k('filter.env', { bipolar: true }))
        : h('p.card__note', null, icon('mod', 13), h('span', null, pairLabel('在下方調變矩陣中選擇「Mod Env」作為來源', 'Pick “Mod Env” as a source in the matrix below').zh));
    const wrap = h('div.envs-view.is-entering', null, h('div.env-wrap', null, ed.el), row(k(`${id}.a`), k(`${id}.d`), k(`${id}.s`), k(`${id}.r`), k(`${id}.curve`)), extra);
    host.append(wrap);
    requestAnimationFrame(() => wrap.classList.remove('is-entering'));
    if (id === 'aenv') {
      sub.add(ctx.onState((st) => {
        let best = null;
        if (st && st.voices) for (const v of st.voices) if (v.stage !== 'idle' && (!best || v.age < best.age)) best = v;
        if (best) ed.setPlayhead(best.level, best.stage); else ed.setPlayhead(null);
      }));
    }
  }
  scope.add(() => sub && sub.dispose());
  show(ctx.ui.env || 'aenv');
  return c;
}

/* ───────────────────────── LFOs ───────────────────────── */
function buildLfo(ctx, scope, id, accent) {
  const { binder, store } = ctx;
  const mode = binder.select(scope, `${id}.mode`, { accent, label: false, variant: 'segmented' });
  const c = card({ group: id, icon: 'mod', accent, cls: 'card--lfo', extra: [mode.el] });
  const view = ctx.visuals.createLfoView({
    getParams: () => ({
      shape: store.get(`${id}.shape`), rate: binder.effective(`${id}.rate`), sync: store.get(`${id}.sync`),
      fade: store.get(`${id}.fade`), phase: store.get(`${id}.phase`), mode: store.get(`${id}.mode`), bpm: store.get('global.bpm'),
    }),
    accent,
  });
  view.el.classList.add('lfoview');
  scope.add(() => view.destroy && view.destroy());
  const shapes = iconChoice(scope, store, `${id}.shape`, LFO_SHAPES.map(([value, d, zh, en]) => ({
    value, label: pairLabel(zh, en),
    svg: `<svg viewBox="0 0 24 24" class="lshape" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  })), { accent, cls: 'ichoice--lfo' });
  const rate = binder.knob(scope, `${id}.rate`, { accent, size: 'md' });
  const sync = binder.select(scope, `${id}.sync`, { accent, variant: 'dropdown' });
  const k = (name) => binder.knob(scope, `${id}.${name}`, { accent }).el;
  const uses = h('div.lfo-uses');
  c.body.append(h('div.lfoview-wrap', null, view.el), shapes, h('div.lfo-ctl', null, rate.el, h('div.lfo-sync', null, sync.el), k('fade'), k('phase')), uses);
  const slotIds = [];
  for (let i = 1; i <= MOD_SLOTS; i++) slotIds.push(`mod${i}.src`, `mod${i}.dst`, `mod${i}.amt`);
  binder.watch(scope, [`${id}.shape`, `${id}.rate`, `${id}.sync`, `${id}.fade`, `${id}.phase`, `${id}.mode`, 'global.bpm', ...slotIds], (s) => {
    try { view.update(); } catch (e) { console.error(e); }
    const synced = s.get(`${id}.sync`) !== 'off';
    rate.el.classList.toggle('is-disabled', synced);
    c.el.classList.toggle('is-synced', synced);
    // destinations fed by this LFO
    uses.textContent = '';
    for (let i = 1; i <= MOD_SLOTS; i++) {
      if (s.get(`mod${i}.src`) !== id || s.get(`mod${i}.dst`) === 'none') continue;
      const p = PARAM_BY_ID[s.get(`mod${i}.dst`)];
      if (!p) continue;
      const nm = pairLabel(p.zh, p.label);
      uses.append(h('span.use-chip', { '--c': accent, title: `${nm.zh} · ${nm.en}` }, h('b', null, `${i}`), `→ ${nm.zh}`));
    }
    if (!uses.childNodes.length) uses.append(h('span.use-none', null, pairLabel('尚未指派 — 到調變矩陣連接', 'Unassigned — route it in the matrix').zh));
  });
  scope.add(ctx.onTabShown('mod', () => { try { view.update(); } catch { /* ignore */ } }));
  return c;
}

/* ───────────────────────── mod matrix ───────────────────────── */
function buildMatrix(ctx, scope) {
  const { store, binder } = ctx;
  const count = h('span.mm-count');
  const c = card({ group: 'mod', icon: 'sliders', accent: AMBER, cls: 'card--matrix', extra: [count] });
  const grid = h('div.mm-grid');
  const head = () => h('div.mm-row.mm-row--head', null, h('span'), h('span', null, t('source')), h('span'), h('span', null, t('destination')), h('span', null, t('amount')), h('span'));
  grid.append(head(), head());
  const rows = [];
  for (let i = 1; i <= MOD_SLOTS; i++) {
    const src = binder.select(scope, `mod${i}.src`, { label: false, variant: 'dropdown' });
    const dst = binder.select(scope, `mod${i}.dst`, { label: false, variant: 'dropdown' });
    const amt = binder.slider(scope, `mod${i}.amt`, { label: false, bipolar: true, accent: AMBER });
    const clr = h('button.icon-btn.mm-clear', { type: 'button', title: t('clear'), 'aria-label': `${t('clear')} ${i}` }, icon('x', 14));
    clr.addEventListener('click', () => store.setMany({ [`mod${i}.src`]: 'none', [`mod${i}.dst`]: 'none', [`mod${i}.amt`]: 0 }));
    const r = h('div.mm-row', null, h('span.mm-n', null, String(i)), src.el, h('span.mm-arrow', null, icon('next', 14)), dst.el, amt.el, clr);
    rows.push({ r, src, amt });
    grid.append(r);
  }
  c.body.append(grid, h('p.card__note', null, icon('mod', 13), h('span', null, t('modArcHint'))));
  const ids = [];
  for (let i = 1; i <= MOD_SLOTS; i++) ids.push(`mod${i}.src`, `mod${i}.dst`, `mod${i}.amt`);
  binder.watch(scope, ids, (s) => {
    let n = 0;
    rows.forEach(({ r, src, amt }, i) => {
      const sv = s.get(`mod${i + 1}.src`);
      const active = sv !== 'none' && s.get(`mod${i + 1}.dst`) !== 'none' && s.get(`mod${i + 1}.amt`) !== 0;
      if (active) n++;
      const col = SOURCE_COLORS[sv] || SOURCE_COLORS.none;
      r.style.setProperty('--src', col);
      src.el.style.setProperty('--k-accent', col);
      amt.setAccent && amt.setAccent(sv === 'none' ? AMBER : col);
      r.classList.toggle('is-empty', sv === 'none');
      r.classList.toggle('is-active', active);
    });
    count.textContent = `${n} / ${MOD_SLOTS}`;
  });
  return c;
}

