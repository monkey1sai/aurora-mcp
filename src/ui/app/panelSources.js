// 聲源 Sources tab: source rack (mixer strips with glowing on/off) + detailed card of the selected
// source (osc waveform/wavetable preview, FM algorithm diagram + operators, physical model pictograms,
// noise colour) + amp envelope card.

import { h, createScope } from './dom.js';
import { icon } from './icons.js';
import { card, section, row, iconChoice } from './parts.js';
import { t, pairLabel, groupLabel, getLang } from './i18n.js';
import { PARAM_BY_ID, WAVETABLE_LABELS, WAVETABLES } from '../../dsp/params.js';
import { createWavePreview, fmDiagramSvg, FALLBACK_ALGOS } from './sourceViz.js';

export const SOURCE_DEFS = [
  { id: 'osc1', icon: 'osc', accent: '#5cf2ff' },
  { id: 'osc2', icon: 'osc', accent: '#3ef0b0' },
  { id: 'fm', icon: 'fm', accent: '#a78bfa' },
  { id: 'phys', icon: 'phys', accent: '#ffc46b' },
  { id: 'noise', icon: 'noise', accent: '#ff6bd6' },
];
const AMBER = '#ffc46b';

const PHYS_MODELS = [
  ['string', 'm-string', '弦', 'String'], ['bar', 'm-bar', '音條', 'Bar'], ['bell', 'm-bell', '鐘', 'Bell'],
  ['glass', 'm-glass', '玻璃', 'Glass'], ['membrane', 'm-membrane', '鼓皮', 'Membrane'], ['plate', 'm-plate', '金屬板', 'Plate'],
];
const PHYS_EXCITERS = [
  ['pluck', 'x-pluck', '撥奏', 'Pluck'], ['mallet', 'x-mallet', '敲擊', 'Mallet'], ['bow', 'x-bow', '弓奏', 'Bow'], ['breath', 'x-breath', '吹奏', 'Breath'],
];

/** Short summary line for a source strip. */
function summary(store, id) {
  const g = k => store.get(`${id}.${k}`);
  if (id === 'osc1' || id === 'osc2') {
    const u = g('unison');
    const base = g('mode') === 'wavetable' ? WAVETABLE_LABELS[WAVETABLES.indexOf(g('table'))] : shapeName(g('shape'));
    return `${base}${u > 1 ? ` · ${u}×` : ''}`;
  }
  if (id === 'fm') return `Algo ${g('algo')}`;
  if (id === 'phys') return `${PARAM_BY_ID['phys.model'].labels[PARAM_BY_ID['phys.model'].options.indexOf(g('model'))]} · ${PARAM_BY_ID['phys.exciter'].labels[PARAM_BY_ID['phys.exciter'].options.indexOf(g('exciter'))]}`;
  const c = g('color');
  return c < -0.35 ? 'Brown' : c < -0.1 ? 'Pink' : c < 0.15 ? 'White' : 'Blue';
}
function shapeName(s) {
  if (s < 0.08) return 'Sine';
  if (Math.abs(s - 1 / 3) < 0.06) return 'Triangle';
  if (Math.abs(s - 2 / 3) < 0.06) return 'Saw';
  if (s > 0.94) return 'Square';
  return s < 1 / 3 ? 'Sine→Tri' : s < 2 / 3 ? 'Tri→Saw' : 'Saw→Sqr';
}

