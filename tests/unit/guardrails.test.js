import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool } from '../../src/mcp.js';
import { Store } from '../../src/store.js';
import { Llm } from '../../src/llm.js';
import { withHud, hudLine, getState, ledger, orphans, appliesToOf } from '../../src/guardrails.js';

function makeCtx(nodes = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  const calls = [];
  const db = {
    async run(cy, params) { calls.push({ cy, params }); return /count\(n\) AS c\b/.test(cy) ? [{ c: nodes }] : []; },
    async purgeProject(t) { calls.push({ purge: t }); return nodes; },
  };
  const store = new Store(dir);
  return { ctx: { db, store, llm: new Llm(store), cfg: {}, tenant: { user_id: 'u1' } }, calls, dir };
}
const PHRASE = 'yes, delete my repo';
const P = 'p';
const LONG = 'Chosen after comparing both options in review.';
const call = (ctx, name, args = {}) => runTool(ctx, name, { project: P, ...args });

// Three docs: K1 is the root, K2 and K3 are flagged needs_review (fewer than 3 docs existed when they were made).
async function seedThreeDocs(ctx) {
  await call(ctx, 'create_doc', { title: 'Root plan', content: 'general overview' });
  await call(ctx, 'create_doc', { title: 'Authentication design', content: 'oauth tokens login session flow' });
  await call(ctx, 'create_doc', { title: 'Billing ledger', content: 'invoices payments stripe charges' });
}

// decision lifecycle

test('decision lifecycle: new decisions are PENDING with ids D1 and D2', async () => {
  const { ctx } = makeCtx();
  const d1 = await call(ctx, 'record_decision', { title: 'Use SQLite' });
  const d2 = await call(ctx, 'record_decision', { title: 'Use Postgres' });
  assert.equal(d1.decision.id, 'D1');
  assert.equal(d1.decision.state, 'PENDING');
  assert.equal(d2.decision.id, 'D2');
  assert.deepEqual(d2.counts, { PENDING: 2, DECIDED: 0, REJECTED: 0 });
});

test('decision lifecycle: DECIDED needs a summary of at least 20 characters', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Cache layer' });
  await assert.rejects(
    call(ctx, 'record_decision', { id: 'D1', state: 'DECIDED', summary: 'too short' }),
    (e) => e.status === 400,
  );
  const ok = await call(ctx, 'record_decision', { id: 'D1', state: 'DECIDED', summary: 'x'.repeat(20) });
  assert.equal(ok.decision.state, 'DECIDED');
});

test('decision lifecycle: REJECTED needs a reason', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Use GraphQL' });
  await assert.rejects(call(ctx, 'record_decision', { id: 'D1', state: 'REJECTED' }), (e) => e.status === 400);
  const ok = await call(ctx, 'record_decision', { id: 'D1', state: 'REJECTED', reason: 'Too heavy for the team' });
  assert.equal(ok.decision.state, 'REJECTED');
});

test('decision lifecycle: moving a DECIDED decision back to PENDING needs a reason', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Queue choice', state: 'DECIDED', summary: LONG });
  await assert.rejects(call(ctx, 'record_decision', { id: 'D1', state: 'PENDING' }), (e) => e.status === 400);
  const ok = await call(ctx, 'record_decision', { id: 'D1', state: 'PENDING', reason: 'New load data' });
  assert.equal(ok.decision.state, 'PENDING');
});

test('decision lifecycle: unknown decision id is 404', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Only one' });
  await assert.rejects(call(ctx, 'record_decision', { id: 'D99', summary: LONG }), (e) => e.status === 404);
});

test('decision lifecycle: invalid state is refused with 400', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(call(ctx, 'record_decision', { title: 'Bad', state: 'MAYBE' }), (e) => e.status === 400);
  assert.equal(ctx.store.get('guardrails', {})['u1/p'], undefined);
});

// set_phase gate

