import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildTools } from './tools.js';
import { track } from './savings.js';
import { withHud } from './guardrails.js';

export const TOOLS = buildTools();
export const toolByName = (n) => TOOLS.find((t) => t.name === n);

// Run one tool and shape failures so every transport reports them the same way.
// opts.track records tokens-saved; only MCP-transport calls (agents) set it, not the admin UI's REST calls.
export async function runTool(ctx, name, args, opts = {}) {
  const tool = toolByName(name);
  if (!tool) { const e = new Error(`unknown tool ${name}`); e.status = 404; throw e; }
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) { const e = new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); e.status = 400; throw e; }
  const out = await tool.handler(ctx, parsed.data);
  if (opts.track) await track(ctx, name, parsed.data, out);
  return out;
}

export function createMcpServer(ctx) {
  const server = new McpServer({ name: 'synaptree-mcp', version: '0.1.0' });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema.shape }, async (args) => {
      try {
        const out = await runTool(ctx, t.name, args, { track: true });
        const text = t.compact && args?.format !== 'json' ? t.compact(out) : JSON.stringify(out, null, 2);
        return { content: withHud(ctx, t.name, args, [{ type: 'text', text }]) };
      } catch (e) {
        return { isError: true, content: withHud(ctx, t.name, args, [{ type: 'text', text: JSON.stringify({ error: e.message, status: e.status ?? 500, ...(e.extra ?? {}) }) }]) };
      }
    });
  }
  return server;
}
