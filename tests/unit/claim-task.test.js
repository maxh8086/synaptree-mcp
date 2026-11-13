import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runTool } from '../../src/mcp.js';
import { Store } from '../../src/store.js';
import { Llm } from '../../src/llm.js';
import { mutate, getState, hudLine, claimTask } from '../../src/guardrails.js';

const STORE_URL = new URL('../../src/store.js', import.meta.url).href;
const GUARD_URL = new URL('../../src/guardrails.js', import.meta.url).href;

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const db = {
    async run() { return []; },
    async purgeProject() { return 0; },
  };
  const store = new Store(dir);
  return { ctx: { db, store, llm: new Llm(store), cfg: {}, tenant: { user_id: 'u1' } }, dir };
}

const P = 'p';
const call = (ctx, name, args = {}) => runTool(ctx, name, { project: P, ...args });
const claim = (ctx, task_id, agent_id, extra = {}) => call(ctx, 'claim_task', { task_id, agent_id, ...extra });
const setTask = (ctx, task, status, extra = {}) => call(ctx, 'manage_ledger', { action: 'update', task, status, ...extra });
const taskOf = (ctx, id) => getState(ctx, P).ledger[id];

// Resolves to the rejection error, or fails the test when the call succeeds.
async function failOf(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to be refused');
}

const auditEvents = (dir) => {
  const file = path.join(dir, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// One doc K1 with tasks T1..T3 (all TODO, claim fields null) in the given phase.
function seedTasks(ctx, phase) {
  mutate(ctx, P, (s) => {
    s.phase = phase;
    s.docs.K1 = { title: 'Feature', kind: 'spec', content: 'c', parent: null, link: 'linked', done: false, decisions: [], created: 1 };
    s.seq.K = 1;
    s.seq.T = 3;
    for (const id of ['T1', 'T2', 'T3']) {
      s.ledger[id] = { doc: 'K1', title: `Task ${id}`, status: 'TODO', claimed_by: null, claimed_at: null, lease_until: null };
    }
  });
}
const seedImpl = (ctx) => seedTasks(ctx, 'implementation');

// Makes a live lease expired without waiting.
const expire = (ctx, task) => mutate(ctx, P, (s) => { s.ledger[task].lease_until = Date.now() - 1; });

const CHILD = `
import { Store } from ${JSON.stringify(STORE_URL)};
import { mutate, claimTask } from ${JSON.stringify(GUARD_URL)};
const store = new Store(process.env.DATA_DIR);
const ctx = { store, tenant: { user_id: 'u1' } };
try {
  const out = mutate(ctx, 'p', (s) => claimTask(s, { task_id: 'T1', agent_id: process.env.AGENT_ID }));
  process.stdout.write(JSON.stringify({ ok: true, claimed_by: out.task.claimed_by }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, status: e.status, code: e.extra && e.extra.code }));
}
`;

function runChild(dir, agent) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { ...process.env, DATA_DIR: dir, AGENT_ID: agent },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(out));
      else reject(new Error(`child ${agent} exited ${code}: ${err}`));
    });
  });
}

test('concurrent claims from child processes: exactly one succeeds', async () => {
  const { ctx, dir } = makeCtx();
  seedImpl(ctx);
  const agents = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
  const results = await Promise.all(agents.map((a) => runChild(dir, a)));
  const wins = results.filter((r) => r.ok);
  assert.equal(wins.length, 1, JSON.stringify(results));
  const losers = results.filter((r) => !r.ok);
  assert.equal(losers.length, agents.length - 1);
  assert.ok(losers.every((r) => r.status === 409 && r.code === 'claimed'), JSON.stringify(losers));
  assert.equal(taskOf(ctx, 'T1').claimed_by, wins[0].claimed_by);
});

test('claim sets the claim fields and the task view', async () => {
  const { ctx, dir } = makeCtx();
  seedImpl(ctx);
  const out = await claim(ctx, 'T1', 'alpha', { lease_seconds: 60 });
  assert.equal(out.renewed, false);
  assert.equal(out.reclaimed, false);
  assert.deepEqual(out.task.id, 'T1');
  assert.equal(out.task.status, 'IN_PROGRESS');
  assert.equal(out.task.marker, '[/]');
  assert.equal(out.task.claimed_by, 'alpha');
  assert.equal(typeof out.task.lease_until, 'number');
  assert.deepEqual(out.progress, { done: 0, total: 3 });
  const t = taskOf(ctx, 'T1');
  assert.equal(t.claimed_by, 'alpha');
  assert.equal(typeof t.claimed_at, 'number');
  assert.equal(t.lease_until, out.task.lease_until);
  assert.deepEqual(auditEvents(dir).filter((e) => e.event === 'task_claimed').map((e) => e.task), ['T1']);
});

