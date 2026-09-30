// Take B — the app itself. Every shot is set up off-beat in a gap (preset loads, tab switches, Demo Center
// opening/closing, camera re-rasters: the app's own hitches happen there), then runs on its own beat grid. Each
// shot's window is written to the report as a mark { label: 'shot', id, start, dur } — tools/video/edit.mjs cuts
// exactly those windows onto the film's beat grid (song beats in brackets):
//
//   H   [188–192]  the hook over the whole live UI: "Claude can't hear. / It built this synth anyway." fully formed on
//                  frame 0 (= the poster), presets flipping on every beat, chords lighting the hero and the keys
//   D   [192–200]  the drop: slam into the hero (12-note chord, flash) "A synthesizer built by Claude" → pull back to
//                  a generic browser window "Runs entirely in a browser tab"
//   P   [208–216]  8 presets, one per beat, hero close-up: "100 presets. Zero samples."
//   E1–E4 [216–220, composited 2×2 by the edit]  wavetable scan · FM algorithms · physical models · ladder sweep
//   T   [220–224]  a sound tour: the cutoff knob turns itself (Acid Bass, step 8), 2.2× on the knob + curve
//   M   [224–228]  one tap: "Ethereal" (cursor, button, change log)
//   Q   [252–256]  "Claude has never heard it. / But you can." over the idle UI (the music's breakdown bar)
//   Z   [256–260]  the full band returns: chord explosion, AURORA 極光 · Built with Claude Code · Claude Opus 5.5
//
//   node tools/video/record.mjs --timeline tools/video/timelines/ui.mjs --out renders/video/takes/ui-en.mp4 --lang en
//   --set only=H,D   records just those shots (quick tests)
import { BEAT, TEXT, chord, installStage } from './lib.mjs';

export const meta = { title: 'X film · take B · the app', tail: 0.3, cursor: 'overlay', preload: Object.values(TEXT).flatMap(t => [t.en, t.zh]) };

const GAP = 0.45;       // settle time between a shot's set-up and its first frame

// preset flips: the hero palette follows the category (keys/pad/fx aurora · bass/lead/strings/drum sunset · pluck/bell/arp ocean)
const HOOK_PRESETS = ['Stellar Supersaw', 'Starlight Harp', 'Aurora Pad', 'Jade Guzheng'];
const FLIP_PRESETS = ['Ivory Hall Grand', 'Autumn Moon Erhu', 'Dewdrop Kalimba', 'Singularity', 'Molten Scream', 'Glass Harmonica', 'Kaleidoscope', 'Thunder Taiko'];
const E_SPREAD = [40, 47, 52, 56, 59, 64, 68, 71, 76];                         // E (the bed is on E under the hook)
const AM_BIG = [33, 40, 45, 52, 57, 60, 64, 69, 72, 76, 81, 84];              // Am across 5 octaves (the drop / the end)
const AM = [45, 52, 57, 60, 64, 69];

export async function prepare(ctx) {
  await installStage(ctx);
  // the document itself must never scroll (a preset row's scrollIntoView() would drag the whole page up)
  await ctx.evalApp(() => {
    const pin = () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); const se = document.scrollingElement; if (se && se.scrollTop) se.scrollTop = 0; };
    window.addEventListener('scroll', pin, { passive: true });
    pin();
    return true;
  });
  // warm every preset the take flips through (first loads build DSP tables: keep that off camera)
  for (const n of [...HOOK_PRESETS, ...FLIP_PRESETS, 'Singularity', 'Platinum Ballad', 'Acid Serpent', 'Sunset Poly', 'Moonlit Suitcase']) {
    await ctx.aurora.loadPresetByName(n);
    await ctx.aurora.noteOn(57, 0.6); await ctx.wait(60); await ctx.aurora.noteOff(57);
  }
  await ctx.aurora.loadPresetByName('Stellar Supersaw');
  await ctx.overlay.cursor.hide({ ms: 0 });
  await parkPointer(ctx);
  await ctx.wait(800);
}
/** the (invisible) pointer rests on static text: hovering a macro knob would pop its targets tooltip into the shot */
const parkPointer = ctx => ctx.moveTo([60, 912], { ms: 0, cursor: false });

