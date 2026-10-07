// AURORA 極光 — 自動演化 Auto-evolve.
// While on, the patch's macros and (optionally) a curated set of safe continuous params drift around the
// preset's committed values with smooth deterministic noise. Writes are transient (store.setTransientMany):
// knobs visibly move, nothing lands in undo history. ❄ Freeze keeps the current sound (one undo step);
// ■ Stop glides back to the preset. A small orbit visual shows every drifting param as a moon.
//
//   const evo = createEvolvePanel({ store, audio });  container.append(evo.el);  evo.stop();  evo.destroy();
//
// Safety: only params that glide cleanly are touched (no reverb size/decay, delay time, pitch, envelope or
// engine switches); cutoff/resonance stay inside musical bounds; a param the user (or the demo sequencer) moves
// is left alone for a moment and then eased back in; mood animations and exclusive tools (morph, A/B) pause it.

import { h, createScope, storage } from '../app/dom.js';
import { onLangChange } from '../app/i18n.js';
import { createSlider, createToggle } from '../components.js';
import { PARAM_BY_ID, toNorm, fromNorm } from '../../dsp/params.js';
import { driftNoise, reflect, evolveTargets } from '../../demo/drift.js';

export { driftNoise, evolveTargets };
import { ensureMagicStyles, biLabel, biText, biTitle, relabel, svgIcon, pill, ICON, L, createAuditionButton } from './smart.js';

const GROUP_META = {
  macros: { zh: '巨集', en: 'Macros', color: '#3ef0b0' },
  timbre: { zh: '音色', en: 'Timbre', color: '#a78bfa' },
  space: { zh: '空間', en: 'Space', color: '#ff6bd6' },
};
const GROUP_ORDER = ['macros', 'timbre', 'space'];

/**
 * @param {{ store: object, audio?: object, compact?: boolean }} opts
 * @returns {{ el: HTMLElement, destroy(): void, stop(): void, start(): void, freeze(): void, isOn(): boolean }}
 */
