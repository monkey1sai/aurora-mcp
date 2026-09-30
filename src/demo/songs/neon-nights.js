// 霓虹夜色 Neon Nights — synthwave, A minor, 104 BPM, 72 bars (≈ 2:46), one pass with a proper ending.
//
//   Intro 夜幕低垂 (8) → Verse 城市巡航 (16) → Chorus 霓虹天際線 (16) → Breakdown 雨夜玻璃 (8)
//   → Climax 全速奔馳 (16) → Outro 尾燈 (8)
//
// Hook: the verse motif E–D–E–A (bars 1/5 of the verse) and the chorus sequence A…G-A → B…A-B → climbing to E6.
// Auto-tweaking: every section rides macros — the whole band starts filtered and opens up over the intro (kick
// Muffle, brass Bright, distant roomy snare coming closer), the brass Blare/Stack swell through the choruses and
// close in the outro, the sync lead's Sync/Grit sweep up through the climax (plus fader rides: forward in the
// choruses, back in the breakdown), the bass filter darkens and rises again in the breakdown, the hats open up.
// The bass ducks under the kick (quieter, 1/48 late) like a sidechained synthwave bass.

import { chords, drums, melody, merge, repeat, shift, humanize, macroRamp, macro, param, ramp, parseChord, bars } from '../songlib.js';

const S = { intro: 0, verse: bars(8), chorus: bars(24), brk: bars(40), climax: bars(48), outro: bars(64), end: bars(72) };

// ───────────── harmony ─────────────
const P_INTRO = 'Am Fmaj7 C G Am Fmaj7 C G';
const P_VERSE = 'Am Fmaj7 C G Am Fmaj7 Dm E';
const P_CHORUS = 'Fmaj7 G Em Am Fmaj7 G E E';
const P_BRK = 'Am Fmaj7 C G Am Fmaj7 Dm E';
const P_OUTRO = 'Am Fmaj7 C G Am Fmaj7 E';   // + the final Am

// ───────────── helpers ─────────────
const at = (ev, beat) => shift(ev, beat);
/** Bass notes from a progression string, roots folded into F1…E2 (29…40) so the line stays in one register. */
function bassPat(spec, pattern, { start = 0, step = 0.5, vel = 0.8, accent = 0.95, gate = 0.8, lo = 29 } = {}) {
  const pat = [...pattern.replace(/[\s|]/g, '')];
  const ev = [];
  let beat = start;
  for (const tok of spec.split(/\s+/).filter(Boolean)) {
    const [sym, len] = tok.split(':');
    const beats = len ? Number(len) : 4;
    const c = parseChord(sym);
    let root = lo + ((((c.root - lo) % 12) + 12) % 12);
    const n = Math.round(beats / step);
    let last = null;
    for (let i = 0; i < n; i++) {
      const t = pat[i % pat.length];
      if (t === '-') { if (last) last.dur += step; continue; }
      last = null;
      if (t === '.') continue;
      const note = t === 'o' || t === 'O' ? root + 12 : t === 'f' ? root + 7 : root;
      const v = t === 'X' || t === 'O' ? accent : t === 'g' ? vel * 0.6 : vel;
      // 'g' = ducked note on a kick: quieter and a 1/48 late, like a sidechained synthwave bass
      const late = t === 'g' ? 1 / 12 : 0;
      last = { beat: beat + i * step + late, type: 'on', note, vel: v, dur: step * gate - late };
      ev.push(last);
    }
    beat += beats;
  }
  return ev;
}
/** Snare roll: 16ths over `beats`, velocity crescendo v0 → v1. */
function roll(start, beats, v0 = 0.35, v1 = 1, rate = 0.25, note = 38) {
  const n = Math.round(beats / rate), ev = [];
  for (let i = 0; i < n; i++) ev.push({ beat: start + i * rate, type: 'on', note, vel: v0 + (v1 - v0) * (i / Math.max(1, n - 1)), dur: 0.1 });
  return ev;
}
const lead = (str, start, opts = {}) => melody(str, { step: 0.5, start, vel: 0.78, accent: 0.95, soft: 0.55, gate: 0.94, ...opts });

