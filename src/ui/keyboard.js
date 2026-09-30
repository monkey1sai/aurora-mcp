// AURORA 極光 — on-screen piano, computer-keyboard (QWERTY) input and Web MIDI input.
// Plain DOM, no dependencies. Never talks to audio directly: everything is reported via callbacks.
// Styling: css/components.css (`ac-kb` classes).

import { noteName } from '../dsp/params.js';

const noop = () => {};
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
// Black-key centre offsets from the boundary between the neighbouring white keys, in white-key widths
// (real pianos: C♯/D♯ lean outwards, F♯/A♯ lean outwards, G♯ centred).
const BLACK_OFF = { 1: -0.09, 3: 0.09, 6: -0.11, 8: 0, 10: 0.11 };
const BLACK_W = 0.6; // black key width in white-key widths
const BLACK_H = 0.62; // black key height as a fraction of the keyboard height
const pcOf = (n) => ((n % 12) + 12) % 12;
const AURORA = ['var(--a-teal, #3ef0b0)', 'var(--a-cyan, #5cf2ff)', 'var(--a-violet, #a78bfa)', 'var(--a-pink, #ff6bd6)'];

/** CSS colour along the aurora gradient for t in 0..1 (uses the design tokens). */
function auroraAt(t) {
  t = clamp(t, 0, 1) * (AURORA.length - 1);
  const i = Math.min(AURORA.length - 2, Math.floor(t));
  const f = t - i;
  return `color-mix(in oklab, ${AURORA[i]} ${Math.round((1 - f) * 100)}%, ${AURORA[i + 1]})`;
}

/** Ableton-style computer keyboard layout: [KeyboardEvent.code, semitone offset from base, glyph]. */
export const QWERTY_LAYOUT = Object.freeze([
  ['KeyA', 0, 'A'], ['KeyW', 1, 'W'], ['KeyS', 2, 'S'], ['KeyE', 3, 'E'], ['KeyD', 4, 'D'],
  ['KeyF', 5, 'F'], ['KeyT', 6, 'T'], ['KeyG', 7, 'G'], ['KeyY', 8, 'Y'], ['KeyH', 9, 'H'],
  ['KeyU', 10, 'U'], ['KeyJ', 11, 'J'], ['KeyK', 12, 'K'], ['KeyO', 13, 'O'], ['KeyL', 14, 'L'],
  ['KeyP', 15, 'P'], ['Semicolon', 16, ';'], ['Quote', 17, "'"],
].map(Object.freeze));
const QWERTY_MAP = new Map(QWERTY_LAYOUT.map(([code, off]) => [code, off]));

/** Pure layout: white keys and black-key centres (in white-key units) for a note range. */
export function keyboardLayout(low, high) {
  const whites = [];
  const whiteIndex = new Map();
  for (let n = low; n <= high; n++) {
    if (!IS_BLACK[pcOf(n)]) { whiteIndex.set(n, whites.length); whites.push(n); }
  }
  const blacks = [];
  for (let n = low; n <= high; n++) {
    const pc = pcOf(n);
    if (!IS_BLACK[pc]) continue;
    const wi = whiteIndex.get(n - 1);
    if (wi === undefined || !whiteIndex.has(n + 1)) continue;
    const c = wi + 1 + BLACK_OFF[pc];
    blacks.push({ note: n, c, l: c - BLACK_W / 2, r: c + BLACK_W / 2 });
  }
  return { whites, blacks };
}

/** Pure hit test: fx, fy in 0..1 of the keyboard box → { note, vel } | null. */
export function keyboardHit(layout, fx, fy) {
  if (fx < 0 || fx >= 1 || fy < 0 || fy > 1) return null;
  const nW = layout.whites.length;
  const u = fx * nW;
  if (fy <= BLACK_H) {
    for (const b of layout.blacks) {
      if (u >= b.l && u <= b.r) return { note: b.note, vel: velocityFrom(fy / BLACK_H) };
    }
  }
  const wi = Math.min(nW - 1, Math.floor(u));
  return { note: layout.whites[wi], vel: velocityFrom(fy) };
}
/** Vertical position on a key (0 top … 1 front edge) → velocity 0..1. */
function velocityFrom(f) {
  return clamp(0.24 + 0.76 * Math.pow(clamp(f, 0, 1), 0.85), 0.05, 1);
}

