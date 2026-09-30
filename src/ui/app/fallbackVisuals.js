// Minimal Canvas2D stand-ins for src/ui/visuals.js (same API). Used only when visuals.js fails to load,
// so the shell keeps working. Deliberately simple and cheap.

const DPR = () => Math.min(2, globalThis.devicePixelRatio || 1);
function canvasBox(cls) {
  const el = document.createElement('div');
  el.className = `fv ${cls}`;
  const c = document.createElement('canvas');
  el.append(c);
  const ctx = c.getContext('2d');
  const fit = () => {
    const w = el.clientWidth || 1, h = el.clientHeight || 1, d = DPR();
    if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return [w, h];
  };
  return { el, c, ctx, fit };
}
function loop(draw) {
  let id = 0, on = false;
  const f = () => { if (!on) return; if (!document.hidden) draw(); id = requestAnimationFrame(f); };
  return { start() { if (!on) { on = true; id = requestAnimationFrame(f); } }, stop() { on = false; cancelAnimationFrame(id); } };
}

export function createHeroVisualizer({ analyser, getState } = {}) {
  const b = canvasBox('fv-hero');
  const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const cols = [[62, 240, 176], [92, 242, 255], [167, 139, 250], [255, 107, 214]];
  const colAt = (u) => { const x = Math.max(0, Math.min(1, u)) * 3, i = Math.min(2, Math.floor(x)), f = x - i; return cols[i].map((c, k) => Math.round(c + (cols[i + 1][k] - c) * f)); };
  const notes = new Map(); // note → { lvl, vel }
  let t = 0;
  const l = loop(() => {
    const [w, h] = b.fit();
    const { ctx } = b;
    ctx.clearRect(0, 0, w, h);
    t += reduce && reduce.matches ? 0.003 : 0.01;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#03040a'); sky.addColorStop(1, '#0b1026');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    if (bins) analyser.getByteFrequencyData(bins);
    // curtain: spectrum-shaped, gently waving
    const n = 96;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(62,240,176,.5)'); grad.addColorStop(0.35, 'rgba(92,242,255,.5)');
    grad.addColorStop(0.7, 'rgba(167,139,250,.5)'); grad.addColorStop(1, 'rgba(255,107,214,.5)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const fi = bins ? Math.floor(Math.pow(i / n, 2) * (bins.length * 0.6)) : 0;
      const v = bins ? bins[fi] / 255 : 0;
      const x = (i / n) * w, base = h * (0.62 + 0.06 * Math.sin(i * 0.09 + t * 2));
      const y = base - (0.12 + v * 0.55) * h * (0.7 + 0.3 * Math.sin(i * 0.31 - t * 3));
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    for (let i = n; i >= 0; i--) ctx.lineTo((i / n) * w, h * (0.62 + 0.06 * Math.sin(i * 0.09 + t * 2)));
    ctx.closePath();
    ctx.filter = 'blur(10px)';
    ctx.fill();
    ctx.filter = 'none';
    // one light column per sounding voice (x = log pitch, height = envelope level, width = velocity)
    const st = getState ? getState() : null;
    const seen = new Set();
    if (st && st.voices) for (const v of st.voices) { seen.add(v.note); const o = notes.get(v.note) || { lvl: 0, vel: 0 }; o.lvl += ((v.level || 0) - o.lvl) * 0.3; o.vel = v.velocity || 0.8; notes.set(v.note, o); }
    ctx.globalCompositeOperation = 'lighter';
    for (const [note, o] of notes) {
      if (!seen.has(note)) { o.lvl *= 0.9; if (o.lvl < 0.01) { notes.delete(note); continue; } }
      const u = Math.max(0.02, Math.min(0.98, (note - 24) / 84));
      const [r, g, bl] = colAt((note - 36) / 60);
      const x = u * w, hh = h * (0.25 + 0.6 * o.lvl), bw = 4 + 10 * o.vel;
      const cg = ctx.createLinearGradient(0, h * 0.86, 0, h * 0.86 - hh);
      cg.addColorStop(0, `rgba(${r},${g},${bl},${0.55 * o.lvl})`); cg.addColorStop(1, `rgba(${r},${g},${bl},0)`);
      ctx.fillStyle = cg;
      ctx.fillRect(x - bw, h * 0.86 - hh, bw * 2, hh);
      const og = ctx.createRadialGradient(x, h * 0.86, 0, x, h * 0.86, bw * 3);
      og.addColorStop(0, `rgba(255,255,255,${0.7 * o.lvl})`); og.addColorStop(0.3, `rgba(${r},${g},${bl},${0.4 * o.lvl})`); og.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = og;
      ctx.fillRect(x - bw * 3, h * 0.86 - bw * 3, bw * 6, bw * 6);
    }
    ctx.globalCompositeOperation = 'source-over';
    // horizon
    ctx.fillStyle = '#04050b';
    ctx.fillRect(0, h * 0.86, w, h * 0.14);
  });
  return { el: b.el, start: l.start, stop: l.stop, setPalette() {} };
}

export function createScope({ analyserL, analyserR } = {}) {
  const b = canvasBox('fv-scope');
  const buf = analyserL ? new Float32Array(analyserL.fftSize) : null;
  const l = loop(() => {
    const [w, h] = b.fit();
    const { ctx } = b;
    ctx.clearRect(0, 0, w, h);
    if (!buf) return;
    analyserL.getFloatTimeDomainData(buf);
    let start = 0;
    for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
    ctx.strokeStyle = 'rgba(92,242,255,.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const n = Math.min(512, buf.length - start);
    for (let i = 0; i < n; i++) { const x = (i / n) * w, y = h / 2 - buf[start + i] * h * 0.45; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
  });
  return { el: b.el, start: l.start, stop: l.stop, setMode() {} };
}

export function createSpectrum({ analyser } = {}) {
  const b = canvasBox('fv-spec');
  const bins = analyser ? new Float32Array(analyser.frequencyBinCount) : null;
  const l = loop(() => {
    const [w, h] = b.fit();
    const { ctx } = b;
    ctx.clearRect(0, 0, w, h);
    if (!bins) return;
    analyser.getFloatFrequencyData(bins);
    const sr = analyser.context.sampleRate;
    ctx.strokeStyle = 'rgba(167,139,250,.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = 20 * Math.pow(1000, x / w);
      const i = Math.min(bins.length - 1, Math.round((f / (sr / 2)) * bins.length));
      const db = Math.max(-100, bins[i]);
      const y = h - ((db + 100) / 90) * h;
      if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  });
  return { el: b.el, start: l.start, stop: l.stop };
}

export function createFilterView({ getParams, filterResponse, sampleRate = 48000 } = {}) {
  const b = canvasBox('fv-filter');
  const N = 160;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  function update() {
    const [w, h] = b.fit();
    const { ctx } = b;
    ctx.clearRect(0, 0, w, h);
    if (!filterResponse || !getParams) return;
    const p = getParams();
    let db;
    try { db = filterResponse(p.type, p.cutoff, p.res, p.drive, p.vowel, freqs, sampleRate); } catch { return; }
    const yOf = d => h * 0.35 - (d / 36) * h * 0.6;
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * w, y = Math.min(h, yOf(db[i])); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#a78bfa';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(167,139,250,.28)'); g.addColorStop(1, 'rgba(167,139,250,0)');
    ctx.fillStyle = g;
    ctx.fill();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(b.el);
  return { el: b.el, update };
}

const LFO_FN = {
  sine: x => Math.sin(2 * Math.PI * x), tri: x => 1 - 4 * Math.abs(((x + 0.25) % 1) - 0.5), saw: x => 2 * x - 1, ramp: x => 1 - 2 * x,
  square: x => (x < 0.5 ? 1 : -1), sh: x => Math.sin(Math.floor(x * 8) * 12.9898) % 1, smooth: x => Math.sin(2 * Math.PI * x) * 0.6 + Math.sin(6 * Math.PI * x + 1) * 0.3,
};
export function createLfoView({ getParams } = {}) {
  const b = canvasBox('fv-lfo');
  function update() {
    const [w, h] = b.fit();
    const { ctx } = b;
    ctx.clearRect(0, 0, w, h);
    const p = getParams ? getParams() : { shape: 'sine' };
    const f = LFO_FN[p.shape] || LFO_FN.sine;
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) { const x = (i / 200) * 2 + (p.phase || 0); const y = h / 2 - f(x % 1) * h * 0.38; if (i) ctx.lineTo((i / 200) * w, y); else ctx.moveTo(0, y); }
    ctx.strokeStyle = '#ffc46b';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(b.el);
  return { el: b.el, update };
}

export function createMeter({ getState } = {}) {
  const el = document.createElement('div');
  el.className = 'fv-meter';
  const L = document.createElement('i'), R = document.createElement('i');
  el.append(L, R);
  const l = loop(() => {
    const s = getState && getState();
    if (!s || !s.peak) return;
    const toW = v => `${Math.max(0, Math.min(100, (20 * Math.log10(v + 1e-9) + 48) / 48 * 100)).toFixed(1)}%`;
    L.style.width = toW(s.peak[0]);
    R.style.width = toW(s.peak[1]);
  });
  l.start();
  return { el };
}