// ───────────── drums ─────────────
const KICK_VERSE = 'x.......x.x.....';
const KICK_VERSE_B = 'x.......x.x...x.';
const KICK_FLOOR = 'X...x...X...x...'; // softer on 2 & 4 where the snare lands
const kick = merge(
  // intro: a muffled four-on-the-floor heartbeat; the Muffle macro opens it up over the 8 bars
  at(repeat(drums({ kick: KICK_FLOOR }, { vel: 0.5, accent: 0.6 }), 4, 4), S.intro),
  at(repeat(drums({ kick: KICK_FLOOR }, { vel: 0.68, accent: 0.78 }), 4, 4), S.intro + bars(4)),
  macroRamp(2, 0.85, 0.0, S.intro, bars(8)),
  ramp('amp.level', -3, 6, S.intro, bars(8)),   // … and fades in (preset level +6 dB)
  // verse: rock beat (1, 3, 3-and), push on the 4th bar of each phrase
  at(repeat(merge(drums({ kick: KICK_VERSE }, { vel: 0.95 }), at(drums({ kick: KICK_VERSE }, { vel: 0.95 }), 4), at(drums({ kick: KICK_VERSE }, { vel: 0.95 }), 8), at(drums({ kick: KICK_VERSE_B }, { vel: 0.95 }), 12)), 4, 16), S.verse),
  // chorus + climax: four on the floor
  at(repeat(drums({ kick: KICK_FLOOR }, { vel: 0.8 }), 16, 4), S.chorus),
  macroRamp(0, 0.1, 0.5, S.chorus, bars(16)),
  macro(0, 0.2, S.climax),
  at(repeat(drums({ kick: KICK_FLOOR }, { vel: 0.8 }), 16, 4), S.climax),
  macroRamp(0, 0.2, 0.45, S.climax, bars(16)),
  // outro: verse beat for 4 bars, floor for 2, then the final hit
  at(repeat(drums({ kick: KICK_VERSE }, { vel: 0.95 }), 4, 4), S.outro),
  at(repeat(drums({ kick: KICK_FLOOR }, { vel: 0.75, accent: 0.9 }), 3, 4), S.outro + bars(4)),
  [{ beat: S.outro + bars(7), type: 'on', note: 36, vel: 1, dur: 0.5 }],
  macro(0, 0.1, S.outro),
);

const SNARE_BACK = '....x.......x...';
const snare = merge(
  // intro: a distant, roomy backbeat that comes closer (velocity up, Space down)
  at(repeat(drums({ snare: SNARE_BACK }, { vel: 0.3 }), 4, 4), S.intro),
  at(repeat(drums({ snare: SNARE_BACK }, { vel: 0.45 }), 3, 4), S.intro + bars(4)),
  at(drums({ snare: '....x...' }, { vel: 0.5 }), S.intro + bars(7)),
  roll(S.verse - 2, 2, 0.25, 0.9),                                  // intro → verse
  at(repeat(drums({ snare: SNARE_BACK }, { vel: 0.92 }), 15, 4), S.verse),
  at(drums({ snare: '....x.......x.x.' }, { vel: 0.92 }), S.verse + bars(7)),
  at(drums({ snare: '....x...x.x.xxxx' }, { vel: 0.85 }), S.verse + bars(15)),   // fill into the chorus
  at(repeat(drums({ snare: SNARE_BACK }, { vel: 1 }), 15, 4), S.chorus),
  at(drums({ snare: '....x.......x.x.' }, { vel: 1 }), S.chorus + bars(7)),
  roll(S.chorus + bars(15) + 2, 2, 0.5, 1),
  roll(S.climax - 4, 4, 0.18, 1),                                   // breakdown build
  at(repeat(drums({ snare: SNARE_BACK }, { vel: 1 }), 15, 4), S.climax),
  at(drums({ snare: '....x.......x.x.' }, { vel: 1 }), S.climax + bars(7)),
  roll(S.climax + bars(15), 4, 0.4, 1),
  at(repeat(drums({ snare: SNARE_BACK }, { vel: 0.92 }), 6, 4), S.outro),
  [{ beat: S.outro + bars(7), type: 'on', note: 38, vel: 1, dur: 0.3 }],
  // rides: the space around the snare grows in the choruses (80s big-room snare)
  macroRamp(3, 0.75, 0.15, S.intro, bars(8)), macroRamp(3, 0.15, 0.55, S.chorus, bars(8)), macro(3, 0.3, S.brk),
  macroRamp(3, 0.4, 0.7, S.climax, bars(16)), macroRamp(3, 0.5, 0.9, S.outro + bars(6), bars(2)),
);