/**
 * On-screen piano.
 * @param {{low?:number, high?:number, onNoteOn?(note,vel), onNoteOff?(note), showLabels?:boolean,
 *          fit?:boolean, minKeyWidth?:number}} opts
 *   fit: when the white keys would be narrower than minKeyWidth (px, default 22), whole octaves are
 *        trimmed from the requested range (around its centre) so keys stay playable on phones.
 * @returns {{ el, setActive(noteSet), setScale(root, intervals|null), setRange(low, high), getRange(),
 *             setQwertyHints(baseNote|null), releaseAll(), destroy() }}
 */
export function createKeyboard({
  low = 36, high = 96, onNoteOn = noop, onNoteOff = noop, showLabels = true, fit = false, minKeyWidth = 22,
} = {}) {
  const root = document.createElement('div');
  root.className = 'ac-kb';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '琴鍵 Keyboard');
  root.style.setProperty('--kb-bh', `${BLACK_H * 100}%`);
  const keysEl = document.createElement('div');
  keysEl.className = 'ac-kb__keys';
  root.append(keysEl);

  let layout = null;
  let lo = 0, hi = 0;
  const keyEls = new Map();
  let active = new Set();
  let scale = null; // { root, set:Set<pc> }
  let hintBase = null;
  const hintEls = [];

  // pointer state (multi-touch): pointerId → note|null; note → refcount of pointers holding it
  const ptrNote = new Map();
  const held = new Map();
  let rect = null;

  function press(note, vel) {
    const c = held.get(note) || 0;
    held.set(note, c + 1);
    if (c) return;
    const k = keyEls.get(note);
    if (k) { k.style.setProperty('--vel', vel.toFixed(2)); k.classList.add('is-pressed'); }
    onNoteOn(note, vel);
  }
  function release(note) {
    const c = held.get(note) || 0;
    if (c > 1) { held.set(note, c - 1); return; }
    if (!c) return;
    held.delete(note);
    const k = keyEls.get(note);
    if (k) k.classList.remove('is-pressed');
    onNoteOff(note);
  }
  function releaseAll() {
    for (const n of Array.from(held.keys())) { held.set(n, 1); release(n); }
    ptrNote.clear();
  }

  function build() {
    keysEl.textContent = '';
    keyEls.clear();
    hintEls.length = 0;
    layout = keyboardLayout(lo, hi);
    const nW = layout.whites.length;
    root.style.setProperty('--nw', nW);
    const span = Math.max(1, hi - lo);
    const frag = document.createDocumentFragment();
    layout.whites.forEach((n, i) => {
      const k = document.createElement('div');
      k.className = 'ac-kb__key ac-kb__key--w';
      k.dataset.note = n;
      k.style.setProperty('--i', i);
      k.style.setProperty('--kc', auroraAt((n - lo) / span));
      if (pcOf(n) === 0) {
        k.classList.add('is-c');
        if (showLabels) {
          const s = document.createElement('span');
          s.className = 'ac-kb__name';
          s.textContent = noteName(n);
          k.append(s);
        }
      }
      keyEls.set(n, k);
      frag.append(k);
    });
    for (const b of layout.blacks) {
      const k = document.createElement('div');
      k.className = 'ac-kb__key ac-kb__key--b';
      k.dataset.note = b.note;
      k.style.setProperty('--c', b.c.toFixed(3));
      k.style.setProperty('--kc', auroraAt((b.note - lo) / span));
      keyEls.set(b.note, k);
      frag.append(k);
    }
    keysEl.append(frag);
    for (const n of active) { const k = keyEls.get(n); if (k) k.classList.add('is-active'); }
    for (const n of held.keys()) { const k = keyEls.get(n); if (k) k.classList.add('is-pressed'); }
    applyScale();
    applyHints();
  }

  function applyScale() {
    root.classList.toggle('has-scale', !!scale);
    for (const [n, k] of keyEls) {
      const pc = scale ? pcOf(n - scale.root) : -1;
      const inS = !!scale && scale.set.has(pc);
      k.classList.toggle('in-scale', inS);
      k.classList.toggle('out-scale', !!scale && !inS);
      k.classList.toggle('is-root', !!scale && pc === 0);
    }
  }
  function applyHints() {
    for (const e of hintEls) e.remove();
    hintEls.length = 0;
    if (hintBase == null) return;
    for (const [, off, glyph] of QWERTY_LAYOUT) {
      const k = keyEls.get(hintBase + off);
      if (!k) continue;
      const s = document.createElement('span');
      s.className = 'ac-kb__hint';
      s.textContent = glyph;
      k.append(s);
      hintEls.push(s);
    }
  }

  function hitAt(e) {
    if (!rect || !layout) return null;
    return keyboardHit(layout, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  }
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    rect = keysEl.getBoundingClientRect();
    try { keysEl.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const hit = hitAt(e);
    ptrNote.set(e.pointerId, hit ? hit.note : null);
    if (hit) press(hit.note, hit.vel);
  }
  function onMove(e) {
    if (!ptrNote.has(e.pointerId)) return;
    const hit = hitAt(e);
    const cur = ptrNote.get(e.pointerId);
    const next = hit ? hit.note : null;
    if (next === cur) return;
    if (cur != null) release(cur);
    if (hit) press(hit.note, hit.vel); // glissando
    ptrNote.set(e.pointerId, next);
  }
  function onUp(e) {
    if (!ptrNote.has(e.pointerId)) return;
    const cur = ptrNote.get(e.pointerId);
    ptrNote.delete(e.pointerId);
    if (cur != null) release(cur);
  }
  keysEl.addEventListener('pointerdown', onDown);
  keysEl.addEventListener('pointermove', onMove);
  keysEl.addEventListener('pointerup', onUp);
  keysEl.addEventListener('pointercancel', onUp);
  keysEl.addEventListener('lostpointercapture', onUp);
  keysEl.addEventListener('contextmenu', (e) => e.preventDefault());

  let req = [low, high]; // requested range (fit mode may show a sub-range)
  function apply(l, h) {
    if (l === lo && h === hi && layout) return;
    // release pointer-held notes that would leave the keyboard
    for (const [id, n] of ptrNote) if (n != null && (n < l || n > h)) { release(n); ptrNote.set(id, null); }
    lo = l; hi = h;
    build();
    sizeClasses();
  }
  function fitted(l, h) {
    const w = root.clientWidth;
    if (!fit || !w) return [l, h];
    const maxW = Math.max(7, Math.floor(w / minKeyWidth));
    const mid = (l + h) / 2;
    const count = (a, b) => keyboardLayout(a, b).whites.length;
    // trim whole octaves (keeps C…C framing); switch to single white keys from the top when a
    // whole octave would throw away too much of the available width
    while (count(l, h) > maxW && h - l > 7) {
      const top = h - mid >= mid - l;
      const nl = top ? l : l + 12, nh = top ? h - 12 : h;
      if (nh - nl >= 7 && (count(nl, nh) >= maxW * 0.75 || count(nl, nh) > maxW)) { l = nl; h = nh; continue; }
      h -= IS_BLACK[pcOf(h - 1)] ? 2 : 1;
    }
    return [l, h];
  }
  function setRange(l, h) {
    l = clamp(Math.round(l), 0, 127);
    h = clamp(Math.round(h), 0, 127);
    if (h < l) { const t = l; l = h; h = t; }
    if (IS_BLACK[pcOf(l)]) l = Math.max(0, l - 1);
    if (IS_BLACK[pcOf(h)]) h = Math.min(127, h + 1);
    if (h - l < 4) h = Math.min(127, l + 4);
    if (IS_BLACK[pcOf(h)]) h = Math.min(127, h + 1);
    req = [l, h];
    const [a, b] = fitted(l, h);
    apply(a, b);
  }
  /** Width-dependent label density: hide hints/names when keys get narrow. */
  function sizeClasses() {
    const w = root.clientWidth;
    if (!w || !layout) return;
    const kw = w / layout.whites.length;
    root.classList.toggle('is-narrow', kw < 20);
    root.classList.toggle('is-tiny', kw < 13);
  }
  setRange(low, high);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const [a, b] = fitted(req[0], req[1]);
    if (a !== lo || b !== hi) apply(a, b); else sizeClasses();
  }) : null;
  if (ro) ro.observe(root);

  return {
    el: root,
    /** Mark sounding notes (Set, array or any iterable of MIDI numbers). */
    setActive(notes) {
      const next = notes instanceof Set ? notes : new Set(notes || []);
      for (const n of active) if (!next.has(n)) { const k = keyEls.get(n); if (k) k.classList.remove('is-active'); }
      for (const n of next) if (!active.has(n)) { const k = keyEls.get(n); if (k) k.classList.add('is-active'); }
      active = new Set(next);
    },
    /** Highlight a scale (intervals relative to root, e.g. SCALES.minor) or clear with null. */
    setScale(rootPc, intervals) {
      scale = intervals && intervals.length
        ? { root: pcOf(Math.round(rootPc || 0)), set: new Set(intervals.map((i) => pcOf(Math.round(i)))) }
        : null;
      applyScale();
    },
    setRange,
    getRange: () => [lo, hi],
    /** Show computer-keyboard letters on the keys starting at baseNote (null hides). */
    setQwertyHints(base) { hintBase = base == null ? null : Math.round(base); applyHints(); },
    releaseAll,
    destroy() { releaseAll(); if (ro) ro.disconnect(); root.remove(); },
  };
}

