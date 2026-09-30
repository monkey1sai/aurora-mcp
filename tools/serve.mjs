#!/usr/bin/env node
// Zero-dependency static dev server for AURORA.
//   npm start                → http://localhost:5173
//   PORT=8080 npm start      → custom port
//   npm run lan              → https on all interfaces (= --lan): try it on a phone / tablet on your LAN
//   HTTPS=1 npm start        → https on localhost only (= --https)
//   HOST=0.0.0.0 npm start   → plain http on all interfaces. NOTE: phones/tablets get NO SOUND this way —
//                              browsers only allow AudioWorklet in a secure context (https or localhost).
//
// HTTPS certificate: CERT_FILE + KEY_FILE when set, else .cert/cert.pem + .cert/key.pem when present (e.g. made
// with mkcert — no browser warning once its root CA is installed on the phone), else an auto-generated self-signed
// certificate for localhost + this machine's LAN addresses (.cert/selfsigned-*.pem; the browser asks once to
// accept it). .cert/ is a dot-dir, so it is never served. In https mode plain http:// requests on the same
// port are redirected to https:// (people usually type 192.168.x.x:5173 without the scheme).
//
// Serves the project root with correct MIME types (ES modules, wasm, audio, fonts), no caching,
// index.html at directories, simple Range support (audio seeking), directory listings for folders
// without an index (handy for renders/), and path-traversal protection.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSelfSignedCert } from './selfsigned.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const LAN = ARGS.includes('--lan');
const HTTPS = LAN || ARGS.includes('--https') || /^(1|true|yes|on)$/i.test(process.env.HTTPS || '');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : null);
const QUIET = ARGS.includes('--quiet') || process.env.QUIET === '1';
const CERT_DIR = path.join(ROOT, '.cert');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.webm': 'audio/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mid': 'audio/midi', '.midi': 'audio/midi',
};
const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;padding:32px 16px;background:#07080d;color:#e8ecff;font:15px/1.6 Inter,"Noto Sans TC",system-ui,sans-serif}
main{max-width:760px;margin:auto}h1{font-size:22px;margin:0 0 12px}a{color:#5cf2ff;text-decoration:none}a:hover{text-decoration:underline}
p{color:#8e97b8}ul{list-style:none;padding:0}li{padding:4px 0;border-bottom:1px solid rgba(140,160,220,.14);font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px}
code{color:#a78bfa}</style></head><body><main>${body}</main></body></html>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function log(req, status, extra = '') {
  if (QUIET) return;
  const color = status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
  process.stdout.write(`\x1b[2m${new Date().toTimeString().slice(0, 8)}\x1b[0m \x1b[${color}m${status}\x1b[0m ${req.method} ${req.url}${extra}\n`);
}

/** Map a URL path to an absolute file path inside ROOT, or null if it escapes ROOT / is malformed. */
export function resolveSafe(urlPath, root = ROOT) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (p.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + p.replace(/\\/g, '/')));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Never serve dot-files/dirs such as .git or .claude.
  if (rel.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.')) return null;
  return abs;
}

function listing(req, res, dir, urlPath) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const base = urlPath.endsWith('/') ? urlPath : urlPath + '/';
  const items = entries.map(e => `<li><a href="${esc(base + encodeURIComponent(e.name) + (e.isDirectory() ? '/' : ''))}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`);
  const up = base !== '/' ? `<li><a href="${esc(path.posix.dirname(base.slice(0, -1)) + '/')}">../</a></li>` : '';
  send(res, 200, page(`Index of ${urlPath}`, `<h1>Index of <code>${esc(decodeURIComponent(base))}</code></h1><ul>${up}${items.join('')}</ul>`));
  log(req, 200, ' (listing)');
}

function serveFile(req, res, file, stat) {
  const type = mimeOf(file);
  const headers = {
    'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Last-Modified': stat.mtime.toUTCString(),
  };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && stat.size > 0) {
    let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? stat.size - 1 : Number(range[2]);
    start = Math.max(0, start); end = Math.min(stat.size - 1, end);
    if (start > end || Number.isNaN(start)) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-store' });
      res.end(); log(req, 416); return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); log(req, 206); return; }
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    log(req, 206);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') { res.end(); log(req, 200); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  log(req, 200);
}