// hats: F#2 closed, A#2 open (Quicksilver Hats)
const HATS_8 = { hat: 'x.x.x.x.x.x.x.x.' };
const HATS_8_OPEN = { hat: 'x.x.x.x.x.x.x...', openHat: '..............x.' };
const HATS_16 = { hat: 'xoxoXoxoxoxoXoxo' };
const HATS_16_OPEN = { hat: 'xoxoXoxoxoxoXo..', openHat: '..............x.' };
const hv = { hat: 0.6, openHat: 0.7 };
const hat8 = merge(repeat(drums(HATS_8, { vel: hv }), 3, 4), at(drums(HATS_8_OPEN, { vel: hv }), 12)); // 4 bars
const hat16 = merge(repeat(drums(HATS_16, { vel: hv, ghost: 0.32 }), 3, 4), at(drums(HATS_16_OPEN, { vel: hv, ghost: 0.32 }), 12));
const hats = humanize(merge(
  at(repeat(drums(HATS_8, { vel: { hat: 0.38 } }), 4, 4), S.intro),
  at(hat8, S.intro + bars(4)),
  at(repeat(hat8, 4, 16), S.verse),
  at(repeat(hat16, 4, 16), S.chorus),
  at(repeat(drums({ hat: '..x...x...x...x.' }, { vel: 0.45 }), 2, 4), S.brk + bars(4)),
  at(drums({ hat: 'xoxoxoxoxoxoxoxo' }, { vel: 0.55, ghost: 0.3 }), S.brk + bars(6)),
  [{ beat: S.climax, type: 'on', note: 46, vel: 0.9, dur: 0.5 }],
  at(repeat(hat16, 4, 16), S.climax),
  at(repeat(hat8, 1, 16), S.outro),
  at(repeat(drums(HATS_8, { vel: { hat: 0.5 } }), 3, 4), S.outro + bars(4)),
  [{ beat: S.outro + bars(7), type: 'on', note: 46, vel: 0.85, dur: 0.5 }],
  // rides: hats open up through the chorus/climax, metal shimmer in the climax
  macro(0, 0, S.intro), macroRamp(2, 0.25, 0.5, S.intro, bars(8)), macroRamp(0, 0, 0.35, S.chorus, bars(16)), macro(0, 0, S.brk),
  macroRamp(0, 0.1, 0.5, S.climax, bars(16)), macroRamp(1, 0, 0.4, S.climax, bars(8)), macro(0, 0, S.outro), macro(1, 0, S.outro),
), { timing: 0.006, velocity: 0.05, seed: 11 });

