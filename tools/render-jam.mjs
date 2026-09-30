#!/usr/bin/env node
// Offline renderer + checker for the generative Jam (src/demo/generator.js): WAV + spectrogram PNG + metrics JSON.
// Renders exactly what the browser plays: every part through the Ensemble (src/dsp/ensemble.js) and the SafetyBus
// limiter on the sum; endless mode queues successive variations (ens.queue) like the Jam panel does.
//
//   node tools/render-jam.mjs --style lofi [--seed 7] [--key F] [--scale dorian] [--bpm 80] [--bars 8|16]
//        [--intensity 0.7] [--lead "Moonlit Suitcase"] [--role keys] [--pad "<preset>"|none] [--bass …|none]
//        [--extra …|none] [--drums kit|none|"<drum preset>"] [--segments 3] [--out renders/jam] [--no-png] [--json]
//   node tools/render-jam.mjs --all [--seeds 1,2] [--no-png]   # every style × a few lead presets → summary + issues
//   node tools/render-jam.mjs --test                          # determinism + music-theory checks (no audio); exit 1 on failure
//
// Checks (printed as issues): theory (chords diatonic, melody in scale, chord tones on strong beats, no minor-9th
// rubs against the voicing, voice ranges, voice-leading, bass roots, density per bar) and mix (≈ −16 LUFS,
// pre-limiter peak / limiter reduction, lead vs. backing balance, silent parts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeWav } from './wav.mjs';
import { analyze, loudness, spectrogram } from './analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AURORA_ROOT ? path.resolve(process.env.AURORA_ROOT) : path.resolve(HERE, '..');
const modUrl = rel => pathToFileURL(path.join(ROOT, rel)).href;
const dB = x => (x > 1e-12 ? 20 * Math.log10(x) : -240);
const r2 = x => (x == null || !Number.isFinite(x) ? x : Math.round(x * 100) / 100);
const cpuMs = () => { const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; };
const KEYS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

export async function loadJamModules() {
  const [G, presets, ens] = await Promise.all([import(modUrl('src/demo/generator.js')), import(modUrl('src/presets/index.js')), import(modUrl('src/dsp/ensemble.js'))]);
  return { G, PRESETS: presets.PRESETS, Ensemble: ens.Ensemble, SafetyBus: ens.SafetyBus };
}

const asPatch = p => (p ? { name: p.name, category: p.category, tags: p.tags, params: p.params, macros: p.macros } : null);

/**
 * Build the generateJam() options the Jam panel would use: lead = a factory preset (role from its category),
 * backing = suggestBacking() unless overridden ('none' disables a slot).
 */
export function jamOptions(M, o = {}) {
  const { G, PRESETS } = M;
  const find = n => (n ? PRESETS.find(p => p.name === n) || PRESETS.find(p => p.name.toLowerCase() === String(n).toLowerCase()) || PRESETS.find(p => p.name.toLowerCase().includes(String(n).toLowerCase())) : null);
  const style = G.STYLES[o.style] ? o.style : 'ambient';
  const d = G.styleDefaults(style);
  const leadP = find(o.lead) || find('Polaris Sync') || PRESETS[0];
  const role = o.role || G.roleForPreset(leadP);
  const sug = G.suggestBacking(style, PRESETS, { lead: { name: leadP.name, role, patch: leadP } });
  const pick = (v, def) => (v === 'none' ? null : v ? find(v) : def);
  const pad = pick(o.pad, sug.pad), bass = pick(o.bass, sug.bass), extra = pick(o.extra, sug.extra);
  const drums = o.drums === 'none' ? null : !o.drums || o.drums === 'kit' ? true : asPatch(find(o.drums)) || true;
  return {
    style, key: o.key ?? d.key, scale: o.scale || d.scale, bpm: o.bpm || d.bpm, bars: o.bars || d.bars, seed: o.seed ?? 1,
    intensity: o.intensity ?? 0.7, variation: o.variation ?? 0, endless: !!o.endless,
    lead: { patch: asPatch(leadP), role, name: leadP.name, tags: leadP.tags },
    backing: { pad: asPatch(pad), bass: asPatch(bass), extra: extra ? { patch: asPatch(extra), role: G.roleForPreset(extra) } : null, drums },
  };
}

/**
 * Render one or more jam segments (segments > 1 = endless mode: variation 0..n−1, each queued at the loop end).
 * @returns {{L, R, sampleRate, songs, stems:[{name,L,R}], seconds, preLimitPeak, limiterMaxReductionDb, rtf}}
 */