export function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, page('405', '<h1>405 Method Not Allowed</h1>'), undefined, { Allow: 'GET, HEAD' });
    log(req, 405);
    return;
  }
  const urlPath = (req.url || '/').split('?')[0];
  const file = resolveSafe(urlPath);
  if (!file) {
    send(res, 403, page('403', '<h1>403 Forbidden</h1><p>Path outside the project root.</p>'));
    log(req, 403);
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || (!stat.isFile() && !stat.isDirectory())) {
      if (urlPath === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); log(req, 204); return; }
      send(res, 404, page('404', `<h1>404 Not Found</h1><p><code>${esc(urlPath)}</code> does not exist.</p><p><a href="/">← AURORA</a></p>`));
      log(req, 404);
      return;
    }
    if (stat.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(301, { Location: urlPath + '/', 'Cache-Control': 'no-store' });
        res.end(); log(req, 301); return;
      }
      const index = path.join(file, 'index.html');
      fs.stat(index, (e2, st2) => {
        if (!e2 && st2.isFile()) serveFile(req, res, index, st2);
        else listing(req, res, file, urlPath);
      });
      return;
    }
    serveFile(req, res, file, stat);
  });
}

/** Non-internal IPv4 addresses of this machine (what a phone on the same Wi-Fi can reach). */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && (a.family === 'IPv4' || a.family === 4)) out.push(a.address);
  }
  return [...new Set(out)];
}

/**
 * Key + certificate for https: user-provided (.cert/cert.pem + key.pem, or CERT_FILE / KEY_FILE) first,
 * else a cached self-signed one that is regenerated when it expires or misses one of `hosts`.
 * @returns {{ key: string, cert: string, source: string, file: string }}
 */
export function loadCert({ hosts = [], dir = CERT_DIR, env = process.env, now = new Date() } = {}) {
  const pairs = [
    env.CERT_FILE && env.KEY_FILE ? [env.CERT_FILE, env.KEY_FILE, 'env'] : null,
    [path.join(dir, 'cert.pem'), path.join(dir, 'key.pem'), 'user'],
  ].filter(Boolean);
  for (const [c, k, source] of pairs) {
    if (fs.existsSync(c) && fs.existsSync(k)) return { cert: fs.readFileSync(c, 'utf8'), key: fs.readFileSync(k, 'utf8'), source, file: c };
  }
  const certFile = path.join(dir, 'selfsigned-cert.pem'), keyFile = path.join(dir, 'selfsigned-key.pem');
  const want = [...new Set(['localhost', '127.0.0.1', '::1', ...hosts])];
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try {
      const cert = fs.readFileSync(certFile, 'utf8');
      const x = new crypto.X509Certificate(cert);
      const san = x.subjectAltName || '';
      const covered = want.every(h => (net.isIP(h) ? x.checkIP(h) : x.checkHost(h)) !== undefined);
      const fresh = new Date(x.validTo).getTime() - now.getTime() > 7 * 24 * 3600e3;
      if (covered && fresh && san) return { cert, key: fs.readFileSync(keyFile, 'utf8'), source: 'selfsigned', file: certFile };
    } catch { /* regenerate */ }
  }
  const made = createSelfSignedCert({ hosts: want, now });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, made.key, { mode: 0o600 });
  fs.writeFileSync(certFile, made.cert);
  return { cert: made.cert, key: made.key, source: 'selfsigned-new', file: certFile };
}

