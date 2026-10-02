import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.mjs';
import { nodeAdapter } from './node-adapter.mjs';
const adapter = nodeAdapter();
const handle = serveStdio(() => createServer(adapter));
const close = async () => { await adapter.close(); await handle.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
