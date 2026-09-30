// Take A of the FIRST cut (not used by the current edit — kept as a working recipe for filming theater mode in sync
// with a song). Theater mode on Neon Nights, in sync with the film's soundtrack (the same song, same beats):
//   S01–S03 (song beats 184–196: hook → "It built a synth anyway." → the drop + wordmark)
//   S13–S14 (song beats 252–264: "Claude has never heard it." → "Your turn. Sound on." → end card)
// The song plays in the app from its top; prepare() waits (off camera) until it is near beat 184.
// Light pillars only rise for notes on the user's synth, so chords on Stellar Supersaw ride along with the song
// (visual only — the film's soundtrack is the offline render of the same song).
//
//   node tools/video/record.mjs --timeline tools/video/timelines/theater.mjs --out renders/video/takes/theater-en.mp4 --lang en
//   quick test on the intro: --set b0=16 --set b13=40
import { BEAT, TEXT, tx, chord, appCss, songSync, waitSongBeat } from './lib.mjs';

export const meta = { title: 'X film · take A · theater', tail: 0.2, cursor: 'none', preload: Object.values(TEXT).flatMap(t => [t.en, t.zh]) };

const CLEAN = `.th__top, .th__caption, .th__bottom, .th__changing, .th__parts, .th__macros, .th__prog, .th__pause, .th__hint, #toasts
  { opacity: 0 !important; transition: none !important; visibility: hidden !important; }`;

const args = ctx => ({ b0: +(ctx.args.b0 ?? 184), b13: +(ctx.args.b13 ?? 252) });

export async function prepare(ctx) {
  const { b0 } = args(ctx);
  await ctx.aurora.loadPresetByName('Stellar Supersaw');
  await appCss(ctx, 'vx-clean', CLEAN);
  const ok = await ctx.evalApp(async () => {
    const A = window.__aurora, c = A.center;
    if (c.ready && c.ready.then) await c.ready;
    c.open('theater');
    await new Promise(r => setTimeout(r, 400));
    const chip = [...document.querySelectorAll('.th-l__chips button')].find(b => /All songs|示範曲連播/.test(b.textContent));
    if (!chip) return 'no songs chip';
    chip.click();
    c.close();
    await new Promise(r => setTimeout(r, 500));
    const song = A.songs.find(s => s.id === 'neon-nights');
    c.theater.enter({ startAt: song });
    await new Promise(r => setTimeout(r, 800));
    const st = c.theater.status();
    return st.open && /Neon/.test(st.item || '') ? 'ok' : JSON.stringify(st);
  });
  if (ok !== 'ok') throw new Error(`theater did not start on Neon Nights: ${ok}`);
  ctx.log('theater on Neon Nights — waiting for the song');
  // the recorder needs ~3.2 s (5.5 beats) of pre-roll after prepare(); the timeline itself starts ~4 beats early
  await waitSongBeat(ctx, b0 - 12.5);
}

