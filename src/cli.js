#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Store } from './store.js';
import { Llm } from './llm.js';
import { createMcpServer } from './mcp.js';
import { createApp } from './server.js';
import { startDesignWatcher } from './watcher.js';

// The project's own .env is authoritative for its NEO4J_* / SYNAPTREE_* keys, so a host process (e.g. an agent
// gateway that spawns us over stdio) cannot point us at someone else's database through inherited variables.
try {
  const own = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(own)) if (/^(NEO4J_|SYNAPTREE_)/.test(k)) process.env[k] = v;
} catch { /* no .env: use process env */ }

async function boot() {
  const cfg = loadConfig();
  const db = new Db(cfg);
  await db.init();
  const store = new Store(cfg.dataDir);
  const llm = new Llm(store);
  return { db, cfg, store, llm, tenant: { user_id: cfg.userId } };
}

const mode = process.argv[2] === '--stdio' ? 'stdio' : process.argv[2] ?? 'serve';

// Background EGM artifact sync: docs/designs/*.md under the working directory are kept in the graph as they change.
// Disable with SYNAPTREE_WATCH=0. Logs go to stderr so stdio transport output stays clean.
function startBackgroundWatch(ctx) {
  if (process.env.SYNAPTREE_WATCH === '0') return null;
  try {
    return startDesignWatcher(ctx, { root: process.cwd() });
  } catch (err) {
    console.error(`[synaptree-watch] not started: ${err.message}`);
    return null;
  }
}

if (mode === 'stdio') {
  const ctx = await boot();
  startBackgroundWatch(ctx);
  await createMcpServer(ctx).connect(new StdioServerTransport());
} else if (mode === 'serve') {
  const ctx = await boot();
  startBackgroundWatch(ctx);
  createApp(ctx).listen(ctx.cfg.port, ctx.cfg.host, () => {
    console.error(`synaptree-mcp listening on http://${ctx.cfg.host}:${ctx.cfg.port} (UI: /ui, MCP SSE: /sse, data: ${path.resolve(ctx.cfg.dataDir)})`);
  });
} else {
  console.error('usage: synaptree-mcp [serve | --stdio]');
  process.exit(2);
}
