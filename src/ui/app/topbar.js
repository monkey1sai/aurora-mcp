// Top bar: logo, preset navigator (◀ name ▶ ★), Save / Undo / Redo / Mutate / Random, the big ▶ Demo
// button, tempo (drag / wheel / type / tap), master volume, MIDI status, CPU + meter, language, menu.

import { h, clamp } from './dom.js';
import { icon } from './icons.js';
import { t, tx, getLang } from './i18n.js';
import { createSlider } from '../components.js';
import { PARAM_BY_ID } from '../../dsp/params.js';

function iconBtn(ic, key, onClick, cls = '') {
  const b = h(`button.icon-btn ${cls}`.trim(), { type: 'button', 'data-i18n-title': key, 'data-i18n-aria': key, title: t(key), 'aria-label': t(key) }, icon(ic, 18));
  b.addEventListener('click', onClick);
  return b;
}
function textBtn(ic, key, onClick, cls = '') {
  const b = h(`button.tb-btn ${cls}`.trim(), { type: 'button', 'data-i18n-title': key, title: t(key) }, icon(ic, 17), tx(key, 'span', 'tb-btn__lbl'));
  b.addEventListener('click', onClick);
  return b;
}

/** Draggable tempo readout (drag ↕, wheel, arrows, double-click to type) + tap tempo. */
function createTempo(store) {
  const p = PARAM_BY_ID['global.bpm'];
  const val = h('span.tempo__val');
  const pulse = h('span.tempo__pulse', { 'aria-hidden': 'true' });
  const el = h('div.tempo', { role: 'spinbutton', tabindex: 0, 'aria-valuemin': p.min, 'aria-valuemax': p.max, 'data-i18n-title': 'tempo', title: `${t('tempo')} — drag / wheel / double-click` },
    pulse, val, h('span.tempo__unit', null, 'BPM'));
  let shown = null;
  const render = () => {
    const v = store.get('global.bpm');
    if (v !== shown) { shown = v; val.textContent = Math.round(v * 10) % 10 ? v.toFixed(1) : String(Math.round(v)); el.setAttribute('aria-valuenow', String(v)); }
  };
  const set = v => store.set('global.bpm', Math.round(clamp(v, p.min, p.max) * 10) / 10);
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus();
    const y0 = e.clientY, v0 = store.get('global.bpm');
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic / already released */ }
    el.classList.add('is-drag');
    const mv = (ev) => set(v0 + Math.round((y0 - ev.clientY) / (ev.shiftKey ? 12 : 3)) * (ev.shiftKey ? 0.1 : 1));
    const up = () => { el.classList.remove('is-drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); set(store.get('global.bpm') + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 1)); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (d) { e.preventDefault(); set(store.get('global.bpm') + d * (e.shiftKey ? 0.1 : 1)); }
    else if (e.key === 'Enter') edit();
  });
  el.addEventListener('dblclick', edit);
  function edit() {
    const inp = h('input.tempo__input', { type: 'number', min: p.min, max: p.max, step: '0.1', value: String(store.get('global.bpm')) });
    val.replaceWith(inp);
    inp.focus();
    inp.select();
    let finished = false;
    const done = (commit) => {
      // removing the focused input fires its blur (→ done(true)): Esc must stay a cancel
      if (finished) return;
      finished = true;
      if (commit) { const v = parseFloat(inp.value); if (Number.isFinite(v)) set(v); }
      inp.replaceWith(val);
      shown = null;
      render();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done(e.key === 'Enter'); try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
    });
    inp.addEventListener('blur', () => done(true), { once: true });
  }
  store.subscribe('global.bpm', render);
  render();

  // tap tempo
  const taps = [];
  const tap = h('button.tb-btn.tb-btn--tap', { type: 'button', 'data-i18n-title': 'tap', title: t('tap') }, icon('tap', 16), tx('tap', 'span', 'tb-btn__lbl'));
  tap.addEventListener('click', () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 6) taps.shift();
    tap.classList.remove('is-hit'); void tap.offsetWidth; tap.classList.add('is-hit');
    if (taps.length >= 2) {
      const iv = [];
      for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
      iv.sort((a, b) => a - b);
      set(60000 / iv[Math.floor(iv.length / 2)]);
    }
  });

  let lastBeat = -1;
  return {
    el, tap,
    /** Beat pulse + (sequencer) tempo display from engine state. */
    onState(st) {
      if (!st) return;
      const b = Math.floor(st.beat || 0);
      if (b !== lastBeat) {
        lastBeat = b;
        pulse.classList.remove('is-beat'); void pulse.offsetWidth; pulse.classList.add('is-beat');
        pulse.classList.toggle('is-bar', b % 4 === 0);
      }
      if (st.seqPlaying && typeof st.bpm === 'number' && Math.abs(st.bpm - store.get('global.bpm')) > 0.05) {
        val.textContent = String(Math.round(st.bpm));
        el.classList.add('is-seq');
        shown = null;
      } else if (el.classList.contains('is-seq')) { el.classList.remove('is-seq'); render(); }
    },
  };
}

