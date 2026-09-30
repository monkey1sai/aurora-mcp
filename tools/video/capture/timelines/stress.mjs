// Capture stress test (~20 s): the overlay's WebGL hook + a full demo song in the Demo Center + camera moves +
// overlay captions/badges/cursor while the song plays. Checks frame rate and sync under the heaviest load.
//   node tools/video/record.mjs --timeline tools/video/capture/timelines/stress.mjs --out renders/video/stress.mp4

export const meta = { title: 'capture stress test', tail: 0.4 };

export default async function stress(ctx) {
  await ctx.focusApp();
  await ctx.evalDirector(() => director.noteFlash(true, 90));
  const T = { en: s => s.en, zh: s => s.zh }[ctx.lang];
  // hook over the app (overlay WebGL sky) while a pad chord rings
  ctx.overlay.hook([{ en: "Claude can't hear.", zh: 'Claude 聽不見。' }, { en: 'It built this anyway.', zh: '但它做出了這個。', key: true }]);
  await ctx.at(0.3);
  await ctx.holdKeys(['KeyA', 'KeyG', 'KeyJ'], 1600);
  await ctx.at(3.2);
  await ctx.overlay.clearHook();
  // a song in the Demo Center (heaviest UI: lanes, meters, cover art) + camera push
  await ctx.aurora.playSong('neon-nights');
  await ctx.mark('song');
  await ctx.at(5.0);
  ctx.overlay.caption({ en: '6 songs written by Claude agents', zh: '6 首由 Claude agent 作曲的歌' });
  await ctx.camera.zoomTo('.sv-player', 1.35, 1400, 'inOutCubic');
  await ctx.at(8.5);
  ctx.overlay.badge({ en: 'Every sound synthesized live', zh: '每個聲音都即時合成' });
  await ctx.camera.reset(1200);
  await ctx.at(10.5);
  await ctx.aurora.closeDemoCenter();
  await ctx.overlay.clearCaptions();
  // play on top of the song while the knobs turn themselves
  await ctx.camera.zoomTo('.play__macros', null, 900, 'outCubic', { margin: 0.1 });
  const knob = '.play__macros .macro:nth-child(2) [role="slider"]';
  await ctx.drag(knob, { dy: -160 }, { ms: 1200, moveMs: 450 });
  for (const [t, k] of [[13.4, 'KeyG'], [13.7, 'KeyJ'], [14.0, 'KeyK'], [14.3, 'KeyL']]) { await ctx.at(t); await ctx.holdKeys([k], 180); }
  await ctx.at(15.0);
  await ctx.camera.reset(900);
  await ctx.at(16.2);
  await ctx.aurora.stopAll();
  await ctx.overlay.flash(0.35, 420);
  await ctx.at(17.5);
  void T;
}
