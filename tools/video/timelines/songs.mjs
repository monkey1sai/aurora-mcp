// Take C — S: the song player playing Neon Nights at the same beats as the film's soundtrack (real sync: the playhead,
// the lane meters and the notes crossing it are the music the viewer is hearing).
//   S  song beats 228–232  the Songs sheet: 6 cover cards + the 6-lane player          "6 songs, composed by Claude"
// (the next shot, "You're hearing one right now.", is the song's spectrogram with a NOW PLAYING playhead: proof.mjs)
// prepare() starts the song from its top and waits (off camera) until it is near beat 228.
//
//   node tools/video/record.mjs --timeline tools/video/timelines/songs.mjs --out renders/video/takes/songs-en.mp4 --lang en
//   quick test: --set b0=40
import { BEAT, TEXT, songSync, waitSongBeat } from './lib.mjs';

export const meta = { title: 'X film · take C · songs', tail: 0.2, cursor: 'none', preload: Object.values(TEXT).flatMap(t => [t.en, t.zh]) };

const b0Of = ctx => +(ctx.args.b0 ?? 228);

export async function prepare(ctx) {
  const b0 = b0Of(ctx);
  await ctx.aurora.loadPresetByName('Stellar Supersaw');
  await ctx.aurora.playSong('neon-nights');
  await ctx.wait(600);
  const st = await ctx.evalApp(() => { const s = window.__aurora.audio.getSongState(); return s && { id: s.id, playing: s.playing, beat: s.beat }; });
  if (!st || !st.playing || st.id !== 'neon-nights') throw new Error(`song not playing: ${JSON.stringify(st)}`);
  await waitSongBeat(ctx, b0 - 8);
}

export default async function songs(ctx) {
  const b0 = b0Of(ctx);
  const S = await songSync(ctx);
  const at = S.at;
  const ms = beats => Math.round(beats * BEAT * 1000);
  const wide0 = await ctx.camera.frameFor([960, 470, 0, 0], 1.0);
  const wide1 = await ctx.camera.frameFor([960, 470, 0, 0], 1.1);
  await ctx.camera.set(wide0);
  ctx.mark('sync', { c0: S.c0, spreadMs: S.spreadMs, b0, sb0: S.sOf(b0) });

  await at(b0 - 0.6);
  ctx.overlay.caption(TEXT.songs, { position: 'bottom', ms: ms(3.8), stagger: 30 });
  await at(b0);
  ctx.mark('S', { beat: b0 });
  ctx.camera.to(wide1, ms(4), 'linear');
  await at(b0 + 4.4);
  ctx.mark('end', { beat: b0 + 4 });
}
