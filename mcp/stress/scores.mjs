// Public-domain repertoire for MCP verification and stress runs. Melodies only (no lyrics); every arrangement is original.
//   Beethoven, "Ode to Joy" theme, Symphony No. 9 (1824) · Pachelbel, Canon in D (c. 1700)
//   Grieg, "In the Hall of the Mountain King", Peer Gynt (1875) · Petzold (formerly attributed to Bach), Minuet in G (c. 1725)
// Each piece returns { id, title, bpm, lengthBeats, tracks: [{ name, role, preset, params, gain, pan, events }], melody }.
// `melody` is the reference line for the audio checks: [{ beat, note, dur }] in project beats.
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const midi = n => { const m = /^([A-G])(#|b)?(-?\d)$/.exec(n); if (!m) throw new Error('bad note ' + n); return 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); };
export const parse = s => s.trim().split(/\s+/).filter(t => t !== '|').map(t => { const [n, d] = t.split(':'); return [n === 'r' ? null : midi(n), Number(d)]; });
const r6 = x => Math.round(x * 1e6) / 1e6;
const on = (beat, note, vel, dur) => ({ beat: r6(beat), type: 'on', note, vel: r6(Math.max(0.01, Math.min(1, vel))), dur: r6(dur) });
/** Notes of a [midi|null, beats][] line; `time` maps score beats to project beats (tempo curves), `vel` may depend on the score beat. */
function line(seq, { start = 0, vel = 0.8, leg = 0.95, shift = 0, time = b => b } = {}) {
  const out = []; let b = start;
  for (const [n, d] of seq) { if (n != null) { const t0 = time(b), t1 = time(b + d); out.push(on(t0, n + shift, typeof vel === 'function' ? vel(b) : vel, (t1 - t0) * leg)); } b += d; }
  return out;
}
const total = seq => seq.reduce((s, [, d]) => s + d, 0);
/** Clamp durations to the project end, drop events at or past it, sort by beat. */
function finish(piece) {
  const L = piece.lengthBeats;
  for (const t of piece.tracks) t.events = t.events.filter(e => e.beat < L - 1e-6).map(e => e.type === 'on' ? { ...e, dur: r6(Math.max(0.001, Math.min(e.dur, L - e.beat))) } : e).sort((a, b) => a.beat - b.beat);
  piece.melody = piece.melody.filter(n => n.beat < L);
  return piece;
}
const TRI = { D: ['D4', 'F#4', 'A4'], A: ['C#4', 'E4', 'A4'], Bm: ['D4', 'F#4', 'B4'], 'F#m': ['C#4', 'F#4', 'A4'], G: ['D4', 'G4', 'B4'], Em: ['E4', 'G4', 'B4'], C: ['C4', 'E4', 'G4'], Am: ['C4', 'E4', 'A4'] };
const ROOT = { D: 'D3', A: 'A2', Bm: 'B2', 'F#m': 'F#2', G: 'G2', Em: 'E2', C: 'C3', Am: 'A2' };

/* ─────────────── Beethoven: Ode to Joy (D major, two statements + coda) ─────────────── */
const ODE = parse(`F#4:1 F#4:1 G4:1 A4:1 | A4:1 G4:1 F#4:1 E4:1 | D4:1 D4:1 E4:1 F#4:1 | F#4:1.5 E4:0.5 E4:2 |
F#4:1 F#4:1 G4:1 A4:1 | A4:1 G4:1 F#4:1 E4:1 | D4:1 D4:1 E4:1 F#4:1 | E4:1.5 D4:0.5 D4:2 |
E4:1 E4:1 F#4:1 D4:1 | E4:1 F#4:0.5 G4:0.5 F#4:1 D4:1 | E4:1 F#4:0.5 G4:0.5 F#4:1 E4:1 | D4:1 E4:1 A3:2 |
F#4:1 F#4:1 G4:1 A4:1 | A4:1 G4:1 F#4:1 E4:1 | D4:1 D4:1 E4:1 F#4:1 | E4:1.5 D4:0.5 D4:2`);
const ODE_H = 'D D D A D D A A D D D A D D A D A D A D A Bm D A D D D A D D A D'.split(' '); // one chord per half bar
export function odeToJoy() {
  const S2 = 64, CODA = 128, L = 140, cello = [], horn = [], flute = [], strings = [], bass = [], pizz = [], taiko = [];
  cello.push(...line(ODE, { start: 0, vel: b => 0.45 + b / 64 * 0.2, leg: 0.95, shift: -12 }));
  horn.push(...line(ODE, { start: S2, vel: b => 0.72 + (b - S2) / 64 * 0.18, leg: 0.93 }));
  flute.push(...line(ODE, { start: S2, vel: 0.62, leg: 0.9, shift: 12 }));
  ODE_H.forEach((c, i) => {
    const b = i * 2;
    if (b >= 32) for (const n of TRI[c]) strings.push(on(b, midi(n), 0.32, 2.05)); // warm cushion under the second half of statement 1
    strings.push(...TRI[c].map(n => on(S2 + b, midi(n) + 12, 0.55, 2.05)));
    bass.push(on(S2 + b, midi(ROOT[c]), 0.75, 1.9));
    pizz.push(on(S2 + b + 1, midi(TRI[c][1]), 0.5, 0.4)); // off-beat (beats 2 and 4)
    if (b % 4 === 0) taiko.push(on(S2 + b, b % 16 === 0 ? 36 : 43, 0.6 + (b / 64) * 0.25, 1.5));
  });
  for (const n of ['D4', 'F#4', 'A4', 'D5']) strings.push(on(CODA, midi(n), 0.7, 11.5));
  horn.push(on(CODA, midi('D4'), 0.85, 11), on(CODA, midi('A4'), 0.8, 11)); flute.push(on(CODA, midi('F#5'), 0.7, 11));
  bass.push(on(CODA, midi('D2'), 0.85, 11)); taiko.push(on(CODA, 36, 0.9, 2));
  for (let k = 0; k < 12; k++) taiko.push(on(CODA + 5 + k * 0.25, 43, 0.4 + k * 0.04, 0.2));
  taiko.push(on(CODA + 8, 36, 1, 3.5));
  return finish({ id: 'ode-to-joy', title: 'Ode to Joy (Beethoven, 1824)', bpm: 104, lengthBeats: L, tracks: [
    { name: 'Cellos', role: 'lead', preset: 'Rosewood Cello', params: { 'voice.poly': 3 }, gain: -2, pan: 0.15, events: cello },
    { name: 'Horns', role: 'lead', preset: 'Twilight Horn', params: { 'voice.poly': 4 }, gain: -2, pan: -0.15, events: horn },
    { name: 'Flute', role: 'lead', preset: 'Bamboo Dizi', params: {}, gain: -4, pan: 0.05, events: flute },
    { name: 'Strings', role: 'pad', preset: 'Aurora Symphony', params: { 'voice.poly': 8 }, gain: -6, pan: 0, events: strings },
    { name: 'Basses', role: 'bass', preset: 'Rosewood Cello', params: { 'voice.poly': 2 }, gain: -3, pan: 0.05, events: bass },
    { name: 'Pizzicato', role: 'arp', preset: 'Pizzicato Hall', params: { 'voice.poly': 4 }, gain: -8, pan: 0.3, events: pizz },
    { name: 'Timpani', role: 'drums', preset: 'Thunder Taiko', params: { 'voice.poly': 4 }, gain: -6, pan: 0, events: taiko },
  ], melody: line(ODE, { leg: 1 }).map(e => ({ beat: e.beat, note: e.note, dur: e.dur })) });
}

/* ─────────────── Pachelbel: Canon in D (ground bass, three-voice canon; sized near every project limit) ─────────────── */
const CANON_CH = ['D', 'A', 'Bm', 'F#m', 'G', 'D', 'G', 'A'];
const CANON_BASS = ['D3', 'A2', 'B2', 'F#2', 'G2', 'D2', 'G2', 'A2'];
const DMAJ = []; for (let n = 36; n <= 96; n++) if ([2, 4, 6, 7, 9, 11, 1].includes(n % 12)) DMAJ.push(n);
const stepDown = (n, k) => DMAJ[DMAJ.indexOf(n) - k];
const CHORD_PC = { D: [2, 6, 9], A: [9, 1, 4], Bm: [11, 2, 6], 'F#m': [6, 9, 1], G: [7, 11, 2] };
const arpRoot = c => { for (let n = 66; n <= 77; n++) if (n % 12 === CHORD_PC[c][0]) return n; };
const V1 = ['F#5', 'E5', 'D5', 'C#5', 'B4', 'A4', 'B4', 'C#5'].map(midi);
const V2 = ['D5', 'C#5', 'B4', 'A4', 'G4', 'F#4', 'G4', 'E4'].map(midi);
const VAR = {
  V1: V1.map(n => [n, 2]),
  V2: V2.map(n => [n, 2]),
  V3: parse('D5:1 F#5:1 A5:1 G5:1 F#5:1 D5:1 F#5:1 E5:1 D5:1 B4:1 D5:1 A5:1 G5:1 B5:1 A5:1 G5:1'),
  V4: parse(`F#5:.5 D5:.5 E5:.5 F#5:.5 E5:.5 C#5:.5 D5:.5 E5:.5 D5:.5 B4:.5 C#5:.5 D5:.5 C#5:.5 A4:.5 B4:.5 C#5:.5
             B4:.5 G4:.5 A4:.5 B4:.5 A4:.5 F#4:.5 G4:.5 A4:.5 B4:.5 G4:.5 A4:.5 B4:.5 C#5:.5 A4:.5 B4:.5 C#5:.5`),
  V5: V1.flatMap(s => [0, 1, 2, 3, 4, 5, 6, 7].map(k => [stepDown(s, k), 0.25])),
  V6: CANON_CH.flatMap(c => { const r = arpRoot(c), t = CHORD_PC[c].map(pc => { for (let n = r; n < r + 12; n++) if (n % 12 === pc) return n; }); return [t[0], t[1], t[2], t[0] + 12, t[2], t[1], t[0], t[1]].map(n => [n, 0.25]); }),
};
const CANON_LINE = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V5', 'V4', 'V3', 'V6', 'V5', 'V4', 'V2', 'V1'];
export function canonInD() {
  const CYC = 16, CYCLES = 17, CODA = CYC * CYCLES, L = CODA + 8, voices = [[], [], []], harp = [], pad = [], bass = [], cel = [], pizz = [];
  const vel = (cyc, base) => base + Math.min(0.3, cyc * 0.025);
  voices.forEach((v, k) => CANON_LINE.forEach((id, i) => { const cyc = 1 + k + i; v.push(...line(VAR[id], { start: cyc * CYC, vel: vel(cyc, 0.5 - k * 0.04), leg: id === 'V5' || id === 'V6' ? 0.9 : 0.96 })); }));
  for (let cyc = 0; cyc < CYCLES; cyc++) CANON_CH.forEach((c, j) => {
    const b = cyc * CYC + j * 2, r = arpRoot(c) - 12, t = CHORD_PC[c].map(pc => { for (let n = r; n < r + 12; n++) if (n % 12 === pc) return n; });
    bass.push(on(b, midi(CANON_BASS[j]), 0.7, 1.95));
    const step = cyc < 2 ? 0.5 : 0.25, pat = [t[0], t[1], t[2], t[0] + 12, t[1] + 12, t[2] + 12, t[0] + 24, t[2] + 12];
    for (let k = 0; k < 2 / step; k++) harp.push(on(b + k * step, pat[k % 8], vel(cyc, 0.32), 1.1));
    if (cyc >= 1) for (const n of TRI[c]) pad.push(on(b, midi(n), vel(cyc, 0.3), 2.05));
    if (cyc >= 9) cel.push(on(b, V1[j] + 12, vel(cyc, 0.35), 1.9));
    if (cyc >= 4) for (let k = 0; k < 4; k++) pizz.push(on(b + k * 0.5, k % 2 ? t[1] + 12 : t[0] + 12, vel(cyc, 0.38), 0.3));
  });
  for (const n of ['D4', 'F#4', 'A4']) pad.push(on(CODA, midi(n), 0.6, 7.5));
  for (const v of voices) v.push(on(CODA, midi('D5'), 0.6, 7.5));
  bass.push(on(CODA, midi('D2'), 0.75, 7.5)); cel.push(on(CODA, midi('F#6'), 0.45, 6)); harp.push(...[50, 54, 57, 62, 66, 69, 74].map((n, k) => on(CODA + k * 0.25, n, 0.45, 6)));
  return finish({ id: 'canon-in-d', title: 'Canon in D (Pachelbel, c. 1700)', bpm: 96, lengthBeats: L, tracks: [
    { name: 'Ground Bass', role: 'bass', preset: 'Rosewood Cello', params: { 'voice.poly': 2 }, gain: -3, pan: 0.1, events: bass },
    { name: 'Violin I', role: 'lead', preset: 'Aurora Symphony', params: { 'voice.poly': 3 }, gain: -4, pan: -0.35, events: voices[0] },
    { name: 'Violin II', role: 'lead', preset: "String Machine '79", params: { 'voice.poly': 3 }, gain: -5, pan: 0.35, events: voices[1] },
    { name: 'Violin III', role: 'lead', preset: 'Ebony Clarinet', params: { 'voice.poly': 3 }, gain: -6, pan: 0, events: voices[2] },
    { name: 'Harp', role: 'arp', preset: 'Starlight Harp', params: { 'voice.poly': 8 }, gain: -9, pan: -0.2, events: harp },
    { name: 'Choir', role: 'pad', preset: 'Seraphim Voices', params: { 'voice.poly': 6 }, gain: -9, pan: 0, events: pad },
    { name: 'Celesta', role: 'lead', preset: 'Sugar Plum Celesta', params: { 'voice.poly': 4 }, gain: -9, pan: 0.2, events: cel },
    { name: 'Pizzicato', role: 'arp', preset: 'Pizzicato Hall', params: { 'voice.poly': 6 }, gain: -10, pan: 0.3, events: pizz },
  ], melody: line(VAR.V1, { start: CYC, leg: 1 }).concat(line(VAR.V2, { start: 2 * CYC, leg: 1 }), line(VAR.V3, { start: 3 * CYC, leg: 1 })).map(e => ({ beat: e.beat, note: e.note, dur: e.dur })) });
}

/* ─────────────── Grieg: In the Hall of the Mountain King (B minor; accelerando 66 → 198 BPM, crescendo, four rounds) ─────────────── */
const KING = parse(`B3:.5 C#4:.5 D4:.5 E4:.5 F#4:.5 D4:.5 F#4:1 | F4:.5 C#4:.5 F4:1 E4:.5 C4:.5 E4:1 |
B3:.5 C#4:.5 D4:.5 E4:.5 F#4:.5 D4:.5 F#4:.5 B4:.5 | A4:.5 F#4:.5 D4:.5 F#4:.5 A4:2 |
F#4:.5 G#4:.5 A4:.5 B4:.5 C#5:.5 A4:.5 C#5:1 | C5:.5 G#4:.5 C5:1 B4:.5 G4:.5 B4:1 |
F#4:.5 G#4:.5 A4:.5 B4:.5 C#5:.5 A4:.5 C#5:.5 F#5:.5 | E5:.5 C#5:.5 A4:.5 C#5:.5 E5:2`);
export const KING_TEMPO = { start: 66, end: 198, scoreBeats: 128, projectBpm: 120 };
/** Project beat of a score beat under the exponential accelerando (constant 198 BPM after the last round). */
export function kingTime(s) {
  const { start: b0, end: b1, scoreBeats: S, projectBpm } = KING_TEMPO, r = b1 / b0, k = Math.log(r);
  const sec = s <= S ? (60 / b0) * (S / k) * (1 - r ** (-s / S)) : (60 / b0) * (S / k) * (1 - 1 / r) + (s - S) * 60 / b1;
  return sec * projectBpm / 60;
}
export function mountainKing() {
  const R = total(KING), rounds = 4, CODA = R * rounds, L = Math.ceil(kingTime(CODA + 8)) + 4;
  const v = (s, lo, hi) => lo + (hi - lo) * Math.min(1, s / CODA), t = kingTime;
  const pizz = [], bassoon = [], violins = [], brass = [], bass = [], snare = [], timp = [];
  for (let i = 0; i < rounds; i++) {
    const s0 = i * R;
    pizz.push(...line(KING, { start: s0, shift: -12, leg: 0.45, vel: s => v(s, 0.4, 0.95), time: t }));
    bassoon.push(...line(KING, { start: s0, shift: -12, leg: 0.55, vel: s => v(s, 0.35, 0.85), time: t }));
    if (i >= 1) violins.push(...line(KING, { start: s0, leg: 0.6, vel: s => v(s, 0.4, 0.95), time: t }));
    if (i >= 2) brass.push(...line(KING, { start: s0, leg: 0.6, vel: s => v(s, 0.5, 1), time: t }));
    for (let q = 0; q < R; q++) { const s = s0 + q, minor = q < 16 ? 'B2' : 'F#2'; bass.push(on(t(s), midi(minor), v(s, 0.45, 0.95), (t(s + 1) - t(s)) * 0.5)); }
    if (i >= 2) for (let e = 0; e < R * 2; e++) { const s = s0 + e / 2; snare.push(on(t(s), 38, v(s, 0.3, 0.8) * (e % 2 ? 0.7 : 1), 0.1)); }
    if (i >= 3) for (let q = 0; q < R; q++) { const s = s0 + q; timp.push(on(t(s), q % 4 === 0 ? 36 : 43, v(s, 0.6, 1), 0.5)); }
  }
  for (let k = 0; k < 8; k++) snare.push(on(t(CODA - 1 + k / 8), 38, 0.6 + k * 0.05, 0.08));
  [0, 1, 2, 3].forEach(q => { const s = CODA + q; for (const n of ['B2', 'F#3', 'B3', 'D4', 'F#4', 'B4']) brass.push(on(t(s), midi(n), 1, (t(s + 1) - t(s)) * 0.45)); timp.push(on(t(s), 36, 1, 0.4)); bass.push(on(t(s), midi('B1'), 1, (t(s + 1) - t(s)) * 0.45)); });
  for (const n of ['B2', 'B3', 'F#4', 'B4']) { brass.push(on(t(CODA + 4), midi(n), 1, t(CODA + 8) - t(CODA + 4))); violins.push(on(t(CODA + 4), midi(n) + 12, 0.95, t(CODA + 8) - t(CODA + 4))); }
  bass.push(on(t(CODA + 4), midi('B1'), 1, t(CODA + 8) - t(CODA + 4))); timp.push(on(t(CODA + 4), 36, 1, 3));
  const melody = []; for (let i = 0; i < rounds; i++) melody.push(...line(KING, { start: i * R, leg: 1, time: t }).map(e => ({ beat: e.beat, note: e.note, dur: e.dur })));
  return finish({ id: 'mountain-king', title: 'In the Hall of the Mountain King (Grieg, 1875)', bpm: KING_TEMPO.projectBpm, lengthBeats: L, tracks: [
    { name: 'Pizzicato Low', role: 'bass', preset: 'Pizzicato Hall', params: { 'voice.poly': 4 }, gain: -4, pan: 0.2, events: pizz },
    { name: 'Bassoon', role: 'lead', preset: 'Ebony Clarinet', params: { 'voice.poly': 2 }, gain: -5, pan: -0.15, events: bassoon },
    { name: 'Violins', role: 'lead', preset: 'Aurora Symphony', params: { 'voice.poly': 6 }, gain: -5, pan: -0.3, events: violins },
    { name: 'Brass', role: 'lead', preset: 'Gilded Fanfare', params: { 'voice.poly': 8 }, gain: -6, pan: 0.25, events: brass },
    { name: 'Basses', role: 'bass', preset: 'Rosewood Cello', params: { 'voice.poly': 2 }, gain: -4, pan: 0, events: bass },
    { name: 'Snare', role: 'drums', preset: 'Cobalt Snare', params: {}, gain: -10, pan: 0.08, events: snare },
    { name: 'Timpani', role: 'drums', preset: 'Thunder Taiko', params: { 'voice.poly': 4 }, gain: -6, pan: 0, events: timp },
  ], melody });
}

/* ─────────────── Petzold: Minuet in G (3/4; harpsichord, second pass with celesta and pizzicato) ─────────────── */
const MIN_RH = parse(`D5:1 G4:.5 A4:.5 B4:.5 C5:.5 | D5:1 G4:1 G4:1 | E5:1 C5:.5 D5:.5 E5:.5 F#5:.5 | G5:1 G4:1 G4:1 |
C5:1 D5:.5 C5:.5 B4:.5 A4:.5 | B4:1 C5:.5 B4:.5 A4:.5 G4:.5 | F#4:1 G4:.5 A4:.5 B4:.5 G4:.5 | A4:3 |
D5:1 G4:.5 A4:.5 B4:.5 C5:.5 | D5:1 G4:1 G4:1 | E5:1 C5:.5 D5:.5 E5:.5 F#5:.5 | G5:1 G4:1 G4:1 |
C5:1 D5:.5 C5:.5 B4:.5 A4:.5 | B4:1 C5:.5 B4:.5 A4:.5 G4:.5 | A4:1 B4:.5 A4:.5 G4:.5 F#4:.5 | G4:3`);
const MIN_LH = parse(`G3:2 A3:1 | B3:3 | C4:3 | B3:3 | A3:3 | G3:3 | D4:1 B3:1 G3:1 | D3:2 C4:1 |
G3:2 A3:1 | B3:3 | C4:3 | B3:3 | A3:3 | G3:3 | C4:1 D4:1 D3:1 | G3:2 G2:1`);
export function minuetInG() {
  const P = total(MIN_RH), L = 2 * P + 6, rh = [], lh = [], cel = [], pizz = [];
  rh.push(...line(MIN_RH, { start: 0, vel: 0.62, leg: 0.88 }), ...line(MIN_RH, { start: P, vel: 0.72, leg: 0.88 }));
  lh.push(...line(MIN_LH, { start: 0, vel: 0.55, leg: 0.92 }), ...line(MIN_LH, { start: P, vel: 0.62, leg: 0.92 }));
  cel.push(...line(MIN_RH, { start: P, vel: 0.4, leg: 0.8, shift: 12 }));
  pizz.push(...line(MIN_LH, { start: P, vel: 0.45, leg: 0.5, shift: -12 }));
  for (const n of ['G4', 'B4', 'D5', 'G5']) rh.push(on(2 * P, midi(n), 0.7, 5.5));
  lh.push(on(2 * P, midi('G2'), 0.65, 5.5), on(2 * P, midi('G3'), 0.6, 5.5)); cel.push(on(2 * P, midi('G6'), 0.35, 5));
  return finish({ id: 'minuet-in-g', title: 'Minuet in G (Petzold, c. 1725)', bpm: 120, lengthBeats: L, tracks: [
    { name: 'Harpsichord RH', role: 'lead', preset: 'Versailles Harpsichord', params: {}, gain: -3, pan: -0.1, events: rh },
    { name: 'Harpsichord LH', role: 'bass', preset: 'Versailles Harpsichord', params: {}, gain: -4, pan: 0.1, events: lh },
    { name: 'Celesta', role: 'lead', preset: 'Sugar Plum Celesta', params: { 'voice.poly': 4 }, gain: -10, pan: 0.25, events: cel },
    { name: 'Pizzicato', role: 'bass', preset: 'Pizzicato Hall', params: { 'voice.poly': 3 }, gain: -9, pan: 0.3, events: pizz },
  ], melody: line(MIN_RH, { leg: 1 }).map(e => ({ beat: e.beat, note: e.note, dur: e.dur })) });
}
export const PIECES = { 'ode-to-joy': odeToJoy, 'canon-in-d': canonInD, 'mountain-king': mountainKing, 'minuet-in-g': minuetInG };
