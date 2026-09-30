// 演奏 Perform tab: arpeggiator (with live step lights), chord memory (chord preview), scale lock
// (key picker on a mini piano), voice/glide, vibrato, tempo & master.

import { h } from './dom.js';
import { card, row } from './parts.js';
import { t, pairLabel } from './i18n.js';
import { icon } from './icons.js';
import { CHORDS, SCALES, PARAM_BY_ID } from '../../dsp/params.js';
import { createSelect } from '../components.js';

const TEAL = '#3ef0b0';
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

export function buildPerform(ctx, scope) {
  const root = h('div.pane.pane--perform');
  root.append(h('div.perf-grid', null,
    buildArp(ctx, scope).el, buildChord(ctx, scope).el, buildScale(ctx, scope).el,
    buildVoice(ctx, scope).el, buildVibrato(ctx, scope).el, buildGlobal(ctx, scope).el));
  return root;
}

function buildArp(ctx, scope) {
  const { binder } = ctx;
  const c = card({ group: 'arp', icon: 'arp', accent: TEAL, cls: 'card--arp' });
  c.head.append(binder.toggle(scope, 'arp.on', { accent: TEAL, label: false }).el);
  const k = (id, o = {}) => binder.knob(scope, id, { accent: TEAL, ...o }).el;
  const steps = h('div.arp-steps', { 'aria-hidden': 'true' });
  const dots = [];
  for (let i = 0; i < 16; i++) { const d = h('i'); dots.push(d); steps.append(d); }
  c.body.append(steps,
    h('div.krow', null, binder.select(scope, 'arp.mode', { accent: TEAL, variant: 'dropdown' }).el, binder.select(scope, 'arp.rate', { accent: TEAL, variant: 'dropdown' }).el),
    row(k('arp.oct'), k('arp.gate'), k('arp.swing'), binder.toggle(scope, 'arp.latch', { accent: TEAL }).el));
  binder.watch(scope, ['arp.on'], s => c.el.classList.toggle('is-bypassed', !s.get('arp.on')));
  let lastStep = -2;
  scope.add(ctx.onState((st) => {
    const sIdx = st && st.arpStep >= 0 ? st.arpStep % 16 : -1;
    if (sIdx === lastStep) return;
    if (lastStep >= 0 && dots[lastStep]) dots[lastStep].classList.remove('is-on');
    if (sIdx >= 0) dots[sIdx].classList.add('is-on');
    lastStep = sIdx;
  }));
  return c;
}

/** Mini piano (2 octaves from C) with highlighted pitch classes/notes. */
function miniPiano({ octaves = 2, onPick } = {}) {
  const el = h('div.mini-piano', { style: `--oct:${octaves}` });
  const keys = [];
  let wi = 0;
  for (let n = 0; n < 12 * octaves + 1; n++) {
    const pc = n % 12;
    const black = IS_BLACK[pc];
    const k = h(`button.mp-key.${black ? 'mp-key--b' : 'mp-key--w'}`, { type: 'button', tabindex: onPick ? 0 : -1, title: NOTE_NAMES[pc], 'aria-label': NOTE_NAMES[pc] });
    if (black) k.style.setProperty('--x', wi - 0.3);
    else { k.style.setProperty('--x', wi); wi++; }
    if (onPick) k.addEventListener('click', () => onPick(pc));
    else k.disabled = true;
    keys.push(k);
    el.append(k);
  }
  el.style.setProperty('--nw', wi);
  return {
    el,
    set(fn) { keys.forEach((k, n) => { const r = fn(n); k.classList.toggle('is-on', !!r); k.classList.toggle('is-root', r === 'root'); }); },
  };
}

// Bilingual chord labels keyed by option id (params.js CHORD_IDS gives the musical order).
const CHORD_LABELS = {
  off: ['關閉', 'Off'], maj: ['大三', 'Major'], min: ['小三', 'Minor'], sus2: ['掛二', 'Sus2'], sus4: ['掛四', 'Sus4'], 7: ['屬七', 'Dom 7'],
  maj7: ['大七', 'Maj 7'], min7: ['小七', 'Min 7'], add9: ['加九', 'Add 9'], min9: ['小九', 'Min 9'], power: ['強力', 'Power'], oct: ['八度', 'Octave'], stack4: ['四度堆疊', 'Fourths'],
};
function chordSelect(ctx, scope) {
  const { store } = ctx;
  const p = PARAM_BY_ID['chord.type'];
  const order = ['off', 'maj', 'min', 'sus2', 'sus4', '7', 'maj7', 'min7', 'add9', 'min9', 'power', 'oct', 'stack4'].filter(o => p.options.includes(o));
  for (const o of p.options) if (!order.includes(o)) order.push(o);
  let se = null;
  se = createSelect({
    param: { id: 'chord.type', type: 'enum', options: order, labels: order.map(o => { const l = CHORD_LABELS[o] && pairLabel(...CHORD_LABELS[o]); return l ? `${l.zh}  ${l.en}` : o; }), def: 'off', zh: p.zh, label: p.label },
    value: store.get('chord.type'), accent: TEAL, variant: 'dropdown', label: pairLabel(p.zh, p.label),
    onChange: v => store.set('chord.type', v, { origin: se }),
  });
  scope.add(store.subscribe('chord.type', (v, o) => { if (o !== se) se.setValue(v); }));
  scope.add(() => se.destroy && se.destroy());
  return se.el;
}