export function renderJam(M, opts, { segments = 1, sampleRate = 48000, tail = 6 } = {}) {
  const { G } = M;
  const sr = sampleRate;
  const songs = [];
  for (let v = 0; v < segments; v++) songs.push(G.generateJam({ ...opts, variation: (opts.variation || 0) + v, endless: segments > 1 || opts.endless, loop: true }));
  const ens = new M.Ensemble(sr, { eager: true, seed: 1 });
  ens.stopHold = tail; ens.maxEndTail = tail;
  ens.load(songs[0]);
  ens.play();
  const bus = new M.SafetyBus(sr);
  bus.engaged = true; bus.reset();
  const segSec = songs.map(s => (s.lengthBeats * 60) / s.bpm);
  const total = segSec.reduce((a, b) => a + b, 0);
  const maxN = Math.ceil((total + tail + ens.stopFade + 1) * sr);
  const L = new Float32Array(maxN), R = new Float32Array(maxN);
  const stemNames = [];
  const stems = [];
  const stemOf = name => { let i = stemNames.indexOf(name); if (i < 0) { i = stemNames.length; stemNames.push(name); stems.push({ name, L: new Float32Array(maxN), R: new Float32Array(maxN) }); } return stems[i]; };
  let pos = 0;
  let cur = 0; // current segment index
  ens.tap = (i, sl, sr2, n, off) => {
    if (i < 0) return;
    const song = songs[cur];
    const p = song && song.parts[i];
    if (!p) return;
    const st = stemOf(p.name);
    for (let k = 0; k < n; k++) { st.L[pos + off + k] += sl[k]; st.R[pos + off + k] += sr2[k]; }
  };
  const B = 128, bl = new Float32Array(B), br = new Float32Array(B);
  let started = false, stopped = false, queued = 0, lastBeat = 0;
  const c0 = cpuMs();
  while (pos < maxN) {
    const n = Math.min(B, maxN - pos);
    bl.fill(0); br.fill(0);
    ens.process(bl, br, n);
    bus.process(bl, br, n);
    L.set(bl.subarray(0, n), pos); R.set(br.subarray(0, n), pos);
    pos += n;
    if (ens.playing) started = true;
    const beat = ens.beat;
    // like the panel: queue the next segment once the current one is half way through
    if (queued === cur && cur + 1 < songs.length && beat > songs[cur].lengthBeats * 0.5) { ens.queue(songs[cur + 1]); queued = cur + 1; }
    if (beat + 1e-6 < lastBeat && cur < queued) cur++; // wrapped → the queued segment took over
    lastBeat = beat;
    if (!stopped && pos >= total * sr) { ens.stop(); stopped = true; }
    if (started && stopped && !ens.active) break;
  }
  const cpu = cpuMs() - c0;
  const thr = 10 ** (-90 / 20);
  let last = 0;
  for (let i = pos - 1; i >= 0; i--) if (Math.abs(L[i]) > thr || Math.abs(R[i]) > thr) { last = i; break; }
  const keep = Math.min(pos, Math.max(Math.ceil(total * sr), last + Math.round(0.25 * sr)));
  return {
    L: L.subarray(0, keep), R: R.subarray(0, keep), sampleRate: sr, songs, seconds: total,
    stems: stems.map(s => ({ name: s.name, L: s.L.subarray(0, keep), R: s.R.subarray(0, keep) })),
    preLimitPeak: bus.inPeak, limiterMaxReductionDb: bus.takeMaxReduction(), rtf: keep / sr / Math.max(1e-6, cpu / 1000),
  };
}

