#!/usr/bin/env node
// The X film's soundtrack: Neon Nights (A minor, 104 BPM, composed by a Claude agent), rendered offline by the app's
// own engine (tools/render-song.mjs → src/dsp/ensemble.js + SafetyBus), song beats 188 → 260, with two
// arrangement mutes so the music has real dynamics (the film is cut on this bed):
//
//   beats 180–192  kick, hats, bass and the sync lead muted → the film opens on the brass swell + the song's own
//                  snare-roll build (K-weighted ≈ −19.5 LUFS momentary); the drop at beat 192 brings the whole band,
//                  the low end and the lead's chorus hook in at once (≈ −13.4: +6 dB, +10 dB below 150 Hz)
//   beats 252–256  kick, hats, bass, snare and lead muted → one bar of brass alone under "Claude has never heard
//                  it."; the full band returns on the outro's downbeat (256) under the end card (+5 dB)
//
// Only note events are removed (macro/param rides stay), exactly like muting those lanes in the song player.
// Everything else is the song as written, rendered sample-for-sample by the same engine the browser runs.
//
//   node tools/video/make-bed.mjs                → renders/video/assets/bed-neon-b188-260.wav (+ .json report)
//   options: --b0 188 --b1 260 · --mute-pre Kick,Hats,Bass,Lead · --mute-brk Kick,Hats,Bass,Snare,Lead ·
//            --no-mutes (the plain song) · --out <wav>
//
// Clock: the render's note onsets land a constant few ms after the nominal beat grid (measured here on the kick
// stem, over every kick of the climax: 17.8 ms). The bed is trimmed that much later, so film frame
// round((b − b0)·BEAT·fps) is where beat b is HEARD — cuts and on-beat visuals land on the audible attacks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const { renderSong, loadSongModules } = await imp('tools/render-song.mjs');
const { writeWav } = await imp('tools/wav.mjs');
const { loudness } = await imp('tools/analyze.mjs');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const B0 = +opt('--b0', 188), B1 = +opt('--b1', 260);
// the pre-drop keeps the brass swell + the song's own snare-roll build (a riser into the drop); the breakdown bar
// keeps the brass alone
const list = (k, d) => String(opt(k, d)).split(',').filter(Boolean);
const MUTES = argv.includes('--no-mutes') ? [] : [
  { from: 180, to: 192, parts: list('--mute-pre', 'Kick,Hats,Bass,Lead') },
  { from: 252, to: 256, parts: list('--mute-brk', 'Kick,Hats,Bass,Snare,Lead') },
];
const OUT = path.resolve(ROOT, opt('--out', `renders/video/assets/bed-neon-b${B0}-${B1}.wav`));
const SR = 48000, BPM = 104, BEAT = 60 / BPM;

const M = await loadSongModules();
const def = M.SONGS.find(s => s.id === 'neon-nights');
const arranged = {
  ...def,
  parts: def.parts.map(p => {
    const mutes = MUTES.filter(m => m.parts.includes(p.name));
    if (!mutes.length) return p;
    return { ...p, events: p.events.filter(e => e.type !== 'on' || !mutes.some(m => e.beat >= m.from && e.beat < m.to)) };
  }),
};
const removed = def.parts.map((p, i) => ({ part: p.name, notes: p.events.length - arranged.parts[i].events.length })).filter(x => x.notes);
console.log('muted notes:', removed.map(x => `${x.part} ${x.notes}`).join(', ') || 'none');

// render only as far as the film needs (+ 2 bars of context for tails)
const res = await renderSong(arranged, { sampleRate: SR, mods: M, maxBeats: Math.min(def.lengthBeats, B1 + 8), tail: 2, profile: false });
const { L, R } = res;

