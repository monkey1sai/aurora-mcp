// Source visualisations: oscillator waveform/wavetable preview (canvas) and FM algorithm diagrams (SVG).

import { WAVETABLES } from '../../dsp/params.js';

/* ═══════════════════════════════ Oscillator preview ═══════════════════════════════ */

const TWO_PI = Math.PI * 2;
const W_SINE = x => Math.sin(TWO_PI * x);
const W_TRI = x => 1 - 4 * Math.abs(((x + 0.25) % 1) - 0.5);
const W_SAW = x => 2 * ((x + 0.5) % 1) - 1;
const wSquare = (x, pw) => (x % 1 < pw ? 1 : -1);

/** Classic-mode morph: 0 sine → ⅓ tri → ⅔ saw → 1 square (crossfade neighbours). */
export function classicSample(x, shape, pw) {
  const p = Math.max(0, Math.min(1, shape)) * 3;
  const i = Math.min(2, Math.floor(p));
  const f = p - i;
  const a = i === 0 ? W_SINE(x) : i === 1 ? W_TRI(x) : W_SAW(x);
  const b = i === 0 ? W_TRI(x) : i === 1 ? W_SAW(x) : wSquare(x, pw);
  return a + (b - a) * f;
}

/**
 * Canvas preview of one oscillator cycle (+ a "3D" stack of wavetable frames in wavetable mode).
 * getFrame(tableIndex, pos, size) is wavetables.getWavetableFrame (optional).
 * → { el, draw({ mode, shape, table, pw, sync, on }) }
 */
