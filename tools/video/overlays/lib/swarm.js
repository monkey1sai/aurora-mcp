// "How Claude built it": a radial swarm of agent runs. A glowing Claude Code core dispatches
// each phase as a ring of agent nodes (fly out → work → report), the camera pulls back as rings
// accumulate, a live counter tallies every agent, and finally everything spirals into the product.
// Canvas 2D (pre-rendered glow sprites, additive blending) + a handful of DOM labels.
import { ease, clamp, lerp, anim, css } from './anim.js';
import { pick } from './text.js';

export const DEFAULT_PHASES = [
  { key: 'build', title: { en: 'Build', zh: '建構' }, groups: [
    { n: 10, label: { en: 'module builders', zh: '模組建構者' }, color: '#5cf2ff' },
    { n: 1, label: { en: 'integration lead', zh: '整合負責人' }, color: '#3ef0b0', lead: true },
  ] },
  { key: 'sound', title: { en: 'Sound', zh: '音色' }, groups: [
    { n: 10, label: { en: 'sound designers', zh: '音色設計師' }, color: '#3ef0b0' },
    { n: 5, label: { en: 'demo & visual engineers', zh: '示範／視覺工程師' }, color: '#5cf2ff' },
    { n: 3, label: { en: 'composers', zh: '作曲家' }, color: '#ff6bd6' },
    { n: 2, label: { en: 'QA leads', zh: '品管負責人' }, color: '#ffc46b', lead: true },
  ] },
  { key: 'review', title: { en: 'Review', zh: '審查' }, flow: 'chain', groups: [
    { n: 5, label: { en: 'reviewers', zh: '審查者' }, color: '#a78bfa' },
    { n: 5, label: { en: 'adversarial verifiers', zh: '反方驗證者' }, color: '#ff6bd6' },
    { n: 4, label: { en: 'fixers', zh: '修復者' }, color: '#3ef0b0' },
    { n: 2, label: { en: 'regression & i18n', zh: '回歸測試＋在地化' }, color: '#ffc46b', lead: true },
  ] },
];

export const SWARM_STR = {
  kicker: { en: 'How Claude built it', zh: 'Claude 怎麼做出來的' },
  core: { en: 'Claude Code', zh: 'Claude Code' },
  count: { en: 'agent runs', zh: '個 agent 分工' },
  meta: { en: '<b>~20M</b> tokens of agent work<br><b>~11 h</b> of workflow time', zh: '約 <b>2,000萬</b> tokens 的 agent 工作量<br>約 <b>11</b> 小時工作流程' },
};

