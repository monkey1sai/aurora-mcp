// 效果 FX tab: a horizontal rack Drive → Chorus → Phaser → Delay → Reverb → EQ/Glue. Each card has a
// glowing on/off switch and a small live diagram (transfer curve, echo taps, reverb tail, EQ curve).

import { h } from './dom.js';
import { card, row } from './parts.js';
import { t, pairLabel } from './i18n.js';
import { icon } from './icons.js';
import { divToBeats } from '../../dsp/params.js';

const PINK = '#ff6bd6';
const f1 = v => (Math.round(v * 10) / 10).toString();

export function buildFx(ctx, scope) {
  const root = h('div.pane.pane--fx');
  const rack = h('div.fx-rack');
  const cards = [buildDrive(ctx, scope), buildChorus(ctx, scope), buildPhaser(ctx, scope), buildDelay(ctx, scope), buildReverb(ctx, scope), buildEq(ctx, scope)];
  cards.forEach((c, i) => {
    rack.append(c.el);
    if (i < cards.length - 1) rack.append(h('div.fx-link', { 'aria-hidden': 'true' }, icon('next', 14)));
  });
  root.append(h('div.fx-flow', null, h('span', null, t('signalFlow')), h('small', null, 'Voices → Drive → Chorus → Phaser → Delay → Reverb → EQ/Glue → Master → Limiter')), rack);
  return root;
}

function fxCard(ctx, scope, group, ic, cls = '') {
  const { binder } = ctx;
  const hasOn = group !== 'eq';
  const c = card({ group, icon: ic, accent: PINK, cls: `card--fx ${cls}` });
  if (hasOn) {
    const tg = binder.toggle(scope, `${group}.on`, { accent: PINK, label: false });
    c.head.append(tg.el);
    binder.watch(scope, [`${group}.on`], s => c.el.classList.toggle('is-bypassed', !s.get(`${group}.on`)));
  }
  const k = (id, o = {}) => binder.knob(scope, id, { accent: PINK, ...o }).el;
  return { c, k };
}

/* ── Drive: transfer curve ── */
function buildDrive(ctx, scope) {
  const { c, k } = fxCard(ctx, scope, 'drive', 'lead');
  const viz = h('div.fx-viz');
  const type = ctx.binder.select(scope, 'drive.type', { accent: PINK, label: false, variant: 'dropdown' });
  c.body.append(viz, type.el, row(k('drive.amount', { size: 'md' }), k('drive.tone'), k('drive.mix')));
  ctx.binder.watch(scope, ['drive.type', 'drive.amount', 'drive.on', 'macro1', 'macro2', 'macro3', 'macro4'], (s) => {
    const tp = s.get('drive.type');
    const a = ctx.binder.effective('drive.amount');
    const g = 1 + a * 9;
    const fn = tp === 'tube' ? x => Math.tanh(g * x + 0.25 * a * x * x * g) / Math.tanh(g) :
      tp === 'fold' ? x => Math.sin(x * (1 + a * 4) * Math.PI / 2) :
        tp === 'crush' ? (x) => { const st = Math.pow(2, 8 - a * 6); return Math.round(x * st) / st; } :
          x => Math.tanh(g * x) / Math.tanh(g);
    let d = '';
    for (let i = 0; i <= 64; i++) { const x = -1 + (2 * i) / 64; const y = Math.max(-1.05, Math.min(1.05, fn(x))); d += `${i ? 'L' : 'M'}${f1(50 + x * 44)} ${f1(30 - y * 24)}`; }
    viz.innerHTML = `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M6 30H94M50 4V56" stroke="rgba(140,160,220,.15)" stroke-width=".8"/><path d="M6 54L94 6" stroke="rgba(140,160,220,.18)" stroke-width=".8" stroke-dasharray="2 2"/><path d="${d}" fill="none" stroke="${PINK}" stroke-width="1.8" vector-effect="non-scaling-stroke"/></svg>`;
  });
  return c;
}

