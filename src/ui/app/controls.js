// Binding layer: schema-driven controls (components.js) wired to the store, plus modulation arcs on
// knobs (mod-matrix ranges and macro offsets, drawn with knob.setModulation).

import {
  createKnob, createSlider, createToggle, createSelect, createEnvelopeEditor,
} from '../components.js';
import { PARAM_BY_ID, MOD_SLOTS, toNorm, fromNorm } from '../../dsp/params.js';
import { paramLabel } from './i18n.js';
import { rafThrottle, clamp01 } from './dom.js';

/** Colour per modulation source (mod matrix rows, arcs). */
export const SOURCE_COLORS = {
  none: '#5a6284', lfo1: '#5cf2ff', lfo2: '#3ef0b0', menv: '#ffc46b', fenv: '#a78bfa', aenv: '#ff9f6b',
  velocity: '#ff6bd6', note: '#7aa2ff', wheel: '#b8f36b', aftertouch: '#ff8fb1', bend: '#6be4ff', random: '#ff6b81',
};
export const MACRO_COLORS = ['#3ef0b0', '#5cf2ff', '#a78bfa', '#ff6bd6'];
export const ACCENTS = {
  sources: 'var(--a-cyan)', filter: 'var(--a-violet)', mod: 'var(--a-amber)', fx: 'var(--a-pink)', perform: 'var(--a-teal)',
};
const BIPOLAR_SRC = new Set(['lfo1', 'lfo2', 'note', 'bend', 'random']);
// filter.env sweeps the cutoff by env·6 octaves; the cutoff knob spans log2(20000/20) ≈ 9.97 octaves
const ENV_OCT_NORM = 6 / Math.log2(1000);

/** FM ratios that "snap" when a ratio knob is released close to them. */
const NICE_RATIOS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

