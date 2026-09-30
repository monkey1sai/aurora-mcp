// AURORA 極光 — 魔法調音 Magic moods panel.
// Mood chips (更明亮 / 更溫暖 / 更寬闊 …) and a free-text box ("不要那麼亮、再寬一點") that glide the patch toward a
// mood (store.animate, ~700 ms) and record ONE undo step; an intensity slider; ↺ revert to the loaded preset;
// a tiny A/B toggle that lets you hear the original preset against the current sound.
//
//   const smart = createSmartPanel({ store, audio });  container.append(smart.el);  …  smart.destroy();
//
// Works in a wide sheet (4-column chip grid) and in a 320–400 px column (container queries in css/demo-tools.css).
// Also exports the small helpers shared by evolve.js and morph.js.

import { h, createScope, storage } from '../app/dom.js';
import { getLang, onLangChange } from '../app/i18n.js';
import { createSlider } from '../components.js';
import { PATCH_IDS } from '../app/store.js';
import {
  MOODS, MOOD_BY_ID, MOOD_EXAMPLES, applyMoods, parseMoodText, describeChanges, DEFAULT_AMOUNT,
} from '../../demo/moods.js';

/* ═══════════════════════════════ shared helpers (evolve.js, morph.js) ═══════════════════════════════ */

const CSS_HREF = new URL('../../../css/demo-tools.css', import.meta.url).href;
/** Load css/demo-tools.css once (no-op if the page already links it). */
export function ensureMagicStyles() {
  if (typeof document === 'undefined') return;
  const has = document.querySelector('link[data-magic-css]')
    || [...document.querySelectorAll('link[rel="stylesheet"]')].some(l => /\/css\/demo-tools\.css(\?|$)/.test(l.href));
  if (has) return;
  document.head.append(h('link', { rel: 'stylesheet', href: CSS_HREF, 'data-magic-css': '' }));
}

/** Bilingual label: primary text in the current UI language, the other language small underneath/after. */
export function biLabel(zh, en, cls = '') {
  const e = h(`span.mt-bi${cls ? `.${cls}` : ''}`, { 'data-zh': zh || '', 'data-en': en || '' }, h('span.mt-bi__main'), h('span.mt-bi__sub'));
  setBi(e);
  return e;
}
function setBi(e) {
  const en = getLang() === 'en';
  const zh = e.dataset.zh, eng = e.dataset.en;
  e.firstChild.textContent = en ? (eng || zh) : (zh || eng);
  e.lastChild.textContent = en ? (eng ? zh : '') : (zh ? eng : '');
}
/** Text in the current language (for titles, placeholders, aria labels). */
export const L = (zh, en) => (getLang() === 'en' ? en || zh : zh || en);
/** Re-apply the language to every biLabel and [data-zh-*] attribute under root. */
export function relabel(root) {
  for (const e of root.querySelectorAll('.mt-bi')) setBi(e);
  for (const e of root.querySelectorAll('[data-zh-title]')) e.title = L(e.dataset.zhTitle, e.dataset.enTitle);
  for (const e of root.querySelectorAll('[data-zh-ph]')) e.placeholder = L(e.dataset.zhPh, e.dataset.enPh);
  for (const e of root.querySelectorAll('[data-zh-aria]')) e.setAttribute('aria-label', L(e.dataset.zhAria, e.dataset.enAria));
  for (const e of root.querySelectorAll('[data-zh-text]')) e.textContent = L(e.dataset.zhText, e.dataset.enText);
}
/** Attributes for a bilingual title/aria label (kept up to date by relabel). */
export const biTitle = (zh, en) => ({ title: L(zh, en), 'aria-label': L(zh, en), 'data-zh-title': zh, 'data-en-title': en, 'data-zh-aria': zh, 'data-en-aria': en });
/** Plain text node in the current language (kept up to date by relabel). */
export const biText = (tag, zh, en, attrs = {}) => h(tag, { ...attrs, 'data-zh-text': zh, 'data-en-text': en }, L(zh, en));