test('set_phase: moving to goldfish_review is blocked while a decision is PENDING', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick vector store' });
  let err;
  await assert.rejects(call(ctx, 'set_phase', { phase: 'goldfish_review' }), (e) => {
    err = e;
    return e.status === 409;
  });
  assert.equal(err.extra.code, 'gate_blocked');
  assert.deepEqual(err.extra.blockers, { pending_decisions: ['D1'], unlinked_docs: [], orphan_decisions: [], unmanifested_docs: [] });
  assert.equal(getState(ctx, P).phase, 'brainstorm');
});

test('set_phase: moving to goldfish_review is blocked while a doc needs review', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1 root
  await call(ctx, 'create_doc', { title: 'Side notes' }); // K2 needs_review
  let err;
  await assert.rejects(call(ctx, 'set_phase', { phase: 'goldfish_review' }), (e) => {
    err = e;
    return e.status === 409;
  });
  assert.equal(err.extra.code, 'gate_blocked');
  assert.deepEqual(err.extra.blockers, { pending_decisions: [], unlinked_docs: ['K2'], orphan_decisions: [], unmanifested_docs: [] });
});

test('set_phase: the gate passes once decisions are resolved and docs are linked', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'create_doc', { title: 'Side notes' }); // K2 needs_review
  await call(ctx, 'record_decision', { title: 'Pick vector store', scope: 'project' }); // D1 PENDING, project-wide so it is never an orphan
  await assert.rejects(call(ctx, 'set_phase', { phase: 'goldfish_review' }), (e) => e.status === 409);

  await call(ctx, 'record_decision', { id: 'D1', state: 'DECIDED', summary: LONG });
  await call(ctx, 'link_doc', { id: 'K2', parent: 'K1' });
  const out = await call(ctx, 'set_phase', { phase: 'goldfish_review' });
  assert.deepEqual(out, { phase: 'goldfish_review', previous: 'brainstorm' });
});

test('set_phase: backward moves and same-phase moves are not gated', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'set_phase', { phase: 'goldfish_review' }); // nothing pending yet, so it passes
  await call(ctx, 'record_decision', { title: 'Late decision' }); // now PENDING
  const same = await call(ctx, 'set_phase', { phase: 'goldfish_review' });
  assert.deepEqual(same, { phase: 'goldfish_review', previous: 'goldfish_review' });
  const back = await call(ctx, 'set_phase', { phase: 'planning' });
  assert.deepEqual(back, { phase: 'planning', previous: 'goldfish_review' });
  // a forward move into a gated phase is still checked
  await assert.rejects(call(ctx, 'set_phase', { phase: 'implementation' }), (e) => e.extra?.code === 'gate_blocked');
});

// create_doc / link_doc

test('create_doc: the first doc is the root and is linked', async () => {
  const { ctx } = makeCtx();
  const out = await call(ctx, 'create_doc', { title: 'Project charter', content: 'Overall goals' });
  assert.deepEqual(out.doc, { id: 'K1', parent: null, link: 'linked', score: null });
  assert.deepEqual(out.suggestions, []);
});

test('create_doc: an explicit parent is linked to that parent', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Project charter' });
  const child = await call(ctx, 'create_doc', { title: 'Auth design', parent: 'K1' });
  assert.equal(child.doc.id, 'K2');
  assert.equal(child.doc.parent, 'K1');
  assert.equal(child.doc.link, 'linked');
});

test('create_doc: an unknown explicit parent is 404', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Project charter' });
  await assert.rejects(call(ctx, 'create_doc', { title: 'Orphan', parent: 'K99' }), (e) => e.status === 404);
});

test('create_doc: with 3+ docs, a doc sharing distinctive words auto-links to that doc', async () => {
  const { ctx } = makeCtx();
  await seedThreeDocs(ctx);
  const k4 = await call(ctx, 'create_doc', { title: 'OAuth login session tokens' });
  assert.equal(k4.doc.id, 'K4');
  assert.equal(k4.doc.parent, 'K2');
  assert.equal(k4.doc.link, 'linked');
  assert.equal(k4.doc.score, 0.57);
  assert.deepEqual(k4.suggestions[0], { id: 'K2', score: 0.57 });
});

