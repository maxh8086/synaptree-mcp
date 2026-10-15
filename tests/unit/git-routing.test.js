import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runTool, createMcpServer } from '../../src/mcp.js';
import { setMeta } from '../../src/tools.js';
import { Store } from '../../src/store.js';
import { Llm } from '../../src/llm.js';

const HAS_GIT = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// Identity is passed inline so the tests do not depend on the machine's git config.
const GIT_ARGS = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
function git(cwd, ...args) {
  return execFileSync('git', [...GIT_ARGS, ...args], { cwd, stdio: 'pipe' }).toString().trim();
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// In-memory stand-in for the graph db: just enough for indexFiles and detect_changes.
function fakeDb(overrides = {}) {
  const files = new Map();
  return {
    files,
    async run() { return []; },
    async fileHashes() { return new Map(files); },
    async replaceFile(_t, file, nodes) { files.set(file, nodes.find((n) => n.label === 'File')?.sha256 ?? null); },
    async nameIndex() { return []; },
    async writeEdges() {},
    async deleteFile(_t, file) { files.delete(file); },
    ...overrides,
  };
}

function makeCtx(db = fakeDb()) {
  const dir = tmpDir('gr-store-');
  const store = new Store(dir);
  return { ctx: { db, store, llm: new Llm(store), cfg: {}, tenant: { user_id: 'u1' } }, dir };
}

test('search_code git path finds matches in tracked and untracked files', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const repo = tmpDir('gr-repo-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.js\n');
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'const needle = 1;\n');
  git(repo, 'add', '.gitignore', 'tracked.js');
  git(repo, 'commit', '-q', '-m', 'init');
  // Untracked (never added) file: only `git grep --untracked` can see it.
  fs.writeFileSync(path.join(repo, 'untracked.js'), '// needle here\n');
  // Git-ignored file: the git path skips it, while the JS walk would not. Proves the git path ran.
  fs.writeFileSync(path.join(repo, 'ignored.js'), 'const needle = 2;\n');

  const { ctx } = makeCtx();
  setMeta(ctx, 'proj', { root: repo });
  const out = await runTool(ctx, 'search_code', { project: 'proj', pattern: 'needle' });
  const files = out.matches.map((m) => m.file).sort();
  assert.deepEqual(files, ['tracked.js', 'untracked.js']);
});

test('search_code git path matches lines in CRLF files', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const repo = tmpDir('gr-crlf-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'crlf.js'), 'const a = 1;\r\nconst needle = 2;\r\n');
  const { ctx } = makeCtx();
  setMeta(ctx, 'proj', { root: repo });
  const out = await runTool(ctx, 'search_code', { project: 'proj', pattern: 'needle' });
  assert.deepEqual(out.matches.map((m) => [m.file, m.line, m.text]), [['crlf.js', 2, 'const needle = 2;']]);
});

test('search_code with a JS-only pattern uses the JS fallback', async () => {
  const dir = tmpDir('gr-js-');
  fs.writeFileSync(path.join(dir, 'n.js'), 'const answer = 42;\n');
  const { ctx } = makeCtx();
  setMeta(ctx, 'proj', { root: dir });
  // \d is a JS-only escape, so gitGrep returns null and the RegExp path runs.
  const out = await runTool(ctx, 'search_code', { project: 'proj', pattern: '\\d+' });
  assert.ok(out.matches.some((m) => m.file === 'n.js' && m.text.includes('42')), JSON.stringify(out));
});

test('search_code works in a non-git directory (fallback)', async () => {
  const dir = tmpDir('gr-nogit-');
  fs.writeFileSync(path.join(dir, 'x.js'), 'const answer = 7;\n');
  const { ctx } = makeCtx();
  setMeta(ctx, 'proj', { root: dir });
  const out = await runTool(ctx, 'search_code', { project: 'proj', pattern: 'answer' });
  assert.deepEqual(out.matches.map((m) => m.file), ['x.js']);
});

