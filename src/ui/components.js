// AURORA 極光 — UI controls (knob, slider, toggle, select, envelope editor, XY pad).
// Plain DOM + SVG/Canvas, no dependencies. Components never talk to audio directly: they report
// native parameter values through callbacks and accept values through setters.
// Styling lives in css/components.css (class prefix `ac-`), themed by the Aurora tokens.
//
// Knobs/sliders work in normalised space internally (toNorm/fromNorm from the schema) and
// report native values (Hz, s, dB, enum option id, …).

import { PARAM_BY_ID, GROUPS, formatValue, toNorm, fromNorm } from '../dsp/params.js';
import { getLang } from './app/i18n.js';

/* ═══════════════════════════════ shared helpers ═══════════════════════════════ */

const noop = () => {};
let uidN = 0;
const uid = (p) => `${p}-${(++uidN).toString(36)}`;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const RM = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => !!(RM && RM.matches);

function h(tag, cls, attrs, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (text != null) e.textContent = text;
  return e;
}

const PSEUDO = { type: 'float', curve: 'lin', unit: '', min: 0, max: 1, label: '', zh: '' };

/** Accepts a schema entry, a param id, or a pseudo-param object ({min,max,def,unit,…}). */
function resolveParam(p) {
  if (typeof p === 'string') {
    const q = PARAM_BY_ID[p];
    if (!q) throw new Error(`Unknown param: ${p}`);
    return q;
  }
  if (!p || typeof p !== 'object') throw new Error('param (schema entry or id) is required');
  if (p.index !== undefined && PARAM_BY_ID[p.id] === p) return p;
  const q = { ...PSEUDO, ...p };
  if (q.type === 'enum') {
    q.labels = q.labels || q.options;
    q.min = 0;
    q.max = q.options.length - 1;
  }
  if (q.type === 'bool') { q.min = 0; q.max = 1; }
  if (q.def === undefined) q.def = q.type === 'enum' ? q.options[0] : q.type === 'bool' ? false : q.min;
  return q;
}

/** Native value sanitised for the param (enum → option id, bool → boolean, number → clamped). */
function coerce(p, v) {
  if (p.type === 'enum') {
    if (typeof v === 'number') return p.options[clamp(Math.round(v), 0, p.options.length - 1)];
    return p.options.includes(v) ? v : p.def;
  }
  if (p.type === 'bool') return !!v;
  let x = Number(v);
  if (!Number.isFinite(x)) x = p.def;
  x = clamp(x, p.min, p.max);
  return p.type === 'int' ? Math.round(x) : x;
}

/** Numeric encoding (enum index, bool 0/1) — for ARIA. */
function numeric(p, v) {
  if (p.type === 'enum') return p.options.indexOf(v);
  if (p.type === 'bool') return v ? 1 : 0;
  return v;
}

function stepsOf(p) {
  if (p.type === 'enum') return p.options.length - 1;
  if (p.type === 'bool') return 1;
  if (p.type === 'int') return p.max - p.min;
  return 0;
}

/** Move a native value by one keyboard/wheel step. */
function nudge(p, v, dir, fine = false, big = false) {
  if (p.type === 'enum') {
    const i = p.options.indexOf(v);
    return p.options[clamp(i + dir * (big ? Math.max(1, Math.round(p.options.length / 4)) : 1), 0, p.options.length - 1)];
  }
  if (p.type === 'bool') return dir > 0;
  if (p.type === 'int') {
    const st = big ? Math.max(1, Math.round((p.max - p.min) / 8)) : 1;
    return clamp(v + dir * st, p.min, p.max);
  }
  const n = clamp01(toNorm(p, v) + dir * (big ? 0.1 : fine ? 0.001 : 0.01));
  return coerce(p, fromNorm(p, n));
}

function extremes(p) {
  if (p.type === 'enum') return [p.options[0], p.options[p.options.length - 1]];
  if (p.type === 'bool') return [false, true];
  return [p.min, p.max];
}

/** Standard slider keyboard handling. Returns true if handled. */
function sliderKey(e, p, get, set) {
  let dir = 0;
  let big = false;
  switch (e.key) {
    case 'ArrowUp': case 'ArrowRight': dir = 1; break;
    case 'ArrowDown': case 'ArrowLeft': dir = -1; break;
    case 'PageUp': dir = 1; big = true; break;
    case 'PageDown': dir = -1; big = true; break;
    case 'Home': set(extremes(p)[0]); return true;
    case 'End': set(extremes(p)[1]); return true;
    case 'Delete': case 'Backspace': set(p.def); return true;
    default: return false;
  }
  set(nudge(p, get(), dir, e.shiftKey, big));
  return true;
}

