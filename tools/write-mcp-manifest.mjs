import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'README.md', 'package.json', 'package-lock.json', 'studio.html',
  'wrangler.mcp.jsonc', 'css/studio.css', 'src/demo/morph.js',
  'src/ui/demo/morph.js', 'src/ui/main.js',
  'tools/build-mcp-site.mjs', 'tools/write-mcp-manifest.mjs',
  'docs/mcp/MCP.md', 'docs/mcp/VERIFICATION.md', 'docs/mcp/FINAL_ACCEPTANCE.md',
];
function collect(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collect(name);
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(name);
  }
}
collect('mcp');
collect('src/creation');
const sources = [...new Set(files)].sort().map(file => {
  const bytes = Buffer.from(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const manifest = {
  upstreamCommit: 'aa204456bfbfff49f79322bfea4673f22d4b4de3',
  byteBasis: 'UTF-8 text with CRLF normalized to LF',
  scope: 'Reviewed local MCP implementation; not evidence of deployment',
  sources,
};
const target = path.join(root, 'docs/mcp/evidence/source-manifest.json');
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Manifest: ${sources.length} files; ${path.relative(root, target)}`);