// ───────────── bass (Rubber Pulse) ─────────────
const bass = merge(
  bassPat('Am Fmaj7 C G', 'x-------', { start: S.intro, vel: 0.5, gate: 0.97 }),        // intro: warm drone …
  bassPat('Am Fmaj7 C G', 'x-x-x-x-', { start: S.intro + bars(4), vel: 0.62, gate: 0.9 }), // … then quarter pulses
  bassPat(P_VERSE + ' ' + P_VERSE, 'gxxxggxo', { start: S.verse, vel: 0.82, gate: 0.72 }),
  bassPat(P_CHORUS + ' ' + P_CHORUS, 'gogogogo', { start: S.chorus, vel: 0.85, gate: 0.7 }),
  bassPat('Am F C G Am F', 'x-------', { start: S.brk, vel: 0.55, gate: 0.97 }),
  bassPat('Dm E', 'xxxxxxxo', { start: S.brk + bars(6), vel: 0.78, gate: 0.7 }),
  bassPat(P_CHORUS + ' ' + P_CHORUS, 'gogogogo', { start: S.climax, vel: 0.88, gate: 0.7 }),
  bassPat('Am F C G Am F', 'gxxxggxo', { start: S.outro, vel: 0.8, gate: 0.72 }),
  bassPat('E', 'x-x-x-xo', { start: S.outro + bars(6), vel: 0.8, gate: 0.85 }),
  [{ beat: S.outro + bars(7), type: 'on', note: 33, vel: 0.9, dur: 5 }],
  // rides: Bright (2) breathes with the arrangement, Octave (3) adds bite in the choruses
  macro(0, 0.1, S.intro), macro(1, 0.3, S.intro), macroRamp(2, 0.0, 0.15, S.intro, bars(8)), macro(3, 0, S.intro),
  macro(0, 0.2, S.verse), macroRamp(2, 0.1, 0.35, S.verse, bars(16)), macro(3, 0.1, S.verse),
  macroRamp(2, 0.35, 0.5, S.chorus, bars(16)), macroRamp(3, 0.1, 0.4, S.chorus, bars(16)),
  macroRamp(2, 0.0, 0.0, S.brk, bars(1)), macro(3, 0, S.brk), macroRamp(2, 0.0, 0.6, S.brk + bars(4), bars(4)),
  macro(0, 0.45, S.climax), macroRamp(2, 0.45, 0.6, S.climax, bars(16)), macroRamp(3, 0.25, 0.5, S.climax, bars(16)),
  macro(0, 0.2, S.outro), macroRamp(2, 0.4, 0.0, S.outro, bars(8)), macro(3, 0.1, S.outro),
);

// ───────────── pad (Starfall Brass) ─────────────
const padRange = ['E3', 'D5'];
const pad = merge(
  chords(P_INTRO, { start: S.intro, range: padRange, vel: 0.62, gate: 1 }),
  chords(P_VERSE + ' ' + P_VERSE, { start: S.verse, range: padRange, vel: 0.66, gate: 1 }),
  chords(P_CHORUS + ' ' + P_CHORUS, { start: S.chorus, range: padRange, vel: 0.78, gate: 1 }),
  chords(P_BRK, { start: S.brk, range: padRange, vel: 0.6, gate: 1 }),
  // climax: the brass section pushes (hit on 1, push on the and-of-2) instead of sustaining
  chords(P_CHORUS + ' ' + P_CHORUS, { start: S.climax, range: padRange, vel: 0.82, rhythm: 'x-----x---------', step: 0.25 }),
  chords(P_OUTRO, { start: S.outro, range: padRange, vel: 0.66, gate: 1 }),
  chords('Am', { start: S.outro + bars(7), range: ['A3', 'E5'], vel: 0.72, gate: 1.75 }),   // final chord rings 7 beats
  // rides: Blare 0 · Bright 1 · Stack 2 · Space 3
  macro(0, 0, S.intro), macroRamp(1, 0.0, 0.5, S.intro, bars(8)), macroRamp(3, 0.7, 0.3, S.intro, bars(8)), macro(2, 0.15, S.intro),
  macroRamp(1, 0.4, 0.55, S.verse, bars(16)), macroRamp(2, 0.15, 0.35, S.verse, bars(16)),
  macroRamp(0, 0.1, 0.55, S.chorus, bars(8)), macroRamp(0, 0.2, 0.7, S.chorus + bars(8), bars(8)), macroRamp(2, 0.35, 0.6, S.chorus, bars(16)), macro(1, 0.6, S.chorus),
  macro(0, 0, S.brk), macro(1, 0.15, S.brk), macroRamp(3, 0.3, 0.85, S.brk, bars(2)), macroRamp(1, 0.15, 0.8, S.brk + bars(4), bars(4)),
  ramp('amp.level', -3, -4.5, S.brk, bars(1)), ramp('amp.level', -4.5, -3, S.brk + bars(6), bars(2)),   // (preset level −3 dB)
  macroRamp(0, 0.5, 0.85, S.climax, bars(16)), macro(1, 0.7, S.climax), macroRamp(2, 0.6, 0.9, S.climax, bars(16)), macroRamp(3, 0.85, 0.35, S.climax, bars(2)),
  macroRamp(0, 0.4, 0.0, S.outro, bars(4)), macroRamp(1, 0.7, 0.1, S.outro, bars(8)), macroRamp(3, 0.35, 0.9, S.outro, bars(8)),
);

