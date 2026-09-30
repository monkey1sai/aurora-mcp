// Checks for the magic sound tools (npm test → suite "magic"): moods (src/demo/moods.js), the store's transient /
// animate / commit / revert API (src/ui/app/store.js), A/B morph (src/ui/demo/morph.js) and auto-evolve targets
// (src/ui/demo/evolve.js). Node only, no DOM. Each check returns { name, probs: string[], info }.
//
//   import { magicChecks } from './magic-checks.mjs';
//   for (const c of await magicChecks(ROOT)) …

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Node 26 warns when UI modules touch the built-in localStorage: give them a quiet in-memory one. */
function quietLocalStorage() {
  const mem = new Map();
  const ls = {
    getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); }, clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  try { Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true }); } catch { /* keep */ }
}

async function run(name, fn) {
  const info = [];
  try {
    await fn(info);
    return { name, probs: [], info: info.join(' · ') };
  } catch (e) {
    return { name, probs: [String(e && e.message ? e.message : e).split('\n')[0].slice(0, 300)], info: info.join(' · ') };
  }
}

export async function magicChecks(ROOT) {
  quietLocalStorage();
  const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
  const [moodsM, presetsM, paramsM, storeM, morphM, evolveM] = await Promise.all([
    load('src/demo/moods.js'), load('src/presets/index.js'), load('src/dsp/params.js'), load('src/ui/app/store.js'),
    load('src/ui/demo/morph.js'), load('src/ui/demo/evolve.js'),
  ]);
  const { MOODS, applyMood, applyMoods, describeChanges, parseMoodText } = moodsM;
  const { PRESETS } = presetsM;
  const { resolveParams, PARAM_BY_ID, toNorm } = paramsM;
  const { createStore, blendValues, PATCH_IDS, sanitizeValue, normalizeMacros } = storeM;
  const out = [];

  /* ── every mood × every preset × 3 amounts, and 6 repeated applications ── */
  out.push(await run('moods: every mood × every preset (valid, audible, bounded, diminishing)', async (info) => {
    let n = 0;
    const noop = {};
    const check = (vals, ch, ctx) => {
      for (const id in ch) {
        const p = PARAM_BY_ID[id];
        assert.ok(p, `${ctx}: unknown param ${id}`);
        assert.ok(p.scope !== 'global', `${ctx}: writes global ${id}`);
        assert.deepEqual(sanitizeValue(p, ch[id]), ch[id], `${ctx}: ${id}=${ch[id]} not native/in range`);
      }
      const V = { ...vals, ...ch };
      assert.ok(['osc1', 'osc2', 'fm', 'phys', 'noise'].some(s => V[`${s}.on`] && V[`${s}.level`] > 0.02), `${ctx}: silent`);
      assert.ok(V['amp.level'] >= Math.min(-30, vals['amp.level']), `${ctx}: amp.level ${V['amp.level']}`);
      assert.ok(V['amp.level'] <= Math.max(vals['amp.level'] + 3.01, Math.min(6, Math.max(vals['amp.level'], 2) + 1)), `${ctx}: amp.level up ${vals['amp.level']} → ${V['amp.level']}`);
      return V;
    };
    for (const pr of PRESETS) {
      const base = resolveParams(pr.params);
      for (const m of MOODS) {
        for (const a of [0.15, 0.6, 1]) {
          const ch = applyMood(base, m.id, a);
          check(base, ch, `${pr.name}/${m.id}/${a}`);
          if (a === 0.6 && !Object.keys(ch).length) (noop[m.id] ||= []).push(pr.name);
          describeChanges(base, ch);
          n++;
        }
        let V = base, prev = base;
        const steps = [];
        for (let r = 0; r < 6; r++) {
          const ch = applyMood(V, m.id, 0.6);
          V = check(V, ch, `${pr.name}/${m.id}/rep${r}`);
          let d = 0;
          for (const id in ch) { const p = PARAM_BY_ID[id]; if (p.type === 'float' && id !== 'amp.level' && !/^mod\d/.test(id)) d += Math.abs(toNorm(p, ch[id]) - toNorm(p, prev[id])); }
          prev = V;
          steps.push(d);
        }
        assert.ok(steps[5] <= steps[0] + 1e-9, `${pr.name}/${m.id}: no diminishing returns (steps ${steps.map(x => x.toFixed(3)).join(' ')})`);
      }
    }
    const combo = applyMoods(resolveParams(PRESETS[0].params), [{ id: 'warmer', amount: 0.4 }, { id: 'wider', amount: 0.4 }]);
    assert.ok(Object.keys(combo).length > 0, 'applyMoods (warmer + wider) changed nothing');
    info.push(`${n} applications on ${PRESETS.length} presets × ${MOODS.length} moods`);
    const nn = Object.entries(noop).map(([k, v]) => `${k}: ${v.length}`);
    if (nn.length) info.push(`no-op at 0.6 (nothing to change): ${nn.join(', ')}`);
  }));

  /* ── free-text requests → moods ── */
  out.push(await run('moods: text requests (zh + en)', async (info) => {
    const want = {
      '不要那麼亮': ['darker'], '溫暖一點，再寬一點': ['warmer', 'wider'], '夢幻又空靈': ['dreamy', 'ethereal'], '80 年代復古': ['vintage'],
      '不要那麼寬': ['focused'], 'warmer and a bit wider': ['warmer', 'wider'], 'not so bright': ['darker'], 'way too dark': ['brighter'],
      'much more motion!!!': ['motion'], 'less wobble': ['steady'], 'hello world': [],
    };
    for (const [txt, ids] of Object.entries(want)) {
      const got = parseMoodText(txt).map(x => x.id);
      assert.deepEqual([...got].sort(), [...ids].sort(), `"${txt}" → ${JSON.stringify(got)} (want ${JSON.stringify(ids)})`);
      for (const x of parseMoodText(txt)) assert.ok(x.amount > 0 && x.amount <= 1, `"${txt}": amount ${x.amount}`);
    }
    info.push(`${Object.keys(want).length} phrases`);
  }));

  /* ── store transient API ── */
  out.push(await run('store: transient / animate / commit / revert / undo', async (info) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const s = createStore();
    s.attach({ setParam() {}, setParams() {}, loadPatch() {}, setMacro() {} });
    const AP = PRESETS.find(p => p.name === 'Aurora Pad');
    const TP = { ...AP, params: { ...AP.params, 'delay.on': false, 'delay.mix': 0.25, 'chorus.on': true } };
    s.loadPreset(TP);
    assert.equal(s.isDirty(), false);
    const cut0 = s.get('filter.cutoff'), rm0 = s.get('reverb.mix'), res0 = s.get('filter.res'), chm0 = s.get('chorus.mix');
    const seen = [];
    s.subscribe('filter.cutoff', (v, o) => seen.push(o));
    // transient write: no undo step, not dirty
    s.setTransient('filter.cutoff', 3000);
    assert.equal(s.get('filter.cutoff'), 3000);
    assert.equal(s.committed('filter.cutoff'), cut0);
    assert.equal(s.isDirty(), false, 'transient made the patch dirty');
    assert.equal(s.canUndo(), false, 'transient added an undo step');
    assert.deepEqual(seen, ['transient']);
    // commit → exactly one undo step
    assert.equal(s.commit('test'), 1);
    assert.equal(s.canUndo(), true);
    s.undo();
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.isDirty(), false);
    // revert
    s.setTransientMany({ 'filter.cutoff': 500, 'reverb.mix': 0.6 });
    s.revert();
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.isTransient(), false);
    // a regular set commits that param only
    s.setTransientMany({ 'filter.cutoff': 500, 'reverb.mix': 0.6 });
    s.set('filter.cutoff', 700);
    assert.equal(s.isTransient('filter.cutoff'), false);
    assert.equal(s.isTransient('reverb.mix'), true);
    s.undo();
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.get('reverb.mix'), rm0);
    // animate with commit: FX switched on fade in, switched off fade out; one undo step
    const h = s.animate({ 'filter.cutoff': 6000, 'chorus.on': false, 'delay.on': true }, { ms: 200, commit: 'anim' });
    let mid = null;
    setTimeout(() => { mid = { cut: s.get('filter.cutoff'), ch: s.get('chorus.on'), chm: s.get('chorus.mix'), dl: s.get('delay.on'), dm: s.get('delay.mix') }; }, 100);
    assert.equal(await h.done, true);
    assert.equal(s.get('filter.cutoff'), 6000);
    assert.equal(s.get('chorus.on'), false);
    assert.equal(s.get('chorus.mix'), chm0, 'chorus mix not restored after its fade-out');
    assert.equal(s.get('delay.on'), true);
    assert.equal(s.get('delay.mix'), 0.25);
    assert.ok(mid && mid.ch === true && mid.chm < chm0 && mid.chm > 0, `chorus not fading out mid-animation ${JSON.stringify(mid)}`);
    assert.ok(mid.dl === true && mid.dm > 0 && mid.dm < 0.25, `delay not fading in mid-animation ${JSON.stringify(mid)}`);
    assert.ok(mid.cut > cut0 && mid.cut < 6000, 'cutoff not gliding');
    assert.equal(s.isTransient(), false, `transient leftovers ${s.transientIds()}`);
    s.undo();
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.get('delay.on'), false);
    assert.equal(s.canUndo(), false);
    // undo during an animation finishes + commits it, then undoes
    s.animate({ 'filter.cutoff': 300 }, { ms: 300, commit: 'anim2' });
    await wait(60);
    s.undo();
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.isAnimating(), false);
    // the user grabbing a knob during an animation takes that param over
    const h3 = s.animate({ 'filter.cutoff': 300, 'filter.res': 0.5 }, { ms: 300, commit: 'anim3' });
    await wait(60);
    s.set('filter.res', 0.2);
    await h3.done;
    assert.equal(s.get('filter.res'), 0.2);
    assert.equal(s.get('filter.cutoff'), 300);
    s.undo(); s.undo();
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.get('filter.res'), res0);
    // commit with macros/meta = one whole-patch step
    s.setTransientMany({ 'filter.cutoff': 900 });
    s.commit('keep', { macros: [{ name: 'X', targets: [{ id: 'filter.cutoff', amount: 0.5 }] }], meta: { name: 'Kept' } });
    assert.equal(s.getMeta().name, 'Kept');
    s.undo();
    assert.equal(s.getMeta().name, 'Aurora Pad');
    assert.equal(s.get('filter.cutoff'), cut0);
    // loadPreset / markClean drop transients
    s.setTransient('filter.cutoff', 1000);
    s.loadPreset(PRESETS[3]);
    assert.equal(s.isTransient(), false);
    s.setTransient('filter.cutoff', 1234);
    s.markClean();
    assert.equal(s.isTransient(), false);
    assert.equal(s.get('filter.cutoff'), 1234);
    // revert with a glide
    s.loadPreset(TP);
    s.setTransientMany({ 'filter.cutoff': 100, 'reverb.on': false });
    await new Promise(r => s.revert({ ms: 120, onDone: r }));
    assert.equal(s.get('filter.cutoff'), cut0);
    assert.equal(s.get('reverb.on'), true);
    assert.equal(s.isTransient(), false, `leftover ${s.transientIds()}`);
    // evolve drift on one param must not leak into a mood commit on another
    const s2 = createStore();
    s2.loadPreset(TP);
    const rm = s2.get('reverb.mix');
    s2.setTransient('reverb.mix', rm + 0.1, { owner: 'evolve' });
    await s2.animate({ 'reverb.decay': 9 }, { ms: 50, commit: 'mood' }).done;
    assert.equal(s2.isTransient('reverb.mix'), true);
    assert.equal(s2.committed('reverb.mix'), rm);
    s2.undo();
    assert.equal(s2.get('reverb.mix'), rm);
    assert.notEqual(s2.get('reverb.decay'), 9);
    // blendValues endpoints are exact, in between is finite
    for (let i = 0; i < 100; i++) {
      const A = resolveParams(PRESETS[i % PRESETS.length].params), B = resolveParams(PRESETS[(i * 7 + 3) % PRESETS.length].params);
      const b0 = blendValues(A, B, 0), b1 = blendValues(A, B, 1);
      for (const id of PATCH_IDS) { assert.equal(b0[id], A[id], `blend t=0 ${id}`); assert.equal(b1[id], B[id], `blend t=1 ${id}`); }
      const b = blendValues(A, B, 0.37);
      for (const id of PATCH_IDS) assert.ok(b[id] !== undefined && (typeof b[id] !== 'number' || Number.isFinite(b[id])), `blend ${id}`);
    }
    info.push('transient, commit, revert, animate (FX fades, take-over, undo mid-animation), drift isolation, blend');
  }));

  /* ── morph + evolve ── */
  out.push(await run('morph (A/B) + auto-evolve targets', async (info) => {
    const { morphPatch, presetValues, effectiveValues } = morphM;
    const { evolveTargets, driftNoise } = evolveM;
    const side = p => ({ values: presetValues(p), macros: normalizeMacros(p.macros) });
    let rng = 12345; const rnd = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
    const SRC = ['osc1', 'osc2', 'fm', 'phys', 'noise'];
    let pairs = 0;
    for (let k = 0; k < 120; k++) {
      const pa = PRESETS[Math.floor(rnd() * PRESETS.length)], pb = PRESETS[Math.floor(rnd() * PRESETS.length)];
      const A = side(pa), B = side(pb);
      const m0 = morphPatch(A, B, 0), m1 = morphPatch(A, B, 1);
      for (const id of PATCH_IDS) { assert.deepEqual(m0.values[id], A.values[id], `${pa.name}→${pb.name} t=0 ${id}`); assert.deepEqual(m1.values[id], B.values[id], `${pa.name}→${pb.name} t=1 ${id}`); }
      for (let i = 0; i <= 25; i++) {
        const t = i / 25;
        const m = morphPatch(A, B, t);
        for (const id of PATCH_IDS) assert.deepEqual(sanitizeValue(PARAM_BY_ID[id], m.values[id]), m.values[id], `${pa.name}→${pb.name} t=${t} ${id}=${m.values[id]}`);
        // something is audible at every point (the ½ switch used to fall silent)
        const eff = effectiveValues(m.values, m.macros);
        const lv = SRC.reduce((s, g) => s + (eff[`${g}.on`] ? eff[`${g}.level`] : 0), 0);
        const lvA = SRC.reduce((s, g) => s + (A.values[`${g}.on`] ? A.values[`${g}.level`] : 0), 0);
        const lvB = SRC.reduce((s, g) => s + (B.values[`${g}.on`] ? B.values[`${g}.level`] : 0), 0);
        assert.ok(lv > 0.2 * Math.min(lvA, lvB), `${pa.name}→${pb.name} t=${t}: level sum ${lv.toFixed(3)} (A ${lvA.toFixed(2)}, B ${lvB.toFixed(2)})`);
      }
      pairs++;
    }
    let tot = 0;
    for (const p of PRESETS) {
      const v = presetValues(p);
      const ts = evolveTargets(v, normalizeMacros(p.macros), { macros: true, timbre: true, space: true });
      for (const t of ts) {
        assert.ok(PARAM_BY_ID[t.id], `evolve target ${t.id}`);
        const x = toNorm(PARAM_BY_ID[t.id], v[t.id]);
        assert.ok(t.lo <= x + 1e-9 && t.hi >= x - 1e-9, `${p.name} ${t.id}: range [${t.lo}, ${t.hi}] excludes ${x}`);
        assert.ok(t.depth > 0 && t.depth <= 0.45, `${p.name} ${t.id}: depth ${t.depth}`);
      }
      tot += ts.length;
    }
    let lo = 1, hi = -1;
    for (let x = 0; x < 200; x += 0.013) { const n = driftNoise(x, 7); lo = Math.min(lo, n); hi = Math.max(hi, n); }
    assert.ok(lo >= -1 && hi <= 1 && hi - lo > 1, `driftNoise range ${lo} … ${hi}`);
    info.push(`${pairs} random preset pairs × 26 points · evolve ${(tot / PRESETS.length).toFixed(1)} targets/preset`);
  }));
  return out;
}