export function createBinder(store) {
  const registry = new Map(); // id → Set<knob api>

  /* ── modulation arcs ── */
  function effAmount(id, macroOff) {
    const p = PARAM_BY_ID[id];
    const off = macroOff.get(id);
    const v = store.get(id);
    if (!off) return v;
    return fromNorm(p, clamp01(toNorm(p, v) + off.off));
  }
  function computeMod() {
    const macros = store.getMacros();
    const macroOff = new Map(); // id → { off, color, w }
    macros.forEach((m, i) => {
      const mv = +store.get(`macro${i + 1}`) || 0;
      for (const t of m.targets) {
        const d = t.amount * mv;
        const cur = macroOff.get(t.id) || { off: 0, color: MACRO_COLORS[i], w: 0 };
        cur.off += d;
        if (Math.abs(d) > cur.w) { cur.w = Math.abs(d); cur.color = MACRO_COLORS[i]; }
        macroOff.set(t.id, cur);
      }
    });
    const matrix = new Map(); // id → { lo, hi, color }
    for (let s = 1; s <= MOD_SLOTS; s++) {
      const src = store.get(`mod${s}.src`), dst = store.get(`mod${s}.dst`);
      if (src === 'none' || dst === 'none') continue;
      const amt = effAmount(`mod${s}.amt`, macroOff);
      if (!amt) continue;
      const a = Math.abs(amt);
      const [lo, hi] = BIPOLAR_SRC.has(src) ? [-a, a] : amt > 0 ? [0, amt] : [amt, 0];
      const cur = matrix.get(dst) || { lo: 0, hi: 0, color: SOURCE_COLORS[src] };
      cur.lo += lo; cur.hi += hi;
      matrix.set(dst, cur);
    }
    // filter envelope sweep on the cutoff knob
    const envAmt = effAmount('filter.env', macroOff);
    if (envAmt) {
      const e = envAmt * ENV_OCT_NORM;
      const cur = matrix.get('filter.cutoff') || { lo: 0, hi: 0, color: SOURCE_COLORS.fenv };
      if (e > 0) cur.hi += e; else cur.lo += e;
      matrix.set('filter.cutoff', cur);
    }
    return { macroOff, matrix };
  }
  function updateArcs() {
    if (!registry.size) return;
    const { macroOff, matrix } = computeMod();
    for (const [id, set] of registry) {
      if (!set.size) continue;
      const p = PARAM_BY_ID[id];
      const base = toNorm(p, store.get(id));
      const mo = macroOff.get(id);
      const eff = clamp01(base + (mo ? mo.off : 0));
      const mx = matrix.get(id);
      let lo = null, hi = null, color = null;
      if (mx) { lo = clamp01(eff + mx.lo); hi = clamp01(eff + mx.hi); color = mx.color; }
      else if (mo && Math.abs(eff - base) > 0.002) { lo = Math.min(base, eff); hi = Math.max(base, eff); color = mo.color; }
      for (const k of set) {
        k.setModulation(lo, hi, color || undefined);
        k.el.classList.toggle('is-modulated', lo !== null);
      }
    }
  }
  const arcs = rafThrottle(updateArcs);
  store.onAny(() => arcs());
  store.onMacros(() => arcs());

  function reg(scope, id, k) {
    let set = registry.get(id);
    if (!set) { set = new Set(); registry.set(id, set); }
    set.add(k);
    scope.add(() => set.delete(k));
    arcs();
  }

  const labelOf = (p, label) => (label === undefined ? paramLabel(p) : label);

  /** Knob bound to a param. opts: size, accent, label, showValue, bipolar, snap:'ratio', title, cls */
  function knob(scope, id, opts = {}) {
    const p = PARAM_BY_ID[id];
    if (!p) throw new Error(`knob: unknown param ${id}`);
    let k = null;
    k = createKnob({
      param: p, value: store.get(id), size: opts.size || 'sm', accent: opts.accent,
      label: labelOf(p, opts.label), showValue: opts.showValue ?? true, bipolar: opts.bipolar,
      onChange: (v) => { store.set(id, v, { origin: k }); if (opts.onChange) opts.onChange(v); },
    });
    if (opts.cls) k.el.classList.add(...opts.cls.split(' '));
    if (opts.title) k.el.title = opts.title;
    scope.add(store.subscribe(id, (v, origin) => { if (origin !== k) k.setValue(v); }));
    scope.add(() => k.destroy && k.destroy());
    reg(scope, id, k);
    if (opts.snap === 'ratio') {
      k.el.addEventListener('pointerup', (e) => {
        if (e.shiftKey) return;
        const v = store.get(id);
        let best = null, bd = Infinity;
        for (const r of NICE_RATIOS) { const d = Math.abs(Math.log(v / r)); if (d < bd) { bd = d; best = r; } }
        if (best !== null && bd < 0.025 && best !== v) {
          store.set(id, best, { origin: 'snap' });
        }
      });
    }
    return k;
  }

  function slider(scope, id, opts = {}) {
    const p = PARAM_BY_ID[id];
    let sl = null;
    sl = createSlider({
      param: p, value: store.get(id), orientation: opts.orientation || 'h', accent: opts.accent,
      label: labelOf(p, opts.label), showValue: opts.showValue ?? true, bipolar: opts.bipolar,
      onChange: (v) => { store.set(id, v, { origin: sl }); if (opts.onChange) opts.onChange(v); },
    });
    scope.add(store.subscribe(id, (v, origin) => { if (origin !== sl) sl.setValue(v); }));
    scope.add(() => sl.destroy && sl.destroy());
    return sl;
  }

  function toggle(scope, id, opts = {}) {
    const p = PARAM_BY_ID[id];
    let tg = null;
    tg = createToggle({
      param: p, value: store.get(id), accent: opts.accent, size: opts.size || 'md',
      label: opts.label === undefined ? undefined : opts.label,
      onChange: (v) => { store.set(id, v, { origin: tg }); if (opts.onChange) opts.onChange(v); },
    });
    scope.add(store.subscribe(id, (v, origin) => { if (origin !== tg) tg.setValue(v); }));
    return tg;
  }

  function select(scope, id, opts = {}) {
    const p = PARAM_BY_ID[id];
    let se = null;
    se = createSelect({
      param: p, value: store.get(id), accent: opts.accent, variant: opts.variant || 'auto',
      label: labelOf(p, opts.label),
      onChange: (v) => { store.set(id, v, { origin: se }); if (opts.onChange) opts.onChange(v); },
    });
    scope.add(store.subscribe(id, (v, origin) => { if (origin !== se) se.setValue(v); }));
    scope.add(() => se.destroy && se.destroy());
    return se;
  }

  /** ADSR editor bound to `${prefix}.a/d/s/r/curve`. */
  function envelope(scope, prefix, opts = {}) {
    const keys = ['a', 'd', 's', 'r', 'curve'];
    const values = {};
    for (const k of keys) values[k] = store.get(`${prefix}.${k}`);
    let ed = null;
    ed = createEnvelopeEditor({
      values, prefix, accent: opts.accent,
      onChange: (partial) => {
        const o = {};
        for (const k in partial) o[`${prefix}.${k}`] = partial[k];
        store.setMany(o, { origin: ed, coalesce: `env:${prefix}` });
      },
    });
    for (const k of keys) {
      scope.add(store.subscribe(`${prefix}.${k}`, (v, origin) => { if (origin !== ed) ed.setValues({ [k]: v }); }));
    }
    scope.add(() => ed.destroy && ed.destroy());
    return ed;
  }

  /** Run fn(store) now and whenever any of `ids` changes (for enabling/dimming/labels). */
  function watch(scope, ids, fn) {
    const run = rafThrottle(() => fn(store));
    for (const id of ids) scope.add(store.subscribe(id, () => run()));
    fn(store);
    return run;
  }

  /** Effective native value = base + macro offsets (what the engine hears before per-voice modulation). */
  function effective(id) {
    const p = PARAM_BY_ID[id];
    const v = store.get(id);
    if (!p || (p.type !== 'float' && p.type !== 'int')) return v;
    let off = 0;
    store.getMacros().forEach((m, i) => {
      const mv = +store.get(`macro${i + 1}`) || 0;
      for (const tg of m.targets) if (tg.id === id) off += tg.amount * mv;
    });
    return off ? fromNorm(p, clamp01(toNorm(p, v) + off)) : v;
  }

  return { knob, slider, toggle, select, envelope, watch, effective, refreshArcs: arcs, computeMod };
}