/* ═══════════════════════════════ QWERTY input ═══════════════════════════════ */

const VEL_STEPS = [20, 40, 60, 80, 100, 127].map((v) => v / 127);
const TEXT_INPUT_OK = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

function isTypingTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !TEXT_INPUT_OK.has((t.type || 'text').toLowerCase());
  return !!(t.closest && t.closest('[role="listbox"],[role="combobox"],[role="textbox"],[role="searchbox"],[contenteditable=""],[contenteditable="true"]'));
}

/**
 * Computer-keyboard playing (Ableton layout): A W S E D F T G Y H U J K O L P ; '  = C … F (1½ octaves),
 * Z / X octave down / up, C / V velocity down / up. No key-repeat retriggers; ignored while typing in
 * inputs; everything is released on window blur / tab hide.
 * Extras: baseNote (default 60 = C4 on the A key), velocity (0..1), onVelocity(vel), target (default window).
 * @returns {Function} detach() — also carries getBaseNote/setBaseNote/getVelocity/setVelocity/releaseAll.
 */
export function attachQwerty({
  onNoteOn = noop, onNoteOff = noop, onOctave = noop, onVelocity = noop,
  baseNote = 60, velocity = 100 / 127, target,
} = {}) {
  const tgt = target || (typeof window !== 'undefined' ? window : null);
  let base = clamp(Math.round(baseNote), 0, 120);
  let vel = clamp(+velocity || 100 / 127, 0.01, 1);
  const codeNote = new Map(); // physical key code → note it triggered
  const noteCount = new Map(); // note → number of physical keys holding it

  function on(note) {
    const c = noteCount.get(note) || 0;
    noteCount.set(note, c + 1);
    if (!c) onNoteOn(note, vel);
  }
  function off(note) {
    const c = noteCount.get(note) || 0;
    if (c > 1) { noteCount.set(note, c - 1); return; }
    if (!c) return;
    noteCount.delete(note);
    onNoteOff(note);
  }
  function releaseAll() {
    codeNote.clear();
    for (const n of Array.from(noteCount.keys())) { noteCount.set(n, 1); off(n); }
  }
  function shiftOct(d) {
    const nb = clamp(base + d * 12, 0, 120);
    if (nb === base) return;
    base = nb;
    onOctave(d, base);
  }
  function stepVel(d) {
    let i = VEL_STEPS.findIndex((v) => v >= vel - 1e-6);
    if (i < 0) i = VEL_STEPS.length - 1;
    if (d > 0 && VEL_STEPS[i] > vel + 1e-6) i -= 1; // between steps: go to the next one up
    i = clamp(i + d, 0, VEL_STEPS.length - 1);
    vel = VEL_STEPS[i];
    onVelocity(vel);
  }

  function keydown(e) {
    const code = e.code;
    const mapped = QWERTY_MAP.has(code) || code === 'KeyZ' || code === 'KeyX' || code === 'KeyC' || code === 'KeyV';
    if (!mapped) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(typeof document !== 'undefined' ? document.activeElement : null)) return;
    e.preventDefault();
    if (e.repeat || codeNote.has(code)) return;
    const off12 = QWERTY_MAP.get(code);
    if (off12 !== undefined) {
      const note = base + off12;
      if (note > 127) return;
      codeNote.set(code, note);
      on(note);
      return;
    }
    if (code === 'KeyZ') shiftOct(-1);
    else if (code === 'KeyX') shiftOct(1);
    else if (code === 'KeyC') stepVel(-1);
    else if (code === 'KeyV') stepVel(1);
  }
  function keyup(e) {
    const note = codeNote.get(e.code);
    if (note === undefined) return;
    codeNote.delete(e.code);
    off(note);
  }
  const onVis = () => { if (typeof document !== 'undefined' && document.hidden) releaseAll(); };

  if (tgt) {
    tgt.addEventListener('keydown', keydown);
    tgt.addEventListener('keyup', keyup);
    tgt.addEventListener('blur', releaseAll);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);

  const detach = () => {
    releaseAll();
    if (tgt) {
      tgt.removeEventListener('keydown', keydown);
      tgt.removeEventListener('keyup', keyup);
      tgt.removeEventListener('blur', releaseAll);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  };
  detach.getBaseNote = () => base;
  detach.setBaseNote = (n) => { base = clamp(Math.round(n), 0, 120); };
  detach.getVelocity = () => vel;
  detach.setVelocity = (v) => { vel = clamp(+v, 0.01, 1); };
  detach.releaseAll = releaseAll;
  return detach;
}