const CJK_SPLIT = /^(.*?[⺀-鿿豈-﫿].*?)\s+([A-Za-z][\w .&/+'-]*)$/;

const isEn = () => getLang() === 'en';
/** { zh, en } names → { zh: primary, en: secondary } in the UI language (English first in English mode). */
function ordered(zh, en) {
  zh = zh || ''; en = en || '';
  return isEn() ? { zh: en || zh, en: en ? zh : '' } : { zh, en };
}
/** A schema name (param / group) in the UI language. */
const nameOf = (q) => (q ? (isEn() ? q.label || q.zh || '' : q.zh || q.label || '') : '');

/**
 * Label parts: { zh: primary, en: secondary } from a param or an override. An object override is used as given
 * (callers order it, e.g. i18n pairLabel); a param's own names and a string "亮度 Bright" follow the UI language.
 */
function labelParts(p, override) {
  if (override === false) return null;
  if (override && typeof override === 'object') return { zh: override.zh || '', en: override.en || '' };
  if (typeof override === 'string') {
    const m = CJK_SPLIT.exec(override.trim());
    return m ? ordered(m[1], m[2]) : { zh: override, en: '' };
  }
  return ordered(p && p.zh, p && p.label);
}

function labelEl(parts, cls = '') {
  const d = h('div', `ac-lbl ${cls}`.trim());
  if (parts.zh) d.append(h('span', 'ac-zh', null, parts.zh));
  if (parts.en && parts.en !== parts.zh) d.append(h('span', 'ac-en', null, parts.en));
  return d;
}

const ariaName = (parts) => (parts ? [parts.zh, parts.en].filter(Boolean).join(' ') : '');

/**
 * Accessible name for a control drawn without a visible label (label:false): the param's own zh/EN names,
 * with its module for generic ones ("振盪器 1 音量 Osc 1 Level", "FM 合成 開關 FM on") — never the raw id.
 */
export function fallbackName(p) {
  if (!p) return '';
  const g = p.group && p.group !== 'global' && p.group !== 'macro' ? GROUPS[p.group] : null;
  if (g && /\.on$/.test(p.id || '')) return `${g.zh} 開關 ${g.label} on`;
  const zh = p.zh || '', en = p.label || '';
  const pre = (s, x) => (g && x && s && !s.includes(x) ? `${x} ` : '');
  return [zh && pre(zh, g && g.zh) + zh, en && pre(en, g && g.label) + en].filter(Boolean).join(' ');
}

function flash(root, ms = 900, cls = 'is-bubble') {
  root.classList.add(cls);
  clearTimeout(root._acFlash);
  root._acFlash = setTimeout(() => root.classList.remove(cls), ms);
}

/** Double-click / double-tap detector for pointerdown streams (works for touch too). */
function tapDetector(ms = 330, dist = 10) {
  let t = -1e9, x = 0, y = 0;
  return (e) => {
    const now = performance.now();
    const hit = now - t < ms && Math.abs(e.clientX - x) < dist && Math.abs(e.clientY - y) < dist;
    if (hit) t = -1e9;
    else { t = now; x = e.clientX; y = e.clientY; }
    return hit;
  };
}

/** Pointer capture + move/end plumbing for one pointer. */
function trackPointer(target, e, move, end) {
  const id = e.pointerId;
  try { target.setPointerCapture(id); } catch { /* synthetic events */ }
  let done = false;
  const onMove = (ev) => { if (ev.pointerId === id && !done) move(ev); };
  const onEnd = (ev) => {
    if (ev.pointerId !== id || done) return;
    done = true;
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onEnd);
    target.removeEventListener('pointercancel', onEnd);
    target.removeEventListener('lostpointercapture', onEnd);
    try { if (target.hasPointerCapture(id)) target.releasePointerCapture(id); } catch { /* ignore */ }
    if (end) end(ev);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onEnd);
  target.addEventListener('pointercancel', onEnd);
  target.addEventListener('lostpointercapture', onEnd);
}

const isPrimary = (e) => !(e.pointerType === 'mouse' && e.button !== 0);

/* ── one shared requestAnimationFrame loop for every animating component ── */
const anims = new Set();
let rafId = 0;
let rafLast = 0;
function animate(fn) {
  anims.add(fn);
  if (!rafId) rafId = requestAnimationFrame(tick);
}
function tick(t) {
  rafId = 0;
  const dt = rafLast ? Math.min(64, Math.max(1, t - rafLast)) : 16;
  rafLast = t;
  const list = Array.from(anims);
  anims.clear();
  for (const f of list) {
    let keep = false;
    try { keep = f(dt, t); } catch (err) { console.error(err); }
    if (keep) anims.add(f);
  }
  if (anims.size) rafId = requestAnimationFrame(tick);
  else rafLast = 0;
}
/** Exponential approach factor for time constant tau (ms). */
const approach = (dt, tau) => (reducedMotion() ? 1 : 1 - Math.exp(-dt / tau));

/* ── colours for canvas drawing (resolved from CSS custom properties) ── */
let colorCtx = null;
function cssToRgb(str, fallback) {
  if (!colorCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    colorCtx = c.getContext('2d', { willReadFrequently: true });
  }
  const ctx = colorCtx;
  ctx.fillStyle = '#010203';
  ctx.fillStyle = str || '';
  if (ctx.fillStyle === '#010203' && !/^#010203$/i.test(str || '')) return fallback;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return d[3] ? [d[0], d[1], d[2]] : fallback;
}
function resolveColor(host, expr, fallback) {
  if (!host.isConnected) return fallback;
  const probe = h('span');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  probe.style.color = expr;
  host.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return cssToRgb(c, fallback);
}
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE = [255, 255, 255];

function fitCanvas(canvas, w, hgt) {
  const dpr = Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(hgt * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  return dpr;
}

/* ═══════════════════════════════════ Knob ═══════════════════════════════════ */

const A0 = -135;
const A1 = 135;
const R_TRACK = 38.5;
const R_MOD = 47;
const R_CAP = 28.5;
const normToDeg = (n) => A0 + (A1 - A0) * n;

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
}
/** SVG arc path along radius r between two angles (degrees clockwise from 12 o'clock). */
function arcPath(r, d0, d1) {
  if (d1 < d0) { const t = d0; d0 = d1; d1 = t; }
  if (d1 - d0 < 0.05) return '';
  const [x0, y0] = polar(r, d0);
  const [x1, y1] = polar(r, d1);
  const large = d1 - d0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const TRACK_D = arcPath(R_TRACK, A0, A1);

/**
 * Rotary knob.
 * @returns {{ el, setValue(v), setModulation(normLo, normHi, color?), setAccent(c), getValue(), destroy() }}
 */
export function createKnob({
  param, value, onChange = noop, size = 'md', accent, label, showValue = true, bipolar,
} = {}) {
  const p = resolveParam(param);
  let val = coerce(p, value === undefined ? p.def : value);
  const nSteps = stepsOf(p);
  const numericType = p.type === 'float' || p.type === 'int';
  const isBi = bipolar ?? (numericType && p.min < 0 && p.max > 0 && Math.abs(p.min + p.max) < 1e-9);
  const origin = isBi ? (numericType && p.min < 0 && p.max > 0 ? toNorm(p, 0) : 0.5) : 0;
  const parts = labelParts(p, label);

  const root = h('div', `ac-knob ac-knob--${size}`);
  if (p.id) root.dataset.param = p.id;
  if (isBi) root.classList.add('is-bipolar');
  const setAccent = (c) => {
    root.classList.toggle('is-aurora', c === 'aurora');
    if (c && c !== 'aurora') root.style.setProperty('--k-accent', c);
    else root.style.removeProperty('--k-accent');
  };
  setAccent(accent);

  const dial = h('div', 'ac-knob__dial', {
    role: 'slider', tabindex: 0, 'aria-label': ariaName(parts) || fallbackName(p) || p.id,
    'aria-valuemin': numeric(p, extremes(p)[0]), 'aria-valuemax': numeric(p, extremes(p)[1]),
  });
  const g = uid('ackg'), c = uid('ackc'), r = uid('ackr'), f = uid('ackf');
  let ticks = '';
  // stepped params: one dot per step. Large continuous knobs: a fine decorative scale (every 5th major)
  // whose dots light up to the current value.
  const deco = nSteps === 0 && (size === 'lg' || size === 'xl');
  const nT = nSteps > 0 && nSteps <= 16 ? nSteps : deco ? 20 : 0;
  for (let i = 0; nT && i <= nT; i++) {
    const [x, y] = polar(R_MOD, normToDeg(i / nT));
    const r = deco ? (i % 5 === 0 ? 1.3 : 0.75) : 1.5;
    ticks += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r}"${deco && i % 5 === 0 ? ' class="is-major"' : ''}/>`;
  }
  const [ox, oy] = polar(R_MOD, normToDeg(origin));
  dial.innerHTML = `<span class="ac-knob__aura"></span>
<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
<defs>
<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="8" y1="0" x2="92" y2="0"><stop offset="0" class="ac-knob__s0"/><stop offset=".5" class="ac-knob__s1"/><stop offset="1" class="ac-knob__s2"/></linearGradient>
<radialGradient id="${c}" cx="38%" cy="30%" r="78%"><stop offset="0" class="ac-knob__c0"/><stop offset=".55" class="ac-knob__c1"/><stop offset="1" class="ac-knob__c2"/></radialGradient>
<linearGradient id="${r}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="${f}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter>
</defs>
<circle class="ac-knob__well" cx="50" cy="50" r="45.5"/>
<g class="ac-knob__ticks">${ticks}</g>
<path class="ac-knob__track" d="${TRACK_D}"/>
${isBi ? `<circle class="ac-knob__origin" cx="${ox.toFixed(2)}" cy="${oy.toFixed(2)}" r="1.9"/>` : ''}
<path class="ac-knob__mod" d=""/>
<path class="ac-knob__halo" d="" filter="url(#${f})"/>
<path class="ac-knob__arc" d="" stroke="url(#${g})"/>
<circle class="ac-knob__shadow" cx="50" cy="54" r="${R_CAP}" filter="url(#${f})"/>
<circle class="ac-knob__cap" cx="50" cy="50" r="${R_CAP}" fill="url(#${c})"/>
<circle class="ac-knob__rim" cx="50" cy="50" r="${R_CAP - 0.7}" stroke="url(#${r})"/>
<circle class="ac-knob__gloss" cx="50" cy="50" r="${R_CAP - 1}"/>
<g class="ac-knob__ptr"><line x1="50" y1="${50 - R_CAP + 5}" x2="50" y2="${50 - R_CAP + 13.5}"/></g>
</svg>`;
  const aura = dial.querySelector('.ac-knob__aura');
  const tickEls = nT ? Array.from(dial.querySelectorAll('.ac-knob__ticks circle')) : [];
  let litLo = -1, litHi = -1;
  if (nT) root.classList.add(deco ? 'has-scale' : 'has-steps');
  const arc = dial.querySelector('.ac-knob__arc');
  const halo = dial.querySelector('.ac-knob__halo');
  const mod = dial.querySelector('.ac-knob__mod');
  const ptr = dial.querySelector('.ac-knob__ptr');

  const bubble = h('div', 'ac-knob__bubble', { 'aria-hidden': 'true' });
  const valEl = h('div', 'ac-knob__value', { 'aria-hidden': 'true' });
  root.append(bubble, dial);
  if (parts) root.append(labelEl(parts, 'ac-knob__label'));
  if (showValue) root.append(valEl);

  // ── state & rendering ──
  const displayNorm = () => toNorm(p, val);
  let shown = displayNorm();
  let target = shown;
  let dragging = false;
  let dragNorm = 0;
  let lastY = 0;
  let wheelAcc = 0;

  function render(n) {
    const deg = normToDeg(n);
    const d = isBi ? arcPath(R_TRACK, normToDeg(origin), deg) : arcPath(R_TRACK, A0, deg);
    arc.setAttribute('d', d);
    halo.setAttribute('d', d);
    ptr.setAttribute('transform', `rotate(${deg.toFixed(2)} 50 50)`);
    aura.style.opacity = (isBi ? Math.abs(n - origin) * 2 : n).toFixed(3);
    if (tickEls.length) {
      // light the scale dots between the origin and the value (only touch the DOM when that changes)
      const a = Math.min(origin, n), b = Math.max(origin, n);
      const lo = Math.ceil(a * nT - 1e-6), hi = Math.floor(b * nT + 1e-6);
      if (lo !== litLo || hi !== litHi) {
        litLo = lo; litHi = hi;
        for (let i = 0; i < tickEls.length; i++) tickEls[i].classList.toggle('is-lit', i >= lo && i <= hi && b - a > 1e-4);
      }
    }
  }
  function text() {
    const s = formatValue(p, val);
    valEl.textContent = s;
    bubble.textContent = s;
    dial.setAttribute('aria-valuenow', numeric(p, val));
    dial.setAttribute('aria-valuetext', s);
  }
  const step = (dt) => {
    shown += (target - shown) * approach(dt, 55);
    if (Math.abs(target - shown) < 0.0006) shown = target;
    render(shown);
    return shown !== target;
  };
  function show(n, instant) {
    target = n;
    if (instant) { shown = n; render(n); } else animate(step);
  }
  /** User edit: update, notify, render. */
  function commit(v, n) {
    v = coerce(p, v);
    const changed = v !== val;
    val = v;
    text();
    show(n !== undefined && nSteps === 0 ? n : displayNorm(), dragging);
    if (changed) onChange(val);
  }

  // ── pointer: vertical drag (shift = fine), double-click/tap → default ──
  const dbl = tapDetector();
  dial.addEventListener('pointerdown', (e) => {
    if (!isPrimary(e)) return;
    e.preventDefault();
    dial.focus({ preventScroll: true });
    if (dbl(e)) { commit(p.def); flash(root, 700); return; }
    dragging = true;
    dragNorm = toNorm(p, val);
    lastY = e.clientY;
    root.classList.add('is-dragging');
    trackPointer(dial, e, (ev) => {
      const dy = lastY - ev.clientY;
      lastY = ev.clientY;
      if (!dy) return;
      const range = nSteps > 0 ? Math.max(160, Math.min(320, nSteps * 18)) : 220;
      dragNorm = clamp01(dragNorm + (dy / range) * (ev.shiftKey ? 0.1 : 1));
      commit(fromNorm(p, dragNorm), dragNorm);
    }, () => {
      dragging = false;
      root.classList.remove('is-dragging');
    });
  });

  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX;
    if (e.deltaMode === 1) d *= 33;
    else if (e.deltaMode === 2) d *= 400;
    if (nSteps > 0) {
      wheelAcc += d;
      if (Math.abs(wheelAcc) < 40 && Math.abs(d) < 40) return;
      const dir = Math.sign(wheelAcc || d);
      wheelAcc = 0;
      commit(nudge(p, val, dir));
    } else {
      const n = clamp01(toNorm(p, val) + clamp(d, -120, 120) * (e.shiftKey ? 0.00003 : 0.00025));
      commit(fromNorm(p, n), n);
    }
    flash(root);
  }, { passive: false });

  dial.addEventListener('keydown', (e) => {
    if (sliderKey(e, p, () => val, (v) => commit(v))) {
      e.preventDefault();
      flash(root);
    }
  });

  text();
  render(shown);

  return {
    el: root,
    setValue(v) {
      if (dragging) return;
      val = coerce(p, v);
      text();
      show(displayNorm(), false);
    },
    getValue: () => val,
    setModulation(lo, hi, color) {
      if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi)) {
        mod.setAttribute('d', '');
        root.classList.remove('has-mod');
        return;
      }
      let a = clamp01(Math.min(lo, hi));
      let b = clamp01(Math.max(lo, hi));
      if (b - a < 0.006) { const m = (a + b) / 2; a = m - 0.003; b = m + 0.003; }
      mod.setAttribute('d', arcPath(R_MOD, normToDeg(a), normToDeg(b)));
      if (color) root.style.setProperty('--k-mod', color);
      root.classList.add('has-mod');
    },
    setAccent,
    destroy() { anims.delete(step); root.remove(); },
  };
}