// ───────────── lead (Polaris Sync) ─────────────
const VERSE_A = 'E5 - D5 - E5 - A5 - | - - G5 - F5 - E5 - | E5 - D5 - E5 - G5 - | - - - - D5 - . . |' +
  'E5 - D5 - E5 - A5 - | - - C6 - B5 - A5 - | A5 - - - F5 - D5 - | E5 - - - - - . . |';
const VERSE_B = 'E5 - D5 - E5 - A5 - | - - G5 - F5 - E5 - | E5 - D5 - E5 - G5 - | - - A5 - G5 - D5 - |' +
  'E5 - D5 - E5 - A5 - | - - C6 - B5 - A5 - | D6 - - - C6 - A5 - | B5 - - - G#5 - - - |';
const CHORUS_A = 'A5 - - - - - G5 A5 | B5 - - - - - A5 B5 | B5 - - - G5 - E5 G5 | A5 - - - - - . . |' +
  'A5 - - - - - G5 A5 | B5 - - - - - C6 D6 | E6 - - - D6 - B5 - | G#5 - - - - - . . |';
const CHORUS_B = 'A5 - - - - - G5 A5 | B5 - - - - - A5 B5 | B5 - - - G5 - E5 G5 | A5 - - - C6 B5 A5 G5 |' +
  'A5 - - - - - G5 A5 | B5 - - - - - C6 D6 | E6 - - - - - D6 - | B5 - - - G#5 - - - |';
const INTRO_ARP = 'A4 . E5 . C5 . E5 . | F4 . C5 . A4 . C5 . | G4 . E5 . C5 . E5 . | G4 . D5 . B4 . D5 . |';
const BRK_LEAD = 'E5 - D5 - E5 - A5 - | - - - - . . . . | E5 - D5 - E5 - G5 - | - - - - . . . . |' +
  'E5 - D5 - E5 - A5 - | - - C6 - B5 - A5 - | A5 - - - F5 - D5 - | E5 - - - G#5 - B5 - |';
const OUTRO_LEAD = 'E5 - D5 - E5 - A5 - | - - G5 - F5 - E5 - | E5 - D5 - E5 - G5 - | - - - - D5 - . . |' +
  'E5 - D5 - E5 - A5 - | - - C6 - B5 - A5 - | B5 - - - G#5 - - - | A5 - - - - - - - - - - - |';   // last A5 rings past the end
const leadEv = merge(
  // intro: echoing arpeggio (no glide), soft then brighter
  lead(INTRO_ARP, S.intro, { vel: 0.5, accent: 0.6, gate: 0.6 }),
  lead(INTRO_ARP, S.intro + bars(4), { vel: 0.62, accent: 0.72, gate: 0.6 }),
  param('voice.glide', 0, S.intro), param('voice.glide', 0.06, S.verse - 0.5),
  lead(VERSE_A, S.verse), lead(VERSE_B, S.verse + bars(8)),
  lead(CHORUS_A, S.chorus, { vel: 0.85 }), lead(CHORUS_B, S.chorus + bars(8), { vel: 0.85 }),
  lead(BRK_LEAD, S.brk, { vel: 0.62 }),
  lead(CHORUS_A, S.climax, { vel: 0.9 }), lead(CHORUS_B, S.climax + bars(8), { vel: 0.92 }),
  lead(OUTRO_LEAD, S.outro, { vel: 0.78 }),
  // rides: Sync 0 · Bright 1 · Grit 2 · Space 3
  macro(0, 0, S.intro), macroRamp(1, 0.0, 0.2, S.intro, bars(8)), macro(2, 0, S.intro), macro(3, 0.75, S.intro),
  macroRamp(3, 0.75, 0.3, S.verse - 1, 2), macroRamp(0, 0.1, 0.35, S.verse, bars(16)), macro(1, 0.25, S.verse),
  macroRamp(0, 0.35, 0.6, S.chorus, bars(16)), macro(1, 0.4, S.chorus), macro(3, 0.35, S.chorus),
  macro(0, 0.15, S.brk), macro(1, 0.05, S.brk), macroRamp(3, 0.35, 0.85, S.brk, bars(1)), macroRamp(0, 0.15, 0.6, S.brk + bars(4), bars(4)),
  // fader rides (amp.level): the lead steps forward in the choruses and sits back in the breakdown
  param('amp.level', 0, S.intro), param('amp.level', 1, S.chorus), param('amp.level', -2.5, S.brk),
  ramp('amp.level', -2.5, 1, S.brk + bars(6), bars(2)), param('amp.level', 0, S.outro),
  macroRamp(0, 0.5, 0.9, S.climax, bars(16)), macroRamp(2, 0.0, 0.45, S.climax, bars(16)), macro(1, 0.5, S.climax), macroRamp(3, 0.85, 0.35, S.climax, 2),
  macroRamp(0, 0.5, 0.1, S.outro, bars(8)), macroRamp(2, 0.3, 0, S.outro, bars(4)), macroRamp(3, 0.35, 0.9, S.outro, bars(8)), macro(1, 0.3, S.outro),
);