export default async function ui(ctx) {
  const only = ctx.args.only ? new Set(String(ctx.args.only).split(',')) : null;
  const want = id => !only || only.has(id);
  const vx = ctx.director.vx;
  const app = (fn, ...a) => ctx.evalApp(fn, ...a);
  const load = name => ctx.aurora.loadPresetByName(name);
  const tab = id => app(id => { document.querySelector(`#tab-${id}`).click(); return true; }, id);
  const source = i => app(i => { document.querySelectorAll('.src-strip__sel')[i].click(); return true; }, i);
  const scrollMain = y => app(y => { const m = document.querySelector('main'); m.scrollTop = y; return m.scrollTop; }, y);
  const glide = (values, ms) => app((values, ms) => { window.__aurora.store.animate(values, { ms, ease: 'inOut' }); return true; }, values, ms);
  const camAt = (x, y, s, opts) => ctx.camera.frameFor([x, y, 0, 0], s, opts);
  const scaleAbout = (st, k) => ({ s: st.s * k, x: 960 - (960 - st.x) * k, y: 540 - (540 - st.y) * k });
  /** hard cut to a framing with a 1.035× punch: preCut() in the gap (the re-raster happens off camera), settle() on the beat */
  const preCut = (st, punch = 1.035) => ctx.camera.set(scaleAbout(st, punch));
  const settle = st => ctx.camera.to(st, 320, 'outCubic');
  const ms = beats => Math.round(beats * BEAT * 1000);
  let T = 0.6;
  const at = b => ctx.at(T + b * BEAT);
  /** open a shot window: T = now + gap (after the set-up) */
  const open = async (id, beats, gap = GAP) => {
    await app(() => { window.scrollTo(0, 0); return true; });
    T = Math.max(T, (await ctx.now()) + gap);
    await ctx.mark('shot', { id, start: +T.toFixed(4), dur: +(beats * BEAT).toFixed(4) });
    ctx.log(`shot ${id} at ${T.toFixed(3)} s (${beats} beats)`);
    return T;
  };
  const close = async beats => { await ctx.at(T + beats * BEAT + 0.05); T += beats * BEAT + 0.05; };
  const reset = async () => { await ctx.overlay.clear({ ms: 0 }); };
  /** the freshly loaded preset's first two macro knobs sweep up on the beat (visible motion on every flip) */
  const knobs = () => app(ms => { window.__aurora.store.animate({ macro1: 0.85, macro2: 0.7 }, { ms, ease: 'inOut' }); return true; }, ms(0.85));

  // ── H · the hook, fully formed on frame 0 over the live UI ──
  if (want('H')) {
    await tab('sources'); await source(0);
    await load(HOOK_PRESETS[0]);
    await ctx.camera.set({ s: 1, x: 0, y: 0 });
    await open('H', 4, 2.3);
    ctx.overlay.hook([{ ...TEXT.hook1, key: false, size: 150 }, { ...TEXT.hook2, key: true, size: ctx.lang === 'zh' ? 118 : 112 }],
      { backdrop: 'none', scrim: 'band', y: 150, stagger: 12, lineGap: 160, beam: false, push: false, delay: 0 });   // (a scaling text box with glow re-rasterises every frame: dropped frames)
    await ctx.at(T - 1.1);
    ctx.overlay.badge(TEXT.soundOn, { position: 'top-right', big: true });
    // the pillars peak ~0.12 s after a chord: this one peaks on the film's first frame (the poster)
    await ctx.at(T - 0.14);
    chord(ctx, E_SPREAD, 1, 520);
    await at(0);
    ctx.camera.to({ s: 1.035, x: -33.6, y: -18.9 }, ms(4), 'linear');
    for (let k = 1; k < 4; k++) {
      await at(k - 0.03);
      await load(HOOK_PRESETS[k]);
      await at(k + 0.02);
      chord(ctx, E_SPREAD, 0.95, 460);   // (no macro sweeps here: with the hook text on screen they cost dropped frames)
    }
    await close(4);
    await reset();
  }

  // ── D · the drop: slam into the hero, then pull back to the browser tab ──
  if (want('D')) {
    await load('Stellar Supersaw'); await tab('sources'); await source(0);
    await vx.bg(true); await vx.frame(true);
    const hero = await camAt(1000, 285, 1.34), punch = scaleAbout(hero, 1.14);
    const browser0 = { s: 0.82, x: 173, y: 119 }, browser1 = { s: 0.86, x: 134.4, y: 97.4 };
    // show the browser framing once off camera (its window frame + backdrop get rasterised before the pull-back)
    await ctx.camera.set(browser0); await ctx.wait(250);
    await ctx.camera.set(punch);
    await open('D', 8, 0.7);
    await ctx.at(T - 0.13);
    chord(ctx, AM_BIG, 1, 1700);
    await ctx.at(T - 0.4);
    ctx.overlay.caption(TEXT.sub, { position: 'bottom', style: 'statement', ms: ms(3.4), stagger: 9 });
    await ctx.at(T - 0.03);
    ctx.overlay.flash(0.45, 280, { color: 'white' });
    ctx.camera.to(hero, 420, 'outExpo');
    await at(2 - 0.1);
    chord(ctx, AM_BIG.slice(6), 0.9, 900);
    await at(3.62);
    ctx.overlay.clearCaptions({ ms: 160 });
    // (spread out: the pull-back re-rasters the browser frame — nothing else heavy on the same frame)
    await at(4 - 0.2);
    chord(ctx, [45, 57, 60, 64, 69, 72, 76], 0.9, 1500);
    await at(4 - 0.02);
    ctx.camera.to(browser0, 620, 'cubic-bezier(.3,.0,.2,1)');
    await at(4.45);
    ctx.overlay.caption(TEXT.browser, { position: 'bottom', ms: ms(3.2), stagger: 30 });
    await at(5.1);
    ctx.camera.to(browser1, ms(2.9), 'linear');
    await close(8);
    await vx.frame(false); await vx.bg(false);
    await reset();
  }

  // ── P · 8 presets, one per beat, on the hero ──
  if (want('P')) {
    await load(FLIP_PRESETS[0]); await tab('sources'); await source(0);
    const p0 = await camAt(860, 300, 1.52), p1 = await camAt(860, 300, 1.6);
    await ctx.camera.set(p0);
    await open('P', 8);
    ctx.camera.to(p1, ms(8), 'linear');
    await ctx.at(T - 0.3);
    ctx.overlay.caption(TEXT.presets, { position: 'bottom', kicker: TEXT.presetsKick, ms: ms(7.2), stagger: 30 });
    await ctx.at(T - 0.1);
    chord(ctx, AM, 0.95, 430);
    for (let k = 1; k < 8; k++) {
      await at(k - 0.03);
      await load(FLIP_PRESETS[k]);
      await at(k + 0.02);
      chord(ctx, AM, 0.95, 430);
      knobs();
    }
    await close(8);
    await reset();
  }

  // ── E1–E4 · four engines, one bar each (the edit tiles them 2×2 on film beats 216–220) ──
  // quadrant titles: top row (E1, E2) top-left, bottom row (E3, E4) bottom-left — the grid's centre stays free for
  // the caption still the edit lays over it
  const engine = async (id, setup, tag, run) => {
    if (!want(id)) return;
    const st = await setup();
    await preCut(st);
    await open(id, 4);
    ctx.overlay.tag(tag, { x: 70, y: id === 'E3' || id === 'E4' ? 1080 - 64 - 124 : 64, size: 104 });
    await at(0);
    settle(st);
    await run();
    await close(4);
    await reset();
  };
  await engine('E1', async () => {        // wavetable: the frame stack scans as Shape moves
    await load('Singularity'); await tab('sources'); await source(0);
    await ctx.aurora.setParam('osc1.shape', 0.2);
    return camAt(770, 722, 1.95);
  }, TEXT.wavetable, async () => {
    chord(ctx, [45, 52, 57, 64], 1, 2200);
    glide({ 'osc1.shape': 0.98 }, ms(4.6));      // ends after the window (a glide's end commits the patch: 1–2 held frames)
  });
  await engine('E2', async () => {        // FM: 4 operators, the algorithm changes every beat
    await load('Platinum Ballad'); await tab('sources'); await source(2);
    await ctx.aurora.setParam('fm.algo', 1);
    return camAt(1050, 730, 1.85);
  }, TEXT.fm, async () => {
    for (const [k, a] of [[0, 1], [1, 3], [2, 5], [3, 8]]) {
      await at(k);
      if (k) await ctx.aurora.setParam('fm.algo', a);
      chord(ctx, [52, 59, 64, 68, 71], 1, 520);
    }
  });
  await engine('E3', async () => {        // physical models: string → bar → bell → glass, each struck
    await load('Celestial Carillon'); await tab('sources'); await source(3);
    await ctx.aurora.setParam('phys.model', 'string');
    return camAt(1048, 730, 1.85);
  }, TEXT.physical, async () => {
    for (const [k, m, n] of [[0, 'string', 72], [1, 'bar', 76], [2, 'bell', 79], [3, 'glass', 84]]) {
      await at(k);
      if (k) await ctx.aurora.setParam('phys.model', m);
      chord(ctx, [n, n - 12], 1, 400);
    }
  });
  await engine('E4', async () => {        // ladder filter: the resonant peak sweeps open
    await load('Acid Serpent'); await tab('filter');
    await ctx.aurora.setParam('filter.cutoff', 180);
    await app(() => { const m = document.querySelector('main'); const p = document.querySelector('#panel-filter') || document.querySelector('.pane--filter'); const r = p.getBoundingClientRect(); m.scrollTop += r.top - 250; return m.scrollTop; });
    return camAt(880, 540, 1.6);
  }, TEXT.ladder, async () => {
    await ctx.aurora.noteOn(33, 1);
    glide({ 'filter.cutoff': 3600, 'filter.res': 0.86 }, ms(4.6));
  });
  if (want('E4')) { await ctx.aurora.noteOff(33); await scrollMain(0); }

  // ── T · a sound tour: the cutoff knob turns itself (Acid Bass, step 8/12 "slowly open the cutoff") ──
  if (want('T')) {
    await ctx.camera.set({ s: 1, x: 0, y: 0 });
    await ctx.aurora.startTour('acid-bass');
    await ctx.wait(300);
    for (let i = 0; i < 7; i++) { await app(() => { window.__aurora.center.tours.skip(); return true; }); await ctx.wait(60); }
    // step 8/12 has just started: its 8-beat cutoff ramp (360 Hz → 1.5 kHz, 3.9 s) runs under the whole window.
    // The tour smooth-scrolls the editor to the ringed knob: measure it once the scroll has settled.
    await ctx.wait(650);
    const st = await ctx.evalApp(() => window.__aurora.center.tours.status().step);
    const k = await app(() => { const e = document.querySelector('.is-tour-focus'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: e.dataset.param }; });
    ctx.log('tour step', st, JSON.stringify(k));
    if (!k) throw new Error('tour: no focused control');
    // the knob on the right third, the curve's resonant peak on the left
    const t0 = await camAt(k.x - 300, k.y + 30, 2.1), t1 = await camAt(k.x - 300, k.y + 30, 2.24);
    await ctx.camera.set(t0);
    await open('T', 4, 0.3);
    ctx.overlay.caption(TEXT.knobs, { position: 'top', kicker: TEXT.tours, ms: ms(3.3), stagger: 30 });
    ctx.camera.to(t1, ms(4), 'linear');
    await close(4);
    await app(() => { window.__aurora.center.tours.stop({ revert: true, silent: true }); return true; });
    await reset();
    await scrollMain(0);
  }

  // ── M · one tap: "Ethereal" (the button, the change log) ──
  if (want('M')) {
    // warm the mood path once off camera (first use stalls rendering ~0.3 s), then a fresh Sunset Poly clears the log
    await load('Moonlit Suitcase');
    await ctx.aurora.openDemoCenter('magic');
    await ctx.wait(500);
    await app(() => { document.querySelector('.mt-mood[data-mood="ethereal"]').click(); return true; });
    await ctx.wait(900);
    await load('Sunset Poly');
    await ctx.wait(500);
    // frame the 4×4 mood grid + the change log that appears under it (measured: the Demo Center scales with the window)
    const g = await app(() => {
      const r = [...document.querySelectorAll('.mt-mood')].map(e => e.getBoundingClientRect()).filter(r => r.width);
      const x0 = Math.min(...r.map(q => q.left)), x1 = Math.max(...r.map(q => q.right)), y0 = Math.min(...r.map(q => q.top)), y1 = Math.max(...r.map(q => q.bottom));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });
    ctx.log('mood grid', JSON.stringify(g));
    // + the log below the grid (≈ 0.75 grid heights) and room above it for the caption (it must not cover a row)
    await ctx.camera.set(await ctx.camera.frameFor([g.x - g.w * 0.12, g.y - g.h * 0.42, g.w * 1.5, g.h * 2.2], null, { margin: 0.02 }));
    const r = await ctx.evalDirector(() => director.selectorRect('.mt-mood[data-mood="ethereal"]'));
    await ctx.overlay.cursor.show({ x: r.cx + 300, y: r.cy + 260, ms: 0 });
    const m0 = await ctx.camera.get();
    await open('M', 4);
    ctx.overlay.caption(TEXT.mood, { position: 'top', kicker: TEXT.moodKick, ms: ms(3.4), stagger: 30 });
    await at(0);
    ctx.camera.to(scaleAbout(m0, 1.06), ms(4), 'linear');
    await at(0.35);
    ctx.clickSelector('.mt-mood[data-mood="ethereal"]', { moveMs: 380 });
    await at(1.3);
    chord(ctx, [57, 60, 64, 67, 71], 0.9, 1500);
    await close(4);
    await ctx.overlay.cursor.hide({ ms: 0 });
    await ctx.aurora.closeDemoCenter();
    await parkPointer(ctx);
    await reset();
  }

  // ── Q · "Claude has never heard it." / "But you can." (the breakdown bar: the UI waits, silent) ──
  if (want('Q')) {
    await load('Aurora Pad'); await tab('sources'); await source(0);
    await ctx.camera.set({ s: 1, x: 0, y: 0 });
    await open('Q', 4, 1.6);
    // line 1 is fully formed on the shot's first frame; line 2 lands on the bar's third beat
    const lead = 1.25;
    await ctx.at(T - lead);
    ctx.overlay.hook([{ ...TEXT.never, key: false, size: 132 }, { ...TEXT.youCan, key: true, size: 132 }],
      { backdrop: 'none', scrim: 'band', y: 150, stagger: 14, lineGap: Math.round((lead + 2 * BEAT - 0.3) * 1000), beam: false, push: false });
    await at(0);
    ctx.camera.to({ s: 1.04, x: -38.4, y: -21.6 }, ms(4), 'linear');
    await close(4);
    await reset();
  }

  // ── Z · the full band returns: explosion + wordmark end card ──
  if (want('Z')) {
    await load('Stellar Supersaw'); await tab('sources'); await source(0);
    const hero = await camAt(1000, 300, 1.22), punch = scaleAbout(hero, 1.14);
    await ctx.camera.set(punch);
    await open('Z', 4, 0.7);
    await ctx.at(T - 0.13);
    chord(ctx, AM_BIG, 1, 2000);
    await ctx.at(T - 0.03);
    ctx.overlay.flash(0.42, 280, { color: 'white' });
    ctx.camera.to(hero, 420, 'outExpo');
    ctx.overlay.title({ style: 'slam', size: 190, built: TEXT.built, note: TEXT.model, noteSize: 40, builtDelay: 260, scrim: 'band' });
    await at(1.2);
    ctx.overlay.badge(TEXT.soundOn, { position: 'top-right', big: true });
    await at(2 - 0.1);
    chord(ctx, AM_BIG.slice(6), 0.85, 1200);
    await at(2.2);
    ctx.camera.to(scaleAbout(hero, 1.03), ms(1.8), 'linear');
    await close(4);
    await reset();
  }
}
