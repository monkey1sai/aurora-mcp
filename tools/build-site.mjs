#!/usr/bin/env node
// Static site build for hosting (Cloudflare Workers static assets / any static host):
// copies only what the browser app needs into dist/. No bundling — the app is plain ES modules.
//   node tools/build-site.mjs   → dist/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const COPY = ['index.html', 'LICENSE', 'css', 'src', 'tools/phrases.mjs']; // phrases.mjs is imported by the UI

fs.rmSync(OUT, { recursive: true, force: true });
let files = 0, bytes = 0;
for (const rel of COPY) {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  fs.cpSync(src, dst, { recursive: true, filter: s => !path.basename(s).startsWith('.') });
}
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(OUT);
console.log(`dist/: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
