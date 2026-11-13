import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool } from '../../src/mcp.js';
import { Store } from '../../src/store.js';
import { Llm } from '../../src/llm.js';
import { getState, hudLine } from '../../src/guardrails.js';

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  const db = {
    async run() { return []; },
    async purgeProject() { return 0; },
  };
  const store = new Store(dir);
  return { ctx: { db, store, llm: new Llm(store), cfg: {}, tenant: { user_id: 'u1' } }, dir };
}

const P = 'p';
const LONG = 'Chosen after comparing both options in review.';
const call = (ctx, name, args = {}) => runTool(ctx, name, { project: P, ...args });

// Resolves to the rejection error, or fails the test when the call succeeds.
async function failOf(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to be refused');
}

const codesOf = (e) => e.extra.reasons.map((r) => r.code);
const auditEvents = (dir) => {
  const file = path.join(dir, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// K1 reference root (no tasks, so it is not an unmanifested doc), K2 and K3 spec docs with tasks.
// Tasks: T1 and T2 belong to K2, T3 to K3. Ends in phase implementation with the gate clear.
async function seedHappy(ctx) {
  await call(ctx, 'create_doc', { title: 'Root plan', kind: 'reference', content: 'overview' });
  await call(ctx, 'create_doc', { title: 'Feature A', kind: 'spec', parent: 'K1', content: 'a' });
  await call(ctx, 'create_doc', { title: 'Feature B', kind: 'spec', parent: 'K1', content: 'b' });
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K2', tasks: [{ title: 'Build A1' }, { title: 'Build A2' }] });
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K3', tasks: [{ title: 'Build B1' }] });
  await call(ctx, 'set_phase', { phase: 'implementation' });
}

const setTask = (ctx, task, status, extra = {}) => call(ctx, 'manage_ledger', { action: 'update', task, status, ...extra });

async function completeEverything(ctx) {
  for (const t of ['T1', 'T2', 'T3']) await setTask(ctx, t, 'COMPLETED');
  await call(ctx, 'complete_doc', { doc: 'K2' });
  await call(ctx, 'complete_doc', { doc: 'K3' });
}

async function finishedProject() {
  const { ctx, dir } = makeCtx();
  await seedHappy(ctx);
  await completeEverything(ctx);
  await call(ctx, 'finish_project');
  return { ctx, dir };
}

test('complete_doc on K2 succeeds while K3 has open tasks', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  await setTask(ctx, 'T1', 'COMPLETED');
  await setTask(ctx, 'T2', 'COMPLETED');
  const out = await call(ctx, 'complete_doc', { doc: 'K2' });
  assert.equal(out.completed, true);
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.docs.find((d) => d.id === 'K2').done, true);
  assert.equal(st.docs.find((d) => d.id === 'K3').done, false);
});

test('finish_project and set_phase complete reject on the same fixture with identical reason codes', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  await call(ctx, 'record_decision', { title: 'Pick cache backend' });

  const e1 = await failOf(call(ctx, 'finish_project'));
  const e2 = await failOf(call(ctx, 'set_phase', { phase: 'complete' }));
  assert.equal(e1.status, 409);
  assert.equal(e1.extra.code, 'finish_blocked');
  assert.equal(e2.status, 409);
  assert.equal(e2.extra.code, 'finish_blocked');
  assert.deepEqual(codesOf(e1), codesOf(e2));
  assert.deepEqual(codesOf(e1), ['incomplete', 'docs_not_done', 'gate_blocked']);
  assert.equal((await call(ctx, 'guardrail_status')).phase, 'implementation');
});

test('reason wrong_phase is reported alone when everything else is clear', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  await completeEverything(ctx);
  await call(ctx, 'set_phase', { phase: 'planning' });
  const e = await failOf(call(ctx, 'finish_project'));
  assert.deepEqual(codesOf(e), ['wrong_phase']);
  assert.equal(e.extra.reasons[0].phase, 'planning');
});

test('reason empty_ledger is reported alone for a project with no tasks', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', kind: 'reference', content: 'overview' });
  await call(ctx, 'set_phase', { phase: 'implementation' });
  const e = await failOf(call(ctx, 'finish_project'));
  assert.deepEqual(codesOf(e), ['empty_ledger']);
});

