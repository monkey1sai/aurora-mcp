// Tiny DOM helpers shared by the app shell (no dependencies).

/**
 * h('div.card.is-on', { title: 'x', onclick: fn, '--accent': '#fff', dataset: {k: 'v'} }, child, 'text', [more])
 * Special attrs: class, style (object or string), html, text, dataset, on<event> (function), --css-var.
 */
export function h(tag, attrs, ...kids) {
  const parts = String(tag || 'div').split('.');
  const e = document.createElement(parts[0] || 'div');
  if (parts.length > 1) e.className = parts.slice(1).join(' ');
  if (attrs) setAttrs(e, attrs);
  append(e, kids);
  return e;
}

export function setAttrs(e, attrs) {
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = e.className ? `${e.className} ${v}` : v;
    else if (k === 'style') { if (typeof v === 'string') e.style.cssText += v; else Object.assign(e.style, v); }
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('--')) e.style.setProperty(k, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && 'value' in e) e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  return e;
}

export function append(e, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(e, k);
    else if (k instanceof Node) e.appendChild(k);
    else e.appendChild(document.createTextNode(String(k)));
  }
  return e;
}

const SVGNS = 'http://www.w3.org/2000/svg';
/** SVG element with attributes. */
export function s(tag, attrs, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, String(attrs[k]));
  for (const k of kids.flat()) if (k) e.appendChild(k);
  return e;
}

/** Collects disposers (unsubscribe functions, component destroy()) so a view can be rebuilt cleanly. */
export function createScope() {
  const fns = [];
  return {
    add(fn) { if (typeof fn === 'function') fns.push(fn); return fn; },
    dispose() { while (fns.length) { try { fns.pop()(); } catch (e) { console.error(e); } } },
  };
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Coalesce calls into one per animation frame. */
export function rafThrottle(fn) {
  let id = 0;
  let lastArgs = null;
  const run = () => { id = 0; const a = lastArgs; lastArgs = null; fn(...a); };
  const wrapped = (...args) => {
    lastArgs = args;
    if (!id) id = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  };
  wrapped.flush = () => { if (id) { (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(id); run(); } };
  return wrapped;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

/** Safe localStorage wrapper (private mode / blocked storage never throws). */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ } },
};

/** True when a keyboard event target is a text-entry element (shortcuts must not fire). */
export function isTyping(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test(t.type || 'text');
  return false;
}
