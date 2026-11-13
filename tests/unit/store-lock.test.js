import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store, StoreError } from '../../src/store.js';

const STORE_URL = new URL('../../src/store.js', import.meta.url).href;

function fresh(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function setEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

const lockPath = (d) => path.join(d, 'store.lock');
const storePath = (d) => path.join(d, 'store.json');
const tmpFiles = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));
const staleFiles = (d) => fs.readdirSync(d).filter((f) => f.includes('.stale-'));

function runChild(code, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('error', reject);
    p.on('exit', (exitCode) => (exitCode === 0 ? resolve(out) : reject(new Error(`child exit ${exitCode}: ${err}`))));
  });
}

const isCode = (code, status = 503) => (e) =>
  e instanceof StoreError && e.status === status && e.extra?.code === code && e.extra?.retry === true;

describe('G0 store lock', () => {
  test('four child processes each do 25 updates and none are lost', async (t) => {
    const d = fresh(t);
    new Store(d).set('c', 0);
    const code = `import { Store } from ${JSON.stringify(STORE_URL)};`
      + ` const s = new Store(${JSON.stringify(d)});`
      + ` for (let i = 0; i < 25; i++) s.update('c', (n) => n + 1);`;
    await Promise.all([1, 2, 3, 4].map(() => runChild(code, { SYNAPTREE_LOCK_TIMEOUT_MS: '60000' })));
    assert.equal(new Store(d).get('c'), 100);
  });

  for (const [name, content] of [['valid JSON', '{"pid":1,"host":"x","token":"abc","at":"x"}'], ['garbage', 'not json at all'], ['empty', '']]) {
    test(`old lock with ${name} content is stolen`, (t) => {
      const d = fresh(t);
      const s = new Store(d);
      s.set('k', 1);
      fs.writeFileSync(lockPath(d), content);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath(d), old, old);
      const started = Date.now();
      assert.equal(s.update('k', (n) => n + 1, 0), 2);
      assert.ok(Date.now() - started < 3000, 'steal should not wait for the lock timeout');
      assert.equal(fs.existsSync(lockPath(d)), false);
      assert.deepEqual(staleFiles(d), []);
    });
  }

  test('empty lock with a fresh mtime is not stolen; second writer gets lock_timeout', (t) => {
    setEnv(t, { SYNAPTREE_LOCK_TIMEOUT_MS: '300' });
    const d = fresh(t);
    const s = new Store(d);
    fs.writeFileSync(lockPath(d), '');
    const started = Date.now();
    assert.throws(() => s.set('k', 2), isCode('lock_timeout'));
    assert.ok(Date.now() - started >= 250, 'should wait roughly the configured timeout');
    assert.equal(fs.readFileSync(lockPath(d), 'utf8'), '');
    assert.equal(fs.existsSync(storePath(d)), false, 'nothing was saved');
  });

  test('stealing a live lock makes its holder fail with lock_lost and nothing is saved', (t) => {
    const d = fresh(t);
    const s = new Store(d);
    s.set('k', 'before');
    assert.throws(() => s.withLock((data) => {
      data.k = 'during';
      fs.writeFileSync(lockPath(d), JSON.stringify({ pid: 0, host: 'other', token: 'thief', at: new Date().toISOString() }));
    }), isCode('lock_lost'));
    assert.equal(JSON.parse(fs.readFileSync(storePath(d), 'utf8')).k, 'before');
    assert.equal(s.get('k'), 'before');
    assert.ok(fs.readFileSync(lockPath(d), 'utf8').includes('thief'), 'holder must not remove another lock');
    assert.deepEqual(tmpFiles(d), []);
  });

  test('garbage store.json: update throws store_unreadable and the bytes are unchanged', (t) => {
    const d = fresh(t);
    const s = new Store(d);
    s.set('k', 1);
    fs.writeFileSync(storePath(d), '{not json');
    const before = fs.readFileSync(storePath(d));
    assert.throws(() => s.update('k', (n) => n + 1, 0), isCode('store_unreadable'));
    assert.deepEqual(fs.readFileSync(storePath(d)), before);
    assert.equal(fs.existsSync(lockPath(d)), false, 'lock released');
  });

  test('constructor on a garbage store.json throws store_unreadable instead of starting empty', (t) => {
    const d = fresh(t);
    fs.writeFileSync(storePath(d), '{not json');
    assert.throws(() => new Store(d), isCode('store_unreadable'));
    assert.equal(fs.readFileSync(storePath(d), 'utf8'), '{not json');
  });

  test('fn throws: lock released and memory equals disk afterwards', (t) => {
    const d = fresh(t);
    const s = new Store(d);
    s.set('a', 1);
    assert.throws(() => s.withLock((data) => { data.a = 2; throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lockPath(d)), false);
    assert.equal(s.get('a'), 1);
    assert.equal(new Store(d).get('a'), 1);
  });

  test('rename failure: lock released, temp file removed, memory equals disk', (t) => {
    const d = fresh(t);
    const s = new Store(d);
    s.set('a', 1);
    t.mock.method(fs, 'renameSync', () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; });
    assert.throws(() => s.set('a', 2), /disk full/);
    t.mock.restoreAll();
    assert.equal(fs.existsSync(lockPath(d)), false);
    assert.deepEqual(tmpFiles(d), []);
    assert.equal(s.get('a'), 1);
    assert.equal(new Store(d).get('a'), 1);
  });

  test('nested failure is rolled back; outer changes survive if outer catches, and are discarded if outer throws', (t) => {
    const d = fresh(t);
    const s = new Store(d);
    s.set('a', 1);
    s.withLock((data) => {
      data.a = 2;
      try { s.withLock((inner) => { inner.b = 'partial'; throw new Error('x'); }); } catch { /* outer handles it */ }
    });
    assert.equal(s.get('a'), 2);
    assert.equal(s.get('b'), undefined);
    assert.equal(new Store(d).get('b'), undefined);

    assert.throws(() => s.withLock((data) => {
      data.a = 3;
      s.withLock(() => { throw new Error('inner'); });
    }), /inner/);
    assert.equal(fs.existsSync(lockPath(d)), false);
    assert.equal(s.get('a'), 2);
    assert.equal(new Store(d).get('a'), 2);
  });

  test('nested update inside update keeps the outer unsaved change', (t) => {
    const d = fresh(t);
    const s = new Store(d);
    s.update('outer', () => { s.update('inner', () => 2); return 1; });
    assert.equal(s.get('outer'), 1);
    assert.equal(s.get('inner'), 2);
    const r = new Store(d);
    assert.equal(r.get('outer'), 1);
    assert.equal(r.get('inner'), 2);
  });

  test('reading after another writer saved returns the new value without restart', (t) => {
    const d = fresh(t);
    const a = new Store(d);
    a.set('k', 'x');
    assert.equal(a.get('k'), 'x');
    const b = new Store(d);
    b.set('k', 'a much longer value than before');
    assert.equal(a.get('k'), 'a much longer value than before');
  });

  test('simultaneous first-run stores end up with the same .secret key', async (t) => {
    const d = fresh(t);
    const code = `import { Store } from ${JSON.stringify(STORE_URL)};`
      + ` const s = new Store(${JSON.stringify(d)});`
      + ` process.stdout.write(s.key.toString('hex'));`;
    const keys = await Promise.all(Array.from({ length: 4 }, () => runChild(code, { SYNAPTREE_SECRET: '' })));
    assert.equal(new Set(keys).size, 1, `keys differ: ${keys.join(' ')}`);
    assert.equal(keys[0].length, 64);
    assert.equal(fs.readFileSync(path.join(d, '.secret'), 'utf8'), keys[0]);
  });
});