test('create_doc: a doc with no overlap is flagged needs_review under the root', async () => {
  const { ctx } = makeCtx();
  await seedThreeDocs(ctx);
  const k4 = await call(ctx, 'create_doc', { title: 'Gardening notes', content: 'roses soil compost' });
  assert.deepEqual(k4.doc, { id: 'K4', parent: 'K1', link: 'needs_review', score: 0 });
});

test('create_doc: consumers are computed on read by guardrail_status, not stored', async () => {
  const { ctx } = makeCtx();
  await seedThreeDocs(ctx);
  await call(ctx, 'create_doc', { title: 'OAuth login session tokens' }); // K4 links under K2
  const st = await call(ctx, 'guardrail_status');
  const byId = Object.fromEntries(st.docs.map((d) => [d.id, d]));
  assert.deepEqual(byId.K2.consumers, ['K4']);
  assert.ok(byId.K1.consumers.includes('K2'));
  assert.deepEqual(byId.K4.consumers, []);
  const stored = ctx.store.get('guardrails', {})['u1/p'];
  assert.equal('consumers' in stored.docs.K2, false);
});

test('link_doc: a link that would create a cycle is refused with code cycle', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'create_doc', { title: 'Design', parent: 'K1' }); // K2
  await call(ctx, 'create_doc', { title: 'Detail', parent: 'K2' }); // K3
  let err;
  await assert.rejects(call(ctx, 'link_doc', { id: 'K2', parent: 'K3' }), (e) => {
    err = e;
    return e.status === 409;
  });
  assert.equal(err.extra.code, 'cycle');
});

test('link_doc: re-parenting the root is refused with 400', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'create_doc', { title: 'Design', parent: 'K1' }); // K2
  await assert.rejects(call(ctx, 'link_doc', { id: 'K1', parent: 'K2' }), (e) => e.status === 400);
});

test('link_doc: a successful link clears needs_review', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'create_doc', { title: 'Side notes' }); // K2 needs_review
  const out = await call(ctx, 'link_doc', { id: 'K2', parent: 'K1' });
  assert.equal(out.doc.link, 'linked');
  assert.equal(out.doc.parent, 'K1');
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.docs.find((d) => d.id === 'K2').link, 'linked');
  assert.equal(st.counts.needs_review, 0);
});

// ledger

test('ledger: add without a doc is refused with 400', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' });
  await assert.rejects(call(ctx, 'manage_ledger', { action: 'add', tasks: [{ title: 'x' }] }), (e) => e.status === 400);
});

test('ledger: add to an unknown doc is 404', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' });
  await assert.rejects(
    call(ctx, 'manage_ledger', { action: 'add', doc: 'K9', tasks: [{ title: 'x' }] }),
    (e) => e.status === 404,
  );
});

test('ledger: updating an unknown task is 404', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' });
  await assert.rejects(
    call(ctx, 'manage_ledger', { action: 'update', task: 'T9', status: 'COMPLETED' }),
    (e) => e.status === 404,
  );
});

test('ledger: a bad task status is refused with 400', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' });
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'Write schema' }] });
  // Through the MCP schema the enum rejects first.
  await assert.rejects(
    call(ctx, 'manage_ledger', { action: 'update', task: 'T1', status: 'DONE' }),
    (e) => e.status === 400,
  );
  // The domain check behind the schema also refuses it and leaves the task untouched.
  assert.throws(() => ledger(getState(ctx, P), { action: 'update', task: 'T1', status: 'DONE' }), (e) => e.status === 400);
  assert.equal(getState(ctx, P).ledger.T1.status, 'TODO');
});

