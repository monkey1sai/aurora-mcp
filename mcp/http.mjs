import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServer } from './server.mjs';
import { nodeAdapter, renderTimeoutFromEnv, artifactBudgetFromEnv, ROOT } from './node-adapter.mjs';
import { createRooms } from './rooms.mjs';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.png': 'image/png' };
export async function startHttp({ port = 8788 } = {}) {
  const rooms = createRooms(); let adapter, endpoint, actualPort;
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = async req => { let size = 0, parts = []; for await (const c of req) { size += c.length; if (size > 1500000) throw Object.assign(new Error('Body exceeds budget'), { status: 413 }); parts.push(c); } return JSON.parse(Buffer.concat(parts).toString('utf8')); };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (![ '127.0.0.1:' + actualPort, 'localhost:' + actualPort ].includes(host)) return json(res, 403, { error: 'HOST_REJECTED' });
      const origin = req.headers.origin;
      if (origin && !['http://127.0.0.1:' + actualPort, 'http://localhost:' + actualPort].includes(origin)) return json(res, 403, { error: 'ORIGIN_REJECTED' });
      const url = new URL(req.url, 'http://' + host);
      if (url.pathname === '/mcp') { await endpoint(req, res); return; }
      if (url.pathname === '/health') return json(res, 200, { status: 'ok', mcp: '/mcp', studio: '/studio.html', render: 'node-worker' });
      if (url.pathname.startsWith('/rooms')) {
        if (req.method === 'POST' && url.pathname === '/rooms') return json(res, 201, rooms.enable());
        const m = url.pathname.match(/^\/rooms\/([a-f0-9-]{36})(?:\/(ack|status))?$/);
        if (!m) return json(res, 404, { error: 'NOT_FOUND' });
        if (req.method === 'DELETE') { rooms.disable(m[1]); return json(res, 200, { status: 'disabled' }); }
        if (req.method === 'GET') return json(res, 200, m[2] === 'status' ? rooms.status(m[1], url.searchParams.get('requestId')) : rooms.poll(m[1]));
        if (req.method === 'POST' && m[2] === 'ack') return json(res, 200, rooms.ack(m[1], await body(req)));
        return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      }
      const artifact = url.pathname.match(/^\/artifacts\/([a-f0-9-]{36})\.(wav|json)$/);
      if (artifact) {
        const a = await adapter.readArtifact(artifact[1], artifact[2]); res.writeHead(200, { 'content-type': a.mimeType, 'content-disposition': 'attachment; filename="aurora-' + artifact[1] + '.' + artifact[2] + '"', 'cache-control': 'private, no-store' }); res.end(a.bytes); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
      // Explicit public file allowlist; never serve .git, dependencies, renderer files or artifacts by arbitrary path.
      if (!(rel === 'index.html' || rel === 'studio.html' || rel === 'LICENSE' || /^(src|css)\/[a-zA-Z0-9_./-]+$/.test(rel) || rel === 'tools/phrases.mjs' || rel === 'tools/video/capture/app-hook.js') || rel.split('/').some(s => s === '..' || s.startsWith('.'))) return json(res, 404, { error: 'NOT_FOUND' });
      const file = path.resolve(ROOT, rel); if (!file.startsWith(ROOT + path.sep)) return json(res, 404, { error: 'NOT_FOUND' });
      const data = await fs.readFile(file); res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) { json(res, e.status || (e.code === 'ENOENT' || e.code === 'ARTIFACT_NOT_FOUND' ? 404 : 400), { error: e.code || 'INVALID_ARGUMENT', message: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  const url = 'http://127.0.0.1:' + actualPort; adapter = nodeAdapter({ baseUrl: url, roomManager: rooms, timeoutMs: renderTimeoutFromEnv(), maxBytes: artifactBudgetFromEnv() });
  const handler = createMcpHandler(() => createServer(adapter), { legacy: 'stateless', maxRequestBodySize: 1500000 });
  endpoint = toNodeHandler(handler, { maxRequestBodySize: 1500000 });
  return { url, adapter, rooms, server, async close() { rooms.close(); await adapter.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startHttp({ port: Number(process.env.AURORA_MCP_PORT || 8788) });
  console.error('AURORA MCP ' + app.url + '/mcp · Studio ' + app.url + '/studio.html');
  const close = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
