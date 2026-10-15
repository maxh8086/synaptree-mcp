import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { ROOT_LABEL, NODE_LABELS, EDGE_TYPES, PRODUCED_EDGE_TYPES, DEFAULT_IGNORE_DIRS, assertEdge } from './constants.js';
import { indexRepository, sha256, walk } from './indexer.js';
import { langForFile } from './langs.js';
import * as C from './compact.js';
import { estimateTokens } from './llm.js';
import { savingsSummary } from './savings.js';
import { summarizeEnabled, summarizeMissing } from './summarize.js';
import { makeEmbedder } from './llm.js';
import { DEFAULT_SYSTEM_PROMPT, renderPrompt } from './prompt.js';
import { ERD_SYSTEM_PROMPT, buildPrompt, applyEnrichment } from './erd-ai.js';
import { modelToGraph, digest, SCHEMA_ROOT } from './schema-graph.js';
import { ErdError, parseDdl, introspect, toMermaid, toCsv, publicConnection } from './erd.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const DAY = 86_400_000;
const STALE_DAYS = 90;
const DELETE_PHRASE = 'yes, delete my repo';
const WRITE_WORDS = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH|CALL)\b/i;
const tenant = (ctx, project) => ({ user_id: ctx.tenant.user_id, repo_name: project });
const pkey = (ctx, project) => `${ctx.tenant.user_id}/${project}`;
const project = z.string().min(1).describe('Project (repo) name');

// Per-project metadata kept in the synaptree store, never in the user's repo.
const meta = (ctx, p) => ctx.store.get('projects', {})[pkey(ctx, p)] ?? {};
const setMeta = (ctx, p, patch) => ctx.store.update('projects', (all) => { all[pkey(ctx, p)] = { ...(all[pkey(ctx, p)] ?? {}), ...patch }; return all; });

function staleInfo(m, now = Date.now()) {
  const days = m.last_sync ? Math.floor((now - m.last_sync) / DAY) : null;
  const keep = Math.max(m.keep_until ?? 0, m.stale_snooze_until ?? 0);
  return { days_since_sync: days, keep_until: keep || null, stale: days !== null && days >= STALE_DAYS && keep < now };
}

function rootOf(ctx, p) {
  const r = meta(ctx, p).root;
  if (!r) throw new HttpError(404, `No local path known for "${p}"; run index_repository with root_path first`);
  return r;
}

// Resolve a repo-relative path and refuse anything that escapes the project root. Read-only use only.
function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(path.resolve(root) + path.sep)) throw new HttpError(400, 'path escapes project root');
  return full;
}

async function readLines(root, rel, from, to) {
  const text = await fs.readFile(safeJoin(root, rel), 'utf8');
  return text.split(/\r?\n/).slice(Math.max(0, from - 1), to).join('\n');
}

// Git is optional (absent in some images, repo may not be a checkout): every caller must handle null and fall back.
// autocrlf=input: CRLF checkouts on bind mounts (Windows) must not read as modified in a Linux container.
const GIT = ['-c', 'safe.directory=*', '-c', 'core.autocrlf=input'];
function git(root, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile('git', [...GIT, ...args], { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
}
const headSha = async (root) => (await git(root, ['rev-parse', 'HEAD']))?.trim() || null;
// Patterns whose JS RegExp meaning differs from POSIX ERE stay on the JS path.
const JS_ONLY = /\(\?|\\[dDtnrfvu0-9xcpk]/;

async function gitGrep(root, pattern, limit) {
  if (JS_ONLY.test(pattern)) return null;
  const excl = DEFAULT_IGNORE_DIRS.filter((d) => !d.includes('/')).map((d) => `:(exclude)**/${d}/**`);
  const out = await git(root, ['grep', '-n', '-I', '-i', '-E', '--untracked', '-e', pattern, '--', '.', ...excl], 20_000);
  if (out === null) return null;
  const matches = [];
  let more = false;
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m || m[3].length > 500 || !langForFile(m[1])) continue;
    if (matches.length >= limit) { more = true; break; }
    matches.push({ file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) });
  }
  return { matches, more };
}