test('reason incomplete reports the count and items; an open task also keeps its doc not done', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  await setTask(ctx, 'T1', 'COMPLETED');
  const e = await failOf(call(ctx, 'finish_project'));
  assert.deepEqual(codesOf(e), ['incomplete', 'docs_not_done']);
  const inc = e.extra.reasons.find((r) => r.code === 'incomplete');
  assert.equal(inc.count, 2);
  assert.deepEqual(inc.items.map((i) => i.id), ['T2', 'T3']);
  assert.deepEqual(inc.items[0], { id: 'T2', title: 'Build A2', status: 'TODO', claimed_by: null });
  const dn = e.extra.reasons.find((r) => r.code === 'docs_not_done');
  assert.deepEqual(dn.docs, ['K2', 'K3']);
});

test('reason incomplete caps items at 20 and keeps the full count', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', kind: 'reference', content: 'overview' });
  await call(ctx, 'create_doc', { title: 'Big feature', kind: 'spec', parent: 'K1', content: 'big' });
  const tasks = Array.from({ length: 25 }, (_, i) => ({ title: `Task ${i + 1}` }));
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K2', tasks });
  await call(ctx, 'set_phase', { phase: 'implementation' });
  const e = await failOf(call(ctx, 'finish_project'));
  const inc = e.extra.reasons.find((r) => r.code === 'incomplete');
  assert.equal(inc.count, 25);
  assert.equal(inc.items.length, 20);
});

test('reason docs_not_done is reported alone when all tasks are COMPLETED but a doc is not signed off', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  for (const t of ['T1', 'T2', 'T3']) await setTask(ctx, t, 'COMPLETED');
  const e = await failOf(call(ctx, 'finish_project'));
  assert.deepEqual(codesOf(e), ['docs_not_done']);
  assert.deepEqual(e.extra.reasons[0].docs, ['K2', 'K3']);
});

test('reason gate_blocked is reported alone when a pending decision remains', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  await completeEverything(ctx);
  await call(ctx, 'record_decision', { title: 'Pick cache backend' });
  const e = await failOf(call(ctx, 'finish_project'));
  assert.deepEqual(codesOf(e), ['gate_blocked']);
  assert.deepEqual(e.extra.reasons[0].blockers.pending_decisions, ['D1']);
});

test('success path: finish_project sets phase complete and writes project_finished', async () => {
  const { ctx, dir } = makeCtx();
  await seedHappy(ctx);
  await completeEverything(ctx);
  const out = await call(ctx, 'finish_project');
  assert.equal(out.phase, 'complete');
  assert.equal(out.previous, 'implementation');
  assert.equal((await call(ctx, 'guardrail_status')).phase, 'complete');
  assert.ok(auditEvents(dir).find((e) => e.event === 'project_finished'), 'project_finished is written');
});

test('mutations are refused with project_complete while the project is complete', async () => {
  const { ctx } = await finishedProject();
  const refused = [
    ['create_doc', { title: 'Late doc' }],
    ['record_decision', { title: 'Late decision' }],
    ['link_doc', { id: 'K2', parent: 'K1' }],
    ['manage_ledger', { action: 'add', doc: 'K2', tasks: [{ title: 'Late task' }] }],
    ['manage_ledger', { action: 'update', task: 'T1', status: 'TODO' }],
    ['complete_doc', { doc: 'K2' }],
  ];
  for (const [name, args] of refused) {
    const e = await failOf(call(ctx, name, args));
    assert.equal(e.status, 409, `${name} is refused with 409`);
    assert.equal(e.extra.code, 'project_complete', `${name} carries project_complete`);
  }
  assert.equal((await call(ctx, 'manage_ledger', { action: 'list' })).tasks.length, 3);
});

test('reopen then re-finish: set_phase implementation is ungated and re-finish passes again', async () => {
  const { ctx, dir } = await finishedProject();
  const back = await call(ctx, 'set_phase', { phase: 'implementation' });
  assert.equal(back.previous, 'complete');
  assert.equal(back.phase, 'implementation');
  assert.ok(auditEvents(dir).find((e) => e.event === 'phase_changed' && e.from === 'complete' && e.to === 'implementation'));
  const out = await call(ctx, 'finish_project');
  assert.equal(out.phase, 'complete');
});