export default async function theater(ctx) {
  const { b0, b13 } = args(ctx);
  const S = await songSync(ctx);
  const at = S.at;
  const ms = beats => Math.round(beats * BEAT * 1000);
  // camera: zoom about a fixed point of the frame (the aurora's heart)
  const zoom = (s, dur = 0, ease = 'linear') => ctx.camera.zoomTo([960, 520, 0, 0], s, dur, ease, { anchorX: 0.5, anchorY: 520 / 1080 });
  ctx.mark('sync', { c0: S.c0, spreadMs: S.spreadMs, b0, b13, sb0: S.sOf(b0), sb13: S.sOf(b13) });

  // ── S01 hook: text fully formed on the film's first frame (beat b0), pillars at their peak ──
  await at(b0 - 2.8);
  ctx.overlay.hook([
    { ...TEXT.hook1, key: false, size: 172 },
    { en: 'It built a synth anyway.', zh: '但它還是做出了一台合成器', key: true, size: ctx.lang === 'zh' ? 110 : 118 },
  ], { backdrop: 'none', lineGap: ms(6.35), stagger: 22, beam: true });
  // the pillars peak ~0.1 s after a chord: this one lands just before the film's first frame (= the poster)
  await at(b0 - 0.15);
  chord(ctx, [38, 45, 50, 53, 57, 62, 65, 69, 74, 77], 1, 1150);      // Dm (the song is on Dm)
  await at(b0);
  ctx.mark('S01', { beat: b0 });
  zoom(1.03, ms(4), 'linear');
  await at(b0 + 2);
  chord(ctx, [50, 57, 62, 65, 69, 74], 0.8, 1000);
  // ── S02: the turn (line 2 lands on the downbeat), sound-on pill before the drop ──
  // visuals fire ~2 frames ahead of the beat (CDP → rAF → compositor), pillar chords ~1.5 frames more (they bloom)
  await at(b0 + 4 - 0.12);
  chord(ctx, [40, 47, 52, 56, 59, 64, 68, 71], 0.85, 1500);           // E
  await at(b0 + 4);
  ctx.mark('S02', { beat: b0 + 4 });
  zoom(1.12, ms(3.85), 'cubic-bezier(.45,0,.75,.6)');
  await at(b0 + 4.6);
  ctx.overlay.badge(TEXT.soundOn, { position: 'top-right', big: true, ms: ms(1.45) });
  await at(b0 + 7.05);
  ctx.overlay.clearHook({ ms: 300, reveal: 'none' });
  // ── S03 the drop: pillars explode, wordmark slams in ──
  await at(b0 + 8 - 0.14);
  chord(ctx, [33, 40, 45, 52, 57, 60, 64, 69, 72, 76, 81, 84], 1, 2500);   // Am over the song's Fmaj7
  await at(b0 + 8 - 0.065);
  zoom(1.07, 0);
  ctx.overlay.flash(0.3, 260, { color: 'white' });
  ctx.overlay.title({ style: 'slam', size: 200, sub: TEXT.sub, subSize: 60, subDelay: ms(2) - 60 });
  zoom(1.0, ms(4), 'cubic-bezier(.2,.6,.3,1)');
  ctx.mark('S03', { beat: b0 + 8 });
  await at(b0 + 10);
  chord(ctx, [64, 69, 72, 76, 81, 84], 1, 1400);
  await at(b0 + 12.3);
  ctx.mark('S03-end', { beat: b0 + 12 });
  ctx.overlay.clearTitle({ ms: 300 });

  // ── idle (not in the film) until S13 ──
  await at(b13 - 2);
  zoom(1.08, 0);
  // ── S13 "Claude has never heard it." ──
  await at(b13 - 0.9);
  ctx.overlay.hook([{ ...TEXT.never, key: false, size: 132 }], { backdrop: 'none', stagger: 22, beam: false });
  await at(b13);
  ctx.mark('S13', { beat: b13 });
  zoom(1.0, ms(8), 'cubic-bezier(.3,.1,.4,1)');
  await at(b13 + 3.15);
  ctx.overlay.clearHook({ ms: 220, reveal: 'none' });
  // ── S14a "Your turn. Sound on." + a last bloom ──
  await at(b13 + 3.78);
  ctx.overlay.hook([{ ...TEXT.youCan, key: false, size: 140 }, { en: 'Sound *on*.', zh: '打開*聲音*', key: true, size: 140 }], { backdrop: 'none', stagger: 26, lineGap: ms(0.9), beam: true });
  await at(b13 + 4 - 0.12);
  chord(ctx, [45, 52, 57, 60, 64, 69, 72, 76], 0.75, 2200);
  await at(b13 + 4);
  ctx.mark('S14', { beat: b13 + 4 });
  await at(b13 + 7.2);
  ctx.overlay.clearHook({ ms: 250, reveal: 'none' });
  // ── S14b end card: wordmark + Built with Claude Code, then text out → aurora only (loops into the hook) ──
  await at(b13 + 7.72);
  ctx.overlay.title({ style: 'rise', size: 190, built: TEXT.built, note: TEXT.model, noteSize: 40, builtDelay: 420 });
  await at(b13 + 10.9);
  ctx.overlay.clearTitle({ ms: 420 });
  await at(b13 + 12.5);
  ctx.mark('end', { beat: b13 + 12 });
}
