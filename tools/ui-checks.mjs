// Checks for the app shell logic that runs without a DOM (npm test → suite "ui"): undo / dirty semantics of
// the patch store (preset switches, macros, Init), the preset library's storage handling, MIDI hot-unplug,
// accessible names of unlabeled controls, the jargon help table, and a few CSS layout guards.
// Each check returns { name, probs: string[], info }.
//
//   import { uiChecks } from './ui-checks.mjs';
//   for (const c of await uiChecks(ROOT)) …

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** In-memory localStorage (optionally failing writes) so UI modules run in Node. */
function memoryStorage() {
  const mem = new Map();
  const ls = {
    failWrites: false, writes: 0,
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem(k, v) { if (ls.failWrites) throw new Error('QuotaExceededError'); ls.writes++; mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); }, clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  try { Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true }); } catch { /* keep */ }
  return ls;
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

export async function uiChecks(ROOT) {
  const ls = memoryStorage();
  const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
  const [storeM, libM, kbM, compM, helpM, paramsM, presetsM] = await Promise.all([
    load('src/ui/app/store.js'), load('src/ui/app/library.js'), load('src/ui/keyboard.js'), load('src/ui/components.js'),
    load('src/ui/app/paramHelp.js'), load('src/dsp/params.js'), load('src/presets/index.js'),
  ]);
  const { createStore } = storeM;
  const { PARAMS, PARAM_BY_ID } = paramsM;
  const { PRESETS } = presetsM;
  const pa = PRESETS.find(p => p.name === 'Aurora Pad') || PRESETS[0];
  const pb = PRESETS.find(p => p !== pa);
  const out = [];

  /* ── leaving an edited patch is one undo step (the edits come back, with their "modified" flag) ── */
  out.push(await run('store: preset switch keeps unsaved edits undoable (UF-01)', async (info) => {
    const s = createStore();
    s.loadPreset(pa, { source: 'factory', key: 'f:a' });
    const c0 = s.get('filter.cutoff');
    s.set('filter.cutoff', 7566);
    assert.equal(s.isDirty(), true, 'edit marks dirty');
    // what main.js loadEntry does when the patch is dirty
    s.loadPreset(pb, { source: 'factory', key: 'f:b', record: true, dirty: false });
    assert.equal(s.getMeta().name, pb.name);
    assert.equal(s.isDirty(), false, 'the newly loaded preset is clean');
    assert.equal(s.canUndo(), true, 'history kept');
    s.undo();
    assert.equal(s.getMeta().name, pa.name, 'undo brings the edited patch back');
    assert.equal(s.get('filter.cutoff'), 7566, 'with the edit');
    assert.equal(s.isDirty(), true, 'and its modified flag');
    s.undo();
    assert.equal(s.get('filter.cutoff'), c0);
    assert.equal(s.isDirty(), false, 'undoing the edit too: clean against the ORIGINAL preset (clean reference restored)');
    s.redo(); s.redo();
    assert.equal(s.getMeta().name, pb.name);
    assert.equal(s.isDirty(), false, 'redo of the switch restores the clean flag');
    info.push('edit → switch → undo ×2 → redo ×2');
  }));

  out.push(await run('store: macro knobs are undoable and mark the patch modified (UF-02)', async (info) => {
    const s = createStore();
    s.loadPreset(pa, { source: 'factory' });
    const m0 = s.get('macro1');
    s.set('macro1', 0.9);
    assert.equal(s.isDirty(), true, 'macro move marks dirty');
    assert.equal(s.canUndo(), true, 'macro move is undoable');
    s.undo();
    assert.equal(s.get('macro1'), m0);
    assert.equal(s.isDirty(), false);
    // XY pad: both axes per event, one coalesced step for a whole drag
    for (let i = 1; i <= 20; i++) s.setMany({ macro1: i / 25, macro2: 1 - i / 25 }, { origin: 'xy', coalesce: 'xy' });
    let n = 0;
    while (s.canUndo()) { s.undo(); n++; }
    assert.equal(n, 1, `XY drag → ${n} undo steps (want 1)`);
    // engine-followed values (demo macro rides) stay out of the history
    s.set('macro3', 0.7, { record: false, send: false, origin: 'engine' });
    assert.equal(s.canUndo(), false, 'record:false macro write recorded');
    // master volume stays out of the history
    s.set('master.volume', -12);
    assert.equal(s.canUndo(), false, 'master.volume recorded');
    info.push('knob, XY drag (1 step), engine follow, master volume');
  }));

  out.push(await run('store: Init patch — undo back to Init is clean (UF-13)', async () => {
    const s = createStore();
    s.loadPreset(pa, { source: 'factory' });
    s.loadPreset({ name: 'Init', params: {}, macros: [] }, { source: 'init', record: true, dirty: false });
    assert.equal(s.isDirty(), false);
    s.set('osc1.shape', 0.9);
    assert.equal(s.isDirty(), true);
    s.undo();
    assert.equal(s.isDirty(), false, 'undo to Init still modified');
    s.undo();
    assert.equal(s.getMeta().name, pa.name);
    assert.equal(s.isDirty(), false, 'undo past Init: back to the clean preset');
  }));

  out.push(await run('store: silent demo apply/restore leaves the dirty flag alone', async () => {
    const s = createStore();
    s.loadPreset(pa, { source: 'factory' });
    s.setMacroDefs(pb.macros || [], { record: false });
    assert.equal(s.isDirty(), false, 'setMacroDefs({record:false}) marked the patch modified');
    s.setMacroDefs(pa.macros || []);
    assert.equal(s.isDirty(), true, 'a recorded macro-definition change must mark it modified');
  }));

  /* ── preset library: one write per import, nothing phantom when storage fails ── */
  out.push(await run('library: batch import + storage failure (UF-04, UF-05)', async (info) => {
    ls.clear(); ls.failWrites = false;
    const lib = libM.createLibrary({ factory: PRESETS.slice(0, 3) });
    let events = 0;
    lib.onChange(() => events++);
    const w0 = ls.writes;
    const batch = Array.from({ length: 300 }, (_, i) => ({ name: `Bank ${i}`, category: 'pad', params: { 'filter.cutoff': 500 + i }, macros: [] }));
    const saved = lib.saveMany(batch);
    assert.equal(saved && saved.length, 300);
    assert.equal(ls.writes - w0, 1, `import wrote storage ${ls.writes - w0}× (want 1)`);
    assert.equal(events, 1, `import emitted ${events} change events (want 1)`);
    assert.equal(lib.user().length, 300);
    ls.failWrites = true;
    const e = lib.saveUser({ name: 'Q1', category: 'pad', params: {}, macros: [] });
    assert.equal(e, null, 'saveUser must report the failure');
    assert.equal(lib.hasUser('Q1'), false, 'failed save left a phantom preset');
    assert.equal(lib.saveMany(batch.slice(0, 2).map(p => ({ ...p, name: `${p.name}x` }))), null);
    assert.equal(lib.user().length, 300, 'failed import changed the list');
    assert.equal(lib.deleteUser('u:Bank 0'), false, 'failed delete must keep the entry');
    assert.equal(lib.hasUser('Bank 0'), true);
    ls.failWrites = false;
    assert.equal(lib.deleteUser('u:Bank 0'), true);
    info.push('300 presets → 1 write, 1 event');
  }));

  /* ── MIDI hot-unplug resets the controllers that device set ── */
  out.push(await run('midi: unplug releases notes and latched sustain / bend / wheel (UF-10)', async () => {
    const st = kbM.createMidiState();
    const got = [];
    const cb = { onNoteOn: () => {}, onNoteOff: n => got.push(['off', n]), onController: (k, v) => got.push([k, v]), channel: null };
    kbM.handleMidiMessage(st, 'A', [0x90, 60, 100], cb);
    kbM.handleMidiMessage(st, 'A', [0xb0, 64, 127], cb); // sustain down
    kbM.handleMidiMessage(st, 'A', [0xe0, 0x7f, 0x7f], cb); // bend up
    kbM.handleMidiMessage(st, 'A', [0xb0, 1, 64], cb); // wheel
    kbM.handleMidiMessage(st, 'B', [0xe0, 0x00, 0x20], cb); // device B bends later: B owns the bend now
    got.length = 0;
    kbM.releaseMidiInput(st, 'A', cb);
    const k = got.map(x => x.join(':'));
    assert.ok(k.includes('off:60'), `note not released: ${k}`);
    assert.ok(k.includes('sustain:0'), `sustain not released: ${k}`);
    assert.ok(k.includes('wheel:0'), `wheel not reset: ${k}`);
    assert.ok(!k.some(x => x.startsWith('bend')), `bend reset although device B set it last: ${k}`);
    got.length = 0;
    kbM.releaseMidiInput(st, 'B', cb);
    assert.ok(got.some(([kk, v]) => kk === 'bend' && v === 0), 'bend of device B not reset');
  }));

  /* ── accessible names: never a raw param id ── */
  out.push(await run('a11y: unlabeled controls get words, not ids (UX-04)', async (info) => {
    const bad = [];
    for (const p of PARAMS) {
      const n = compM.fallbackName(p);
      if (!n || /^[a-z]+\d*\.[\w.]+$/.test(n) || n === p.id) bad.push(`${p.id} → '${n}'`);
    }
    assert.equal(bad.length, 0, bad.slice(0, 6).join(', '));
    assert.equal(compM.fallbackName(PARAM_BY_ID['fm.on']), 'FM 合成 開關 FM on');
    assert.ok(/振盪器 1/.test(compM.fallbackName(PARAM_BY_ID['osc1.level'])), 'osc1.level lacks its module name');
    assert.equal(compM.fallbackName(PARAM_BY_ID['master.volume']), '總音量 Master');
    info.push(`${PARAMS.length} params`);
  }));

  out.push(await run('help: jargon explanations point at real params', async (info) => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/app/paramHelp.js'), 'utf8');
    const keys = [...src.matchAll(/^\s*'([^']+)':\s*\[/gm)].map(m => m[1]);
    const miss = keys.filter(k => (k.startsWith('*.') ? !PARAMS.some(p => p.id.endsWith(k.slice(1))) : !PARAM_BY_ID[k]));
    assert.equal(miss.length, 0, `unknown ids: ${miss.join(', ')}`);
    assert.ok(helpM.paramHelp('osc1.pw'), 'osc1.pw has no help');
    assert.equal(helpM.paramHelp('fm.op1.detune'), null, 'unison detune text used for an FM operator');
    const covered = PARAMS.filter(p => helpM.paramHelp(p.id)).length;
    info.push(`${keys.length} entries cover ${covered} params`);
  }));

  /* ── layout guards (CSS) ── */
  out.push(await run('css: phone dock keeps octave / hold; short screens compact the dock column', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
    const block = (q) => {
      const i = css.indexOf(q);
      assert.ok(i >= 0, `missing ${q}`);
      let d = 0, j = css.indexOf('{', i);
      const s0 = j;
      for (; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}' && --d === 0) break; }
      return css.slice(s0, j);
    };
    const phone = block('@media (max-width: 899px) {');
    assert.ok(!/\.dock__ctl\s*\{\s*display:\s*none/.test(phone), 'phone layout hides the octave / hold controls again');
    assert.ok(/safe-area-inset-bottom/.test(phone), 'phone dock ignores the home-indicator inset');
    const short = block('@media (max-height: 820px) and (min-width: 900px) {');
    assert.ok(/\.dock__ctl\s*\{[^}]*gap/.test(short) && /\.hold\s*\{[^}]*height/.test(short), 'short-screen dock column not compacted (it overflowed by 4 px)');
    assert.ok(/@media \(max-width: 899px\) and \(orientation: landscape\)/.test(css), 'no phone-landscape layout');
  }));
  return out;
}