export function createWavePreview({ accent = '#5cf2ff', getFrame = null } = {}) {
  const el = document.createElement('div');
  el.className = 'wave-prev';
  const c = document.createElement('canvas');
  el.append(c);
  const ctx = c.getContext('2d');
  const tag = document.createElement('span');
  tag.className = 'wave-prev__tag';
  el.append(tag);
  let last = null;
  const stackCache = new Map(); // table → Float32Array[]
  const N = 192;
  const buf = new Float32Array(N + 1);

  function frameStack(ti) {
    let st = stackCache.get(ti);
    if (!st && getFrame) {
      st = [];
      for (let k = 0; k < 12; k++) st.push(getFrame(ti, k / 11, 96));
      stackCache.set(ti, st);
    }
    return st;
  }
  const sampleTable = (fr, x) => {
    const n = fr.length;
    const p = (x % 1) * n;
    const i = Math.floor(p), f = p - i;
    return fr[i % n] + (fr[(i + 1) % n] - fr[i % n]) * f;
  };

  function fill(v) {
    const r = Math.pow(2, (v.sync || 0) * 4);
    const wt = v.mode === 'wavetable' && getFrame;
    let fr = null;
    if (wt) {
      try { fr = getFrame(WAVETABLES.indexOf(v.table), v.shape, 256); } catch { fr = null; }
    }
    let peak = 1e-6;
    for (let i = 0; i <= N; i++) {
      const x = ((i / N) * r) % 1;
      const y = fr ? sampleTable(fr, x) : classicSample(x, v.shape, v.pw);
      buf[i] = y;
      if (Math.abs(y) > peak) peak = Math.abs(y);
    }
    const g = 1 / Math.max(1, peak);
    for (let i = 0; i <= N; i++) buf[i] *= g;
    return !!fr;
  }

  function draw(v) {
    if (v) last = v;
    v = last;
    if (!v) return;
    const w = el.clientWidth, hh = el.clientHeight;
    if (!w || !hh) return;
    const d = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(w * d) || c.height !== Math.round(hh * d)) { c.width = Math.round(w * d); c.height = Math.round(hh * d); }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const isWt = fill(v);
    const padX = 12, padY = 14;
    const stackDepth = isWt ? 34 : 0;
    const x0 = padX, x1 = w - padX - stackDepth * 0.9;
    const yMid = hh / 2 + stackDepth * 0.28;
    const amp = (hh / 2 - padY - stackDepth * 0.3) * 0.92;

    // grid
    ctx.strokeStyle = 'rgba(140,160,220,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(yMid) + 0.5); ctx.lineTo(x1, Math.round(yMid) + 0.5);
    for (let k = 1; k < 4; k++) { const gx = Math.round(x0 + (x1 - x0) * k / 4) + 0.5; ctx.moveTo(gx, yMid - amp); ctx.lineTo(gx, yMid + amp); }
    ctx.stroke();

    // wavetable frame stack (behind)
    if (isWt) {
      const st = frameStack(WAVETABLES.indexOf(v.table));
      if (st) {
        for (let k = st.length - 1; k >= 0; k--) {
          const f = st[k];
          const pos = k / (st.length - 1);
          const ox = pos * stackDepth * 0.9, oy = -pos * stackDepth * 0.55;
          const near = 1 - Math.min(1, Math.abs(pos - v.shape) * 4);
          ctx.beginPath();
          for (let i = 0; i <= 96; i++) {
            const x = x0 + ox + (x1 - x0) * (i / 96);
            const y = yMid + oy - f[i % 96] * amp * 0.9;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.strokeStyle = hexA(accent, 0.07 + near * 0.25);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
    // main curve: soft fill + glow stroke
    const path = () => {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = x0 + (x1 - x0) * (i / N);
        const y = yMid - buf[i] * amp;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
    };
    path();
    ctx.lineTo(x1, yMid); ctx.lineTo(x0, yMid); ctx.closePath();
    const gr = ctx.createLinearGradient(0, yMid - amp, 0, yMid + amp);
    gr.addColorStop(0, hexA(accent, v.on ? 0.26 : 0.08));
    gr.addColorStop(0.5, hexA(accent, 0.02));
    gr.addColorStop(1, hexA(accent, v.on ? 0.18 : 0.06));
    ctx.fillStyle = gr;
    ctx.fill();
    path();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hexA(accent, v.on ? 0.35 : 0.15);
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = v.on ? mix(accent, '#ffffff', 0.25) : hexA(accent, 0.55);
    ctx.lineWidth = 1.8;
    ctx.stroke();
    tag.textContent = isWt ? `${Math.round(v.shape * 100)}%` : '';
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => draw()).observe(el);
  return { el, draw };
}

/* ═══════════════════════════════ FM algorithm diagrams ═══════════════════════════════ */

// Fallback copy of the 8 algorithm layouts (used only if engines/fm.js cannot be imported).
export const FALLBACK_ALGOS = [
  { id: 1, name: 'Stack', zh: '四層堆疊', carriers: [1], edges: [[2, 1], [3, 2], [4, 3]], layout: { 1: [0, 3], 2: [0, 2], 3: [0, 1], 4: [0, 0] }, cols: 1, rows: 4, feedback: 4 },
  { id: 2, name: 'Y-Stack', zh: '雙入堆疊', carriers: [1], edges: [[2, 1], [3, 2], [4, 2]], layout: { 1: [0.5, 2], 2: [0.5, 1], 3: [0, 0], 4: [1, 0] }, cols: 2, rows: 3, feedback: 4 },
  { id: 3, name: 'Twin Pairs', zh: '雙對並聯', carriers: [1, 3], edges: [[2, 1], [4, 3]], layout: { 1: [0, 1], 2: [0, 0], 3: [1, 1], 4: [1, 0] }, cols: 2, rows: 2, feedback: 4 },
  { id: 4, name: 'Branch', zh: '分支', carriers: [1], edges: [[2, 1], [3, 1], [4, 3]], layout: { 1: [0.5, 2], 2: [0, 1], 3: [1, 1], 4: [1, 0] }, cols: 2, rows: 3, feedback: 4 },
  { id: 5, name: 'Fan Out', zh: '一對三', carriers: [1, 2, 3], edges: [[4, 1], [4, 2], [4, 3]], layout: { 1: [0, 1], 2: [1, 1], 3: [2, 1], 4: [1, 0] }, cols: 3, rows: 2, feedback: 4 },
  { id: 6, name: 'Pair + 2', zh: '一對加雙正弦', carriers: [1, 2, 3], edges: [[4, 3]], layout: { 1: [0, 1], 2: [1, 1], 3: [2, 1], 4: [2, 0] }, cols: 3, rows: 2, feedback: 4 },
  { id: 7, name: 'Pair + 2 Alt', zh: '一對加雙載波', carriers: [1, 3, 4], edges: [[2, 1]], layout: { 1: [0, 1], 2: [0, 0], 3: [1, 1], 4: [2, 1] }, cols: 3, rows: 2, feedback: 4 },
  { id: 8, name: 'Additive', zh: '加法合成', carriers: [1, 2, 3, 4], edges: [], layout: { 1: [0, 0], 2: [1, 0], 3: [2, 0], 4: [3, 0] }, cols: 4, rows: 1, feedback: 4 },
];

/**
 * SVG markup for an algorithm. opts: { mini (thumbnail, no labels), levels: [4] 0..1 (glow), accent, modAccent }
 */
export function fmDiagramSvg(algo, { mini = false, levels = [1, 1, 1, 1], accent = '#5cf2ff', modAccent = '#a78bfa', active = 0 } = {}) {
  if (!algo) return '';
  const bw = mini ? 12 : 38, bh = mini ? 9 : 27;
  const cw = mini ? 17 : 62, ch = mini ? 15 : 50;
  const pad = mini ? 5 : 16;
  const fbw = mini ? 5 : 14;
  const W = pad * 2 + Math.max(1, algo.cols) * cw + fbw;
  const busGap = mini ? 7 : 20;
  const H = pad * 2 + algo.rows * ch + busGap + (mini ? 2 : 14);
  const pos = {};
  for (const op of [1, 2, 3, 4]) {
    const [cx, cy] = algo.layout[op] || [op - 1, 0];
    pos[op] = [pad + cx * cw + cw / 2, pad + cy * ch + bh / 2 + (mini ? 2 : 4)];
  }
  const carr = new Set(algo.carriers);
  const sw = mini ? 1.1 : 1.6;
  let out = '';
  // edges
  for (const [m, tg] of algo.edges) {
    const [x1, y1] = pos[m], [x2, y2] = pos[tg];
    if (Math.abs(y1 - y2) < 1) {
      const dir = x2 > x1 ? 1 : -1;
      out += line(x1 + dir * bw / 2, y1, x2 - dir * bw / 2, y2, modAccent, sw, !mini);
    } else {
      const ya = y1 + bh / 2, yb = y2 - bh / 2;
      if (Math.abs(x1 - x2) < 1) out += line(x1, ya, x2, yb, modAccent, sw, !mini);
      else {
        const ym = (ya + yb) / 2;
        out += `<path d="M${f(x1)} ${f(ya)} C${f(x1)} ${f(ym)} ${f(x2)} ${f(ym)} ${f(x2)} ${f(yb - (mini ? 0 : 3))}" fill="none" stroke="${modAccent}" stroke-width="${sw}" stroke-linecap="round" opacity=".85"/>`;
        if (!mini) out += arrowHead(x2, yb, modAccent);
      }
    }
  }
  // carriers → output bus
  const cs = algo.carriers.map(c => pos[c]);
  const busY = pad + algo.rows * ch + (mini ? 1 : 4);
  const bx0 = Math.min(...cs.map(p => p[0])), bx1 = Math.max(...cs.map(p => p[0]));
  for (const [x, y] of cs) out += `<path d="M${f(x)} ${f(y + bh / 2)} V${f(busY)}" stroke="${accent}" stroke-width="${sw}" stroke-linecap="round" opacity=".8" fill="none"/>`;
  const bxm = (bx0 + bx1) / 2;
  out += `<path d="M${f(bx0)} ${f(busY)} H${f(bx1)}" stroke="${accent}" stroke-width="${sw}" stroke-linecap="round" fill="none"/>`;
  out += `<path d="M${f(bxm)} ${f(busY)} V${f(busY + busGap - (mini ? 2 : 6))}" stroke="${accent}" stroke-width="${sw}" stroke-linecap="round" fill="none"/>`;
  if (!mini) {
    out += arrowHead(bxm, busY + busGap - 2, accent);
    out += `<text x="${f(bxm + 8)}" y="${f(busY + busGap - 1)}" class="fmd__out">OUT</text>`;
  }
  // feedback loop on op 4
  {
    const [x, y] = pos[algo.feedback || 4];
    const xr = x + bw / 2, yt = y - bh / 2;
    const lx = xr + fbw - (mini ? 1 : 4);
    out += `<path d="M${f(xr)} ${f(y)} H${f(lx)} V${f(yt - (mini ? 3 : 8))} H${f(x)} V${f(yt - (mini ? 0 : 3))}" fill="none" stroke="${modAccent}" stroke-width="${mini ? 0.9 : 1.3}" stroke-linejoin="round" stroke-dasharray="${mini ? '' : '3 2.5'}" opacity=".75"/>`;
    if (!mini) out += arrowHead(x, yt, modAccent);
  }
  // operator boxes
  for (const op of [1, 2, 3, 4]) {
    const [x, y] = pos[op];
    const isC = carr.has(op);
    const col = isC ? accent : modAccent;
    const lv = Math.max(0, Math.min(1, levels[op - 1] ?? 1));
    const glow = mini ? '' : `<rect x="${f(x - bw / 2 - 3)}" y="${f(y - bh / 2 - 3)}" width="${bw + 6}" height="${bh + 6}" rx="${mini ? 3 : 9}" fill="${col}" opacity="${(0.05 + lv * 0.22).toFixed(3)}" filter="url(#fmdGlow)"/>`;
    out += `<g class="fmd__op${active === op ? ' is-active' : ''}" data-op="${op}">${glow}<rect x="${f(x - bw / 2)}" y="${f(y - bh / 2)}" width="${bw}" height="${bh}" rx="${mini ? 2.5 : 7}" fill="${col}" fill-opacity="${(isC ? 0.2 : 0.14) + lv * 0.18}" stroke="${col}" stroke-width="${mini ? 1 : 1.4}"/>`;
    if (!mini) out += `<text x="${f(x)}" y="${f(y + 4.5)}" text-anchor="middle" class="fmd__num">${op}</text>`;
    out += '</g>';
  }
  const defs = mini ? '' : '<defs><filter id="fmdGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5"/></filter></defs>';
  return `<svg class="fmd${mini ? ' fmd--mini' : ''}" viewBox="0 0 ${f(W)} ${f(H)}" width="${f(W)}" height="${f(H)}" aria-hidden="true">${defs}${out}</svg>`;
}

function line(x1, y1, x2, y2, col, sw, head) {
  const d = head ? 3.5 : 0;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ex = x2 - ((x2 - x1) / len) * d, ey = y2 - ((y2 - y1) / len) * d;
  return `<path d="M${f(x1)} ${f(y1)} L${f(ex)} ${f(ey)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" fill="none" opacity=".85"/>${head ? arrowHead(x2, y2, col, Math.atan2(y2 - y1, x2 - x1)) : ''}`;
}
function arrowHead(x, y, col, ang = Math.PI / 2) {
  const s = 5;
  const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
  return `<path d="M${f(x)} ${f(y)} L${f(x + Math.cos(a1) * s)} ${f(y + Math.sin(a1) * s)} L${f(x + Math.cos(a2) * s)} ${f(y + Math.sin(a2) * s)}Z" fill="${col}"/>`;
}
const f = v => (Math.round(v * 10) / 10).toString();

/* ── colour helpers ── */
export function hexA(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function mix(hexA1, hexB, tt) {
  const a = hexRgb(hexA1), b = hexRgb(hexB);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * tt)},${Math.round(a[1] + (b[1] - a[1]) * tt)},${Math.round(a[2] + (b[2] - a[2]) * tt)})`;
}
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [92, 242, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