function buildChorus(ctx, scope) {
  const { c, k } = fxCard(ctx, scope, 'chorus', 'pad');
  const mode = ctx.binder.select(scope, 'chorus.mode', { accent: PINK, label: false });
  c.body.append(mode.el, row(k('chorus.rate', { size: 'md' }), k('chorus.depth', { size: 'md' })), row(k('chorus.feedback'), k('chorus.mix')));
  return c;
}

function buildPhaser(ctx, scope) {
  const { c, k } = fxCard(ctx, scope, 'phaser', 'mod');
  const st = ctx.binder.select(scope, 'phaser.stages', { accent: PINK, label: false });
  c.body.append(st.el, row(k('phaser.rate', { size: 'md' }), k('phaser.depth', { size: 'md' })), row(k('phaser.feedback'), k('phaser.mix')));
  return c;
}

/* ── Delay: echo taps ── */
function buildDelay(ctx, scope) {
  const { c, k } = fxCard(ctx, scope, 'delay', 'loop');
  const viz = h('div.fx-viz');
  const sync = ctx.binder.select(scope, 'delay.sync', { accent: PINK, variant: 'dropdown' });
  const time = k('delay.time', { size: 'md' });
  c.body.append(viz, h('div.krow', null, h('div.fx-sync', null, sync.el), time), row(k('delay.feedback'), k('delay.pingpong'), k('delay.tone')), row(k('delay.wobble'), k('delay.mix')));
  ctx.binder.watch(scope, ['delay.sync', 'delay.time', 'delay.feedback', 'delay.pingpong', 'global.bpm', 'macro1', 'macro2', 'macro3', 'macro4'], (s) => {
    const beats = divToBeats(s.get('delay.sync'));
    time.classList.toggle('is-disabled', beats > 0);
    const sec = beats > 0 ? (beats * 60) / s.get('global.bpm') : ctx.binder.effective('delay.time');
    const fb = ctx.binder.effective('delay.feedback');
    const pp = ctx.binder.effective('delay.pingpong');
    const span = 2.4;
    let out = `<rect x="2" y="12" width="2.6" height="36" rx="1.2" fill="#e8ecff" opacity=".9"/>`;
    let amp = 1;
    for (let n = 1; n < 24; n++) {
      amp *= n === 1 ? 0.85 : fb;
      const x = 3 + (sec * n / span) * 94;
      if (x > 98 || amp < 0.02) break;
      const side = n % 2 ? -1 : 1;
      const hgt = 36 * amp;
      const y = 30 - hgt / 2 + side * pp * 7;
      out += `<rect x="${f1(x - 1)}" y="${f1(y)}" width="2.2" height="${f1(hgt)}" rx="1.1" fill="${PINK}" opacity="${(0.35 + amp * 0.65).toFixed(2)}"/>`;
    }
    viz.innerHTML = `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M2 30H98" stroke="rgba(140,160,220,.15)" stroke-width=".8"/>${out}</svg>`;
  });
  return c;
}