test('same agent renews: new lease, claimed_at kept, renewed true', async () => {
  const { ctx, dir } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha', { lease_seconds: 60 });
  const before = taskOf(ctx, 'T1');
  const again = await claim(ctx, 'T1', 'alpha', { lease_seconds: 600 });
  assert.equal(again.renewed, true);
  assert.equal(again.reclaimed, false);
  const after = taskOf(ctx, 'T1');
  assert.equal(after.claimed_at, before.claimed_at);
  assert.ok(after.lease_until > before.lease_until);
  assert.ok(after.lease_until - before.lease_until > 500_000);
  // renewals are not audited
  assert.equal(auditEvents(dir).filter((e) => e.event === 'task_claimed').length, 1);
});

test('live lease held by another agent refuses with claimed and the holder', () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  const t0 = 1_000_000;
  mutate(ctx, P, (s) => claimTask(s, { task_id: 'T1', agent_id: 'alpha', lease_seconds: 30 }, t0));
  assert.throws(
    () => mutate(ctx, P, (s) => claimTask(s, { task_id: 'T1', agent_id: 'beta' }, t0 + 29_000)),
    (e) => e.status === 409 && e.extra.code === 'claimed' && e.extra.claimed_by === 'alpha' && e.extra.lease_until === t0 + 30_000,
  );
});

test('expired lease is reclaimed with an injected clock', () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  const t0 = 1_000_000;
  mutate(ctx, P, (s) => claimTask(s, { task_id: 'T1', agent_id: 'alpha', lease_seconds: 30 }, t0));
  const out = mutate(ctx, P, (s) => claimTask(s, { task_id: 'T1', agent_id: 'beta' }, t0 + 31_000));
  assert.equal(out.reclaimed, true);
  assert.equal(out.renewed, false);
  assert.equal(out.previous_agent, 'alpha');
  assert.equal(out.task.claimed_by, 'beta');
  assert.equal(taskOf(ctx, 'T1').claimed_by, 'beta');
});

test('reclaiming an expired lease through the tool audits task_reclaimed with previous_agent', async () => {
  const { ctx, dir } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha');
  expire(ctx, 'T1');
  const out = await claim(ctx, 'T1', 'beta');
  assert.equal(out.reclaimed, true);
  const ev = auditEvents(dir).find((e) => e.event === 'task_reclaimed');
  assert.ok(ev, 'task_reclaimed audit written');
  assert.equal(ev.previous_agent, 'alpha');
  assert.equal(ev.agent, 'beta');
  assert.equal(ev.task, 'T1');
});

test('claim_task refused outside implementation with wrong_phase', async () => {
  for (const phase of ['brainstorm', 'planning', 'goldfish_review']) {
    const { ctx } = makeCtx();
    seedTasks(ctx, phase);
    const e = await failOf(claim(ctx, 'T1', 'alpha'));
    assert.equal(e.status, 409, phase);
    assert.equal(e.extra.code, 'wrong_phase', phase);
    assert.equal(taskOf(ctx, 'T1').claimed_by, null);
  }
});

test('claim_task refused in a complete project with project_complete', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  mutate(ctx, P, (s) => { s.phase = 'complete'; });
  const e = await failOf(claim(ctx, 'T1', 'alpha'));
  assert.equal(e.status, 409);
  assert.equal(e.extra.code, 'project_complete');
});

test('claim_task on a completed task refuses with already_completed', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  await setTask(ctx, 'T1', 'COMPLETED');
  const e = await failOf(claim(ctx, 'T1', 'alpha'));
  assert.equal(e.status, 409);
  assert.equal(e.extra.code, 'already_completed');
});

test('unknown task is 404', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  const e = await failOf(claim(ctx, 'T99', 'alpha'));
  assert.equal(e.status, 404);
});

