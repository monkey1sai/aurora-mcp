// 濾波 Filter tab: main filter (type chooser with live response thumbnails, big response curve,
// XL cutoff / resonance), serial Filter 2, and the filter envelope.

import { h } from './dom.js';
import { card, section, row, iconChoice } from './parts.js';
import { t, pairLabel } from './i18n.js';
import { PARAM_BY_ID, FILTER_TYPES } from '../../dsp/params.js';
import { icon } from './icons.js';

const VIOLET = '#a78bfa';
const AMBER = '#ffc46b';
const MACRO_IDS = ['macro1', 'macro2', 'macro3', 'macro4'];

const TYPE_LABELS = {
  ladder24: ['階梯 24', 'Ladder 24'], ladder12: ['階梯 12', 'Ladder 12'], lp: ['低通', 'SVF LP'], bp: ['帶通', 'SVF BP'],
  hp: ['高通', 'SVF HP'], notch: ['陷波', 'Notch'], formant: ['母音', 'Formant'], comb: ['梳狀', 'Comb'], off: ['關閉', 'Off'],
};

/** Tiny response-curve SVG for a filter type (computed with the real filterResponse when available). */
function thumbSvg(filterResponse, type, sampleRate = 48000) {
  const N = 56;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  let db = null;
  if (type !== 'off' && filterResponse) {
    try { db = filterResponse(type, type === 'comb' ? 350 : 900, type === 'comb' ? 0.75 : 0.55, 0, 0.25, freqs, sampleRate); } catch { db = null; }
  }
  const pts = [];
  for (let i = 0; i < N; i++) {
    const d = db ? Math.max(-42, Math.min(24, db[i])) : 0;
    pts.push(`${((i / (N - 1)) * 60).toFixed(1)},${(12 - d * 0.42).toFixed(1)}`);
  }
  return `<svg viewBox="-2 -4 64 36" class="fthumb" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function buildFilter(ctx, scope) {
  const { binder, store } = ctx;
  const root = h('div.pane.pane--filter');
  const fr = ctx.dsp.filterResponse;
  const sr = ctx.sampleRate();

  /* ── signal flow ── */
  const flow = h('div.flow', { 'aria-label': t('signalFlow') },
    h('span.flow__node', { 'data-k': 'src' }, t('tabSources')), h('span.flow__arrow'),
    h('span.flow__node', { 'data-k': 'f1' }, 'Filter 1'), h('span.flow__arrow'),
    h('span.flow__node', { 'data-k': 'f2' }, 'Filter 2'), h('span.flow__arrow'),
    h('span.flow__node', { 'data-k': 'amp' }, 'Amp'));

  /* ── filter 1 ── */
  const f1 = card({ group: 'filter', icon: 'filter', accent: VIOLET, cls: 'card--filter' });
  const f1on = binder.toggle(scope, 'filter.on', { accent: VIOLET, label: false });
  f1.head.append(f1on.el);
  const types = iconChoice(scope, store, 'filter.type', FILTER_TYPES.map(tp => ({ value: tp, svg: thumbSvg(fr, tp, sr), label: pairLabel(...TYPE_LABELS[tp]) })), { accent: VIOLET, cls: 'ichoice--filters' });
  const view = ctx.visuals.createFilterView({
    getParams: () => ({
      type: store.get('filter.type'), cutoff: binder.effective('filter.cutoff'), res: binder.effective('filter.res'),
      drive: binder.effective('filter.drive'), vowel: binder.effective('filter.vowel'), on: !!store.get('filter.on'),
    }),
    filterResponse: fr, sampleRate: sr, accent: VIOLET,
  });
  view.el.classList.add('fview');
  scope.add(() => view.destroy && view.destroy());
  const k = (id, o = {}) => binder.knob(scope, id, { accent: VIOLET, ...o }).el;
  const vowel = k('filter.vowel');
  f1.body.append(types, h('div.filter-main', null,
    h('div.fview-wrap', null, view.el),
    h('div.filter-big', null, k('filter.cutoff', { size: 'xl' }), k('filter.res', { size: 'lg' }))),
  row(k('filter.drive'), k('filter.key'), k('filter.env', { bipolar: true }), k('filter.vel'), vowel));
  const updView = () => { try { view.update(); } catch (e) { console.error(e); } };
  binder.watch(scope, ['filter.type', 'filter.cutoff', 'filter.res', 'filter.drive', 'filter.vowel', 'filter.on', ...MACRO_IDS], (s) => {
    updView();
    vowel.classList.toggle('is-disabled', s.get('filter.type') !== 'formant');
    f1.el.classList.toggle('is-off', !s.get('filter.on'));
  });

  /* ── filter 2 ── */
  const f2 = card({ group: 'filter2', icon: 'filter', accent: VIOLET, cls: 'card--filter2' });
  const p2 = PARAM_BY_ID['filter2.type'];
  const types2 = iconChoice(scope, store, 'filter2.type', p2.options.map(tp => ({ value: tp, svg: thumbSvg(fr, tp, sr), label: pairLabel(...TYPE_LABELS[tp]) })), { accent: VIOLET, cls: 'ichoice--filters ichoice--small' });
  const view2 = ctx.visuals.createFilterView({
    getParams: () => {
      const tp = store.get('filter2.type');
      return { type: tp === 'off' ? 'lp' : tp, cutoff: binder.effective('filter2.cutoff'), res: binder.effective('filter2.res'), drive: 0, vowel: 0, on: tp !== 'off' };
    },
    filterResponse: fr, sampleRate: sr, accent: VIOLET, labels: false,
  });
  view2.el.classList.add('fview', 'fview--small');
  scope.add(() => view2.destroy && view2.destroy());
  const k2 = (id, o = {}) => binder.knob(scope, id, { accent: VIOLET, size: 'md', ...o }).el;
  f2.body.append(types2, h('div.fview-wrap.fview-wrap--small', null, view2.el), row(k2('filter2.cutoff'), k2('filter2.res')),
    h('p.card__note', null, icon('link', 13), h('span', null, pairLabel('串接在濾波器 1 之後', 'Serial after Filter 1').zh)));
  binder.watch(scope, ['filter2.type', 'filter2.cutoff', 'filter2.res', ...MACRO_IDS], (s) => {
    try { view2.update(); } catch (e) { console.error(e); }
    f2.el.classList.toggle('is-bypassed', s.get('filter2.type') === 'off');
    flow.querySelector('[data-k="f2"]').classList.toggle('is-off', s.get('filter2.type') === 'off');
  });
  binder.watch(scope, ['filter.on'], s => flow.querySelector('[data-k="f1"]').classList.toggle('is-off', !s.get('filter.on')));

  /* ── filter envelope ── */
  const fe = card({ group: 'fenv', icon: 'env', accent: AMBER, cls: 'card--fenv' });
  const ed = binder.envelope(scope, 'fenv', { accent: AMBER });
  const ka = (id, o = {}) => binder.knob(scope, id, { accent: AMBER, ...o }).el;
  fe.body.append(h('div.env-wrap', null, ed.el), row(ka('fenv.a'), ka('fenv.d'), ka('fenv.s'), ka('fenv.r'), ka('fenv.curve')),
    section(pairLabel('包絡 → 截止頻率', 'Env → Cutoff'), binder.knob(scope, 'filter.env', { accent: VIOLET, size: 'md', bipolar: true }).el));

  // re-layout the curves when the tab becomes visible (canvas size was 0 while hidden)
  scope.add(ctx.onTabShown('filter', () => { updView(); try { view2.update(); } catch { /* ignore */ } }));

  root.append(flow, h('div.filter-grid', null, f1.el, h('div.filter-col', null, f2.el, fe.el)));
  return root;
}