/* ── Reverb: tail diagram (centrepiece, wider card) ── */
function buildReverb(ctx, scope) {
  const { c, k } = fxCard(ctx, scope, 'reverb', 'fx', 'card--reverb');
  const viz = h('div.fx-viz.fx-viz--wide');
  c.body.append(viz,
    h('div.krow', null, k('reverb.size', { size: 'md' }), k('reverb.decay', { size: 'md' }), k('reverb.mix', { size: 'md' })),
    row(k('reverb.predelay'), k('reverb.damp'), k('reverb.mod')), row(k('reverb.width'), k('reverb.shimmer')));
  ctx.binder.watch(scope, ['reverb.size', 'reverb.decay', 'reverb.predelay', 'reverb.damp', 'reverb.shimmer', 'reverb.width', 'macro1', 'macro2', 'macro3', 'macro4'], () => {
    const e = id => ctx.binder.effective(id);
    const decay = e('reverb.decay'), pre = e('reverb.predelay'), size = e('reverb.size'), damp = e('reverb.damp'), sh = e('reverb.shimmer'), wid = e('reverb.width');
    const span = Math.min(30, Math.max(2, pre + decay * 1.25));
    const X = s => 4 + (s / span) * 94;
    let bars = '';
    const n = 90;
    for (let i = 0; i < n; i++) {
      const tt = pre + (i / n) * (span - pre);
      const env = Math.pow(10, (-3 * (tt - pre)) / Math.max(0.05, decay));
      const jitter = 0.55 + 0.45 * Math.abs(Math.sin(i * 12.9898 + size * 7));
      const hh = 44 * env * jitter * (i < 8 ? 1 - 0.4 * (i % 3) / 3 : 1);
      if (hh < 0.3) continue;
      bars += `<rect x="${f1(X(tt))}" y="${f1(30 - hh / 2)}" width=".9" height="${f1(hh)}" fill="url(#rvg)" opacity="${(0.4 + 0.6 * env).toFixed(2)}"/>`;
    }
    const col2 = sh > 0.05 ? '#ffffff' : '#a78bfa';
    viz.innerHTML = `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><defs><linearGradient id="rvg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col2}" stop-opacity="${0.4 + sh * 0.6}"/><stop offset=".5" stop-color="${PINK}"/><stop offset="1" stop-color="#a78bfa" stop-opacity="${0.5 + wid * 0.5}"/></linearGradient></defs>
<rect x="2" y="10" width="2.4" height="40" rx="1.2" fill="#e8ecff" opacity=".9"/>${bars}
<text x="96" y="10" text-anchor="end" class="fx-viz__txt">${decay < 1 ? `${Math.round(decay * 1000)} ms` : `${decay.toFixed(1)} s`}${damp > 0.6 ? ' · dark' : damp < 0.25 ? ' · bright' : ''}</text></svg>`;
  });
  return c;
}

/* ── EQ + glue: RBJ response curve ── */
function biquadDb(b0, b1, b2, a0, a1, a2, w) {
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
function shelf(fs, f0, g, high) {
  const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * f0 / fs, cs = Math.cos(w0), al = Math.sin(w0) / 2 * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
  return high
    ? [A * ((A + 1) + (A - 1) * cs + sa), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sa), (A + 1) - (A - 1) * cs + sa, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sa]
    : [A * ((A + 1) - (A - 1) * cs + sa), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - sa), (A + 1) + (A - 1) * cs + sa, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - sa];
}
function peak(fs, f0, g, q) {
  const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * f0 / fs, al = Math.sin(w0) / (2 * q), cs = Math.cos(w0);
  return [1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A];
}
function buildEq(ctx, scope) {
  const { c, k } = fxCard(ctx, scope, 'eq', 'sliders', 'card--eq');
  const viz = h('div.fx-viz');
  c.body.append(viz, row(k('eq.low'), k('eq.mid'), k('eq.midfreq'), k('eq.high')), row(k('comp.amount', { size: 'md' })));
  ctx.binder.watch(scope, ['eq.low', 'eq.mid', 'eq.midfreq', 'eq.high', 'macro1', 'macro2', 'macro3', 'macro4'], () => {
    const e = id => ctx.binder.effective(id);
    const fs = 48000;
    const L = shelf(fs, 120, e('eq.low'), false), M = peak(fs, e('eq.midfreq'), e('eq.mid'), 0.9), Hs = shelf(fs, 8000, e('eq.high'), true);
    let d = '';
    for (let i = 0; i <= 80; i++) {
      const fq = 20 * Math.pow(1000, i / 80), w = 2 * Math.PI * fq / fs;
      const db = biquadDb(...L, w) + biquadDb(...M, w) + biquadDb(...Hs, w);
      d += `${i ? 'L' : 'M'}${f1(2 + (i / 80) * 96)} ${f1(30 - Math.max(-14, Math.min(14, db)) * 1.9)}`;
    }
    viz.innerHTML = `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M2 30H98" stroke="rgba(140,160,220,.2)" stroke-width=".8"/><path d="${d} L98 60 L2 60Z" fill="${PINK}" opacity=".10"/><path d="${d}" fill="none" stroke="${PINK}" stroke-width="1.8" vector-effect="non-scaling-stroke"/></svg>`;
  });
  c.head.append(h('span.card__badge', null, pairLabel('常開', 'Always on').zh));
  return c;
}