// ── onset latency: kick stem attacks vs the nominal grid (climax, four on the floor) ──
const kickIdx = res.song.parts.findIndex(p => p.name === 'Kick');
const kL = res.stems[kickIdx].L, kR = res.stems[kickIdx].R;
let kpk = 0; for (let i = 0; i < kL.length; i++) kpk = Math.max(kpk, Math.abs(kL[i]), Math.abs(kR[i]));
const thr = kpk * 10 ** (-24 / 20);
const lat = [];
for (let b = 192; b < Math.min(252, B1); b++) {
  const s = Math.round(b * BEAT * SR);
  for (let i = s - 480; i < s + 4800; i++) if (Math.abs(kL[i]) > thr || Math.abs(kR[i]) > thr) { lat.push(i - s); break; }
}
lat.sort((a, b) => a - b);
const LAT = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
console.log(`kick onsets vs grid: n=${lat.length} median ${(LAT / SR * 1000).toFixed(2)} ms (min ${(lat[0] / SR * 1000).toFixed(2)}, max ${(lat.at(-1) / SR * 1000).toFixed(2)})`);

// ── trim beats B0 → B1 (shifted by the onset latency), 8 ms fade-in / 60 ms fade-out (X loops the clip) ──
const s0 = Math.round(B0 * BEAT * SR) + LAT, n = Math.round((B1 - B0) * BEAT * SR);
const oL = new Float32Array(n), oR = new Float32Array(n);
const fi = Math.round(0.008 * SR), fo = Math.round(0.06 * SR);
for (let i = 0; i < n; i++) {
  let g = 1;
  if (i < fi) g = i / fi;
  if (i >= n - fo) g = Math.min(g, (n - 1 - i) / fo);
  oL[i] = (L[s0 + i] || 0) * g; oR[i] = (R[s0 + i] || 0) * g;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
writeWav(OUT, [oL, oR], SR, { bitDepth: 24 });

// ── per-beat RMS + section loudness (for the report; the dynamics are the point) ──
const rmsDb = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += 0.5 * (oL[i] * oL[i] + oR[i] * oR[i]); return 10 * Math.log10(s / Math.max(1, b - a) + 1e-20); };
const lowDb = (a, b) => { // one-pole 150 Hz low-pass energy
  const k = 1 - Math.exp(-2 * Math.PI * 150 / SR); let yL = 0, yR = 0, s = 0;
  for (let i = Math.max(0, a - 4800); i < b; i++) { yL += k * (oL[i] - yL); yR += k * (oR[i] - yR); if (i >= a) s += 0.5 * (yL * yL + yR * yR); }
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-20);
};
const beats = [];
for (let b = B0; b < B1; b++) {
  const a = Math.round((b - B0) * BEAT * SR), e = Math.round((b + 1 - B0) * BEAT * SR);
  beats.push({ beat: b, rmsDb: +rmsDb(a, e).toFixed(1), lowDb: +lowDb(a, e).toFixed(1) });
}
const lu = (b0, b1) => { const a = Math.round((b0 - B0) * BEAT * SR), e = Math.round((b1 - B0) * BEAT * SR); const l = loudness(oL.subarray(a, e), oR.subarray(a, e), SR); return +(+l.integrated).toFixed(1); };
const whole = loudness(oL, oR, SR);
const report = {
  file: path.relative(ROOT, OUT), song: 'neon-nights', beats: [B0, B1], seconds: +(n / SR).toFixed(4), sampleRate: SR,
  mutes: MUTES, mutedNotes: removed, onsetLatencyMs: +(LAT / SR * 1000).toFixed(2), startSample: s0,
  lufs: +(+whole.integrated).toFixed(2),
  sections: { preDrop: lu(B0, 192), drop: lu(192, 200), breakdown: lu(252, 256), finalHit: lu(256, B1) },
  perBeat: beats,
};
fs.writeFileSync(OUT.replace(/\.wav$/, '.json'), JSON.stringify(report, null, 1));
console.log(`bed → ${report.file}: ${report.seconds} s, ${report.lufs} LUFS; sections`, report.sections);
console.log('per-beat RMS dB (low <150 Hz):', beats.map(x => `${x.beat}:${x.rmsDb}(${x.lowDb})`).join(' '));
