import { Synth, renderOffline } from '../dsp/synth.js';
import { Ensemble, SafetyBus } from '../dsp/ensemble.js';
import { validateProject, LIMITS, bounded, choice, fail } from './project.js';
export function renderPlan(project, options = {}) {
  validateProject(project);
  for (const k of Object.keys(options)) if (!['sampleRate', 'tailSeconds', 'bitDepth', 'loop', 'fadeSeconds'].includes(k)) fail('INVALID_ARGUMENT', 'Unknown render option ' + k);
  const sampleRate = options.sampleRate ?? 24000, tailSeconds = options.tailSeconds ?? 2, bitDepth = options.bitDepth ?? 24;
  choice(sampleRate, [16000, 24000, 44100, 48000], 'sampleRate'); choice(bitDepth, [16, 24], 'bitDepth');
  bounded(tailSeconds, 0, 8, 'tailSeconds'); bounded(options.fadeSeconds ?? 0.02, 0, 0.2, 'fadeSeconds');
  if (options.loop !== undefined && typeof options.loop !== 'boolean') fail('INVALID_ARGUMENT', 'loop must be boolean');
  const contentSeconds = project.lengthBeats * 60 / project.globals['global.bpm'], seconds = contentSeconds + tailSeconds;
  if (seconds > LIMITS.seconds) fail('RESOURCE_LIMIT', 'Content plus tail exceeds 180s; shorten project or tail');
  const frames = Math.ceil(seconds * sampleRate), bytes = 44 + frames * 2 * bitDepth / 8;
  if (bytes > LIMITS.outputBytes) fail('RESOURCE_LIMIT', 'Output exceeds byte budget');
  return { sampleRate, tailSeconds, bitDepth, contentSeconds, seconds, frames, bytes, loop: options.loop ?? false, fadeSeconds: options.fadeSeconds ?? 0.02 };
}
export function timedEvents(events, bpm) {
  const spb = 60 / bpm, out = [];
  for (const e of events) {
    const x = { ...e, time: e.beat * spb }; delete x.beat;
    if (e.type === 'on') { delete x.dur; out.push(x, { time: (e.beat + e.dur) * spb, type: 'off', note: e.note }); }
    else out.push(x);
  }
  return out.sort((a, b) => a.time - b.time || (a.type === 'off' ? -1 : b.type === 'off' ? 1 : 0));
}
export function songForProject(p) {
  validateProject(p);
  return { id: 'mcp-project', title: p.title, bpm: p.globals['global.bpm'], lengthBeats: p.lengthBeats, loop: false,
    parts: p.tracks.map(t => ({ name: t.name, role: t.role, patch: { ...t.patch, params: { ...t.patch.params, 'scale.root': p.globals['scale.root'] ?? 0, 'scale.type': p.globals['scale.type'] ?? 'off' } }, gain: t.gain, pan: t.pan, mute: t.mute, events: t.events })) };
}
export function renderProject(project, options = {}) {
  const plan = renderPlan(project, options), sr = plan.sampleRate, started = performance.now();
  let L, R, synth, ensemble, lastActive = 0;
  if (project.tracks.length === 1) {
    const t = project.tracks[0], patch = { ...t.patch, params: { ...t.patch.params, ...project.globals } };
    // Same sequencer for one track and ensemble: ramps and note ordering match.
    const events = [{ time: 0, type: 'seqLoad', song: { bpm: project.globals['global.bpm'], lengthBeats: project.lengthBeats, loop: false, events: t.events } }, { time: 0, type: 'seqPlay' }];
    const result = renderOffline(patch, events, plan.seconds, sr, { seed: project.seed });
    L = result.L; R = result.R; synth = result.synth;
    const gain = t.mute ? 0 : 10 ** (t.gain / 20);
    const panL = t.pan > 0 ? Math.cos(t.pan * Math.PI / 2) : 1, panR = t.pan < 0 ? Math.cos(-t.pan * Math.PI / 2) : 1;
    for (let i = 0; i < L.length; i++) { L[i] *= gain * panL; R[i] *= gain * panR; }
    lastActive = synth.getState().voices.length;
  } else {
    ensemble = new Ensemble(sr, { eager: true, seed: project.seed }); ensemble.stopHold = plan.tailSeconds; ensemble.maxEndTail = plan.tailSeconds;
    ensemble.load(songForProject(project)); project.tracks.forEach((t, i) => ensemble.setPart(i, { mute: t.mute }));
    ensemble.play(); const bus = new SafetyBus(sr); bus.engaged = true; bus.reset();
    L = new Float32Array(plan.frames); R = new Float32Array(plan.frames);
    const bl = new Float32Array(128), br = new Float32Array(128), gain = 10 ** (((project.globals['master.volume'] ?? -3) + 3) / 20);
    for (let pos = 0; pos < plan.frames; pos += 128) {
      const n = Math.min(128, plan.frames - pos); bl.fill(0); br.fill(0); ensemble.process(bl, br, n); bus.process(bl, br, n);
      for (let i = 0; i < n; i++) { L[pos + i] = bl[i] * gain; R[pos + i] = br[i] * gain; }
    }
    lastActive = ensemble.getState().parts.reduce((n, t) => n + (t.notes?.length || 0), 0);
  }
  let peak = 0, energy = 0, tailPeak = 0; const tailStart = Math.max(0, L.length - Math.round(sr * 0.02));
  for (let i = 0; i < L.length; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) fail('NONFINITE_AUDIO', 'DSP generated nonfinite audio');
    const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); peak = Math.max(peak, v); energy += (L[i] ** 2 + R[i] ** 2) / 2; if (i >= tailStart) tailPeak = Math.max(tailPeak, v);
  }
  const gain = peak > 0.966 ? 0.966 / peak : 1, fade = Math.min(Math.round(plan.fadeSeconds * sr), Math.floor(L.length / 2));
  for (let i = 0; i < L.length; i++) {
    let envelope = gain;
    if (i >= L.length - fade) envelope *= (L.length - 1 - i) / Math.max(1, fade - 1);
    if (plan.loop && i < fade) envelope *= i / Math.max(1, fade - 1);
    L[i] *= envelope; R[i] *= envelope;
  }
  const warnings = [];
  if (tailPeak > 0.0001 || lastActive > 0) warnings.push('TAIL_FADED_AT_BUDGET: increase tailSeconds for a longer natural decay');
  if (peak < 0.00001) warnings.push('SILENT_OUTPUT: inspect notes, envelopes, source levels and track mute');
  if (gain < 1) warnings.push('PEAK_ATTENUATED: output gain reduced to -0.3 dBFS ceiling');
  return { L, R, plan, metrics: { peakDbFS: 20 * Math.log10(Math.max(1e-12, peak * gain)), rmsDbFS: 10 * Math.log10(Math.max(1e-24, energy / L.length * gain ** 2)), renderMs: performance.now() - started, frames: L.length, sampleRate: sr, seconds: plan.seconds, tracks: project.tracks.length, seed: project.seed, engineVersion: project.provenance?.source || 'aurora-synth', warnings } };
}
// Uint8Array/DataView WAV core works in browsers, Node and Workers.
export function encodePcmWav(L, R, sr, bitDepth = 24) {
  choice(bitDepth, [16, 24], 'bitDepth');
  if (L.length !== R.length) fail('INVALID_AUDIO', 'Channel lengths differ');
  const bytesPerSample = bitDepth / 8, bytes = new Uint8Array(44 + L.length * 2 * bytesPerSample), v = new DataView(bytes.buffer);
  const tag = (offset, s) => { for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2 * bytesPerSample, true); v.setUint16(32, 2 * bytesPerSample, true); v.setUint16(34, bitDepth, true); tag(36, 'data'); v.setUint32(40, bytes.length - 44, true);
  let offset = 44;
  for (let i = 0; i < L.length; i++) for (const c of [L, R]) {
    const x = c[i]; if (!Number.isFinite(x)) fail('NONFINITE_AUDIO', 'Cannot encode nonfinite audio');
    const n = Math.round(Math.max(-1, Math.min(1, x)) * (bitDepth === 24 ? 8388607 : 32767));
    if (bitDepth === 16) v.setInt16(offset, n, true);
    else { bytes[offset] = n & 255; bytes[offset + 1] = (n >> 8) & 255; bytes[offset + 2] = (n >> 16) & 255; }
    offset += bytesPerSample;
  }
  return bytes;
}