test('ledger: listing tasks does not create a state entry', async () => {
  const { ctx } = makeCtx();
  const out = await call(ctx, 'manage_ledger', { action: 'list' });
  assert.deepEqual(out.tasks, []);
  assert.deepEqual(out.progress, { done: 0, total: 0 });
  assert.deepEqual(ctx.store.get('guardrails', {}), {});
});

// complete_doc

test('complete_doc: a doc with no ledger tasks is refused with empty_ledger', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  let err;
  await assert.rejects(call(ctx, 'complete_doc', { doc: 'K1' }), (e) => {
    err = e;
    return e.status === 409;
  });
  assert.equal(err.extra.code, 'empty_ledger');
});

test('complete_doc: incomplete tasks are refused with remaining titles and progress', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'Write schema' }, { title: 'Write tests' }] });
  await call(ctx, 'manage_ledger', { action: 'update', task: 'T1', status: 'COMPLETED' });
  let err;
  await assert.rejects(call(ctx, 'complete_doc', { doc: 'K1' }), (e) => {
    err = e;
    return e.status === 409;
  });
  assert.equal(err.extra.code, 'incomplete');
  assert.deepEqual(err.extra.remaining, ['Write tests']);
  assert.equal(err.extra.progress, '1/2');
});

test('complete_doc: when every task is complete the doc is marked done', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'Write schema' }, { title: 'Write tests' }] });
  await call(ctx, 'manage_ledger', { action: 'update', task: 'T1', status: 'COMPLETED' });
  await call(ctx, 'manage_ledger', { action: 'update', task: 'T2', status: 'COMPLETED' });
  const out = await call(ctx, 'complete_doc', { doc: 'K1' });
  assert.deepEqual(out, { doc: 'K1', completed: true, progress: '2/2' });
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.docs.find((d) => d.id === 'K1').done, true);
});

// HUD

test('hudLine: implementation always shows a progress bar', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'A' }] }); // T1, so K1 is not unmanifested
  await call(ctx, 'set_phase', { phase: 'implementation' });
  assert.equal(
    hudLine(getState(ctx, P)),
    '[SYNAPTREE HUD] phase=implementation | pending=0 | needs_review=0 | ledger 0/1 ----------',
  );
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'B' }] }); // T2
  await call(ctx, 'manage_ledger', { action: 'update', task: 'T1', status: 'COMPLETED' });
  assert.equal(
    hudLine(getState(ctx, P)),
    '[SYNAPTREE HUD] phase=implementation | pending=0 | needs_review=0 | ledger 1/2 #####-----',
  );
});

test('hudLine: null in other phases when nothing is pending', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' });
  assert.equal(hudLine(getState(ctx, P)), null);
  await call(ctx, 'set_phase', { phase: 'planning' });
  assert.equal(hudLine(getState(ctx, P)), null);
});

test('hudLine: shown in other phases when a decision is pending', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick DB' });
  assert.equal(
    hudLine(getState(ctx, P)),
    '[SYNAPTREE HUD] phase=brainstorm | pending=1 | needs_review=0',
  );
});

test('withHud: appends a second text block when a project has pending items', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick DB' });
  const blocks = [{ type: 'text', text: 'ok' }];
  const out = withHud(ctx, 'create_doc', { project: P }, blocks);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'ok');
  assert.equal(out[1].type, 'text');
  assert.match(out[1].text, /^\[SYNAPTREE HUD\]/);
});

test('withHud: guardrail_status is exempt from the HUD', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick DB' });
  const blocks = [{ type: 'text', text: 'ok' }];
  assert.equal(withHud(ctx, 'guardrail_status', { project: P }, blocks), blocks);
});

test('withHud: no project argument returns the blocks unchanged', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick DB' }); // state exists and would add a HUD
  const blocks = [{ type: 'text', text: 'ok' }];
  assert.equal(withHud(ctx, 'record_decision', {}, blocks), blocks);
});

