// Interaction smoke test (~12 s): overlay cursor clicks (Demo Center button, Magic tab, a mood chip), typing into the
// natural-language box, a knob drag and wheel. Verifies the trusted-input paths through the camera and the iframe.
//   node tools/video/record.mjs --timeline tools/video/capture/timelines/interact.mjs --out renders/video/interact.mp4

export const meta = { title: 'capture interaction smoke test', tail: 0.4 };

export default async function interact(ctx) {
  await ctx.focusApp();
  await ctx.aurora.loadPresetByName('Aurora Pad');
  await ctx.showCursor(true);
  await ctx.holdKeys(['KeyA', 'KeyG'], 900);
  await ctx.clickSelector('.dc-btn', { moveMs: 700 });                              // Demo Center
  await ctx.wait(700);
  await ctx.clickSelector('#dc-tab-magic', { moveMs: 500 });                          // Magic tab
  await ctx.wait(600);
  await ctx.clickSelector('.mt-ask__input', { moveMs: 500 });
  await ctx.type(ctx.lang === 'zh' ? '更溫暖' : 'warmer and dreamy', { charMs: 55 });
  await ctx.key('Enter');
  await ctx.mark('typed');
  await ctx.holdKeys(['KeyA', 'KeyD', 'KeyG'], 900);
  await ctx.clickSelector('.mt-mood[data-mood]:nth-child(3)', { moveMs: 500 });
  await ctx.holdKeys(['KeyS', 'KeyG'], 700);
  await ctx.aurora.closeDemoCenter();
  await ctx.wait(500);
  await ctx.drag('.play__macros .macro:nth-child(3) [role="slider"]', { dy: -120 }, { ms: 900 });
  await ctx.wheel('.play__macros .macro:nth-child(4) [role="slider"]', -400);
  await ctx.holdKeys(['KeyD', 'KeyH'], 800);
  await ctx.showCursor(false);
}
