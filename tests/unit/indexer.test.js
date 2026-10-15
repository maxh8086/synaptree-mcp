import test from 'node:test';
import assert from 'node:assert/strict';
import { indexFiles, sha256 } from '../../src/indexer.js';

// In-memory stand-in for Db: records writes so incremental behaviour can be asserted without Neo4j.
const fakeDb = () => {
  const files = new Map();
  const edges = [];
  return {
    files, edges,
    fileHashes: async () => new Map([...files].map(([p, v]) => [p, v.hash])),
    replaceFile: async (t, rel, nodes) => { files.set(rel, { hash: nodes.find((n) => n.label === 'File').sha256, nodes }); },
    nameIndex: async () => [...files.values()].flatMap((f) => f.nodes)
      .filter((n) => !['File', 'Folder', 'Project'].includes(n.label))
      .map((n) => ({ ...n, owner: n.qualified_name.split('.').slice(-2, -1)[0] })),
    writeEdges: async (t, e) => { edges.push(...e); },
  };
};
const T = { user_id: 'u', repo_name: 'proj' };

test('indexes new files, links calls across files, skips unchanged on re-run', async () => {
  const db = fakeDb();
  const src = [
    { rel: 'a.js', source: 'import { b } from "./b.js";\nexport function a() { b(); }\n' },
    { rel: 'b.js', source: 'export function b() {}\n' },
  ];
  const first = await indexFiles(db, T, 'proj', src);
  assert.equal(first.indexed, 2);
  assert.ok(db.edges.some((e) => e.type === 'CALLS' && e.to === 'proj.b.b'));
  assert.ok(db.edges.some((e) => e.type === 'IMPORTS' && e.to === 'proj.b.js'));

  const again = await indexFiles(db, T, 'proj', src);
  assert.equal(again.indexed, 0);
  assert.equal(again.skipped, 2);

  const changed = await indexFiles(db, T, 'proj', [{ rel: 'b.js', source: 'export function b() { return 1; }\n' }]);
  assert.equal(changed.indexed, 1);
});

test('sha256 is stable', () => { assert.equal(sha256('x'), sha256('x')); });

// --- ignore list, worktrees and pruning ---------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexRepository, walk } from '../../src/indexer.js';

const pruningDb = () => {
  const db = fakeDb();
  db.folders = new Set();
  const base = db.replaceFile;
  db.replaceFile = async (t, rel, nodes) => { await base(t, rel, nodes); for (const n of nodes) if (n.label === 'Folder') db.folders.add(n.qualified_name); };
  db.deleteFile = async (t, rel) => { db.files.delete(rel); };
  db.pruneFolders = async (t, keep) => { for (const q of [...db.folders]) if (!keep.has(q)) db.folders.delete(q); };
  db.deleteByPrefix = async (t, prefix) => {
    for (const [p] of [...db.files]) if (p === prefix || p.startsWith(prefix + '/')) db.files.delete(p);
    for (const q of [...db.folders]) if (q.startsWith(`proj.${prefix.replace(/\//g, '.')}`)) db.folders.delete(q);
  };
  return db;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
const put = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

test('(a) .claude/worktrees and nested worktrees yield no nodes', async () => {
  const root = tmp();
  put(root, 'src/a.js', 'export function a() {}\n');
  put(root, '.claude/worktrees/x1/src/a.js', 'export function a() {}\n');
  put(root, 'other/wt/.git', 'gitdir: /somewhere\n');
  put(root, 'other/wt/b.js', 'export function b() {}\n');
  const db = pruningDb();
  // Simulate stale data from an earlier run that did index the worktree.
  db.files.set('.claude/worktrees/x1/old.js', { hash: 'h', nodes: [] });
  db.folders.add('proj..claude.worktrees');
  const r = await indexRepository(db, T, 'proj', root, { ignore: ['node_modules', '.claude/worktrees', '.git'] });
  assert.deepEqual([...db.files.keys()].sort(), ['src/a.js']);
  assert.ok(![...db.folders].some((q) => q.includes('worktrees') || q.includes('other')));
  assert.ok(r.removed >= 1);
  const seen = []; for await (const f of walk(root)) seen.push(path.relative(root, f).split(path.sep).join('/'));
  assert.deepEqual(seen.sort(), ['src/a.js']);
});

test('(b) renamed file: old qualified_name gone, new present, orphan folder pruned', async () => {
  const root = tmp();
  put(root, 'gateway/compose.js', 'export function compose() {}\n');
  const db = pruningDb();
  await indexRepository(db, T, 'proj', root);
  assert.ok(db.files.has('gateway/compose.js'));
  assert.ok(db.folders.has('proj.gateway'));
  fs.mkdirSync(path.join(root, 'router'));
  fs.renameSync(path.join(root, 'gateway/compose.js'), path.join(root, 'router/compose.js'));
  fs.rmdirSync(path.join(root, 'gateway'));
  await indexRepository(db, T, 'proj', root);
  assert.ok(!db.files.has('gateway/compose.js'));
  assert.ok(db.files.has('router/compose.js'));
  assert.ok(!db.folders.has('proj.gateway'));
  assert.ok(db.folders.has('proj.router'));
});
