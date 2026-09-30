// AURORA 極光 — A/B 音色變形 Morph.
// A = the current patch, B = any preset (searchable picker, 🎲 random). A big slider (or the auto-morph sweep)
// blends the two through transient store writes, so knobs follow and nothing lands in undo history until
// 保留 Keep records the morph point as a new patch (one undo step).
//
// The blend is store.js blendValues(): continuous params glide in normalised space, an engine/effect present in
// only one side fades its level/mix instead of switching, filters sweep open, mod routes cross through zero.
// Macros: both sides are morphed with their macro offsets baked in (effectiveValues), so the sound is continuous
// through the middle; Keep re-attaches the nearer side's macro definitions and knob positions.
//
//   const morph = createMorphPanel({ store, audio, presets, categories });  container.append(morph.el);

import { h, createScope, storage } from '../app/dom.js';
import { onLangChange } from '../app/i18n.js';
import { createToggle, createSlider } from '../components.js';
import { PARAM_BY_ID, toNorm, fromNorm } from '../../dsp/params.js';
import { PATCH_IDS, STRUCTURAL, structuralChange, blendValues, sanitizeValue, normalizeMacros } from '../app/store.js';
import { ensureMagicStyles, biLabel, biTitle, biText, relabel, svgIcon, pill, ICON, L, createAuditionButton } from './smart.js';

/* ═══════════════════════════════ pure morph math (Node-testable) ═══════════════════════════════ */

/** Complete native patch values of a preset (defaults filled in, global params excluded, sanitised). */
export function presetValues(preset) {
  const params = (preset && preset.params) || {};
  const out = {};
  for (const id of PATCH_IDS) { const p = PARAM_BY_ID[id]; out[id] = sanitizeValue(p, params[id] !== undefined ? params[id] : p.def); }
  return out;
}

/** Values with the macro offsets baked in (what the engine hears) and macro knobs at 0. */
export function effectiveValues(values, macros) {
  const out = { ...values };
  const acc = new Map();
  (macros || []).forEach((m, i) => {
    const mv = +values[`macro${i + 1}`] || 0;
    if (!mv || !m || !m.targets) return;
    for (const t of m.targets) {
      const p = PARAM_BY_ID[t.id];
      if (!p || (p.type !== 'float' && p.type !== 'int')) continue;
      acc.set(t.id, (acc.has(t.id) ? acc.get(t.id) : toNorm(p, values[t.id])) + t.amount * mv);
    }
  });
  for (const [id, n] of acc) out[id] = sanitizeValue(PARAM_BY_ID[id], fromNorm(PARAM_BY_ID[id], n < 0 ? 0 : n > 1 ? 1 : n));
  for (let i = 1; i <= 4; i++) out[`macro${i}`] = 0;
  return out;
}

/** Undo effectiveValues for a macro set: base = eff − Σ amount·macro (clamped), macro knobs restored. */
export function unbakeMacros(eff, macros, macroValues) {
  const out = { ...eff };
  const acc = new Map();
  (macros || []).forEach((m, i) => {
    const mv = +macroValues[i] || 0;
    if (!mv || !m || !m.targets) return;
    for (const t of m.targets) {
      const p = PARAM_BY_ID[t.id];
      if (!p || (p.type !== 'float' && p.type !== 'int')) continue;
      acc.set(t.id, (acc.has(t.id) ? acc.get(t.id) : toNorm(p, eff[t.id])) - t.amount * mv);
    }
  });
  for (const [id, n] of acc) out[id] = sanitizeValue(PARAM_BY_ID[id], fromNorm(PARAM_BY_ID[id], n < 0 ? 0 : n > 1 ? 1 : n));
  for (let i = 1; i <= 4; i++) out[`macro${i}`] = +macroValues[i - 1] || 0;
  return out;
}

/**
 * The morph point between two patches: { values, macros } where values is complete (native) and macros are the
 * nearer side's definitions (t < ½ → A). t = 0 / 1 reproduce A / B exactly (macro knobs included).
 */