async function nodeByQn(ctx, p, qn) {
  const [n] = await ctx.db.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:$q}) RETURN properties(n) AS n`, { u: ctx.tenant.user_id, r: p, q: qn });
  return n?.n ?? null;
}

async function traceRows(ctx, p, qn, { direction = 'both', depth = 2, edge_types, include_tests = false } = {}) {
  const d = Math.min(Math.max(parseInt(depth, 10) || 1, 1), 5);
  const types = (edge_types?.length ? edge_types : ['CALLS', 'CALL_REFERENCE', 'USAGE', 'IMPLEMENTS', 'INHERITS', 'USES_TYPE', 'IMPORTS']).map((e) => assertEdge(e)).join('|');
  const pat = direction === 'out' ? `-[r:${types}*1..${d}]->` : direction === 'in' ? `<-[r:${types}*1..${d}]-` : `-[r:${types}*1..${d}]-`;
  return ctx.db.run(
    `MATCH (s:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:$q})
     MATCH path = (s)${pat}(m:${ROOT_LABEL} {user_id:$u, repo_name:$r})
     WHERE $tests OR m.file_path IS NULL OR NOT (m.file_path =~ '(?i)(^|.*/)(tests?|__tests__|spec)/.*|.*\\\\.(test|spec)\\\\.[a-z]+$')
     WITH m, min(length(path)) AS hops
     RETURN m.qualified_name AS qualified_name, m.name AS name, labels(m) AS labels, m.file_path AS file_path, m.start_line AS start_line, m.end_line AS end_line, hops
     ORDER BY hops, name LIMIT 200`,
    { u: ctx.tenant.user_id, r: p, q: qn, tests: !!include_tests });
}

async function listProjectRows(ctx) {
  const rows = await ctx.db.run(
    `MATCH (n:${ROOT_LABEL} {user_id:$u}) WHERE NOT n:${SCHEMA_ROOT} RETURN n.repo_name AS name, count(n) AS nodes, sum(CASE WHEN n:File THEN 1 ELSE 0 END) AS files`,
    { u: ctx.tenant.user_id });
  return rows.map((r) => ({ ...r, root: meta(ctx, r.name).root ?? null, last_sync: meta(ctx, r.name).last_sync ?? null, ...staleInfo(meta(ctx, r.name)) }));
}

// Deepest depth (down to 1) whose measured size fits the limit. Falls back to 1 when nothing fits.
export async function chooseDepth(requested, limit, measure) {
  let depth = requested;
  while (depth > 1 && (await measure(depth)) > limit) depth--;
  return depth;
}

export function buildTools() {
  const T = [];
  const fmt = z.enum(['compact', 'json']).optional().describe('compact (default, token-lean text) or json (full object)');
  const add = (name, description, shape, handler, compact) => T.push({ name, description, schema: z.object(compact ? { ...shape, format: fmt } : shape), handler, compact });

  add('index_repository', 'Index (or incrementally refresh) a local repository into the graph. Reads files only; never modifies the repo. Use when the user says "index this repo": pass root_path as the current working directory (absolute) and project as that folder\'s name.',
    { project, root_path: z.string().optional(), force: z.boolean().optional() },
    async (ctx, a) => {
      const root = a.root_path ? path.resolve(a.root_path) : rootOf(ctx, a.project);
      const st = await fs.stat(root).catch(() => null);
      if (!st?.isDirectory()) throw new HttpError(400, `root_path is not a directory: ${root}`);
      const t = tenant(ctx, a.project);
      const stats = await indexRepository(ctx.db, t, a.project, root, { force: a.force, grammarsDir: ctx.cfg.grammarsDir, embed: makeEmbedder(ctx.cfg, ctx.db), ignore: [...DEFAULT_IGNORE_DIRS, ...(ctx.cfg.ignore ?? [])] });
      if (summarizeEnabled(ctx.cfg)) {
        stats.summaries = await summarizeMissing(ctx, a.project, { limit: ctx.cfg.summarizeOnIndex.limit }).catch((e) => ({ error: e.message }));
      }
      setMeta(ctx, a.project, { root, last_sync: Date.now(), index_sha: await headSha(root) });
      ctx.store.audit({ event: 'index', user: t.user_id, project: a.project, ...stats, errors: undefined });
      return stats;
    });

  add('index_status', 'Counts and sync/staleness state for one project.', { project },
    async (ctx, a) => {
      const [c] = await ctx.db.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) RETURN count(n) AS nodes, sum(CASE WHEN n:File THEN 1 ELSE 0 END) AS files`, { u: ctx.tenant.user_id, r: a.project });
      const m = meta(ctx, a.project);
      const info = staleInfo(m);
      // HEAD moved since the last index (commit, checkout, rename, delete) means the graph may hold dead paths.
      const head_sha = m.root ? await headSha(m.root) : null;
      const index_sha = m.index_sha ?? null;
      const head_changed = !!(head_sha && index_sha && head_sha !== index_sha);
      return { project: a.project, ...c, root: m.root ?? null, last_sync: m.last_sync ?? null, ...info, head_sha, index_sha, head_changed, stale: info.stale || head_changed, status: c.nodes ? 'indexed' : 'empty' };
    });

  add('list_projects', 'List indexed projects with node counts, last sync and stale flag.', {}, async (ctx) => ({ projects: await listProjectRows(ctx) }));

  add('snooze_project', 'Keep a stale project for 3 or 6 more months (suppresses the stale reminder). Never deletes.',
    { project, months: z.union([z.literal(3), z.literal(6)]) },
    async (ctx, a) => {
      const until = Date.now() + a.months * 30 * DAY;
      setMeta(ctx, a.project, { keep_until: until });
      ctx.store.audit({ event: 'keep', user: ctx.tenant.user_id, project: a.project, months: a.months });
      return { project: a.project, keep_until: until };
    });

  add('delete_project',
    'Remove a project from the synaptree INDEX only (not git, not the local path). Two stages: call with dry_run:true first to get counts and a delete_token; then the HUMAN must type the repo name and the phrase "yes, delete my repo". Agents must never fill confirm_name or confirm_phrase themselves.',
    { project, dry_run: z.boolean().optional(), delete_token: z.string().optional(), confirm_name: z.string().optional(), confirm_phrase: z.string().optional() },
    async (ctx, a) => {
      const t = tenant(ctx, a.project);
      const [{ c }] = await ctx.db.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) RETURN count(n) AS c`, { u: t.user_id, r: t.repo_name });
      if (!c) throw new HttpError(404, `Project "${a.project}" has no indexed content`);
      const tokens = (ctx.deleteTokens ??= new Map());
      if (a.dry_run || !a.delete_token) {
        const token = crypto.randomUUID();
        tokens.set(token, { user: t.user_id, project: a.project, nodes: c, exp: Date.now() + 300_000 });
        return {
          dry_run: true, nodes: c, delete_token: token, expires_in: 300,
          notice: 'This clears the synaptree index only. Your git history and local files are not touched. Re-indexing recreates it.',
          next: `Type the repo name "${a.project}", then the phrase "${DELETE_PHRASE}".`,
        };
      }
      const rec = tokens.get(a.delete_token);
      tokens.delete(a.delete_token); // single use, even on failure
      if (!rec || rec.exp < Date.now() || rec.user !== t.user_id || rec.project !== a.project) throw new HttpError(400, 'delete_token is invalid or expired; start again with dry_run:true');
      if (a.confirm_name !== a.project) throw new HttpError(400, 'confirm_name does not match the repo name');
      if (a.confirm_phrase !== DELETE_PHRASE) throw new HttpError(400, `confirm_phrase must be exactly "${DELETE_PHRASE}"`);
      if (rec.nodes !== c) throw new HttpError(409, 'repo changed between steps; start again with dry_run:true');
      const removed = await ctx.db.purgeProject(t);
      ctx.store.update('projects', (all) => { delete all[pkey(ctx, a.project)]; return all; });
      ctx.store.update('annotations', (all) => { delete all[pkey(ctx, a.project)]; return all; });
      ctx.store.audit({ event: 'delete_project', user: t.user_id, project: a.project, nodes: removed });
      return { deleted: true, nodes_removed: removed, scope: 'synaptree index only' };
    });

  add('search_graph', 'Find symbols by name/text (fulltext) and optional label.',
    { project, query: z.string().optional(), label: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
    async (ctx, a) => {
      if (a.label && !NODE_LABELS.includes(a.label)) throw new HttpError(400, `unknown label ${a.label}`);
      const lbl = a.label ? `:${a.label}` : '';
      const lim = a.limit ?? 25;
      const off = a.offset ?? 0;
      const rows = a.query
        ? await ctx.db.run(
          `CALL db.index.fulltext.queryNodes('code_fulltext_idx', $q) YIELD node AS n, score
           WHERE n.user_id=$u AND n.repo_name=$r ${a.label ? `AND n:${a.label}` : ''}
           RETURN n.qualified_name AS qualified_name, n.name AS name, labels(n) AS labels, n.file_path AS file_path, n.start_line AS start_line, score ORDER BY score DESC SKIP toInteger($off) LIMIT toInteger($lim)`,
          { q: a.query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').trim() + '*', u: ctx.tenant.user_id, r: a.project, lim, off })
        : await ctx.db.run(
          `MATCH (n:${ROOT_LABEL}${lbl} {user_id:$u, repo_name:$r}) RETURN n.qualified_name AS qualified_name, n.name AS name, labels(n) AS labels, n.file_path AS file_path, n.start_line AS start_line ORDER BY n.qualified_name SKIP toInteger($off) LIMIT toInteger($lim)`,
          { u: ctx.tenant.user_id, r: a.project, lim, off });
      return { results: rows, offset: off, limit: lim, has_more: rows.length === lim };
    }, C.renderSearchGraph);

  add('search_code', 'Regex/literal search over the indexed repository files on disk (read-only).',
    { project, pattern: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
    async (ctx, a) => {
      const root = rootOf(ctx, a.project);
      const limit = a.limit ?? 50;
      const g = await gitGrep(root, a.pattern, limit);
      if (g) return { matches: g.matches, ...(g.more ? { truncated: true } : {}) };
      let re;
      try { re = new RegExp(a.pattern, 'i'); } catch { re = new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
      const out = [];
      for await (const full of walk(root)) {
        const lines = (await fs.readFile(full, 'utf8').catch(() => '')).split(/\r?\n/);
        for (let i = 0; i < lines.length && out.length < limit; i++) {
          if (re.test(lines[i])) out.push({ file: path.relative(root, full).split(path.sep).join('/'), line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
        if (out.length >= limit) break;
      }
      return { matches: out };
    }, C.renderSearchCode);

  add('get_code_snippet', 'Return the source of a symbol by qualified name (stored source first, disk as fallback; read-only).', { project, qualified_name: z.string() },
    async (ctx, a) => {
      const n = await nodeByQn(ctx, a.project, a.qualified_name);
      if (!n) throw new HttpError(404, 'symbol not found');
      const code = n.source || (n.file_path ? await readLines(rootOf(ctx, a.project), n.file_path, n.start_line ?? 1, n.end_line ?? (n.start_line ?? 1) + 60) : '');
      return { qualified_name: n.qualified_name, file_path: n.file_path, start_line: n.start_line, end_line: n.end_line, signature: n.signature, code: code.replace(/\r\n/g, '\n') };
    }, C.renderSnippet);

  add('trace_path', 'Graph walk from ONE symbol (qualified_name from search_graph). Pick params by question: WHO CALLS X / impact of changing X -> direction:"in", depth 1-3. WHAT DOES X CALL -> direction:"out", depth:1 (true callees; depth 2+ pulls in same-name noise such as .get/.set/.find because receiver calls resolve by name). Default depth is 2, direction both: use only for a quick neighbourhood. Test files are excluded unless include_tests:true. Not for reading code (use get_code_snippet), text/regex matches (use search_code) or counts/filters (use query_graph).',
    { project, qualified_name: z.string(), direction: z.enum(['in', 'out', 'both']).optional(), depth: z.number().int().min(1).max(5).optional(), edge_types: z.array(z.string()).optional(), include_tests: z.boolean().optional() },
    async (ctx, a) => ({ nodes: await traceRows(ctx, a.project, a.qualified_name, a) }), C.renderTrace);

  add('query_graph', 'Run a READ-ONLY Cypher query. Must reference $user_id and $repo_name; write clauses are rejected with 403; max 500 rows.',
    { project, cypher: z.string().min(1) },
    async (ctx, a) => {
      if (WRITE_WORDS.test(a.cypher)) throw new HttpError(403, 'query_graph is read-only: write and CALL clauses are not allowed');
      if (!/\$user_id\b/.test(a.cypher)) throw new HttpError(403, 'query must filter on $user_id (tenant isolation)');
      const rows = await ctx.db.run(a.cypher, { user_id: ctx.tenant.user_id, repo_name: a.project });
      return { rows: rows.slice(0, 500), truncated: rows.length > 500 };
    }, C.renderQueryGraph);

  add('get_architecture', 'Overview: counts by label and edge type, languages, top folders.', { project },
    async (ctx, a) => {
      const p = { u: ctx.tenant.user_id, r: a.project };
      const labels = await ctx.db.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) UNWIND labels(n) AS l WITH l WHERE l <> '${ROOT_LABEL}' RETURN l AS label, count(*) AS count ORDER BY count DESC`, p);
      const edges = await ctx.db.run(`MATCH (a:${ROOT_LABEL} {user_id:$u, repo_name:$r})-[e]->() RETURN type(e) AS type, count(e) AS count ORDER BY count DESC`, p);
      const langs = await ctx.db.run(`MATCH (f:File {user_id:$u, repo_name:$r}) RETURN f.language AS language, count(*) AS files ORDER BY files DESC`, p);
      return { labels, edges, languages: langs };
    });

  add('get_graph_schema', 'Node labels and edge types the graph can contain, plus which are populated for this project.', { project: project.optional() },
    async (ctx, a) => {
      const used = a.project ? await ctx.db.run(`MATCH (:${ROOT_LABEL} {user_id:$u, repo_name:$r})-[e]->() RETURN DISTINCT type(e) AS t`, { u: ctx.tenant.user_id, r: a.project }) : [];
      return { node_labels: NODE_LABELS, edge_types: EDGE_TYPES, produced_edge_types: PRODUCED_EDGE_TYPES, reserved_edge_types: EDGE_TYPES.filter((e) => !PRODUCED_EDGE_TYPES.includes(e)), populated_edge_types: used.map((x) => x.t) };
    });

  add('detect_changes', 'Compare files on disk with the index (sha256) and list added/modified/removed paths, plus git_dirty (working-tree changes per git, null outside a repo). Read-only.', { project },
    async (ctx, a) => {
      const root = rootOf(ctx, a.project);
      const known = await ctx.db.fileHashes(tenant(ctx, a.project));
      const seen = new Set();
      const added = [], modified = [];
      for await (const full of walk(root)) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        seen.add(rel);
        const h = known.get(rel);
        if (h === undefined) { if (langForFile(rel) && !/\.(md|markdown)$/i.test(rel)) added.push(rel); } // markdown has no extractor, so it is never hashed
        else if (sha256(await fs.readFile(full, 'utf8')) !== h) modified.push(rel);
      }
      const removed = [...known.keys()].filter((k) => !seen.has(k));
      // Git-aware: working-tree changes per git (null when git or a repo is unavailable), plus index staleness by commit.
      const porcelain = await git(root, ['status', '--porcelain']);
      const git_dirty = porcelain === null ? null : porcelain.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
      const head_sha = await headSha(root);
      const index_sha = meta(ctx, a.project).index_sha ?? null;
      const stale = !!(head_sha && index_sha && head_sha !== index_sha);
      return { added, modified, removed, git_dirty, clean: !(added.length || modified.length || removed.length), index_sha, head_sha, stale };
    }, C.renderChanges);

  add('manage_adr', 'Store or read architecture decision records for a project (kept in the synaptree store).',
    { project, action: z.enum(['list', 'get', 'set', 'delete']), id: z.string().optional(), title: z.string().optional(), content: z.string().optional() },
    async (ctx, a) => {
      const all = ctx.store.get('adrs', {});
      const key = pkey(ctx, a.project);
      const cur = all[key] ?? {};
      if (a.action === 'list') return { adrs: Object.entries(cur).map(([id, v]) => ({ id, title: v.title })) };
      if (!a.id) throw new HttpError(400, 'id required');
      if (a.action === 'get') return cur[a.id] ? { id: a.id, ...cur[a.id] } : (() => { throw new HttpError(404, 'ADR not found'); })();
      ctx.store.update('adrs', (x) => { x[key] ??= {}; if (a.action === 'set') x[key][a.id] = { title: a.title ?? a.id, content: a.content ?? '', updated: Date.now() }; else delete x[key][a.id]; return x; });
      return { ok: true };
    });

  add('ingest_traces', 'Add runtime-observed CALLS edges to the index (index only; never touches the repo).',
    { project, edges: z.array(z.object({ from: z.string(), to: z.string(), count: z.number().optional() })).max(5000) },
    async (ctx, a) => {
      await ctx.db.writeEdges(tenant(ctx, a.project), a.edges.map((e) => ({ type: 'CALLS', from: e.from, to: e.to, line: null })));
      return { ingested: a.edges.length };
    });

  add('annotate_element', 'Attach a human note to a node or edge (stored in synaptree, not in the repo).',
    { project, element: z.string(), note: z.string().max(2000) },
    async (ctx, a) => {
      const key = pkey(ctx, a.project);
      ctx.store.update('annotations', (all) => { all[key] ??= {}; if (a.note.trim()) all[key][a.element] = a.note; else delete all[key][a.element]; return all; });
      return { ok: true };
    });

  add('get_annotations', 'Return all annotations for a project.', { project },
    async (ctx, a) => ({ annotations: ctx.store.get('annotations', {})[pkey(ctx, a.project)] ?? {} }));

  add('export_graph', 'Export the graph of a project (nodes, edges, annotations) as JSON for backup or transfer. Read-only; embeddings are omitted.', { project },
    async (ctx, a) => {
      const p = { u: ctx.tenant.user_id, r: a.project };
      const nodes = await ctx.db.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) RETURN properties(n) AS p, labels(n) AS l`, p);
      const edges = await ctx.db.run(`MATCH (a:${ROOT_LABEL} {user_id:$u, repo_name:$r})-[e]->(b:${ROOT_LABEL} {user_id:$u, repo_name:$r}) RETURN a.qualified_name AS \`from\`, b.qualified_name AS \`to\`, type(e) AS type, e.line AS line, e.ambiguous AS ambiguous`, p);
      return {
        format: 'synaptree-export/1', project: a.project,
        nodes: nodes.map((x) => { const { user_id, repo_name, embedding, source, ...rest } = x.p; return { ...rest, label: x.l.find((l) => NODE_LABELS.includes(l)) ?? 'Function' }; }),
        edges, annotations: ctx.store.get('annotations', {})[pkey(ctx, a.project)] ?? {},
      };
    });

  add('import_graph', 'Import a synaptree-export/1 document into a project (merges nodes, edges and annotations into the index; never touches the repo).',
    { project, data: z.object({ format: z.literal('synaptree-export/1'), nodes: z.array(z.record(z.any())), edges: z.array(z.record(z.any())), annotations: z.record(z.string()).optional() }) },
    async (ctx, a) => {
      for (const n of a.data.nodes) if (!NODE_LABELS.includes(n.label) || typeof n.qualified_name !== 'string') throw new HttpError(400, 'invalid node in import');
      for (const e of a.data.edges) assertEdge(e.type);
      await ctx.db.importGraph(tenant(ctx, a.project), a.data.nodes, a.data.edges);
      if (a.data.annotations) ctx.store.update('annotations', (all) => { all[pkey(ctx, a.project)] = { ...(all[pkey(ctx, a.project)] ?? {}), ...a.data.annotations }; return all; });
      return { imported: { nodes: a.data.nodes.length, edges: a.data.edges.length, annotations: Object.keys(a.data.annotations ?? {}).length } };
    });

  const flowContext = async (ctx, a) => {
    const root = rootOf(ctx, a.project);
    const start = await nodeByQn(ctx, a.project, a.qualified_name);
    if (!start) throw new HttpError(404, 'symbol not found');
    const near = await traceRows(ctx, a.project, a.qualified_name, { direction: 'both', depth: a.depth ?? 2 });
    const notes = ctx.store.get('annotations', {})[pkey(ctx, a.project)] ?? {};
    const parts = [];
    for (const n of [{ ...start, qualified_name: start.qualified_name }, ...near.slice(0, 30)]) {
      if (!n.file_path || !n.start_line) continue;
      const code = await readLines(root, n.file_path, n.start_line, Math.min(n.end_line ?? n.start_line + 40, n.start_line + 80)).catch(() => '');
      parts.push(`### ${n.qualified_name} (${n.file_path}:${n.start_line})\n${notes[n.qualified_name] ? `Note: ${notes[n.qualified_name]}\n` : ''}${code}`);
    }
    return { text: parts.join('\n\n'), nodes: near.length + 1 };
  };

  // Auto-narrow the trace depth to fit the confirm threshold. Only paid sources are gated, so only they narrow.
  const pickDepth = async (ctx, a, question = '') => {
    const requested = a.depth ?? 2;
    if (!ctx.llm.isPaid()) return { depth: requested, depth_used: requested };
    const limit = ctx.llm.settings().guardrails.confirm_tokens;
    const measure = async (depth) => {
      const c = await flowContext(ctx, { ...a, depth });
      return estimateTokens(question ? `${c.text}\n\nQuestion: ${question}` : c.text);
    };
    const depth = await chooseDepth(requested, limit, measure);
    if (depth === requested) return { depth, depth_used: depth };
    return { depth, depth_used: depth, note: `Depth reduced from ${requested} to ${depth} to stay under ${limit} tokens` };
  };

  add('estimate_cost', 'Estimate LLM tokens for asking about a flow, and which approval tier applies.',
    { project, qualified_name: z.string(), depth: z.number().int().min(1).max(3).optional() },
    async (ctx, a) => {
      const picked = await pickDepth(ctx, a);
      const c = await flowContext(ctx, { ...a, depth: picked.depth });
      const tokens = estimateTokens(c.text);
      return { estimated_tokens: tokens, nodes: c.nodes, tier: ctx.llm.tier(tokens), usage: ctx.llm.usage(), depth_used: picked.depth_used, ...(picked.note ? { note: picked.note } : {}) };
    });

  add('ask_flow', 'Ask the configured LLM about a flow. Above the confirm threshold the call returns needs_approval; resend with approval_id (and send_anyway:true above the hard limit).',
    { project, qualified_name: z.string(), question: z.string().min(1).max(2000), depth: z.number().int().min(1).max(3).optional(), approval_id: z.string().optional(), send_anyway: z.boolean().optional() },
    async (ctx, a) => {
      const picked = await pickDepth(ctx, a, a.question);
      const c = await flowContext(ctx, { ...a, depth: picked.depth });
      const prompt = `${c.text}\n\nQuestion: ${a.question}`;
      const tokens = estimateTokens(prompt);
      const scope = `${a.project}:${a.qualified_name}:${picked.depth}`;
      const gate = ctx.llm.gate(scope, tokens, a);
      if (!gate.ok) return { ...gate, depth_used: picked.depth_used, ...(picked.note ? { note: picked.note } : {}) };
      const sys = renderPrompt(DEFAULT_SYSTEM_PROMPT, { USER_ID: ctx.tenant.user_id, REPO_NAME: a.project });
      return { ...(await ctx.llm.complete(prompt, { system: sys })), estimated_tokens: tokens, depth_used: picked.depth_used, ...(picked.note ? { note: picked.note } : {}) };
    });

  add('summarize_symbol', 'One-paragraph LLM summary of a symbol (same approval gate as ask_flow).',
    { project, qualified_name: z.string(), approval_id: z.string().optional(), send_anyway: z.boolean().optional() },
    async (ctx, a) => {
      const n = await nodeByQn(ctx, a.project, a.qualified_name);
      if (!n) throw new HttpError(404, 'symbol not found');
      const code = await readLines(rootOf(ctx, a.project), n.file_path, n.start_line, n.end_line);
      const prompt = `Summarize this ${n.label ?? 'symbol'} in 2-3 sentences.\n\n${code}`;
      const gate = ctx.llm.gate(`sum:${a.qualified_name}`, estimateTokens(prompt), { ...a, purpose: 'annotation' });
      if (!gate.ok) return gate;
      return ctx.llm.complete(prompt);
    });

  add('get_llm_settings', 'Current LLM provider settings and guardrails (API key never returned).', {}, async (ctx) => ctx.llm.publicSettings());
  add('set_llm_settings', 'Update LLM provider (local|api), endpoint, model, API key (write-only) and guardrails.',
    { provider: z.enum(['local', 'api']).optional(), base_url: z.string().url().optional(), model: z.string().optional(), api_key: z.string().optional(), guardrails: z.record(z.string(), z.number()).optional() },
    async (ctx, a) => {
      try { return ctx.llm.save(a); } catch (e) { throw new HttpError(400, e.message); }
    });
  add('get_usage', 'LLM token usage for today against the daily budget, plus estimated tokens saved by graph tools (savings: saved, baseline, response, calls, by_tool).', {},
    async (ctx) => ({ ...ctx.llm.usage(), savings: savingsSummary(ctx.store) }));

  // ---- ERD: read-only. Connection secrets are sealed server-side and never returned. ----
  const ck = (ctx) => `erd_conns:${ctx.tenant.user_id}`;
  const erdWrap = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof ErdError) throw new HttpError(e.status, e.message); throw e; } };

  add('erd_list_connections', 'Saved database connections for ERDs (passwords never returned).', {},
    async (ctx) => Object.entries(ctx.store.get(ck(ctx), {})).map(([id, c]) => ({ id, ...publicConnection({ ...c.public, password: c.secret }) })));
  add('erd_save_connection', 'Save a read-only database connection (kind: postgres|mysql|oracle|odbc|sqlite|mongodb; mongodb is sampled with depth/field limits). As per industry best practice and the AI governance lifecycle, we recommend providing read-only credentials only (SELECT/catalog rights). The password is write-only.',
    {
      id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
      kind: z.enum(['postgres', 'mysql', 'oracle', 'odbc', 'sqlite', 'mongodb']),
      sample_size: z.number().int().min(1).max(200).optional(), max_depth: z.number().int().min(1).max(4).optional(),
      host: z.string().optional(), port: z.number().int().optional(), database: z.string().optional(), user: z.string().optional(), password: z.string().optional(),
      service_name: z.string().optional(), connect_string: z.string().optional(), dsn: z.string().optional(), connection_string: z.string().optional(),
      dialect: z.enum(['postgres', 'mysql', 'sqlserver', 'oracle']).optional(), file: z.string().optional(),
    },
    async (ctx, a) => {
      const { id, password, connection_string, ...rest } = a;
      const secret = JSON.stringify({ password: password ?? undefined, connection_string: connection_string ?? undefined });
      ctx.store.update(ck(ctx), (all) => {
        const prev = all[id];
        // omitting the password keeps the previous secret
        all[id] = { public: rest, secret: password || connection_string ? ctx.store.seal(secret) : prev?.secret ?? ctx.store.seal('{}') };
        return all;
      });
      ctx.store.audit({ event: 'erd_connection_saved', user: ctx.tenant.user_id, id, kind: a.kind });
      return { id, saved: true };
    });
  add('erd_delete_connection', 'Forget a saved ERD connection (does not touch the database).', { id: z.string() },
    async (ctx, a) => {
      ctx.store.update(ck(ctx), (all) => { delete all[a.id]; return all; });
      const purged = await ctx.db.purgeProject(tenant(ctx, `db:${a.id}`)); // saved schema snapshot in the synaptree index only
      return { id: a.id, deleted: true, schema_nodes_removed: purged };
    });

  add('erd_test_connection', 'Open a saved connection in a read-only session and report only table/relationship counts.', { id: z.string() },
    async (ctx, a) => erdWrap(async () => {
      const c = ctx.store.get(ck(ctx), {})[a.id];
      if (!c) throw new HttpError(404, 'connection not found');
      const secret = JSON.parse(ctx.store.open(c.secret) || '{}');
      try {
        const m = await introspect({ ...c.public, ...secret }, [], { workspaceRoot: ctx.cfg.workspaceRoot ?? process.cwd() });
        return { ok: true, tables: m.tables.length, relationships: m.relationships.length };
      } catch (e) { return { ok: false, error: e.message }; }
    }));

  const erdModel = (ctx, a) => erdWrap(async () => {
    if (a.ddl) return parseDdl(a.ddl);
    const c = ctx.store.get(ck(ctx), {})[a.connection_id];
    if (!c) throw new HttpError(404, 'connection not found; save one first or pass ddl');
    const secret = JSON.parse(ctx.store.open(c.secret) || '{}');
    return introspect({ ...c.public, ...secret }, a.schemas ?? [], { workspaceRoot: ctx.cfg.workspaceRoot ?? process.cwd() });
  });
  const erdShape = { connection_id: z.string().optional(), ddl: z.string().max(2_000_000).optional(), schemas: z.array(z.string()).max(50).optional() };

  add('erd_get_model', 'Entity-relationship model (tables, columns, PK/FK, relationships) from a saved connection or pasted DDL. Runs read-only catalog queries only.', erdShape,
    async (ctx, a) => erdModel(ctx, a));
  add('erd_export', 'Export an ERD as Mermaid erDiagram or CSV (column inventory).', { ...erdShape, format: z.enum(['mermaid', 'csv']) },
    async (ctx, a) => {
      const m = await erdModel(ctx, a);
      return a.format === 'mermaid' ? { format: 'mermaid', content: toMermaid(m) } : { format: 'csv', content: toCsv(m) };
    });

  add('erd_ai_generate', 'One-click ERD from a saved connection (or DDL) using the LOCAL LLM to infer undeclared relationships, group tables into domains and describe them. Only table/column names and types are sent, never row data; refuses unless the LLM is local. Same approval gate as ask_flow.',
    { ...erdShape, approval_id: z.string().optional(), send_anyway: z.boolean().optional() },
    async (ctx, a) => {
      ctx.llm.assertLocal();
      const model = await erdModel(ctx, a);
      const prompt = buildPrompt(model);
      const tokens = estimateTokens(prompt) + estimateTokens(ERD_SYSTEM_PROMPT);
      const gate = ctx.llm.gate(`erd:${a.connection_id ?? 'ddl'}:${model.tables.length}`, tokens, a);
      if (!gate.ok) return gate;
      const r = await ctx.llm.complete(prompt, { system: ERD_SYSTEM_PROMPT, localOnly: true });
      const { model: enriched, added, domains, warning } = applyEnrichment(model, r.text);
      ctx.store.audit({ event: 'erd_ai_generate', user: ctx.tenant.user_id, connection: a.connection_id ?? null, tables: model.tables.length, inferred: added });
      return { model: enriched, inferred_relationships: added, domains, estimated_tokens: tokens, local_only: true, ...(warning ? { warning } : {}) };
    });

  // ---- Saved DB schema in the graph (SQL + NoSQL): lets agents see tables, structure and relationships over MCP. ----
  const schemaRepo = (id) => `db:${id}`;
  const loadSchema = async (ctx, id) => {
    const s = await ctx.db.readSchema(tenant(ctx, schemaRepo(id)));
    if (!s.tables.length) throw new HttpError(404, `No saved schema for "${id}"; run erd_save_to_index first`);
    const cols = new Map();
    for (const c of s.columns) (cols.get(c.table) ?? cols.set(c.table, []).get(c.table)).push({ name: c.name, type: c.type, nullable: c.nullable, pk: c.pk, fk: c.fk });
    return {
      saved_at: s.tables[0].saved_at, nosql: !!s.tables[0].nosql,
      tables: s.tables.map((t) => ({ id: t.qualified_name, schema: t.schema, name: t.name, kind: t.kind, description: t.description, domain: t.domain, columns: cols.get(t.qualified_name) ?? [] })),
      relationships: s.relationships.map((r) => ({ from: r.from, to: r.to, name: r.p.name, cardinality: r.p.cardinality, origin: r.p.origin, columns: (r.p.from_columns ?? []).map((f, i) => ({ from: f, to: r.p.to_columns?.[i] })) })),
    };
  };

  add('erd_save_to_index', 'Save a database schema (tables/collections, columns, PK/FK, relationships) into the synaptree graph so agents can query it. Reads the source DB read-only; writes only to the synaptree index. NoSQL is sampled and depth/field-limited (reported as truncated). Set enrich=true to also infer undeclared relationships with the LOCAL LLM.',
    { connection_id: z.string(), schemas: z.array(z.string()).max(50).optional(), enrich: z.boolean().optional(), approval_id: z.string().optional(), send_anyway: z.boolean().optional(),
      model: z.object({ tables: z.array(z.any()).max(5000), relationships: z.array(z.any()).max(20000) }).passthrough().optional() },
    async (ctx, a) => {
      const c = ctx.store.get(ck(ctx), {})[a.connection_id];
      if (!c) throw new HttpError(404, 'connection not found');
      // `model` lets the UI persist an already-generated (e.g. LLM-enriched) ERD without re-reading the DB or re-running the LLM.
      let model = a.model ?? await erdModel(ctx, a);
      if (a.enrich && !a.model) {
        ctx.llm.assertLocal();
        const prompt = buildPrompt(model);
        const gate = ctx.llm.gate(`erd-save:${a.connection_id}:${model.tables.length}`, estimateTokens(prompt) + estimateTokens(ERD_SYSTEM_PROMPT), a);
        if (!gate.ok) return gate;
        const r = await ctx.llm.complete(prompt, { system: ERD_SYSTEM_PROMPT, localOnly: true });
        const e = applyEnrichment(model, r.text);
        model = { ...e.model, nosql: model.nosql, truncated: model.truncated, limits: model.limits };
      }
      const g = modelToGraph(model, { source_kind: c.public.kind });
      await ctx.db.replaceSchema(tenant(ctx, schemaRepo(a.connection_id)), g.nodes, g.edges);
      ctx.store.audit({ event: 'erd_saved_to_index', user: ctx.tenant.user_id, connection: a.connection_id, tables: model.tables.length });
      return {
        connection_id: a.connection_id, saved_at: g.saved_at, tables: model.tables.length, relationships: model.relationships.length,
        nosql: !!model.nosql, truncated: !!model.truncated, ...(model.limits ? { limits: model.limits } : {}),
      };
    });
  add('list_db_schemas', 'Database schemas saved in the graph (connection id, table count, when saved).', {},
    async (ctx) => (await ctx.db.listSchemas(tenant(ctx, ''))).map((r) => ({ connection_id: r.repo_name.replace(/^db:/, ''), tables: r.tables, saved_at: r.saved_at, source_kind: r.source_kind, nosql: !!r.nosql })));
  add('delete_db_schema', 'Delete one saved database schema snapshot from the synaptree index. Never touches the source database.',
    { connection_id: z.string() },
    async (ctx, a) => {
      await ctx.db.deleteSchema(tenant(ctx, schemaRepo(a.connection_id)));
      ctx.store.audit({ event: 'delete_db_schema', user: ctx.tenant.user_id, connection: a.connection_id });
      return { connection_id: a.connection_id, deleted: true };
    });
  add('get_db_schema','Saved database schema from the graph: tables/collections, columns, keys and relationships. Use format=digest for a compact text summary.',
    { connection_id: z.string(), format: z.enum(['json', 'digest']).optional() },
    async (ctx, a) => {
      const m = await loadSchema(ctx, a.connection_id);
      return a.format === 'digest' ? { connection_id: a.connection_id, saved_at: m.saved_at, nosql: m.nosql, digest: digest(m) } : { connection_id: a.connection_id, ...m };
    });
  add('get_table_relationships', 'Tables/collections related to one table in the saved schema: what it references and what references it, with column mappings, cardinality and origin (declared | inferred_name | inferred_llm).',
    { connection_id: z.string(), table: z.string() },
    async (ctx, a) => {
      const m = await loadSchema(ctx, a.connection_id);
      const t = m.tables.find((x) => x.id === a.table || x.name === a.table);
      if (!t) throw new HttpError(404, `table "${a.table}" not found in saved schema`);
      return {
        table: t,
        references: m.relationships.filter((r) => r.from === t.id),
        referenced_by: m.relationships.filter((r) => r.to === t.id),
      };
    });

  return T;
}

export { listProjectRows, staleInfo, meta, setMeta, DELETE_PHRASE };