/** Mix metrics + issues for a renderJam() result. */
export function jamMetrics(M, res) {
  const { L, R, sampleRate: sr, songs } = res;
  const playLen = Math.min(L.length, Math.round(res.seconds * sr));
  const mix = analyze(L.subarray(0, playLen), R.subarray(0, playLen), sr);
  const parts = res.stems.map(s => {
    let pk = 0;
    for (let k = 0; k < s.L.length; k++) { const a = Math.abs(s.L[k]), b = Math.abs(s.R[k]); if (a > pk) pk = a; if (b > pk) pk = b; }
    const lu = loudness(s.L.subarray(0, playLen), s.R.subarray(0, playLen), sr);
    const def = songs[0].parts.find(p => p.name === s.name) || {};
    return { name: s.name, zh: def.zh, role: def.role, slot: def.slot, preset: def.presetName || def.kit || null, gainDb: def.gain, lufs: r2(lu.integrated), peakDb: r2(dB(pk)) };
  });
  const theory = songs.map(s => M.G.checkJam(s));
  const issues = [];
  theory.forEach((t, i) => t.issues.slice(0, 6).forEach(x => issues.push(`[theory v${i}] ${x}`)));
  if (mix.nanCount || mix.infCount) issues.push(`NaN/Inf ${mix.nanCount + mix.infCount}`);
  if (mix.lufs == null || mix.lufs < -19.5) issues.push(`quiet mix (${mix.lufs} LUFS, target ≈ −16)`);
  if (mix.lufs > -12.5) issues.push(`loud mix (${mix.lufs} LUFS, target ≈ −16)`);
  // same rule as the demo songs (docs/SONGS.md): the SafetyBus is a safety net and should stay above −1 dB
  if (res.limiterMaxReductionDb < -1) issues.push(`safety limiter pulls ${r2(-res.limiterMaxReductionDb)} dB (pre-limit peak ${r2(dB(res.preLimitPeak))} dBFS)`);
  if (mix.peak > 0.9661) issues.push(`peak ${mix.peakDb} dBFS above the ceiling`);
  const lead = parts.find(p => p.name === 'Lead');
  for (const p of parts) if (p.lufs == null || p.lufs < -60) issues.push(`part "${p.name}" silent`);
  if (lead && lead.lufs != null) {
    const melodic = parts.filter(p => p !== lead && p.role !== 'drums' && p.lufs != null);
    for (const p of melodic) if (p.lufs > lead.lufs + 3) issues.push(`"${p.name}" (${p.lufs}) louder than the lead (${lead.lufs}) by > 3 dB`);
    if (lead.role !== 'bass' && lead.role !== 'drums' && lead.lufs < mix.lufs - 9) issues.push(`lead buried (${lead.lufs} LUFS vs mix ${mix.lufs})`);
  }
  const bass = parts.find(p => p.slot === 'bass');
  if (bass && bass.lufs != null && mix.lufs != null && bass.lufs < mix.lufs - 14) issues.push(`bass too quiet (${bass.lufs})`);
  // per-section loudness (first segment): the arc should build
  const s0 = songs[0];
  const spb = 60 / s0.bpm;
  const sections = (s0.sections || []).map(sec => {
    const a = Math.round(sec.beat * spb * sr), b = Math.min(playLen, Math.round((sec.beat + sec.beats) * spb * sr));
    const lu = b - a > sr * 0.5 ? loudness(L.subarray(a, b), R.subarray(a, b), sr) : { integrated: null };
    return { name: sec.name, zh: sec.zh, beat: sec.beat, energy: sec.energy, lufs: r2(lu.integrated) };
  });
  return {
    mix: { lufs: mix.lufs, peakDb: mix.peakDb, truePeakDb: mix.truePeakDb, crestDb: mix.crestDb, centroidHz: mix.centroidHz, bands: mix.bands, width: mix.width, correlation: mix.correlation, lra: mix.lra },
    preLimitPeakDb: r2(dB(res.preLimitPeak)), limiterMaxReductionDb: r2(res.limiterMaxReductionDb), rtf: r2(res.rtf),
    parts, sections, theory: theory.map(t => t.stats), issues,
  };
}

function markersFor(songs) {
  const out = [];
  let t0 = 0;
  songs.forEach((s, v) => {
    const spb = 60 / s.bpm;
    for (const sec of s.sections || []) out.push({ t: t0 + sec.beat * spb, label: `${songs.length > 1 ? `v${v} ` : ''}${sec.name}` });
    t0 += s.lengthBeats * spb;
  });
  return out;
}