test('withHud: a project without state returns the blocks unchanged', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick DB' }); // state exists for p, not for fresh
  const blocks = [{ type: 'text', text: 'ok' }];
  assert.equal(withHud(ctx, 'create_doc', { project: 'fresh' }, blocks), blocks);
});

// tenant isolation

test('tenant isolation: the same project name under u1 and u2 has independent state', async () => {
  const { ctx } = makeCtx();
  const other = { ...ctx, tenant: { user_id: 'u2' } };
  await call(ctx, 'record_decision', { title: 'u1 decision' });
  await call(ctx, 'create_doc', { title: 'u1 doc' });
  await call(ctx, 'set_phase', { phase: 'planning' });

  const d = await call(other, 'record_decision', { title: 'u2 decision' });
  assert.equal(d.decision.id, 'D1');

  const s1 = await call(ctx, 'guardrail_status');
  const s2 = await call(other, 'guardrail_status');
  assert.equal(s1.phase, 'planning');
  assert.equal(s2.phase, 'brainstorm');
  assert.deepEqual(s1.decisions.map((x) => x.title), ['u1 decision']);
  assert.deepEqual(s2.decisions.map((x) => x.title), ['u2 decision']);
  assert.equal(s1.docs.length, 1);
  assert.deepEqual(s2.docs, []);
  assert.deepEqual(Object.keys(ctx.store.get('guardrails', {})).sort(), ['u1/p', 'u2/p']);
});

// delete_project cleanup

test('delete_project: the full flow removes the guardrails entry for u1/p and keeps other projects', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick cache' });
  await call(ctx, 'create_doc', { title: 'Root plan' });
  await runTool(ctx, 'record_decision', { project: 'q', title: 'Keep me' });
  assert.ok(ctx.store.get('guardrails', {})['u1/p']);

  const dry = await runTool(ctx, 'delete_project', { project: P, dry_run: true });
  const out = await runTool(ctx, 'delete_project', {
    project: P, delete_token: dry.delete_token, confirm_name: P, confirm_phrase: PHRASE,
  });
  assert.equal(out.deleted, true);
  assert.equal(ctx.store.get('guardrails', {})['u1/p'], undefined);
  assert.ok(ctx.store.get('guardrails', {})['u1/q']);
});

// audit

test('audit: a blocked phase gate writes a gate_blocked event', async () => {
  const { ctx, dir } = makeCtx();
  await call(ctx, 'record_decision', { title: 'Pick vector store' });
  await assert.rejects(call(ctx, 'set_phase', { phase: 'goldfish_review' }), (e) => e.status === 409);

  const events = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = events.find((e) => e.event === 'gate_blocked');
  assert.ok(ev, 'gate_blocked event is written');
  assert.equal(ev.user, 'u1');
  assert.equal(ev.project, P);
  assert.equal(ev.to, 'goldfish_review');
  assert.deepEqual(ev.blockers.pending_decisions, ['D1']);
  assert.equal(events.some((e) => e.event === 'phase_changed'), false);
});

// G1 orphan gate

const ids = (from, to, prefix) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

test('orphans: legacy DECIDED decisions with no stored scope move forward with no orphans', async () => {
  const { ctx } = makeCtx();
  ctx.store.update('guardrails', (all) => {
    all['u1/p'] = {
      phase: 'brainstorm',
      seq: { D: 1, K: 1, T: 1 },
      decisions: { D1: { title: 'Legacy choice', state: 'DECIDED', summary: LONG, reason: '', updated: 0 } },
      docs: { K1: { title: 'Root plan', kind: 'spec', content: '', parent: null, link: 'linked', done: false, created: 0 } },
      ledger: { T1: { doc: 'K1', title: 'Build it', status: 'TODO' } },
      updated: 0,
    };
    return all;
  });
  assert.equal(getState(ctx, P).decisions.D1.scope, undefined);
  assert.deepEqual(orphans(getState(ctx, P)), { orphan_decisions: [], unmanifested_docs: [] });
  await call(ctx, 'set_phase', { phase: 'goldfish_review' });
  await call(ctx, 'set_phase', { phase: 'implementation' });
  assert.equal(getState(ctx, P).phase, 'implementation');
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.counts.orphans, 0);
});