export function buildSources(ctx, scope) {
  const { store, binder } = ctx;
  const root = h('div.pane.pane--sources');
  const rack = h('div.src-rack', { role: 'tablist', 'aria-label': t('sourceMix') });
  const detail = h('div.src-detail');
  let detailScope = null;
  let selected = ctx.ui.selectedSource || 'osc1';
  const strips = {};

  for (const def of SOURCE_DEFS) {
    const { id, accent } = def;
    const tg = binder.toggle(scope, `${id}.on`, { accent, size: 'sm', label: false });
    const lvl = binder.knob(scope, `${id}.level`, { size: 'sm', label: false, showValue: false, accent });
    const sumEl = h('span.src-strip__sum');
    const name = groupLabel(id);
    const sel = h('button.src-strip__sel', { type: 'button', role: 'tab' },
      h('span.src-strip__ic', null, icon(def.icon, 18)),
      h('span.src-strip__txt', null, h('span.src-strip__name', null, name.zh), h('span.src-strip__en', null, name.en), sumEl));
    const strip = h('div.src-strip', { '--acc': accent }, sel, h('div.src-strip__ctl', null, lvl.el, tg.el));
    sel.addEventListener('click', () => select(id));
    strips[id] = strip;
    rack.append(strip);
    const watchIds = [`${id}.on`, ...Object.keys(PARAM_BY_ID).filter(k => k.startsWith(`${id}.`) && /\.(mode|table|shape|unison|algo|model|exciter|color)$/.test(k))];
    binder.watch(scope, watchIds, (s) => {
      strip.classList.toggle('is-on', !!s.get(`${id}.on`));
      sumEl.textContent = summary(s, id);
    });
  }

  function select(id) {
    selected = id;
    ctx.ui.selectedSource = id;
    for (const k in strips) {
      strips[k].classList.toggle('is-selected', k === id);
      strips[k].querySelector('.src-strip__sel').setAttribute('aria-selected', String(k === id));
    }
    if (detailScope) detailScope.dispose();
    detailScope = createScope();
    detail.textContent = '';
    const def = SOURCE_DEFS.find(d => d.id === id);
    const builder = id === 'fm' ? buildFm : id === 'phys' ? buildPhys : id === 'noise' ? buildNoise : buildOsc;
    const c = builder(ctx, detailScope, id, def.accent);
    c.el.classList.add('is-entering');
    detail.append(c.el);
    requestAnimationFrame(() => c.el.classList.remove('is-entering'));
  }
  scope.add(() => detailScope && detailScope.dispose());

  // after a preset load, jump to the first active source if the selected one is switched off
  scope.add(store.onPatch(() => {
    if (store.get(`${selected}.on`)) return;
    const first = SOURCE_DEFS.find(d => store.get(`${d.id}.on`));
    if (first) select(first.id);
  }));

  const amp = buildAmp(ctx, scope);
  root.append(h('div.src-col', null, h('div.col-label', null, h('span', null, t('sourceMix'))), rack), detail, amp.el);
  if (!store.get(`${selected}.on`)) { const first = SOURCE_DEFS.find(d => store.get(`${d.id}.on`)); if (first) selected = first.id; }
  select(selected);
  return root;
}

/* ───────────────────────── common header pieces ───────────────────────── */
function onOff(ctx, scope, id, accent, c) {
  const tg = ctx.binder.toggle(scope, `${id}.on`, { accent, label: false });
  ctx.binder.watch(scope, [`${id}.on`], s => c.el.classList.toggle('is-off', !s.get(`${id}.on`)));
  const hint = h('div.card__offhint', null, icon('fx', 14), h('span', null, t('sourceOff')));
  c.body.append(hint);
  return tg;
}

/* ───────────────────────── oscillator ───────────────────────── */
function buildOsc(ctx, scope, id, accent) {
  const { binder, store } = ctx;
  const k = (name, o = {}) => binder.knob(scope, `${id}.${name}`, { accent, ...o }).el;
  const mode = binder.select(scope, `${id}.mode`, { accent, label: false });
  const c = card({ group: id, icon: 'osc', accent, cls: 'card--src card--osc', extra: [mode.el] });
  c.head.append(onOff(ctx, scope, id, accent, c).el);
  const preview = createWavePreview({ accent, getFrame: ctx.dsp.getWavetableFrame });
  const table = binder.select(scope, `${id}.table`, { accent, variant: 'dropdown' });
  const tableWrap = h('div.osc-table', null, table.el);
  const pwEl = k('pw');
  const left = h('div.osc-left', null, preview.el, tableWrap, row(k('shape', { size: 'md' }), pwEl, k('sync')));
  const right = h('div.osc-right', null,
    section(pairLabel('音高', 'Pitch'), k('oct'), k('semi'), k('fine')),
    section(pairLabel('齊奏', 'Unison'), k('unison'), k('detune'), k('spread'), k('blend')),
    section(pairLabel('輸出', 'Output'), k('level'), k('pan'), k('filt'), k('drift')),
    section(pairLabel('相位', 'Phase'), binder.select(scope, `${id}.phase`, { accent, label: false }).el));
  c.body.append(h('div.osc-grid', null, left, right));
  const ids = ['mode', 'shape', 'table', 'pw', 'sync', 'on'].map(x => `${id}.${x}`);
  binder.watch(scope, ids, (s) => {
    const wt = s.get(`${id}.mode`) === 'wavetable';
    tableWrap.classList.toggle('is-hidden', !wt);
    pwEl.classList.toggle('is-disabled', wt);
    preview.draw({ mode: s.get(`${id}.mode`), shape: s.get(`${id}.shape`), table: s.get(`${id}.table`), pw: s.get(`${id}.pw`), sync: s.get(`${id}.sync`), on: !!s.get(`${id}.on`) });
  });
  return c;
}

