// Take D — the proof, two windows on the take's own clock (the beat grid is the film's; nothing waits on the song):
//   L    song beats 200–208  a REAL excerpt of the build log: a sound designer agent renders Bowed Moonglass, reads the
//                            spectrogram it rendered, sees noise (→ "So it tuned every sound by looking at it."),
//                            builds a repro of the voice-steal bug, works around it and reads the clean result
//                            (→ "Saw the noise. Found the bug. Fixed it.")                 tools/video/make-buildlog.mjs
//   NAX  song beats 232–252  the spectrogram of Neon Nights with a live NOW PLAYING playhead (232–236, "You're hearing
//                            one right now."), the 47-agent swarm (236–244, the count completes at ≈2 s and holds),
//                            the numbers (244–252: 46,742 lines · 0 dependencies · 0 audio samples · 308 tests)
//
//   node tools/video/record.mjs --timeline tools/video/timelines/proof.mjs --out renders/video/takes/proof-en.mp4 --lang en
//   --set only=L|NAX   records one window (quick tests)
import { BEAT, TEXT, installStage } from './lib.mjs';

export const meta = { title: 'X film · take D · proof', tail: 0.3, cursor: 'none', preload: Object.values(TEXT).flatMap(t => [t.en, t.zh]).concat(['REAL LOG EXCERPT 真實紀錄節錄 noise 雜訊 clean 乾淨了 ✓ ⏺ ⎿ 音色設計代理人 · 鋪底 sound designer agent · pads']) };

const SONG_T = b => (b * 60) / 104;     // song seconds at song beat b

export async function prepare(ctx) {
  await installStage(ctx);
  const spec = await ctx.director.vx.spec.load();
  const log = await ctx.director.vx.log.load();
  ctx.log('assets', JSON.stringify({ spec, log }));
  await ctx.aurora.loadPresetByName('Stellar Supersaw');
}

export default async function proof(ctx) {
  const only = ctx.args.only ? new Set(String(ctx.args.only).split(',')) : null;
  const want = id => !only || only.has(id);
  const vx = ctx.director.vx;
  const ms = beats => Math.round(beats * BEAT * 1000);
  let T = 1.0;
  const dly = async s => Math.round((s - (await ctx.now())) * 1000);

  // ── L · the build log (8 beats) ──
  if (want('L')) {
    const at = b => ctx.at(T + (b - 200) * BEAT);
    await ctx.mark('shot', { id: 'L', start: T, dur: +(8 * BEAT).toFixed(4) });
    await ctx.at(T - 0.7);
    // the first rows type in just before the cut (the shot opens on text, not an empty window)
    vx.log.show({ delay: (await dly(T)) - 420, beat2: ms(4) + 420, lang: ctx.lang });
    await ctx.at(T - 0.32);
    ctx.overlay.caption(TEXT.looking, { position: 'bottom', ms: ms(3.35), stagger: 30 });
    await at(203.55);
    ctx.overlay.clearCaptions({ ms: 180 });
    await at(203.72);
    ctx.overlay.caption(TEXT.fixed, { position: 'bottom', ms: ms(4.1), stagger: 30 });
    await at(208.15);
    await ctx.overlay.clearCaptions({ ms: 0 });
    vx.log.hide();
    T = T + 8 * BEAT + 1.2;
  }

  // ── N A X · spectrogram (4 beats) → swarm (8) → numbers (8) ──
  if (want('NAX')) {
    const at = b => ctx.at(T + (b - 232) * BEAT);
    await ctx.mark('shot', { id: 'NAX', start: T, dur: +(20 * BEAT).toFixed(4) });
    await ctx.at(T - 0.9);
    vx.spec.show({ t0: SONG_T(232), t1: SONG_T(236), ms: ms(4), s0: 1.0, s1: 1.22, anchorX: 0.6, tag: ctx.lang === 'zh' ? '▶ 正在播放' : '▶ NOW PLAYING', delay: await dly(T) });
    await ctx.at(T - 0.32);
    ctx.overlay.caption(TEXT.hearing, { position: 'bottom', kicker: TEXT.hearingKick, ms: ms(3.3), stagger: 34 });
    // hard cut on beat 236: the sky goes up at full opacity in one call (it covers the spectrogram, which is hidden
    // right after — never a frame of the app in between), the swarm fades in on top and its first ring launches
    // ≈ 0.4 s later (its clock starts after the 0.536 × 420 ms fade)
    await at(236 - 0.3);
    ctx.overlay.clearCaptions({ ms: 140 });
    await at(236 - 0.005);
    await ctx.overlay.backdrop.now({ amp: 0.6, lift: 0.22, owner: 'swarm', restart: true });
    ctx.overlay.swarm({ ms: 3000, phaseGap: 600, stay: true, calls: 'current', backdrop: false, countLabel: TEXT.agentsLabel });
    vx.spec.hide();
    // ── the numbers: the swarm hands the sky to the stats (no fade restart: backdrop.now keeps it on) ──
    await at(244 - 0.12);
    await ctx.overlay.backdrop.now({ owner: 'stats' });
    ctx.overlay.clearSwarm({ ms: 220 });
    ctx.overlay.stats([
      { value: 46742, label: TEXT.lines },
      { value: 0, label: TEXT.deps },
      { value: 0, label: TEXT.samples },
      { value: 308, label: TEXT.tests },
    ], { ms: 950, stagger: ms(0.5), size: 150, cols: 2, dim: true, title: TEXT.statsTitle });
    // a slow push on the grid while the numbers hold (composited: no layout)
    await ctx.evalDirector(ms => { const el = document.querySelector('.ovl-stats'); if (el) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }], { duration: ms, delay: 200, easing: 'linear', fill: 'both' }); return !!el; }, ms(8));
    await at(252.2);
  }
  ctx.mark('end');
}