test('detect_changes: index_sha matches head after index, stale only after a new commit', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const repo = tmpDir('gr-stale-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), 'function a() { return 1; }\n');
  git(repo, 'add', 'a.js');
  git(repo, 'commit', '-q', '-m', 'first');

  const { ctx } = makeCtx();
  await runTool(ctx, 'index_repository', { project: 'proj', root_path: repo });
  const head1 = git(repo, 'rev-parse', 'HEAD');

  const before = await runTool(ctx, 'detect_changes', { project: 'proj' });
  assert.equal(before.index_sha, head1);
  assert.equal(before.head_sha, head1);
  assert.equal(before.stale, false);

  fs.writeFileSync(path.join(repo, 'b.js'), 'function b() { return 2; }\n');
  git(repo, 'add', 'b.js');
  git(repo, 'commit', '-q', '-m', 'second');
  const head2 = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(head2, head1);

  const after = await runTool(ctx, 'detect_changes', { project: 'proj' });
  assert.equal(after.head_sha, head2);
  assert.equal(after.index_sha, head1);
  assert.equal(after.stale, true);
});

test('get_code_snippet returns code without CR for a CRLF source file', async () => {
  const dir = tmpDir('gr-crlf-');
  fs.writeFileSync(path.join(dir, 'c.js'), 'function greet() {\r\n  return 1;\r\n}\r\n');
  const node = { qualified_name: 'proj.c.greet', name: 'greet', file_path: 'c.js', start_line: 1, end_line: 3, signature: 'greet()' };
  const db = fakeDb({
    async run(cy) { return /qualified_name:\$q/.test(cy) ? [{ n: node }] : []; },
  });
  const { ctx } = makeCtx(db);
  setMeta(ctx, 'proj', { root: dir });

  // Disk fallback (no stored source).
  const fromDisk = await runTool(ctx, 'get_code_snippet', { project: 'proj', qualified_name: 'proj.c.greet' });
  assert.ok(!fromDisk.code.includes('\r'));
  assert.match(fromDisk.code, /return 1;/);

  // Stored source that itself contains CRLF.
  node.source = 'function greet() {\r\n  return 2;\r\n}';
  const fromStore = await runTool(ctx, 'get_code_snippet', { project: 'proj', qualified_name: 'proj.c.greet' });
  assert.ok(!fromStore.code.includes('\r'));
  assert.match(fromStore.code, /return 2;/);
});

test('MCP text layer: compact by default, JSON when format is json', async () => {
  const dir = tmpDir('gr-mcp-');
  fs.writeFileSync(path.join(dir, 'm.js'), 'const needle = 1;\n');
  const { ctx } = makeCtx();
  setMeta(ctx, 'proj', { root: dir });

  const server = createMcpServer(ctx);
  const client = new Client({ name: 'git-routing-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const compact = await client.callTool({ name: 'search_code', arguments: { project: 'proj', pattern: 'needle' } });
    const compactText = compact.content[0].text;
    assert.ok(!compactText.trimStart().startsWith('{'), compactText);
    assert.match(compactText, /m\.js:1:/);

    const json = await client.callTool({ name: 'search_code', arguments: { project: 'proj', pattern: 'needle', format: 'json' } });
    const parsed = JSON.parse(json.content[0].text);
    assert.equal(parsed.matches[0].file, 'm.js');
  } finally {
    await client.close();
    await server.close();
  }
});

test('(c) index_status reports stale after HEAD changes and fresh after re-index', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const repo = tmpDir('gr-status-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), 'function a() { return 1; }\n');
  git(repo, 'add', 'a.js');
  git(repo, 'commit', '-q', '-m', 'first');
  const { ctx } = makeCtx(fakeDb({ async run() { return [{ nodes: 1, files: 1 }]; } }));
  await runTool(ctx, 'index_repository', { project: 'proj', root_path: repo });
  const fresh = await runTool(ctx, 'index_status', { project: 'proj' });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.index_sha, fresh.head_sha);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
  const stale = await runTool(ctx, 'index_status', { project: 'proj' });
  assert.equal(stale.stale, true);
  assert.notEqual(stale.index_sha, stale.head_sha);
  await runTool(ctx, 'index_repository', { project: 'proj', root_path: repo });
  const again = await runTool(ctx, 'index_status', { project: 'proj' });
  assert.equal(again.stale, false);
});
