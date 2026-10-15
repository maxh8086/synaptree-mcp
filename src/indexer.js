import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { langForFile } from './langs.js';
import { parseSource } from './parser.js';
import { extractTree, extractLite, extractResource } from './extract.js';
import { buildFile, linkRefs, NameIndex, resolveImports } from './linker.js';
import { DEFAULT_IGNORE_DIRS } from './constants.js';

const MAX_BYTES = 1_000_000;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Read-only walk: never writes into the repo being indexed. Ignore entries are either a bare directory
// name (matched anywhere) or a root-relative path such as ".claude/worktrees". Directories holding a `.git`
// *file* (linked worktrees, submodules) are separate checkouts and are skipped.
export async function* walk(root, ignore = DEFAULT_IGNORE_DIRS) {
  const names = new Set(ignore.filter((i) => !i.includes('/')));
  const paths = new Set(ignore.filter((i) => i.includes('/')).map((i) => i.replace(/^\.?\/+|\/+$/g, '')));
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (dir !== root && ents.some((e) => e.name === '.git' && e.isFile())) continue;
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (names.has(e.name)) continue;
        if (paths.size && paths.has(path.relative(root, full).split(path.sep).join('/'))) continue;
        stack.push(full);
      } else if (e.isFile() && langForFile(e.name)) yield full;
    }
  }
}

const SHELL_LITE = { lite: [
  { re: /^[ 	]*(?:function[ 	]+)?([A-Za-z_][w.-]*)[ 	]*(?:([ 	]*))?[ 	]*{/m, nameGroup: 1, kind: 'Function', end: "block" },
] };

export async function extractSource(filePath, source, grammarsDir) {
  const cfg = langForFile(filePath);
  if (!cfg) return null;
  if (cfg.lite) return extractLite(source, cfg);
  if (cfg.resource) return extractResource(source, cfg);
  let tree;
  try { tree = await parseSource(cfg, source, grammarsDir); } catch (err) {
    // The bundled bash WASM grammar can crash on some scripts; fall back to pattern extraction so the file still indexes.
    if (cfg.id === 'bash') return extractLite(source, SHELL_LITE);
    throw err;
  }
  return tree ? extractTree(tree, source, cfg) : null;
}

// Index a set of files for one tenant. `files` are {rel, source}; unchanged sha256 values are skipped unless force.
export async function indexFiles(db, t, project, files, { force = false, grammarsDir, embed, maxSource = 8192 } = {}) {
  const known = force ? new Map() : await db.fileHashes(t);
  const stats = { indexed: 0, skipped: 0, failed: 0, errors: [] };
  const built = [];
  for (const { rel, source, ast, hash: given } of files) {
    const hash = given ?? sha256(source ?? JSON.stringify(ast));
    if (known.get(rel) === hash) { stats.skipped++; continue; }
    try {
      const x = ast ?? await extractSource(rel, source, grammarsDir);
      if (!x) { stats.skipped++; continue; }
      const f = buildFile(project, rel, x, { lang: langForFile(rel)?.id ?? '', source, maxSource });
      f.nodes.find((n) => n.label === 'File').sha256 = hash;
      await db.replaceFile(t, rel, f.nodes, f.edges);
      built.push(f);
      stats.indexed++;
    } catch (err) { stats.failed++; stats.errors.push(`${rel}: ${err.message}`.slice(0, 200)); }
  }
  if (built.length) {
    const index = new NameIndex(await db.nameIndex(t));
    const allFiles = new Set((await db.fileHashes(t)).keys());
    const edges = [];
    for (const f of built) {
      edges.push(...linkRefs(f.pending, index));
      for (const target of resolveImports(f.filePath, f.imports, allFiles)) {
        edges.push({ type: 'IMPORTS', from: f.fileQn, to: `${project}.${target}`, line: null });
      }
    }
    await db.writeEdges(t, edges);
    stats.links = edges.length;
    if (embed) embed(t, built).catch(() => {});
  }
  return stats;
}

export async function indexRepository(db, t, project, root, opts = {}) {
  const files = [];
  for await (const full of walk(root, opts.ignore)) {
    const st = await fs.stat(full);
    if (st.size > MAX_BYTES) continue;
    files.push({ rel: path.relative(root, full).split(path.sep).join('/'), source: await fs.readFile(full, 'utf8') });
  }
  const stats = await indexFiles(db, t, project, files, opts);
  // Files that disappeared since the last run are purged.
  const present = new Set(files.map((f) => f.rel));
  let removed = 0;
  for (const p of (await db.fileHashes(t)).keys()) if (!present.has(p)) { await db.deleteFile(t, p); removed++; }
  // Folder nodes have no file_path, so drop the ones no surviving file lives under.
  if (typeof db.pruneFolders === 'function') {
    const keep = new Set([project]);
    for (const rel of present) {
      let acc = project;
      for (const seg of rel.split('/').slice(0, -1)) keep.add((acc = `${acc}.${seg}`));
    }
    await db.pruneFolders(t, keep);
  }
  return { ...stats, removed, files: files.length };
}
