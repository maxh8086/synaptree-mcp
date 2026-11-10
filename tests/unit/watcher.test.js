import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { extractMarkdown } from '../../src/extract.js';
import { isHiddenPath, isOnDesignsBranch, createDesignIngestor } from '../../src/watcher.js';

const root = path.resolve('/repo');
const dir = path.join(root, 'docs', 'designs');

test('isOnDesignsBranch traverses only ancestors and docs/designs', () => {
  assert.equal(isOnDesignsBranch(root, root), true);
  assert.equal(isOnDesignsBranch(root, path.join(root, 'docs')), true);
  assert.equal(isOnDesignsBranch(root, dir), true);
  assert.equal(isOnDesignsBranch(root, path.join(dir, 'plan.md')), true);
  assert.equal(isOnDesignsBranch(root, path.join(root, 'node_modules')), false);
  assert.equal(isOnDesignsBranch(root, path.join(root, 'docs', 'other')), false);
  assert.equal(isOnDesignsBranch(root, path.join(dir, '.tmp', 'x.md')), false);
});

test('isHiddenPath ignores dot segments below the watched dir only', () => {
  assert.equal(isHiddenPath(dir, path.join(dir, 'plan.md')), false);
  assert.equal(isHiddenPath(dir, path.join(dir, '.tmp', 'plan.md')), true);
  assert.equal(isHiddenPath(dir, path.join(dir, 'sub', '.swp')), true);
  assert.equal(isHiddenPath(dir, dir), false);
});

function fakeDb() {
  const calls = { deleteFile: [], pruneFolders: [] };
  return {
    calls,
    async deleteFile(t, rel) { calls.deleteFile.push({ t, rel }); },
    async pruneFolders(t, keep) { calls.pruneFolders.push({ t, keep: [...keep] }); },
    async fileHashes() { return new Map([['docs/designs/a.md', 'h']]); },
  };
}

test('remove deletes the orphaned markdown node and prunes folder paths', async () => {
  const db = fakeDb();
  const ing = createDesignIngestor({ db, tenant: { user_id: 'u1' }, project: 'demo', root, log: () => {} });
  await ing.remove(path.join(dir, 'a.md'));
  assert.deepEqual(db.calls.deleteFile, [{ t: { user_id: 'u1', repo_name: 'demo' }, rel: 'docs/designs/a.md' }]);
  assert.equal(db.calls.pruneFolders.length, 1);
  assert.deepEqual(db.calls.pruneFolders[0].keep.sort(), ['demo', 'demo.docs', 'demo.docs.designs'].sort());
});

test('non-markdown events are ignored', async () => {
  const db = fakeDb();
  const ing = createDesignIngestor({ db, tenant: { user_id: 'u1' }, project: 'demo', root, log: () => {} });
  assert.equal(await ing.remove(path.join(dir, 'notes.txt')), null);
  assert.equal(db.calls.deleteFile.length, 0);
});

test('upsert reads the file and routes it through indexFiles as a File with heading Resources', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'syn-watch-'));
  try {
    const d = path.join(tmp, 'docs', 'designs');
    await fs.mkdir(d, { recursive: true });
    const file = path.join(d, 'plan.md');
    await fs.writeFile(file, '# Plan\n\n## Goals\n');
    const db = fakeDb();
    db.fileHashes = async () => new Map();
    const written = [];
    db.replaceFile = async (t, rel, nodes) => { written.push({ rel, nodes }); };
    db.writeEdges = async () => {};
    db.nameIndex = async () => [];
    const ing = createDesignIngestor({ db, tenant: { user_id: 'u1' }, project: 'demo', root: tmp, log: () => {} });
    const stats = await ing.upsert(file);
    assert.equal(stats.indexed, 1);
    assert.equal(written[0].rel, 'docs/designs/plan.md');
    const labels = written[0].nodes.map((n) => n.label);
    assert.ok(labels.includes('File'));
    assert.equal(written[0].nodes.filter((n) => n.label === 'Resource').length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('events are applied one at a time, and a failure does not stop the queue', async () => {
  const order = [];
  const db = fakeDb();
  db.deleteFile = async (t, rel) => {
    order.push(`start:${rel}`);
    await new Promise((r) => setTimeout(r, 10));
    if (rel.endsWith('bad.md')) throw new Error('boom');
    order.push(`end:${rel}`);
  };
  const logs = [];
  const ing = createDesignIngestor({ db, tenant: { user_id: 'u1' }, project: 'demo', root, log: (m) => logs.push(m) });
  ing.remove(path.join(dir, 'bad.md'));
  await ing.remove(path.join(dir, 'ok.md'));
  // bad.md throws before its "end" marker; ok.md must only start after bad.md has settled.
  assert.deepEqual(order, ['start:docs/designs/bad.md', 'start:docs/designs/ok.md', 'end:docs/designs/ok.md']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /boom/);
});

test('extractMarkdown handles CRLF line endings', () => {
  const src = '# Plan\r\n\r\n## Goals\r\nbody\r\n';
  const out = extractMarkdown(src);
  assert.deepEqual(out.symbols.map((s) => [s.name, s.start, s.end]), [
    ['Plan', 1, 2],
    ['Goals', 3, 5],
  ]);
  assert.equal(out.symbols[0].signature, '# Plan');
});

test('extractMarkdown maps headings to Resource spans and ignores fenced code', () => {
  const src = ['# Title', 'intro', '## Goals', '```', '# not a heading', '```', '### Deep', 'end'].join('\n');
  const out = extractMarkdown(src);
  assert.deepEqual(out.symbols.map((s) => [s.name, s.kind, s.start, s.end]), [
    ['Title', 'Resource', 1, 2],
    ['Goals', 'Resource', 3, 6],
    ['Deep', 'Resource', 7, 8],
  ]);
  assert.equal(out.symbols[0].signature, '# Title');
});
