// MCP verification and stress run with public-domain repertoire (see scores.mjs).
// Usage: node mcp/stress/run.mjs <outDir> [--cloud http://127.0.0.1:8792/mcp] [--production https://…/mcp] [--skip-watchdog]
// Everything goes through official SDK clients: stdio for the Node renderer, Streamable HTTP for Cloudflare endpoints.
// Production checks are bounded and quota-neutral: tool listing, validation and a render request that must be
// refused before any job or byte reservation (cloud upload limit).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { decodeWav } from '../../tools/wav.mjs';
import { loudness } from '../../tools/analyze.mjs';
import { PIECES } from './scores.mjs';
import { checkMelody } from './analyze.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), outDir = args[0]; if (!outDir) throw new Error('Usage: node mcp/stress/run.mjs <outDir> [--cloud url] [--production url] [--skip-watchdog]');
const opt = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const LONG = 1200000, evidence = { at: new Date().toISOString(), node: process.version, repertoire: 'public domain; melodies only; original arrangements', pieces: {}, verification: {}, stress: {} };
// schema (input) errors come back as plain text, tool errors as {status, data}
const unwrap = r => { if (r.structuredContent?.data) return r.structuredContent.data; const text = r.content?.[0]?.text ?? ''; try { return JSON.parse(text).data ?? {}; } catch { return { code: 'INPUT_VALIDATION', message: text }; } };
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const latency = xs => ({ n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1), max: +Math.max(...xs).toFixed(1) });
function session(client, transport) {
  const log = [];
  const call = async (name, a, { timeout = 120000, expectError = false } = {}) => {
    const t = performance.now(), r = await client.callTool({ name, arguments: a }, { timeout }), ms = performance.now() - t, d = unwrap(r);
    log.push({ name, ms }); if (r.isError && !expectError) throw new Error(name + ': ' + JSON.stringify(d).slice(0, 300));
    return r.isError ? { isError: true, ...d, ms } : d;
  };
  return { client, call, log, close: async () => { await client.close(); await transport?.close?.(); } };
}
async function stdio(env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/stdio.mjs')], cwd: ROOT, stderr: 'pipe', env: { ...process.env, ...env } });
  const client = new Client({ name: 'aurora-stress', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport); return session(client, transport);
}
async function http(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url)), client = new Client({ name: 'aurora-stress-http', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport); return session(client, transport);
}
// The Node adapter keeps a 100 MB / 1 h artifact budget; drop each artifact this run created once it is copied or analysed.
const ARTIFACT = /[\\/]renders[\\/]mcp[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(wav|json)$/;
const release = async a => { for (const f of [a?.wavPath, a?.projectPath]) if (f && ARTIFACT.test(f)) await fs.unlink(f).catch(() => {}); };
const counts = p => ({ tracks: p.tracks.length, events: p.tracks.reduce((s, t) => s + t.events.length, 0), automation: p.tracks.reduce((s, t) => s + t.events.filter(e => e.type !== 'on').length, 0), jsonBytes: Buffer.byteLength(JSON.stringify(p)), seconds: +(p.lengthBeats * 60 / p.globals['global.bpm']).toFixed(2) });
async function build(call, piece) {
  let project = null;
  for (const t of piece.tracks) {
    const patch = (await call('get_preset', { name: t.preset })).patch; Object.assign(patch.params, t.params);
    const track = { name: t.name, role: t.role, patch, gain: t.gain, pan: t.pan, mute: false, events: t.events };
    if (!project) {
      project = (await call('create_project', { title: piece.title, kind: 'music', seed: 1207, patch, axes: { rhythm: { bpm: piece.bpm } } })).project;
      project = (await call('set_parameters', { project, values: { 'global.bpm': piece.bpm, 'master.volume': -3 } })).project;
      project = (await call('resize_project', { project, lengthBeats: piece.lengthBeats })).project;
      project = (await call('set_track', { project, index: 0, changes: track })).project;
    } else project = (await call('add_track', { project, track })).project;
  }
  return project;
}
/** Piece-specific use of the website-parity tools (auto-morph, evolve, freeze, mood), sized for the stress targets. */
async function decorate(call, id, project, notes) {
  if (id === 'canon-in-d') {
    project = (await call('auto_morph', { project, index: 5, preset: 'Aurora Pad', period: 24, steps: 48 })).project; notes.push('auto_morph Choir ⇄ Aurora Pad, 24 s period');
    const probe = (await call('evolve_sound', { project, index: 4, algorithm: 'website', steps: 2, groups: { macros: true, timbre: true, space: true } })).project;
    const targets = (counts(probe).automation - counts(project).automation) / 2, c = counts(project);
    const steps = Math.max(2, Math.min(512, Math.floor((4096 - 8 - c.automation) / targets), Math.floor((8192 - 8 - c.events) / targets)));
    project = (await call('evolve_sound', { project, index: 4, algorithm: 'website', steps, intensity: 0.5, groups: { macros: true, timbre: true, space: true } })).project;
    notes.push(`evolve_sound website on Harp: ${targets} targets × ${steps} steps`);
  } else if (id === 'minuet-in-g') {
    project = (await call('auto_morph', { project, index: 0, preset: 'Golden Twelve', period: 16, startBeat: 48, endBeat: 96, steps: 24 })).project; notes.push('auto_morph harpsichord ⇄ Golden Twelve in the second pass');
    project = (await call('evolve_sound', { project, index: 2, algorithm: 'website', steps: 32, intensity: 0.6 })).project;
    project = (await call('freeze_sound', { project, index: 2, beat: 72 })).project; notes.push('evolve_sound on Celesta, then freeze_sound at beat 72');
  } else if (id === 'ode-to-joy') { project = (await call('apply_mood', { project, index: 3, moods: ['warmer', 'wider'], amount: 0.4 })).project; notes.push('apply_mood warmer + wider on Strings'); }
  else if (id === 'mountain-king') { project = (await call('evolve_sound', { project, index: 3, algorithm: 'website', steps: 48, intensity: 0.35 })).project; notes.push('evolve_sound website on Brass'); }
  return project;
}
async function audioFacts(file) {
  const w = decodeWav(await fs.readFile(file)), [L, R] = w.channels; let peak = 0, nonfinite = 0;
  for (let i = 0; i < L.length; i++) { if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nonfinite++; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  return { sampleRate: w.sampleRate, bitDepth: w.bitDepth, seconds: +(L.length / w.sampleRate).toFixed(3), peakDbFS: +(20 * Math.log10(peak || 1e-12)).toFixed(2), lufs: +loudness(L, R, w.sampleRate).integrated.toFixed(1), nonfinite };
}
const CLEAN = { 'osc1.on': true, 'osc1.mode': 'classic', 'osc1.shape': 0, 'osc1.drift': 0, 'osc1.unison': 1, 'osc1.level': 0.8, 'osc2.on': false, 'fm.on': false, 'phys.on': false, 'noise.on': false, 'filter.on': false,
  'chorus.on': false, 'delay.on': false, 'reverb.on': false, 'phaser.on': false, 'drive.on': false, 'vib.depth': 0, 'aenv.a': 0.002, 'aenv.d': 0.05, 'aenv.s': 1, 'aenv.r': 0.02, 'amp.vel': 0, 'voice.glide': 0 };
async function verifyMelody(call, piece) {
  let p = (await call('create_project', { title: piece.id + ' reference', kind: 'music', seed: 1, axes: { rhythm: { bpm: piece.bpm } } })).project;
  p = (await call('set_parameters', { project: p, values: { ...CLEAN, 'global.bpm': piece.bpm } })).project;
  const end = Math.max(...piece.melody.map(n => n.beat + n.dur)) + 0.5;
  p = (await call('resize_project', { project: p, lengthBeats: Math.round(end * 1e6) / 1e6 })).project;
  p = (await call('set_track', { project: p, index: 0, changes: { events: piece.melody.map(n => ({ beat: n.beat, type: 'on', note: n.note, vel: 0.8, dur: Math.round(n.dur * 0.7 * 1e6) / 1e6 })) } })).project;
  const art = await call('render_audio', { project: p, options: { sampleRate: 48000, bitDepth: 16, tailSeconds: 0.3 } }, { timeout: LONG });
  const w = decodeWav(await fs.readFile(art.wavPath)); await release(art);
  return { renderMs: Math.round(art.metrics.renderMs), ...checkMelody(w.channels[0], w.sampleRate, piece.melody, piece.bpm, { articulation: 0.7 }) };
}
await fs.mkdir(outDir, { recursive: true });
const main = await stdio({ AURORA_RENDER_TIMEOUT_MS: String(LONG) }), call = main.call, projects = {};
try {
  for (const [id, make] of Object.entries(PIECES)) {
    const piece = make(), notes = [], t0 = performance.now();
    let project = await build(call, piece); project = await decorate(call, id, project, notes);
    const plan = (await call('validate_project', { project, options: id === 'canon-in-d' ? { sampleRate: 48000, bitDepth: 24, tailSeconds: 4 } : { sampleRate: 44100, bitDepth: 24, tailSeconds: 3 } })).plan;
    const buildMs = performance.now() - t0, options = { sampleRate: plan.sampleRate, bitDepth: plan.bitDepth, tailSeconds: plan.tailSeconds };
    console.log(`[${id}] built ${JSON.stringify(counts(project))}; rendering ${plan.seconds.toFixed(1)} s at ${plan.sampleRate} Hz…`);
    const art = await call('render_audio', { project, options }, { timeout: LONG }), file = path.join(outDir, id + '.wav');
    await fs.copyFile(art.wavPath, file); await fs.writeFile(path.join(outDir, id + '.project.json'), JSON.stringify(project)); await release(art);
    const facts = await audioFacts(file);
    evidence.pieces[id] = { title: piece.title, ...counts(project), features: notes, buildMs: Math.round(buildMs), render: { status: art.status, renderMs: Math.round(art.metrics.renderMs), realtimeFactor: +(plan.seconds / (art.metrics.renderMs / 1000)).toFixed(2), bytes: art.bytes, sha256: art.hash, warnings: art.metrics.warnings }, audio: facts };
    projects[id] = project; console.log(`[${id}] ${art.status} in ${(art.metrics.renderMs / 1000).toFixed(1)} s, ${facts.lufs} LUFS, peak ${facts.peakDbFS} dBFS`);
    evidence.verification[id] = await verifyMelody(call, piece);
    const v = evidence.verification[id]; console.log(`[${id}] reference melody: ${v.checked} notes, pitch |cents| p95 ${v.pitchCents.p95Abs?.toFixed(2)} max ${v.pitchCents.maxAbs?.toFixed(2)}, onset ms median ${v.onsetMs.median?.toFixed(2)} max ${v.onsetMs.maxAbs?.toFixed(2)}`);
  }
  // ── limit enforcement on the largest project ──
  const canon = projects['canon-in-d'], limits = {};
  const expect = async (label, name, a, pattern) => { const r = await call(name, a, { expectError: true, timeout: LONG }); limits[label] = { refused: !!r.isError, code: r.code || null, message: (r.message || '').slice(0, 120), ok: !!r.isError && (!pattern || pattern.test(r.message || r.code || '')) }; };
  await expect('ninth track', 'add_track', { project: canon, track: canon.tracks[0] }, /1\.\.8 tracks/);
  await expect('events over 8192', 'set_track', { project: canon, index: 6, changes: { events: [...canon.tracks[6].events, ...Array.from({ length: 8192 }, (_, k) => ({ beat: (k % 270), type: 'on', note: 60, vel: 0.5, dur: 0.1 }))].slice(0, 8192 - (counts(canon).events - canon.tracks[6].events.length) + 1).sort((x, y) => x.beat - y.beat) } }, /8192/);
  // swap notes for automation so the event total stays put and only the automation limit can trip
  const extra = 4096 - counts(canon).automation + 1;
  await expect('automation over 4096', 'set_track', { project: canon, index: 7, changes: { events: [...canon.tracks[7].events.slice(extra), ...Array.from({ length: extra }, (_, k) => ({ beat: k % 270, type: 'macro', index: 0, value: 0.5 }))].sort((x, y) => x.beat - y.beat) } }, /4096 automation/);
  await expect('content over 180 s', 'resize_project', { project: canon, lengthBeats: 290 }, /180/);
  await expect('content + tail over 180 s', 'render_audio', { project: canon, options: { tailSeconds: 6 } }, /180/);
  const full = Object.fromEntries((await call('get_parameter_schema', {})).parameters.filter(p => p.scope !== 'global').map(p => [p.id, p.def]));
  await expect('project JSON over 1.5 MB', 'set_track', { project: projects['minuet-in-g'], index: 3, changes: { events: Array.from({ length: 400 }, (_, k) => ({ beat: k / 8, type: 'params', values: full })) } }, /byte limit/);
  await expect('unsupported sample rate', 'render_audio', { project: projects['minuet-in-g'], options: { sampleRate: 96000 } });
  await expect('stale revision', 'set_parameters', { project: canon, values: { 'filter.cutoff': 900 }, expectedRevision: 0 }, /Expected 0/);
  evidence.stress.limits = limits; console.log('[limits]', Object.entries(limits).map(([k, v]) => `${k}: ${v.ok ? 'refused ✓' : 'NOT REFUSED ✗'}`).join(' · '));
  // ── concurrency: one renderer slot per process ──
  const small = projects['minuet-in-g'], race = await Promise.all([0, 1].map(() => call('render_audio', { project: small, options: { sampleRate: 16000, tailSeconds: 0 } }, { expectError: true, timeout: LONG })));
  evidence.stress.concurrency = { ready: race.filter(r => r.status === 'artifact-ready').length, busy: race.filter(r => r.code === 'RENDER_BUSY').length }; for (const r of race) await release(r);
  console.log('[concurrency]', JSON.stringify(evidence.stress.concurrency));
  // ── throughput of light tools over stdio ──
  const lat = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); await call(['get_capabilities', 'search_presets', 'validate_project', 'compare_patches'][i % 4], [{}, { query: 'warm' }, { project: projects['ode-to-joy'] }, { a: 'Aurora Pad', b: 'Velvet Dusk' }][i % 4]); lat.push(performance.now() - t); }
  evidence.stress.stdioThroughput = latency(lat); console.log('[stdio throughput ms]', JSON.stringify(evidence.stress.stdioThroughput));
} finally { await main.close(); }
// ── default watchdog (60 s) against the full canon ──
if (!args.includes('--skip-watchdog')) {
  const def = await stdio({ AURORA_RENDER_TIMEOUT_MS: '' });
  try { const t = performance.now(), r = await def.call('render_audio', { project: projects['canon-in-d'], options: { sampleRate: 48000, bitDepth: 24, tailSeconds: 4 } }, { expectError: true, timeout: LONG }); evidence.stress.defaultWatchdog = { code: r.code || r.status, seconds: +((performance.now() - t) / 1000).toFixed(1) }; }
  finally { await def.close(); }
  console.log('[default watchdog]', JSON.stringify(evidence.stress.defaultWatchdog));
}
// ── Cloudflare endpoints ──
async function cloudChecks(url, label, { queue = false, burst = 0 } = {}) {
  const s = await http(url), r = { endpoint: url };
  try {
    r.tools = (await s.client.listTools()).tools.length;
    const v = await s.call('validate_project', { project: projects['canon-in-d'] }, { expectError: true, timeout: 300000 }); r.validateCanon = v.isError ? { error: v.code, message: v.message } : { ok: true, ms: Math.round(s.log.at(-1).ms), jsonBytes: counts(projects['canon-in-d']).jsonBytes };
    const big = await s.call('render_audio', { project: projects['canon-in-d'], options: { sampleRate: 48000, bitDepth: 24, tailSeconds: 4 } }, { expectError: true, timeout: 300000 }); r.render48k24 = { refused: !!big.isError, message: (big.message || '').slice(0, 100) };
    if (queue) { const q = await s.call('render_audio', { project: projects['canon-in-d'], options: { sampleRate: 24000, bitDepth: 16, tailSeconds: 4 } }, { timeout: 300000 }); r.queued = { status: q.status, id: q.id, renderUrl: q.renderUrl }; }
    if (burst) { let ok = 0, limited = 0, other = 0; for (let i = 0; i < burst; i++) { try { await s.client.callTool({ name: 'get_capabilities', arguments: {} }); ok++; } catch (e) { /429|RATE_LIMIT/.test(String(e.message)) ? limited++ : other++; } } r.burst = { requests: burst, ok, rateLimited: limited, other }; }
  } catch (e) { r.error = String(e.message).slice(0, 200); } finally { await s.close(); }
  evidence.stress[label] = r; console.log(`[${label}]`, JSON.stringify(r));
}
if (opt('--cloud')) await cloudChecks(opt('--cloud'), 'cloudLocalWorkerd', { queue: true, burst: 75 });
if (opt('--production')) await cloudChecks(opt('--production'), 'cloudProduction');
await fs.writeFile(path.join(ROOT, 'docs/mcp/evidence/stress-famous.json'), JSON.stringify(evidence, null, 2));
console.log('evidence written: docs/mcp/evidence/stress-famous.json');