test('agent_id format is enforced with 400; valid ids are accepted', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  for (const bad of ['', '-x', '.leading', 'a b', 'a/b', 'x'.repeat(65)]) {
    const e = await failOf(claim(ctx, 'T1', bad));
    assert.equal(e.status, 400, JSON.stringify(bad));
  }
  await claim(ctx, 'T1', 'agent-1.a:b_c');
  await claim(ctx, 'T2', 'x'.repeat(64));
  await claim(ctx, 'T3', 'A');
  assert.equal(taskOf(ctx, 'T2').claimed_by, 'x'.repeat(64));
});

test('lease_seconds outside 30..3600 is refused', () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  for (const bad of [29, 3601, 1.5]) {
    assert.throws(
      () => mutate(ctx, P, (s) => claimTask(s, { task_id: 'T1', agent_id: 'alpha', lease_seconds: bad })),
      (e) => e.status === 400,
    );
  }
});

test('manage_ledger enforces ownership of a live claim', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha');
  let e = await failOf(setTask(ctx, 'T1', 'COMPLETED'));
  assert.equal(e.status, 409);
  assert.equal(e.extra.code, 'claimed_by_other');
  e = await failOf(setTask(ctx, 'T1', 'COMPLETED', { agent_id: 'beta' }));
  assert.equal(e.extra.code, 'claimed_by_other');
  e = await failOf(setTask(ctx, 'T1', 'TODO', { agent_id: 'beta' }));
  assert.equal(e.extra.code, 'claimed_by_other');
  const ok = await setTask(ctx, 'T1', 'COMPLETED', { agent_id: 'alpha' });
  const row = ok.tasks.find((t) => t.id === 'T1');
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.marker, '[x]');
  assert.equal(taskOf(ctx, 'T1').claimed_by, 'alpha');
  assert.equal(taskOf(ctx, 'T1').lease_until, null);
});

test('expired lease: anyone may release to TODO, only the claimant may mark COMPLETED', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha');
  expire(ctx, 'T1');
  const e = await failOf(setTask(ctx, 'T1', 'COMPLETED', { agent_id: 'beta' }));
  assert.equal(e.status, 409);
  assert.equal(e.extra.code, 'claimed_by_other');
  await setTask(ctx, 'T1', 'TODO', { agent_id: 'beta' });
  const t = taskOf(ctx, 'T1');
  assert.equal(t.status, 'TODO');
  assert.equal(t.claimed_by, null);
  assert.equal(t.claimed_at, null);
  assert.equal(t.lease_until, null);
});

test('null-lease COMPLETED task is releasable to TODO by anyone', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha');
  await setTask(ctx, 'T1', 'COMPLETED', { agent_id: 'alpha' });
  assert.equal(taskOf(ctx, 'T1').lease_until, null);
  assert.equal(taskOf(ctx, 'T1').claimed_by, 'alpha');
  await setTask(ctx, 'T1', 'TODO');
  const t = taskOf(ctx, 'T1');
  assert.equal(t.status, 'TODO');
  assert.equal(t.claimed_by, null);
});

test('force without a reason is 400 and writes no audit; force with a reason is audited', async () => {
  const { ctx, dir } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha');

  const e = await failOf(setTask(ctx, 'T1', 'TODO', { agent_id: 'beta', force: true }));
  assert.equal(e.status, 400);
  assert.equal(taskOf(ctx, 'T1').claimed_by, 'alpha');
  assert.equal(auditEvents(dir).filter((x) => x.event === 'ledger_forced').length, 0);

  const e2 = await failOf(setTask(ctx, 'T1', 'TODO', { force: true, reason: '   ' }));
  assert.equal(e2.status, 400);

  await setTask(ctx, 'T1', 'TODO', { agent_id: 'beta', force: true, reason: 'alpha vanished' });
  assert.equal(taskOf(ctx, 'T1').status, 'TODO');
  assert.equal(taskOf(ctx, 'T1').claimed_by, null);
  const ev = auditEvents(dir).find((x) => x.event === 'ledger_forced');
  assert.ok(ev, 'ledger_forced audit written');
  assert.equal(ev.previous_owner, 'alpha');
  assert.equal(ev.reason, 'alpha vanished');
  assert.equal(ev.task, 'T1');
});

