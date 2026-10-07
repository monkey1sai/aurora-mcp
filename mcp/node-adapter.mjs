import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { ResourceTemplate } from '@modelcontextprotocol/server';
import { fail, validateProject } from '../src/creation/project.js';
import { renderPlan } from '../src/creation/render.js';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'renders', 'mcp');
const TTL = 3600000;
/** Render watchdog from AURORA_RENDER_TIMEOUT_MS (1 s – 30 min); default 60 s. A full 180 s, 8-track project can need several minutes. */
export function renderTimeoutFromEnv(env = process.env) {
  const raw = env.AURORA_RENDER_TIMEOUT_MS; if (raw === undefined || raw === '') return 60000;
  const ms = Number(raw); if (!Number.isInteger(ms) || ms < 1000 || ms > 1800000) throw new Error('AURORA_RENDER_TIMEOUT_MS must be an integer from 1000 to 1800000');
  return ms;
}
/** One-hour artifact budget (WAV + project JSON in renders/mcp) from AURORA_ARTIFACT_BUDGET_BYTES (60 MB – 10 GB); default 100 MB. One 180 s 48 kHz 24-bit WAV is ≈ 51.8 MB. */
export function artifactBudgetFromEnv(env = process.env) {
  const raw = env.AURORA_ARTIFACT_BUDGET_BYTES; if (raw === undefined || raw === '') return 100000000;
  const bytes = Number(raw); if (!Number.isSafeInteger(bytes) || bytes < 60000000 || bytes > 10000000000) throw new Error('AURORA_ARTIFACT_BUDGET_BYTES must be an integer from 60000000 to 10000000000');
  return bytes;
}
export function nodeAdapter({ baseUrl = '', timeoutMs = 60000, concurrency = 1, roomManager, maxBytes = 100000000 } = {}) {
  const artifacts = new Map(), active = new Set(); let diskBytes = 0, rendering = 0, closed = false;
  const purge = async () => {
    for (const [id, a] of artifacts) if (a.expiresAt < Date.now()) artifacts.delete(id);
    diskBytes = 0;
    // Only UUID artifacts created by this adapter are eligible for TTL cleanup.
    for (const name of await fs.readdir(OUT).catch(e => { if(e.code==='ENOENT')return [];throw e; })) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(wav|json)$/.test(name)) continue;
      const file = path.join(OUT,name), stat = await fs.stat(file).catch(()=>null); if(!stat)continue;
      if(stat.mtimeMs + TTL < Date.now())await fs.unlink(file).catch(()=>{});else diskBytes += stat.size;
    }
  };
  const cleanupTimer = setInterval(() => { purge().catch(()=>{}); }, 60000); cleanupTimer.unref();
  const resolve = async id => { await purge(); const a = artifacts.get(id); if (!a) fail('ARTIFACT_NOT_FOUND', 'Artifact is missing, expired or belongs to another process'); return a; };
  const adapters = {
    renderMode: 'node-worker',
    async render(project, options, ctx = {}) {
      validateProject(project); const plan = renderPlan(project, options); await purge();
      if (closed) fail('SHUTTING_DOWN', 'Renderer closed');
      if (rendering >= concurrency) fail('RENDER_BUSY', 'Renderer concurrency limit reached; retry after the current job');
      const projectBytes = Buffer.byteLength(JSON.stringify({ project, options }));
      if (diskBytes + plan.bytes + projectBytes + 10000 > maxBytes) fail('STORAGE_LIMIT', 'Artifact budget reached (' + Math.round(maxBytes / 1e6) + ' MB per hour); wait for one-hour expiration or raise AURORA_ARTIFACT_BUDGET_BYTES');
      const signal = ctx.signal;
      if (signal?.aborted) fail('CANCELLED', 'Render cancelled');
      rendering++;
      try {
      const w = new Worker(new URL('./render-worker.mjs', import.meta.url), { workerData: { project, options }, resourceLimits: { maxOldGenerationSizeMb: 256 } }); active.add(w);
      let result;
      try {
        result = await new Promise((res, rej) => {
          let settled = false;
          const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? rej(error) : res(value); };
          const abort = () => { w.terminate(); finish(Object.assign(new Error('Render cancelled'), { code: 'CANCELLED' })); };
          const timer = setTimeout(() => { w.terminate(); finish(Object.assign(new Error('Render exceeded wall-clock budget'), { code: 'RENDER_TIMEOUT' })); }, timeoutMs);
          signal?.addEventListener('abort', abort, { once: true });
          w.once('message', value => value.error ? finish(Object.assign(new Error(value.error.message), { code: value.error.code })) : finish(null, value));
          w.once('error', error => finish(error)); w.once('exit', code => { if (!settled) finish(Object.assign(new Error('Render worker exited: ' + code), { code: 'RENDER_FAILED' })); });
        });
      } finally { await w.terminate(); active.delete(w); }
      const id = randomUUID(), bytes = Buffer.from(result.wav), hash = createHash('sha256').update(bytes).digest('hex');
      await fs.mkdir(OUT, { recursive: true });
      const wavPath = path.join(OUT, id + '.wav'), projectPath = path.join(OUT, id + '.json');
      try {
        await fs.writeFile(wavPath, bytes, { flag: 'wx' });
        await fs.writeFile(projectPath, JSON.stringify({ project, options, metrics: result.metrics, wavSha256: hash }), { flag: 'wx' });
      } catch(e) { await fs.unlink(wavPath).catch(()=>{}); await fs.unlink(projectPath).catch(()=>{}); throw e; }
      const expiresAt = Date.now() + TTL;
      const a = { id, status: 'artifact-ready', bytes: bytes.length, hash, expiresAt, metrics: result.metrics, wavPath, projectPath, resourceUri: 'aurora://artifacts/' + id + '/wav', ...(baseUrl ? { downloadUrl: baseUrl + '/artifacts/' + id + '.wav', projectUrl: baseUrl + '/artifacts/' + id + '.json' } : {}) };
      artifacts.set(id, a); return a;
      } finally { rendering--; }
    },
    async result(id) { return resolve(id); },
    async readArtifact(id, extension) { const a = await resolve(id); return { bytes: await fs.readFile(extension === 'wav' ? a.wavPath : a.projectPath), mimeType: extension === 'wav' ? 'audio/wav' : 'application/json' }; },
    registerResources(server) {
      server.registerResource('rendered-audio', new ResourceTemplate('aurora://artifacts/{id}/{format}', { list: undefined }), { description: 'Rendered WAV or project JSON; process-owned, expires in one hour.' }, async (uri, variables) => {
        const id = String(variables.id), format = String(variables.format);
        if (!['wav', 'json'].includes(format)) fail('NOT_FOUND', 'Format must be wav or json');
        const a = await adapters.readArtifact(id, format);
        return { contents: [{ uri: uri.href, mimeType: a.mimeType, ...(format === 'wav' ? { blob: a.bytes.toString('base64') } : { text: a.bytes.toString('utf8') }) }] };
      });
    },
    ...(roomManager ? { browserCommand: a => roomManager.command(a) } : {}),
    async close() { closed = true; clearInterval(cleanupTimer); await Promise.all([...active].map(w => w.terminate())); active.clear(); },
  };
  return adapters;
}