/** 24×24 stroke icon from inner SVG markup. */
export function svgIcon(inner, size = 20, cls = 'mt-ic') {
  const w = h(`span.${cls}`, { 'aria-hidden': 'true' });
  w.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return w;
}
export const ICON = {
  magic: '<path d="M4.5 19.5l10-10"/><path d="M14.5 3.5l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z"/><path d="M19 11.5l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7z"/>',
  revert: '<path d="M4.5 12a7.5 7.5 0 107.5-7.5 7.7 7.7 0 00-5.3 2.2L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  send: '<path d="M4 12l15.5-7.5L15 20l-3.2-6.2z"/><path d="M11.8 13.8L19.5 4.5"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.6"/><circle cx="8.6" cy="8.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="8.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="8.6" cy="15.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.1" fill="currentColor" stroke="none"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.6 4.6L12 6.4l2.4-1.8M9.6 19.4L12 17.6l2.4 1.8"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  keep: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  swap: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="M20 20l-4.4-4.4"/>',
  orbit: '<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-25 12 12)"/>',
  morph: '<circle cx="7.5" cy="12" r="4.2"/><rect x="13" y="7.8" width="8.4" height="8.4" rx="1.6"/><path d="M11.7 12h1.3" stroke-dasharray="1 1.2"/>',
};

/** Small segmented pill button used across the magic panels. */
export function pill(label, attrs = {}, iconInner = null) {
  const b = h('button.mt-pill', { type: 'button', ...attrs });
  if (iconInner) b.append(svgIcon(iconInner, 16));
  if (label) b.append(label);
  return b;
}

/* ── ▶ 試聽 Audition: loop the current preset's demo phrase so tool changes can be heard ── */

let phrasesP = null;
const loadPhrases = () => (phrasesP ||= import('../../../tools/phrases.mjs').catch((e) => { console.warn('[aurora magic] phrases unavailable', e); phrasesP = null; return null; }));
/** One shared playback state per audio object, so every audition button (smart / evolve / morph) stays in sync. */
const auditions = new WeakMap();
function auditionFor(audio, store) {
  let a = auditions.get(audio);
  if (a) return a;
  const subs = new Set();
  a = {
    mine: false, startedAt: 0,
    set(on) { a.mine = on; for (const fn of subs) fn(on); },
    on: fn => { subs.add(fn); return () => subs.delete(fn); },
    async start() {
      const ph = await loadPhrases();
      if (!ph || !audio || typeof audio.seqPlay !== 'function') return;
      const meta = store.getMeta();
      const id = meta.demo && ph.PHRASES[meta.demo] ? meta.demo : (ph.DEMO_FOR_CATEGORY && ph.DEMO_FOR_CATEGORY[meta.category]) || 'keys';
      const song = ph.getPhrase(id);
      song.loop = true;
      audio.seqStop();
      audio.seqLoad(song);
      audio.seqPlay();
      a.startedAt = performance.now();
      a.key = meta.key;
      a.set(true);
    },
    stop() { if (!a.mine) return; try { audio.seqStop(); } catch { /* ignore */ } a.set(false); },
  };
  // someone else stopped the sequencer (main ▶ Demo, a song, panic …): reflect it
  if (audio && typeof audio.onState === 'function') {
    audio.onState((st) => { if (a.mine && st && st.seqPlaying === false && performance.now() - a.startedAt > 600) a.set(false); });
  }
  // a different preset was loaded while auditioning: play its own demo phrase
  store.onPatch((meta) => { if (a.mine && meta.source !== 'morph' && meta.key !== a.key) a.start(); });
  auditions.set(audio, a);
  return a;
}

/**
 * ▶ 試聽 button: loops the current preset's demo phrase (audio.seqLoad/seqPlay) — press again to stop.
 * @returns {{ el: HTMLElement, stop(): void, destroy(): void }}
 */
export function createAuditionButton({ store, audio }) {
  const ok = !!(audio && typeof audio.seqPlay === 'function');
  const btn = h('button.mt-play', { type: 'button', 'aria-pressed': 'false', ...biTitle('試聽：循環播放這個音色的示範樂句', 'Listen: loop this preset\'s demo phrase') },
    h('span.mt-play__ic', { 'aria-hidden': 'true' }), biLabel('試聽', 'Listen', 'mt-play__lbl'));
  if (!ok) { btn.disabled = true; return { el: btn, stop() {}, destroy() { btn.remove(); } }; }
  const au = auditionFor(audio, store);
  const render = (on) => { btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('is-on', on); };
  const off = au.on(render);
  render(au.mine);
  btn.addEventListener('click', () => { if (au.mine) au.stop(); else au.start(); });
  return { el: btn, stop: () => au.stop(), destroy() { off(); btn.remove(); } };
}

const clone = o => JSON.parse(JSON.stringify(o));
const sameVal = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

/* ═══════════════════════════════ panel ═══════════════════════════════ */

/**
 * @param {{ store: object, audio?: object, compact?: boolean }} opts
 * @returns {{ el: HTMLElement, destroy(): void, apply(text:string): Array, applyMood(id:string, amount?:number): void }}
 */
