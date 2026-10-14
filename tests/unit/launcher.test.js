import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildComposeArgs, pidAlive, readLiveLeases } from '../../src/launcher.js';

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