export async function renderJamToFiles(M, o, { segments = 1, out, png = true, json = false } = {}) {
  const opts = jamOptions(M, o);
  const res = renderJam(M, opts, { segments });
  const m = jamMetrics(M, res);
  const s0 = res.songs[0];
  const name = `${opts.style}-${opts.lead.name}-s${opts.seed}${segments > 1 ? `-x${segments}` : ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const summary = {
    jam: { style: opts.style, key: s0.meta.keyName, keyEn: s0.meta.keyNameEn, bpm: s0.bpm, bars: s0.meta.bars, seed: opts.seed, segments, lead: opts.lead.name, leadRole: opts.lead.role, leadPlays: s0.meta.leadPlays,
      chords: s0.meta.chords.map(c => c.symbol).join(' '), progression: s0.meta.progression, rides: s0.meta.rides.map(r => `${r.name} ${r.base}→${r.peak}`), dropped: s0.meta.dropped },
    parts: s0.parts.map(p => ({ name: p.name, preset: p.presetName || p.kit || null, role: p.role, gain: p.gain, notes: p.events.filter(e => e.type === 'on').length })),
    metrics: m,
  };
  if (json) return summary;
  const dir = path.resolve(out || path.join(ROOT, 'renders', 'jam'));
  fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, `${name}.wav`), [res.L, res.R], res.sampleRate, { bitDepth: 16 });
  if (png) fs.writeFileSync(path.join(dir, `${name}.png`), spectrogram(res.L, res.R, res.sampleRate, { title: `jam · ${opts.style} · ${s0.meta.keyNameEn} · ${s0.bpm} bpm · lead ${opts.lead.name}`, subtitle: summary.jam.chords, markers: markersFor(res.songs), width: 1600, height: 520 }));
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(summary, null, 1));
  summary.files = { wav: path.join(dir, `${name}.wav`), png: png ? path.join(dir, `${name}.png`) : null };
  return summary;
}

// ───────────────────────── --test: determinism + theory for every style ─────────────────────────
export async function runTests(M, log = console.log) {
  const { G, PRESETS } = M;
  let fails = 0, checks = 0;
  const fail = msg => { fails++; if (fails <= 40) log(`  FAIL ${msg}`); };
  const leadFor = { lead: 'Polaris Sync', keys: 'Moonlit Suitcase', pad: 'Aurora Pad', bass: 'Deep Bass', pluck: 'Jade Guzheng', bell: 'Celestial Carillon', arp: 'Borealis Sequencer', strings: 'Aurora Symphony', fx: 'Nebula Drift', drum: 'Membrane Kit' };
  const byName = n => PRESETS.find(p => p.name === n) || PRESETS.find(p => p.category === Object.keys(leadFor).find(k => leadFor[k] === n)) || PRESETS[0];
  for (const style of G.STYLE_IDS) {
    let n = 0;
    const t0 = performance.now();
    for (const role of Object.keys(leadFor)) {
      const lp = byName(leadFor[role]);
      for (const scale of G.JAM_SCALE_IDS) {
        for (const seed of [1, 7, 12345]) {
          for (const variation of [0, 1, 2, 3]) {
            const o = jamOptions(M, { style, lead: lp.name, role, scale, seed, key: (seed + variation * 5) % 12, bars: seed === 7 ? 16 : 8, variation, endless: variation > 0, intensity: [0.2, 0.7, 1][seed % 3] });
            const a = G.generateJam(o);
            const c = G.checkJam(a);
            checks++; n++;
            if (!c.ok) fail(`${style}/${role}/${scale}/seed ${seed}/v${variation}: ${c.issues.slice(0, 3).join('; ')}`);
            if (a.parts.length > G.MAX_PARTS) fail(`${style}/${role}: ${a.parts.length} parts > ${G.MAX_PARTS}`);
            if (a.parts[0].name !== 'Lead') fail(`${style}/${role}: part 0 is not the lead`);
            if (variation === 0 && scale === 'major' && seed === 1) {
              const b = G.generateJam(o);
              checks++;
              if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${style}/${role}: not deterministic`);
              const c2 = G.generateJam({ ...o, seed: 2 });
              checks++;
              if (JSON.stringify(c2.parts[0].events) === JSON.stringify(a.parts[0].events) && a.parts[0].events.length > 8) fail(`${style}/${role}: seed does not change the lead`);
            }
          }
        }
      }
    }
    // endless coherence: variations share the progression family and the theme (motif A rhythm)
    const o = jamOptions(M, { style, lead: 'Polaris Sync', seed: 99 });
    const vs = [0, 1, 2, 3].map(v => G.generateJam({ ...o, variation: v, endless: true }));
    checks++;
    if (new Set(vs.map(v => v.meta.progression.a)).size !== 1) fail(`${style}: endless variations change the main progression`);
    const firstBar = v => (v.meta.melody || []).filter(m => m.beat < 4).map(m => m.beat).join(',');
    checks++;
    if (firstBar(vs[0]) !== firstBar(vs[1]) && firstBar(vs[1])) fail(`${style}: theme rhythm differs between variation 0 and 1 (${firstBar(vs[0])} vs ${firstBar(vs[1])})`);
    checks++;
    if (JSON.stringify(vs[0].parts[0].events) === JSON.stringify(vs[1].parts[0].events)) fail(`${style}: variation 1 identical to variation 0`);
    // durations & loop sanity for the ensemble
    for (const v of vs) for (const p of v.parts) for (const e of p.events) if (e.type === 'on' && e.beat + e.dur > v.lengthBeats + 1e-6) fail(`${style}: note past the segment end`);
    log(`  ${style.padEnd(11)} ${n} jams checked in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  log(`${fails ? 'FAIL' : 'PASS'} jam generator: ${checks} checks, ${fails} failures`);
  return fails;
}

// ───────────────────────── CLI ─────────────────────────
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else { o[k] = next; i++; }
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help || a.h) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const M = await loadJamModules();
  if (a.test) return (await runTests(M)) ? 1 : 0;
  const num = (v, d) => (v === undefined || v === true ? d : Number(v));
  const key = a.key === undefined ? undefined : KEYS[a.key] ?? Number(a.key);
  const base = {
    style: a.style || 'ambient', seed: num(a.seed, 1), key, scale: a.scale, bpm: a.bpm ? Number(a.bpm) : undefined, bars: a.bars ? Number(a.bars) : undefined,
    intensity: num(a.intensity, 0.7), lead: a.lead, role: a.role, pad: a.pad, bass: a.bass, extra: a.extra, drums: a.drums,
  };
  const png = !a['no-png'];
  const segments = Math.max(1, num(a.segments, 1));
  const runs = [];
  if (a.all) {
    const leads = { ambient: ['Aurora Pad', 'Starlight Harp', 'Meadow Whistle'], lofi: ['Moonlit Suitcase', 'Cassette Bloom', 'Walnut Upright'], synthwave: ['Polaris Sync', 'Midnight Freeway', "String Machine '79"],
      house: ['Prism Shards', 'Warehouse Organ', 'Velvet Dub Stabs'], cinematic: ['Aurora Symphony', 'Horizon Throw', 'Celestial Carillon'], pentatonic: ['Jade Guzheng', 'Bamboo Dizi', 'Paper Lantern Echoes'],
      chiptune: ['Cartridge Hero', 'Pixel Quest', 'Deep Bass'] };
    const seeds = String(a.seeds || '1').split(',').map(Number);
    for (const style of Object.keys(leads)) for (const lead of leads[style]) for (const seed of seeds) runs.push({ ...base, style, lead, seed });
  } else runs.push(base);
  let bad = 0;
  for (const r of runs) {
    const t0 = performance.now();
    const s = await renderJamToFiles(M, r, { segments, out: a.out, png, json: !!a.json });
    if (a.json && runs.length === 1) { console.log(JSON.stringify(s, null, 1)); return 0; }
    const m = s.metrics;
    const partStr = m.parts.map(p => `${p.name}${p.preset ? `(${p.preset})` : ''} ${p.lufs}`).join(' · ');
    console.log(`${s.jam.style.padEnd(10)} ${String(s.jam.lead).padEnd(20)} ${s.jam.key.padEnd(10)} ${s.jam.bpm}bpm  LUFS ${m.mix.lufs}  peak ${m.mix.peakDb}  pre ${m.preLimitPeakDb} lim ${m.limiterMaxReductionDb}  cent ${m.mix.centroidHz}  width ${m.mix.width}  ${(performance.now() - t0).toFixed(0)}ms`);
    console.log(`           ${s.jam.chords}  | ${s.jam.leadPlays} | rides: ${s.jam.rides.join(', ') || '—'}`);
    console.log(`           ${partStr}`);
    console.log(`           sections: ${m.sections.map(x => `${x.name} ${x.lufs}`).join(' → ')}  | theory: ${m.theory.map(t => `strong ${t.strongChordTonePct}% vl ${t.avgVoiceMove} bass ${t.bassRootPct == null ? 'n/a' : t.bassRootPct + '%'}`).join(' ; ')}`);
    if (m.issues.length) { bad++; console.log(`           ISSUES: ${m.issues.join(' | ')}`); }
    if (s.files) console.log(`           → ${s.files.png || s.files.wav}`);
  }
  return bad && a.strict ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
}
