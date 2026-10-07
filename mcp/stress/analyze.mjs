// Audio checks for rendered reference melodies: YIN fundamental per note (cents vs the score) and onset time vs the score.
// The reference render uses a plain sine voice (no vibrato, drift, unison, filter or effects), so errors measure the
// MCP → sequencer → engine path, not the arrangement's timbre.
export function yinHz(x, sr, start, { fmin = 70, fmax = 1600, window = 2048, threshold = 0.12 } = {}) {
  const maxT = Math.floor(sr / fmin), minT = Math.max(2, Math.floor(sr / fmax)), W = window;
  if (start < 0 || start + W + maxT + 1 >= x.length) return NaN;
  const d = new Float64Array(maxT + 2);
  for (let tau = 1; tau <= maxT + 1; tau++) { let s = 0; for (let j = 0; j < W; j++) { const v = x[start + j] - x[start + j + tau]; s += v * v; } d[tau] = s; }
  const c = new Float64Array(maxT + 2); c[0] = 1; let run = 0;
  for (let tau = 1; tau <= maxT + 1; tau++) { run += d[tau]; c[tau] = run > 0 ? d[tau] * tau / run : 1; }
  let tau = -1;
  for (let t = minT; t <= maxT; t++) if (c[t] < threshold) { while (t < maxT && c[t + 1] < c[t]) t++; tau = t; break; }
  if (tau < 0) { tau = minT; for (let t = minT; t <= maxT; t++) if (c[t] < c[tau]) tau = t; }
  const a = c[tau - 1], b = c[tau], g = c[tau + 1], den = a + g - 2 * b;
  return sr / (tau + (den ? (a - g) / (2 * den) : 0));
}
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
const stats = xs => { const s = xs.slice().sort((a, b) => a - b), n = s.length, abs = xs.map(Math.abs).sort((a, b) => a - b); return n ? { n, mean: xs.reduce((p, v) => p + v, 0) / n, median: s[n >> 1], p95Abs: abs[Math.min(n - 1, Math.floor(n * 0.95))], maxAbs: abs[n - 1] } : { n: 0 }; };
/**
 * @param {Float32Array|Float64Array} x mono signal; @param {number} sr; @param {{beat,note,dur}[]} notes; @param {number} bpm project tempo
 * @returns {{ pitchCents, onsetMs, notes: {beat,note,expectedHz,measuredHz,cents,onsetMs}[] }}
 */
export function checkMelody(x, sr, notes, bpm, { articulation = 0.7 } = {}) {
  const spb = 60 / bpm, out = [];
  for (const n of notes) {
    const t0 = n.beat * spb, len = n.dur * articulation * spb, s0 = Math.round(t0 * sr);
    // steady-state window starts 30 % into the sounding part
    const f = yinHz(x, sr, Math.round((t0 + len * 0.3) * sr), { window: Math.min(2048, Math.floor(len * sr * 0.35)) });
    let peak = 0; for (let i = Math.round((t0 + len * 0.3) * sr), e = Math.round((t0 + len * 0.7) * sr); i < e; i++) peak = Math.max(peak, Math.abs(x[i]));
    let onset = NaN; for (let i = Math.max(0, s0 - Math.round(0.02 * sr)), e = Math.min(x.length, s0 + Math.round(0.05 * sr)); i < e; i++) if (Math.abs(x[i]) > peak * 0.25) { onset = (i - s0) / sr * 1000; break; }
    out.push({ beat: n.beat, note: n.note, expectedHz: hz(n.note), measuredHz: f, cents: 1200 * Math.log2(f / hz(n.note)), onsetMs: onset });
  }
  const valid = out.filter(o => Number.isFinite(o.cents)), timed = out.filter(o => Number.isFinite(o.onsetMs));
  return { checked: out.length, pitchCents: stats(valid.map(o => o.cents)), onsetMs: stats(timed.map(o => o.onsetMs)), missingPitch: out.length - valid.length, missingOnset: out.length - timed.length,
    worst: out.slice().sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, 3) };
}