/* ═══════════════════════════════ Web MIDI input ═══════════════════════════════ */

/** Parse one MIDI message and dispatch. Exported for testing; `state` is from createMidiState(). */
export function createMidiState() {
  return {
    held: new Map() /* inputId → Set<note> */, count: new Map() /* note → #inputs holding */, poly: new Map() /* note → pressure */,
    ctl: new Map() /* controller kind → { id: input that set it last, v } — reset when that input goes away */,
  };
}

/**
 * A MIDI input went away (unplugged / detached): release its held notes, and put the controllers it set last
 * (sustain pedal, pitch bend, mod wheel, aftertouch) back to rest — they would stay latched otherwise.
 */
export function releaseMidiInput(state, id, cb) {
  const set = state.held.get(id);
  if (set) {
    for (const n of Array.from(set)) handleMidiMessage(state, id, [0x80, n, 0], { ...cb, channel: null });
    state.held.delete(id);
  }
  if (!state.ctl) return;
  for (const [kind, c] of Array.from(state.ctl)) {
    if (c.id !== id) continue;
    state.ctl.delete(kind);
    if (c.v !== 0) cb.onController(kind, 0);
  }
}

export function handleMidiMessage(state, inputId, data, cb) {
  if (!data || data.length < 1) return;
  const st = data[0];
  if (st >= 0xf0 || st < 0x80) return; // system / realtime / stray data
  const type = st & 0xf0;
  const ch = st & 0x0f;
  if (cb.channel != null && cb.channel !== ch) return;
  const d1 = data.length > 1 ? data[1] & 0x7f : 0;
  const d2 = data.length > 2 ? data[2] & 0x7f : 0;
  let set = state.held.get(inputId);
  if (!set) { set = new Set(); state.held.set(inputId, set); }
  const ctl = (kind, v) => {
    if (state.ctl) state.ctl.set(kind, { id: inputId, v });
    cb.onController(kind, v);
  };
  const noteOff = (n) => {
    if (!set.has(n)) return;
    set.delete(n);
    state.poly.delete(n);
    const c = (state.count.get(n) || 1) - 1;
    if (c <= 0) { state.count.delete(n); cb.onNoteOff(n); } else state.count.set(n, c);
  };
  switch (type) {
    case 0x90:
      if (d2 === 0) { noteOff(d1); break; }
      if (!set.has(d1)) { set.add(d1); state.count.set(d1, (state.count.get(d1) || 0) + 1); }
      cb.onNoteOn(d1, d2 / 127);
      break;
    case 0x80: noteOff(d1); break;
    case 0xb0:
      if (d1 === 1) ctl('wheel', d2 / 127);
      else if (d1 === 64) ctl('sustain', d2 >= 64 ? 1 : 0);
      else if (d1 === 120 || d1 === 123) for (const n of Array.from(set)) noteOff(n);
      if (cb.onCC) cb.onCC(d1, d2 / 127, ch);
      break;
    case 0xe0: {
      const v = ((d2 << 7) | d1) - 8192;
      ctl('bend', v >= 0 ? v / 8191 : v / 8192);
      break;
    }
    case 0xd0: ctl('aftertouch', d1 / 127); break;
    case 0xa0: {
      // polyphonic aftertouch → a single aftertouch value: the strongest pressure among held notes
      if (d2 === 0) state.poly.delete(d1); else state.poly.set(d1, d2);
      let m = 0;
      for (const v of state.poly.values()) if (v > m) m = v;
      ctl('aftertouch', m / 127);
      break;
    }
    default: break;
  }
}

