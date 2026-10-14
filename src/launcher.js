import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const composeFile = process.env.SYNAPTREE_COMPOSE_FILE || path.resolve(here, '..', 'docker-compose.yml');
const container = process.env.SYNAPTREE_CONTAINER || 'synaptree-synaptree-1';
const leaseDir = process.env.SYNAPTREE_LEASE_DIR || path.join(os.tmpdir(), 'synaptree-leases');
const upAttempts = Number(process.env.SYNAPTREE_UP_ATTEMPTS) || 3;
const upRetryMs = Number(process.env.SYNAPTREE_UP_RETRY_MS) || 5000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function buildComposeArgs(file, action) {
  if (action === 'up') return ['compose', '-f', file, 'up', '-d', '--wait'];
  if (action === 'stop') return ['compose', '-f', file, 'stop'];
  throw new Error(`unsupported compose action: ${action}`);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLiveLeases(dir, isAlive = pidAlive) {
  if (!fs.existsSync(dir)) return [];
  const pids = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.lease')) continue;
    const file = path.join(dir, name);
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      continue;
    }
    if (!isAlive(pid)) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      continue;
    }
    pids.push(pid);
  }
  return pids;
}

function isStaleLock(lockDir, isAlive) {
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).pid;
  } catch {
    try {
      return Date.now() - fs.statSync(lockDir).mtimeMs > 5000;
    } catch {
      return false;
    }
  }
  return !isAlive(pid);
}

export function acquireLock(lockDir, { timeoutMs = 120000, isAlive = pidAlive } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isStaleLock(lockDir, isAlive)) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
        continue;
      }
      if (Date.now() - start >= timeoutMs) throw new Error('launcher lock timeout');
      Atomics.wait(sleepCell, 0, 0, 50);
      continue;
    }
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }));
    return;
  }
}

export function releaseLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function main() {
  fs.mkdirSync(leaseDir, { recursive: true });

  const lockDir = path.join(leaseDir, '.lock');
  const leaseFile = path.join(leaseDir, `${process.pid}.lease`);
  try {
    acquireLock(lockDir);
    try {
      readLiveLeases(leaseDir);
      fs.writeFileSync(
        leaseFile,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
    } finally {
      releaseLock(lockDir);
    }
  } catch (err) {
    process.stderr.write('launcher: ' + err.message + '\n');
    process.exit(1);
  }

  let cleaned = false;
  let child = null;
  let stdinEnded = false;
  let onStdinEnd = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* ignore */ }
    }
    try { fs.rmSync(leaseFile, { force: true }); } catch { /* ignore */ }
    try {
      acquireLock(lockDir);
    } catch (err) {
      process.stderr.write('launcher: warning, could not acquire lock, skipping compose stop: ' + err.message + '\n');
      return;
    }
    try {
      let live = [];
      try { live = readLiveLeases(leaseDir); } catch { /* ignore */ }
      if (live.length === 0) {
        spawnSync('docker', buildComposeArgs(composeFile, 'stop'), {
          stdio: ['ignore', process.stderr, process.stderr],
        });
      }
    } finally {
      releaseLock(lockDir);
    }
  };

  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => process.exit(128));
  }

  process.stdin.on('end', () => {
    stdinEnded = true;
    if (onStdinEnd) onStdinEnd();
  });

  const scheduleKill = () => {
    setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }, 1000);
  };

  // Docker Desktop may still be starting when the client connects, so retry `up` a few times.
  const composeUp = (attempt) => {
    const up = spawn('docker', buildComposeArgs(composeFile, 'up'), {
      stdio: ['ignore', process.stderr, process.stderr],
    });
    let handled = false;
    const onFail = (code) => {
      if (handled) return;
      handled = true;
      if (attempt < upAttempts) {
        process.stderr.write(`launcher: docker compose up failed (exit ${code}), retry ${attempt + 1}/${upAttempts} in ${upRetryMs}ms\n`);
        setTimeout(() => composeUp(attempt + 1), upRetryMs);
        return;
      }
      process.stderr.write(`launcher: docker compose up failed after ${attempt} attempts (exit ${code})\n`);
      try { fs.rmSync(leaseFile, { force: true }); } catch { /* ignore */ }
      process.exit(1);
    };
    up.on('exit', (code) => {
      if (handled) return;
      if (code === 0) {
        handled = true;
        if (stdinEnded) {
          cleanup();
          process.exit(0);
        }
        startBridge();
        return;
      }
      onFail(code);
    });
    up.on('error', (err) => {
      if (handled) return;
      process.stderr.write('launcher: docker compose up error: ' + err.message + '\n');
      onFail(null);
    });
  };
  composeUp(1);

  function startBridge() {
    child = spawn('docker', ['exec', '-i', container, 'node', 'src/cli.js', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    onStdinEnd = scheduleKill;
    if (stdinEnded) scheduleKill();
    child.on('close', (code, signal) => {
      cleanup();
      process.exit(stdinEnded ? 0 : (signal ? 1 : (code ?? 0)));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