/* ───────────────────────── FM ───────────────────────── */
function buildFm(ctx, scope, id, accent) {
  const { binder, store } = ctx;
  const algos = ctx.dsp.FM_ALGORITHMS || FALLBACK_ALGOS;
  const k = (pid, o = {}) => binder.knob(scope, pid, { accent, ...o }).el;
  const c = card({ group: 'fm', icon: 'fm', accent, cls: 'card--src card--fm' });
  c.head.append(onOff(ctx, scope, 'fm', accent, c).el);
  const diagram = h('div.fm-diagram');
  const algoName = h('div.fm-algo-name');
  const picker = h('div.fm-algos', { role: 'radiogroup', 'aria-label': 'FM algorithm' });
  const pickBtns = algos.map((a) => {
    const b = h('button.fm-algo', { type: 'button', role: 'radio', title: `${a.id}. ${a.zh} ${a.name}` }, h('span.fm-algo__svg', { html: fmDiagramSvg(a, { mini: true, accent: '#5cf2ff', modAccent: accent }) }), h('span.fm-algo__n', null, String(a.id)));
    b.addEventListener('click', () => store.set('fm.algo', a.id, { origin: picker }));
    picker.append(b);
    return b;
  });
  let activeOp = 0;
  const top = h('div.fm-top', null,
    h('div.fm-diag-wrap', null, diagram, algoName),
    h('div.fm-side', null, h('div.sect__label', null, h('span', null, t('algorithm'))), picker,
      h('div.krow.fm-globals', null, k('fm.level'), k('fm.feedback'), k('fm.oct'), k('fm.fine'), k('fm.filt'), k('fm.pan'))));
  const ops = h('div.fm-ops');
  const opRows = [];
  for (let i = 1; i <= 4; i++) {
    const p = `fm.op${i}`;
    const role = h('span.fm-op__role');
    const badge = h('div.fm-op__badge', null, h('span.fm-op__n', null, `OP${i}`), role);
    const r = h('div.fm-op', { 'data-op': i }, badge,
      h('div.fm-op__grp', null, k(`${p}.ratio`, { snap: 'ratio', size: 'sm' }), k(`${p}.detune`), k(`${p}.level`)),
      h('div.fm-op__grp.fm-op__env', null, k(`${p}.a`), k(`${p}.d`), k(`${p}.s`), k(`${p}.r`)),
      h('div.fm-op__grp', null, k(`${p}.vel`), k(`${p}.kscale`)));
    opRows.push({ r, role });
    ops.append(r);
  }
  diagram.addEventListener('click', (e) => {
    const g = e.target.closest && e.target.closest('[data-op]');
    if (!g) return;
    activeOp = +g.dataset.op;
    const row = opRows[activeOp - 1].r;
    row.classList.remove('is-flash');
    void row.offsetWidth;
    row.classList.add('is-flash');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  c.body.append(top, ops);
  const levelIds = [1, 2, 3, 4].map(i => `fm.op${i}.level`);
  binder.watch(scope, ['fm.algo', 'fm.on', ...levelIds], (s) => {
    const a = algos[(s.get('fm.algo') | 0) - 1] || algos[0];
    const levels = levelIds.map(x => s.get(x));
    diagram.innerHTML = fmDiagramSvg(a, { accent: '#5cf2ff', modAccent: accent, levels, active: activeOp });
    algoName.innerHTML = '';
    const en = getLang() === 'en';
    algoName.append(h('b', null, `${a.id}`), h('span', null, en ? a.name : a.zh), h('small', null, en ? a.zh : a.name));
    pickBtns.forEach((b, i) => { const on = i === a.id - 1; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    const carriers = new Set(a.carriers);
    opRows.forEach(({ r, role }, i) => {
      const isC = carriers.has(i + 1);
      r.classList.toggle('is-carrier', isC);
      role.textContent = isC ? t('carrier') : t('modulator');
      r.classList.toggle('has-fb', (a.feedback || 4) === i + 1);
    });
  });
  return c;
}

/* ───────────────────────── physical model ───────────────────────── */
function buildPhys(ctx, scope, id, accent) {
  const { binder, store } = ctx;
  const k = (name, o = {}) => binder.knob(scope, `phys.${name}`, { accent, ...o }).el;
  const c = card({ group: 'phys', icon: 'phys', accent, cls: 'card--src card--phys' });
  c.head.append(onOff(ctx, scope, 'phys', accent, c).el);
  const models = iconChoice(scope, store, 'phys.model', PHYS_MODELS.map(([value, ic, zh, en]) => ({ value, icon: ic, label: pairLabel(zh, en) })), { accent, cls: 'ichoice--models' });
  const exciters = iconChoice(scope, store, 'phys.exciter', PHYS_EXCITERS.map(([value, ic, zh, en]) => ({ value, icon: ic, label: pairLabel(zh, en) })), { accent, cls: 'ichoice--exc' });
  const pressure = k('pressure');
  c.body.append(
    h('div.phys-choosers', null,
      h('div.phys-choice', null, h('div.sect__label', null, h('span', null, t('model')), h('small', null, 'Model')), models),
      h('div.phys-choice', null, h('div.sect__label', null, h('span', null, t('exciter')), h('small', null, 'Exciter')), exciters)),
    h('div.phys-knobs', null,
      section(pairLabel('激發', 'Exciter'), k('hardness', { size: 'md' }), k('position'), pressure),
      section(pairLabel('共鳴體', 'Resonator'), k('decay', { size: 'md' }), k('brightness'), k('inharm'), k('body'), k('damp')),
      section(pairLabel('輸出', 'Output'), k('level'), k('spread'), k('oct'), k('fine'), k('filt'), k('pan'))));
  binder.watch(scope, ['phys.exciter'], (s) => {
    const cont = s.get('phys.exciter') === 'bow' || s.get('phys.exciter') === 'breath';
    pressure.classList.toggle('is-disabled', !cont);
  });
  return c;
}

/* ───────────────────────── noise ───────────────────────── */
function buildNoise(ctx, scope, id, accent) {
  const { binder } = ctx;
  const k = (name, o = {}) => binder.knob(scope, `noise.${name}`, { accent, ...o }).el;
  const c = card({ group: 'noise', icon: 'noise', accent, cls: 'card--src card--noise' });
  c.head.append(onOff(ctx, scope, 'noise', accent, c).el);
  const tilt = h('div.noise-tilt');
  c.body.append(h('div.noise-grid', null,
    h('div.noise-color', null, tilt, k('color', { size: 'lg' })),
    h('div', null,
      section(pairLabel('音色', 'Tone'), k('decay', { size: 'md' }), k('width')),
      section(pairLabel('輸出', 'Output'), k('level'), k('filt'), k('pan')))));
  binder.watch(scope, ['noise.color', 'noise.on'], (s) => {
    const col = s.get('noise.color');
    // spectrum slope: −1 brown (−6 dB/oct) … 0 white … +1 blue (+3 dB/oct), drawn over 20 Hz–20 kHz
    const slope = col < 0 ? col * 6 : col * 3;
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const x = i / 40;
      const oct = x * 10 - 5;
      const db = slope * oct;
      pts.push(`${(x * 200).toFixed(1)},${(40 - db * 1.4).toFixed(1)}`);
    }
    // deterministic "noise" texture along the line
    const jag = pts.map((p, i) => { const [x, y] = p.split(','); return `${x},${(+y + Math.sin(i * 12.9898) * 3.2).toFixed(1)}`; }).join(' ');
    tilt.innerHTML = `<svg viewBox="0 0 200 80" preserveAspectRatio="none"><defs><linearGradient id="ntg" x1="0" x2="1"><stop offset="0" stop-color="#b8743a"/><stop offset=".5" stop-color="#e8ecff"/><stop offset="1" stop-color="#6b9dff"/></linearGradient></defs><polyline points="${jag}" fill="none" stroke="url(#ntg)" stroke-width="1.6" stroke-linejoin="round" opacity="${s.get('noise.on') ? 1 : 0.4}"/><polyline points="${pts.join(' ')} 200,80 0,80" fill="url(#ntg)" opacity=".12"/></svg>`;
  });
  return c;
}

/* ───────────────────────── amp envelope ───────────────────────── */
export function buildAmp(ctx, scope) {
  const { binder } = ctx;
  const c = card({ title: pairLabel('音量包絡', 'Amp Envelope'), icon: 'amp', accent: AMBER, cls: 'card--amp' });
  const ed = binder.envelope(scope, 'aenv', { accent: AMBER });
  const k = (pid, o = {}) => binder.knob(scope, pid, { accent: AMBER, ...o }).el;
  c.body.append(h('div.env-wrap', null, ed.el),
    row(k('aenv.a'), k('aenv.d'), k('aenv.s'), k('aenv.r'), k('aenv.curve')),
    section(pairLabel('音量', 'Amp'), k('amp.level'), k('amp.vel'), k('amp.pan')));
  scope.add(ctx.onState((st) => {
    const v = newestVoice(st);
    if (v) ed.setPlayhead(v.level, v.stage); else ed.setPlayhead(null);
  }));
  return c;
}

export function newestVoice(st) {
  if (!st || !st.voices || !st.voices.length) return null;
  let best = null;
  for (const v of st.voices) if (v.stage !== 'idle' && (!best || v.age < best.age)) best = v;
  return best;
}

