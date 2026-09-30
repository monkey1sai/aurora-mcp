#!/usr/bin/env node
// The film's "it tuned by looking" proof: a REAL excerpt of the build transcript — one of the 10 parallel sound
// designer agents (pads) rendering Bowed Moonglass offline, reading the spectrogram PNG it had just rendered, seeing
// broadband noise, tracking it down to a voice-steal bug in the physical-model engine, working around it and
// reading the clean result. The two images are the exact JPEGs that agent was shown (base64 in the tool results).
//
//   node tools/video/make-buildlog.mjs --transcript <agent .jsonl>   → renders/video/assets/buildlog/
//     before.jpg / after.jpg   the spectrograms exactly as the agent saw them (1400×500)
//     moonglass.json           the lines shown on screen (tool name + the agent's own description + a trimmed output line),
//                              each with its message index and timestamp in the transcript
//
// --transcript: the pad sound designer's sub-agent transcript from the Claude Code build session
// (~/.claude/projects/<project>/<session>/subagents/workflows/<workflow>/agent-<id>.jsonl on the machine that built it).
// Only tool names, the agent's short tool descriptions, file names and numbers are used — no paths, no user data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TRANSCRIPT = opt('--transcript', process.env.AURORA_BUILDLOG_TRANSCRIPT);
if (!TRANSCRIPT) { console.error('usage: node tools/video/make-buildlog.mjs --transcript <agent .jsonl>'); process.exit(2); }
const OUT = path.join(ROOT, 'renders/video/assets/buildlog');

// message index → how it is shown (checked against the transcript below: tool, description / file must match)
const PICK = {
  before: [
    { i: 385, tool: 'Bash', expect: 'Render Bowed Moonglass tests', out: /^demo .*/ },
    { i: 388, tool: 'Read', expect: 'bowed-moonglass-demo.png', image: 'before.jpg' },
  ],
  after: [
    { i: 410, tool: 'Bash', expect: 'Build minimal repro for phys bow voice-steal noise' },
    { i: 446, tool: 'Bash', expect: 'Apply Moonglass workaround and re-test', out: /^demo .*/ },
    { i: 449, tool: 'Read', expect: 'bowed-moonglass-demo.png', image: 'after.jpg' },
  ],
};

const msgs = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const results = {};
for (const m of msgs) for (const b of (Array.isArray(m.message?.content) ? m.message.content : [])) if (b.type === 'tool_result') results[b.tool_use_id] = b;
fs.mkdirSync(OUT, { recursive: true });

/** the metrics line, trimmed to the numbers the film can show (same order, same values) */
const trimMetrics = s => {
  const g = re => (s.match(re) || [])[1];
  return `demo  LUFS ${g(/LUFS (-?[\d.]+)/)}  pk ${g(/pk (-?[\d.]+)/)}  cent ${g(/cent (\d+)/)}  >16k ${g(/>16k (-?\d+)/)}`;
};

const lines = {};
for (const [phase, picks] of Object.entries(PICK)) {
  lines[phase] = [];
  for (const p of picks) {
    const m = msgs[p.i];
    const tu = (m?.message?.content || []).find(b => b.type === 'tool_use');
    if (!tu || tu.name !== p.tool) throw new Error(`message ${p.i}: expected ${p.tool}, found ${tu?.name}`);
    const label = p.tool === 'Read' ? path.basename(tu.input.file_path) : tu.input.description;
    if (!String(label).includes(p.expect)) throw new Error(`message ${p.i}: expected "${p.expect}", found "${label}"`);
    const res = results[tu.id];
    const row = { i: p.i, at: m.timestamp, tool: p.tool, text: p.tool === 'Read' ? `out/${label}` : label };
    if (p.out) {
      const txt = (Array.isArray(res.content) ? res.content.map(x => x.text || '').join('\n') : String(res.content));
      const hit = txt.split('\n').find(l => p.out.test(l));
      if (!hit) throw new Error(`message ${p.i}: no output line matching ${p.out}`);
      row.out = trimMetrics(hit);
      row.outRaw = hit.trim();
    }
    if (p.image) {
      const img = (Array.isArray(res.content) ? res.content : []).find(x => x.type === 'image');
      if (!img) throw new Error(`message ${p.i}: no image in the tool result`);
      fs.writeFileSync(path.join(OUT, p.image), Buffer.from(img.source.data, 'base64'));
      row.image = p.image;
    }
    lines[phase].push(row);
  }
}
const meta = {
  source: 'build transcript, sound designer agent (pads)',
  agent: { en: 'sound designer agent · pads', zh: '音色設計代理人 · 鋪底' },
  date: msgs[385].timestamp.slice(0, 10),
  // the noise band in before.jpg (image px): the broadband haze between ≈7 s and ≈13 s of the demo phrase
  noiseBox: { x: 446, y: 32, w: 396, h: 408 },
  lines,
};
fs.writeFileSync(path.join(OUT, 'moonglass.json'), JSON.stringify(meta, null, 1));
console.log(JSON.stringify(meta, null, 1));