export function morphPatch(A, B, t) {
  if (!(t > 0)) return { values: { ...A.values }, macros: A.macros };
  if (t >= 1) return { values: { ...B.values }, macros: B.macros };
  // no position-based level dip: the kept/rested morph point must never sit on a muted engine
  const eff = blendValues(effectiveValues(A.values, A.macros), effectiveValues(B.values, B.macros), t, PATCH_IDS, { dip: false });
  const near = t < 0.5 ? A : B;
  const mv = [1, 2, 3, 4].map(i => +near.values[`macro${i}`] || 0);
  return { values: unbakeMacros(eff, near.macros, mv), macros: near.macros };
}

/* ═══════════════════════════════ panel ═══════════════════════════════ */

const baseName = n => String(n || '').split(' × ')[0].trim() || 'A';

/**
 * @param {{ store: object, audio?: object, presets?: object[], categories?: object[], compact?: boolean }} opts
 * @returns {{ el: HTMLElement, destroy(): void, setB(preset): void, setT(t:number): void, keep(): void, stopAuto(): void }}
 */
export function createMorphPanel({ store, audio = null, presets = [], categories = [], compact = false } = {}) {
  ensureMagicStyles();
  const scope = createScope();
  const saved = storage.get('aurora.magic.morph', null) || {};
  const list = (presets || []).filter(p => p && p.params);
  const catOf = id => (categories || []).find(c => c.id === id) || null;
  const colorOf = id => (catOf(id) && catOf(id).color) || '#a78bfa';

  let A = null;            // { values, macros, eff, name, category, key }
  let B = null;            // { values, macros, eff, name, category, key, preset }
  let Bprev = null;        // crossfade source while B changes mid-morph
  let retarget = 1;        // 0..1 crossfade Bprev → B
  let t = 0;
  let auto = false;
  let phase = 0;
  let period = Number.isFinite(saved.period) ? saved.period : 12;
  const own = new Set();   // params we wrote transiently
  const pinned = new Set();// params the user edited while morphing (left alone until the next A)
  let claimed = false;

  const el = h('section.mt.mt-morph', { 'aria-label': L('A/B 音色變形', 'A/B morph') });
  if (compact) el.classList.add('mt--compact');

  /* ── header ── */
  const listen = createAuditionButton({ store, audio });
  const head = h('header.mt-head', null,
    h('div.mt-title', null, svgIcon(ICON.morph, 18, 'mt-title__ic'), biLabel('A/B 音色變形', 'Morph', 'mt-title__txt')),
    h('div.mt-head__actions', null, listen.el));

  /* ── A / B cards ── */
  const cardA = h('div.mt-morph__card.is-a', null, h('span.mt-morph__tag', null, 'A'), h('div.mt-morph__meta', null, h('b.mt-morph__name'), h('small.mt-morph__cat')));
  const bName = h('b.mt-morph__name');
  const bCat = h('small.mt-morph__cat');
  const cardB = h('button.mt-morph__card.is-b', { type: 'button', 'aria-haspopup': 'listbox', ...biTitle('選擇 B 音色', 'Choose preset B') },
    h('span.mt-morph__tag', null, 'B'), h('div.mt-morph__meta', null, bName, bCat), svgIcon(ICON.search, 16, 'mt-morph__pick'));
  const dice = h('button.mt-morph__dice', { type: 'button', ...biTitle('隨機選一個 B', 'Random B') }, svgIcon(ICON.dice, 20));
  const ends = h('div.mt-morph__ends', null, cardA, h('span.mt-morph__arrow', { 'aria-hidden': 'true' }, svgIcon(ICON.swap, 18)), h('div.mt-morph__bwrap', null, cardB, dice));

  /* ── picker ── */
  const search = h('input.mt-morph__search', {
    type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: L('搜尋音色…', 'Search presets…'),
    'data-zh-ph': '搜尋音色…', 'data-en-ph': 'Search presets…', 'aria-label': L('搜尋音色', 'Search presets'), 'data-zh-aria': '搜尋音色', 'data-en-aria': 'Search presets',
  });
  const results = h('ul.mt-morph__list', { role: 'listbox', 'aria-label': L('音色', 'Presets') });
  const picker = h('div.mt-morph__picker', { hidden: true }, h('div.mt-morph__searchrow', null, svgIcon(ICON.search, 15), search), results);

  /* ── big slider ── */
  const pct = h('span.mt-morph__pct', null, '0%');
  const labA = h('span.mt-morph__endlbl.is-a', null, 'A');
  const labB = h('span.mt-morph__endlbl.is-b', null, 'B');
  const thumb = h('div.mt-morph__thumb', null, h('span'));
  const fill = h('div.mt-morph__fill');
  const track = h('div.mt-morph__track', { role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': L('變形位置', 'Morph position'), 'data-zh-aria': '變形位置', 'data-en-aria': 'Morph position' },
    h('div.mt-morph__rail', null, fill, h('i.mt-morph__tick', { style: 'left:25%' }), h('i.mt-morph__tick.is-mid', { style: 'left:50%' }), h('i.mt-morph__tick', { style: 'left:75%' })), thumb);
  const sliderWrap = h('div.mt-morph__slider', null, h('div.mt-morph__scale', null, labA, pct, labB), track);

  /* ── auto + actions ── */
  const autoToggle = createToggle({ label: false, value: false, accent: 'aurora', size: 'sm', onChange: v => setAuto(v) });
  autoToggle.el.setAttribute('aria-label', L('自動變形', 'Auto-morph'));
  const periodSl = createSlider({
    param: { id: '', type: 'float', min: 3, max: 40, def: 12, unit: 's', curve: 'exp', zh: '週期', label: 'Period' },
    value: period, accent: 'var(--a-violet)', label: false,
    onChange: (v) => { period = v; storage.set('aurora.magic.morph', { period }); },
  });
  const autoRow = h('div.mt-morph__auto', null, autoToggle.el, biLabel('自動變形', 'Auto-morph', 'mt-row__lbl'), h('div.mt-morph__period', null, biText('span.mt-row__end', '週期', 'Period'), periodSl.el));
  const keepBtn = pill(biLabel('保留', 'Keep'), { class: 'mt-morph__keep is-primary', ...biTitle('把目前的變形結果存成新音色（可復原）', 'Keep this morph as the new patch (undoable)') }, ICON.keep);
  const backBtn = pill(biLabel('回到 A', 'Back to A'), { class: 'mt-morph__back', ...biTitle('滑回原本的音色 A', 'Glide back to A') }, ICON.revert);
  const actions = h('div.mt-morph__actions', null, backBtn, keepBtn);

  el.append(head, ends, picker, sliderWrap, autoRow, actions);

  /* ── state ── */
  function snapA() {
    const meta = store.getMeta();
    const values = store.committedValues();
    const vals = {};
    for (const id of PATCH_IDS) vals[id] = values[id];
    const macros = JSON.parse(JSON.stringify(store.getMacros()));
    A = { values: vals, macros, eff: effectiveValues(vals, macros), name: meta.name, category: meta.category, key: meta.key };
    pinned.clear();
    renderCards();
  }
  function setB(preset, { silent = false } = {}) {
    if (!preset) return;
    const values = presetValues(preset);
    const macros = normalizeMacros(preset.macros);
    const next = { values, macros, eff: effectiveValues(values, macros), name: preset.name, category: preset.category, key: preset.key || preset.name, preset };
    if (B && t > 0) { Bprev = currentB(); retarget = 0; } else { Bprev = null; retarget = 1; }
    B = next;
    storage.set('aurora.magic.morph', { period, b: B.name });
    renderCards();
    closePicker();
    if (!silent) { cardB.classList.remove('is-new'); void cardB.offsetWidth; cardB.classList.add('is-new'); }
    if (t > 0) schedule();
  }
  /** B as heard right now (mid-crossfade when B was just changed). */
  function currentB() {
    if (!Bprev || retarget >= 1) return B;
    const eff = blendValues(Bprev.eff, B.eff, retarget, PATCH_IDS, { dip: false });
    return { ...B, eff };
  }
  function randomB() {
    const pool = list.filter(p => p.name !== (A && A.name) && p.name !== (B && B.name));
    if (!pool.length) return;
    setB(pool[Math.floor(Math.random() * pool.length)]);
    dice.classList.remove('is-roll'); void dice.offsetWidth; dice.classList.add('is-roll');
  }

  function renderCards() {
    const an = cardA.querySelector('.mt-morph__name'), ac = cardA.querySelector('.mt-morph__cat');
    an.textContent = A ? A.name : '—';
    const ca = A && catOf(A.category);
    ac.textContent = ca ? L(ca.zh, ca.label) : L('目前音色', 'Current sound');
    cardA.style.setProperty('--mc', A ? colorOf(A.category) : '#5cf2ff');
    bName.textContent = B ? B.name : L('選一個音色', 'Pick a preset');
    const cb = B && catOf(B.category);
    bCat.textContent = cb ? L(cb.zh, cb.label) : '';
    cardB.style.setProperty('--mc', B ? colorOf(B.category) : '#ff6bd6');
    el.style.setProperty('--ma', A ? colorOf(A.category) : '#5cf2ff');
    el.style.setProperty('--mb', B ? colorOf(B.category) : '#ff6bd6');
    labA.textContent = `A · ${A ? A.name : ''}`;
    labB.textContent = `${B ? B.name : ''} · B`;
    keepBtn.disabled = !(t > 0);
    backBtn.disabled = !(t > 0);
  }
  function renderT() {
    const p = Math.round(t * 100);
    pct.textContent = `${p}%`;
    track.setAttribute('aria-valuenow', String(p));
    track.setAttribute('aria-valuetext', `${p}% B`);
    el.style.setProperty('--t', t.toFixed(4));
    keepBtn.disabled = !(t > 0);
    backBtn.disabled = !(t > 0);
    el.classList.toggle('is-morphing', t > 0);
  }

  /* ── applying the blend ── */
  let raf = 0, lastT = 0, lastWrite = 0, dirtyWrite = false;
  let duck = null; // engine duck around a structural switch: { groups: string[], stage: 'down' | 'switched' }
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(tms) {
    raf = 0;
    const dt = Math.min(0.1, Math.max(0, (tms - (lastT || tms)) / 1000));
    lastT = tms;
    if (auto) {
      phase = (phase + dt / Math.max(1, period)) % 1;
      t = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      renderT();
      dirtyWrite = true;
    }
    if (glide) {
      const k = Math.min(1, (tms - glide.t0) / glide.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      t = glide.from + (glide.to - glide.from) * e;
      renderT();
      dirtyWrite = true;
      if (k >= 1) { const done = glide.done; glide = null; if (done) done(); }
    }
    if (retarget < 1) { retarget = Math.min(1, retarget + dt / 0.45); dirtyWrite = true; if (retarget >= 1) Bprev = null; }
    if (dirtyWrite && tms - lastWrite >= 30) { lastWrite = tms; dirtyWrite = false; apply(); }
    if (auto || glide || retarget < 1 || dirtyWrite || duck) schedule();
  }
  /**
   * Engines whose model/table/mode switches rebuild inside the DSP (osc mode/table, phys model/exciter) are ducked in
   * time around the switch — level → 0, switch, level back (≈ 3 writes, ~70 ms) — instead of by morph position, so
   * a morph resting at any point (even exactly ½) never mutes an engine.
   */
  function apply() {
    if (!A || !B) return;
    if (!(t > 0)) { duck = null; releaseMorph(); return; }
    if (!claimed) { claimed = true; store.claim('morph', { exclusive: true }); }
    const Bn = currentB();
    const eff = blendValues(A.eff, Bn.eff, t, PATCH_IDS, { dip: false });
    const out = {};
    for (const id of PATCH_IDS) if (!pinned.has(id)) { out[id] = eff[id]; own.add(id); }
    const audible = g => store.get(`${g}.on`) && store.get(`${g}.level`) > 0.001;
    const next = { ...store.values, ...out };
    const switching = Object.keys(STRUCTURAL).filter(g => audible(g) && structuralChange(g, store.values, next));
    if (duck || switching.length) {
      const groups = [...new Set([...(duck ? duck.groups : []), ...switching])];
      if (!duck || (duck.stage === 'switched' && switching.length)) {
        // stage 1: fade the engine out, keep its current structure
        for (const g of groups) { out[`${g}.level`] = 0; for (const id of STRUCTURAL[g]) if (id in out) out[id] = store.get(id); }
        duck = { groups, stage: 'down' };
      } else if (duck.stage === 'down') {
        // stage 2 (≥ 30 ms later, the 6 ms level smoothing has settled): switch while silent
        for (const g of groups) out[`${g}.level`] = 0;
        duck = { groups, stage: 'switched' };
      } else duck = null; // stage 3: back to the blended level
      if (duck) dirtyWrite = true;
    }
    store.setTransientMany(out, { owner: 'morph' });
  }
  /** Back at A: drop every transient param (exact A, macro knobs included). */
  function releaseMorph() {
    if (own.size) store.revert({ ids: [...own], owner: 'morph' });
    own.clear();
    if (claimed) { claimed = false; store.release('morph'); }
  }
  function setT(v, { write = true } = {}) {
    t = Math.max(0, Math.min(1, v));
    renderT();
    if (write) { dirtyWrite = true; schedule(); }
  }
  let glide = null;
  function glideTo(to, ms = 450, done) { glide = { from: t, to, t0: performance.now(), ms, done }; schedule(); }
  function setAuto(v) {
    if (v && !B) randomB();
    auto = !!v;
    autoToggle.setValue(auto);
    el.classList.toggle('is-auto', auto);
    if (auto) { phase = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * t))) / (Math.PI * 2); glide = null; schedule(); }
  }
  function stopAuto() { if (auto) setAuto(false); }

  /** Record the current morph point as the patch (one undo step), then it becomes the new A. */
  let keeping = false;
  function keep() {
    if (!(t > 0) || !A || !B) return;
    stopAuto();
    glide = null;
    duck = null;
    const mp = morphPatch(A, currentB(), t);
    // pinned params keep the user's edits
    const vals = {};
    for (const id of PATCH_IDS) if (!pinned.has(id)) vals[id] = mp.values[id];
    store.setTransientMany(vals, { owner: 'morph' });
    const pctTxt = Math.round(t * 100);
    const near = t < 0.5 ? A : B;
    const wasClaimed = claimed;
    claimed = false;
    own.clear();
    const aName = A.name;
    t = 0;
    keeping = true;
    try {
      store.commit(`morph ${pctTxt}%`, {
        owner: 'morph',
        macros: mp.macros,
        meta: { name: `${baseName(aName)} × ${B.name}`, category: near.category || null, source: 'morph', key: null, description: `${aName} ⇄ ${B.name} · ${pctTxt}%`, tags: ['morph'] },
      });
    } finally { keeping = false; }
    if (wasClaimed) store.release('morph');
    snapA();
    renderT();
    el.classList.remove('is-kept'); void el.offsetWidth; el.classList.add('is-kept');
  }

  /* ── slider interaction ── */
  const posToT = (e) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left - 14) / Math.max(1, r.width - 28))); };
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    track.focus({ preventScroll: true });
    stopAuto();
    glide = null;
    track.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    setT(posToT(e));
    const move = ev => setT(posToT(ev));
    const up = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
      el.classList.remove('is-dragging');
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });
  track.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let v = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = t + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = t - step;
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = 1;
    else if (e.key === 'PageUp') v = t + 0.25;
    else if (e.key === 'PageDown') v = t - 0.25;
    if (v === null) return;
    e.preventDefault();
    e.stopPropagation();
    stopAuto();
    setT(v);
  });
  track.addEventListener('dblclick', () => { stopAuto(); glideTo(t > 0.25 ? 0 : 0.5); });

  /* ── picker ── */
  function renderResults() {
    const q = search.value.trim().toLowerCase();
    results.textContent = '';
    let n = 0;
    for (const p of list) {
      const cat = catOf(p.category);
      const hay = `${p.name} ${(p.tags || []).join(' ')} ${cat ? `${cat.zh} ${cat.label}` : p.category} ${p.description || ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const li = h('li.mt-morph__opt', { role: 'option', tabindex: '-1', 'aria-selected': String(!!(B && B.name === p.name)), '--mc': colorOf(p.category) },
        h('i.mt-morph__dot'), h('span.mt-morph__optname', null, p.name), h('small', null, cat ? L(cat.zh, cat.label) : p.category || ''));
      li.addEventListener('click', () => setB(p));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setB(p); cardB.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (li.nextElementSibling || li).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousElementSibling || search).focus(); }
        else if (e.key === 'Escape') { closePicker(); cardB.focus(); }
      });
      results.append(li);
      if (++n >= 120) break;
    }
    if (!n) results.append(h('li.mt-morph__empty', null, L('沒有符合的音色', 'No matching presets')));
  }
  function openPicker() {
    picker.hidden = false;
    cardB.setAttribute('aria-expanded', 'true');
    el.classList.add('is-picking');
    search.value = '';
    renderResults();
    requestAnimationFrame(() => search.focus({ preventScroll: true }));
  }
  function closePicker() {
    if (picker.hidden) return;
    picker.hidden = true;
    cardB.setAttribute('aria-expanded', 'false');
    el.classList.remove('is-picking');
  }
  cardB.addEventListener('click', () => (picker.hidden ? openPicker() : closePicker()));
  dice.addEventListener('click', randomB);
  search.addEventListener('input', renderResults);
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); const f = results.querySelector('.mt-morph__opt'); if (f) f.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); const f = results.querySelector('.mt-morph__opt'); if (f) f.click(); }
    else if (e.key === 'Escape') { closePicker(); cardB.focus(); }
  });
  results.addEventListener('keydown', e => e.stopPropagation());
  const outside = (e) => { if (!picker.hidden && !picker.contains(e.target) && !cardB.contains(e.target)) closePicker(); };
  document.addEventListener('pointerdown', outside, true);
  scope.add(() => document.removeEventListener('pointerdown', outside, true));

  keepBtn.addEventListener('click', keep);
  backBtn.addEventListener('click', () => { stopAuto(); glideTo(0, 500); });

  /* ── store coordination ── */
  scope.add(store.onAny((id, v, origin) => {
    if (origin === 'transient') return;
    if (t > 0 && own.has(id)) { pinned.add(id); own.delete(id); return; } // the user grabbed a knob mid-morph
    if (!(t > 0)) snapSoon();
  }));
  let snapT = 0;
  const snapSoon = () => { clearTimeout(snapT); snapT = setTimeout(() => { if (!(t > 0)) snapA(); }, 60); };
  scope.add(store.onPatch(() => {
    if (keeping) return; // our own Keep
    stopAuto(); glide = null; own.clear(); claimed = false; t = 0; renderT(); snapA();
  }));
  scope.add(store.onMacros(() => { if (!(t > 0)) snapSoon(); }));
  scope.add(store.onTransient((e) => {
    if (e.type === 'claim' && e.exclusive && e.owner !== 'morph' && t > 0) {
      stopAuto(); glide = null;
      if (own.size) store.revert({ ids: [...own], owner: 'morph' });
      own.clear();
      if (claimed) { claimed = false; store.release('morph'); }
      t = 0; renderT(); snapA();
    } else if (e.type === 'claim' && !e.exclusive && e.owner !== 'morph' && t > 0) {
      // a mood is about to change the committed patch: settle the morph first so the mood applies to A
      stopAuto(); glide = null;
      if (own.size) store.revert({ ids: [...own], owner: 'morph' });
      own.clear();
      if (claimed) { claimed = false; store.release('morph'); }
      t = 0; renderT();
    } else if (e.type === 'clear') {
      stopAuto(); glide = null; own.clear();
      if (claimed) { claimed = false; store.release('morph'); }
      t = 0; renderT(); snapSoon();
    } else if (e.type === 'commit' && e.owner !== 'morph' && !(t > 0)) snapSoon();
  }));

  /* ── init ── */
  snapA();
  const want = saved.b && list.find(p => p.name === saved.b);
  const firstB = want && want.name !== A.name ? want : list.find(p => p.category !== A.category && p.name !== A.name) || list.find(p => p.name !== A.name);
  if (firstB) setB(firstB, { silent: true });
  renderT();
  scope.add(onLangChange(() => { relabel(el); renderCards(); if (!picker.hidden) renderResults(); }));

  return {
    el,
    setB: p => setB(p),
    setT: v => { stopAuto(); setT(v); },
    getT: () => t,
    keep,
    stopAuto,
    /** Stop the auto-morph sweep and the ▶ audition loop (the morph point itself stays). */
    stop() { stopAuto(); listen.stop(); },
    setAuto: v => setAuto(v),
    destroy() {
      stopAuto();
      listen.stop();
      listen.destroy();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(snapT);
      releaseMorph();
      scope.dispose();
      periodSl.destroy();
      el.remove();
    },
  };
}