/** plain-http request on the https port → same URL over https */
function redirectToHttps(req, res) {
  const host = /^[\w.\-:[\]]+$/.test(req.headers.host || '') ? req.headers.host : `localhost:${PORT}`;
  res.writeHead(308, { Location: `https://${host}${req.url || '/'}`, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`AURORA uses https here: https://${host}${req.url || '/'}\n`);
  log(req, 308, ' → https');
}

/**
 * One TCP port for both protocols: TLS handshakes (first byte 0x16) go to the https server, anything else to a
 * tiny http server that redirects to https. Returns a net.Server (not yet listening).
 */
export function createDualServer({ key, cert }, onRequest = handler) {
  const secure = https.createServer({ key, cert }, onRequest);
  const plain = http.createServer(redirectToHttps);
  for (const s of [secure, plain]) s.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* ignore */ } });
  const mux = net.createServer((sock) => {
    sock.once('error', () => sock.destroy());
    sock.once('readable', () => {
      const first = sock.read(1);
      if (!first) { sock.destroy(); return; }
      sock.unshift(first);
      (first[0] === 0x16 ? secure : plain).emit('connection', sock);
    });
  });
  mux.on('close', () => { secure.close(); plain.close(); });
  return mux;
}

function listen(host, tls) {
  return new Promise((resolve, reject) => {
    const server = tls ? createDualServer(tls) : http.createServer(handler);
    server.once('error', reject);
    server.listen(PORT, host ?? undefined, () => resolve(server));
  });
}

async function start() {
  const allIfaces = HOST === '0.0.0.0' || HOST === '::';
  const lan = lanAddresses();
  let tls = null;
  if (HTTPS) {
    const extra = allIfaces ? lan : HOST && HOST !== 'localhost' ? [HOST] : [];
    try { tls = loadCert({ hosts: extra }); } catch (e) {
      console.error(`\x1b[31mCould not set up https: ${e.message}\x1b[0m\nPut a certificate at .cert/cert.pem + .cert/key.pem (e.g. mkcert -cert-file .cert/cert.pem -key-file .cert/key.pem localhost ${lan[0] || '<LAN-IP>'}).`);
      process.exit(1);
    }
  }
  const hosts = HOST ? [HOST] : ['127.0.0.1', '::1'];
  const servers = [];
  for (const h of hosts) {
    try { servers.push(await listen(h, tls)); }
    catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.error(`\x1b[31mPort ${PORT} is already in use\x1b[0m${h ? ` on ${h}` : ''}. Is AURORA already running? Try: PORT=${PORT + 1} ${LAN ? 'npm run lan' : 'npm start'}`);
        process.exit(1);
      }
      if (h !== '::1') throw e; // IPv6 loopback unavailable is fine
    }
  }
  const scheme = tls ? 'https' : 'http';
  const shown = HOST && HOST !== '127.0.0.1' && HOST !== 'localhost' && !allIfaces ? HOST : 'localhost';
  const url = h => `${scheme}://${h.includes(':') ? `[${h}]` : h}:${PORT}/`;
  const lines = [`  → \x1b[4m${url(shown)}\x1b[0m`];
  const lanNote = tls ? '(手機／平板 phone / tablet)' : '(區網 LAN — 手機在這裡沒有聲音 no sound on phones)';
  if (allIfaces) for (const ip of lan) lines.push(`  → \x1b[4m${url(ip)}\x1b[0m  \x1b[2m${lanNote}\x1b[0m`);
  console.log(`\n  \x1b[1m\x1b[36mAURORA 極光\x1b[0m dev server\n${lines.join('\n')}\n  serving ${ROOT}\n`);
  if (tls) {
    const how = tls.source.startsWith('selfsigned')
      ? '自簽憑證：手機第一次開啟時會出現「連線不是私人連線」警告，點「顯示詳細資訊／進階 → 繼續前往」即可（只需一次）。\n  Self-signed certificate: accept the browser warning once. For no warning, use mkcert (see README).'
      : `certificate: ${path.relative(ROOT, tls.file) || tls.file}`;
    console.log(`  \x1b[2m${how}\x1b[0m\n`);
  } else if (allIfaces) {
    console.log(`  \x1b[33m注意：手機／平板用 http://IP 開啟時瀏覽器會停用音訊（需要 https 或 localhost）。請改用 npm run lan。\n  Phones/tablets get no sound over http://<IP> (AudioWorklet needs a secure context): use npm run lan.\x1b[0m\n`);
  }
  const stop = () => { for (const s of servers) s.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