test('orphans: a DECIDED doc-scope decision that no doc references blocks goldfish_review until attached', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'record_decision', { title: 'Cache choice', state: 'DECIDED', summary: LONG }); // D1, scope doc
  let err;
  await assert.rejects(call(ctx, 'set_phase', { phase: 'goldfish_review' }), (e) => {
    err = e;
    return e.status === 409;
  });
  assert.deepEqual(err.extra.blockers.orphan_decisions, ['D1']);
  await call(ctx, 'link_doc', { id: 'K1', decisions: ['D1'] });
  const out = await call(ctx, 'set_phase', { phase: 'goldfish_review' });
  assert.deepEqual(out, { phase: 'goldfish_review', previous: 'brainstorm' });
});

test('link_doc: a decisions-only call leaves an unlinked doc in unlinked_docs', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  await call(ctx, 'create_doc', { title: 'Side notes' }); // K2 needs_review
  await call(ctx, 'record_decision', { title: 'Side choice', state: 'DECIDED', summary: LONG }); // D1
  const out = await call(ctx, 'link_doc', { id: 'K2', decisions: ['D1'] });
  assert.equal(out.doc.link, 'needs_review');
  assert.deepEqual(out.doc.decisions, ['D1']);
  const st = await call(ctx, 'guardrail_status');
  assert.equal(st.docs.find((d) => d.id === 'K2').link, 'needs_review');
  await assert.rejects(
    call(ctx, 'set_phase', { phase: 'goldfish_review' }),
    (e) => e.status === 409 && e.extra.blockers.unlinked_docs.join() === 'K2',
  );
});

test('orphans: the unmanifested kind exemption ignores case and surrounding spaces', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', kind: 'spec' }); // K1
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'Build' }] });
  await call(ctx, 'create_doc', { title: 'Reference notes', kind: '  REFERENCE ', parent: 'K1' }); // K2 exempt
  await call(ctx, 'create_doc', { title: 'Scratch', kind: ' Note', parent: 'K1' }); // K3 exempt
  await call(ctx, 'create_doc', { title: 'Design detail', kind: 'Design', parent: 'K1' }); // K4 not exempt
  assert.deepEqual(orphans(getState(ctx, P)).unmanifested_docs, ['K4']);
  await assert.rejects(
    call(ctx, 'set_phase', { phase: 'implementation' }),
    (e) => e.status === 409 && e.extra.blockers.unmanifested_docs.join() === 'K4',
  );
});

test('decision limit: a doc holds at most 20 decisions, refused with 400 and nothing mutated', async () => {
  const { ctx } = makeCtx();
  for (let i = 1; i <= 21; i++) await call(ctx, 'record_decision', { title: `Choice ${i}` });
  await assert.rejects(call(ctx, 'create_doc', { title: 'Too many', decisions: ids(1, 21, 'D') }), (e) => e.status === 400);
  assert.deepEqual(Object.keys(getState(ctx, P).docs), []);

  await call(ctx, 'create_doc', { title: 'Root plan', decisions: ids(1, 20, 'D') });
  await assert.rejects(call(ctx, 'link_doc', { id: 'K1', decisions: ['D21'] }), (e) => e.status === 400);
  const docs = getState(ctx, P).docs;
  assert.equal(docs.K1.decisions.length, 20);
  assert.equal(docs.K1.decisions.includes('D21'), false);
});