export function createTopbar({ store, actions }) {
  const el = h('header.topbar');
  const logo = h('div.logo', { title: 'AURORA 極光' }, h('span.logo__mark', { 'aria-hidden': 'true' }), h('span.logo__word', null, 'AURORA'), h('span.logo__zh', null, '極光'));

  const browse = iconBtn('list', 'presets', actions.toggleDrawer, 'tb-browse');
  const prev = iconBtn('prev', 'prevPreset', actions.prev);
  const next = iconBtn('next', 'nextPreset', actions.next);
  const catIc = h('span.pn__cat');
  const name = h('span.pn__name');
  const dirty = h('span.pn__dirty', { 'data-i18n-title': 'modified', title: t('modified') });
  const nameBtn = h('button.pn__main', { type: 'button', title: t('presets') }, catIc, h('span.pn__text', null, name, dirty));
  nameBtn.addEventListener('click', actions.toggleDrawer);
  const fav = iconBtn('star', 'favourite', actions.fav, 'pn__fav');
  const nav = h('div.pn', null, prev, nameBtn, next, fav);

  const save = textBtn('save', 'save', actions.save);
  const undo = iconBtn('undo', 'undo', actions.undo);
  const redo = iconBtn('redo', 'redo', actions.redo);
  const mutate = textBtn('mutate', 'mutate', actions.mutate, 'tb-btn--mutate');
  const random = textBtn('dice', 'random', actions.random, 'tb-btn--random');
  const tools = h('div.tb-group.tb-tools', null, save, h('span.tb-sep'), undo, redo, h('span.tb-sep'), mutate, random);

  // demo
  const demoIc = h('span.demo__ic', null, icon('play', 18));
  const demoLbl = tx('demo', 'span', 'demo__lbl');
  const demoSub = h('span.demo__sub');
  const demoProg = h('span.demo__prog', { 'aria-hidden': 'true' });
  const demo = h('button.demo', { type: 'button', 'data-i18n-title': 'demo', title: `${t('demo')} (Space)` }, demoProg, demoIc, h('span.demo__txt', null, demoLbl, demoSub));
  demo.addEventListener('click', actions.demo);

  // Demo Center 示範中心: songs, sound tours, jam, magic, theater
  const dcSub = h('span.dc-btn__sub');
  const dcBtn = h('button.dc-btn', { type: 'button', 'data-i18n-title': 'dcOpen', title: t('dcOpen'), 'aria-haspopup': 'dialog' },
    h('span.dc-btn__ic', null, icon('fx', 16)), h('span.dc-btn__txt', null, tx('dcOpen', 'span', 'dc-btn__lbl'), dcSub), h('span.dc-btn__live', { 'aria-hidden': 'true' }));
  dcBtn.addEventListener('click', () => { if (actions.center) actions.center(); });

  const tempo = createTempo(store);
  const vol = createSlider({ param: PARAM_BY_ID['master.volume'], value: store.get('master.volume'), accent: 'aurora', label: false, showValue: true, onChange: v => store.set('master.volume', v, { origin: vol }) });
  store.subscribe('master.volume', (v, o) => { if (o !== vol) vol.setValue(v); });
  const volWrap = h('div.tb-vol', { 'data-i18n-title': 'master', title: t('master') }, icon('amp', 16), vol.el);

  const midiDot = h('span.midi__dot');
  const midiTxt = h('span.midi__txt', null, 'MIDI');
  const midi = h('button.midi', { type: 'button', title: 'MIDI' }, icon('midi', 16), midiDot, midiTxt);
  midi.addEventListener('click', actions.midi);

  const meterHost = h('div.tb-meter');
  const cpu = h('span.cpu', { title: 'CPU' }, h('b', null, '—'), h('small', null, 'CPU'));
  const voices = h('span.cpu.voices', { title: t('voices') }, h('b', null, '0'), h('small', null, 'VOX'));
  // no engine: a labelled "silent · retry" button (was a bare 'Audio' with the meaning only in its tooltip)
  const audioBadgeTxt = h('span.audio-badge__txt');
  const audioBadge = h('button.audio-badge', { type: 'button', hidden: true }, icon('panic', 14), audioBadgeTxt);
  audioBadge.addEventListener('click', actions.retryAudio);

  const lang = h('button.lang', { type: 'button', title: '中文 / English' }, h('span.lang__zh', null, '中'), h('span.lang__sep', null, '/'), h('span.lang__en', null, 'EN'));
  lang.addEventListener('click', actions.toggleLang);
  const menu = iconBtn('menu', 'more', (e) => actions.menu(e.currentTarget));

  const editLbl = h('span.tb-btn__lbl');
  const edit = h('button.tb-btn.tb-edit', { type: 'button', 'aria-pressed': 'false' }, icon('edit', 16), editLbl);
  edit.addEventListener('click', actions.toggleEdit);
  let editing = false;
  const renderEdit = () => {
    edit.firstChild.replaceWith(icon(editing ? 'check' : 'edit', 16));
    editLbl.textContent = t(editing ? 'editDone' : 'editView');
    edit.title = t(editing ? 'editDone' : 'editOpen');
    edit.setAttribute('aria-label', t('editOpen'));
    edit.setAttribute('aria-pressed', String(editing));
    edit.classList.toggle('is-on', editing);
  };
  renderEdit();

  el.append(
    h('div.tb-left', null, browse, logo),
    h('div.tb-center', null, nav, tools, demo, dcBtn),
    h('div.tb-right', null, h('div.tb-tempo', null, tempo.el, tempo.tap), volWrap, midi, h('div.tb-perf', null, meterHost, cpu, voices), audioBadge, edit, lang, menu),
  );

  let audioStatus = 'off';
  const renderAudioBadge = () => {
    audioBadgeTxt.textContent = t(audioStatus === 'error' ? 'audioBadge' : 'audioBadgeOff');
    audioBadge.title = audioStatus === 'error' ? t('audioFailedLong') : t('tapToStart');
  };
  const renderLang = () => {
    renderEdit();
    renderAudioBadge();
    lang.classList.toggle('is-en', getLang() === 'en');
    dcSub.textContent = t('dcOpen', getLang() === 'en' ? 'zh' : 'en');
  };
  renderLang();

  let lastCpu = '', lastVox = '', demoKey = '';
  return {
    el,
    setPreset(meta, cat, isFav) {
      name.textContent = meta.name;
      catIc.textContent = '';
      if (cat) { catIc.append(icon(cat.icon, 15)); catIc.style.setProperty('--c', cat.color); catIc.title = `${cat.zh} ${cat.label}`; }
      fav.classList.toggle('is-on', !!isFav);
      fav.setAttribute('aria-pressed', String(!!isFav));
      fav.hidden = meta.source === 'random' || meta.source === 'init';
    },
    setDirty(d) { el.classList.toggle('is-dirty', d); },
    /** Demo Center button: live dot while a song / tour / jam / theater plays. */
    setCenterLive(kind) { dcBtn.classList.toggle('is-live', !!kind && kind !== 'demo'); dcBtn.setAttribute('aria-expanded', String(document.documentElement.classList.contains('dc-open'))); },
    setHistory({ canUndo, canRedo }) { undo.disabled = !canUndo; redo.disabled = !canRedo; },
    setDemo(playing, progress, label) {
      const key = `${playing}|${label || ''}|${getLang()}`;
      if (key !== demoKey) {
        demoKey = key;
        demo.classList.toggle('is-playing', playing);
        demoIc.replaceChildren(icon(playing ? 'stop' : 'play', 18));
        demoLbl.dataset.i18n = playing ? 'stop' : 'demo';
        demoLbl.textContent = t(playing ? 'stop' : 'demo');
        demoSub.textContent = label || '';
        demo.setAttribute('aria-pressed', String(playing));
      }
      demo.style.setProperty('--p', playing ? (progress || 0).toFixed(3) : '0');
    },
    setMidi(status) {
      // status: { supported, inputs:[names], error }
      midi.classList.toggle('is-on', !!(status && status.inputs && status.inputs.length));
      midi.classList.toggle('is-off', !status || !status.supported);
      const n = status && status.inputs ? status.inputs.length : 0;
      midiTxt.textContent = n ? `MIDI ${n}` : 'MIDI';
      midi.title = !status ? t('midiConnect') : !status.supported ? `${t('midiUnsupported')}${status.error ? ` — ${status.error}` : ''}` : n ? `${n} ${t('midiDevices')}: ${status.inputs.join(', ')}` : t('midiNone');
    },
    flashMidi() { midiDot.classList.remove('is-hit'); void midiDot.offsetWidth; midiDot.classList.add('is-hit'); },
    setAudioStatus(s) {
      audioStatus = s;
      audioBadge.hidden = s === 'ok';
      audioBadge.classList.toggle('is-error', s === 'error');
      renderAudioBadge();
    },
    /** Phone layout: the ✎ button shows ✓ 完成 while the editor is open. */
    setEditing(on) { editing = !!on; renderEdit(); },
    mountMeter(visuals, getState) {
      try {
        const m = visuals.createMeter({ getState });
        meterHost.append(m.el);
      } catch (e) { console.error('meter failed', e); }
    },
    onState(st) {
      tempo.onState(st);
      if (!st) return;
      const c = `${Math.round((st.cpuLoad || 0) * 100)}%`;
      if (c !== lastCpu) { lastCpu = c; cpu.firstChild.textContent = c; cpu.classList.toggle('is-hot', (st.cpuLoad || 0) > 0.7); }
      const v = String(st.activeVoices ?? (st.voices ? st.voices.length : 0));
      if (v !== lastVox) { lastVox = v; voices.firstChild.textContent = v; }
    },
    renderLang,
  };
}
