import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.mjs';
import { nodeAdapter, renderTimeoutFromEnv, artifactBudgetFromEnv } from './node-adapter.mjs';
const adapter = nodeAdapter({ timeoutMs: renderTimeoutFromEnv(), maxBytes: artifactBudgetFromEnv() });
const handle = serveStdio(() => createServer(adapter));
const close = async () => { await adapter.close(); await handle.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
