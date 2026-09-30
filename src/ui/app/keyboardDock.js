// Bottom dock: pitch-bend (spring) + mod-wheel strips, octave shift, velocity, hold (sustain), and the
// on-screen keyboard. Active keys follow the engine's voices (so arp/sequencer notes light up too).

import { h, storage } from './dom.js';
import { icon } from './icons.js';
import { t, tx } from './i18n.js';
import { createSlider } from '../components.js';
import { createKeyboard } from '../keyboard.js';
import { SCALES, noteName } from '../../dsp/params.js';

const BEND = { id: 'ui.bend', type: 'float', min: -1, max: 1, def: 0, unit: '', label: 'Bend', zh: '彎音' };
const WHEEL = { id: 'ui.wheel', type: 'float', min: 0, max: 1, def: 0, unit: '%', label: 'Mod', zh: '調變輪' };

/**
 * opts: { store, noteOn(n, v), noteOff(n), controller(kind, v) }
 * → { el, keyboard, setActiveFromState(state), setWheel(v), setBend(v), setBase(n), octave(delta), onOctave(cb) }
 */
export function createKeyboardDock({ store, noteOn, noteOff, controller }) {
  const el = h('footer.dock', { 'aria-label': t('regionKeyboard'), 'data-i18n-aria': 'regionKeyboard' });
  let base = storage.get('aurora.kbBase', 48); // lowest C shown
  const span = 48; // 4 octaves + top C
  const kb = createKeyboard({ low: base, high: base + span, onNoteOn: noteOn, onNoteOff: noteOff, fit: true, minKeyWidth: 22 });

  const bend = createSlider({ param: BEND, value: 0, orientation: 'v', spring: true, accent: 'var(--a-cyan)', label: false, showValue: false, onChange: v => controller('bend', v) });
  const wheel = createSlider({ param: WHEEL, value: 0, orientation: 'v', accent: 'var(--a-violet)', label: false, showValue: false, onChange: v => controller('wheel', v) });
  const wheels = h('div.dock__wheels', null,
    h('div.wheel', null, bend.el, h('span.wheel__lbl', null, tx('bend'))),
    h('div.wheel', null, wheel.el, h('span.wheel__lbl', null, tx('modWheel'))));

  const octLbl = h('span.oct__val');
  const down = h('button.icon-btn.oct__btn.oct__btn--down', { type: 'button', 'aria-label': t('octDown'), 'data-i18n-aria': 'octDown', title: t('octDown'), 'data-i18n-title': 'octDown' }, icon('prev', 16));
  const up = h('button.icon-btn.oct__btn.oct__btn--up', { type: 'button', 'aria-label': t('octUp'), 'data-i18n-aria': 'octUp', title: t('octUp'), 'data-i18n-title': 'octUp' }, icon('next', 16));
  const velLbl = h('span.vel__val');
  const velBar = h('span.vel__bar', null, h('i'));
  let holdOn = false;
  const hold = h('button.pill-btn.hold', { type: 'button', 'aria-pressed': 'false', title: t('sustainPedal'), 'data-i18n-title': 'sustainPedal' }, icon('pedal', 16), tx('hold'));
  hold.addEventListener('click', () => setHold(!holdOn));
  function setHold(on) {
    holdOn = on;
    hold.classList.toggle('is-on', on);
    hold.setAttribute('aria-pressed', String(on));
    controller('sustain', on ? 1 : 0);
  }
  const ctl = h('div.dock__ctl', null,
    h('div.oct', null, h('span.dock__cap', null, tx('octave')), h('div.oct__row', null, down, octLbl, up)),
    h('div.vel', null, h('span.dock__cap', null, tx('velocity')), h('div.vel__row', null, velBar, velLbl)),
    hold);
  el.append(wheels, ctl, h('div.dock__kb', null, kb.el));

  const octCbs = new Set();
  // the range actually on screen (a phone-width keyboard shows a centred part of the requested 4 octaves)
  function renderOct() {
    const [lo, hi] = kb.getRange();
    octLbl.textContent = `${noteName(lo)}–${noteName(hi)}`;
    down.disabled = base <= 12;
    up.disabled = base >= 72;
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => renderOct()).observe(kb.el);
  function setBase(n) {
    base = Math.max(12, Math.min(72, n));
    storage.set('aurora.kbBase', base);
    kb.setRange(base, base + span);
    renderOct();
  }
  function octave(d) {
    setBase(base + 12 * d);
    for (const f of octCbs) f(base);
  }
  down.addEventListener('click', () => octave(-1));
  up.addEventListener('click', () => octave(1));
  renderOct();

  // scale lock marks
  const applyScale = () => {
    const sc = SCALES[store.get('scale.type')];
    kb.setScale(store.get('scale.root') | 0, sc || null);
  };
  store.subscribe('scale.type', applyScale);
  store.subscribe('scale.root', applyScale);
  applyScale();

  let lastKey = '';
  return {
    el,
    keyboard: kb,
    setActiveFromState(st) {
      if (!st || !st.voices) return;
      const set = new Set();
      for (const v of st.voices) if (v.stage !== 'release' && v.stage !== 'idle') set.add(v.note);
      const key = [...set].sort().join(',');
      if (key === lastKey) return;
      lastKey = key;
      kb.setActive(set);
    },
    setWheel(v) { wheel.setValue(v); },
    setBend(v) { bend.setValue(v); },
    setVelocity(v) {
      velLbl.textContent = String(Math.round(v * 127));
      velBar.firstChild.style.width = `${Math.round(v * 100)}%`;
    },
    setSustain(on) { if (on !== holdOn) { holdOn = on; hold.classList.toggle('is-on', on); hold.setAttribute('aria-pressed', String(on)); } },
    setQwertyBase(n) { kb.setQwertyHints(n); },
    setBase, octave,
    getBase: () => base,
    onOctave(cb) { octCbs.add(cb); return () => octCbs.delete(cb); },
    releaseAll() { kb.releaseAll(); },
  };
}