const BASE_MS = 5600;
const RADII = [175, 285, 395];
const CAM = [1.72, 1.5, 1.24, 1.07];
const hexRGB = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function sprite(color, size = 96) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const [r, gg, b] = hexRGB(color);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(255,255,255,1)`);
  grd.addColorStop(.12, `rgba(${r},${gg},${b},.95)`);
  grd.addColorStop(.35, `rgba(${r},${gg},${b},.32)`);
  grd.addColorStop(.7, `rgba(${r},${gg},${b},.07)`);
  grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return c;
}

export class Swarm {
  constructor(ov) {
    this.ov = ov; this.engine = ov?.engine;
    this.el = null; this.running = false;
  }

  _build(lang, phases, opts) {
    const el = this.el = document.createElement('div');
    el.className = 'ovl-layer ovl-swarm';
    const pr = this.pr = opts.pixelRatio || 1;
    const cv = this.cv = document.createElement('canvas');
    cv.width = 1920 * pr; cv.height = 1080 * pr;
    el.appendChild(cv);
    this.g = cv.getContext('2d');
    const mk = (cls, html, parent = el) => { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; parent.appendChild(d); return d; };
    this.kick = mk('ovl-sw-kicker', pick(opts.kicker || SWARM_STR.kicker, lang));
    this.steps = mk('ovl-sw-steps');
    this.stepEls = phases.map((ph, i) => {
      const s = mk('ovl-sw-step', null, this.steps);
      s.innerHTML = `<span class="ovl-sw-step__n">0${i + 1}</span><span class="ovl-sw-step__t"></span><span class="ovl-sw-step__ck">✓</span>`;
      s.querySelector('.ovl-sw-step__t').textContent = pick(ph.title, lang);
      return s;
    });
    const cnt = this.countEl = mk('ovl-sw-count');
    cnt.innerHTML = `<span class="ovl-sw-count__n ovl-gradtext">0</span><span class="ovl-sw-count__l"></span>`;
    this.countN = cnt.firstChild; cnt.lastChild.textContent = pick(opts.countLabel || SWARM_STR.count, lang);
    this.coreLabel = mk('ovl-sw-core', null); this.coreLabel.textContent = pick(opts.core || SWARM_STR.core, lang);
    this.meta = mk('ovl-sw-meta', pick(opts.meta || SWARM_STR.meta, lang));
    this.logo = mk('ovl-sw-logo', `<span class="ovl-sw-logo__w ovl-gradtext">AURORA</span><span class="ovl-sw-logo__z">極光</span>`);
    this.sprites = new Map();
    this.coreSprite = sprite('#5cf2ff', 256);
    this.violetSprite = sprite('#a78bfa', 256);

    // nodes, rings
    this.nodes = []; this.rings = []; this.calls = [];
    phases.forEach((ph, pi) => {
      const R = RADII[Math.min(pi, RADII.length - 1)] + Math.max(0, pi - 2) * 100;
      const total = ph.groups.reduce((s, g) => s + g.n, 0);
      const gapSlots = .9;
      const slots = total + gapSlots * ph.groups.length;
      // default rotations put at most one group label on the (crowded) left side, at mid-height
      const rot = ph.rot ?? [-2.67, 1.69, .297][pi % 3];
      let slot = 0;
      const ring = { R, phase: pi, drawn: 0, nodes: [], groups: [], spin: (pi % 2 ? -1 : 1) * .045 };
      ph.groups.forEach((gr, gi) => {
        const gNodes = [];
        slot += gapSlots / 2;
        for (let k = 0; k < gr.n; k++) {
          const a = rot + ((slot + .5) / slots) * Math.PI * 2; slot++;
          const nd = { a, R, color: gr.color, lead: !!gr.lead, phase: pi, group: gi, ring, r: gr.lead ? 13 : 8.5,
            launch: 0, land: 0, workMs: 0, state: 0, x: 0, y: 0, pulse: -1, glow: 0 };
          gNodes.push(nd); this.nodes.push(nd); ring.nodes.push(nd);
        }
        slot += gapSlots / 2;
        const mid = gNodes.length ? (gNodes[0].a + gNodes[gNodes.length - 1].a) / 2 : rot;
        const call = mk('ovl-sw-call', `<b>${gr.n}</b><span></span>`);
        call.lastChild.textContent = pick(gr.label, lang);
        call.style.setProperty('--c', gr.color);
        const right = Math.cos(mid) >= 0;
        call.classList.add(right ? 'is-right' : 'is-left');
        if (!right) { call.innerHTML = ''; const s = document.createElement('span'); s.textContent = pick(gr.label, lang); const b = document.createElement('b'); b.textContent = gr.n; call.append(s, b); }
        const c = { el: call, mid, R, phase: pi, color: gr.color, right, nodes: gNodes, shown: false, y: 0, x: 0, alpha: 0, ring };
        ring.groups.push({ ...gr, nodes: gNodes, call: c });
        this.calls.push(c);
      });
      this.rings.push(ring);
    });
    return el;
  }

  _spr(color) { let s = this.sprites.get(color); if (!s) { s = sprite(color); this.sprites.set(color, s); } return s; }

  _schedule(phases, k) {
    // absolute times (ms from start), scaled by k; opts.phaseGap (real ms) spaces the phases independently of k;
    // opts.stay: no convergence / logo — the swarm stays on the full count until clear()
    const gap = this.gap ?? 1400 * k;
    const T = this.T = {
      coreIn: 0, coreDur: 380 * k,
      phase: phases.map((_, i) => 320 * k + i * gap), phaseDur: gap,
      converge: this.hold ? Infinity : 320 * k + phases.length * gap + 60 * k,
    };
    T.convDur = 620 * k; T.bloom = T.converge + T.convDur; T.logo = T.bloom + 40 * k; T.end = T.bloom + 700 * k;
    // node launch/land/work times
    this.rings.forEach((ring, pi) => {
      const p0 = T.phase[pi];
      const n = ring.nodes.length;
      // chain flow (review): groups launch in order; others: all at once with a fast stagger
      const chain = phases[pi].flow === 'chain';
      ring.nodes.forEach((nd, i) => {
        let at;
        if (chain) at = p0 + (nd.group * 170 + (i % 6) * 26) * k;
        else if (nd.lead) at = p0 + 330 * k;
        else at = p0 + (i / n) * 380 * k;
        nd.launch = at; nd.fly = 380 * k; nd.land = at + nd.fly;
        nd.workMs = (nd.lead ? 380 : 330 + ((i * 97) % 7) * 55) * k;
        nd.done = nd.land + nd.workMs;
        if (nd.lead) nd.done = p0 + 1180 * k;
      });
      ring.mergeAt = p0 + 860 * k; ring.doneAt = p0 + 1260 * k;
    });
    // hold mode: play() resolves when the last agent has landed (the count is complete)
    if (this.hold) T.end = T.full = Math.max(...this.nodes.map(nd => nd.land));
  }

  async play(opts = {}) {
    const ov = this.ov; const lang = opts.lang || ov.lang;
    const phases = opts.phases || DEFAULT_PHASES;
    this.stop(true);
    const k = (opts.ms || BASE_MS) / BASE_MS;
    this.gap = opts.phaseGap ?? null; this.hold = !!opts.stay; this.punched = false;
    // 'current': only the running phase's callouts are on screen (the previous ring's labels vanish the moment the
    // next ring launches — no half-faded label ever overlaps a live one)
    this.snapCalls = opts.calls === 'current';
    const el = this._build(lang, phases, opts);
    ov.layers.swarm.appendChild(el);
    this._schedule(phases, k);
    this.phases = phases; this.k = k;
    this.cx = opts.cx ?? 1020; this.cy = opts.cy ?? 560;
    this.cam = CAM[0];
    this.particles = [];
    this.count = 0; this.total = this.nodes.length;
    // backdrop: aurora sky, dimmed so the swarm owns the frame
    if (opts.backdrop !== false) ov.backdrop.show({ ms: 500 * k, amp: opts.amp ?? .55, lift: .22, owner: 'swarm' });
    this.running = true; this._tick(0, 0);
    await anim(el, [{ opacity: 0 }, { opacity: 1 }], { ms: 420 * k, easing: 'ease-out', delay: opts.delay || 0 });
    this.t0 = this.engine.now();
    this.logoShown = false;
    return new Promise(res => {
      this._done = res;
      this._stopTick = this.engine.add((now, dt) => this._tick(now - this.t0, dt));
    });
  }

  _emit(x0, y0, x1, y1, color, dur, size = 1, bend = .22) {
    if (this.particles.length > 420) return;
    const dx = x1 - x0, dy = y1 - y0;
    const b = (Math.random() - .5) * 2 * bend;
    this.particles.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2 - dy * b, cy: (y0 + y1) / 2 + dx * b, t: 0, dur, color, size });
  }

  _tick(t, dt) {
    if (!this.running) return false;
    const T = this.T, k = this.k, g = this.g, pr = this.pr;
    const dts = dt / 1000;
    // ── camera ──
    let cam = CAM[0];
    for (let i = 0; i < this.rings.length; i++) {
      const p = clamp((t - (T.phase[i] - 150 * k)) / (650 * k));
      if (p > 0) cam = lerp(CAM[Math.min(i, CAM.length - 1)] ?? cam, CAM[Math.min(i + 1, CAM.length - 1)] - Math.max(0, i - 2) * .16, ease.inOutCubic(p));
    }
    const conv = clamp((t - T.converge) / T.convDur);
    const convE = ease.inCubic(conv);
    if (t > T.converge) cam = lerp(cam, 1.25, ease.inOutCubic(clamp((t - T.converge) / (T.convDur + 300 * k))));
    this.cam = cam;
    const cx = this.cx, cy = this.cy;

    // ── node positions / states ──
    let landed = 0;
    for (const nd of this.nodes) {
      const fp = clamp((t - nd.launch) / nd.fly);
      if (fp <= 0) { nd.vis = 0; continue; }
      const fe = ease.outCubic(fp);
      const spin = (1 - fe) * .9;
      let r = nd.R * fe, a = nd.a - spin + nd.ring.spin * t / 1000;
      if (conv > 0) { r *= 1 - convE; a += convE * 1.6; }
      nd.x = Math.cos(a) * r; nd.y = Math.sin(a) * r;
      nd.vis = conv > 0 ? 1 - clamp((conv - .75) / .25) : 1;
      if (fp >= 1) landed++;
      const was = nd.state;
      nd.state = t < nd.land ? 1 : t < nd.done ? 2 : 3;
      if (was === 2 && nd.state === 3) nd.pulse = t;
      if (was === 1 && nd.state >= 2) nd.pulse = t - 200;
    }
    if (landed !== this.count) {
      if (!this.count && landed) anim(this.countEl, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }], { ms: 260 * k, easing: css.out });
      this.count = landed;
      this.countN.textContent = String(landed);
      if (this.hold && landed === this.total && !this.punched) {
        this.punched = true;
        anim(this.countN, [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.32)', filter: 'brightness(1.6)', offset: .3 }, { transform: 'scale(1.12)', filter: 'brightness(1.15)' }], { ms: 520, easing: css.outSoft, fill: 'forwards' });
        anim(this.meta, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { ms: 500, delay: 180, easing: css.out });
      }
    }

    // ── steps ──
    this.rings.forEach((ring, i) => {
      const s = this.stepEls[i]; if (!s) return;
      const on = t >= T.phase[i] && t < ring.doneAt + 120 * k;
      s.classList.toggle('is-on', on && !(t >= ring.doneAt));
      s.classList.toggle('is-done', t >= ring.doneAt);
    });

    // ── emit particles ──
    const rnd = Math.random;
    for (const nd of this.nodes) {
      if (!nd.vis || conv > 0) continue;
      const ring = nd.ring; const ph = this.phases[nd.phase];
      if (nd.state === 2 && rnd() < 3.2 * dts) this._emit(0, 0, nd.x, nd.y, nd.color, (420 + rnd() * 200) * k, .8);
      if (t > ring.mergeAt && t < ring.doneAt && !nd.lead && rnd() < 9 * dts) {
        const g0 = ring.groups[nd.group];
        let targets;
        if (ph.flow === 'chain') targets = (ring.groups[nd.group + 1] || ring.groups[ring.groups.length - 1]).nodes;
        else targets = ring.groups.filter(x => x.lead).flatMap(x => x.nodes);
        if (targets?.length && targets !== g0.nodes) { const tg = targets[(rnd() * targets.length) | 0]; this._emit(nd.x, nd.y, tg.x, tg.y, nd.color, (360 + rnd() * 160) * k, .9, .35); }
      }
      if (nd.lead && t > ring.doneAt - 260 * k && t < ring.doneAt + 60 * k && rnd() < 14 * dts) this._emit(nd.x, nd.y, 0, 0, nd.color, 420 * k, 1.1, .3);
    }
    if (conv > 0 && conv < .95) {
      for (const nd of this.nodes) if (rnd() < 10 * dts) this._emit(nd.x, nd.y, 0, 0, nd.color, (260 + rnd() * 140) * k, 1, .5);
    }

    // ── draw ──
    g.setTransform(pr, 0, 0, pr, 0, 0);
    g.clearRect(0, 0, 1920, 1080);
    g.setTransform(pr * cam, 0, 0, pr * cam, pr * cx, pr * cy);
    const coreIn = ease.outBack(clamp((t - T.coreIn) / T.coreDur));

    // ring guides (draw-on arcs)
    g.globalCompositeOperation = 'source-over';
    g.lineWidth = 1.2 / cam;
    for (const ring of this.rings) {
      const p = clamp((t - T.phase[ring.phase]) / (560 * k));
      if (p <= 0) continue;
      const a0 = ring.nodes[0].a - .3 + ring.spin * t / 1000;
      g.strokeStyle = `rgba(150,175,235,${.16 * (1 - convE)})`;
      g.beginPath(); g.arc(0, 0, ring.R * (1 - convE), a0, a0 + Math.PI * 2 * ease.outCubic(p)); g.stroke();
    }
    // links core → node, batched by colour
    g.lineWidth = 1.4 / cam;
    const byColor = new Map();
    for (const nd of this.nodes) { if (!nd.vis || nd.state < 2) continue; (byColor.get(nd.color) || byColor.set(nd.color, []).get(nd.color)).push(nd); }
    for (const [color, arr] of byColor) {
      const [r, gg, b] = hexRGB(color);
      g.strokeStyle = `rgba(${r},${gg},${b},${.16 * (1 - convE)})`;
      g.beginPath();
      for (const nd of arr) { g.moveTo(0, 0); g.quadraticCurveTo(nd.x * .5 - nd.y * .12, nd.y * .5 + nd.x * .12, nd.x, nd.y); }
      g.stroke();
    }

    g.globalCompositeOperation = 'lighter';
    // particles
    const P = this.particles; let w = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i]; p.t += dt / p.dur;
      if (p.t >= 1) continue;
      P[w++] = p;
      const spr = this._spr(p.color);
      for (let j = 0; j < 3; j++) {
        const tt = p.t - j * .045; if (tt < 0) break;
        const u = 1 - tt;
        const x = u * u * p.x0 + 2 * u * tt * p.cx + tt * tt * p.x1;
        const y = u * u * p.y0 + 2 * u * tt * p.cy + tt * tt * p.y1;
        const s = (15 - j * 4) * p.size;
        g.globalAlpha = (j === 0 ? .95 : .5 - j * .14) * Math.sin(Math.PI * Math.min(1, p.t * 1.15));
        g.drawImage(spr, x - s / 2, y - s / 2, s, s);
      }
    }
    P.length = w;

    // nodes
    for (const nd of this.nodes) {
      if (!nd.vis) continue;
      const spr = this._spr(nd.color);
      const fp = clamp((t - nd.launch) / nd.fly);
      // comet trail while flying
      if (fp < 1) {
        for (let j = 1; j <= 4; j++) {
          const q = ease.outCubic(clamp(fp - j * .06)); const a = nd.a - (1 - q) * .9 + nd.ring.spin * t / 1000;
          const x = Math.cos(a) * nd.R * q, y = Math.sin(a) * nd.R * q;
          g.globalAlpha = .5 - j * .1; const s = nd.r * (5 - j * .6);
          g.drawImage(spr, x - s / 2, y - s / 2, s, s);
        }
      }
      const done = nd.state === 3;
      const glowS = nd.r * (done ? 7.5 : 5.5) * (nd.lead ? 1.25 : 1);
      g.globalAlpha = nd.vis * (done ? .95 : .7);
      g.drawImage(spr, nd.x - glowS / 2, nd.y - glowS / 2, glowS, glowS);
      if (nd.pulse >= 0) {
        const pp = (t - nd.pulse) / (520 * k);
        if (pp < 1) {
          const [r, gg, b] = hexRGB(nd.color);
          g.globalAlpha = (1 - pp) * .9 * nd.vis; g.strokeStyle = `rgb(${r},${gg},${b})`; g.lineWidth = 2.2 / cam;
          g.beginPath(); g.arc(nd.x, nd.y, nd.r + 4 + pp * 26, 0, Math.PI * 2); g.stroke();
        }
      }
    }
    g.globalCompositeOperation = 'source-over';
    for (const nd of this.nodes) {
      if (!nd.vis) continue;
      const [r, gg, b] = hexRGB(nd.color);
      g.globalAlpha = nd.vis;
      g.fillStyle = nd.state === 3 ? '#f4fbff' : `rgb(${r},${gg},${b})`;
      g.beginPath(); g.arc(nd.x, nd.y, nd.r * (nd.state === 3 ? .62 : .5), 0, Math.PI * 2); g.fill();
      g.strokeStyle = `rgba(${r},${gg},${b},.95)`; g.lineWidth = 2 / cam;
      g.beginPath(); g.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2); g.stroke();
      if (nd.state === 2) { // working: progress arc
        const pp = clamp((t - nd.land) / nd.workMs);
        g.lineWidth = 3 / cam; g.strokeStyle = '#ffffff'; g.globalAlpha = .9 * nd.vis;
        g.beginPath(); g.arc(nd.x, nd.y, nd.r + 5.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pp); g.stroke();
      }
    }

    // core
    g.globalCompositeOperation = 'lighter';
    const breath = 1 + .05 * Math.sin(t / 260);
    const bloom = clamp((t - T.bloom) / (700 * k));
    const coreS = 230 * coreIn * breath * (1 + convE * .6);
    g.globalAlpha = .9 * (1 - bloom * .5); g.drawImage(this.coreSprite, -coreS / 2, -coreS / 2, coreS, coreS);
    g.globalAlpha = .55 * (1 - bloom * .5); const vs = coreS * 1.5; g.drawImage(this.violetSprite, -vs / 2 + 8, -vs / 2 + 6, vs, vs);
    // orbiting arcs (Claude "thinking")
    g.globalCompositeOperation = 'source-over';
    const rot = t / 900;
    const arcs = [['#3ef0b0', 0], ['#a78bfa', 2.1], ['#ff6bd6', 4.2]];
    g.lineCap = 'round';
    for (const [c, o] of arcs) {
      g.globalAlpha = .9 * coreIn * (1 - bloom); g.strokeStyle = c; g.lineWidth = 3.2 / cam;
      g.beginPath(); g.arc(0, 0, 40 * coreIn, rot + o, rot + o + 1.25); g.stroke();
    }
    g.globalAlpha = coreIn * (1 - bloom * .8);
    const cg = g.createRadialGradient(0, -6, 2, 0, 0, 27);
    cg.addColorStop(0, '#ffffff'); cg.addColorStop(.55, '#bff9ff'); cg.addColorStop(1, '#5cf2ff');
    g.fillStyle = cg; g.beginPath(); g.arc(0, 0, 26 * coreIn, 0, Math.PI * 2); g.fill();

    // bloom + shockwaves at the convergence point
    if (t >= T.bloom) {
      g.globalCompositeOperation = 'lighter';
      const bs = 260 + ease.outCubic(bloom) * 1500;
      g.globalAlpha = (1 - bloom) * .9; g.drawImage(this.coreSprite, -bs / 2, -bs / 2, bs, bs);
      g.globalCompositeOperation = 'source-over';
      for (const [c, d] of [['#5cf2ff', 0], ['#a78bfa', 110], ['#ff6bd6', 220]]) {
        const sp = clamp((t - T.bloom - d * k) / (900 * k)); if (sp <= 0 || sp >= 1) continue;
        g.globalAlpha = (1 - sp) * .8; g.strokeStyle = c; g.lineWidth = (5 * (1 - sp) + 1) / cam;
        g.beginPath(); g.arc(0, 0, 30 + ease.outCubic(sp) * 760, 0, Math.PI * 2); g.stroke();
      }
    }
    g.globalAlpha = 1;

    // ── DOM labels ──
    this.coreLabel.style.transform = `translate(${cx}px, ${cy + 64 * cam}px) translate(-50%, 0)`;
    this.coreLabel.style.opacity = String(coreIn * (1 - clamp(conv * 3)));
    this._layoutCalls(t, cam);

    if (t >= T.logo && !this.logoShown) {
      this.logoShown = true;
      this.logo.style.top = cy + 'px'; this.logo.style.left = cx + 'px';
      const w = this.logo.querySelector('.ovl-sw-logo__w');
      w.style.setProperty('--sweep', '-400px');
      anim(this.logo, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.72)', filter: 'blur(24px)', letterSpacing: '0' },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', filter: 'blur(0px)' }], { ms: 900 * k, easing: css.out });
      anim(w, [{ '--sweep': '-300px' }, { '--sweep': '1500px' }], { ms: 1300 * k, delay: 250 * k, easing: 'cubic-bezier(.45,0,.25,1)' });
      anim(this.meta, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { ms: 700 * k, delay: 300 * k });
      anim(this.countEl, [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { ms: 600 * k, easing: css.outSoft, fill: 'none' });
    }
    if (t >= T.end && this._done) {
      const d = this._done; this._done = null; d(this);
    }
    // keep ticking while anything moves (particles / core breathing) until cleared
    return true;
  }

  _layoutCalls(t, cam) {
    const T = this.T, k = this.k, cx = this.cx, cy = this.cy;
    const active = [];
    for (const c of this.calls) {
      const hideAt = c.phase + 1 < this.rings.length ? T.phase[c.phase + 1] + (this.snapCalls ? 0 : 330 * k) : T.converge;
      const show = t >= (c.nodes[0]?.land ?? 0) && t < hideAt && t < T.converge;
      const target = show ? 1 : 0;
      if (!show && this.snapCalls) c.alpha = 0;
      else c.alpha += (target - c.alpha) * Math.min(1, (show ? 7 : 9) / 60);
      if (c.alpha < .01 && !show) { if (c.el.style.opacity !== '0') c.el.style.opacity = '0'; continue; }
      c.w = c.w || c.el.offsetWidth;
      const rs = c.R * cam; const mid = c.mid + c.ring.spin * t / 1000;
      const ax = cx + Math.cos(mid) * (rs + 20), ay = cy + Math.sin(mid) * (rs + 20);
      c.ax = ax; c.ay = ay;
      c.x = c.right ? Math.max(ax, cx + rs * .55) + 58 : Math.min(ax, cx - rs * .55) - 58;
      c.x = c.right ? Math.min(c.x, 1860 - c.w) : Math.max(c.x, 60 + c.w); // title-safe margins
      c.y = ay;
      active.push(c);
    }
    // resolve vertical overlaps per side
    // keep clear of the step list (top-left) and the agent counter (bottom-left)
    if (!this.obst) {
      const r = e => ({ l: e.offsetLeft, t: e.offsetTop, r: e.offsetLeft + e.offsetWidth, b: e.offsetTop + e.offsetHeight });
      this.obst = [r(this.steps), r(this.kick), r(this.countEl)];
    }
    for (const c of active) {
      if (c.right) continue;
      for (const o of this.obst) {
        if (c.x - c.w > o.r + 60) continue;
        const top = c.y - 26, bot = c.y + 26;
        if (bot > o.t - 16 && top < o.b + 16) c.y = (c.y < (o.t + o.b) / 2 && o.t > 540) ? o.t - 16 - 26 : o.b + 16 + 26;
      }
    }
    for (const side of [true, false]) {
      const arr = active.filter(c => c.right === side).sort((a, b) => a.y - b.y);
      const minY = side ? 130 : 130, maxY = side ? 1010 : 1010, gap = 64;
      for (let i = 0; i < arr.length; i++) arr[i].y = Math.max(arr[i].y, i ? arr[i - 1].y + gap : minY);
      for (let i = arr.length - 1; i >= 0; i--) arr[i].y = Math.min(arr[i].y, i < arr.length - 1 ? arr[i + 1].y - gap : maxY);
    }
    // leader lines (screen space)
    const g = this.g, pr = this.pr;
    g.setTransform(pr, 0, 0, pr, 0, 0);
    g.globalCompositeOperation = 'source-over'; g.lineWidth = 1.6;
    for (const c of active) {
      const [r, gg, b] = hexRGB(c.color);
      g.globalAlpha = c.alpha * .75; g.strokeStyle = `rgb(${r},${gg},${b})`;
      const ex = c.x + (c.right ? -12 : 12);
      g.beginPath(); g.moveTo(c.ax, c.ay); g.lineTo(ex - (c.right ? 22 : -22), c.y); g.lineTo(ex, c.y); g.stroke();
      g.fillStyle = `rgb(${r},${gg},${b})`; g.beginPath(); g.arc(c.ax, c.ay, 3.2, 0, Math.PI * 2); g.fill();
      c.el.style.opacity = c.alpha.toFixed(3);
      c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) ${c.right ? 'translate(0,-50%)' : 'translate(-100%,-50%)'} translateX(${((1 - c.alpha) * (c.right ? -18 : 18)).toFixed(1)}px)`;
    }
    g.globalAlpha = 1;
  }

  stop(immediate) {
    this.running = false;
    this._stopTick?.(); this._stopTick = null;
    if (this._done) { const d = this._done; this._done = null; d(this); }
    if (immediate && this.el) { this.el.remove(); this.el = null; }
  }

  async clear({ ms = 600, delay = 0 } = {}) {
    const el = this.el; if (!el) return;
    await anim(el, [{ opacity: getComputedStyle(el).opacity, filter: 'blur(0px)', transform: 'scale(1)' }, { opacity: 0, filter: 'blur(10px)', transform: 'scale(1.04)' }], { ms, delay, easing: css.inOut });
    if (this.el === el) this.stop(true);
    if (this.ov.backdrop.owner === 'swarm') this.ov.backdrop.hide({ ms: 400 });
  }
}
