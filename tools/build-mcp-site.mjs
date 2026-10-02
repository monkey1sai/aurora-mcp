import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=path.join(ROOT,'dist'), expected=new Set();
const COPY=['index.html','studio.html','LICENSE','css','src','tools/phrases.mjs','tools/video/capture/app-hook.js'];
function copy(rel){rel=path.normalize(rel);const source=path.join(ROOT,rel);if(fs.statSync(source).isDirectory()){for(const name of fs.readdirSync(source))if(!name.startsWith('.'))copy(path.join(rel,name));}else{expected.add(rel);const dest=path.join(OUT,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest);}}
// Keep watched directories in place on Windows; remove only stale generated files.
fs.mkdirSync(OUT,{recursive:true});for(const rel of COPY)copy(rel);
function prune(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())prune(file);else if(!expected.has(path.relative(OUT,file)))fs.unlinkSync(file);}}
prune(OUT);
console.log(`dist/: ${expected.size} allowlisted files; MCP server and dependencies excluded.`);
