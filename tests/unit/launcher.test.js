import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildComposeArgs, pidAlive, readLiveLeases, acquireLock, releaseLock } from '../../src/launcher.js';

const FILE = '/repo/docker-compose.yml';

test('buildComposeArgs up and stop return exact arrays', () => {
  assert.deepEqual(buildComposeArgs(FILE, 'up'), ['compose', '-f', FILE, 'up', '-d', '--wait']);
  assert.deepEqual(buildComposeArgs(FILE, 'stop'), ['compose', '-f', FILE, 'stop']);
});

test('buildComposeArgs throws for down', () => {
  assert.throws(() => buildComposeArgs(FILE, 'down'), Error);
});

test('readLiveLeases keeps live pids and prunes dead or corrupt leases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    fs.writeFileSync(path.join(dir, '111.lease'), JSON.stringify({ pid: 111 }));
    fs.writeFileSync(path.join(dir, '222.lease'), JSON.stringify({ pid: 222 }));
    fs.writeFileSync(path.join(dir, '333.lease'), '{not json');
    const pids = readLiveLeases(dir, (p) => p === 111);
    assert.deepEqual(pids, [111]);
    assert.equal(fs.existsSync(path.join(dir, '111.lease')), true);
    assert.equal(fs.existsSync(path.join(dir, '222.lease')), false);
    assert.equal(fs.existsSync(path.join(dir, '333.lease')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLiveLeases returns [] for a missing directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    assert.deepEqual(readLiveLeases(path.join(dir, 'does-not-exist')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lease filename pattern matches the pid lease and round-trips', () => {
  const name = `${process.pid}.lease`;
  assert.match(name, /^\d+\.lease$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid }));
    assert.deepEqual(readLiveLeases(dir, () => true), [process.pid]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pidAlive reports the current process as alive', () => {
  assert.equal(pidAlive(process.pid), true);
});

test('acquireLock times out while a live owner holds the lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    const lockDir = path.join(dir, 'lock');
    acquireLock(lockDir);
    assert.throws(() => acquireLock(lockDir, { timeoutMs: 200 }), /launcher lock timeout/);
    releaseLock(lockDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseLock lets the lock be acquired again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    const lockDir = path.join(dir, 'lock');
    acquireLock(lockDir);
    releaseLock(lockDir);
    assert.doesNotThrow(() => acquireLock(lockDir));
    releaseLock(lockDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock takes over a lock whose owner is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    const lockDir = path.join(dir, 'lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999 }));
    acquireLock(lockDir, { isAlive: () => false, timeoutMs: 1000 });
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(fs.existsSync(path.join(lockDir, 'owner.json')), true);
    assert.equal(owner.pid, process.pid);
    releaseLock(lockDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