/**
 * Web MIDI input (all inputs, omni unless `channel` 0..15 is given). Never rejects: resolves with
 * { inputs: [names] (kept live on hot-plug), supported, error, detach() }.
 * Extras: onCC(cc, value01, channel), onDevicesChange(names).
 */
export async function attachMidi({
  onNoteOn = noop, onNoteOff = noop, onController = noop, onCC = null, onDevicesChange = null, channel = null,
} = {}) {
  const result = { inputs: [], supported: false, error: null, detach: noop };
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || typeof nav.requestMIDIAccess !== 'function') {
    result.error = '此瀏覽器沒有 Web MIDI · Web MIDI is not available in this browser';
    return result;
  }
  let access;
  try {
    access = await nav.requestMIDIAccess({ sysex: false });
  } catch (err) {
    // e.g. the permission prompt was dismissed/blocked: say where to allow it (the raw reason goes to the console)
    console.warn('[aurora] requestMIDIAccess failed', err);
    result.error = '瀏覽器拒絕了 MIDI 存取，可在網址列左側的網站設定中允許 · MIDI access was blocked — allow it in the site settings';
    return result;
  }
  result.supported = true;
  const state = createMidiState();
  const cb = { onNoteOn, onNoteOff, onController, onCC, channel };
  const bound = new Map(); // id → MIDIInput
  const onMsg = (ev) => handleMidiMessage(state, ev.currentTarget ? ev.currentTarget.id : ev.target.id, ev.data, cb);

  function releaseInput(id) {
    releaseMidiInput(state, id, cb);
  }
  function scan() {
    const live = new Set();
    for (const input of access.inputs.values()) {
      if (input.state === 'disconnected') continue;
      live.add(input.id);
      if (!bound.has(input.id)) {
        input.addEventListener('midimessage', onMsg);
        if (typeof input.open === 'function') input.open().catch(noop);
        bound.set(input.id, input);
      }
    }
    for (const [id, input] of bound) {
      if (live.has(id)) continue;
      input.removeEventListener('midimessage', onMsg);
      bound.delete(id);
      releaseInput(id);
    }
    result.inputs.length = 0;
    for (const input of bound.values()) result.inputs.push(input.name || input.manufacturer || 'MIDI Input');
    if (onDevicesChange) onDevicesChange(result.inputs.slice());
  }
  access.addEventListener('statechange', scan);
  scan();
  result.detach = () => {
    access.removeEventListener('statechange', scan);
    for (const [id, input] of bound) { input.removeEventListener('midimessage', onMsg); releaseInput(id); }
    bound.clear();
    result.inputs.length = 0;
  };
  return result;
}
