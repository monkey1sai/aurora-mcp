// AURORA 極光 — motion-graphics overlay for the demo film.
//   import { createOverlay } from './tools/video/overlays/overlay.js';
//   const ov = createOverlay(document.getElementById('overlay-root'), { lang: 'en' });
//   await ov.ready;               // stylesheet + web fonts loaded (never blocks > ~5 s)
//   await ov.hook([{ en: "Claude can't hear.", zh: 'Claude 聽不見。' }, { en: 'It built this anyway.', zh: '但它做出了這個。', key: true }]);
// Everything is designed on a 1920×1080 stage and scaled to the root's size. See README.md for the full API.
import { Engine, ease, clamp, lerp, anim, css, stepping } from './lib/anim.js';
import { pick, split, mapGradient } from './lib/text.js';
import { Backdrop } from './lib/backdrop.js';
import { Swarm, DEFAULT_PHASES, SWARM_STR } from './lib/swarm.js';

export { DEFAULT_PHASES };
export const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..900&family=JetBrains+Mono:wght@400..700&family=Noto+Sans+TC:wght@400..900&display=swap';
const W = 1920, H = 1080;

const STR = {
  tagline: { en: 'A hybrid synthesizer that runs entirely in your browser.', zh: '完全在瀏覽器裡運作的混合式合成器' },
  built: { en: 'Built with <b>Claude Code</b>', zh: '由 <b>Claude Code</b> 打造' },
  facts: { en: '<b>47</b> agent runs · <b>46,742</b> lines · <b>0</b> dependencies', zh: '<b>47</b> 個 agent · <b>46,742</b> 行程式碼 · <b>0</b> 個相依套件' },
};

let uid = 0;
const SOUND_SVG = id => `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ef0b0"/><stop offset=".5" stop-color="#5cf2ff"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>
  <path d="M6 18.5h7.5L24 10v28l-10.5-8.5H6z" fill="url(#${id})" stroke="url(#${id})" stroke-width="2" stroke-linejoin="round"/>
  <path class="wave" d="M30.5 17.5c2.6 1.8 4 4 4 6.5s-1.4 4.7-4 6.5" fill="none" stroke="#eaf8ff" stroke-width="3.4" stroke-linecap="round"/>
  <path class="wave wave2" d="M35.5 11.5c4.6 3.2 7 7.4 7 12.5s-2.4 9.3-7 12.5" fill="none" stroke="#eaf8ff" stroke-width="3.4" stroke-linecap="round"/></svg>`;
const SPARK_SVG = id => `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ef0b0"/><stop offset=".35" stop-color="#5cf2ff"/><stop offset=".7" stop-color="#a78bfa"/><stop offset="1" stop-color="#ff6bd6"/></linearGradient></defs>
  <path d="M24 3c1.6 10.4 6.6 15.4 21 21-14.4 5.6-19.4 10.6-21 21-1.6-10.4-6.6-15.4-21-21 14.4-5.6 19.4-10.6 21-21z" fill="url(#${id})"/></svg>`;