test('force completes a task owned by another agent with a reason', async () => {
  const { ctx, dir } = makeCtx();
  seedImpl(ctx);
  await claim(ctx, 'T1', 'alpha');
  await setTask(ctx, 'T1', 'COMPLETED', { force: true, reason: 'orchestrator sign-off' });
  assert.equal(taskOf(ctx, 'T1').status, 'COMPLETED');
  assert.equal(taskOf(ctx, 'T1').lease_until, null);
  assert.equal(auditEvents(dir).find((x) => x.event === 'ledger_forced').previous_owner, 'alpha');
});

test('marker aliases map to statuses and IN_PROGRESS in implementation requires agent_id', async () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  const e = await failOf(setTask(ctx, 'T1', '[/]'));
  assert.equal(e.status, 400);
  assert.equal(e.extra.code, 'agent_id_required');
  assert.equal(taskOf(ctx, 'T1').status, 'TODO');

  const started = await setTask(ctx, 'T1', '[/]', { agent_id: 'alpha' });
  const row = started.tasks.find((t) => t.id === 'T1');
  assert.equal(row.status, 'IN_PROGRESS');
  assert.equal(row.marker, '[/]');
  assert.equal(taskOf(ctx, 'T1').claimed_by, 'alpha');

  const done = await setTask(ctx, 'T1', '[x]', { agent_id: 'alpha' });
  assert.equal(done.tasks.find((t) => t.id === 'T1').marker, '[x]');

  const back = await setTask(ctx, 'T1', '[ ]');
  const backRow = back.tasks.find((t) => t.id === 'T1');
  assert.equal(backRow.status, 'TODO');
  assert.equal(backRow.marker, '[ ]');
});

test('IN_PROGRESS outside implementation does not require agent_id', async () => {
  const { ctx } = makeCtx();
  seedTasks(ctx, 'brainstorm');
  await setTask(ctx, 'T1', 'IN_PROGRESS');
  const t = taskOf(ctx, 'T1');
  assert.equal(t.status, 'IN_PROGRESS');
  assert.equal(t.claimed_by, null);
});

test('legacy unclaimed task (no claim fields) updates without agent_id', async () => {
  const { ctx } = makeCtx();
  mutate(ctx, P, (s) => {
    s.phase = 'implementation';
    s.docs.K1 = { title: 'Legacy', kind: 'spec', content: '', parent: null, link: 'linked', done: false, decisions: [], created: 1 };
    s.seq.K = 1;
    s.seq.T = 1;
    s.ledger.T1 = { doc: 'K1', title: 'legacy task', status: 'TODO' };
  });
  const out = await setTask(ctx, 'T1', 'COMPLETED');
  assert.equal(out.tasks.find((t) => t.id === 'T1').status, 'COMPLETED');
});

test('HUD shows in_progress and stale in implementation with exact strings', () => {
  const { ctx } = makeCtx();
  seedImpl(ctx);
  const now = 5_000_000;
  mutate(ctx, P, (s) => {
    claimTask(s, { task_id: 'T1', agent_id: 'alpha', lease_seconds: 60 }, now);
    claimTask(s, { task_id: 'T2', agent_id: 'beta', lease_seconds: 30 }, now - 40_000);
  });
  const s = getState(ctx, P);
  assert.equal(
    hudLine(s, now),
    '[SYNAPTREE HUD] phase=implementation | pending=0 | needs_review=0 | ledger 0/3 ---------- | in_progress=2 | stale=1',
  );
  assert.equal(
    hudLine(s, now + 120_000),
    '[SYNAPTREE HUD] phase=implementation | pending=0 | needs_review=0 | ledger 0/3 ---------- | in_progress=2 | stale=2',
  );
  assert.equal(
    hudLine(s, now - 1_000_000),
    '[SYNAPTREE HUD] phase=implementation | pending=0 | needs_review=0 | ledger 0/3 ---------- | in_progress=2',
  );
});

test('HUD has no in_progress fragment outside implementation', () => {
  const { ctx } = makeCtx();
  seedTasks(ctx, 'brainstorm');
  mutate(ctx, P, (s) => { s.ledger.T1.status = 'IN_PROGRESS'; });
  assert.equal(hudLine(getState(ctx, P)), null);
});
