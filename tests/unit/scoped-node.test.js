import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool } from '../../src/mcp.js';
import { Store } from '../../src/store.js';
import { Llm } from '../../src/llm.js';
import { emptyState, scopedNode, SCOPED_CAP } from '../../src/guardrails.js';

const P = 'p';
const NOW = 1_000_000;
const call = (ctx, name, args = {}) => runTool(ctx, name, { project: P, ...args });
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-'));
  const db = {
    async run() { return []; },
    async purgeProject() { return 0; },
  };
  const store = new Store(dir);
  return { db, store, llm: new Llm(store), cfg: {}, tenant: { user_id: 'u1' } };
}

const doc = (title, extra = {}) => ({
  title, kind: 'design', content: '', parent: null, link: 'linked', done: false, decisions: [], created: 0, ...extra,
});
const dec = (title, state, extra = {}) => ({
  title, state, summary: 'A summary that is long enough to pass.', reason: '', scope: 'doc', updated: 0, ...extra,
});
const task = (doc_, title, status, extra = {}) => ({ doc: doc_, title, status, ...extra });

// Tree: K0 (grandparent) -> K1 (parent) -> K2 (node). K2 and K1 both carry D3, so self must win.
function treeState() {
  const s = emptyState();
  s.phase = 'implementation';
  s.docs = {
    K0: doc('Root', { decisions: ['D9'] }),
    K1: doc('Parent', { parent: 'K0', decisions: ['D2', 'D3'] }),
    K2: doc('Child', { parent: 'K1', decisions: ['D1', 'D3'], content: 'child body text' }),
    K5: doc('Sibling', { parent: 'K1' }),
  };
  s.decisions = {
    D1: dec('Child rule', 'DECIDED'),
    D2: dec('Parent rule rejected', 'REJECTED', { reason: 'too costly' }),
    D3: dec('Shared rule', 'PENDING'),
    D9: dec('Grandparent rule', 'DECIDED'),
  };
  s.seq = { D: 9, K: 5, T: 2 };
  s.ledger = {
    T1: { doc: 'K2', title: 'Write child', status: 'TODO' },
    T2: { doc: 'K1', title: 'Parent task', status: 'COMPLETED' },
  };
  return s;
}

test('doc node: self and parent constraints, direct hops only, self wins on duplicates', () => {
  const out = scopedNode(treeState(), 'K2', { now: NOW });
  assert.equal(out.v, 1);
  assert.equal(out.phase, 'implementation');
  assert.equal(out.node.type, 'doc');
  assert.equal(out.node.parent, 'K1');
  assert.equal(out.node.done, false);
  assert.deepEqual(out.node.progress, { done: 0, total: 1 });
  assert.deepEqual(out.parent, { id: 'K1', title: 'Parent', kind: 'design' });
  // D1 self DECIDED, D3 self wins over parent (PENDING), D2 parent REJECTED. Ordered DECIDED, REJECTED, PENDING.
  assert.deepEqual(out.constraints.map((c) => [c.id, c.state, c.via]), [
    ['D1', 'DECIDED', 'self'],
    ['D2', 'REJECTED', 'parent'],
    ['D3', 'PENDING', 'self'],
  ]);
  assert.equal(out.constraints[1].reason, 'too costly');
  // Grandparent decision D9 is absent.
  assert.ok(!out.constraints.some((c) => c.id === 'D9'));
  assert.deepEqual(out.tasks, [{ id: 'T1', title: 'Write child', status: 'TODO', marker: '[ ]', claimed_by: null, claim: 'none' }]);
  assert.deepEqual(out.children, []);
  assert.deepEqual(out.global_constraints, []);
  assert.deepEqual(out.truncated, { content: false, constraints: 0, tasks: 0, children: 0 });
});

test('doc node reports children, done from the stored doc, and its progress', () => {
  const s = treeState();
  s.docs.K2.done = true;
  const parent = scopedNode(s, 'K1', { now: NOW });
  assert.deepEqual(parent.children.map((c) => c.id).sort(), ['K2', 'K5']);
  assert.equal(parent.children.find((c) => c.id === 'K2').done, true);
  assert.equal(parent.node.done, false);
  assert.deepEqual(parent.node.progress, { done: 1, total: 1 });
  assert.equal(scopedNode(s, 'K2', { now: NOW }).node.done, true);
});

test('task node: doc ref as node.doc and parent, constraints of its doc, no progress, claimable flag', () => {
  const out = scopedNode(treeState(), 'T1', { now: NOW });
  assert.equal(out.node.type, 'task');
  assert.equal(out.node.status, 'TODO');
  assert.equal(out.node.marker, '[ ]');
  assert.deepEqual(out.node.doc, { id: 'K2', title: 'Child', kind: 'design' });
  assert.deepEqual(out.parent, { id: 'K2', title: 'Child', kind: 'design' });
  assert.equal(out.node.claimable, true);
  assert.equal('progress' in out.node, false);
  assert.deepEqual(out.constraints.map((c) => c.id), ['D1', 'D2', 'D3']);
  assert.deepEqual(out.tasks, []);
  assert.deepEqual(out.children, []);
});