export default {
  id: 'neon-nights',
  title: 'Neon Nights',
  zh: '霓虹夜色',
  genre: 'Synthwave',
  zhGenre: '合成器浪潮',
  description: 'A 小調的八〇年代午夜公路：八分音符貝斯推著引擎前進，銅管鋪底隨濾波緩緩綻放，硬同步主奏在副歌掃出霓虹光芒；高潮時同步與咆哮巨集一路推高，最後在尾燈中收束。',
  descriptionEn: 'An 80s midnight highway in A minor: driving eighth-note bass, a brass pad that opens with the filter, and a hard-sync lead sweeping neon across the chorus. The climax pushes the sync and growl macros all the way before it fades out in the tail lights.',
  bpm: 104,
  key: { root: 'A', scale: 'minor' },
  lengthBeats: S.end,
  loop: false,
  cover: { colors: ['#ff2e97', '#7b2ff7', '#2de2e6'] },
  sections: [
    { beat: S.intro, name: 'Nightfall', zh: '夜幕低垂' },
    { beat: S.verse, name: 'Cruise', zh: '城市巡航' },
    { beat: S.chorus, name: 'Neon Skyline', zh: '霓虹天際線' },
    { beat: S.brk, name: 'Rain on Glass', zh: '雨夜玻璃' },
    { beat: S.climax, name: 'Overdrive', zh: '全速奔馳' },
    { beat: S.outro, name: 'Tail Lights', zh: '尾燈' },
  ],
  parts: [
    // kick −2.5 dB (was −4): the phys retune fix (no +dB burst while the pitch envelope drops) left Anvil Kick ≈ 3 LU
    // quieter and thinner; the preset's low shelf (eq.low 3 → 6) and this +1.5 dB bring it back to ≈ −23.6 LUFS
    { name: 'Kick', zh: '大鼓', role: 'drums', preset: 'Anvil Kick', gain: -2.5, pan: 0, events: kick },
    { name: 'Snare', zh: '小鼓', role: 'drums', preset: 'Cobalt Snare',
      params: { 'reverb.size': 0.9, 'reverb.decay': 0.9, 'reverb.damp': 0.3, 'reverb.predelay': 0.008 },   // big 80s room
      macros: [0.5, 0, 0.45, 0.15], gain: -6, pan: 0, events: snare },
    { name: 'Hats', zh: '腳踏鈸', role: 'drums', preset: 'Quicksilver Hats', macros: [0, 0, 0.5, 0], gain: -10.5, pan: 0.2, events: hats },
    { name: 'Bass', zh: '貝斯', role: 'bass', preset: 'Rubber Pulse', gain: -3, pan: 0, events: bass },
    { name: 'Brass', zh: '銅管鋪底', role: 'pad', preset: 'Starfall Brass', params: { 'voice.poly': 8 }, gain: -2, pan: -0.1, events: pad },
    { name: 'Lead', zh: '同步主奏', role: 'lead', preset: 'Polaris Sync', gain: -0.5, pan: 0.05, events: leadEv },
  ],
};
