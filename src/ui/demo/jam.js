// 自動演奏 Jam — generative auto-play panel (Demo Center tab, also usable standalone: docs/jam-demo.html).
//
//   const jam = createJamPanel({ store, audio, presets, categories });   // audio: object or () => object
//   host.append(jam.el); … jam.stop(); jam.destroy();
//
// The current preset (store.toPatch()) is the "Lead" part and plays the role its category suits (pad → chords,
// bass → bassline, lead/strings → melody, keys → comping + melody, pluck/arp/bell → arpeggio or melody, drum →
// groove, fx → texture); a backing band of factory presets (picked by style, changeable) and a built-in drum kit
// join it. Songs come from src/demo/generator.js and play on the multi-part ensemble (audio.songLoad/songPlay/
// songQueue/songPart). Endless mode queues the next variation before the current segment ends; edits to the
// preset or the settings apply from the next segment (seamless switch at the loop end).

import {
  generateJam, STYLES, STYLE_IDS, JAM_SCALES, JAM_SCALE_IDS, KEY_NAMES, suggestBacking, roleForPreset, leadPlays, styleDefaults,
} from '../../demo/generator.js';
import { getLang, onLangChange, nameText } from '../app/i18n.js';

/* ───────────────────────── tiny DOM helpers ───────────────────────── */
function h(tag, attrs, ...kids) {
  const [name, ...cls] = String(tag).split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('--')) e.style.setProperty(k, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const svg = (inner, size = 20) => {
  const s = document.createElement('span');
  s.className = 'jam-ic';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return s;
};

/* ── language: English first in English mode (the Chinese stays as the small secondary line), live-switchable ── */
const isEn = () => getLang() === 'en';
const cap1 = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** One string in the UI language: English alone in English mode, the "中文 English" pair (joined by sep) in Chinese mode. */
const LB = (zh, en, sep = ' ') => (isEn() ? cap1(en || zh) : `${zh}${sep}${en}`);
/** Fill a [data-zh][data-en] pair element: first child = primary line, second = the other language (small). */
function setBi(e) {
  const en = isEn(), zh = e.dataset.zh || '', eng = e.dataset.en || '';
  const [main, sub] = e.children;
  main.textContent = en ? eng || zh : zh || eng;
  sub.textContent = en ? (eng ? zh : '') : (zh ? eng : '');
  sub.lang = en ? 'zh-Hant' : 'en';
}
/** Bilingual label (primary in the UI language, the other language small); relabelled on a language switch. */
const bi = (zh, en, cls = '') => {
  const e = h(`span.jam-bi${cls ? `.${cls}` : ''}`, { 'data-zh': zh, 'data-en': en }, h('span.jam-bi__main'), h('span.jam-bi__sub'));
  setBi(e);
  return e;
};

const ICONS = {
  ambient: '<path d="M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5a7.5 7.5 0 1 0 9.7 9.7z"/><path d="M17 3.5v3M15.5 5h3"/>',
  lofi: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.5" cy="12" r="2"/><path d="M10.5 12h3M7 18l1.5-2.5h7L17 18"/>',
  synthwave: '<path d="M5 13a7 7 0 0 1 14 0"/><path d="M2.5 13h19M5 16h14M7.5 19h9"/>',
  house: '<rect x="5" y="3" width="14" height="18" rx="3"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7.5" r="1.3"/>',
  cinematic: '<path d="M2.5 19.5l6.5-10 4 5.5 2.5-3.5 6 8z"/><path d="M15 5.5l1 1.8 2 .3-1.5 1.4.4 2-1.9-1-1.9 1 .4-2L12 7.6l2-.3z"/>',
  pentatonic: '<path d="M12 2.5v2"/><path d="M7 7.5c0-1.7 2.2-3 5-3s5 1.3 5 3v7c0 1.7-2.2 3-5 3s-5-1.3-5-3z"/><path d="M7 11h10M12 17.5V21M9.5 21.5h5"/>',
  chiptune: '<rect x="2.5" y="7.5" width="19" height="10" rx="3.5"/><path d="M7 10.5v4M5 12.5h4"/><path d="M15 11.5h.01M18 13.5h.01" stroke-width="2.6"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" stroke-width="2.8"/>',
  infinity: '<path d="M12 12c-2-2.5-3.5-4-5.5-4a4 4 0 0 0 0 8c2 0 3.5-1.5 5.5-4zm0 0c2 2.5 3.5 4 5.5 4a4 4 0 0 0 0-8c-2 0-3.5 1.5-5.5 4z"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v8M12 5v8M16 5v8M6.5 13h3M10.5 13h3M14.5 13h3"/>',
  drums: '<ellipse cx="12" cy="9" rx="8" ry="3.5"/><path d="M4 9v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5V9"/><path d="M8 3l3 5M16 3l-3 5"/>',
  bass: '<path d="M6 19c-1.5-1.5-1-4 1-5l7-7 3 3-7 7c-1 2-3.5 2.5-4 2z"/><path d="M15 6l3-3M17 8l3-3"/>',
  pad: '<path d="M3 15c3-6 6 2 9-4s6 2 9-4"/><path d="M3 19c3-6 6 2 9-4s6 2 9-4" opacity=".5"/>',
  extra: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  wave: '<path d="M3 12c2.5-6 5-6 7.5 0s5 6 7.5 0 2.5-3 3-3"/>',
};

/* ───────────────────────── settings ───────────────────────── */
const STORE_KEY = 'aurora.jam';
const loadSettings = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {}; } catch { return {}; } };
const saveSettings = s => { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ } };

const ROLE_CHOICES = [
  ['auto', '自動', 'Auto'], ['lead', '旋律', 'Melody'], ['pad', '和弦', 'Chords'], ['keys', '伴奏＋旋律', 'Comping'],
  ['arp', '琶音', 'Arpeggio'], ['bass', '貝斯', 'Bass'], ['drum', '節奏', 'Drums'], ['fx', '音景', 'Texture'],
];
const PART_EN = { Lead: 'Your preset' }; // English display names of generator parts whose id is not one
const PLAYS_LABEL = {
  melody: ['旋律', 'melody'], comp: ['伴奏和弦＋旋律', 'comping + melody'], chords: ['和弦', 'chords'], held: ['琶音器和弦', 'arp chords'],
  bass: ['貝斯線', 'bassline'], arp: ['琶音', 'arpeggio'], drums: ['節奏', 'groove'], texture: ['音景', 'texture'],
};
const SLOT_CATS = { pad: ['pad', 'keys', 'strings', 'arp', 'pluck', 'bell'], bass: ['bass'], extra: ['lead', 'pluck', 'bell', 'arp', 'strings', 'keys'], drums: ['drum'] };

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  if (document.querySelector('link[data-jam-css], link[href$="css/jam.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../../../css/jam.css', import.meta.url).href;
  l.dataset.jamCss = '';
  document.head.append(l);
}

/**
 * @param {{ store: object, audio: object|(() => object), presets?: object[], categories?: object[] }} opts
 * @returns {{ el: HTMLElement, destroy(): void, stop(): void, play(): void, readonly playing: boolean }}
 */