test('reopen then a new task blocks re-finish, because the full check runs again', async () => {
  const { ctx, dir } = await finishedProject();
  await call(ctx, 'set_phase', { phase: 'implementation' });
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K3', tasks: [{ title: 'Late B2' }] });
  const e = await failOf(call(ctx, 'finish_project'));
  assert.deepEqual(codesOf(e), ['incomplete', 'docs_not_done']);
  const reopen = auditEvents(dir).find((ev) => ev.event === 'doc_reopened' && ev.doc === 'K3');
  assert.ok(reopen, 'doc_reopened is written for K3');
});

test('manage_ledger add on a done doc reopens it and audits doc_reopened', async () => {
  const { ctx, dir } = makeCtx();
  await seedHappy(ctx);
  await completeEverything(ctx);
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K2', tasks: [{ title: 'Follow-up A3' }] });
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.docs.find((d) => d.id === 'K2').done, false);
  assert.equal(st.docs.find((d) => d.id === 'K3').done, true);
  const ev = auditEvents(dir).find((e) => e.event === 'doc_reopened');
  assert.equal(ev.doc, 'K2');
});

test('a COMPLETED to TODO status change in a done doc reopens it', async () => {
  const { ctx, dir } = makeCtx();
  await seedHappy(ctx);
  await setTask(ctx, 'T1', 'COMPLETED');
  await setTask(ctx, 'T2', 'COMPLETED');
  await call(ctx, 'complete_doc', { doc: 'K2' });
  await setTask(ctx, 'T1', 'TODO');
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.docs.find((d) => d.id === 'K2').done, false);
  assert.ok(auditEvents(dir).find((e) => e.event === 'doc_reopened' && e.doc === 'K2'));
});

test('finish_blocked audit event is written with the reasons', async () => {
  const { ctx, dir } = makeCtx();
  await seedHappy(ctx);
  await failOf(call(ctx, 'finish_project'));
  const ev = auditEvents(dir).find((e) => e.event === 'finish_blocked');
  assert.ok(ev, 'finish_blocked event is written');
  assert.deepEqual(ev.reasons.map((r) => r.code), ['incomplete', 'docs_not_done']);
});

test('set_phase complete is accepted by the schema and reaches the finish checks (409, not 400)', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  const e = await failOf(call(ctx, 'set_phase', { phase: 'complete' }));
  assert.equal(e.status, 409);
  assert.equal(e.extra.code, 'finish_blocked');
});

test('marker aliases [ ], [/], [x] are accepted and normalized, with a marker field in the output', async () => {
  const { ctx } = makeCtx();
  await seedHappy(ctx);
  const doing = await setTask(ctx, 'T1', '[/]', { agent_id: 'orchestrator' });
  assert.equal(doing.tasks.find((t) => t.id === 'T1').status, 'IN_PROGRESS');
  assert.equal(doing.tasks.find((t) => t.id === 'T1').marker, '[/]');
  const done = await setTask(ctx, 'T1', '[x]', { agent_id: 'orchestrator' });
  assert.equal(done.tasks.find((t) => t.id === 'T1').status, 'COMPLETED');
  assert.equal(done.tasks.find((t) => t.id === 'T1').marker, '[x]');
  const todo = await setTask(ctx, 'T1', '[ ]');
  assert.equal(todo.tasks.find((t) => t.id === 'T1').status, 'TODO');
  assert.equal(todo.tasks.find((t) => t.id === 'T1').marker, '[ ]');
  const e = await failOf(setTask(ctx, 'T1', '[?]'));
  assert.equal(e.status, 400);
});

test('HUD in complete phase shows the phase and the full ledger bar', async () => {
  const { ctx } = await finishedProject();
  assert.equal(
    hudLine(getState(ctx, P)),
    '[SYNAPTREE HUD] phase=complete | pending=0 | needs_review=0 | ledger 3/3 ##########',
  );
});
