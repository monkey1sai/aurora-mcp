// Opening on the splash screen (~6 s): the take starts BEFORE the audio engine exists; a click on
// "Tap to start" boots it (the audio tap installs itself the moment the engine appears), then a chord.
//   node tools/video/record.mjs --timeline tools/video/capture/timelines/splash.mjs --out renders/video/splash.mp4 --no-autostart

export const meta = { title: 'splash opening', overlay: 'none', cursor: 'builtin', tail: 0.4 };

export default async function splash(ctx) {
  await ctx.wait(900);
  await ctx.clickSelector('.splash__start', { moveMs: 600 });
  await ctx.wait(1500);                     // splash fade + engine warm-up
  await ctx.showCursor(false);
  await ctx.focusApp();
  await ctx.holdKeys(['KeyA', 'KeyD', 'KeyG', 'KeyK'], 1600);
  await ctx.wait(1200);
}
