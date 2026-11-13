import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Error raised by the store. `status` is an HTTP-style code; `extra` carries machine-readable fields
// such as { code, retry }. mcp.js and server.js already report e.status and e.extra for any error.
export class StoreError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.extra = extra;
  }
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, ms); }
function jitter(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

const LOCK_RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function envMs(name, fallback) {
  const raw = process.env[name];
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Bounded retry for reads that can fail transiently (torn rename on Windows, a parse of a half-written file).
// Five tries total, 10 to 50 ms apart, then a retriable 503.
function retryUnreadable(op) {
  for (let i = 0; i < 5; i++) {
    try { return op(); } catch { if (i < 4) sleepSync(jitter(10, 50)); }
  }
  throw new StoreError('store.json is unreadable; retry shortly', 503, { code: 'store_unreadable', retry: true });
}

// Returns a freshness stamp for the store file, or null when it does not exist.
function statStamp(file) {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// rename with up to 5 retries on the codes Windows virus scanners and indexers produce.
function renameWithRetry(from, to) {
  for (let retries = 0; ; retries++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || retries >= 5) throw e;
      sleepSync(jitter(10, 50));
    }
  }
}

// Replace the contents of `target` in place so that object identity is preserved.
function replaceContents(target, src) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, src);
}

// Small JSON-file store for synaptree's own metadata (project roots, annotations, ADRs, settings, usage, audit log).
// It never touches the user's repository or the databases an ERD is read from.
//
// Cross-process safety: every write goes through withLock(fn), which takes <dir>/store.lock, re-reads the file,
// runs fn on the fresh data, and atomically replaces store.json. Reads only re-read when the file's stamp changes.
export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'store.json');
    this.lockFile = path.join(this.dir, 'store.lock');
    this._depth = 0;
    this.data = {};
    this.stamp = undefined; // undefined = unknown, reload on next access
    this._load();
    this.key = this._key();
  }

  _key() {
    const env = process.env.SYNAPTREE_SECRET;
    if (env) return crypto.createHash('sha256').update(env).digest();
    const f = path.join(this.dir, '.secret');
    const existing = () => {
      try {
        const b = Buffer.from(fs.readFileSync(f, 'utf8'), 'hex');
        return b.length ? b : null;
      } catch { return null; }
    };
    const first = existing();
    if (first) return first;
    const k = crypto.randomBytes(32);
    try {
      fs.writeFileSync(f, k.toString('hex'), { mode: 0o600, flag: 'wx' });
      return k;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Another first-run process created the file. Use its key; it may still be being written, so poll briefly.
    for (let i = 0; i < 100; i++) {
      const b = existing();
      if (b) return b;
      sleepSync(jitter(5, 25));
    }
    throw new StoreError('.secret is unreadable; retry shortly', 503, { code: 'store_unreadable', retry: true });
  }

  get(k, d) {
    if (this._depth === 0) this._sync();
    return this.data[k] ?? d;
  }

  set(k, v) {
    return this.withLock((data) => { data[k] = v; return v; });
  }

  update(k, fn, d = {}) {
    return this.withLock((data) => {
      const v = fn(structuredClone(data[k] ?? d));
      data[k] = v;
      return v;
    });
  }

  // Commit lifecycle: acquire, reload, fn, save, release. fn must be synchronous.
  // A nested call runs fn inline; if it throws, its partial changes are rolled back and the outer transaction continues.
  withLock(fn) {
    if (this._depth > 0) {
      const snap = structuredClone(this.data);
      try { return fn(this.data); } catch (e) {
        replaceContents(this.data, snap);
        throw e;
      }
    }
    const token = this._acquire();
    this._depth = 1;
    let committed = false;
    try {
      this._load();
      const out = fn(this.data);
      this._commit(token);
      committed = true;
      return out;
    } finally {
      this._depth = 0;
      if (!committed) this.stamp = undefined; // memory must not serve a mutation that was not committed
      this._release(token);
    }
  }

  // Reads the file and returns { data, stamp }. Only ENOENT maps to {}. Anything else is retried, then thrown.
  _readFresh() {
    return retryUnreadable(() => {
      const stamp = statStamp(this.file); // stamp taken before the read: a concurrent write only causes an extra reload
      if (stamp === null) return { data: {}, stamp };
      return { data: JSON.parse(fs.readFileSync(this.file, 'utf8')), stamp };
    });
  }

  _load() {
    const { data, stamp } = this._readFresh();
    this.data = data;
    this.stamp = stamp;
  }

  _sync() {
    if (this.stamp !== undefined && retryUnreadable(() => statStamp(this.file)) === this.stamp) return;
    this._load();
  }

  _acquire() {
    const timeoutMs = envMs('SYNAPTREE_LOCK_TIMEOUT_MS', 5000);
    const staleMs = envMs('SYNAPTREE_LOCK_STALE_MS', 10000);
    const started = Date.now();
    for (;;) {
      const token = crypto.randomBytes(16).toString('hex');
      let fd;
      try {
        fd = fs.openSync(this.lockFile, 'wx');
      } catch (e) {
        if (!LOCK_RETRY_CODES.has(e.code)) throw e;
      }
      if (fd !== undefined) {
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() }));
        } catch (e) {
          fs.closeSync(fd);
          fs.rmSync(this.lockFile, { force: true });
          throw e;
        }
        fs.closeSync(fd);
        return token;
      }
      this._stealIfStale(staleMs);
      if (Date.now() - started >= timeoutMs) {
        throw new StoreError('store is locked by another process; retry shortly', 503, { code: 'lock_timeout', retry: true });
      }
      sleepSync(jitter(5, 25));
    }
  }

  // Stale rule: mtime only. An empty or unparsable lock is live until its mtime is old enough.
  _stealIfStale(staleMs) {
    let mtimeMs;
    try { mtimeMs = fs.statSync(this.lockFile).mtimeMs; } catch { return; }
    if (Date.now() - mtimeMs < staleMs) return;
    const moved = `${this.lockFile}.stale-${crypto.randomBytes(6).toString('hex')}`;
    try { fs.renameSync(this.lockFile, moved); } catch { return; } // another stealer got there first; caller retries
    try { fs.rmSync(moved, { force: true }); } catch { /* left behind; harmless */ }
  }

  // Fence: true only if store.lock still carries our token.
  _holds(token) {
    return retryUnreadable(() => {
      let text;
      try { text = fs.readFileSync(this.lockFile, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
      }
      try { return JSON.parse(text)?.token === token; } catch { return false; }
    });
  }

  _commit(token) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      if (!this._holds(token)) {
        throw new StoreError('lock was taken over during the write; nothing was saved; retry', 503, { code: 'lock_lost', retry: true });
      }
      renameWithRetry(tmp, this.file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
    this.stamp = retryUnreadable(() => statStamp(this.file));
  }

  _release(token) {
    for (let i = 0; i < 5; i++) {
      try {
        const cur = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
        if (cur?.token !== token) return; // not ours any more
        fs.unlinkSync(this.lockFile);
        return;
      } catch (e) {
        if (e.code === 'ENOENT' || e instanceof SyntaxError) return;
        sleepSync(jitter(10, 50));
      }
    }
  }

  seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  open(sealed) {
    if (!sealed) return '';
    const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }

  audit(event) {
    fs.appendFileSync(path.join(this.dir, 'audit.log'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }
}
