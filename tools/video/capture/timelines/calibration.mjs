// 12-second capture calibration clip (tools/video/capture/measure.mjs checks it).
// QWERTY notes and chords; a white square (top-right) flashes in the SAME task as every note trigger;
// two preset loads; a camera zoom into the macro knobs with a knob drag; camera reset.
//   node tools/video/record.mjs --timeline tools/video/capture/timelines/calibration.mjs --out renders/video/calibration.mp4 --keep

export const meta = { title: 'capture calibration', overlay: 'none', cursor: 'builtin', tail: 0.4 };

export default async function calibration(ctx) {
  await ctx.focusApp();
  await ctx.evalDirector(() => director.noteFlash(true, 90));
  await ctx.aurora.loadPresetByName('Dewdrop Kalimba');   // preset 1: plucked, sharp attacks
  await ctx.mark('kalimba');

  // single notes, then a chord
  const notes = [[0.45, 'KeyA'], [0.95, 'KeyD'], [1.45, 'KeyG'], [1.95, 'KeyK']];
  for (const [t, k] of notes) { await ctx.at(t); await ctx.holdKeys([k], 260); }
  await ctx.at(2.5);
  await ctx.holdKeys(['KeyA', 'KeyD', 'KeyG'], 650);

  // preset 2
  await ctx.at(3.5);
  await ctx.aurora.loadPresetByName('Ivory Hall Grand');
  await ctx.mark('piano');
  const run = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'];
  for (let i = 0; i < run.length; i++) { await ctx.at(3.9 + i * 0.22); await ctx.holdKeys([run[i]], 150); }

  // camera: zoom into the macro knobs, turn M1 by dragging, play under the zoom
  await ctx.at(6.0);
  await ctx.mark('zoom');
  await ctx.camera.zoomTo('.play__macros', null, 900, 'inOutCubic', { margin: 0.06 });
  const knob = '.play__macros .macro:nth-child(1) [role="slider"]';
  await ctx.drag(knob, { dy: -140 }, { ms: 900, moveMs: 350 });
  for (const [t, k] of [[8.2, 'KeyG'], [8.55, 'KeyJ'], [8.9, 'KeyK']]) { await ctx.at(t); await ctx.holdKeys([k], 200); }
  await ctx.at(9.3);
  await ctx.holdKeys(['KeyA', 'KeyG', 'KeyJ'], 700);
  await ctx.at(10.2);
  await ctx.camera.reset(900, 'inOutCubic');
  await ctx.at(11.2);
  await ctx.holdKeys(['KeyD'], 300);
  await ctx.at(11.7);
}