test('decision node: applies_to refs, no parent, constraints, tasks or children', () => {
  const s = treeState();
  const out = scopedNode(s, 'D3', { now: NOW });
  assert.equal(out.node.type, 'decision');
  assert.equal(out.node.state, 'PENDING');
  assert.equal(out.node.scope, 'doc');
  assert.deepEqual(out.node.applies_to.map((r) => r.id).sort(), ['K1', 'K2']);
  assert.equal(out.parent, null);
  assert.deepEqual(out.constraints, []);
  assert.deepEqual(out.tasks, []);
  assert.deepEqual(out.children, []);
});

test('global_constraints lists project-scoped decisions (legacy no-scope included) as id, title, state', () => {
  const s = treeState();
  s.decisions.D7 = dec('Project rule', 'DECIDED', { scope: 'project', summary: 'project wide summary text' });
  s.decisions.D8 = { title: 'Legacy rule', state: 'PENDING', summary: '', reason: '', updated: 0 };
  s.decisions.D6 = dec('Doc only', 'DECIDED');
  const out = scopedNode(s, 'K2', { now: NOW });
  // D9 (doc scope) and D6 (doc scope) are excluded; D7 (explicit project) and D8 (legacy, no scope) are included.
  assert.deepEqual(out.global_constraints, [
    { id: 'D7', title: 'Project rule', state: 'DECIDED' },
    { id: 'D8', title: 'Legacy rule', state: 'PENDING' },
  ]);
});

test('global_constraints is capped at 10 entries', () => {
  const s = treeState();
  for (let i = 100; i < 115; i++) s.decisions[`D${i}`] = dec(`Project ${i}`, 'DECIDED', { scope: 'project' });
  assert.equal(scopedNode(s, 'K1', { now: NOW }).global_constraints.length, 10);
});

test('legacy state without decisions, docs.decisions or scope reads as project-wide and does not throw', () => {
  const s = emptyState();
  s.docs = { K1: { title: 'Old root', kind: '', content: 'x', parent: null, link: 'linked', done: false, created: 0 } };
  s.decisions = { D1: { title: 'Old decision', state: 'DECIDED', summary: 'old summary text here', reason: '', updated: 0 } };
  s.seq = { D: 1, K: 1, T: 0 };
  const out = scopedNode(s, 'K1', { now: NOW });
  assert.deepEqual(out.constraints, []);
  assert.deepEqual(out.global_constraints, [{ id: 'D1', title: 'Old decision', state: 'DECIDED' }]);
  assert.equal(out.node.parent, null);
  assert.equal(out.parent, null);
});

test('max_content 0 omits content and reports the cut; default keeps short content', () => {
  const s = treeState();
  const none = scopedNode(s, 'K2', { maxContent: 0, now: NOW });
  assert.equal(none.node.content, '');
  assert.equal(none.truncated.content, true);
  const full = scopedNode(s, 'K2', { now: NOW });
  assert.equal(full.node.content, 'child body text');
  assert.equal(full.truncated.content, false);
});

test('claim: live, expired and none, with claimable and an injected now', () => {
  const s = treeState();
  s.ledger = {
    T1: task('K2', 'live', 'IN_PROGRESS', { claimed_by: 'a1', lease_until: NOW + 5000 }),
    T2: task('K2', 'expired', 'IN_PROGRESS', { claimed_by: 'a2', lease_until: NOW - 1 }),
    T3: task('K2', 'todo', 'TODO'),
    T4: task('K2', 'done', 'COMPLETED', { claimed_by: null, lease_until: NOW - 1 }),
    T5: task('K2', 'no lease', 'IN_PROGRESS'),
  };
  s.seq.T = 5;
  const byId = Object.fromEntries(scopedNode(s, 'K2', { now: NOW }).tasks.map((t) => [t.id, t]));
  assert.equal(byId.T1.claim, 'live');
  assert.equal(byId.T1.claimed_by, 'a1');
  assert.equal(byId.T2.claim, 'expired');
  assert.equal(byId.T3.claim, 'none');
  assert.equal(byId.T3.claimed_by, null);
  assert.equal(byId.T4.claim, 'none');
  assert.equal(byId.T5.claim, 'none');
  assert.equal(byId.T5.marker, '[/]');
  assert.equal(byId.T4.marker, '[x]');

  const task_ = (id) => scopedNode(s, id, { now: NOW }).node;
  assert.equal(task_('T1').claimable, false);
  assert.equal(task_('T2').claimable, true);
  assert.equal(task_('T3').claimable, true);
  assert.equal(task_('T4').claimable, false);
  assert.equal(task_('T5').claimable, true);
  // Same state, later clock: the live lease expires.
  const later = scopedNode(s, 'T1', { now: NOW + 10_000 }).node;
  assert.equal(later.claim, 'expired');
  assert.equal(later.claimable, true);
});