export function createEvolvePanel({ store, audio = null, compact = false } = {}) {
  ensureMagicStyles();
  const scope = createScope();
  const saved = storage.get('aurora.magic.evolve', null) || {};
  const st = {
    on: false, paused: false,
    intensity: Number.isFinite(saved.intensity) ? saved.intensity : 0.55,
    speed: Number.isFinite(saved.speed) ? saved.speed : 0.4,
    groups: { macros: true, timbre: true, space: false, ...(saved.groups || {}) },
    amp: 0, ampTarget: 0, fadeSec: 1.6,
    x: Math.random() * 1000, // noise time (random start so every session evolves differently)
  };
  let targets = [];
  const own = new Set();          // params we have written transiently
  const yieldUntil = new Map();   // id → time until which the user/sequencer owns it
  const persist = () => storage.set('aurora.magic.evolve', { intensity: st.intensity, speed: st.speed, groups: st.groups });

  const el = h('section.mt.mt-evolve', { 'aria-label': L('自動演化', 'Auto-evolve') });
  if (compact) el.classList.add('mt--compact');

  /* ── header ── */
  const toggle = createToggle({ label: false, value: false, accent: 'aurora', size: 'md', onChange: v => (v ? start() : stop()) });
  toggle.el.classList.add('mt-evo__switch');
  toggle.el.setAttribute('aria-label', L('自動演化 開／關', 'Auto-evolve on/off'));
  const listen = createAuditionButton({ store, audio });
  const head = h('header.mt-head', null,
    h('div.mt-title', null, svgIcon(ICON.orbit, 18, 'mt-title__ic'), biLabel('自動演化', 'Auto-evolve', 'mt-title__txt')),
    h('div.mt-head__actions', null, listen.el, toggle.el));

  /* ── orbit stage ── */
  const canvas = h('canvas.mt-evo__canvas', { 'aria-hidden': 'true' });
  const status = h('div.mt-evo__status');
  const legend = h('div.mt-evo__legend');
  const stage = h('div.mt-evo__stage', null, canvas, status, legend);
  stage.addEventListener('click', () => (st.on ? null : start()));

  /* ── controls ── */
  const intensity = createSlider({
    param: { id: '', type: 'float', min: 0, max: 1, def: 0.55, unit: '%', zh: '幅度', label: 'Intensity' },
    value: st.intensity, accent: 'aurora', label: false,
    onChange: (v) => { st.intensity = v; persist(); },
  });
  const speed = createSlider({
    param: { id: '', type: 'float', min: 0, max: 1, def: 0.4, unit: '%', zh: '速度', label: 'Speed' },
    value: st.speed, accent: 'var(--a-cyan)', label: false,
    onChange: (v) => { st.speed = v; persist(); },
  });
  const row = (zh, en, lo, hi, sl) => h('div.mt-row', null, biLabel(zh, en, 'mt-row__lbl'), biText('span.mt-row__end', lo[0], lo[1]), sl.el, biText('span.mt-row__end', hi[0], hi[1]));
  const groupBtns = {};
  const groupsEl = h('div.mt-evo__groups', { role: 'group', 'aria-label': L('演化目標', 'What to evolve') });
  for (const g of GROUP_ORDER) {
    const m = GROUP_META[g];
    const b = h('button.mt-chip', { type: 'button', 'aria-pressed': String(!!st.groups[g]), '--mc': m.color }, h('span.mt-chip__dot'), biLabel(m.zh, m.en), h('b.mt-chip__n'));
    b.addEventListener('click', () => {
      st.groups[g] = !st.groups[g];
      if (!Object.values(st.groups).some(Boolean)) st.groups[g] = true; // keep at least one
      b.setAttribute('aria-pressed', String(st.groups[g]));
      for (const k of GROUP_ORDER) groupBtns[k].setAttribute('aria-pressed', String(!!st.groups[k]));
      persist();
      rebuild();
    });
    groupBtns[g] = b;
    groupsEl.append(b);
  }
  const freezeBtn = pill(biLabel('凍結', 'Freeze'), { class: 'mt-evo__freeze', ...biTitle('保留現在聽到的聲音（可復原）並停止演化', 'Keep what you hear now (undoable) and stop evolving') }, ICON.snow);
  const stopBtn = pill(biLabel('停止', 'Stop'), { class: 'mt-evo__stop', ...biTitle('停止並滑回原本的音色', 'Stop and glide back to the preset') }, ICON.stop);
  freezeBtn.addEventListener('click', () => freeze());
  stopBtn.addEventListener('click', () => stop());
  const controls = h('div.mt-evo__controls', null,
    row('幅度', 'Intensity', ['微', 'Subtle'], ['大', 'Wild'], intensity),
    row('速度', 'Speed', ['慢', 'Slow'], ['快', 'Fast'], speed),
    groupsEl,
    h('div.mt-evo__actions', null, freezeBtn, stopBtn));
  el.append(head, stage, controls);

  /* ── targets ── */
  function rebuild() {
    const vals = store.committedValues();
    const next = evolveTargets(vals, store.getMacros(), st.groups);
    const nextIds = new Set(next.map(t => t.id));
    // params that left the set glide back via a short revert
    const gone = [...own].filter(id => !nextIds.has(id));
    if (gone.length) { store.revert({ ids: gone, ms: 400, owner: 'evolve' }); for (const id of gone) own.delete(id); }
    targets = next;
    const counts = { macros: 0, timbre: 0, space: 0 };
    for (const t of targets) counts[t.group]++;
    for (const g of GROUP_ORDER) groupBtns[g].querySelector('.mt-chip__n').textContent = counts[g] ? String(counts[g]) : '0';
    legend.textContent = '';
    for (const g of GROUP_ORDER) {
      if (!st.groups[g] || !counts[g]) continue;
      legend.append(h('span.mt-evo__leg', { '--mc': GROUP_META[g].color }, h('i'), `${L(GROUP_META[g].zh, GROUP_META[g].en)} ${counts[g]}`));
    }
    trails.clear();
    renderStatus();
  }
  function renderStatus() {
    status.textContent = '';
    if (st.paused) status.append(h('span.mt-evo__badge.is-paused', null, L('暫停中（其他工具使用中）', 'Paused (another tool is active)')));
    else if (st.on) status.append(h('span.mt-evo__badge.is-on', null, h('i'), L(`演化中 · ${targets.length} 個參數`, `Evolving · ${targets.length} params`)));
    else status.append(h('span.mt-evo__badge', null, L('點一下開始自動演化', 'Tap to start evolving')));
    el.classList.toggle('is-on', st.on);
    el.classList.toggle('is-paused', st.paused);
    freezeBtn.disabled = !st.on;
    stopBtn.disabled = !st.on;
  }

  /* ── engine ── */
  let raf = 0, lastT = 0, lastWrite = 0, lastDraw = 0;
  const now = () => performance.now();
  function frame(tms) {
    raf = 0;
    const dt = Math.min(0.1, Math.max(0, (tms - (lastT || tms)) / 1000));
    lastT = tms;
    // amplitude envelope (fade in on start, glide back on stop)
    const k = 1 - Math.exp(-dt / (st.fadeSec / 3));
    st.amp += (st.ampTarget - st.amp) * k;
    if (st.on && !st.paused) st.x += dt * 0.04 * 2 ** (st.speed * 4.4);
    if (st.on && !st.paused && tms - lastWrite >= 33) { lastWrite = tms; write(tms); }
    if (st.on && st.ampTarget === 0 && st.amp < 0.012) finishStop();
    if (tms - lastDraw >= (st.on ? 16 : 50)) { lastDraw = tms; draw(tms); }
    schedule();
  }
  const visible = { v: true };
  function schedule() {
    if (raf) return;
    if (!visible.v && !st.on) return;
    raf = requestAnimationFrame(frame);
  }
  /** Current normalised offset for a target at noise time x. */
  const offsetOf = (t, x) => driftNoise(x + (t.seed % 997) * 0.731, t.seed) * t.depth * st.intensity * 1.25;
  function write(tms) {
    const out = {};
    for (const t of targets) {
      const id = t.id;
      if (store.isAnimating(id)) { yieldUntil.set(id, tms + 900); continue; }
      const yu = yieldUntil.get(id) || 0;
      if (tms < yu) continue;
      const yf = Math.min(1, (tms - yu) / 1400);
      const p = PARAM_BY_ID[id];
      const nb = toNorm(p, store.committed(id));
      const lo = Math.min(t.lo, nb), hi = Math.max(t.hi, nb);
      const x = reflect(nb + offsetOf(t, st.x) * st.amp * (yu ? yf : 1), lo, hi);
      out[id] = fromNorm(p, x);
      own.add(id);
    }
    store.setTransientMany(out, { owner: 'evolve' });
  }
  function onExternal(id, v, origin) {
    if (origin === 'transient' || !st.on) return;
    if (targets.some(t => t.id === id)) yieldUntil.set(id, now() + 1600);
  }

  function start() {
    if (st.on && !st.paused) return;
    store.claim('evolve', { exclusive: true });
    st.on = true;
    st.paused = false;
    st.ampTarget = 1;
    st.fadeSec = 1.6;
    yieldUntil.clear();
    rebuild();
    toggle.setValue(true);
    renderStatus();
    schedule();
  }
  /** Glide back to the committed patch, then stop. */
  function stop() {
    if (!st.on) return;
    st.ampTarget = 0;
    st.fadeSec = 1.2;
    toggle.setValue(false);
    el.classList.add('is-stopping');
    if (st.paused) finishStop();
    schedule();
  }
  function finishStop() {
    st.on = false;
    st.paused = false;
    st.amp = 0;
    el.classList.remove('is-stopping');
    if (own.size) store.revert({ ids: [...own], owner: 'evolve' });
    own.clear();
    store.release('evolve');
    toggle.setValue(false);
    renderStatus();
  }
  /** Keep the current evolved sound as the patch (one undo step) and stop. */
  function freeze() {
    if (!st.on) return;
    const ids = [...own];
    own.clear();
    if (ids.length) store.commit('evolve:freeze', { ids, owner: 'evolve' });
    st.on = false;
    st.amp = 0;
    st.ampTarget = 0;
    st.paused = false;
    store.release('evolve');
    toggle.setValue(false);
    renderStatus();
    el.classList.remove('is-frozen'); void el.offsetWidth; el.classList.add('is-frozen');
  }

  scope.add(store.onAny(onExternal));
  scope.add(store.onPatch(() => { if (st.on) { st.amp = 0; own.clear(); } rebuild(); }));
  scope.add(store.onMacros(() => rebuild()));
  scope.add(store.onTransient((e) => {
    if (e.type === 'claim' && e.exclusive && e.owner !== 'evolve' && st.on && !st.paused) {
      st.paused = true;
      if (own.size) store.revert({ ids: [...own], owner: 'evolve' });
      own.clear();
      renderStatus();
    } else if (e.type === 'release' && e.owner !== 'evolve' && st.paused) {
      st.paused = false;
      st.amp = 0; // fade back in
      st.ampTarget = 1;
      renderStatus();
      schedule();
    } else if (e.type === 'clear' && st.on) {
      // undo/redo/load put everything back: restart the drift softly from the (new) committed values
      own.clear();
      st.amp = 0;
    }
  }));
  // structural changes (engines/FX on-off, filter type) change which params are safe to evolve
  const STRUCT = /\.(on|type|mode|unison|algo)$|^filter2\.type$/;
  scope.add(store.onAny((id, v, origin) => { if (origin !== 'transient' && STRUCT.test(id)) rebuildSoon(); }));
  let rbT = 0;
  const rebuildSoon = () => { clearTimeout(rbT); rbT = setTimeout(rebuild, 120); };

  /* ── orbit visual ── */
  const ctx = canvas.getContext('2d');
  const trails = new Map();
  let W = 0, H = 0, dpr = 1;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(stage);
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { visible.v = es.some(e => e.isIntersecting); if (visible.v) schedule(); }) : null;
  if (io) io.observe(stage);
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw(now());
  }
  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  function draw(tms) {
    if (!W || !ctx || (typeof document !== 'undefined' && document.hidden)) return;
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W * 0.46, H * 0.9);
    const tilt = 0.42;
    const live = st.on && !st.paused;
    const energy = st.amp * (0.4 + 0.6 * st.intensity);
    // core glow
    const core = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
    core.addColorStop(0, `rgba(167,139,250,${0.18 + 0.35 * energy})`);
    core.addColorStop(0.35, `rgba(92,242,255,${0.05 + 0.12 * energy})`);
    core.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = core;
    c.fillRect(0, 0, W, H);
    // rings
    const rings = { macros: 0.38, timbre: 0.66, space: 0.93 };
    c.lineWidth = 1;
    for (const g of GROUP_ORDER) {
      const rr = R * rings[g];
      c.strokeStyle = st.groups[g] ? hexA(GROUP_META[g].color, 0.16 + 0.1 * energy) : 'rgba(140,160,220,.07)';
      c.setLineDash(g === 'space' ? [2, 5] : []);
      c.beginPath();
      c.ellipse(cx, cy, rr, rr * tilt, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.setLineDash([]);
    // sun
    const pulse = 1 + 0.12 * Math.sin(tms / 420) * energy;
    const sunR = (4.5 + 5 * energy) * pulse;
    const sg = c.createRadialGradient(cx, cy, 0, cx, cy, sunR * 3.2);
    sg.addColorStop(0, 'rgba(255,255,255,.95)');
    sg.addColorStop(0.25, `rgba(92,242,255,${0.55 + 0.3 * energy})`);
    sg.addColorStop(1, 'rgba(92,242,255,0)');
    c.fillStyle = sg;
    c.beginPath();
    c.arc(cx, cy, sunR * 3.2, 0, Math.PI * 2);
    c.fill();
    // moons (one per evolving param)
    const byGroup = { macros: [], timbre: [], space: [] };
    for (const t of targets) byGroup[t.group].push(t);
    const spin = tms / 1000;
    for (const g of GROUP_ORDER) {
      const list = byGroup[g];
      const rr = R * rings[g];
      const speedG = (g === 'macros' ? 0.22 : g === 'timbre' ? -0.15 : 0.1) * (live ? 0.6 + 1.4 * st.speed : 0.25);
      list.forEach((t, i) => {
        const p = PARAM_BY_ID[t.id];
        let dev = 0;
        if (st.on && own.has(t.id)) {
          const nb = toNorm(p, store.committed(t.id));
          dev = t.depth > 0 ? (toNorm(p, store.get(t.id)) - nb) / (t.depth * 1.25) : 0;
          dev = dev < -1.2 ? -1.2 : dev > 1.2 ? 1.2 : dev;
        }
        let a0 = trails.get(t.id)?.ang;
        if (a0 === undefined) a0 = (i / Math.max(1, list.length)) * Math.PI * 2 + (g === 'timbre' ? 0.6 : g === 'space' ? 1.3 : 0);
        const ang = a0 + speedG * 0.016 * (live ? 1 : 0.4);
        const rad = rr * (1 + dev * 0.18);
        const x = cx + Math.cos(ang + dev * 0.35) * rad;
        const y = cy + Math.sin(ang + dev * 0.35) * rad * tilt;
        const tr = trails.get(t.id) || { ang, pts: [] };
        tr.ang = ang;
        tr.pts.push(x, y);
        if (tr.pts.length > 28) tr.pts.splice(0, 2);
        trails.set(t.id, tr);
        const col = t.color || GROUP_META[g].color;
        // trail
        if (tr.pts.length > 4 && st.on) {
          for (let j = 2; j < tr.pts.length; j += 2) {
            c.strokeStyle = hexA(col, (j / tr.pts.length) * 0.5 * (0.3 + energy));
            c.lineWidth = 1 + (j / tr.pts.length) * 1.6;
            c.beginPath();
            c.moveTo(tr.pts[j - 2], tr.pts[j - 1]);
            c.lineTo(tr.pts[j], tr.pts[j + 1]);
            c.stroke();
          }
        }
        // moon + glow (front half brighter: fake depth)
        const front = Math.sin(ang) > 0;
        const size = (g === 'macros' ? 4.2 : 3.2) * (front ? 1.15 : 0.85) * (1 + Math.abs(dev) * 0.35);
        const glow = c.createRadialGradient(x, y, 0, x, y, size * 4);
        glow.addColorStop(0, hexA(col, (front ? 0.55 : 0.3) * (0.4 + 0.6 * (st.on ? 1 : 0.5))));
        glow.addColorStop(1, hexA(col, 0));
        c.fillStyle = glow;
        c.beginPath();
        c.arc(x, y, size * 4, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = st.on ? col : hexA(col, 0.55);
        c.beginPath();
        c.arc(x, y, size, 0, Math.PI * 2);
        c.fill();
      });
    }
  }

  /* ── init ── */
  rebuild();
  requestAnimationFrame(() => resize());
  schedule();
  scope.add(onLangChange(() => { relabel(el); rebuild(); }));

  return {
    el,
    start,
    /** Stop evolving (glide back to the preset) and stop the ▶ audition loop (Demo Center: another player took over). */
    stop() { stop(); listen.stop(); },
    freeze,
    isOn: () => st.on,
    destroy() {
      if (st.on) { if (own.size) store.revert({ ids: [...own], owner: 'evolve' }); own.clear(); store.release('evolve'); st.on = false; }
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(rbT);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      scope.dispose();
      intensity.destroy();
      speed.destroy();
      listen.stop();
      listen.destroy();
      el.remove();
    },
  };
}
