#!/usr/bin/env node
// X (twitter-text v3) weighted length of every post option in docs/video/POST.md, written back into its heading.
//   node tools/video/xlen.mjs [docs/video/POST.md]
// Weights: code points in [0, 4351], [8192, 8205], [8208, 8223], [8242, 8247] count 1, everything else 2 (CJK,
// full-width punctuation, emoji); URLs count 23. A heading/label line containing "(xlen N/280)" is followed by the
// ``` block it measures; "(N characters)" labels (alt text, limit 1000) count plain code points.
import fs from 'node:fs';
const R = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const w = cp => (R.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2);
export const xlen = s => { s = s.normalize('NFC').replace(/https?:\/\/\S+/g, 'x'.repeat(23)); let n = 0; for (const ch of s) n += w(ch.codePointAt(0)); return n; };
const file = process.argv[2] || new URL('../../docs/video/POST.md', import.meta.url).pathname;
const lines = fs.readFileSync(file, 'utf8').split('\n');
const blockAfter = i => { let a = i + 1; while (a < lines.length && !lines[a].startsWith('```')) a++; let b = a + 1; while (b < lines.length && !lines[b].startsWith('```')) b++; return lines.slice(a + 1, b).join('\n').trim(); };
let over = 0;
for (let i = 0; i < lines.length; i++) {
  if (/\(xlen [?\d]+\/280\)/.test(lines[i])) {
    const n = xlen(blockAfter(i)); if (n > 280) over++;
    lines[i] = lines[i].replace(/\(xlen [?\d]+\/280\)/, `(xlen ${n}/280)`);
    console.log(String(n).padStart(4), n > 280 ? 'OVER' : '    ', lines[i].replace(/[#*]/g, '').trim().slice(0, 60));
  } else if (/\([?\d]+ characters\)/.test(lines[i])) {
    const n = [...blockAfter(i)].length; if (n > 1000) over++;
    lines[i] = lines[i].replace(/\([?\d]+ characters\)/, `(${n} characters)`);
    console.log(String(n).padStart(4), n > 1000 ? 'OVER' : '    ', lines[i].replace(/[#*]/g, '').trim().slice(0, 60));
  }
}
fs.writeFileSync(file, lines.join('\n'));
if (over) { console.error(`${over} option(s) over the limit`); process.exitCode = 1; }