const CHECK_SVG = id => `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ef0b0"/><stop offset="1" stop-color="#5cf2ff"/></linearGradient></defs>
  <circle cx="24" cy="24" r="20" fill="url(#${id})"/><path d="M15 24.5l6 6 12-13" fill="none" stroke="#04121a" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW_SVG = `<svg viewBox="0 0 58 70" aria-hidden="true"><defs><linearGradient id="ovl-cur-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dff6ff"/></linearGradient></defs>
  <path d="M7 5 L7 55 L19.5 43.5 L28.5 64 L38 59.8 L29.2 39.8 L46 39.8 Z" fill="url(#ovl-cur-g)" stroke="#07101c" stroke-width="3.2" stroke-linejoin="round"/></svg>`;

export function createOverlay(rootEl, { lang = 'en', clock, pixelRatio = 1, loadFonts = true, glScale = .5 } = {}) {
  if (!rootEl) throw new Error('createOverlay: root element required');
  const engine = new Engine(clock);
  const doc = rootEl.ownerDocument;

  // ── stylesheet + fonts ──
  const cssHref = new URL('./overlay.css', import.meta.url).href;
  const links = [];
  const ensureLink = (href, crossOrigin) => {
    let l = [...doc.querySelectorAll('link[rel="stylesheet"]')].find(x => x.href === href);
    if (l) return Promise.resolve();
    l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = href; if (crossOrigin) l.crossOrigin = 'anonymous';
    const p = new Promise(res => { l.onload = res; l.onerror = res; });
    doc.head.appendChild(l); links.push(l); return p;
  };
  const cssReady = ensureLink(cssHref);
  const hasFonts = [...doc.querySelectorAll('link')].some(l => /fonts\.googleapis\.com\/css2\?[^"]*Inter/.test(l.href));
  const fontCss = loadFonts && !hasFonts ? ensureLink(FONT_HREF) : Promise.resolve();

  // ── root / layers ──
  const el = doc.createElement('div');
  el.className = 'ovl'; el.dataset.lang = lang;
  rootEl.appendChild(el);
  const L = {};
  for (const name of ['backdrop', 'dim', 'beam', 'swarm', 'hook', 'stats', 'counters', 'end', 'spot', 'rings', 'scrim', 'captions', 'badges', 'cursor', 'flash']) {
    const d = doc.createElement('div'); d.className = 'ovl-layer ovl-l-' + name; el.appendChild(d); L[name] = d;
  }
  const fit = () => {
    const w = rootEl.clientWidth || W, h = rootEl.clientHeight || H;
    const s = Math.min(w / W, h / H) || 1;
    el.style.transform = s === 1 ? '' : `scale(${s})`;
  };
  fit();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null; ro?.observe(rootEl);

  const backdrop = new Backdrop(engine, L.backdrop, { scale: glScale });
  const dim = doc.createElement('div'); dim.className = 'ovl-layer ovl-dim'; L.dim.appendChild(dim);
  const beam = doc.createElement('div'); beam.className = 'ovl-beam'; L.beam.appendChild(beam);
  const swarmer = new Swarm(null);

  const mk = (cls, parent, html) => { const d = doc.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; if (parent) parent.appendChild(d); return d; };
  const wait = ms => engine.wait(ms);
  let epoch = 0;

  const ov = {
    engine, el, layers: L, backdrop, lang,
    ready: null,
    get scale() { return el.getBoundingClientRect().width / W; },
  };
  swarmer.ov = ov; swarmer.engine = engine;

  ov.ready = (async () => {
    await cssReady;
    await Promise.race([fontCss, wait(4000)]);
    if (doc.fonts) {
      const faces = ['800 100px Inter', '600 100px Inter', '500 30px "JetBrains Mono"', '800 100px "Noto Sans TC"', '500 60px "Noto Sans TC"'];
      await Promise.race([Promise.all(faces.map(f => doc.fonts.load(f, f.includes('Noto') ? '極光聽不見合成器' : 'AURORA 0123456789').catch(() => null))), wait(5000)]);
      await ov.preload([]); // built-in strings (swarm, end card)
    }
    return ov;
  })();

  /** Make sure the glyphs of `str` are loaded before animating (no-op when ov.preload() already fetched them). */
  const glyphs = async (str, weights = ['800', '600']) => {
    if (!doc.fonts || !str) return;
    const text = String(str).replace(/<[^>]+>/g, '').replace(/\*/g, '');
    const faces = weights.flatMap(w => [`${w} 100px Inter`, `${w} 100px "Noto Sans TC"`]);
    let ok = true;
    for (const f of faces) { try { if (!doc.fonts.check(f, text)) { ok = false; break; } } catch {} }
    if (ok) return;
    console.warn('[overlay] glyphs not preloaded, loading now (call ov.preload() earlier):', text.slice(0, 40));
    await Promise.race([Promise.all(faces.map(f => doc.fonts.load(f, text).catch(() => null))), new Promise(r => setTimeout(r, 1500))]);
  };
  ov.glyphs = glyphs;
  /** Load the exact glyphs (CJK font slices) for strings you are about to show. */
  ov.preload = async (strings = []) => {
    if (!doc.fonts) return;
    const flat = x => (x == null ? [] : Array.isArray(x) ? x.flatMap(flat) : typeof x === 'object' ? Object.values(x).flatMap(flat) : [String(x)]);
    const all = [...new Set(flat([strings, STR, DEFAULT_PHASES.map(p => [p.title, p.groups.map(g => g.label)]), SWARM_STR]).join(' ').replace(/<[^>]+>/g, '').replace(/\*/g, ''))].join('') + ' AURORA 極光 0123456789,.';
    const faces = ['400', '500', '600', '700', '800'].flatMap(w => [`${w} 60px Inter`, `${w} 60px "Noto Sans TC"`]);
    await Promise.race([Promise.all(faces.map(f => doc.fonts.load(f, all).catch(() => null))), wait(5000)]);
  };
  /** Which fonts actually loaded (for verification). */
  ov.fontReport = () => {
    const out = {};
    for (const f of doc.fonts || []) { const k = `${f.family.replace(/"/g, '')} ${f.weight}`; if (f.status === 'loaded') out[k] = (out[k] || 0) + 1; }
    return { loaded: out, inter: doc.fonts?.check('800 100px Inter'), noto: doc.fonts?.check('800 100px "Noto Sans TC"', '極光'), mono: doc.fonts?.check('500 30px "JetBrains Mono"') };
  };

  ov.setLang = l => {
    ov.lang = l; el.dataset.lang = l;
    for (const b of bilingual) if (b.el.isConnected) b.el[b.html ? 'innerHTML' : 'textContent'] = pick(b.text, l);
  };
  const bilingual = [];
  const bi = (node, text, html = false) => { node[html ? 'innerHTML' : 'textContent'] = pick(text, ov.lang); bilingual.push({ el: node, text, html }); return node; };

  // ── geometry helpers ──
  ov.rectOf = target => {
    let node = target;
    if (typeof target === 'string') {
      node = doc.querySelector(target);
      if (!node) for (const f of doc.querySelectorAll('iframe')) { try { node = f.contentDocument?.querySelector(target); } catch {} if (node) break; }
      if (!node) return null;
    }
    const r = node.getBoundingClientRect();
    let x = r.left, y = r.top, w = r.width, h = r.height;
    let win = node.ownerDocument.defaultView;
    while (win && win.frameElement && win !== doc.defaultView) {
      const fe = win.frameElement; const fr = fe.getBoundingClientRect(); const s = fr.width / (fe.offsetWidth || fr.width || 1);
      x = fr.left + (fe.clientLeft + x) * s; y = fr.top + (fe.clientTop + y) * s; w *= s; h *= s;
      win = fe.ownerDocument.defaultView;
    }
    const or = el.getBoundingClientRect(); const s2 = or.width / W || 1;
    return { x: (x - or.left) / s2, y: (y - or.top) / s2, w: w / s2, h: h / s2 };
  };
  const toRect = t => {
    if (!t) return null;
    if (Array.isArray(t)) return { x: t[0], y: t[1], w: t[2], h: t[3] };
    if (typeof t === 'string' || t.nodeType === 1) return ov.rectOf(t);
    return { x: t.x ?? t.left, y: t.y ?? t.top, w: t.w ?? t.width, h: t.h ?? t.height };
  };
  const toPoint = (x, y) => {
    if (typeof x === 'number') return { x, y };
    const r = toRect(x); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  };

  // ════════════════════════════════ HOOK ════════════════════════════════
  let hookState = null;
  const SIZES = { xxl: 200, xl: 172, l: 138, m: 104, s: 64 };
  // scrim: 'radial' (default, for the aurora sky) | 'band' (a strong horizontal band: text over the live app UI)
  ov.hook = async (lines, { delay = 0, ms = 0, backdrop: bd = 'aurora', stagger = 24, lineGap = 560, amp = 1, lift = .30, beam: useBeam = true, backdropMs = 0, y = 0, restartSky = true, push = true, maxWidth = 1740, scrim = 'radial' } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return;
    if (hookState) { hookState.box.remove(); hookState = null; }
    lines = (Array.isArray(lines) ? lines : [lines]).map(l => (typeof l === 'string' ? { en: l, zh: l } : l));
    await glyphs(lines.map(l => pick(l, ov.lang)).join(''), ['800', '600']);
    if (my !== epoch) return;
    const box = mk('ovl-layer ovl-hook' + (scrim === 'band' ? ' ovl-hook--band' : ''), L.hook);
    if (y) box.style.transform = `translateY(${y}px)`;
    const scrimEl = mk('ovl-hook__scrim', box);
    anim(scrimEl, [{ opacity: 0 }, { opacity: 1 }], { ms: scrim === 'band' ? 300 : 500, easing: 'ease-out' });
    const made = lines.map((ln, i) => {
      const key = ln.key ?? (lines.length === 1 || (i === lines.length - 1 && !lines.some(x => x.key)));
      const size = SIZES[ln.size] || (typeof ln.size === 'number' ? ln.size : key ? SIZES.xl : SIZES.l);
      const d = mk('ovl-hook__line' + (key ? ' is-key' : '') + (ln.soft ? ' is-soft' : ''), box);
      d.style.fontSize = size + 'px';
      const str = pick(ln, ov.lang);
      const { units, runs } = split(d, str, { by: 'char', hlAll: key });
      return { d, units, runs, key, size };
    });
    // fit each line to the safe width, then map gradients
    for (const m of made) {
      const wpx = m.d.scrollWidth;
      if (wpx > maxWidth) m.d.style.fontSize = Math.floor(m.size * maxWidth / wpx) + 'px';
      mapGradient(m.runs, m.d);
    }
    if (bd === 'aurora') {
      if (!backdrop.visible || backdrop.el.style.opacity !== '1') {
        if (restartSky) backdrop.restart();
        if (backdropMs) backdrop.show({ ms: backdropMs, amp, lift, owner: 'hook' }); else backdrop.now({ amp, lift, owner: 'hook' });
      }
      else { backdrop.owner = 'hook'; if (backdrop.parked) backdrop.restart(); } // e.g. continuing from a looped-out end card
    } else if (bd === 'dim') anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 1 }], { ms: 400 });
    hookState = { box, made, bd, scrimEl };
    if (push) anim(box, [{ transform: `translateY(${y}px) scale(1.06)` }, { transform: `translateY(${y}px) scale(1)` }], { ms: 3600, easing: 'cubic-bezier(.2,.6,.2,1)' });
    let end = 0;
    const track = ov.lang === 'zh' ? '.02em' : '-.035em';
    made.forEach((m, i) => {
      const t0 = i * lineGap;
      m.units.forEach((u, j) => {
        anim(u, [{ opacity: 0, transform: 'translate3d(0,.40em,0) scale(1.08)', filter: 'blur(18px)' },
          { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 820, delay: t0 + j * stagger, easing: css.out });
      });
      anim(m.d, [{ letterSpacing: ov.lang === 'zh' ? '.16em' : '.06em' }, { letterSpacing: track }], { ms: 1300, delay: t0, easing: css.out });
      const revealEnd = t0 + m.units.length * stagger + 820;
      end = Math.max(end, revealEnd);
      if (m.key) {
        const streak = mk('ovl-hook__streak', m.d);
        anim(streak, [{ opacity: 0, transform: 'scaleX(0)' }, { opacity: 1, transform: 'scaleX(.55)', offset: .45 }, { opacity: 0, transform: 'scaleX(1)' }], { ms: 1500, delay: t0 + 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
        const lw = m.d.offsetWidth;
        anim(m.d, [{ '--sweep': '-400px' }, { '--sweep': (lw + 400) + 'px' }], { ms: 1400, delay: t0 + Math.min(m.units.length * stagger, 500) + 260, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
        if (useBeam) anim(beam, [{ opacity: 0, transform: 'translateX(-1100px) rotate(14deg)' }, { opacity: 1, offset: .3 }, { opacity: 0, transform: 'translateX(2300px) rotate(14deg)' }], { ms: 1700, delay: t0 + 120, easing: 'cubic-bezier(.4,0,.3,1)', fill: 'none' });
      }
    });
    await wait(end);
    if (ms) await wait(ms);
  };
  ov.clearHook = async ({ ms = 520, delay = 0, reveal = 'iris' } = {}) => {
    if (delay) await wait(delay);
    const h = hookState; if (!h) return;
    hookState = null;
    const all = h.made.flatMap(m => m.units);
    anim(h.scrimEl, [{ opacity: 1 }, { opacity: 0 }], { ms: ms + 200, easing: 'ease-in' });
    all.forEach((u, j) => anim(u, [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'translate3d(0,-.28em,0) scale(.98)', filter: 'blur(16px)' }], { ms, delay: j * 7, easing: css.in }));
    const bdDone = backdrop.owner === 'hook' && reveal !== 'none' ? backdrop.hide({ ms: ms + 520, delay: ms * .35, iris: reveal === 'iris' }) : Promise.resolve();
    if (h.bd === 'dim') anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 0 }], { ms: ms + 300 });
    await wait(ms + all.length * 7);
    h.box.remove();
    await bdDone;
  };

  // ════════════════════════════════ CAPTIONS ════════════════════════════════
  const capQ = {}; const capLive = new Set();
  const scrims = {};
  const scrimFor = pos => scrims[pos] || (scrims[pos] = mk(`ovl-layer ovl-scrim ovl-scrim--${pos}`, L.scrim));
  let scrimCount = { top: 0, bottom: 0, center: 0 };
  ov.caption = (text, opts = {}) => {
    const pos = opts.position || 'bottom';
    const my = epoch;
    const p = (capQ[pos] || Promise.resolve()).then(() => (my === epoch ? showCaption(text, opts) : null));
    capQ[pos] = p.catch(() => {});
    return p;
  };
  const showCaption = async (text, { ms = 2400, delay = 0, position = 'bottom', style = 'label', kicker, persist = false, scrim, stagger } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return;
    await glyphs(pick(text, ov.lang) + pick(kicker, ov.lang), style === 'statement' ? ['780', '600'] : ['650', '600']);
    if (my !== epoch) return;
    const slot = mk(`ovl-cap-slot ovl-cap-slot--${position}`, L.captions);
    const cap = mk(`ovl-cap ovl-cap--${style}`, slot);
    let body = cap;
    if (style === 'label') { mk('ovl-cap__dot', cap); body = mk('ovl-cap__body', cap); }
    if (kicker) { const k = mk('ovl-cap__kicker', body); const s = doc.createElement('span'); s.className = 'ovl-gradtext'; s.textContent = pick(kicker, ov.lang); k.appendChild(s); }
    const tx = mk('ovl-cap__text', body);
    const { units, runs } = split(tx, pick(text, ov.lang), { by: ov.lang === 'zh' ? 'char' : 'word' });
    mapGradient(runs, tx);
    const useScrim = scrim ?? style === 'statement';
    const rec = { slot, cap, units, position, useScrim, persist };
    const handle = { el: cap, remove: ({ ms: out = 420 } = {}) => removeCaption(rec, out) };
    capLive.add(rec);
    if (useScrim) { scrimCount[position]++; const s = scrimFor(position); anim(s, [{ opacity: getComputedStyle(s).opacity }, { opacity: 1 }], { ms: 450, easing: 'ease-out' }); }
    const st = stagger ?? (style === 'statement' ? (ov.lang === 'zh' ? 34 : 60) : (ov.lang === 'zh' ? 22 : 40));
    const fromY = position === 'top' ? '-26px' : '26px';
    anim(cap, [{ opacity: 0, transform: `translateY(${fromY}) scale(.965)`, filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 620, easing: css.out });
    units.forEach((u, j) => anim(u, [{ opacity: 0, transform: 'translate3d(0,.45em,0)', filter: 'blur(10px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 640, delay: 90 + j * st, easing: css.out }));
    for (const run of runs) {
      const w = parseFloat(run[0].style.getPropertyValue('--rw')) || 600;
      run.forEach(u => anim(u, [{ '--sweep': '-400px' }, { '--sweep': (w + 400) + 'px' }], { ms: 1200, delay: 380 + units.length * st, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' }));
    }
    const inMs = 90 + units.length * st + 640;
    await wait(inMs);
    if (persist || !(ms > 0) || ms === Infinity) { rec.persist = true; return handle; }
    await wait(ms);
    if (rec.slot.isConnected) await removeCaption(rec);
    return handle;
  };
  const removeCaption = async (rec, outMs = 420) => {
    if (!capLive.has(rec)) return;
    capLive.delete(rec);
    anim(rec.cap, [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'translateY(-14px) scale(.985)', filter: 'blur(14px)' }], { ms: outMs, easing: css.in });
    if (rec.useScrim && --scrimCount[rec.position] <= 0) { scrimCount[rec.position] = 0; const s = scrimFor(rec.position); anim(s, [{ opacity: getComputedStyle(s).opacity }, { opacity: 0 }], { ms: outMs + 200 }); }
    await wait(outMs);
    rec.slot.remove();
  };
  ov.clearCaptions = async ({ ms = 420 } = {}) => {
    for (const k of Object.keys(capQ)) capQ[k] = null;
    await Promise.all([...capLive].map(r => removeCaption(r, ms)));
  };

  // ════════════════════════════════ BADGES ════════════════════════════════
  const stacks = {};
  const stackFor = pos => stacks[pos] || (stacks[pos] = mk(`ovl-badge-stack ovl-badge-stack--${pos}`, L.badges));
  const badgeLive = new Set();
  ov.badge = async (text, { icon = 'auto', position = 'top-right', ms, delay = 0, eq, big = false } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    let str = pick(text, ov.lang);
    await glyphs(str, ['650']);
    let ic = icon;
    const m = str.match(/^\s*(🔊|🔉|🔈|🎧|✨|✦|✓|✔️?)\s*/u);
    if (m) { str = str.slice(m[0].length); if (ic === 'auto') ic = /🔊|🔉|🔈|🎧/u.test(m[1]) ? 'sound' : /✓|✔/u.test(m[1]) ? 'check' : 'spark'; }
    if (ic === 'auto') ic = 'none';
    const b = mk('ovl-badge' + (ic === 'none' ? ' ovl-badge--plain' : '') + (big ? ' ovl-badge--big' : ''), stackFor(position));
    if (ic !== 'none') {
      const i = mk('ovl-badge__ic', b); const id = 'ovl-bg-' + (++uid);
      i.innerHTML = ic === 'sound' ? SOUND_SVG(id) : ic === 'check' ? CHECK_SVG(id) : SPARK_SVG(id);
    }
    const t = doc.createElement('span'); b.appendChild(t);
    if (typeof text === 'object' && !m) bi(t, text); else t.textContent = str;
    if (eq ?? ic === 'sound') { const q = mk('ovl-badge__eq', b); q.innerHTML = '<i></i><i></i><i></i><i></i>'; }
    const handle = { el: b, remove: async ({ ms: out = 380 } = {}) => {
      if (!badgeLive.has(handle)) return; badgeLive.delete(handle);
      await anim(b, [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'translateY(-10px) scale(.94)', filter: 'blur(8px)' }], { ms: out, easing: css.in });
      b.remove();
    } };
    badgeLive.add(handle);
    await anim(b, [{ opacity: 0, transform: 'translateY(-16px) scale(.86)', filter: 'blur(10px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 650, easing: css.spring });
    if (ms > 0 && ms !== Infinity) { await wait(ms); await handle.remove(); }
    return handle;
  };

  // ════════════════════════════════ TAGS ════════════════════════════════
  // ov.tag(text, { x, y, size, delay }) — a big bold label pill at a fixed stage position (e.g. a quadrant title that
  // must stay legible after the edit scales the shot down). Persistent until ov.clear() / handle.remove().
  const tagLive = new Set();
  ov.tag = async (text, { x = 64, y = 56, size = 96, delay = 0 } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    await glyphs(pick(text, ov.lang), ['800']);
    const t = mk('ovl-tag', L.badges);
    t.style.left = x + 'px'; t.style.top = y + 'px'; t.style.fontSize = size + 'px';
    const { runs } = split(t, pick(text, ov.lang), { by: 'word', hlAll: false });
    mapGradient(runs, t);
    const handle = { el: t, remove: async ({ ms: out = 0 } = {}) => { tagLive.delete(handle); if (out) await anim(t, [{ opacity: 1 }, { opacity: 0 }], { ms: out }); t.remove(); } };
    tagLive.add(handle);
    await anim(t, [{ opacity: 0, transform: 'translateY(-14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { ms: 380, easing: css.out });
    return handle;
  };

  // ════════════════════════════════ NUMBERS ════════════════════════════════
  // Odometer: one strip (0-9,0) per digit; lower digits spin, higher digits roll on carry.
  const buildNum = (parent, { value, prefix = '', suffix = '', decimals = 0, size = 240, sep = ',' }) => {
    const root = mk('ovl-num', parent); root.style.fontSize = size + 'px';
    const scaled = Math.round(Math.abs(value) * 10 ** decimals);
    const nd = Math.max(1 + decimals, String(scaled).length);
    const parts = []; const slots = [];
    const addFix = (s, kind) => { if (!s) return; const f = mk('ovl-num__fix ovl-num__fix--' + kind, root); f.textContent = s; parts.push(f); };
    addFix(prefix, 'prefix');
    for (let i = nd - 1; i >= 0; i--) {
      const s = mk('ovl-num__slot', root);
      const strip = mk('ovl-num__strip', s); strip.innerHTML = '<span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span><span>0</span>';
      slots.push({ place: i, s, strip });
      parts.push(s);
      if (i === decimals && decimals > 0) { const d = mk('ovl-num__sep', root); d.textContent = '.'; d.dataset.place = i; parts.push(d); slots.at(-1).sepAfter = d; }
      else if (i > decimals && (i - decimals) % 3 === 0) { const d = mk('ovl-num__sep', root); d.textContent = sep; d.dataset.place = i; slots.at(-1).sepAfter = d; parts.push(d); }
    }
    addFix(suffix, 'suffix');
    // continuous gradient across the whole number
    const run = parts.map(p => p.classList.contains('ovl-num__slot') ? p.firstChild : p);
    run.forEach(x => x.classList.add('ovl-gradtext'));
    const setGrad = () => {
      const rb = root.getBoundingClientRect(); const s = rb.width / (root.offsetWidth || 1) || 1;
      const lw = root.offsetWidth;
      run.forEach(x => { const host = x.classList.contains('ovl-num__strip') ? x.parentElement : x; x.style.setProperty('--rw', lw + 'px'); x.style.setProperty('--rx', ((host.getBoundingClientRect().left - rb.left) / s).toFixed(1) + 'px'); });
    };
    const set = (v, spin = 0) => {
      const iv = Math.max(0, v * 10 ** decimals);
      for (const sl of slots) {
        const p10 = 10 ** sl.place;
        let pos;
        if (sl.place === 0) pos = iv % 10;
        else { const lower = iv % p10; pos = Math.floor(iv / p10) % 10 + clamp(lower - (p10 - 1)); }
        if (spin) pos = (pos + spin * 10 * (1 + sl.place * .35)) % 10;
        sl.strip.style.transform = `translate3d(0,${(-pos).toFixed(4)}em,0)`;
        const vis = sl.place <= decimals || spin ? 1 : clamp(iv - (p10 - 1));
        sl.s.style.opacity = vis.toFixed(3);
        if (sl.sepAfter) sl.sepAfter.style.opacity = vis.toFixed(3);
      }
    };
    return { root, set, setGrad, slots };
  };

  const counterLive = new Set();
  ov.counter = async ({ value, label, sub, prefix, suffix, from = 0, decimals = 0, ms = 1600, delay = 0, x = W / 2, y = H / 2, size = 250, hold, dim: useDim = false, easing } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    const box = mk('ovl-counter', L.counters); box.style.left = x + 'px'; box.style.top = y + 'px';
    const num = buildNum(box, { value, prefix, suffix, decimals, size });
    if (label) bi(mk('ovl-counter__label', box), label);
    if (sub) bi(mk('ovl-counter__sub', box), sub);
    num.setGrad();
    num.set(from);
    if (useDim) anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 1 }], { ms: 400 });
    anim(box, [{ opacity: 0, transform: 'translate(-50%,-50%) translateY(40px) scale(.92)', filter: 'blur(14px)' }, { opacity: 1, transform: 'translate(-50%,-50%)', filter: 'blur(0px)' }], { ms: 700, easing: css.out });
    const zero = value === from;
    // a value that does not count (e.g. 0) is shown as itself from the first frame and pops — it never spins
    // through other digits (a paused frame must never read "4 dependencies" on the way to 0)
    if (zero) { num.set(value); await anim(num.root, [{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { ms: 520, delay: 150, easing: css.spring }); }
    else await engine.tween({ ms, delay: 150, easing: easing || ease.outExpo, update: p => num.set(lerp(from, value, p)) });
    num.set(value);
    anim(num.root, [{ filter: 'drop-shadow(0 0 36px rgba(92,242,255,.22)) brightness(1)' }, { filter: 'drop-shadow(0 0 60px rgba(92,242,255,.65)) brightness(1.25)', offset: .25 }, { filter: 'drop-shadow(0 0 36px rgba(92,242,255,.22)) brightness(1)' }], { ms: 800, fill: 'none' });
    const handle = { el: box, remove: async ({ ms: out = 450 } = {}) => {
      if (!counterLive.has(handle)) return; counterLive.delete(handle);
      await anim(box, [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(12px)' }], { ms: out, easing: css.in });
      box.remove();
      if (useDim && ![...counterLive].some(h => h.dim)) anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 0 }], { ms: out });
    }, dim: useDim };
    counterLive.add(handle);
    if (hold > 0) { await wait(hold); await handle.remove(); }
    return handle;
  };

  ov.stats = async (items, { ms = 1700, delay = 0, stagger = 150, title, hold, dim: useDim = true, size = 144, y = 0, cols } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    const box = mk('ovl-layer ovl-stats', L.stats);
    if (y) box.style.transform = `translateY(${y}px)`;
    if (title) { const t = mk('ovl-stats__title', box); const s = doc.createElement('span'); s.className = 'ovl-gradtext'; bi(s, title); t.appendChild(s); }
    const grid = mk('ovl-stats__grid', box);
    grid.style.display = 'flex'; grid.style.flexWrap = 'wrap'; grid.style.maxWidth = cols ? `${cols * 540 + (cols - 1) * 30 + 40}px` : '1760px';
    const tiles = items.map(it => {
      const tile = mk('ovl-stat', grid);
      const num = buildNum(tile, { ...it, size: it.size || size });
      if (it.label) bi(mk('ovl-counter__label', tile), it.label);
      if (it.sub) bi(mk('ovl-counter__sub', tile), it.sub);
      return { tile, num, it };
    });
    if (useDim) anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 1 }], { ms: 450 });
    tiles.forEach(t => { t.num.setGrad(); t.num.set(t.it.from ?? 0); });
    const runs = tiles.map((t, i) => {
      const d = i * stagger;
      const from = t.it.from ?? 0; const zero = t.it.value === from;
      if (zero) {
        // shown as its final value from its first frame: a scale-pop, never a slot roll
        t.num.set(t.it.value);
        anim(t.tile, [{ opacity: 0, transform: 'scale(.8)', filter: 'blur(10px)' }, { opacity: 1, transform: 'scale(1.06)', filter: 'blur(0px)', offset: .55 }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 560, delay: d, easing: css.out });
        anim(t.num.root, [{ transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { ms: 620, delay: d, easing: css.spring });
        return engine.wait(d + 300).then(() => anim(t.tile, [{ '--glow': 0 }, { '--glow': 1, offset: .2 }, { '--glow': 0 }], { ms: 900, fill: 'none' }));
      }
      anim(t.tile, [{ opacity: 0, transform: 'translateY(46px) scale(.93)', filter: 'blur(14px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 760, delay: d, easing: css.out });
      return engine.tween({ ms: t.it.ms || ms, delay: d + 180, easing: ease.outExpo, update: p => t.num.set(lerp(from, t.it.value, p)) })
        .then(() => { t.num.set(t.it.value); return anim(t.tile, [{ '--glow': 0 }, { '--glow': 1, offset: .2 }, { '--glow': 0 }], { ms: 900, fill: 'none' }); });
    });
    await Promise.all(runs);
    const handle = { el: box, remove: async ({ ms: out = 500 } = {}) => {
      if (!box.isConnected) return;
      tiles.forEach((t, i) => anim(t.tile, [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'translateY(-20px) scale(.97)', filter: 'blur(12px)' }], { ms: out, delay: i * 40, easing: css.in }));
      if (useDim) anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 0 }], { ms: out + 200 });
      await wait(out + tiles.length * 40);
      box.remove();
    } };
    statsLive.add(handle);
    if (hold > 0) { await wait(hold); await handle.remove(); statsLive.delete(handle); }
    return handle;
  };
  const statsLive = new Set();

  // ════════════════════════════════ SWARM ════════════════════════════════
  ov.swarm = async (opts = {}) => {
    const my = epoch;
    await swarmer.play({ lang: ov.lang, pixelRatio, ...opts });
    if (my !== epoch) return null;
    const handle = { remove: o => swarmer.clear(o) };
    if (opts.hold > 0) { await wait(opts.hold); await swarmer.clear(); }
    return handle;
  };
  ov.clearSwarm = o => swarmer.clear(o);

  // ════════════════════════════════ CURSOR ════════════════════════════════
  const cur = mk('ovl-cursor', L.cursor);
  mk('ovl-cursor__halo', cur);
  const arrow = mk('ovl-cursor__arrow', cur, ARROW_SVG);
  const cs = { x: W * .62, y: H * .72, vis: false, rot: 0, press: 1 };
  const place = () => { cur.style.transform = `translate3d(${cs.x.toFixed(2)}px, ${cs.y.toFixed(2)}px, 0)`; arrow.style.transform = `rotate(${cs.rot.toFixed(2)}deg) scale(${cs.press.toFixed(3)})`; };
  place();
  const cursor = ov.cursor = {
    get x() { return cs.x; }, get y() { return cs.y; },
    async show({ ms = 260, x, y } = {}) {
      if (x != null) { const p = toPoint(x, y); cs.x = p.x; cs.y = p.y; place(); }
      if (cs.vis) return; cs.vis = true;
      await anim(cur, [{ opacity: 0 }, { opacity: 1 }], { ms, easing: 'ease-out' });
    },
    async hide({ ms = 300 } = {}) {
      if (!cs.vis) return; cs.vis = false;
      await anim(cur, [{ opacity: getComputedStyle(cur).opacity }, { opacity: 0 }], { ms, easing: 'ease-in' });
    },
    async moveTo(x, y, o) {
      let p, opts;
      if (typeof x === 'number') { p = { x, y }; opts = typeof o === 'number' ? { ms: o } : (o || {}); }
      else { p = toPoint(x); opts = typeof y === 'number' ? { ms: y } : (y || {}); }
      if (!p) return;
      if (opts.delay) await wait(opts.delay);
      if (!cs.vis) await cursor.show({ ms: 200 });
      const x0 = cs.x, y0 = cs.y, dx = p.x - x0, dy = p.y - y0, dist = Math.hypot(dx, dy);
      if (dist < 4) { cs.x = p.x; cs.y = p.y; place(); return; }
      const ms = opts.ms ?? clamp(300 + dist * .38, 320, 950);
      const arc = opts.arc ?? .12;
      const cx = x0 + dx / 2 - dy * arc, cy = y0 + dy / 2 + dx * arc;
      let px = x0;
      await engine.tween({ ms, easing: opts.ease || ease.inOutCubic, update: (t, raw) => {
        const u = 1 - t;
        cs.x = u * u * x0 + 2 * u * t * cx + t * t * p.x; cs.y = u * u * y0 + 2 * u * t * cy + t * t * p.y;
        const vx = cs.x - px; px = cs.x;
        cs.rot = lerp(cs.rot, clamp(vx * .9, -14, 14) * (1 - raw), .3);
        place();
      } });
      cs.x = p.x; cs.y = p.y; cs.rot = 0; place();
    },
    /** click(x, y, {ms, delay, onPress}) — glide there (if needed), press, ripple. onPress fires at the press
        instant (use it to fire the real click); the promise resolves ~0.3 s later while the ripple keeps going. */
    async click(x, y, o = {}) {
      let opts = o;
      if (x != null && typeof x !== 'number') { opts = y || {}; await cursor.moveTo(x, { ms: opts.ms, delay: opts.delay }); }
      else if (x != null) { await cursor.moveTo(x, y, { ms: opts.ms, delay: opts.delay }); }
      else if (!cs.vis) await cursor.show();
      await engine.tween({ ms: 80, easing: ease.outCubic, update: t => { cs.press = 1 - .2 * t; place(); } });
      opts.onPress?.();
      const rip = (cls, d, size) => {
        const r = mk('ovl-ripple ' + cls, L.cursor); r.style.left = cs.x + 'px'; r.style.top = cs.y + 'px';
        return anim(r, [{ opacity: 1, transform: 'scale(.12)' }, { opacity: 0, transform: `scale(${size})` }], { ms: 720, delay: d, easing: css.out }).then(() => r.remove());
      };
      rip('ovl-ripple--dot', 0, 1.6); rip('', 0, 1); rip('ovl-ripple--b', 110, 1.35);
      await engine.tween({ ms: 240, easing: ease.outBack, update: t => { cs.press = .8 + .2 * t; place(); } });
    },
  };

  // ════════════════════════════════ SPOTLIGHT / RING ════════════════════════════════
  const spot = mk('ovl-spot', L.spot);
  const ss = { x: 0, y: 0, w: W, h: H, r: 20, on: false, gen: 0 };
  const placeSpot = () => { spot.style.transform = `translate(${ss.x.toFixed(1)}px, ${ss.y.toFixed(1)}px)`; spot.style.width = ss.w.toFixed(1) + 'px'; spot.style.height = ss.h.toFixed(1) + 'px'; spot.style.borderRadius = ss.r + 'px'; };
  ov.spotlight = async (target, { ms = 650, pad = 18, radius = 22, dim: d = .64, delay = 0 } = {}) => {
    if (delay) await wait(delay);
    const gen = ++ss.gen;
    if (!target) {
      if (!ss.on) return; ss.on = false;
      await anim(spot, [{ opacity: getComputedStyle(spot).opacity }, { opacity: 0 }], { ms: Math.min(ms, 500), easing: 'ease-in-out' });
      return;
    }
    const r = toRect(target); if (!r) return;
    const tg = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    spot.style.setProperty('--dim', d);
    if (!ss.on) { ss.x = tg.x - 260; ss.y = tg.y - 200; ss.w = tg.w + 520; ss.h = tg.h + 400; ss.r = radius + 60; placeSpot(); ss.on = true; anim(spot, [{ opacity: 0 }, { opacity: 1 }], { ms: ms * .8, easing: 'ease-out' }); }
    const f = { ...ss };
    await engine.tween({ ms, easing: ease.inOutCubic, update: p => {
      if (gen !== ss.gen) return;
      ss.x = lerp(f.x, tg.x, p); ss.y = lerp(f.y, tg.y, p); ss.w = lerp(f.w, tg.w, p); ss.h = lerp(f.h, tg.h, p); ss.r = lerp(f.r, radius, p); placeSpot();
    } });
  };
  const ringLive = new Set();
  ov.highlightRing = async (target, { ms = 750, pad = 12, radius = 18, hold, delay = 0, label, labelPos = 'above', pulse = true } = {}) => {
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    const r = toRect(target); if (!r) return null;
    const w = r.w + pad * 2, h = r.h + pad * 2;
    const box = mk('ovl-ring', L.rings);
    Object.assign(box.style, { transform: `translate(${r.x - pad}px, ${r.y - pad}px)`, width: w + 'px', height: h + 'px', borderRadius: radius + 'px' });
    const id = 'ovl-rg-' + (++uid);
    box.innerHTML = `<div class="ovl-ring__glow"></div><svg viewBox="-40 -40 ${w + 80} ${h + 80}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ef0b0"/><stop offset=".35" stop-color="#5cf2ff"/><stop offset=".7" stop-color="#a78bfa"/><stop offset="1" stop-color="#ff6bd6"/></linearGradient>
      <filter id="${id}b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter></defs>
      <rect class="g" x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="none" stroke="url(#${id})" stroke-width="10" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" filter="url(#${id}b)" opacity=".85"/>
      <rect class="s" x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="none" stroke="url(#${id})" stroke-width="4.5" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"/></svg>`;
    const glow = box.firstChild;
    let tag = null;
    if (label) { tag = mk('ovl-ring__tag' + (labelPos === 'below' ? ' is-below' : ''), box); bi(tag, label); }
    const rects = box.querySelectorAll('rect');
    rects.forEach(rc => anim(rc, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { ms, easing: 'cubic-bezier(.5,0,.2,1)' }));
    anim(glow, [{ opacity: 0 }, { opacity: 1 }], { ms: ms * .8, delay: ms * .5, easing: 'ease-out' });
    if (tag) anim(tag, [{ opacity: 0, transform: `translateX(-50%) translateY(${labelPos === 'below' ? -12 : 12}px) scale(.9)` }, { opacity: 1, transform: 'translateX(-50%)' }], { ms: 600, delay: ms * .55, easing: css.spring });
    await wait(ms + 150);
    let pulseAnim = null;
    if (pulse) pulseAnim = glow.animate([{ opacity: 1 }, { opacity: .45 }, { opacity: 1 }], { duration: 1600, iterations: Infinity, easing: 'ease-in-out' });
    const handle = { el: box, remove: async ({ ms: out = 380 } = {}) => {
      if (!ringLive.has(handle)) return; ringLive.delete(handle);
      pulseAnim?.cancel();
      await anim(box, [{ opacity: 1, transform: box.style.transform + ' scale(1)' }, { opacity: 0, transform: box.style.transform + ' scale(1.03)' }], { ms: out, easing: css.in });
      box.remove();
    } };
    ringLive.add(handle);
    if (hold > 0) { await wait(hold); await handle.remove(); }
    return handle;
  };

  // ════════════════════════════════ FLASH ════════════════════════════════
  const flashes = [];
  ov.flash = async (opacity = .45, ms = 480, { color = 'aurora', delay = 0 } = {}) => {
    if (typeof ms === 'object') { ({ ms = 480, color = 'aurora', delay = 0 } = ms); }
    if (delay) await wait(delay);
    const now = engine.now();
    while (flashes.length && now - flashes[0] > 1000) flashes.shift();
    if (flashes.length >= 3) { console.warn('[overlay] flash skipped: photosensitivity limit (max 3 per second)'); return false; }
    flashes.push(now);
    const o = Math.min(opacity, color === 'white' ? .55 : .8);
    const f = mk('ovl-layer ovl-flash ovl-flash--' + color, L.flash);
    await anim(f, [{ opacity: 0 }, { opacity: o, offset: .14 }, { opacity: 0 }], { ms: Math.max(220, ms), easing: 'cubic-bezier(.2,.6,.3,1)' });
    f.remove();
    return true;
  };

  // ════════════════════════════════ END CARD ════════════════════════════════
  let endState = null;
  ov.endCard = async ({ lang: l, ms, delay = 0, tagline, built, facts = true, loopOut = false, amp = 1, lift = .30 } = {}) => {
    if (l && l !== ov.lang) ov.setLang(l);
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    await glyphs(pick(tagline || STR.tagline, ov.lang) + pick(built || STR.built, ov.lang) + pick(facts === true ? STR.facts : facts || '', ov.lang), ['500', '600', '800']);
    if (my !== epoch) return null;
    if (endState) { endState.box.remove(); endState = null; }
    backdrop.show({ ms: 900, amp, lift, owner: 'end' });
    const box = mk('ovl-layer ovl-end', L.end);
    const scrimEl = mk('ovl-hook__scrim', box);
    anim(scrimEl, [{ opacity: 0 }, { opacity: 1 }], { ms: 900, easing: 'ease-out' });
    const logo = mk('ovl-end__logo', box);
    const w = mk('ovl-end__w', logo);
    const { units, runs } = split(w, 'AURORA', { by: 'char', hlAll: true });
    const z = mk('ovl-end__z', logo); z.textContent = '極光';
    const tag = mk('ovl-end__tag', box); tag.textContent = pick(tagline || STR.tagline, ov.lang);
    const pill = mk('ovl-end__built', box);
    const sp = doc.createElement('span'); sp.className = 'ovl-end__spark'; sp.innerHTML = SPARK_SVG('ovl-sp-' + (++uid)); pill.appendChild(sp);
    const bt = doc.createElement('span'); bt.innerHTML = pick(built || STR.built, ov.lang); pill.appendChild(bt);
    let fx = null;
    if (facts) { fx = mk('ovl-end__facts', box); fx.innerHTML = pick(facts === true ? STR.facts : facts, ov.lang); }
    mapGradient(runs, w);
    endState = { box };
    units.forEach((u, j) => anim(u, [{ opacity: 0, transform: 'translate3d(0,.3em,0) scale(1.15)', filter: 'blur(22px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 1000, delay: 120 + j * 70, easing: css.out }));
    anim(w, [{ letterSpacing: '.42em', marginRight: '-.42em' }, { letterSpacing: '.18em', marginRight: '-.18em' }], { ms: 1500, delay: 60, easing: css.out });
    anim(z, [{ opacity: 0, transform: 'translateY(20px)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 900, delay: 620, easing: css.out });
    const lw = w.offsetWidth;
    anim(w, [{ '--sweep': '-500px' }, { '--sweep': (lw + 500) + 'px' }], { ms: 1600, delay: 700, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    anim(tag, [{ opacity: 0, transform: 'translateY(22px)', filter: 'blur(10px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 800, delay: 820, easing: css.out });
    anim(pill, [{ opacity: 0, transform: 'translateY(26px) scale(.9)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 800, delay: 1180, easing: css.spring });
    anim(pill, [{ '--gx': '-300px' }, { '--gx': '1200px' }], { ms: 1300, delay: 1750, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    if (fx) anim(fx, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { ms: 700, delay: 1600, easing: css.out });
    await wait(2300);
    const handle = { el: box, remove: async ({ ms: out = 700, keepBackdrop = false } = {}) => {
      if (!box.isConnected) return;
      await anim(box, [{ opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' }, { opacity: 0, filter: 'blur(18px)', transform: 'scale(.985)' }], { ms: out, easing: css.inOut });
      box.remove(); if (endState?.box === box) endState = null;
      if (!keepBackdrop && backdrop.owner === 'end') await backdrop.hide({ ms: 500 });
    } };
    endState.handle = handle;
    handle.loopOut = async ({ ms: out = 1400 } = {}) => { await Promise.all([handle.remove({ ms: Math.min(out, 900), keepBackdrop: true }), backdrop.loopBack(out)]); };
    if (ms > 0 && ms !== Infinity) { await wait(ms); if (loopOut) await handle.loopOut(); }
    return handle;
  };

  // ════════════════════════════════ TITLE (wordmark over the live app) ════════════════════════════════
  // ov.title({ sub, built, note, style: 'slam'|'rise', size = 210, scrim = true, y = 0, subDelay, builtDelay, ms })
  // The AURORA 極光 logotype without a backdrop of its own (the app's theater aurora shows through):
  // 'slam' = the whole word lands in ~190 ms (for a musical drop), 'rise' = letters blur in one by one.
  // Persistent: resolves after the intro → handle { el, remove({ms}) }; ov.clearTitle({ms}) removes it remotely.
  let titleState = null;
  ov.title = async ({ sub, built, note, style = 'slam', size = 210, subSize = 56, noteSize = 40, scrim = true, y = 0, delay = 0, subDelay = 900, builtDelay = 700, ms } = {}) => {
    // scrim: true (radial, over the aurora sky) | 'band' (a strong horizontal band: the wordmark over the live app UI)
    const my = epoch;
    if (delay) await wait(delay);
    if (my !== epoch) return null;
    await glyphs([sub, built, note].map(x => (x ? pick(x, ov.lang) : '')).join(''), ['500', '600', '800']);
    if (my !== epoch) return null;
    if (titleState) { titleState.box.remove(); titleState = null; }
    const box = mk('ovl-layer ovl-end ovl-title' + (scrim === 'band' ? ' ovl-hook--band' : ''), L.end);
    if (y) box.style.transform = `translateY(${y}px)`;
    let scrimEl = null;
    if (scrim) { scrimEl = mk('ovl-hook__scrim', box); anim(scrimEl, [{ opacity: 0 }, { opacity: 1 }], { ms: style === 'slam' ? 180 : 700, easing: 'ease-out' }); }
    const logo = mk('ovl-end__logo', box);
    logo.style.gap = Math.round(size * 0.16) + 'px';
    const w = mk('ovl-end__w', logo); w.style.fontSize = size + 'px';
    const { units, runs } = split(w, 'AURORA', { by: 'char', hlAll: true });
    const z = mk('ovl-end__z', logo); z.textContent = '極光'; z.style.fontSize = Math.round(size * 0.44) + 'px';
    let subEl = null, pill = null, noteEl = null;
    if (sub) { subEl = mk('ovl-end__tag ovl-title__sub', box); subEl.innerHTML = pick(sub, ov.lang); subEl.style.fontSize = subSize + 'px'; }
    if (built) {
      pill = mk('ovl-end__built ovl-title__built', box);
      const sp = doc.createElement('span'); sp.className = 'ovl-end__spark'; sp.innerHTML = SPARK_SVG('ovl-sp-' + (++uid)); pill.appendChild(sp);
      const bt = doc.createElement('span'); bt.innerHTML = pick(built, ov.lang); pill.appendChild(bt);
    }
    if (note) { noteEl = mk('ovl-end__facts ovl-title__note', box); noteEl.innerHTML = pick(note, ov.lang); noteEl.style.fontSize = noteSize + 'px'; }
    mapGradient(runs, w);
    const lw = w.offsetWidth;
    if (style === 'slam') {
      // compositor-only (opacity/transform): the drop is the busiest frame of the film (pillars, flash, camera cut)
      anim(logo, [{ opacity: 0, transform: 'scale(1.22)' }, { opacity: 1, transform: 'scale(1)', offset: .55 }, { opacity: 1, transform: 'scale(.985)' }], { ms: 260, easing: 'cubic-bezier(.2,.9,.25,1)' });
      anim(box, [{ transform: `translateY(${y}px) scale(1)` }, { transform: `translateY(${y}px) scale(1.04)` }], { ms: 2600, delay: 260, easing: 'cubic-bezier(.2,.5,.3,1)', fill: 'forwards' });
      anim(w, [{ '--sweep': '-500px' }, { '--sweep': (lw + 500) + 'px' }], { ms: 1100, delay: 90, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    } else {
      units.forEach((u, j) => anim(u, [{ opacity: 0, transform: 'translate3d(0,.3em,0) scale(1.15)', filter: 'blur(22px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 800, delay: j * 55, easing: css.out }));
      anim(w, [{ letterSpacing: '.36em', marginRight: '-.36em' }, { letterSpacing: '.18em', marginRight: '-.18em' }], { ms: 1300, easing: css.out });
      anim(z, [{ opacity: 0, transform: 'translateY(20px)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 800, delay: 380, easing: css.out });
      anim(w, [{ '--sweep': '-500px' }, { '--sweep': (lw + 500) + 'px' }], { ms: 1400, delay: 450, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    }
    if (subEl) anim(subEl, [{ opacity: 0, transform: 'translateY(22px)', filter: 'blur(10px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 520, delay: subDelay, easing: css.out });
    if (pill) {
      anim(pill, [{ opacity: 0, transform: 'translateY(26px) scale(.9)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { ms: 700, delay: builtDelay, easing: css.spring });
      anim(pill, [{ '--gx': '-300px' }, { '--gx': '1200px' }], { ms: 1300, delay: builtDelay + 500, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    }
    if (noteEl) anim(noteEl, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { ms: 600, delay: builtDelay + 350, easing: css.out });
    const handle = { el: box, remove: async ({ ms: out = 420 } = {}) => {
      if (!box.isConnected) return;
      const k = getComputedStyle(box).transform;
      await anim(box, [{ opacity: 1, transform: k === 'none' ? 'none' : k }, { opacity: 0, transform: (k === 'none' ? '' : k + ' ') + 'translateY(-12px)' }], { ms: out, easing: css.inOut });
      box.remove(); if (titleState?.box === box) titleState = null;
    } };
    titleState = { box, handle };
    await wait(style === 'slam' ? 200 : 900);
    if (ms > 0 && ms !== Infinity) { await wait(ms); await handle.remove(); }
    return handle;
  };
  ov.clearTitle = async (o) => { if (titleState) await titleState.handle.remove(o); };

  // ════════════════════════════════ GLOBAL ════════════════════════════════
  ov.dim = async (on = true, { ms = 450 } = {}) => anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: on ? (typeof on === 'number' ? on : 1) : 0 }], { ms });
  ov.wait = wait;
  ov.clear = async ({ ms = 500 } = {}) => {
    epoch++;
    const jobs = [];
    jobs.push(ov.clearHook({ ms, reveal: 'none' }));
    jobs.push(ov.clearCaptions({ ms }));
    for (const h of [...badgeLive]) jobs.push(h.remove({ ms }));
    for (const h of [...counterLive]) jobs.push(h.remove({ ms }));
    for (const h of [...statsLive]) { statsLive.delete(h); jobs.push(h.remove({ ms })); }
    for (const h of [...ringLive]) jobs.push(h.remove({ ms }));
    for (const h of [...tagLive]) jobs.push(h.remove({ ms }));
    if (swarmer.el) jobs.push(swarmer.clear({ ms }));
    if (endState?.handle) jobs.push(endState.handle.remove({ ms, keepBackdrop: true }));
    else if (endState) { endState.box.remove(); endState = null; }
    if (titleState) jobs.push(titleState.handle.remove({ ms }));
    jobs.push(ov.spotlight(null, { ms }));
    jobs.push(cursor.hide({ ms }));
    jobs.push(anim(dim, [{ opacity: getComputedStyle(dim).opacity }, { opacity: 0 }], { ms }));
    jobs.push(backdrop.hide({ ms }));
    await Promise.all(jobs);
  };
  // freeze()/thaw(): hold the whole overlay (WAAPI/CSS animations + engine clock) on the current frame —
  // for poster frames and exact-time verification screenshots.
  let frozenAnims = new Set();
  const pauseAll = () => { for (const a of doc.getAnimations()) if (a.playState === 'running' || a.playState === 'paused') { if (a.playState === 'running') a.pause(); frozenAnims.add(a); } };
  ov.freeze = () => { engine.freeze(); stepping.on = true; pauseAll(); };
  ov.thaw = () => {
    stepping.on = false;
    for (const a of frozenAnims) { try { if (a.playState === 'paused') a.play(); } catch {} }
    for (const a of doc.getAnimations()) { try { if (a.playState === 'paused') a.play(); } catch {} } // created while frozen
    frozenAnims.clear(); engine.thaw();
  };
  /** Deterministic frame stepping (call freeze() first): advance every animation + the engine clock by
      exactly `ms`, run one engine frame, and resolve after the DOM has settled — then capture a frame. */
  ov.step = async (ms = 1000 / 60) => {
    if (engine.frozen == null) ov.freeze();
    pauseAll();
    engine.frozen += ms;
    // iterate our own set too: a fill:none animation parked exactly at its end is no longer in getAnimations()
    for (const a of frozenAnims) {
      if (a.playState !== 'paused' || a.currentTime == null) { if (a.playState === 'finished' || a.playState === 'idle') frozenAnims.delete(a); continue; }
      const end = a.effect?.getComputedTiming?.().endTime;
      const next = a.currentTime + ms;
      if (Number.isFinite(end) && next >= end - .5) { try { a.finish(); } catch { a.currentTime = end; } frozenAnims.delete(a); }
      else a.currentTime = next;
    }
    engine._loop();
    // let promise continuations (awaited animations / waits) run and pause what they start
    for (let i = 0; i < 4; i++) { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); pauseAll(); }
    engine._loop(); pauseAll();
  };
  ov.perf = () => engine.perf();
  ov.perfReset = () => engine.perfReset();
  ov.destroy = () => { epoch++; swarmer.stop(true); ro?.disconnect(); el.remove(); links.forEach(l => l.remove()); engine.tickers.clear(); };
  return ov;
}

export default createOverlay;