export function createJamPanel({ store, audio, presets = [], categories = [] } = {}) {
  injectCss();
  const A = () => (typeof audio === 'function' ? audio() : audio) || null;
  const saved = loadSettings();
  const st = {
    style: STYLES[saved.style] ? saved.style : 'lofi',
    key: Number.isFinite(saved.key) ? saved.key : null,
    scale: JAM_SCALES[saved.scale] ? saved.scale : null,
    bpm: Number(saved.bpm) || null,
    bars: saved.bars === 16 ? 16 : 8,
    intensity: Number.isFinite(saved.intensity) ? saved.intensity : 0.7,
    endless: saved.endless !== false,
    seed: (Number(saved.seed) >>> 0) || ((Date.now() % 100000) + 1),
    role: saved.role || 'auto',
    on: { drums: true, bass: true, pad: true, extra: true, ...(saved.on || {}) },
    pick: { ...(saved.pick || {}) }, // slot → preset name ('' = suggested; 'kit' for drums)
  };
  {
    const d = styleDefaults(st.style);
    if (st.key === null) st.key = d.key;
    if (!st.scale) st.scale = d.scale;
    if (!st.bpm) st.bpm = d.bpm;
  }
  const persist = () => saveSettings({ style: st.style, key: st.key, scale: st.scale, bpm: st.bpm, bars: st.bars, intensity: st.intensity, endless: st.endless, seed: st.seed, role: st.role, on: st.on, pick: st.pick });

  // playback state
  let playing = false;
  let seenOwn = false;      // the engine has reported our song since play()
  let song = null;          // segment currently playing (or last generated)
  let queued = null;        // segment queued for the loop end
  let variation = 0;
  let counter = 0;
  let dirty = false;        // settings/patch changed since the current segment was generated
  let lastState = null, lastStateAt = 0;
  let fallback = false;     // no ensemble: plays the lead part only on the user's synth
  const mutedNames = new Set();
  const cleanups = [];

  /* ───────── helpers ───────── */
  const byName = n => presets.find(p => p && p.name === n) || null;
  const leadInfo = () => {
    const meta = (store && store.getMeta && store.getMeta()) || {};
    const patch = store && store.toPatch ? store.toPatch() : { params: {}, macros: [] };
    const role = st.role !== 'auto' ? st.role : roleForPreset({ category: meta.category, demo: meta.demo });
    return { patch, role, name: meta.name || 'Lead', tags: meta.tags || [], category: meta.category || null };
  };
  const suggestion = () => { const l = leadInfo(); return suggestBacking(st.style, presets, { lead: { name: l.name, role: l.role, patch: l.patch } }); };
  const slotPreset = (slot) => {
    const sug = suggestion();
    if (slot === 'drums') return st.pick.drums && st.pick.drums !== 'kit' ? byName(st.pick.drums) : null;
    const name = st.pick[slot];
    if (name) { const p = byName(name); if (p) return p; }
    return slot === 'pad' ? sug.pad : slot === 'bass' ? sug.bass : sug.extra;
  };
  const asPatch = p => (p ? { name: p.name, category: p.category, tags: p.tags, params: p.params, macros: p.macros } : null);

  function makeSong(v = variation) {
    const lead = leadInfo();
    const extraP = st.on.extra ? slotPreset('extra') : null;
    const drumP = slotPreset('drums');
    const s = generateJam({
      style: st.style, key: st.key, scale: st.scale, bpm: st.bpm, bars: st.bars, seed: st.seed, intensity: st.intensity,
      variation: v, endless: st.endless, loop: true,
      lead: { patch: lead.patch, role: lead.role, name: lead.name, tags: lead.tags },
      backing: {
        drums: st.on.drums ? (drumP ? asPatch(drumP) : true) : null,
        bass: st.on.bass ? asPatch(slotPreset('bass')) : null,
        pad: st.on.pad ? asPatch(slotPreset('pad')) : null,
        extra: extraP ? { patch: asPatch(extraP), role: roleForPreset(extraP) } : null,
      },
    });
    const sty = STYLES[st.style];
    s.id = `jam-${++counter}`;
    s.title = `Jam · ${sty.en}`;
    s.zh = `自動演奏 · ${sty.zh}`;
    return s;
  }

  /* ───────── DOM ───────── */
  const el = h('div.jam', { '--jam-acc': STYLES[st.style].color });
  // static bilingual attributes (title / aria-label), re-applied on a language switch
  const attrs = [];
  const tr = (node, attr, zh, en, sep = ' ') => { attrs.push([node, attr, zh, en, sep]); node.setAttribute(attr, LB(zh, en, sep)); return node; };

  // style chips
  const chips = tr(h('div.jam-styles', { role: 'radiogroup' }), 'aria-label', '風格', 'Style');
  const chipEls = {};
  for (const id of STYLE_IDS) {
    const s = STYLES[id];
    const txt = h('span.jam-style__txt', { 'data-zh': s.zh, 'data-en': s.en }, h('span.jam-style__main'), h('span.jam-style__sub'));
    setBi(txt);
    const b = tr(h('button.jam-style', { type: 'button', role: 'radio', 'aria-checked': 'false', '--c': s.color },
      h('span.jam-style__ic', null, svg(ICONS[id], 22)), txt), 'title', s.desc.zh, s.desc.en, ' — ');
    b.addEventListener('click', () => setStyle(id));
    chipEls[id] = b;
    chips.append(b);
  }

  // stage: roll + transport
  const canvas = h('canvas.jam-roll__cv', { 'aria-hidden': 'true' });
  const rollInfo = h('div.jam-roll__info');
  const rollEmpty = h('div.jam-roll__empty', null, svg(ICONS.wave, 26), bi('按下 ▶ 開始即興', 'Press ▶ to start jamming'));
  // the canvas is absolutely positioned in a fixed-height box so its bitmap size never feeds back into layout
  const cvBox = h('div.jam-roll__box', null, canvas, rollEmpty);
  const roll = tr(h('div.jam-roll', { role: 'img' }, rollInfo, cvBox), 'aria-label', '即時鋼琴捲簾', 'Live piano roll');
  const partsBar = tr(h('div.jam-parts'), 'aria-label', '聲部', 'Parts');

  const playBtn = h('button.jam-play', { type: 'button', 'aria-label': 'Jam' }, h('span.jam-play__ring', { 'aria-hidden': 'true' }), h('span.jam-play__ic'), h('span.jam-play__txt'));
  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  const diceBtn = tr(h('button.jam-btn.jam-dice', { type: 'button' }, svg(ICONS.dice, 18), bi('新點子', 'New idea')), 'title', '新點子', 'New idea (new seed)');
  diceBtn.addEventListener('click', () => newIdea());
  const endlessBtn = tr(h('button.jam-btn.jam-toggle', { type: 'button', 'aria-pressed': 'false' }, svg(ICONS.infinity, 18), bi('無限', 'Endless')),
    'title', '無限演奏：不斷生成下一段變奏', 'Endless: keeps generating the next variation');
  endlessBtn.addEventListener('click', () => { st.endless = !st.endless; persist(); syncControls(); changed(); });
  const segBadge = h('div.jam-seg', { 'aria-live': 'polite' });
  const nowChord = h('span.jam-now__chord');
  const nextChord = h('span.jam-now__next');
  const nowWrap = h('div.jam-now', { 'aria-live': 'off' }, h('span.jam-now__lbl', null, bi('現在和弦', 'Now')), nowChord, nextChord);
  const transport = h('div.jam-transport', null, nowWrap, playBtn, h('div.jam-transport__row', null, diceBtn, endlessBtn), segBadge);
  const stage = h('div.jam-stage', null, h('div.jam-stage__roll', null, roll, partsBar), transport);

  // controls: key / scale / tempo / intensity / length / role
  const keySel = tr(h('select.jam-select', null, KEY_NAMES.map((n, i) => h('option', { value: String(i), text: n }))), 'aria-label', '調性', 'Key');
  keySel.addEventListener('change', () => { st.key = Number(keySel.value); persist(); changed(); syncControls(); });
  // native <option>s hold one line: English alone in English mode, "中文 English" in Chinese mode
  const scaleText = id => LB(JAM_SCALES[id].zh, JAM_SCALES[id].en);
  const roleText = id => { const r = ROLE_CHOICES.find(x => x[0] === id); return r ? LB(r[1], r[2]) : id; };
  const scaleSel = tr(h('select.jam-select', null, JAM_SCALE_IDS.map(id => h('option', { value: id, text: scaleText(id) }))), 'aria-label', '音階', 'Scale');
  scaleSel.addEventListener('change', () => { st.scale = scaleSel.value; persist(); changed(); syncControls(); });
  const bpmIn = tr(h('input.jam-range', { type: 'range', min: '50', max: '180', step: '1' }), 'aria-label', '速度', 'Tempo');
  const bpmVal = h('span.jam-val');
  bpmIn.addEventListener('input', () => { st.bpm = Number(bpmIn.value); bpmVal.textContent = `${st.bpm}`; });
  bpmIn.addEventListener('change', () => { persist(); changed(); });
  const intIn = tr(h('input.jam-range', { type: 'range', min: '0', max: '100', step: '1' }), 'aria-label', '強度', 'Intensity');
  const intVal = h('span.jam-val');
  intIn.addEventListener('input', () => { st.intensity = Number(intIn.value) / 100; intVal.textContent = `${Math.round(st.intensity * 100)}%`; });
  intIn.addEventListener('change', () => { persist(); changed(); });
  const lenSeg = tr(h('div.jam-seg2', { role: 'radiogroup' }), 'aria-label', '長度', 'Length');
  const lenBtns = [8, 16].map(n => {
    const b = h('button.jam-seg2__opt', { type: 'button', role: 'radio', text: `${n}` });
    b.addEventListener('click', () => { st.bars = n; persist(); syncControls(); changed(); });
    lenSeg.append(b);
    return [n, b];
  });
  const roleSel = tr(h('select.jam-select', null, ROLE_CHOICES.map(([id]) => h('option', { value: id, text: roleText(id) }))), 'aria-label', '你的音色擔任', 'Your preset plays');
  roleSel.addEventListener('change', () => { st.role = roleSel.value; persist(); changed(); syncControls(); });
  const field = (zh, en, ...ctl) => h('label.jam-field', null, h('span.jam-field__lbl', null, bi(zh, en)), h('span.jam-field__ctl', null, ...ctl));
  const controls = h('div.jam-controls', null,
    field('調性', 'Key', keySel, scaleSel),
    field('速度', 'Tempo', bpmIn, bpmVal),
    field('強度', 'Intensity', intIn, intVal),
    h('div.jam-field', null, h('span.jam-field__lbl', null, bi('長度（小節）', 'Bars')), h('span.jam-field__ctl', null, lenSeg)),
    field('你的音色擔任', 'Your preset plays', roleSel),
  );

  // backing band
  const bandRows = {};
  const band = h('div.jam-band', null, h('div.jam-sec__head', null, svg(ICONS.drums, 16), bi('伴奏樂團', 'Backing band')));
  const bandGrid = h('div.jam-band__grid');
  band.append(bandGrid);
  const catName = id => { const c = categories.find(x => x.id === id); return c ? LB(c.zh, c.label) : id; };
  for (const [slot, zh, en, ic] of [['drums', '鼓組', 'Drums', 'drums'], ['bass', '貝斯', 'Bass', 'bass'], ['pad', '和弦', 'Chords', 'pad'], ['extra', '點綴／旋律', 'Extra', 'extra']]) {
    const tog = tr(h('button.jam-sw', { type: 'button', role: 'switch', 'aria-checked': 'false' }, h('span.jam-sw__knob')), 'aria-label', zh, en);
    const sel = tr(h('select.jam-select.jam-select--sm'), 'aria-label', zh, `${en} preset`);
    const note = h('span.jam-band__note');
    const row = h('div.jam-band__row', { 'data-slot': slot }, h('span.jam-band__ic', null, svg(ICONS[ic], 17)), h('span.jam-band__name', null, bi(zh, en)), tog, sel, note);
    tog.addEventListener('click', () => { st.on[slot] = !st.on[slot]; persist(); syncControls(); changed(); });
    sel.addEventListener('change', () => { st.pick[slot] = sel.value; persist(); changed(); syncControls(); });
    bandRows[slot] = { row, tog, sel, note };
    bandGrid.append(row);
  }
  function fillSelect(slot) {
    const { sel } = bandRows[slot];
    const cur = st.pick[slot] || '';
    sel.textContent = '';
    if (slot === 'drums') sel.append(h('option', { value: 'kit', text: LB('內建鼓組', 'Built-in kit') }));
    else {
      const sug = slotPreset(slot);
      sel.append(h('option', { value: '', text: sug ? (isEn() ? `✦ Suggested: ${sug.name}` : `✦ 推薦 ${sug.name}`) : `✦ ${LB('推薦', 'Suggested')}` }));
    }
    for (const cat of SLOT_CATS[slot]) {
      const list = presets.filter(p => p && p.category === cat);
      if (!list.length) continue;
      const g = document.createElement('optgroup');
      g.label = catName(cat);
      for (const p of list) g.append(h('option', { value: p.name, text: p.name }));
      sel.append(g);
    }
    sel.value = cur && [...sel.options].some(o => o.value === cur) ? cur : slot === 'drums' ? 'kit' : '';
  }

  // play along + auto tone
  const lockBtn = h('button.jam-btn.jam-lock', { type: 'button', 'aria-pressed': 'false' }, svg(ICONS.lock, 16), h('span.jam-lock__txt'));
  lockBtn.addEventListener('click', () => toggleLock());
  const alongTxt = h('p.jam-along__txt');
  const along = h('div.jam-along', null, h('span.jam-along__ic', null, svg(ICONS.keys, 20)), h('div.jam-along__body', null, h('div.jam-along__title', null, bi('一起彈', 'Play along')), alongTxt), lockBtn);
  const ridesEl = h('div.jam-rides');
  const tone = h('div.jam-tone', null, h('div.jam-sec__head', null, svg(ICONS.wave, 16), bi('自動調音', 'Auto-tone')), ridesEl);
  const bottom = h('div.jam-bottom', null, along, tone);

  el.append(chips, stage, controls, band, bottom);

  /* ───────── sync UI ───────── */
  function syncControls() {
    const sty = STYLES[st.style];
    el.style.setProperty('--jam-acc', sty.color);
    for (const id of STYLE_IDS) { const on = id === st.style; chipEls[id].classList.toggle('is-on', on); chipEls[id].setAttribute('aria-checked', String(on)); }
    keySel.value = String(st.key);
    scaleSel.value = st.scale;
    bpmIn.value = String(st.bpm); bpmVal.textContent = `${st.bpm}`;
    const [bmin, bmax] = sty.bpmRange;
    bpmIn.min = String(Math.min(bmin, st.bpm)); bpmIn.max = String(Math.max(bmax, st.bpm));
    intIn.value = String(Math.round(st.intensity * 100)); intVal.textContent = `${Math.round(st.intensity * 100)}%`;
    for (const [n, b] of lenBtns) { b.classList.toggle('is-on', n === st.bars); b.setAttribute('aria-checked', String(n === st.bars)); }
    roleSel.value = st.role;
    endlessBtn.classList.toggle('is-on', st.endless); endlessBtn.setAttribute('aria-pressed', String(st.endless));
    playBtn.classList.toggle('is-playing', playing);
    playBtn.querySelector('.jam-play__ic').replaceChildren(svg(playing ? ICONS.stop : ICONS.play, 26));
    playBtn.querySelector('.jam-play__txt').replaceChildren(playing ? bi('停止', 'Stop') : bi('開始即興', 'Jam'));
    playBtn.setAttribute('aria-label', playing ? LB('停止', 'Stop') : LB('開始即興', 'Jam'));
    const lead = leadInfo();
    const plays = leadPlays(lead.role, lead.patch, st.style);
    const [pz, pe] = PLAYS_LABEL[plays] || PLAYS_LABEL.melody;
    for (const slot in bandRows) {
      const r = bandRows[slot];
      fillSelect(slot);
      const byLead = (slot === 'pad' && (plays === 'chords' || plays === 'comp' || plays === 'held')) || (slot === 'bass' && plays === 'bass');
      r.tog.setAttribute('aria-checked', String(!!st.on[slot]));
      r.tog.classList.toggle('is-on', !!st.on[slot]);
      r.row.classList.toggle('is-off', !st.on[slot] || byLead);
      r.sel.disabled = !st.on[slot] || byLead;
      r.note.textContent = byLead ? LB('由你的音色演奏', 'played by your preset') : slot === 'extra' && st.on.extra ? (plays === 'melody' || plays === 'comp' ? LB('對位琶音', 'counter line') : LB('旋律', 'melody')) : '';
    }
    const kn = KEY_NAMES[st.key], sc = JAM_SCALES[st.scale];
    alongTxt.textContent = '';
    if (isEn()) {
      alongTxt.append(h('b', { text: `“${lead.name}”` }), ` plays the ${pe}. Jam along on your computer keyboard or MIDI in `, h('b.jam-key', { text: `${kn} ${sc.en}` }), '.');
    } else {
      alongTxt.append(
        h('b', { text: `「${lead.name}」` }), `擔任${pz}（${pe}）。用電腦鍵盤或 MIDI 一起彈 `, h('b.jam-key', { text: `${kn} ${sc.zh}` }),
        h('span.jam-along__en', { text: ` · your preset plays the ${pe}; jam along in ${kn} ${sc.en}.` }),
      );
    }
    const locked = isLocked();
    lockBtn.classList.toggle('is-on', locked);
    lockBtn.setAttribute('aria-pressed', String(locked));
    lockBtn.querySelector('.jam-lock__txt').replaceChildren(locked ? bi('已鎖定音階', 'Scale locked') : bi('鎖定到 ' + kn, isEn() ? `Lock to ${kn}` : 'Lock to key'));
    renderRides();
    renderParts();
  }

  function isLocked() {
    if (!store || !store.get) return false;
    return store.get('scale.type') === st.scale && Number(store.get('scale.root')) === st.key;
  }
  function toggleLock() {
    if (!store || !store.set) return;
    if (isLocked()) store.set('scale.type', 'off');
    else { store.set('scale.root', st.key); store.set('scale.type', st.scale); }
    syncControls();
  }

  function renderRides() {
    ridesEl.textContent = '';
    const rides = song ? song.meta.rides : (() => { const l = leadInfo(); return (l.patch.macros || []).length ? null : []; })();
    if (!rides || !rides.length) {
      ridesEl.append(h('p.jam-rides__empty', { text: song ? LB('這個音色沒有可以自動推動的巨集', 'no macros to ride', ' · ') : LB('開始後，AURORA 會隨段落自動推動你音色的巨集', 'macros ride with the music once playing', ' · ') }));
      return;
    }
    for (const r of rides) {
      const kind = { bright: ['亮度', 'brightness'], space: ['空間', 'space'], motion: ['流動', 'motion'], drive: ['推力', 'drive'] }[r.kind] || ['', r.kind];
      const bar = h('span.jam-ride__bar', null, h('span.jam-ride__fill'));
      // macro names are "中文 English" pairs ("亮度 Bright"): the English part alone in English mode
      ridesEl.append(h('div.jam-ride', { 'data-index': String(r.index), 'data-kind': r.kind }, h('span.jam-ride__name', { text: isEn() ? nameText(r.name) : r.name }), bar, h('span.jam-ride__kind', { text: kind[0] ? LB(kind[0], kind[1]) : kind[1] })));
    }
  }

  function renderParts() {
    partsBar.textContent = '';
    if (!song) return;
    const ss = lastState && lastState.song && lastState.song.id === song.id ? lastState.song : null;
    song.parts.forEach((p, i) => {
      const muted = mutedNames.has(p.name) || (ss && ss.parts[i] ? ss.parts[i].mute : false);
      const en = isEn();
      const b = h('button.jam-part', { type: 'button', '--c': p.color, 'aria-pressed': String(!muted), title: `${p.presetName || p.kit || ''} — ${LB('點一下靜音', 'click to mute')}` },
        h('span.jam-part__dot'), h('span.jam-part__name', { text: en ? PART_EN[p.name] || p.name : p.zh }), h('span.jam-part__preset', { text: p.presetName || (en ? p.zh || p.name : p.name) }));
      b.classList.toggle('is-muted', !!muted);
      b.addEventListener('click', () => {
        const a = A();
        const m = !b.classList.contains('is-muted');
        b.classList.toggle('is-muted', m);
        b.setAttribute('aria-pressed', String(!m));
        if (m) mutedNames.add(p.name); else mutedNames.delete(p.name); // the ensemble carries mutes over by part name
        if (a && typeof a.songPart === 'function') a.songPart(p.name, { mute: m });
      });
      partsBar.append(b);
    });
  }

  /* ───────── transport ───────── */
  function hasEnsemble(a) { return a && typeof a.songLoad === 'function' && typeof a.songPlay === 'function'; }

  function play() {
    ensureSub();
    const a = A();
    if (!a) return;
    variation = 0;
    queued = null;
    dirty = false;
    mutedNames.clear(); // a fresh load resets the ensemble mixer
    song = makeSong(0);
    fallback = !hasEnsemble(a);
    try {
      if (fallback) { // older engine: the lead part alone on the user's synth
        const lead = song.parts[0];
        a.seqLoad({ bpm: song.bpm, loop: true, lengthBeats: song.lengthBeats, events: lead.events });
        a.seqPlay();
      } else {
        a.songLoad(song);
        a.songPlay();
      }
    } catch (e) {
      console.error('[aurora jam]', e);
      showError(e);
      return;
    }
    playing = true;
    seenOwn = false;
    playStart = performance.now();
    rollEmpty.hidden = true;
    rollDirty = true;
    syncControls();
    startLoop();
  }

  function stop() {
    const a = A();
    const was = playing;
    playing = false;
    queued = null;
    if (a && was) {
      try { if (fallback) a.seqStop(); else if (typeof a.songStop === 'function') a.songStop(); } catch (e) { console.error(e); }
    }
    syncControls();
    rollDirty = true;
    drawFrame();
    updateInfo();
  }

  function newIdea() {
    st.seed = ((st.seed * 1103515245 + 12345) >>> 0) % 2147483647 || 1;
    persist();
    el.classList.remove('is-rolling'); void el.offsetWidth; el.classList.add('is-rolling');
    if (playing) play(); else { preview(); syncControls(); }
  }

  function setStyle(id) {
    if (!STYLES[id]) return;
    const d = styleDefaults(id);
    st.style = id; st.key = d.key; st.scale = d.scale; st.bpm = d.bpm;
    st.pick = {};
    persist();
    syncControls();
    if (playing) play(); else preview();
  }
  function preview() {
    song = makeSong(0); variation = 0; rollEmpty.hidden = true; rollDirty = true;
    renderParts(); renderRides(); drawFrame(); updateInfo();
  }

  let changeTimer = 0;
  /** Settings or the preset changed: regenerate and switch seamlessly at the loop end. */
  function changed() {
    dirty = true;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (!playing) { preview(); return; }
      const a = A();
      if (!a) return;
      if (fallback) { play(); return; }
      // endless: the next variation is generated fresh anyway; loop mode: regenerate this segment
      const next = makeSong(st.endless ? variation + 1 : variation);
      try { a.songQueue(next); queued = next; } catch (e) { console.error(e); }
      updateInfo();
    }, 350);
  }

  function showError(e) {
    rollInfo.textContent = '';
    rollInfo.append(h('span.jam-err', { text: `${LB('無法播放', 'Can\'t play')}: ${String(e && e.message ? e.message : e).slice(0, 140)}` }));
  }

  /* ───────── engine state ───────── */
  function onState(s) {
    if (!s) return;
    lastState = s;
    lastStateAt = performance.now();
    const ss = s.song;
    if (!playing || fallback || !ss) return;
    if (song && (ss.id === song.id || (queued && ss.id === queued.id))) seenOwn = true;
    // somebody else took over the ensemble (a demo song) → we are no longer playing. Only once our own song has
    // been reported: the first states after play() can still describe the previously loaded song.
    if (seenOwn && ss.id && !String(ss.id).startsWith('jam-')) { playing = false; queued = null; syncControls(); return; }
    if (queued && ss.id === queued.id) { // the queued segment took over
      song = queued;
      queued = null;
      variation = song.meta.variation;
      dirty = false;
      rollDirty = true;
      renderParts();
      renderRides();
    }
    if (song && ss.id === song.id && ss.playing && st.endless && !queued && ss.beat > song.lengthBeats * 0.5) {
      const a = A();
      const next = makeSong(variation + 1);
      try { a.songQueue(next); queued = next; } catch (e) { console.error(e); }
    }
    if (song && ss.id === song.id && !ss.playing && !ss.pending && performance.now() - playStart > 1500) { playing = false; syncControls(); }
  }
  let subAudio = null, unsub = null;
  function ensureSub() {
    const a = A();
    if (!a || a === subAudio || typeof a.onState !== 'function') return;
    if (unsub) { try { unsub(); } catch { /* ignore */ } }
    subAudio = a;
    unsub = a.onState(onState);
  }
  ensureSub();
  cleanups.push(() => { if (unsub) unsub(); });

  // the preset changed → the lead part follows from the next segment
  if (store) {
    if (store.onPatch) cleanups.push(store.onPatch(() => { syncControls(); changed(); }));
    if (store.onGlobals) cleanups.push(store.onGlobals(() => syncControls()));
  }

  // language switch: relabel in place (no rebuild — playback, the roll and the settings are untouched)
  function relabel() {
    for (const e of el.querySelectorAll('[data-zh][data-en]')) setBi(e);
    for (const [node, attr, zh, en, sep] of attrs) node.setAttribute(attr, LB(zh, en, sep));
    for (const o of scaleSel.options) o.textContent = scaleText(o.value);
    for (const o of roleSel.options) o.textContent = roleText(o.value);
    syncControls(); // play/lock labels, band notes + preset lists, play-along text, rides, parts
    updateInfo();   // chips (its cache key includes the language)
  }
  cleanups.push(onLangChange(relabel));

  /* ───────── piano roll ───────── */
  const ctx2 = canvas.getContext('2d');
  let rollDirty = true, raf = 0, playStart = 0;
  let layer = null; // offscreen static layer
  let cw = 0, chh = 0, dpr = 1;
  const PAD_L = 8, PAD_R = 8, TOP = 22, BOTTOM = 8;

  function currentBeat() {
    if (!song) return 0;
    const s = lastState;
    if (!playing || !s) return 0;
    const bpm = song.bpm;
    const dt = (performance.now() - lastStateAt) / 1000;
    let b;
    if (!fallback && s.song && s.song.id === song.id) b = s.song.beat + (s.song.playing ? dt * bpm / 60 : 0);
    else if (fallback && s.seqPlaying) b = (s.seqBeat || 0) + dt * bpm / 60;
    else return -1;
    return ((b % song.lengthBeats) + song.lengthBeats) % song.lengthBeats;
  }

  function resize() {
    const r = cvBox.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, Math.round(r.width * dpr)), hh = Math.max(10, Math.round(r.height * dpr));
    if (w !== cw || hh !== chh) { cw = w; chh = hh; canvas.width = w; canvas.height = hh; rollDirty = true; }
  }

  function buildLayer() {
    rollDirty = false;
    if (!song) { layer = null; return; }
    layer = layer || document.createElement('canvas');
    layer.width = cw; layer.height = chh;
    const g = layer.getContext('2d');
    g.clearRect(0, 0, cw, chh);
    const L = song.lengthBeats;
    const x0 = PAD_L * dpr, x1 = cw - PAD_R * dpr, top = TOP * dpr, bot = chh - BOTTOM * dpr;
    const X = b => x0 + (b / L) * (x1 - x0);
    // lanes: melodic (pitched) area + drum strip
    const drumH = Math.round((bot - top) * 0.2);
    const melTop = top, melBot = bot - drumH - 6 * dpr;
    let lo = 127, hi = 0;
    const melodic = song.parts.filter(p => p.role !== 'drums');
    for (const p of melodic) for (const e of p.events) if (e.type === 'on') { lo = Math.min(lo, e.note); hi = Math.max(hi, e.note); }
    if (lo > hi) { lo = 48; hi = 84; }
    lo -= 2; hi += 2;
    const Y = n => melBot - ((n - lo) / (hi - lo)) * (melBot - melTop);
    const rowH = Math.max(2 * dpr, Math.min(7 * dpr, (melBot - melTop) / (hi - lo)));
    // sections & energy
    const E = song.meta.energy;
    g.fillStyle = 'rgba(140,160,220,0.05)';
    g.beginPath();
    g.moveTo(X(0), bot);
    E.forEach((e, i) => { g.lineTo(X(i * 4), bot - e * (bot - top) * 0.9); g.lineTo(X(i * 4 + 4), bot - e * (bot - top) * 0.9); });
    g.lineTo(X(L), bot); g.closePath(); g.fill();
    // bar lines
    for (let b = 0; b <= L; b += 4) {
      g.fillStyle = b % 16 === 0 ? 'rgba(160,180,240,0.22)' : 'rgba(160,180,240,0.09)';
      g.fillRect(Math.round(X(b)), top - 4 * dpr, dpr, bot - top + 4 * dpr);
    }
    // chord symbols
    g.font = `${600} ${11 * dpr}px Inter, "Noto Sans TC", system-ui, sans-serif`;
    g.textBaseline = 'middle';
    for (const c of song.meta.chords) {
      const xa = X(c.beat), xb = X(c.beat + c.beats);
      g.fillStyle = 'rgba(232,236,255,0.06)';
      g.fillRect(xa + dpr, 3 * dpr, xb - xa - 2 * dpr, 15 * dpr);
      g.fillStyle = 'rgba(232,236,255,0.82)';
      g.fillText(c.symbol, xa + 6 * dpr, 10.5 * dpr, Math.max(10, xb - xa - 10 * dpr));
    }
    // notes (melodic lines drawn last so they sit on top of chords)
    const order = song.parts.map((p, i) => i).sort((a, b) => (song.parts[a].role === 'melody' || a === 0 ? 1 : 0) - (song.parts[b].role === 'melody' || b === 0 ? 1 : 0));
    for (const pi of order) {
      const p = song.parts[pi];
      if (p.role === 'drums') continue;
      g.fillStyle = hexA(p.color, pi === 0 || p.role === 'melody' ? 0.95 : 0.5);
      for (const e of p.events) {
        if (e.type !== 'on') continue;
        const xa = X(e.beat), xb = Math.max(xa + 2 * dpr, X(Math.min(L, e.beat + e.dur)) - dpr);
        roundRect(g, xa, Y(e.note) - rowH / 2, xb - xa, rowH, Math.min(rowH / 2, 3 * dpr));
      }
    }
    // drum strip
    const drums = song.parts.filter(p => p.role === 'drums');
    const rows = Math.max(1, drums.length);
    drums.forEach((p, i) => {
      const yy = bot - drumH + (i + 0.5) * (drumH / rows);
      g.fillStyle = hexA(p.color, 0.7);
      for (const e of p.events) {
        if (e.type !== 'on') continue;
        const r = (1.2 + 1.8 * e.vel) * dpr;
        g.beginPath(); g.arc(X(e.beat), yy + (e.note > 80 ? -2 * dpr : e.note < 48 ? 2 * dpr : 0), r, 0, Math.PI * 2); g.fill();
      }
    });
    layer._geom = { X, Y, rowH, top, bot, drumH, lo, hi };
  }

  function drawFrame() {
    resize();
    if (rollDirty) buildLayer();
    ctx2.clearRect(0, 0, cw, chh);
    if (!song || !layer) return;
    ctx2.drawImage(layer, 0, 0);
    const beat = currentBeat();
    if (beat >= 0 && playing) {
      const { X, Y, rowH, top, bot } = layer._geom;
      // glow the notes sounding now
      ctx2.save();
      ctx2.globalCompositeOperation = 'lighter';
      for (let pi = 0; pi < song.parts.length; pi++) {
        const p = song.parts[pi];
        if (p.role === 'drums') continue;
        for (const e of p.events) {
          if (e.type !== 'on' || beat < e.beat || beat > e.beat + e.dur) continue;
          const xa = X(e.beat), xb = X(e.beat + e.dur);
          ctx2.shadowColor = p.color; ctx2.shadowBlur = 12 * dpr;
          ctx2.fillStyle = hexA(p.color, 0.9);
          roundRect(ctx2, xa, Y(e.note) - rowH / 2, Math.max(2 * dpr, xb - xa), rowH, Math.min(rowH / 2, 3 * dpr));
        }
      }
      ctx2.restore();
      // playhead
      const x = X(beat);
      const grad = ctx2.createLinearGradient(x - 24 * dpr, 0, x, 0);
      grad.addColorStop(0, 'rgba(92,242,255,0)'); grad.addColorStop(1, 'rgba(92,242,255,0.16)');
      ctx2.fillStyle = grad;
      ctx2.fillRect(x - 24 * dpr, top - 4 * dpr, 24 * dpr, bot - top + 4 * dpr);
      ctx2.fillStyle = '#e8fbff';
      ctx2.shadowColor = '#5cf2ff'; ctx2.shadowBlur = 10 * dpr;
      ctx2.fillRect(Math.round(x), top - 4 * dpr, 1.5 * dpr, bot - top + 4 * dpr);
      ctx2.shadowBlur = 0;
    }
  }

  let infoKey = '';
  function updateInfo() {
    if (!song) { rollInfo.textContent = ''; infoKey = ''; return; }
    const beat = currentBeat();
    const b = beat < 0 ? 0 : beat;
    const ch = song.meta.chords.reduce((acc, c) => (b >= c.beat - 1e-6 ? c : acc), song.meta.chords[0]);
    const sec = (song.sections || []).reduce((acc, s) => (b >= s.beat - 1e-6 ? s : acc), (song.sections || [])[0]);
    const bar = Math.floor(b / 4) + 1;
    const k = `${playing}|${ch.symbol}|${sec && sec.name}|${bar}|${variation}|${queued ? queued.id : ''}|${song.id}|${getLang()}`;
    if (k === infoKey) return;
    infoKey = k;
    rollInfo.textContent = '';
    const i = song.meta.chords.indexOf(ch);
    const nx = song.meta.chords[(i + 1) % song.meta.chords.length];
    nowChord.textContent = ch.symbol;
    nextChord.textContent = nx && nx !== ch ? `→ ${nx.symbol}` : '';
    nowWrap.classList.toggle('is-live', playing);
    rollInfo.append(...[
      h('span.jam-chip.jam-chip--chord', { text: ch.symbol }),
      sec ? h('span.jam-chip', null, bi(sec.zh, sec.en)) : null,
      h('span.jam-chip.jam-chip--dim', { text: playing ? `${bar} / ${song.meta.bars}` : isEn() ? `${song.meta.bars} bars` : `${song.meta.bars} 小節 bars` }),
      h('span.jam-chip.jam-chip--dim', { text: `${isEn() ? song.meta.keyNameEn || song.meta.keyName : song.meta.keyName} · ${song.bpm} BPM` }),
      playing ? null : h('span.jam-chip.jam-chip--preview', null, bi('預覽', 'Preview')),
    ].filter(Boolean));
    segBadge.textContent = '';
    if (playing && st.endless) segBadge.append(svg(ICONS.infinity, 14), h('span', { text: LB(`第 ${variation + 1} 段`, `segment ${variation + 1}`, ' · ') }));
    if (playing && queued && !st.endless) segBadge.append(h('span.jam-seg__next', { text: `⏭ ${LB('下一段套用變更', 'changes apply next loop', ' · ')}` }));
    else if (playing && dirty && !st.endless) segBadge.append(h('span.jam-seg__next', { text: `⏭ ${LB('準備中', 'preparing', ' · ')}` }));
  }

  function updateRides() {
    if (!song) return;
    const beat = currentBeat();
    for (const r of song.meta.rides) {
      const node = ridesEl.querySelector(`.jam-ride[data-index="${r.index}"] .jam-ride__fill`);
      if (!node) continue;
      const v = playing && beat >= 0 ? rideValue(song.parts[0].events, r.index, beat, r.base) : r.base;
      node.style.transform = `scaleX(${Math.max(0.02, Math.min(1, v))})`;
    }
  }

  let visible = true;
  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); if (visible) startLoop(); }) : null;
  if (io) io.observe(el);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { rollDirty = true; drawFrame(); }) : null;
  if (ro) ro.observe(cvBox);

  function startLoop() {
    if (raf) return;
    const tick = () => {
      raf = 0;
      if (document.hidden || !visible) return;
      drawFrame();
      updateInfo();
      updateRides();
      if (playing) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // silent preview of the jam (the roll is never a blank box; it follows every setting and the preset)
  song = makeSong(0);
  rollEmpty.hidden = true;
  syncControls();
  requestAnimationFrame(() => { drawFrame(); updateInfo(); });

  function destroy() {
    stop();
    clearTimeout(changeTimer);
    if (raf) cancelAnimationFrame(raf);
    for (const fn of cleanups) { try { if (typeof fn === 'function') fn(); } catch { /* ignore */ } }
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    el.remove();
  }

  return {
    el, destroy, stop, play,
    get playing() { return playing; },
    /** Current segment (engine-ready song) — for tests. */
    get song() { return song; },
    settings: st,
  };
}

/* ───────────────────────── drawing helpers ───────────────────────── */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(92,242,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function roundRect(g, x, y, w, hh, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, hh, r); else g.rect(x, y, w, hh);
  g.fill();
}

/** Macro value at `beat` from a part's macro / ramp-macro events (piecewise linear), for the auto-tone meters. */
export function rideValue(events, index, beat, base = 0) {
  let v = base, ramp = null;
  const at = t => (!ramp ? v : t >= ramp.t1 ? ramp.to : ramp.from + (ramp.to - ramp.from) * ((t - ramp.t0) / Math.max(1e-6, ramp.t1 - ramp.t0)));
  for (const e of events) {
    if (e.beat > beat) break;
    if (e.index !== index) continue;
    if (e.type === 'macro') { v = e.value; ramp = null; }
    else if (e.type === 'ramp-macro') { const from = at(e.beat); v = from; ramp = { t0: e.beat, t1: e.beat + e.beats, from, to: e.to }; }
  }
  return at(beat);
}
