// Calls every website-parity tool on a running MCP endpoint (local workerd or the deployed Worker).
// Read-only tools only: no render job, no quota-consuming write. Usage: node mcp/verify-parity.mjs <url>/mcp [evidence.json]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const endpoint = process.argv[2]; if (!endpoint) throw new Error('Usage: node mcp/verify-parity.mjs <endpoint> [evidence.json]');
const client = new Client({ name: 'aurora-parity-verify', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
const data = r => { assert.notEqual(r.isError, true, JSON.stringify(r).slice(0, 300)); return r.structuredContent?.data || JSON.parse(r.content[0].text).data; };
const results = [];
const step = async (name, args, check) => { const t = performance.now(), d = data(await client.callTool({ name, arguments: args })); const note = check(d); results.push({ tool: name, ms: Math.round(performance.now() - t), note }); return d; };
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  const cap = data(await client.callTool({ name: 'get_capabilities', arguments: {} }));
  await step('search_presets', { query: 'warm pad' }, d => (assert.ok(d.total > 0), `${d.total} matches`));
  await step('step_preset', { name: 'Aurora Pad', category: 'pad' }, d => d.preset.name);
  const patch = (await step('get_preset', { name: 'Aurora Pad' }, d => d.patch.name)).patch;
  const project = (await step('create_project', { title: 'parity-check', patch }, d => `revision ${d.project.revision}`)).project;
  const file = (await step('export_preset', { project, tags: ['parity'] }, d => (assert.equal(d.preset.format, 'aurora-preset'), d.preset.format))).preset;
  await step('import_preset', { data: file, project }, d => `${d.presets.length} preset, ${d.warnings.length} warnings`);
  const lib = (await step('manage_library', { action: 'save', preset: file, name: 'Parity' }, d => d.saved.key)).library;
  await step('manage_library', { library: lib, action: 'toggle_favourite', name: 'Parity' }, d => `favourite ${d.favourite}`);
  await step('get_parameter_help', { ids: ['filter.cutoff', 'reverb.mix'], project }, d => d.parameters.map(p => p.formatted).join(', '));
  await step('compare_patches', { a: 'Aurora Pad', b: 'Velvet Dusk' }, d => `${d.changed} changed`);
  await step('get_song_info', { id: 'aurora-dreams' }, d => `${d.sections.length} sections`);
  await step('get_tour_info', { id: 'supersaw-pad' }, d => `${d.steps.length} steps`);
  await step('get_catalog', {}, d => (assert.ok(d.details.styleDefaults), `${Object.keys(d.details.presetTags).length} tagged presets`));
  await step('apply_mood', { project, moods: '更暗、再寬一點' }, d => `${d.changes.length} changes`);
  await step('apply_phrase', { project, macroRides: true }, d => `${d.project.tracks[0].events.filter(e => e.type === 'ramp-macro').length} macro ramps`);
  await step('evolve_sound', { project, algorithm: 'website' }, d => `${d.project.tracks[0].events.length} events`);
  await step('morph_patch', { project, preset: 'Velvet Dusk', position: 0.5 }, d => d.project.tracks[0].patch.name);
  await step('generate_jam', { style: 'lofi', variation: 1, backing: { extra: null } }, d => `check ok=${d.check.ok}, ${d.project.tracks.length} tracks`);
  const evidence = { endpoint, era: client.getProtocolEra?.(), render: cap.render, toolCount: tools.length, tools, results, at: new Date().toISOString() };
  if (process.argv[3]) await fs.writeFile(process.argv[3], JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await client.close(); }
