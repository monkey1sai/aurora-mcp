import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from './server.mjs';
import { validateProject, LIMITS } from '../src/creation/project.js';
import { renderPlan } from '../src/creation/render.js';
const UUID = /^[a-f0-9-]{36}$/;
const CHUNK = 65536, TTL = 3600000;
// Body aggregation plus SHA-256 must fit the Worker memory budget.
const CLOUD_BYTES = 32000000;
const DAILY_REQUESTS = 5000, DAILY_JOBS = 20, DAILY_AUDIO_BYTES = 100000000;
async function budget(env, bytes) {
  const response = await env.BUDGET.get(env.BUDGET.idFromName('daily')).fetch('https://budget/allow', { method:'POST', body:JSON.stringify(bytes === undefined ? {} : {bytes}) });
  return response.ok;
}
function cloudPlan(project, options) { const plan = renderPlan(project, options); if (plan.bytes > CLOUD_BYTES) throw new Error('CLOUD_OUTPUT_LIMIT: choose 24000 Hz, 16-bit or a shorter project; cloud upload limit is 32 MB'); return plan; }
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const stub = (env, id) => env.JOBS.get(env.JOBS.idFromName(id));
async function boundedBody(request, maximum) {
  const announced = Number(request.headers.get('content-length')); if (announced > maximum) throw new Error('Request exceeds byte budget');
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const parts = []; let size = 0, timer;
  const timeout = new Promise((_,reject)=>{timer=setTimeout(()=>{reader.cancel().catch(()=>{});reject(new Error('UPLOAD_TIMEOUT: body exceeded 30 seconds'));},30000);});
  try { for (;;) { const { value, done } = await Promise.race([reader.read(),timeout]); if (done) break; size += value.length; if (size > maximum) { await reader.cancel(); throw new Error('Request exceeds byte budget'); } parts.push(value); } } finally { clearTimeout(timer); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Same-origin website requests or non-browser MCP clients. Never accept a foreign web Origin.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'ORIGIN_REJECTED' }, 403);
    if (url.pathname === '/health') return json({ status: 'ok', mcp: '/mcp', render: 'browser-worker', protocol: ['2026-07-28', 'legacy-stateless'] });
    if (url.pathname === '/rooms' || url.pathname.startsWith('/rooms/')) return json({ error: 'BROWSER_CONTROL_LOCAL_ONLY', message: 'Live control uses the loopback Node server. This public endpoint cannot control another visitor.' }, 403);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/jobs/')) {
      if (!env.LIMITER || !env.BUDGET) return json({ error: 'LIMITER_AND_BUDGET_REQUIRED' }, 503);
      const limit = await env.LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
      if (!limit.success) return json({ error: 'RATE_LIMIT' }, 429);
      if (!await budget(env)) return json({error:'DAILY_REQUEST_BUDGET',message:'Public daily request quota reached; use local MCP or retry tomorrow UTC.'},429);
    }
    if (url.pathname === '/mcp') {
      const adapter = {
        renderMode: 'browser-worker: user opens renderUrl, renders and uploads public expiring WAV',
        renderLimits: { ...LIMITS, outputBytes: CLOUD_BYTES, dailyRequests:DAILY_REQUESTS, dailyJobs:DAILY_JOBS, dailyAudioBytes:DAILY_AUDIO_BYTES },
        async render(project, options) {
          validateProject(project); const plan = cloudPlan(project, options), id = crypto.randomUUID();
          if (!await budget(env,plan.bytes)) throw new Error('DAILY_RENDER_BUDGET: public daily render quota reached; use local MCP or retry tomorrow UTC');
          const response = await stub(env, id).fetch('https://job/create', { method: 'POST', body: JSON.stringify({ id, project, options, plan, origin: url.origin }) });
          if (!response.ok) throw new Error('Could not create render job');
          return { id, status: 'queued', renderer: 'user-browser', requiresUserAction: true, renderUrl: url.origin + '/studio.html?job=' + id, resultTool: 'get_render_result', expiresAt: Date.now() + TTL, privacy: 'Unlisted public links; do not upload private material. Job expires after one hour.' };
        },
        async result(id) { if (!UUID.test(id)) throw new Error('Invalid job ID'); const r = await stub(env, id).fetch('https://job/status'); const value = await r.json(); if (!r.ok) throw new Error(value.error); return value; },
      };
      return createMcpHandler(() => createServer(adapter), { legacy: 'stateless', maxRequestBodySize: LIMITS.jsonBytes }).fetch(request);
    }
    const m = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(?:\/(audio|project))?$/);
    if (m) {
      const suffix = m[2] === 'audio' ? '/audio' : m[2] === 'project' ? '/project' : '/project';
      return stub(env, m[1]).fetch(new Request('https://job' + suffix, request));
    }
    return env.ASSETS.fetch(request);
  },
};
export class RenderJob {
  constructor(state) { this.state = state; this.uploading = false; }
  async fetch(request) {
    // Claim before the first await: concurrent PUTs cannot overwrite a completed artifact.
    if (new URL(request.url).pathname === '/audio' && request.method === 'PUT') {
      if (this.uploading) return json({ error: 'UPLOAD_BUSY' }, 409);
      this.uploading = true;
      try { return await this.handle(request); } finally { this.uploading = false; }
    }
    return this.handle(request);
  }
  async handle(request) {
    const storage = this.state.storage, url = new URL(request.url);
    try {
      if (url.pathname === '/create' && request.method === 'POST') {
        if (await storage.get('job')) return json({ error: 'ALREADY_CREATED' }, 409);
        const raw = await boundedBody(request, LIMITS.jsonBytes + 2000), value = JSON.parse(new TextDecoder().decode(raw));
        validateProject(value.project); value.plan = cloudPlan(value.project, value.options); value.expiresAt = Date.now() + TTL; value.status = 'queued';
        // A single SQLite storage value is bounded; split larger project JSON.
        const encoded = new TextEncoder().encode(JSON.stringify(value.project));
        const chunks = Math.ceil(encoded.length / CHUNK);
        for (let i = 0; i < chunks; i++) await storage.put('p' + i, encoded.slice(i * CHUNK, (i + 1) * CHUNK));
        delete value.project; value.projectChunks = chunks; value.projectBytes = encoded.length;
        await storage.put('job', value); await storage.setAlarm(value.expiresAt); return json({ status: 'queued' }, 201);
      }
      const job = await storage.get('job');
      if (!job || job.expiresAt < Date.now()) return json({ error: 'JOB_EXPIRED_OR_MISSING' }, 404);
      if (url.pathname === '/status') return json({ status: job.status, expiresAt: job.expiresAt, renderer: 'user-browser', ...(job.status === 'artifact-ready' ? { downloadUrl: job.origin + '/jobs/' + job.id + '/audio', metrics: job.metrics, sha256: job.sha256, bytes: job.audioBytes } : { requiresUserAction: true }) });
      if (url.pathname === '/project') {
        const encoded = new Uint8Array(job.projectBytes); for (let i = 0; i < job.projectChunks; i++) encoded.set(await storage.get('p' + i), i * CHUNK);
        return json({ project: JSON.parse(new TextDecoder().decode(encoded)), options: job.options, status: job.status, expiresAt: job.expiresAt });
      }
      if (url.pathname === '/audio' && request.method === 'PUT') {
        if (job.status === 'artifact-ready') return json({ error: 'ALREADY_RENDERED' }, 409);
        const bytes = await boundedBody(request, CLOUD_BYTES);
        const v = new DataView(bytes.buffer); const tag = (o, s) => s.split('').every((c, i) => bytes[o + i] === c.charCodeAt(0));
        if (bytes.length !== job.plan.bytes || !tag(0,'RIFF') || !tag(8,'WAVE') || !tag(12,'fmt ') || !tag(36,'data') || v.getUint16(20,true)!==1 || v.getUint16(22,true)!==2 || v.getUint32(24,true)!==job.plan.sampleRate || v.getUint16(34,true)!==job.plan.bitDepth || v.getUint32(40,true)!==bytes.length-44) return json({ error: 'INVALID_WAV' }, 400);
        const metadata = request.headers.get('x-aurora-metrics') || ''; if (metadata.length > 5000) return json({ error:'INVALID_METRICS' },400);
        const metrics = metadata ? JSON.parse(atob(metadata)) : {};
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
        if(job.expiresAt<=Date.now())return json({error:'JOB_EXPIRED_OR_MISSING'},404);
        const chunks = Math.ceil(bytes.length / CHUNK);
        await storage.transaction(async tx=>{
          const current=await tx.get('job');if(!current||current.expiresAt<=Date.now())throw new Error('JOB_EXPIRED_OR_MISSING');
          if(current.status==='artifact-ready')throw new Error('ALREADY_RENDERED');
          for (let i=0;i<chunks;i++) await tx.put('a'+i,bytes.slice(i*CHUNK,(i+1)*CHUNK));
          await tx.put('job',{...job,status:'artifact-ready',audioBytes:bytes.length,audioChunks:chunks,sha256,metrics:{...metrics,source:'user-browser; metadata is client-reported',verifiedWav:{sampleRate:job.plan.sampleRate,bitDepth:job.plan.bitDepth,frames:job.plan.frames}}});
          await tx.setAlarm(job.expiresAt);
        });
        return json({status:'artifact-ready',sha256});
      }
      if (url.pathname === '/audio' && request.method === 'GET') {
        if (job.status !== 'artifact-ready') return json({ error:'AUDIO_NOT_READY' },409);
        let i=0; const stream=new ReadableStream({async pull(controller){if(i>=job.audioChunks){controller.close();return;}controller.enqueue(await storage.get('a'+i++));}});
        return new Response(stream,{headers:{'content-type':'audio/wav','content-disposition':'attachment; filename="aurora.wav"','cache-control':'no-store','x-content-type-options':'nosniff','content-length':String(job.audioBytes)}});
      }
      return json({error:'METHOD_NOT_ALLOWED'},405);
    } catch(e) { return json({error:e.message==='JOB_EXPIRED_OR_MISSING'?'JOB_EXPIRED_OR_MISSING':'INVALID_ARGUMENT',message:e.message},e.message==='JOB_EXPIRED_OR_MISSING'?404:400); }
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
// Serialized reservations bound anonymous writes. Failed jobs retain their
// reservation until the next UTC day, preventing retry-based quota bypass.
export class AdmissionBudget {
  constructor(state) { this.state=state; }
  async fetch(request) {
    const input=await request.json(), day=new Date().toISOString().slice(0,10);
    if(input.bytes!==undefined && (!Number.isSafeInteger(input.bytes)||input.bytes<44||input.bytes>CLOUD_BYTES))return json({error:'INVALID_RESERVATION'},400);
    return this.state.storage.transaction(async tx=>{
      let counter=await tx.get('counter');if(counter?.day!==day)counter={day,requests:0,jobs:0,bytes:0};
      if(input.bytes===undefined){if(counter.requests>=DAILY_REQUESTS)return json({error:'REQUEST_BUDGET'},429);counter.requests++;}
      else{if(counter.jobs>=DAILY_JOBS||counter.bytes+input.bytes>DAILY_AUDIO_BYTES)return json({error:'RENDER_BUDGET'},429);counter.jobs++;counter.bytes+=input.bytes;}
      await tx.put('counter',counter);return json({status:'reserved'});
    });
  }
}