test('decision limit: a decision applies to at most 20 docs, enforced on record_decision and link_doc', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan' }); // K1
  for (let i = 2; i <= 21; i++) await call(ctx, 'create_doc', { title: `Part ${i}`, parent: 'K1' }); // K2..K21
  await assert.rejects(
    call(ctx, 'record_decision', { title: 'Too widely shared', applies_to: ids(1, 21, 'K') }),
    (e) => e.status === 400,
  );
  const shared = await call(ctx, 'record_decision', { title: 'Shared rule', applies_to: ids(1, 20, 'K') });
  assert.equal(shared.decision.applies_to.length, 20);
  await assert.rejects(call(ctx, 'link_doc', { id: 'K21', decisions: ['D1'] }), (e) => e.status === 400);
  assert.deepEqual(getState(ctx, P).docs.K21.decisions, []);
});

test('applies_to: an update replaces the attachment list, omitting it keeps the list, and unknown docs refuse the whole call', async () => {
  const { ctx } = makeCtx();
  await seedThreeDocs(ctx); // K1, K2, K3
  await call(ctx, 'record_decision', { title: 'Use OAuth', applies_to: ['K1', 'K2'] }); // D1
  assert.deepEqual(appliesToOf(getState(ctx, P), 'D1'), ['K1', 'K2']);

  await call(ctx, 'record_decision', { id: 'D1', state: 'DECIDED', summary: LONG }); // applies_to omitted
  assert.deepEqual(appliesToOf(getState(ctx, P), 'D1'), ['K1', 'K2']);

  await call(ctx, 'record_decision', { id: 'D1', applies_to: ['K3'] }); // replaces
  assert.deepEqual(appliesToOf(getState(ctx, P), 'D1'), ['K3']);

  await assert.rejects(call(ctx, 'record_decision', { id: 'D1', applies_to: ['K3', 'K9'] }), (e) => e.status === 404);
  assert.deepEqual(appliesToOf(getState(ctx, P), 'D1'), ['K3']);
  assert.equal(getState(ctx, P).decisions.D1.state, 'DECIDED');
});

test('scope: new decisions default to doc, and updates carry the stored scope forward', async () => {
  const { ctx } = makeCtx();
  const d1 = await call(ctx, 'record_decision', { title: 'Global rule', scope: 'project' });
  const d2 = await call(ctx, 'record_decision', { title: 'Local rule' });
  assert.equal(d1.decision.scope, 'project');
  assert.equal(d2.decision.scope, 'doc');

  await call(ctx, 'record_decision', { id: 'D1', state: 'DECIDED', summary: LONG }); // scope omitted
  assert.equal(getState(ctx, P).decisions.D1.scope, 'project');

  await call(ctx, 'record_decision', { id: 'D2', scope: 'project' }); // explicit change
  assert.equal(getState(ctx, P).decisions.D2.scope, 'project');
  await assert.rejects(call(ctx, 'record_decision', { title: 'Bad scope', scope: 'global' }), (e) => e.status === 400);
});

test('orphans: unmanifested docs are counted in status and HUD only during implementation', async () => {
  const { ctx } = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', kind: 'spec' }); // K1
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K1', tasks: [{ title: 'Build' }] }); // T1
  await call(ctx, 'create_doc', { title: 'Detail', kind: 'design', parent: 'K1' }); // K2
  await call(ctx, 'manage_ledger', { action: 'add', doc: 'K2', tasks: [{ title: 'Detail work' }] }); // T2
  await call(ctx, 'set_phase', { phase: 'goldfish_review' });
  assert.equal((await call(ctx, 'guardrail_status')).counts.orphans, 0);
  await call(ctx, 'set_phase', { phase: 'implementation' });

  await call(ctx, 'create_doc', { title: 'Late detail', kind: 'design', parent: 'K1' }); // K3, leaf with no tasks
  assert.equal((await call(ctx, 'guardrail_status')).counts.orphans, 1);
  assert.equal(hudLine(getState(ctx, P)).includes(' | orphans=1'), true);

  await call(ctx, 'set_phase', { phase: 'planning' }); // backward move, ungated
  assert.equal((await call(ctx, 'guardrail_status')).counts.orphans, 0);
  assert.equal(hudLine(getState(ctx, P)), null);
});