test('byte budget: 20 long constraints and 50 long tasks serialize to at most 12000 bytes', () => {
  const s = emptyState();
  s.phase = 'implementation';
  const long = 'x'.repeat(300);
  const ids = Array.from({ length: 20 }, (_, i) => `D${i + 1}`);
  s.decisions = Object.fromEntries(ids.map((id) => [id, dec(long, 'DECIDED', { summary: 'y'.repeat(400), reason: 'z'.repeat(200) })]));
  s.docs = { K1: doc(long, { content: 'c'.repeat(4096), decisions: ids }) };
  s.ledger = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`T${i + 1}`, task('K1', long, 'TODO', { claimed_by: 'agent-long-name' })]));
  s.seq = { D: 20, K: 1, T: 50 };
  const out = scopedNode(s, 'K1', { now: NOW });
  assert.ok(bytes(out) <= SCOPED_CAP, `size ${bytes(out)}`);
  assert.ok(bytes(out) <= 12000);
  assert.equal(out.node.title.length, 120);
  assert.equal(out.truncated.content, true);
  assert.ok(out.truncated.constraints > 0 || out.constraints.length < 20);
  assert.ok(out.tasks.every((t) => t.title.length === 120));
});

test('budget cuts children beyond 20 and tasks beyond 50 when over the cap', () => {
  const s = emptyState();
  const long = 'q'.repeat(120);
  s.docs = { K1: doc('Root', { content: 'short' }) };
  for (let i = 2; i <= 30; i++) s.docs[`K${i}`] = doc(long, { parent: 'K1', content: '' });
  s.ledger = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`T${i + 1}`, task('K1', long, 'COMPLETED', { claimed_by: 'c'.repeat(200) })]));
  s.seq = { D: 0, K: 30, T: 60 };
  const out = scopedNode(s, 'K1', { now: NOW });
  assert.ok(bytes(out) <= SCOPED_CAP);
  assert.equal(out.children.length, 20);
  assert.equal(out.truncated.children, 9);
  assert.ok(out.truncated.tasks >= 10);
  assert.ok(out.tasks.length <= 50);
});

test('input validation: malformed ids are 400, unknown ids are 404', () => {
  const s = treeState();
  for (const bad of ['k1', 'X1', 'K', 'K1x', 'D-1', ' K1', 'KK1']) {
    assert.throws(() => scopedNode(s, bad, { now: NOW }), (e) => e.status === 400, bad);
  }
  assert.throws(() => scopedNode(s, 'K1', { maxContent: 4097 }), (e) => e.status === 400);
  assert.throws(() => scopedNode(s, 'K1', { maxContent: -1 }), (e) => e.status === 400);
  assert.throws(() => scopedNode(s, 'K99', { now: NOW }), (e) => e.status === 404);
  assert.throws(() => scopedNode(s, 'T99', { now: NOW }), (e) => e.status === 404);
  assert.throws(() => scopedNode(s, 'D99', { now: NOW }), (e) => e.status === 404);
});

test('tool: malformed id 400, unknown id 404, read-only, and another tenant gets 404', async () => {
  const ctx = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', content: 'overview' });
  const other = { ...ctx, tenant: { user_id: 'u2' } };

  await assert.rejects(call(ctx, 'get_scoped_node', { node_id: 'Z1' }), (e) => e.status === 400);
  await assert.rejects(call(ctx, 'get_scoped_node', { node_id: 'K404' }), (e) => e.status === 404);
  await assert.rejects(call(ctx, 'get_scoped_node', { node_id: 'K1', max_content: 9000 }), (e) => e.status === 400);

  const mine = await call(ctx, 'get_scoped_node', { node_id: 'K1' });
  assert.equal(mine.node.id, 'K1');
  assert.equal(mine.node.content, 'overview');

  await assert.rejects(call(other, 'get_scoped_node', { node_id: 'K1' }), (e) => e.status === 404);
  // Reading an unknown project does not create tenant state.
  await assert.rejects(runTool(ctx, 'get_scoped_node', { project: 'never', node_id: 'K1' }), (e) => e.status === 404);
  assert.equal(ctx.store.get('guardrails', {})['u1/never'], undefined);
});

test('tool: max_content 0 through the tool omits content', async () => {
  const ctx = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', content: 'overview' });
  const out = await call(ctx, 'get_scoped_node', { node_id: 'K1', max_content: 0 });
  assert.equal(out.node.content, '');
  assert.equal(out.truncated.content, true);
});

test('tool: decisions linked through the tools resolve as constraints', async () => {
  const ctx = makeCtx();
  await call(ctx, 'create_doc', { title: 'Root plan', content: 'overview of the system design' });
  const d = await call(ctx, 'record_decision', {
    title: 'Use SQLite', state: 'DECIDED', scope: 'doc', summary: 'SQLite is the chosen local store.', applies_to: ['K1'],
  });
  const out = await call(ctx, 'get_scoped_node', { node_id: 'K1' });
  assert.deepEqual(out.constraints.map((c) => [c.id, c.via]), [[d.decision.id, 'self']]);
  const dec_ = await call(ctx, 'get_scoped_node', { node_id: d.decision.id });
  assert.deepEqual(dec_.node.applies_to.map((r) => r.id), ['K1']);
});