function buildChord(ctx, scope) {
  const { binder } = ctx;
  const c = card({ group: 'chord', icon: 'keys', accent: TEAL, cls: 'card--chord' });
  const piano = miniPiano({ octaves: 2 });
  const names = h('div.chord-notes');
  c.body.append(chordSelect(ctx, scope), piano.el, names,
    h('p.card__note', null, icon('keys', 13), h('span', null, pairLabel('按一個鍵就彈出整個和弦（以按下的音為根音）', 'One key plays the whole chord (rooted on the key)').zh)));
  binder.watch(scope, ['chord.type'], (s) => {
    const iv = CHORDS[s.get('chord.type')] || [0];
    const set = new Set(iv);
    piano.set(n => (n === 0 ? 'root' : set.has(n)));
    names.textContent = s.get('chord.type') === 'off' ? '—' : iv.map(i => NOTE_NAMES[i % 12]).join(' · ');
    c.el.classList.toggle('is-bypassed', s.get('chord.type') === 'off');
  });
  return c;
}

function buildScale(ctx, scope) {
  const { binder, store } = ctx;
  const c = card({ group: 'scale', icon: 'perform', accent: TEAL, cls: 'card--scale' });
  c.head.append(h('span.card__badge', { title: t('globalHint') }, pairLabel('全域', 'Global').zh));
  const piano = miniPiano({ octaves: 1, onPick: pc => store.set('scale.root', pc) });
  c.body.append(binder.select(scope, 'scale.type', { accent: TEAL, variant: 'dropdown' }).el,
    h('div.sect__label', null, h('span', null, pairLabel('調性', 'Key').zh), h('small', null, 'Key')), piano.el,
    h('p.card__note', null, icon('check', 13), h('span', null, pairLabel('彈奏的音會自動對齊到音階（琴鍵上會標示）', 'Played notes snap to the scale (marked on the keys)').zh)));
  binder.watch(scope, ['scale.type', 'scale.root'], (s) => {
    const sc = SCALES[s.get('scale.type')];
    const root = s.get('scale.root') | 0;
    const set = sc ? new Set(sc.map(i => (i + root) % 12)) : null;
    piano.set(n => { const pc = n % 12; if (pc === root) return 'root'; return set ? set.has(pc) : false; });
    c.el.classList.toggle('is-bypassed', !sc);
  });
  return c;
}

function buildVoice(ctx, scope) {
  const { binder } = ctx;
  const c = card({ group: 'voice', icon: 'keyboard', accent: TEAL, cls: 'card--voice' });
  const k = (id, o = {}) => binder.knob(scope, id, { accent: TEAL, ...o }).el;
  c.body.append(binder.select(scope, 'voice.mode', { accent: TEAL, label: false }).el,
    row(k('voice.poly'), k('voice.glide', { size: 'md' }), k('voice.bend')), row(k('voice.pitch', { bipolar: true }), k('voice.spread')));
  return c;
}

function buildVibrato(ctx, scope) {
  const { binder } = ctx;
  const c = card({ group: 'vibrato', icon: 'mod', accent: TEAL, cls: 'card--vib' });
  const k = (id, o = {}) => binder.knob(scope, id, { accent: TEAL, ...o }).el;
  c.body.append(row(k('vib.depth', { size: 'md' }), k('vib.rate', { size: 'md' })), row(k('vib.delay'), k('vib.wheel')));
  return c;
}

function buildGlobal(ctx, scope) {
  const { binder } = ctx;
  const c = card({ group: 'global', icon: 'globe', accent: TEAL, cls: 'card--global' });
  c.head.append(h('span.card__badge', { title: t('globalHint') }, pairLabel('全域', 'Global').zh));
  const k = (id, o = {}) => binder.knob(scope, id, { accent: TEAL, ...o }).el;
  c.body.append(row(k('global.bpm', { size: 'md' }), k('master.volume', { size: 'md' })),
    h('p.card__note', null, icon('globe', 13), h('span', null, t('globalHint'))));
  return c;
}