/* ═══════════════════════════════════ Slider ═══════════════════════════════════ */

/**
 * Linear slider. Extra options: label, showValue, bipolar, spring (return to default on release — e.g. pitch bend).
 * @returns {{ el, setValue(v), getValue(), setAccent(c), destroy() }}
 */
export function createSlider({
  param, value, onChange = noop, orientation = 'h', accent, label, showValue = true, bipolar, spring = false,
} = {}) {
  const p = resolveParam(param);
  const vert = orientation === 'v';
  let val = coerce(p, value === undefined ? p.def : value);
  const nSteps = stepsOf(p);
  const numericType = p.type === 'float' || p.type === 'int';
  const isBi = bipolar ?? (numericType && p.min < 0 && p.max > 0 && Math.abs(p.min + p.max) < 1e-9);
  const origin = isBi ? (numericType && p.min < 0 && p.max > 0 ? toNorm(p, 0) : 0.5) : 0;
  const parts = labelParts(p, label);

  const root = h('div', `ac-slider ac-slider--${vert ? 'v' : 'h'}`);
  if (p.id) root.dataset.param = p.id;
  const setAccent = (c) => {
    root.classList.toggle('is-aurora', c === 'aurora');
    if (c && c !== 'aurora') root.style.setProperty('--k-accent', c);
    else root.style.removeProperty('--k-accent');
  };
  setAccent(accent);
  if (isBi) root.classList.add('is-bipolar');

  const head = h('div', 'ac-slider__head');
  if (parts) head.append(labelEl(parts, 'ac-slider__label'));
  const valEl = h('span', 'ac-slider__value', { 'aria-hidden': 'true' });
  if (showValue) head.append(valEl);
  const track = h('div', 'ac-slider__track', {
    role: 'slider', tabindex: 0, 'aria-orientation': vert ? 'vertical' : 'horizontal',
    'aria-label': ariaName(parts) || fallbackName(p) || p.id,
    'aria-valuemin': numeric(p, extremes(p)[0]), 'aria-valuemax': numeric(p, extremes(p)[1]),
  });
  const rail = h('div', 'ac-slider__rail');
  const fill = h('div', 'ac-slider__fill');
  const thumb = h('div', 'ac-slider__thumb');
  const bubble = h('div', 'ac-slider__bubble', { 'aria-hidden': 'true' });
  thumb.append(bubble);
  if (isBi) {
    const o = h('div', 'ac-slider__origin');
    o.style.setProperty('--o', origin);
    rail.append(o);
  }
  rail.append(fill, thumb);
  track.append(rail);
  if (vert) root.append(track, head);
  else root.append(head, track);

  let dragging = false;
  function render(n) {
    root.style.setProperty('--pos', n.toFixed(4));
    root.style.setProperty('--from', Math.min(origin, n).toFixed(4));
    root.style.setProperty('--to', Math.max(origin, n).toFixed(4));
  }
  function text() {
    const s = formatValue(p, val);
    valEl.textContent = s;
    bubble.textContent = s;
    track.setAttribute('aria-valuenow', numeric(p, val));
    track.setAttribute('aria-valuetext', s);
  }
  function commit(v, n) {
    v = coerce(p, v);
    const changed = v !== val;
    val = v;
    text();
    render(n !== undefined && nSteps === 0 ? n : toNorm(p, val));
    if (changed) onChange(val);
  }

  const dbl = tapDetector();
  const posOf = (ev, rect) => (vert ? 1 - (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width);
  track.addEventListener('pointerdown', (e) => {
    if (!isPrimary(e)) return;
    e.preventDefault();
    track.focus({ preventScroll: true });
    if (dbl(e)) { commit(p.def); flash(root, 700); return; }
    const rect = rail.getBoundingClientRect();
    dragging = true;
    root.classList.add('is-dragging');
    let n = toNorm(p, val);
    let last = vert ? e.clientY : e.clientX;
    const onThumb = e.target === thumb || thumb.contains(e.target);
    if (!e.shiftKey && !onThumb) { n = clamp01(posOf(e, rect)); commit(fromNorm(p, n), n); }
    trackPointer(track, e, (ev) => {
      const cur = vert ? ev.clientY : ev.clientX;
      if (ev.shiftKey || onThumb) {
        const span = vert ? rect.height : rect.width;
        const d = ((vert ? last - cur : cur - last) / Math.max(20, span)) * (ev.shiftKey ? 0.1 : 1);
        n = clamp01(n + d);
      } else {
        n = clamp01(posOf(ev, rect));
      }
      last = cur;
      commit(fromNorm(p, n), n);
    }, () => {
      dragging = false;
      root.classList.remove('is-dragging');
      if (spring) commit(p.def);
    });
  });
  track.addEventListener('wheel', (e) => {
    e.preventDefault();
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX;
    if (e.deltaMode === 1) d *= 33;
    if (nSteps > 0) { if (Math.abs(d) >= 1) commit(nudge(p, val, Math.sign(d))); } else {
      const n = clamp01(toNorm(p, val) + clamp(d, -120, 120) * (e.shiftKey ? 0.00003 : 0.00025));
      commit(fromNorm(p, n), n);
    }
    flash(root);
  }, { passive: false });
  track.addEventListener('keydown', (e) => {
    if (sliderKey(e, p, () => val, (v) => commit(v))) { e.preventDefault(); flash(root); }
  });
  if (spring) track.addEventListener('keyup', () => commit(p.def));

  text();
  render(toNorm(p, val));
  return {
    el: root,
    setValue(v) { if (dragging) return; val = coerce(p, v); text(); render(toNorm(p, val)); },
    getValue: () => val,
    setAccent,
    destroy() { root.remove(); },
  };
}

/* ═══════════════════════════════════ Toggle ═══════════════════════════════════ */

/**
 * Pill switch with glow. `label` may be a string ("濾波器 Filter" is split), {zh,en}, or omitted.
 * Extra: `param` (bool schema entry/id) supplies label + default; size 'sm'|'md'.
 * @returns {{ el, setValue(v), getValue(), setAccent(c) }}
 */
export function createToggle({ label, value, onChange = noop, accent, param, size = 'md' } = {}) {
  const p = param ? resolveParam(param) : null;
  let val = !!(value === undefined ? p && p.def : value);
  const parts = labelParts(p, label === undefined && !p ? false : label);
  if (parts && label === undefined && p && p.label === 'On' && GROUPS[p.group]) parts.en = GROUPS[p.group].label;
  const btn = h('button', `ac-toggle ac-toggle--${size}`, { type: 'button', role: 'switch' });
  if (p && p.id) btn.dataset.param = p.id;
  const setAccent = (c) => {
    btn.classList.toggle('is-aurora', c === 'aurora');
    if (c && c !== 'aurora') btn.style.setProperty('--k-accent', c);
    else btn.style.removeProperty('--k-accent');
  };
  setAccent(accent);
  btn.append(h('span', 'ac-toggle__track', { 'aria-hidden': 'true' }));
  btn.firstChild.append(h('span', 'ac-toggle__thumb'));
  if (parts && (parts.zh || parts.en)) btn.append(labelEl(parts, 'ac-toggle__label'));
  btn.setAttribute('aria-label', ariaName(parts) || fallbackName(p) || (p && p.id) || 'toggle');
  const render = () => {
    btn.setAttribute('aria-checked', String(val));
    btn.classList.toggle('is-on', val);
  };
  btn.addEventListener('click', () => { val = !val; render(); onChange(val); });
  render();
  return {
    el: btn,
    setValue(v) { val = !!v; render(); },
    getValue: () => val,
    setAccent,
    destroy() { btn.remove(); },
  };
}

/* ═══════════════════════════════════ Select ═══════════════════════════════════ */

function optionList(p) {
  if (p.type === 'enum') {
    return p.options.map((id, i) => {
      const lab = p.labels[i];
      if (id === 'none' && lab === 'none') return { value: id, label: '—', sub: 'None' };
      const q = lab === id ? PARAM_BY_ID[id] : null;
      if (q) { // a param as an option (mod-matrix destinations): names in the UI language, the other one as sub
        const g = GROUPS[q.group];
        const nm = ordered(q.zh, q.label);
        const gn = g ? ordered(g.zh, g.label) : null;
        return {
          value: id, label: nm.zh, sub: nm.en,
          group: gn ? `${gn.zh}${gn.en && gn.en !== gn.zh ? ` · ${gn.en}` : ''}` : q.group,
          short: gn ? `${gn.zh} · ${nm.zh}` : nm.zh,
        };
      }
      return { value: id, label: lab };
    });
  }
  if (p.type === 'int') {
    const out = [];
    for (let v = p.min; v <= p.max; v++) out.push({ value: v, label: formatValue(p, v) });
    return out;
  }
  if (p.type === 'bool') return [{ value: false, label: 'Off' }, { value: true, label: 'On' }];
  throw new Error(`createSelect: unsupported param type ${p.type}`);
}

/**
 * Segmented control (≤ 4 options) or a styled, keyboard-accessible dropdown (more).
 * Extras: label (false hides), accent, variant 'auto'|'segmented'|'dropdown'.
 * @returns {{ el, setValue(v), getValue(), close() }}
 */
export function createSelect({ param, value, onChange = noop, label, accent, variant = 'auto' } = {}) {
  const p = resolveParam(param);
  const opts = optionList(p);
  const indexOf = (v) => {
    if (p.type === 'enum' && typeof v === 'number') return clamp(Math.round(v), 0, opts.length - 1);
    const i = opts.findIndex((o) => o.value === v);
    return i < 0 ? Math.max(0, opts.findIndex((o) => o.value === p.def)) : i;
  };
  let cur = indexOf(value === undefined ? p.def : value);
  const parts = labelParts(p, label);
  const seg = variant === 'segmented' || (variant !== 'dropdown' && opts.length <= 4);

  const root = h('div', `ac-select ${seg ? 'ac-seg' : 'ac-dd'}`);
  if (p.id) root.dataset.param = p.id;
  if (accent) root.style.setProperty('--k-accent', accent);
  const name = ariaName(parts) || fallbackName(p) || p.id;
  if (parts) root.append(labelEl(parts, 'ac-select__label'));

  if (seg) {
    const track = h('div', 'ac-seg__track', { role: 'radiogroup', 'aria-label': name });
    track.style.setProperty('--n', opts.length);
    const ind = h('span', 'ac-seg__ind', { 'aria-hidden': 'true' });
    track.append(ind);
    const btns = opts.map((o, i) => {
      const b = h('button', 'ac-seg__opt', { type: 'button', role: 'radio', title: o.sub || o.label }, o.label);
      b.addEventListener('click', () => pick(i, true));
      track.append(b);
      return b;
    });
    track.addEventListener('keydown', (e) => {
      let d = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') d = 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') d = -1;
      else if (e.key === 'Home') d = -cur;
      else if (e.key === 'End') d = opts.length - 1 - cur;
      else return;
      e.preventDefault();
      pick(clamp(cur + d, 0, opts.length - 1), true);
      btns[cur].focus();
    });
    root.append(track);
    const render = () => {
      track.style.setProperty('--i', cur);
      btns.forEach((b, i) => {
        const on = i === cur;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        b.classList.toggle('is-on', on);
      });
    };
    const pick = (i, user) => {
      if (i === cur) return;
      cur = i;
      render();
      if (user) onChange(opts[cur].value);
    };
    render();
    return {
      el: root,
      setValue(v) { cur = indexOf(v); render(); },
      getValue: () => opts[cur].value,
      close: noop,
      destroy() { root.remove(); },
    };
  }

  // ── dropdown ──
  const listId = uid('acdd');
  const btn = h('button', 'ac-dd__btn', {
    type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': name,
  });
  const btnText = h('span', 'ac-dd__text');
  const chev = h('span', 'ac-dd__chev', { 'aria-hidden': 'true' });
  chev.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
  btn.append(btnText, chev);
  root.append(btn);

  let pop = null;
  let active = cur;
  let optEls = [];
  let typed = '';
  let typedT = 0;
  const renderBtn = () => {
    const o = opts[cur];
    btnText.textContent = o.short || o.label;
    btnText.title = o.sub ? `${o.short || o.label} (${o.sub})` : o.label;
  };
  const setActive = (i, scroll = true) => {
    if (!pop) return;
    i = clamp(i, 0, opts.length - 1);
    if (optEls[active]) optEls[active].classList.remove('is-active');
    active = i;
    const a = optEls[active];
    a.classList.add('is-active');
    pop.setAttribute('aria-activedescendant', a.id);
    if (scroll) a.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    const changed = i !== cur;
    cur = i;
    renderBtn();
    close(true);
    if (changed) onChange(opts[cur].value);
  };
  function place() {
    const rc = btn.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const below = vh - rc.bottom - 10, above = rc.top - 10;
    const want = Math.min(360, pop.scrollHeight + 2);
    const up = below < Math.min(want, 200) && above > below;
    const maxH = Math.max(120, Math.min(360, up ? above : below));
    pop.style.maxHeight = `${maxH}px`;
    pop.style.minWidth = `${Math.max(rc.width, 140)}px`;
    const w = pop.offsetWidth;
    pop.style.left = `${clamp(rc.left, 8, Math.max(8, vw - w - 8))}px`;
    if (up) { pop.style.top = ''; pop.style.bottom = `${vh - rc.top + 6}px`; pop.classList.add('is-up'); } else { pop.style.bottom = ''; pop.style.top = `${rc.bottom + 6}px`; pop.classList.remove('is-up'); }
  }
  const onDocDown = (e) => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(false); };
  let scrollRaf = 0;
  const onScroll = (e) => {
    if (!pop || (e.target instanceof Node && pop.contains(e.target)) || scrollRaf) return;
    // follow the button while the page scrolls; close once it leaves the viewport
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!pop) return;
      const rc = btn.getBoundingClientRect();
      if (rc.bottom < 0 || rc.top > innerHeight) close(false); else place();
    });
  };
  const onResize = () => onScroll({ target: null });
  const onBlur = () => close(false);
  function open() {
    if (pop) return;
    pop = h('div', 'ac-dd__pop', { role: 'listbox', id: listId, tabindex: '-1', 'aria-label': name });
    const ac = getComputedStyle(root).getPropertyValue('--k-accent').trim();
    if (ac) pop.style.setProperty('--k-accent', ac);
    optEls = [];
    let lastGroup = null;
    opts.forEach((o, i) => {
      if (o.group && o.group !== lastGroup) {
        lastGroup = o.group;
        pop.append(h('div', 'ac-dd__group', { role: 'presentation' }, o.group));
      }
      const oe = h('div', 'ac-dd__opt', { role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === cur) });
      oe.append(h('span', 'ac-dd__check', { 'aria-hidden': 'true' }), h('span', 'ac-dd__olabel', null, o.label));
      if (o.sub && o.sub !== o.label) oe.append(h('span', 'ac-dd__osub', null, o.sub));
      if (i === cur) oe.classList.add('is-selected');
      oe.addEventListener('pointermove', () => { if (active !== i) setActive(i, false); });
      oe.addEventListener('click', () => choose(i));
      optEls.push(oe);
      pop.append(oe);
    });
    pop.addEventListener('keydown', onPopKey);
    document.body.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', listId);
    root.classList.add('is-open');
    place();
    active = cur;
    setActive(cur, false);
    optEls[cur].scrollIntoView({ block: 'center' });
    pop.focus({ preventScroll: true });
    requestAnimationFrame(() => pop && pop.classList.add('is-shown'));
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('scroll', onScroll, true);
    addEventListener('resize', onResize);
    addEventListener('blur', onBlur);
  }
  function close(refocus) {
    if (!pop) return;
    const el = pop;
    pop = null;
    optEls = [];
    el.classList.remove('is-shown');
    el.removeEventListener('keydown', onPopKey);
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 140);
    btn.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onResize);
    removeEventListener('blur', onBlur);
    if (refocus) btn.focus({ preventScroll: true });
  }
  function onPopKey(e) {
    switch (e.key) {
      case 'ArrowDown': setActive(active + 1); break;
      case 'ArrowUp': setActive(active - 1); break;
      case 'PageDown': setActive(active + 8); break;
      case 'PageUp': setActive(active - 8); break;
      case 'Home': setActive(0); break;
      case 'End': setActive(opts.length - 1); break;
      case 'Enter': case ' ': choose(active); break;
      case 'Escape': close(true); break;
      case 'Tab': close(true); break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const now = performance.now();
        typed = now - typedT > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
        typedT = now;
        const hay = (o) => `${o.label} ${o.sub || ''} ${o.short || ''}`.toLowerCase();
        let i = opts.findIndex((o, j) => j >= (typed.length === 1 ? active + 1 : active) && o.label.toLowerCase().startsWith(typed));
        if (i < 0) i = opts.findIndex((o) => o.label.toLowerCase().startsWith(typed));
        if (i < 0) i = opts.findIndex((o) => hay(o).includes(typed));
        if (i >= 0) setActive(i);
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }
  btn.addEventListener('click', () => (pop ? close(true) : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  renderBtn();
  return {
    el: root,
    setValue(v) {
      cur = indexOf(v);
      renderBtn();
      if (pop) optEls.forEach((o, i) => { o.classList.toggle('is-selected', i === cur); o.setAttribute('aria-selected', String(i === cur)); });
    },
    getValue: () => opts[cur].value,
    close: () => close(false),
    destroy() { close(false); root.remove(); },
  };
}

/* ═══════════════════════════════ Envelope editor ═══════════════════════════════ */

// Mirrors src/dsp/env.js attackK/decayK: segment shape y(p) = (1 − e^(−k·p)) / (1 − e^(−k)).
const lerp = (a, b, t) => a + (b - a) * t;
export function envAttackK(curve) {
  return curve < 0.5 ? lerp(5.5, 1.4, curve * 2) : lerp(1.4, -4.5, (curve - 0.5) * 2);
}
export function envDecayK(curve) {
  return curve < 0.5 ? lerp(12, 6, curve * 2) : lerp(6, -1.5, (curve - 0.5) * 2);
}
/** Normalised segment shape 0..1 → 0..1 (rising). */
export function envShape(x, k) {
  if (k > -1e-3 && k < 1e-3) return x;
  return (1 - Math.exp(-k * x)) / (1 - Math.exp(-k));
}
/** Inverse of envShape. */
export function envShapeInv(y, k) {
  if (k > -1e-3 && k < 1e-3) return y;
  const v = 1 - y * (1 - Math.exp(-k));
  return v <= 0 ? 1 : clamp01(-Math.log(v) / k);
}

const ENV_KEYS = ['a', 'd', 's', 'r', 'curve'];
function resolveEnvRanges(ranges, prefix) {
  const out = {};
  if (typeof ranges === 'string') prefix = ranges;
  if (ranges && typeof ranges === 'object') {
    const list = Array.isArray(ranges) ? ranges : Object.values(ranges);
    if (!Array.isArray(ranges)) for (const k of ENV_KEYS) if (ranges[k]) out[k] = resolveParam(ranges[k]);
    for (const q of list) {
      if (!q) continue;
      const rp = resolveParam(q);
      const k = String(rp.id || '').split('.').pop();
      if (ENV_KEYS.includes(k) && !out[k]) out[k] = rp;
    }
  }
  const pre = prefix || 'aenv';
  for (const k of ENV_KEYS) if (!out[k]) out[k] = PARAM_BY_ID[`${pre}.${k}`];
  return out;
}

const ENV_STAGES = { attack: 1, decay: 2, sustain: 3, release: 4, 1: 1, 2: 2, 3: 3, 4: 4 };
const ENV_SAMPLES = 40;

/**
 * ADSR editor with draggable A / D(+S) / S / R nodes and curve handles.
 * @param {{values:{a,d,s,r,curve}, ranges?: object|array|string, onChange(partialNative), accent?, prefix?}} opts
 * @returns {{ el, setValues(v), setPlayhead(level, stage), setAccent(c), destroy() }}
 */
export function createEnvelopeEditor({ values = {}, ranges, onChange = noop, accent, prefix } = {}) {
  const P = resolveEnvRanges(ranges, prefix);
  const val = {};
  for (const k of ENV_KEYS) val[k] = coerce(P[k], values[k] === undefined ? P[k].def : values[k]);
  const normOf = (k, v) => toNorm(P[k], v);
  // displayed normalised values (animated toward target)
  const disp = {};
  const tgt = {};
  for (const k of ENV_KEYS) disp[k] = tgt[k] = normOf(k, val[k]);
  disp.z = tgt.z = 1;
  let sized = false;

  const root = h('div', 'ac-env');
  if (accent) root.style.setProperty('--e-accent', accent);
  const canvas = h('canvas', 'ac-env__canvas', { 'aria-hidden': 'true' });
  const bubble = h('div', 'ac-env__bubble', { 'aria-hidden': 'true' });
  root.append(canvas, bubble);
  const ctx = canvas.getContext('2d');

  // accessible hidden sliders (Tab through A, D, S, R, Curve)
  const sr = {};
  for (const k of ENV_KEYS) {
    const q = P[k];
    const s = h('div', 'ac-sr-only ac-env__sr', {
      role: 'slider', tabindex: 0, 'aria-label': ariaName(ordered(q.zh, q.label)),
      'aria-valuemin': q.min, 'aria-valuemax': q.max,
    });
    s.addEventListener('focus', () => { focusKey = k; showBubbleFor(nodeForKey(k)); kick(); });
    s.addEventListener('blur', () => { if (focusKey === k) { focusKey = null; if (!drag) hideBubble(); kick(); } });
    s.addEventListener('keydown', (e) => {
      if (sliderKey(e, q, () => val[k], (v) => edit({ [k]: v }, true))) { e.preventDefault(); showBubbleFor(nodeForKey(k)); }
    });
    sr[k] = s;
    root.append(s);
  }
  const updateAria = () => {
    for (const k of ENV_KEYS) {
      sr[k].setAttribute('aria-valuenow', val[k]);
      sr[k].setAttribute('aria-valuetext', formatValue(P[k], val[k]));
    }
  };

  let W = 0, H = 0, dpr = 1;
  let col = { acc: [255, 196, 107], line: [140, 160, 220], text: [142, 151, 184], bg: [12, 15, 24] };
  let colorsOk = false;
  let hot = null; // hovered node id
  let drag = null; // { id, sx, sy, start:{...} }
  let focusKey = null;
  const ph = { on: false, level: 0, stage: 0, x: 0, y: 0, alpha: 0, susT: 0, lastStage: 0 };

  function resolveColors() {
    if (!root.isConnected) return;
    col = {
      acc: resolveColor(root, 'var(--e-accent, var(--a-amber, #ffc46b))', [255, 196, 107]),
      line: resolveColor(root, 'var(--line-rgb, rgb(140,160,220))', [140, 160, 220]),
      text: resolveColor(root, 'var(--text-dim, #8e97b8)', [142, 151, 184]),
      bg: resolveColor(root, 'var(--bg-1, #0c0f18)', [12, 15, 24]),
    };
    colorsOk = true;
  }

  // Horizontal layout: each segment's width follows its knob position (normalised value), so a node
  // tracks the pointer exactly like the knob would. The whole envelope is then zoomed to fill the
  // width (zoom frozen while dragging, eased afterwards).
  const PAD_L = 12, PAD_R = 12, PAD_T = 16, PAD_B = 24;
  function widths(n, PW) {
    const minW = Math.min(7, PW * 0.02);
    const mA = PW * 0.25, mD = PW * 0.25, hold = PW * 0.14, mR = PW * 0.31;
    return {
      minW, mA, mD, mR, hold,
      wA: minW + (mA - minW) * n.a, wD: minW + (mD - minW) * n.d, wR: minW + (mR - minW) * n.r,
    };
  }
  function fitZoom(n) {
    const PW = Math.max(40, W - PAD_L - PAD_R);
    const b = widths(n, PW);
    return clamp((PW * 0.94) / (b.wA + b.wD + b.hold + b.wR), 1, 2.4);
  }
  function geom() {
    const L = PAD_L, R = W - PAD_R, T = PAD_T, B = H - PAD_B;
    const PW = Math.max(40, R - L), PH = Math.max(20, B - T);
    const b = widths(disp, PW);
    const z = disp.z;
    const xA = L + b.wA * z;
    const xD = xA + b.wD * z;
    const xS = xD + b.hold * z;
    const xR = xS + b.wR * z;
    const yS = B - disp.s * PH;
    const kA = envAttackK(disp.curve), kD = envDecayK(disp.curve);
    return { L, R, T, B, PW, PH, z, minW: b.minW, mA: b.mA, mD: b.mD, mR: b.mR, hold: b.hold * z, xA, xD, xS, xR, yS, kA, kD };
  }

  function nodes(g) {
    const s = disp.s;
    const out = [
      { id: 'A', x: g.xA, y: g.T, main: true },
      { id: 'D', x: g.xD, y: g.yS, main: true },
      { id: 'S', x: g.xS, y: g.yS, main: true },
      { id: 'R', x: g.xR, y: g.B, main: true },
    ];
    if (g.xA - g.L > 22) out.push({ id: 'cA', x: (g.L + g.xA) / 2, y: g.B - envShape(0.5, g.kA) * g.PH });
    if (g.xD - g.xA > 22 && s < 0.97) out.push({ id: 'cD', x: (g.xA + g.xD) / 2, y: g.B - (s + (1 - s) * (1 - envShape(0.5, g.kD))) * g.PH });
    if (g.xR - g.xS > 22 && s > 0.03) out.push({ id: 'cR', x: (g.xS + g.xR) / 2, y: g.B - s * (1 - envShape(0.5, g.kD)) * g.PH });
    return out;
  }
  const nodeForKey = (k) => ({ a: 'A', d: 'D', s: 'S', r: 'R', curve: 'cD' }[k]);

  function hitTest(x, y, touch) {
    const g = geom();
    const rad = touch ? 22 : 12;
    let best = null, bd = rad * rad;
    for (const n of nodes(g)) {
      const dx = n.x - x, dy = n.y - y;
      const d2 = dx * dx + dy * dy * (n.main ? 1 : 1.2) + (n.main ? 0 : 20);
      if (d2 < bd) { bd = d2; best = n.id; }
    }
    return best;
  }

  const buf = new Float32Array((ENV_SAMPLES * 3 + 4) * 2);
  function curvePoints(g) {
    let i = 0;
    const put = (x, y) => { buf[i++] = x; buf[i++] = y; };
    const s = disp.s;
    put(g.L, g.B);
    for (let j = 1; j <= ENV_SAMPLES; j++) { const t = j / ENV_SAMPLES; put(g.L + (g.xA - g.L) * t, g.B - envShape(t, g.kA) * g.PH); }
    for (let j = 1; j <= ENV_SAMPLES; j++) { const t = j / ENV_SAMPLES; put(g.xA + (g.xD - g.xA) * t, g.B - (s + (1 - s) * (1 - envShape(t, g.kD))) * g.PH); }
    put(g.xS, g.yS);
    for (let j = 1; j <= ENV_SAMPLES; j++) { const t = j / ENV_SAMPLES; put(g.xS + (g.xR - g.xS) * t, g.B - s * (1 - envShape(t, g.kD)) * g.PH); }
    return i >> 1;
  }

  function playheadTarget(g) {
    const s = disp.s, lv = clamp01(ph.level);
    switch (ph.stage) {
      case 1: return [g.L + (g.xA - g.L) * envShapeInv(lv, g.kA), g.B - lv * g.PH];
      case 2: {
        const fr = s >= 0.999 ? 1 : clamp01((1 - lv) / (1 - s));
        return [g.xA + (g.xD - g.xA) * envShapeInv(fr, g.kD), g.B - lv * g.PH];
      }
      case 3: return [g.xD + g.hold * 0.86 * (1 - Math.exp(-ph.susT / 900)), g.B - lv * g.PH];
      case 4: {
        const fr = s <= 0.001 ? 1 : clamp01(1 - lv / s);
        return [g.xS + (g.xR - g.xS) * envShapeInv(fr, g.kD), g.B - lv * g.PH];
      }
      default: return [g.L, g.B];
    }
  }

  function draw() {
    if (!W || !H) return;
    if (!colorsOk) resolveColors();
    const g = geom();
    const { acc, line, text } = col;
    const accHi = mixRgb(acc, WHITE, 0.45);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(line, 0.09);
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) { const y = Math.round(g.T + (g.PH * i) / 4) + 0.5; ctx.moveTo(g.L, y); ctx.lineTo(g.R, y); }
    const cols = Math.max(4, Math.round(g.PW / 36));
    for (let i = 0; i <= cols; i++) { const x = Math.round(g.L + (g.PW * i) / cols) + 0.5; ctx.moveTo(x, g.T); ctx.lineTo(x, g.B); }
    ctx.stroke();
    // segment boundaries
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = rgba(line, 0.22);
    ctx.beginPath();
    for (const x of [g.xA, g.xD, g.xS]) { const xx = Math.round(x) + 0.5; ctx.moveTo(xx, g.T - 4); ctx.lineTo(xx, g.B); }
    ctx.stroke();
    ctx.setLineDash([]);
    // sustain hold band
    const band = ctx.createLinearGradient(0, g.yS, 0, g.B);
    band.addColorStop(0, rgba(acc, 0.07));
    band.addColorStop(1, rgba(acc, 0));
    ctx.fillStyle = band;
    ctx.fillRect(g.xD, g.yS, g.xS - g.xD, g.B - g.yS);

    // curve
    const n = curvePoints(g);
    ctx.beginPath();
    ctx.moveTo(buf[0], buf[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(buf[i * 2], buf[i * 2 + 1]);
    ctx.lineTo(g.xR, g.B + 0.5);
    ctx.lineTo(g.L, g.B + 0.5);
    ctx.closePath();
    const fillG = ctx.createLinearGradient(0, g.T, 0, g.B);
    fillG.addColorStop(0, rgba(acc, 0.34));
    fillG.addColorStop(0.55, rgba(acc, 0.12));
    fillG.addColorStop(1, rgba(acc, 0.02));
    ctx.fillStyle = fillG;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(buf[0], buf[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(buf[i * 2], buf[i * 2 + 1]);
    const strokeG = ctx.createLinearGradient(g.L, 0, g.xR, 0);
    strokeG.addColorStop(0, rgba(accHi, 1));
    strokeG.addColorStop(1, rgba(acc, 1));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.save();
    ctx.shadowColor = rgba(acc, 0.75);
    ctx.shadowBlur = 10;
    ctx.strokeStyle = strokeG;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // playhead
    if (ph.alpha > 0.01) {
      const a = ph.alpha;
      const lg = ctx.createLinearGradient(0, ph.y, 0, g.B);
      lg.addColorStop(0, rgba(accHi, 0.45 * a));
      lg.addColorStop(1, rgba(acc, 0));
      ctx.fillStyle = lg;
      ctx.fillRect(ph.x - 0.75, ph.y, 1.5, g.B - ph.y);
      const rg = ctx.createRadialGradient(ph.x, ph.y, 0, ph.x, ph.y, 14);
      rg.addColorStop(0, rgba(accHi, 0.9 * a));
      rg.addColorStop(0.35, rgba(acc, 0.45 * a));
      rg.addColorStop(1, rgba(acc, 0));
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(ph.x, ph.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(WHITE, a);
      ctx.beginPath();
      ctx.arc(ph.x, ph.y, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // nodes
    const focusNode = focusKey ? nodeForKey(focusKey) : null;
    const activeId = drag ? drag.id : null;
    for (const nd of nodes(g)) {
      const isHot = nd.id === hot || nd.id === activeId || nd.id === focusNode;
      if (nd.main) {
        if (isHot) {
          const rg = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, 16);
          rg.addColorStop(0, rgba(acc, 0.55));
          rg.addColorStop(1, rgba(acc, 0));
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, 16, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, isHot ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = nd.id === activeId ? rgba(accHi, 1) : rgba(col.bg, 1);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(isHot ? accHi : acc, 1);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, isHot ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col.bg, 0.9);
        ctx.fill();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = rgba(acc, isHot ? 1 : 0.55);
        ctx.stroke();
      }
      if (nd.id === focusNode) {
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 9, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(accHi, 0.9);
        ctx.stroke();
      }
    }

    // labels (stage letter + value), collision-avoided along the bottom
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';
    const labs = [
      ['A', formatValue(P.a, val.a), (g.L + g.xA) / 2],
      ['D', formatValue(P.d, val.d), (g.xA + g.xD) / 2],
      ['S', formatValue(P.s, val.s), (g.xD + g.xS) / 2],
      ['R', formatValue(P.r, val.r), (g.xS + g.xR) / 2],
    ];
    const y = g.B + 16;
    const widths = labs.map(([l, v]) => ctx.measureText(`${l} ${v}`).width);
    const xs = labs.map((l, i) => l[2] - widths[i] / 2);
    for (let i = 0; i < xs.length; i++) {
      if (i === 0) xs[i] = Math.max(g.L - 4, xs[i]);
      else xs[i] = Math.max(xs[i], xs[i - 1] + widths[i - 1] + 8);
    }
    const over = xs[3] + widths[3] - (W - 4);
    if (over > 0) for (let i = 3; i >= 0; i--) { xs[i] -= over; if (i && xs[i] > xs[i - 1] + widths[i - 1] + 8) break; }
    labs.forEach(([l, v], i) => {
      ctx.fillStyle = rgba(acc, 0.95);
      ctx.fillText(l, xs[i], y);
      ctx.fillStyle = rgba(text, 0.95);
      ctx.fillText(v, xs[i] + ctx.measureText(`${l} `).width, y);
    });
  }

  function frame(dt) {
    let busy = false;
    if (drag && W) {
      // while dragging the zoom may only shrink (keeps the dragged node on-canvas)
      const zt = fitZoom(disp);
      if (zt < disp.z) disp.z = zt;
    }
    if (!drag) {
      const kf = approach(dt, 60);
      if (W) tgt.z = fitZoom(tgt);
      for (const k of ENV_KEYS) {
        const d = tgt[k] - disp[k];
        if (Math.abs(d) > 0.0004) { disp[k] += d * kf; busy = true; } else disp[k] = tgt[k];
      }
      const dz = tgt.z - disp.z;
      if (Math.abs(dz) > 0.001) { disp.z += dz * approach(dt, 110); busy = true; } else disp.z = tgt.z;
    }
    if (W && H) {
      const g = geom();
      if (ph.on) {
        if (ph.stage === 3) { ph.susT += dt; if (ph.susT < 4000) busy = true; }
        const [tx, ty] = playheadTarget(g);
        if (ph.alpha < 0.02) { ph.x = tx; ph.y = ty; }
        const kp = approach(dt, 28);
        ph.x += (tx - ph.x) * kp;
        ph.y += (ty - ph.y) * kp;
        ph.alpha += (1 - ph.alpha) * approach(dt, 50);
        if (Math.abs(tx - ph.x) > 0.3 || Math.abs(ty - ph.y) > 0.3 || ph.alpha < 0.99) busy = true;
      } else if (ph.alpha > 0.01) {
        ph.alpha *= 1 - approach(dt, 140);
        busy = true;
      } else ph.alpha = 0;
    }
    draw();
    if (bubbleFor && !drag) positionBubble(bubbleFor);
    return busy;
  }
  const kick = () => animate(frame);

  // ── bubble ──
  let bubbleFor = null;
  function bubbleText(id) {
    const f = (k) => formatValue(P[k], val[k]);
    switch (id) {
      case 'A': return `${nameOf(P.a)} ${f('a')}`;
      case 'D': return `${nameOf(P.d)} ${f('d')} · ${nameOf(P.s)} ${f('s')}`;
      case 'S': return `${nameOf(P.s)} ${f('s')}`;
      case 'R': return `${nameOf(P.r)} ${f('r')}`;
      default: return `${nameOf(P.curve)} ${f('curve')}`;
    }
  }
  function positionBubble(id) {
    const n = nodes(geom()).find((q) => q.id === id) || (id === 'cD' ? { x: (geom().xA + geom().xD) / 2, y: geom().yS } : null);
    if (!n) return;
    bubble.textContent = bubbleText(id);
    const bw = bubble.offsetWidth || 80;
    const x = clamp(n.x, bw / 2 + 4, W - bw / 2 - 4);
    const yy = Math.max(n.y - 12, 26);
    bubble.style.transform = `translate(${x.toFixed(1)}px, ${yy.toFixed(1)}px) translate(-50%, -100%)`;
  }
  function showBubbleFor(id) {
    if (!id) return;
    bubbleFor = id;
    root.classList.add('is-bubble');
    positionBubble(id);
  }
  function hideBubble() { bubbleFor = null; root.classList.remove('is-bubble'); }

  /** Apply native edits (user): update state + notify. */
  function edit(partial, animated) {
    const out = {};
    let any = false;
    for (const k in partial) {
      const v = coerce(P[k], partial[k]);
      if (v !== val[k]) { val[k] = v; out[k] = v; any = true; }
      tgt[k] = normOf(k, val[k]);
      if (!animated) disp[k] = tgt[k];
    }
    if (!any) return;
    updateAria();
    kick();
    if (bubbleFor) positionBubble(bubbleFor);
    onChange(out);
  }

  // ── pointer ──
  const dbl = tapDetector();
  const local = (e) => { const rc = canvas.getBoundingClientRect(); return [e.clientX - rc.left, e.clientY - rc.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!isPrimary(e)) return;
    const [x, y] = local(e);
    const id = hitTest(x, y, e.pointerType !== 'mouse');
    if (!id) return;
    e.preventDefault();
    if (dbl(e)) {
      const reset = { A: ['a'], D: ['d', 's'], S: ['s'], R: ['r'] }[id] || ['curve'];
      const pt = {};
      for (const k of reset) pt[k] = P[k].def;
      edit(pt, true);
      showBubbleFor(id);
      setTimeout(() => { if (!drag && hot !== id) hideBubble(); }, 900);
      return;
    }
    const g = geom();
    drag = { id, sx: x, sy: y, g, start: { ...disp }, fine: 1 };
    root.classList.add('is-dragging');
    showBubbleFor(id);
    kick();
    trackPointer(canvas, e, (ev) => {
      const [mx, my] = local(ev);
      const fine = ev.shiftKey ? 0.2 : 1;
      const dx = (mx - drag.sx) * fine, dy = (my - drag.sy) * fine;
      const st = drag.start, gg = drag.g;
      const pt = {};
      switch (drag.id) {
        case 'A': pt.a = fromNorm(P.a, clamp01(st.a + dx / ((gg.mA - gg.minW) * gg.z))); break;
        case 'D':
          pt.d = fromNorm(P.d, clamp01(st.d + dx / ((gg.mD - gg.minW) * gg.z)));
          pt.s = fromNorm(P.s, clamp01(st.s - dy / gg.PH));
          break;
        case 'S': pt.s = fromNorm(P.s, clamp01(st.s - dy / gg.PH)); break;
        case 'R': pt.r = fromNorm(P.r, clamp01(st.r + dx / ((gg.mR - gg.minW) * gg.z))); break;
        case 'cA': pt.curve = fromNorm(P.curve, clamp01(st.curve + dy / (gg.PH * 0.9))); break;
        default: pt.curve = fromNorm(P.curve, clamp01(st.curve - dy / (gg.PH * 0.9))); break;
      }
      edit(pt, false);
      positionBubble(drag.id);
    }, () => {
      drag = null;
      root.classList.remove('is-dragging');
      if (!hot) hideBubble();
      kick();
    });
  });
  const cursorFor = { A: 'ew-resize', D: 'move', S: 'ns-resize', R: 'ew-resize', cA: 'ns-resize', cD: 'ns-resize', cR: 'ns-resize' };
  canvas.addEventListener('pointermove', (e) => {
    if (drag || e.pointerType !== 'mouse') return;
    const [x, y] = local(e);
    const id = hitTest(x, y, false);
    if (id !== hot) {
      hot = id;
      canvas.style.cursor = id ? cursorFor[id] : '';
      if (id) showBubbleFor(id); else if (!focusKey) hideBubble();
      kick();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    if (hot) { hot = null; if (!focusKey) hideBubble(); kick(); }
  });

  // ── sizing ──
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const w = root.clientWidth, hh = root.clientHeight;
    if (!w || !hh) return;
    W = w; H = hh;
    dpr = fitCanvas(canvas, W, H);
    if (!sized) { sized = true; disp.z = tgt.z = fitZoom(disp); }
    if (!colorsOk) resolveColors();
    kick();
  }) : null;
  if (ro) ro.observe(root);
  updateAria();

  return {
    el: root,
    setValues(v) {
      if (!v) return;
      for (const k of ENV_KEYS) {
        if (v[k] === undefined) continue;
        if (drag) continue;
        val[k] = coerce(P[k], v[k]);
        tgt[k] = normOf(k, val[k]);
      }
      updateAria();
      kick();
    },
    getValues: () => ({ ...val }),
    setPlayhead(level, stage) {
      const st = stage == null ? 0 : ENV_STAGES[stage] || 0;
      if (!st || !(level >= 0)) { if (ph.on) { ph.on = false; kick(); } return; }
      if (st === 3 && ph.stage !== 3) ph.susT = 0;
      ph.on = true;
      ph.level = +level;
      ph.stage = st;
      kick();
    },
    setAccent(c) {
      if (c) root.style.setProperty('--e-accent', c); else root.style.removeProperty('--e-accent');
      colorsOk = false;
      kick();
    },
    destroy() { if (ro) ro.disconnect(); anims.delete(frame); root.remove(); },
  };
}

/* ═══════════════════════════════════ XY pad ═══════════════════════════════════ */

const TRAIL_N = 48;
const TRAIL_MS = 520;
const XY_PAD = 14;      // px: the puck travels inside this inset, so it stays whole even at 0,0 / 1,1
const RIPPLE_MS = 620;

/**
 * XY pad (x, y in 0..1, y = 1 at the top). Glowing puck with comet trail; stays where released.
 * Extras: formatX(x)/formatY(y) for the readouts.
 * @returns {{ el, setXY(x, y), getXY(), setAccent(c), destroy() }}
 */
export function createXYPad({ x = 0.5, y = 0.5, onChange = noop, labelX = 'X', labelY = 'Y', accent, formatX, formatY } = {}) {
  let cx = clamp01(+x || 0), cy = clamp01(+y || 0);
  const home = [cx, cy];
  const disp = { x: cx, y: cy };
  const fx = formatX || ((v) => `${Math.round(v * 100)}%`);
  const fy = formatY || ((v) => `${Math.round(v * 100)}%`);
  const lx = labelParts(null, labelX) || { zh: '', en: '' };
  const ly = labelParts(null, labelY) || { zh: '', en: '' };

  const root = h('div', 'ac-xy', { role: 'group', 'aria-label': `XY ${ariaName(lx)} / ${ariaName(ly)}` });
  const setAccent = (c) => {
    root.classList.toggle('is-aurora', !c || c === 'aurora');
    if (c && c !== 'aurora') root.style.setProperty('--xy-accent', c);
    else root.style.removeProperty('--xy-accent');
    colorsOk = false;
    kick();
  };
  const canvas = h('canvas', 'ac-xy__canvas', { 'aria-hidden': 'true' });
  const puck = h('div', 'ac-xy__puck', { 'aria-hidden': 'true' });
  const axX = h('div', 'ac-xy__axis ac-xy__axis--x', { 'aria-hidden': 'true' });
  const axY = h('div', 'ac-xy__axis ac-xy__axis--y', { 'aria-hidden': 'true' });
  const vX = h('b', 'ac-xy__v');
  const vY = h('b', 'ac-xy__v');
  axX.append(labelEl(lx, 'ac-xy__lbl'), vX);
  axY.append(labelEl(ly, 'ac-xy__lbl'), vY);
  root.append(canvas, axX, axY, puck);
  const ctx = canvas.getContext('2d');

  const mkSr = (axis, parts) => {
    const s = h('div', 'ac-sr-only', { role: 'slider', tabindex: 0, 'aria-label': ariaName(parts) || axis, 'aria-valuemin': 0, 'aria-valuemax': 100 });
    s.addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 0.002 : e.key.startsWith('Page') ? 0.1 : 0.01;
      let nx = cx, ny = cy;
      switch (e.key) {
        case 'ArrowLeft': nx -= st; break;
        case 'ArrowRight': nx += st; break;
        case 'ArrowUp': ny += st; break;
        case 'ArrowDown': ny -= st; break;
        case 'PageUp': if (axis === 'x') nx += st; else ny += st; break;
        case 'PageDown': if (axis === 'x') nx -= st; else ny -= st; break;
        case 'Home': if (axis === 'x') nx = 0; else ny = 0; break;
        case 'End': if (axis === 'x') nx = 1; else ny = 1; break;
        default: return;
      }
      e.preventDefault();
      set(nx, ny, true, true);
    });
    s.addEventListener('focus', () => root.classList.add('is-focus'));
    s.addEventListener('blur', () => root.classList.remove('is-focus'));
    root.append(s);
    return s;
  };
  const srX = mkSr('x', lx);
  const srY = mkSr('y', ly);

  let W = 0, H = 0, dpr = 1;
  let colorsOk = false;
  let ripT = -1e9, ripX = 0, ripY = 0; // touch ripple (normalised position)
  /** normalised → canvas px (inside the inset) */
  const pxOf = (v) => XY_PAD + v * Math.max(1, W - 2 * XY_PAD);
  const pyOf = (v) => XY_PAD + (1 - v) * Math.max(1, H - 2 * XY_PAD);
  let col = { acc: [92, 242, 255], acc2: [167, 139, 250], line: [140, 160, 220] };
  const trail = new Float64Array(TRAIL_N * 3);
  const rib = new Float64Array((TRAIL_N + 1) * 3); // scratch: x, y, freshness (0 old … 1 new)
  let tHead = 0, tCount = 0;
  let dragging = false;

  function resolveColors() {
    if (!root.isConnected) return;
    const aur = root.classList.contains('is-aurora');
    col = {
      acc: resolveColor(root, aur ? 'var(--a-cyan, #5cf2ff)' : 'var(--xy-accent)', [92, 242, 255]),
      acc2: resolveColor(root, aur ? 'var(--a-violet, #a78bfa)' : 'var(--xy-accent)', [167, 139, 250]),
      line: [140, 160, 220],
    };
    colorsOk = true;
  }
  function pushTrail(px, py, t) {
    const i = tHead * 3;
    trail[i] = px; trail[i + 1] = py; trail[i + 2] = t;
    tHead = (tHead + 1) % TRAIL_N;
    if (tCount < TRAIL_N) tCount++;
  }
  function text() {
    vX.textContent = fx(cx);
    vY.textContent = fy(cy);
    srX.setAttribute('aria-valuenow', Math.round(cx * 100));
    srX.setAttribute('aria-valuetext', fx(cx));
    srY.setAttribute('aria-valuenow', Math.round(cy * 100));
    srY.setAttribute('aria-valuetext', fy(cy));
  }
  let nearX = false, nearY = false;
  function placePuck() {
    const px = pxOf(disp.x), py = pyOf(disp.y);
    puck.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
    // the axis read-outs step aside (fade) while the puck sits on top of them
    if (W && H) {
      const nx = py > H - 34 && Math.abs(px - W / 2) < 90;
      const ny = px < 38 && Math.abs(py - H / 2) < 80;
      if (nx !== nearX) { nearX = nx; root.classList.toggle('is-near-x', nx); }
      if (ny !== nearY) { nearY = ny; root.classList.toggle('is-near-y', ny); }
    }
  }

  function draw(now) {
    if (!W || !H) return;
    if (!colorsOk) resolveColors();
    const { acc, acc2, line } = col;
    const px = pxOf(disp.x), py = pyOf(disp.y);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // spotlight following the puck
    const sp = ctx.createRadialGradient(px, py, 0, px, py, Math.max(W, H) * 0.55);
    sp.addColorStop(0, rgba(acc, 0.16));
    sp.addColorStop(0.5, rgba(acc2, 0.05));
    sp.addColorStop(1, rgba(acc2, 0));
    ctx.fillStyle = sp;
    ctx.fillRect(0, 0, W, H);
    // grid
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const gx = Math.round((W * i) / 8) + 0.5, gy = Math.round((H * i) / 8) + 0.5;
      ctx.moveTo(gx, 0); ctx.lineTo(gx, H);
      ctx.moveTo(0, gy); ctx.lineTo(W, gy);
    }
    ctx.strokeStyle = rgba(line, 0.07);
    ctx.stroke();
    ctx.beginPath();
    const mx = Math.round(W / 2) + 0.5, my = Math.round(H / 2) + 0.5;
    ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.moveTo(0, my); ctx.lineTo(W, my);
    ctx.strokeStyle = rgba(line, 0.13);
    ctx.stroke();
    // grid dots at intersections near the puck (subtle "lens")
    for (let i = 1; i < 8; i++) {
      for (let j = 1; j < 8; j++) {
        const gx = (W * i) / 8, gy = (H * j) / 8;
        const d = Math.hypot(gx - px, gy - py) / (Math.min(W, H) * 0.45);
        if (d >= 1) continue;
        ctx.fillStyle = rgba(acc, 0.35 * (1 - d));
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
      }
    }
    // crosshair
    const chx = ctx.createLinearGradient(0, 0, W, 0);
    const fxp = clamp01(px / W);
    chx.addColorStop(0, rgba(acc, 0.04));
    chx.addColorStop(fxp, rgba(acc, 0.5));
    chx.addColorStop(1, rgba(acc, 0.04));
    ctx.fillStyle = chx;
    ctx.fillRect(0, py - 0.5, W, 1);
    const chy = ctx.createLinearGradient(0, 0, 0, H);
    const fyp = clamp01(py / H);
    chy.addColorStop(0, rgba(acc, 0.04));
    chy.addColorStop(fyp, rgba(acc, 0.5));
    chy.addColorStop(1, rgba(acc, 0.04));
    ctx.fillStyle = chy;
    ctx.fillRect(px - 0.5, 0, 1, H);
    // comet trail: one tapered ribbon (no overlapping caps → no beading), gradient tail → head
    let n = 0;
    for (let k = tCount; k >= 1; k--) {
      const i = ((tHead - k + TRAIL_N) % TRAIL_N) * 3;
      const age = now - trail[i + 2];
      if (age > TRAIL_MS) continue;
      const x0 = pxOf(trail[i]), y0 = pyOf(trail[i + 1]);
      if (n && Math.abs(x0 - rib[(n - 1) * 3]) + Math.abs(y0 - rib[(n - 1) * 3 + 1]) < 0.75) continue;
      rib[n * 3] = x0; rib[n * 3 + 1] = y0; rib[n * 3 + 2] = 1 - age / TRAIL_MS;
      n++;
    }
    if (n && Math.abs(px - rib[(n - 1) * 3]) + Math.abs(py - rib[(n - 1) * 3 + 1]) >= 0.75) {
      rib[n * 3] = px; rib[n * 3 + 1] = py; rib[n * 3 + 2] = 1; n++;
    }
    let alive = n > 0 && tCount > 0;
    // touch ripple: two expanding rings where the pad was pressed
    const ra = (now - ripT) / RIPPLE_MS;
    if (ra >= 0 && ra < 1) {
      alive = true;
      const rx = pxOf(ripX), ry = pyOf(ripY), R = Math.min(W, H) * 0.32;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 2; k++) {
        const f = ra - k * 0.18;
        if (f <= 0) continue;
        const e = 1 - (1 - f) * (1 - f);
        ctx.beginPath();
        ctx.arc(rx, ry, 6 + e * R * (1 - k * 0.3), 0, Math.PI * 2);
        ctx.lineWidth = 1.6 - k * 0.5;
        ctx.strokeStyle = rgba(k ? acc2 : acc, 0.55 * (1 - f));
        ctx.stroke();
      }
      ctx.restore();
    }
    if (n >= 2) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let pass = 0; pass < 2; pass++) {
        const wMax = pass ? 2.6 : 9.5;
        ctx.beginPath();
        for (let j = 0; j < n; j++) ribbonPt(j, n, wMax, 1, j === 0);
        for (let j = n - 1; j >= 0; j--) ribbonPt(j, n, wMax, -1, false);
        ctx.closePath();
        const tx = rib[0], ty = rib[1], hx = rib[(n - 1) * 3], hy = rib[(n - 1) * 3 + 1];
        const linear = Math.abs(hx - tx) + Math.abs(hy - ty) > 3;
        const grad = linear ? ctx.createLinearGradient(tx, ty, hx, hy) : ctx.createRadialGradient(hx, hy, 0, hx, hy, 40);
        const headA = pass ? 0.8 : 0.5;
        if (linear) {
          grad.addColorStop(0, rgba(acc2, 0));
          grad.addColorStop(0.6, rgba(mixRgb(acc2, acc, 0.6), headA * 0.45));
          grad.addColorStop(1, rgba(pass ? mixRgb(acc, WHITE, 0.5) : acc, headA));
        } else {
          grad.addColorStop(0, rgba(acc, headA));
          grad.addColorStop(1, rgba(acc2, 0));
        }
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.restore();
    }
    return alive;
  }
  /** Ribbon edge point j at side s (±1): offset along the local normal by the tapered half-width. */
  function ribbonPt(j, n, wMax, s, first) {
    const x = rib[j * 3], y = rib[j * 3 + 1], f = rib[j * 3 + 2];
    const a = j > 0 ? j - 1 : j, c = j < n - 1 ? j + 1 : j;
    let dx = rib[c * 3] - rib[a * 3], dy = rib[c * 3 + 1] - rib[a * 3 + 1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const w = (0.3 + wMax * f * f) * s;
    const ex = x - dy * w, ey = y + dx * w;
    if (first) ctx.moveTo(ex, ey); else ctx.lineTo(ex, ey);
  }

  function frame(dt, now) {
    let busy = false;
    if (!dragging) {
      const k = approach(dt, 70);
      const ddx = cx - disp.x, ddy = cy - disp.y;
      if (Math.abs(ddx) > 0.0005 || Math.abs(ddy) > 0.0005) {
        disp.x += ddx * k; disp.y += ddy * k;
        pushTrail(disp.x, disp.y, now);
        busy = true;
      } else { disp.x = cx; disp.y = cy; }
    }
    placePuck();
    if (draw(now)) busy = true;
    return busy;
  }
  const kick = () => animate(frame);

  function set(nx, ny, user, animated) {
    nx = clamp01(nx); ny = clamp01(ny);
    const changed = nx !== cx || ny !== cy;
    cx = nx; cy = ny;
    if (!animated) { disp.x = cx; disp.y = cy; pushTrail(cx, cy, performance.now()); }
    text();
    kick();
    if (user && changed) onChange(cx, cy);
  }

  const dbl = tapDetector();
  root.addEventListener('pointerdown', (e) => {
    if (!isPrimary(e)) return;
    if (e.target.classList && e.target.classList.contains('ac-sr-only')) return;
    e.preventDefault();
    if (dbl(e)) { set(home[0], home[1], true, true); return; }
    const rc = canvas.getBoundingClientRect();
    dragging = true;
    root.classList.add('is-dragging');
    let lastX = e.clientX, lastY = e.clientY;
    const iw = Math.max(1, rc.width - 2 * XY_PAD), ih = Math.max(1, rc.height - 2 * XY_PAD);
    const abs = (ev) => set((ev.clientX - rc.left - XY_PAD) / iw, 1 - (ev.clientY - rc.top - XY_PAD) / ih, true, false);
    if (!e.shiftKey) abs(e);
    ripT = performance.now(); ripX = cx; ripY = cy;
    trackPointer(root, e, (ev) => {
      if (ev.shiftKey) {
        set(cx + ((ev.clientX - lastX) / iw) * 0.2, cy - ((ev.clientY - lastY) / ih) * 0.2, true, false);
      } else abs(ev);
      lastX = ev.clientX; lastY = ev.clientY;
    }, () => {
      dragging = false;
      root.classList.remove('is-dragging');
      kick();
    });
  });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const w = root.clientWidth, hh = root.clientHeight;
    if (!w || !hh) return;
    W = w; H = hh;
    dpr = fitCanvas(canvas, W, H);
    kick();
  }) : null;
  if (ro) ro.observe(root);
  setAccent(accent);
  text();

  return {
    el: root,
    setXY(nx, ny) { if (!dragging) set(+nx, +ny, false, true); },
    getXY: () => [cx, cy],
    setAccent,
    destroy() { if (ro) ro.disconnect(); anims.delete(frame); root.remove(); },
  };
}