export function createSmartPanel({ store, audio = null, compact = false } = {}) {
  ensureMagicStyles();
  const scope = createScope();
  let amount = +storage.get('aurora.magic.amount', DEFAULT_AMOUNT) || DEFAULT_AMOUNT;
  let anim = null;       // running mood animation
  let ab = null;         // { ids } while listening to A (the original preset)
  let origin = null;     // the patch as loaded: { values, macros, key, name, clean }

  const el = h('section.mt.mt-smart', { 'aria-label': L('魔法調音', 'Magic moods') });
  if (compact) el.classList.add('mt--compact');

  /* ── header ── */
  const abBtn = h('button.mt-ab', { type: 'button', 'aria-pressed': 'false', ...biTitle('按住或點一下：聽原始音色 (A) 與目前 (B) 的差別', 'Hold or click: compare the original preset (A) with now (B)') },
    h('span.mt-ab__a', null, 'A'), h('span.mt-ab__sep', null, '/'), h('span.mt-ab__b', null, 'B'));
  const revertBtn = pill(biLabel('還原', 'Revert'), { class: 'mt-revert', ...biTitle('還原到載入時的音色（可復原）', 'Back to the preset as loaded (undoable)') }, ICON.revert);
  const listen = createAuditionButton({ store, audio });
  const head = h('header.mt-head', null,
    h('div.mt-title', null, svgIcon(ICON.magic, 18, 'mt-title__ic'), biLabel('魔法調音', 'Magic Moods', 'mt-title__txt')),
    h('div.mt-head__actions', null, listen.el, abBtn, revertBtn));

  /* ── describe box ── */
  const input = h('input.mt-ask__input', {
    type: 'text', maxlength: 120, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go',
    placeholder: L('描述你想要的聲音…', 'Describe the sound you want…'), 'data-zh-ph': '描述你想要的聲音…', 'data-en-ph': 'Describe the sound you want…',
    'data-zh-aria': '描述你想要的聲音', 'data-en-aria': 'Describe the sound you want', 'aria-label': L('描述你想要的聲音', 'Describe the sound you want'),
  });
  const goBtn = h('button.mt-ask__go', { type: 'button', ...biTitle('套用描述', 'Apply description') }, svgIcon(ICON.send, 18));
  const ask = h('form.mt-ask', { autocomplete: 'off' }, svgIcon(ICON.magic, 16, 'mt-ask__ic'), input, goBtn);
  const hint = h('div.mt-hint', { 'aria-live': 'polite' });
  const examples = h('div.mt-examples');
  for (const ex of MOOD_EXAMPLES) {
    const b = h('button.mt-example', { type: 'button', 'data-zh-text': ex.zh, 'data-en-text': ex.en }, L(ex.zh, ex.en));
    b.addEventListener('click', () => { input.value = L(ex.zh, ex.en); runText(input.value); });
    examples.append(b);
  }

  /* ── mood chips ── */
  const grid = h('div.mt-moods', { role: 'group', 'aria-label': L('情緒', 'Moods') });
  const chips = new Map();
  for (const m of MOODS) {
    const chip = h('button.mt-mood', {
      type: 'button', '--mc': m.color, 'data-mood': m.id,
      title: L(m.desc, m.descEn), 'data-zh-title': m.desc, 'data-en-title': m.descEn,
    }, svgIcon(m.svg, 22, 'mt-mood__ic'), biLabel(m.zh, m.en, 'mt-mood__lbl'), h('span.mt-mood__pulse', { 'aria-hidden': 'true' }));
    chip.addEventListener('click', (e) => runMoods([{ id: m.id, amount: e.shiftKey ? Math.min(1, amount * 1.6) : amount }], m.id));
    chips.set(m.id, chip);
    grid.append(chip);
  }

  /* ── intensity ── */
  const slider = createSlider({
    param: { id: '', type: 'float', min: 0.1, max: 1, def: DEFAULT_AMOUNT, unit: '%', zh: '強度', label: 'Intensity' },
    value: amount, accent: 'aurora', label: false,
    onChange: (v) => { amount = v; storage.set('aurora.magic.amount', v); },
  });
  const intensity = h('div.mt-intensity', null,
    biLabel('強度', 'Intensity', 'mt-intensity__lbl'),
    biText('span.mt-intensity__end', '輕', 'Light'), slider.el, biText('span.mt-intensity__end', '強', 'Strong'));

  /* ── result log ── */
  const log = h('div.mt-log', { 'aria-live': 'polite' });

  el.append(head, ask, hint, examples, grid, intensity, log);

  /* ── origin (for revert and A/B) ── */
  function snapOrigin() {
    const meta = store.getMeta();
    origin = { values: store.committedValues(), macros: clone(store.getMacros()), key: meta.key, name: meta.name, meta: clone(meta), clean: !store.isDirty() };
  }
  const differsFromOrigin = () => {
    if (!origin) return false;
    const v = store.committedValues();
    return PATCH_IDS.some(id => !sameVal(v[id], origin.values[id])) || JSON.stringify(store.getMacros()) !== JSON.stringify(origin.macros);
  };
  let revertRaf = 0;
  const updateButtons = () => {
    if (revertRaf) return;
    revertRaf = requestAnimationFrame(() => {
      revertRaf = 0;
      const d = differsFromOrigin();
      revertBtn.disabled = !d && !ab;
      abBtn.disabled = !d && !ab;
    });
  };
  snapOrigin();
  scope.add(store.onPatch((meta) => {
    // a new patch was loaded (a morph that was kept is still "based on" the loaded preset: revert/A-B keep targeting it)
    if (!origin || (meta.source !== 'morph' && (meta.key !== origin.key || meta.name !== origin.name))) { exitAB(false); snapOrigin(); clearLog(); }
    updateButtons();
  }));
  scope.add(store.onAny((id, v, origin_) => { if (origin_ !== 'transient') updateButtons(); }));
  scope.add(store.onHistory(() => updateButtons()));
  scope.add(store.onTransient((e) => {
    if (e.type === 'commit' || e.type === 'clear' || e.type === 'revert') updateButtons();
    if (ab && ((e.type === 'claim' && e.owner !== 'smart-ab') || e.type === 'clear')) exitAB(false);
  }));
  updateButtons();

  /* ── actions ── */
  function flashChip(id) {
    const c = chips.get(id);
    if (!c) return;
    c.classList.remove('is-fired');
    void c.offsetWidth;
    c.classList.add('is-fired');
  }
  function runMoods(list, label) {
    if (!list.length) return;
    exitAB(false);
    store.claim('smart', { exclusive: false });
    if (anim) anim.finish();
    const base = store.committedValues();
    const ch = applyMoods(base, list, { category: store.getMeta().category });
    for (const m of list) flashChip(m.id);
    if (!Object.keys(ch).length) {
      showLog(list, [], true);
      return;
    }
    el.classList.add('is-working');
    const a = store.animate(ch, { ms: 700, ease: 'inOut', commit: `mood:${label}`, owner: 'smart' });
    anim = a;
    a.done.then(() => { if (anim === a) { anim = null; el.classList.remove('is-working'); } updateButtons(); });
    showLog(list, describeChanges(base, ch), false);
  }
  function runText(text) {
    const list = parseMoodText(text);
    hint.textContent = '';
    hint.classList.remove('is-miss');
    if (!list.length) {
      hint.classList.add('is-miss');
      hint.textContent = L('聽不太懂… 試試「溫暖一點」「不要那麼亮」「像在教堂裡」', 'Not sure what that means… try "warmer", "not so bright", "like a cathedral"');
      input.classList.remove('is-shake'); void input.offsetWidth; input.classList.add('is-shake');
      return [];
    }
    // the slider scales how strongly a description is applied (0.6 = as written)
    const k = amount / DEFAULT_AMOUNT;
    runMoods(list.map(m => ({ id: m.id, amount: Math.max(0.05, Math.min(1, m.amount * k)) })), 'text');
    return list;
  }
  ask.addEventListener('submit', (e) => { e.preventDefault(); runText(input.value); });
  goBtn.addEventListener('click', () => runText(input.value));
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') input.blur(); });

  function clearLog() { log.textContent = ''; log.classList.remove('is-in'); }
  function showLog(list, items, none) {
    log.textContent = '';
    const moods = h('div.mt-log__moods');
    for (const m of list) {
      const md = MOOD_BY_ID[m.id];
      if (!md) continue;
      moods.append(h('span.mt-log__mood', { '--mc': md.color }, svgIcon(md.svg, 14), L(md.zh, md.en), h('b', null, `×${m.amount.toFixed(2)}`)));
    }
    log.append(moods);
    if (none) {
      log.append(h('div.mt-log__none', null, L('已經到這個方向的極限了 — 試試別的情緒', 'Already as far as it goes — try another mood')));
    } else {
      const ul = h('ul.mt-log__list');
      for (const it of items.slice(0, compact ? 4 : 7)) {
        const arrow = it.kind === 'on' ? '＋' : it.kind === 'off' ? '－' : it.dir > 0 ? '↑' : it.dir < 0 ? '↓' : '⇄';
        ul.append(h(`li.mt-log__item.is-${it.kind === 'on' || it.dir > 0 ? 'up' : it.kind === 'off' || it.dir < 0 ? 'down' : 'swap'}`, null,
          h('i', null, arrow), getLang() === 'en' ? it.en : it.zh));
      }
      if (items.length > (compact ? 4 : 7)) ul.append(h('li.mt-log__more', null, `+${items.length - (compact ? 4 : 7)}`));
      log.append(ul);
    }
    log.classList.remove('is-in');
    void log.offsetWidth;
    log.classList.add('is-in');
  }

  function revert() {
    if (!origin) return;
    exitAB(false);
    store.claim('smart', { exclusive: false });
    if (anim) anim.finish();
    const target = origin;
    const macrosChanged = JSON.stringify(store.getMacros()) !== JSON.stringify(target.macros);
    const cm = store.getMeta();
    const metaChanged = cm.name !== target.meta.name || cm.key !== target.meta.key || cm.category !== target.meta.category; // e.g. after a kept morph
    const cur = store.committedValues();
    const targets = {};
    for (const id of PATCH_IDS) if (!sameVal(cur[id], target.values[id])) targets[id] = target.values[id];
    if (!Object.keys(targets).length && !macrosChanged && !metaChanged) return;
    const whole = macrosChanged || metaChanged; // one whole-patch undo step (values + macros + name)
    el.classList.add('is-working');
    const a = store.animate(targets, {
      ms: 650, ease: 'inOut', owner: 'smart', commit: whole ? false : 'revert',
      onDone: (ok) => {
        if (!ok) return;
        if (whole) store.commit('revert', { macros: target.macros, meta: clone(target.meta) });
        if (target.clean && !differsFromOrigin()) store.markClean();
      },
    });
    anim = a;
    a.done.then(() => { if (anim === a) { anim = null; el.classList.remove('is-working'); } updateButtons(); });
    log.textContent = '';
    log.append(h('div.mt-log__none', null, `↺ ${L('已還原為', 'Reverted to')} ${target.name}`));
    log.classList.remove('is-in'); void log.offsetWidth; log.classList.add('is-in');
  }
  revertBtn.addEventListener('click', revert);

  /* ── A/B: listen to the original preset (transient, never recorded) ── */
  function enterAB() {
    if (ab || !origin || !differsFromOrigin()) return;
    if (anim) anim.finish();
    store.claim('smart-ab', { exclusive: true });
    const cur = store.values;
    const targets = {};
    for (const id of PATCH_IDS) if (!sameVal(cur[id], origin.values[id])) targets[id] = origin.values[id];
    const h2 = store.animate(targets, { ms: 90, ease: 'out', owner: 'smart-ab' });
    ab = { ids: [...h2.ids] };
    abBtn.setAttribute('aria-pressed', 'true');
    el.classList.add('is-ab');
  }
  function exitAB(animated) {
    if (!ab) return;
    const ids = ab.ids;
    ab = null;
    abBtn.setAttribute('aria-pressed', 'false');
    el.classList.remove('is-ab');
    store.revert({ ids, ms: animated ? 90 : 0, owner: 'smart-ab' });
    store.release('smart-ab');
    updateButtons();
  }
  // click toggles; press-and-hold compares while held
  let holdT = 0, held = false;
  abBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || abBtn.disabled) return;
    held = false;
    try { abBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const wasOn = !!ab;
    if (!wasOn) enterAB();
    holdT = setTimeout(() => { held = true; }, 350);
    const up = () => {
      clearTimeout(holdT);
      abBtn.removeEventListener('pointerup', up);
      abBtn.removeEventListener('pointercancel', up);
      if (wasOn || held) exitAB(true);
    };
    abBtn.addEventListener('pointerup', up);
    abBtn.addEventListener('pointercancel', up);
  });
  abBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (ab) exitAB(true); else enterAB(); }
  });

  /* ── language ── */
  scope.add(onLangChange(() => relabel(el)));

  return {
    el,
    /** Stop what this panel started (the ▶ audition loop); Demo Center calls it when another player takes over. */
    stop() { exitAB(false); listen.stop(); },
    /** Apply a free-text description programmatically (demo scripts). Returns the parsed moods. */
    apply: text => runText(text),
    /** Apply one mood by id. */
    applyMood(id, amt = amount) { if (MOOD_BY_ID[id]) runMoods([{ id, amount: amt }], id); },
    destroy() {
      exitAB(false);
      listen.stop();
      listen.destroy();
      if (anim) anim.finish();
      if (revertRaf) cancelAnimationFrame(revertRaf);
      scope.dispose();
      slider.destroy();
      el.remove();
    },
  };
}
