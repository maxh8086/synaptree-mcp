// Guardrails: decision log, phase gate, doc linking and task ledger per (tenant, project).
// Pure logic on top of the Store. Imports nothing but node builtins (none needed) so it can be
// used from tools.js without a circular import.

export class GuardError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const PHASES = ['brainstorm', 'planning', 'goldfish_review', 'implementation', 'complete'];
export const GATED = new Set(['goldfish_review', 'implementation']);
export const LIMITS = { docs: 200, tasks: 500, decisions: 100, content: 4096 };
export const LINK = { MIN_SCORE: 0.35, MIN_MARGIN: 0.10, MIN_CANDIDATES: 3 };
export const MAX_DECISION_LINKS = 20;
export const DECISION_SCOPES = ['doc', 'project'];
// Agent ids are self-asserted and advisory (see the claim_task description), not authentication.
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const LEASE = { MIN: 30, MAX: 3600, DEFAULT: 900 };
// Doc kinds that never need an execution ledger entry.
export const NON_EXECUTABLE_KINDS = ['reference', 'note', 'research'];

const DECISION_STATES = ['PENDING', 'DECIDED', 'REJECTED'];
const TASK_STATES = ['TODO', 'IN_PROGRESS', 'COMPLETED'];
// Checkbox markers accepted as aliases for task statuses in manage_ledger.
const MARKER_ALIASES = { '[ ]': 'TODO', '[/]': 'IN_PROGRESS', '[x]': 'COMPLETED' };
const normalizeStatus = (v) => (Object.prototype.hasOwnProperty.call(MARKER_ALIASES, v) ? MARKER_ALIASES[v] : v);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'but', 'you', 'your',
  'have', 'has', 'will', 'can', 'all', 'any', 'into', 'out', 'use', 'used', 'using', 'per', 'via',
  'its', 'our', 'they', 'them', 'than', 'then', 'when', 'what', 'which', 'each', 'such', 'more',
  'also', 'only', 'should',
]);

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// Docs without a stored decisions list read as []. Decisions without a stored scope are legacy
// project-wide decisions, so existing projects are never blocked by the orphan rule.
export const docDecisions = (doc) => doc.decisions ?? [];
export const decisionScope = (d) => d.scope ?? 'project';

export function emptyState() {
  return { phase: 'brainstorm', seq: { D: 0, K: 0, T: 0 }, decisions: {}, docs: {}, ledger: {}, updated: 0 };
}

export const key = (ctx, project) => `${ctx.tenant.user_id}/${project}`;

// Read-only: never writes.
export function getState(ctx, project) {
  const all = ctx.store.get('guardrails', {});
  const k = key(ctx, project);
  return has(all, k) ? all[k] : emptyState();
}

export function hasState(ctx, project) {
  return has(ctx.store.get('guardrails', {}), key(ctx, project));
}

// store.update clones first and writes nothing if fn throws, so every operation validates before mutating.
export function mutate(ctx, project, fn) {
  let out;
  const k = key(ctx, project);
  ctx.store.update('guardrails', (all) => {
    const s = (all[k] ??= emptyState());
    out = fn(s);
    s.updated = Date.now();
    return all;
  });
  return out;
}

// Every guardrail mutation calls this first. A complete project is read-only except for set_phase (reopen).
export function assertMutable(s) {
  if (s.phase === 'complete') {
    throw new GuardError(409, 'project is complete; reopen it with set_phase implementation', { code: 'project_complete' });
  }
}

export function tokenize(text) {
  const out = new Set();
  for (const t of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

export function docTokens(doc) {
  return tokenize(`${doc.title ?? ''} ${(doc.content ?? '').slice(0, 500)}`);
}

// docs: object id -> doc. Returns [{id, score}] sorted by score desc (unrounded).
export function scoreDocs(newText, docs) {
  const entries = Object.keys(docs).map((id) => ({ id, toks: docTokens(docs[id]) }));
  const N = entries.length;
  const df = new Map();
  for (const e of entries) for (const t of e.toks) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t) => Math.log(1 + N / df.get(t));
  const q = tokenize(newText);
  const scored = entries.map(({ id, toks }) => {
    if (toks.size === 0) return { id, score: 0 };
    let num = 0;
    let den = 0;
    for (const t of toks) {
      const w = idf(t);
      den += w;
      if (q.has(t)) num += w;
    }
    return { id, score: den ? num / den : 0 };
  });
  return scored.sort((x, y) => y.score - x.score);
}

export function consumersOf(s, id) {
  return Object.keys(s.docs).filter((k) => s.docs[k].parent === id);
}

// Doc ids that carry the given decision (computed from doc.decisions, never stored on the decision).
export function appliesToOf(s, id) {
  return Object.keys(s.docs).filter((k) => docDecisions(s.docs[k]).includes(id));
}

export function progress(s, doc) {
  const tasks = Object.values(s.ledger).filter((t) => doc == null || t.doc === doc);
  return { done: tasks.filter((t) => t.status === 'COMPLETED').length, total: tasks.length };
}

// Validates an optional id array: undefined passes through, anything else must be an array of
// non-empty strings with no more than `max` distinct entries. Returns the de-duplicated list.
function idList(value, field, max = MAX_DECISION_LINKS) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => nonEmpty(v))) {
    throw new GuardError(400, `${field} must be an array of ids`);
  }
  const out = [...new Set(value)];
  if (out.length > max) throw new GuardError(400, `${field} accepts at most ${max} ids`);
  return out;
}

const pendingCount = (s) => Object.keys(s.decisions).filter((id) => s.decisions[id].state === 'PENDING').length;
const needsReviewCount = (s) => Object.keys(s.docs).filter((id) => s.docs[id].link === 'needs_review').length;

// Computed, never stored.
//   orphan_decisions: DECIDED, scope 'doc', referenced by no doc. PENDING is already a blocker; REJECTED is a record.
//   unmanifested_docs: leaf doc, zero ledger tasks, not done, kind not in NON_EXECUTABLE_KINDS.
// Phase is not considered here; gateBlockers and the status and HUD counts decide when each applies.
export function orphans(s) {
  const attached = new Set();
  for (const id of Object.keys(s.docs)) for (const d of docDecisions(s.docs[id])) attached.add(d);

  const orphan_decisions = Object.keys(s.decisions).filter((id) => {
    const d = s.decisions[id];
    return d.state === 'DECIDED' && decisionScope(d) === 'doc' && !attached.has(id);
  });

  const unmanifested_docs = Object.keys(s.docs).filter((id) => {
    const doc = s.docs[id];
    if (doc.done) return false;
    if (consumersOf(s, id).length > 0) return false;
    if (progress(s, id).total > 0) return false;
    return !NON_EXECUTABLE_KINDS.includes(String(doc.kind ?? '').trim().toLowerCase());
  });

  return { orphan_decisions, unmanifested_docs };
}

// Orphan count as shown in status and the HUD. Unmanifested docs count only during implementation.
export function orphanCount(s) {
  const o = orphans(s);
  return o.orphan_decisions.length + (s.phase === 'implementation' ? o.unmanifested_docs.length : 0);
}

// Always returns all four keys. unmanifested_docs is evaluated only for the implementation target.
export function gateBlockers(s, target) {
  const o = orphans(s);
  return {
    pending_decisions: Object.keys(s.decisions).filter((id) => s.decisions[id].state === 'PENDING'),
    unlinked_docs: Object.keys(s.docs).filter((id) => s.docs[id].link === 'needs_review'),
    orphan_decisions: o.orphan_decisions,
    unmanifested_docs: target === 'implementation' ? o.unmanifested_docs : [],
  };
}

function countDecisionStates(decisions) {
  const counts = { PENDING: 0, DECIDED: 0, REJECTED: 0 };
  for (const id of Object.keys(decisions)) counts[decisions[id].state] = (counts[decisions[id].state] ?? 0) + 1;
  return counts;
}

export function recordDecision(s, a = {}) {
  assertMutable(s);
  const { id, title, state, summary, reason, scope } = a;
  if (state !== undefined && !DECISION_STATES.includes(state)) {
    throw new GuardError(400, `invalid decision state: ${state}`);
  }
  if (scope !== undefined && !DECISION_SCOPES.includes(scope)) {
    throw new GuardError(400, `invalid decision scope: ${scope}`);
  }
  const appliesTo = idList(a.applies_to, 'applies_to');
  for (const docId of appliesTo ?? []) {
    if (!has(s.docs, docId)) throw new GuardError(404, `doc ${docId} not found`);
  }

  let rec;
  const isNew = id === undefined || id === null || id === '';
  if (isNew) {
    if (!nonEmpty(title)) throw new GuardError(400, 'decision title is required');
    if (Object.keys(s.decisions).length >= LIMITS.decisions) throw new GuardError(400, 'decision limit reached');
    rec = {
      title: title.trim(),
      state: state ?? 'PENDING',
      summary: summary ?? '',
      reason: reason ?? '',
      scope: scope ?? 'doc',
    };
  } else {
    if (!has(s.decisions, id)) throw new GuardError(404, `decision ${id} not found`);
    const prev = s.decisions[id];
    if (title !== undefined && !nonEmpty(title)) throw new GuardError(400, 'decision title cannot be empty');
    rec = {
      title: title !== undefined ? title.trim() : prev.title,
      state: state ?? prev.state,
      summary: summary ?? prev.summary,
      reason: reason ?? prev.reason,
      scope: scope ?? decisionScope(prev),
    };
    if (rec.state === 'PENDING' && prev.state !== 'PENDING' && !nonEmpty(reason)) {
      throw new GuardError(400, 'a reason is required to move a decision back to PENDING');
    }
  }

  if (rec.state === 'DECIDED' && String(rec.summary ?? '').trim().length < 20) {
    throw new GuardError(400, 'a DECIDED decision needs a summary of at least 20 characters');
  }
  if (rec.state === 'REJECTED' && !nonEmpty(rec.reason)) {
    throw new GuardError(400, 'a REJECTED decision needs a reason');
  }

  // All checks happen before the first write, so a refusal leaves s untouched.
  const finalId = isNew ? 'D' + (s.seq.D + 1) : id;
  for (const docId of appliesTo ?? []) {
    const cur = docDecisions(s.docs[docId]);
    if (!cur.includes(finalId) && cur.length >= MAX_DECISION_LINKS) {
      throw new GuardError(400, `doc ${docId} already has ${MAX_DECISION_LINKS} decisions`);
    }
  }

  if (isNew) s.seq.D += 1;
  s.decisions[finalId] = { ...rec, updated: Date.now() };

  // applies_to replaces the attachment list. Omitted leaves every doc untouched.
  if (appliesTo !== undefined) {
    for (const docId of Object.keys(s.docs)) {
      const cur = docDecisions(s.docs[docId]);
      const want = appliesTo.includes(docId);
      const attached = cur.includes(finalId);
      if (want && !attached) s.docs[docId].decisions = [...cur, finalId];
      else if (!want && attached) s.docs[docId].decisions = cur.filter((x) => x !== finalId);
    }
  }

  return {
    decision: { id: finalId, ...s.decisions[finalId], applies_to: appliesToOf(s, finalId) },
    counts: countDecisionStates(s.decisions),
  };
}

export const FINISH_ITEM_CAP = 20;

// The only place that decides whether the project may close. Collects every failed reason, then throws once.
export function enforceImplementationProgress(s) {
  const reasons = [];
  if (s.phase !== 'implementation') reasons.push({ code: 'wrong_phase', phase: s.phase });

  const taskIds = Object.keys(s.ledger);
  if (taskIds.length === 0) reasons.push({ code: 'empty_ledger' });

  const open = taskIds.filter((id) => s.ledger[id].status !== 'COMPLETED');
  if (open.length > 0) {
    reasons.push({
      code: 'incomplete',
      count: open.length,
      items: open.slice(0, FINISH_ITEM_CAP).map((id) => ({
        id,
        title: s.ledger[id].title,
        status: s.ledger[id].status,
        claimed_by: s.ledger[id].claimed_by ?? null,
      })),
    });
  }

  const docsNotDone = Object.keys(s.docs).filter((id) => s.docs[id].done !== true && progress(s, id).total > 0);
  if (docsNotDone.length > 0) reasons.push({ code: 'docs_not_done', docs: docsNotDone });

  const blockers = gateBlockers(s, 'implementation');
  if (Object.values(blockers).some((list) => list.length > 0)) reasons.push({ code: 'gate_blocked', blockers });

  if (reasons.length > 0) {
    throw new GuardError(409, `project cannot finish: ${reasons.map((r) => r.code).join(', ')}`, {
      code: 'finish_blocked',
      reasons,
    });
  }
  return { ok: true };
}

export function setPhase(s, { phase } = {}) {
  if (!PHASES.includes(phase)) throw new GuardError(400, `invalid phase: ${phase}`);
  const previous = s.phase;
  if (phase === 'complete') {
    enforceImplementationProgress(s);
    s.phase = 'complete';
    return { phase, previous };
  }
  if (phase === previous) return { phase, previous };

  if (GATED.has(phase) && PHASES.indexOf(phase) > PHASES.indexOf(previous)) {
    const blockers = gateBlockers(s, phase);
    if (Object.values(blockers).some((list) => list.length > 0)) {
      throw new GuardError(
        409,
        'phase gate blocked: resolve pending decisions, unlinked docs, orphan decisions and unmanifested docs first',
        { code: 'gate_blocked', blockers },
      );
    }
  }
  s.phase = phase;
  return { phase, previous };
}

export function createDoc(s, { title, kind, content, parent, decisions } = {}) {
  assertMutable(s);
  if (!nonEmpty(title)) throw new GuardError(400, 'doc title is required');
  if (Object.keys(s.docs).length >= LIMITS.docs) throw new GuardError(400, 'doc limit reached');
  const decs = idList(decisions, 'decisions') ?? [];
  for (const decId of decs) {
    if (!has(s.decisions, decId)) throw new GuardError(404, `decision ${decId} not found`);
    if (appliesToOf(s, decId).length >= MAX_DECISION_LINKS) {
      throw new GuardError(400, `decision ${decId} already applies to ${MAX_DECISION_LINKS} docs`);
    }
  }
  const body = String(content ?? '').slice(0, LIMITS.content);
  const docIds = Object.keys(s.docs);
  const scores = docIds.length ? scoreDocs(`${title} ${body.slice(0, 500)}`, s.docs) : [];
  const suggestions = scores.slice(0, 3).map((x) => ({ id: x.id, score: round2(x.score) }));

  let parentId;
  let link;
  let score = null;
  if (parent) {
    if (!has(s.docs, parent)) throw new GuardError(404, `parent doc ${parent} not found`);
    parentId = parent;
    link = 'linked';
  } else if (docIds.length === 0) {
    parentId = null;
    link = 'linked';
  } else {
    const best = scores[0];
    const second = scores[1] ?? { score: 0 };
    if (
      docIds.length >= LINK.MIN_CANDIDATES &&
      best.score >= LINK.MIN_SCORE &&
      best.score - second.score >= LINK.MIN_MARGIN
    ) {
      parentId = best.id;
      link = 'linked';
      score = best.score;
    } else {
      parentId = docIds.find((k) => s.docs[k].parent === null) ?? docIds[0];
      link = 'needs_review';
      score = scores.find((x) => x.id === parentId)?.score ?? null;
    }
  }

  s.seq.K += 1;
  const id = 'K' + s.seq.K;
  s.docs[id] = {
    title: title.trim(),
    kind: kind ?? '',
    content: body,
    parent: parentId,
    link,
    done: false,
    decisions: decs,
    created: Date.now(),
  };
  return { doc: { id, parent: parentId, link, score: round2(score) }, suggestions };
}

// parent, decisions and remove_decisions are each optional, but at least one is required.
// link changes only when parent is supplied, so a decisions-only call cannot clear needs_review.
export function linkDoc(s, { id, parent, decisions, remove_decisions } = {}) {
  assertMutable(s);
  const hasParent = parent !== undefined && parent !== null;
  const add = idList(decisions, 'decisions');
  const drop = idList(remove_decisions, 'remove_decisions');
  if (!hasParent && add === undefined && drop === undefined) {
    throw new GuardError(400, 'link_doc needs parent, decisions or remove_decisions');
  }
  if (!has(s.docs, id)) throw new GuardError(404, `doc ${id} not found`);

  if (hasParent) {
    if (!has(s.docs, parent)) throw new GuardError(404, `parent doc ${parent} not found`);
    if (s.docs[id].parent === null) throw new GuardError(400, 'the root doc cannot be re-parented');

    const seen = new Set();
    let cur = parent;
    while (cur != null && !seen.has(cur)) {
      if (cur === id) throw new GuardError(409, 'link would create a cycle', { code: 'cycle' });
      seen.add(cur);
      cur = has(s.docs, cur) ? s.docs[cur].parent : null;
    }
  }

  // Validate the decision edits fully before any write.
  let next;
  if (add !== undefined || drop !== undefined) {
    const addList = add ?? [];
    const dropList = drop ?? [];
    if (addList.some((d) => dropList.includes(d))) {
      throw new GuardError(400, 'a decision cannot be added and removed in one call');
    }
    for (const d of [...addList, ...dropList]) {
      if (!has(s.decisions, d)) throw new GuardError(404, `decision ${d} not found`);
    }
    const current = docDecisions(s.docs[id]);
    next = current.filter((d) => !dropList.includes(d));
    for (const d of addList) if (!next.includes(d)) next.push(d);
    if (next.length > MAX_DECISION_LINKS) {
      throw new GuardError(400, `doc ${id} would have more than ${MAX_DECISION_LINKS} decisions`);
    }
    for (const d of addList) {
      if (!current.includes(d) && appliesToOf(s, d).length >= MAX_DECISION_LINKS) {
        throw new GuardError(400, `decision ${d} already applies to ${MAX_DECISION_LINKS} docs`);
      }
    }
  }

  if (hasParent) {
    s.docs[id].parent = parent;
    s.docs[id].link = 'linked';
  }
  if (next !== undefined) s.docs[id].decisions = next;
  return {
    doc: {
      id,
      parent: s.docs[id].parent,
      link: s.docs[id].link,
      consumers: consumersOf(s, id),
      decisions: docDecisions(s.docs[id]),
    },
  };
}

// Clears done on a finished doc that gained or lost completion. Returns the doc id when it reopened, else null.
function reopenDoc(s, docId) {
  if (!docId || !has(s.docs, docId) || s.docs[docId].done !== true) return null;
  s.docs[docId].done = false;
  return docId;
}

// Returns { tasks, progress, reopened }. reopened is the doc id that lost done, or null; the tool handler audits it.
// Returns { tasks, progress, reopened, claim, forced }. now is internal (tests inject it).
export function ledger(s, a = {}, now = Date.now()) {
  const { action, doc, tasks, task } = a;
  const newStatus = normalizeStatus(a.status);
  let reopened = null;
  let claim = null;
  let forced = null;
  const listTasks = (filterDoc) =>
    Object.keys(s.ledger)
      .filter((id) => filterDoc == null || s.ledger[id].doc === filterDoc)
      .map((id) => ({
        id,
        doc: s.ledger[id].doc,
        title: s.ledger[id].title,
        status: s.ledger[id].status,
        marker: MARKER[s.ledger[id].status] ?? '[ ]',
      }));

  if (action === 'add') {
    assertMutable(s);
    if (!doc) throw new GuardError(400, 'doc is required');
    if (!has(s.docs, doc)) throw new GuardError(404, `doc ${doc} not found`);
    if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every((t) => t && nonEmpty(t.title))) {
      throw new GuardError(400, 'tasks must be a non-empty array of {title}');
    }
    if (Object.keys(s.ledger).length + tasks.length > LIMITS.tasks) throw new GuardError(400, 'task limit reached');
    for (const t of tasks) {
      s.seq.T += 1;
      s.ledger['T' + s.seq.T] = { doc, title: t.title.trim(), status: 'TODO', claimed_by: null, claimed_at: null, lease_until: null };
    }
    reopened = reopenDoc(s, doc);
  } else if (action === 'update') {
    assertMutable(s);
    if (!task) throw new GuardError(400, 'task is required');
    if (!has(s.ledger, task)) throw new GuardError(404, `task ${task} not found`);
    if (!TASK_STATES.includes(newStatus)) throw new GuardError(400, `invalid task status: ${a.status}`);
    const agent = a.agent_id ?? null;
    if (agent !== null) checkAgentId(agent);
    if (a.force === true && !nonEmpty(a.reason)) throw new GuardError(400, 'force requires a non-empty reason');

    const t = s.ledger[task];
    const prev = t.status;
    if (newStatus === 'IN_PROGRESS' && s.phase === 'implementation') {
      // The only path that sets claim fields in implementation. force does not apply to claiming.
      if (agent === null) {
        throw new GuardError(400, 'agent_id is required to set IN_PROGRESS in implementation', { code: 'agent_id_required' });
      }
      claim = claimTask(s, { task_id: task, agent_id: agent }, now);
    } else if (prev !== newStatus) {
      const owner = t.claimed_by ?? null;
      const live = owner !== null && typeof t.lease_until === 'number' && t.lease_until > now;
      const bypass = owner !== null && a.force === true && agent !== owner;
      if (owner !== null && !bypass) {
        if (live && agent !== owner) throw otherOwner(t, task);
        // After the lease expires anyone may release to TODO; only the claimant may mark COMPLETED.
        if (!live && newStatus === 'COMPLETED' && agent !== owner) throw otherOwner(t, task);
      }
      if (bypass) forced = { task, previous_owner: owner, reason: a.reason };
      if (newStatus === 'TODO') {
        t.claimed_by = null;
        t.claimed_at = null;
        t.lease_until = null;
      } else if (newStatus === 'COMPLETED') {
        t.lease_until = null;
      }
      t.status = newStatus;
    }
    if (prev === 'COMPLETED' && newStatus !== 'COMPLETED') reopened = reopenDoc(s, t.doc);
  } else if (action !== 'list') {
    throw new GuardError(400, `invalid ledger action: ${action}`);
  }

  return { tasks: listTasks(doc), progress: progress(s, doc), reopened, claim, forced };
}

export function completeDoc(s, { doc } = {}) {
  assertMutable(s);
  if (!doc) throw new GuardError(400, 'doc is required');
  if (!has(s.docs, doc)) throw new GuardError(404, `doc ${doc} not found`);
  const mine = Object.keys(s.ledger).filter((id) => s.ledger[id].doc === doc);
  if (mine.length === 0) throw new GuardError(409, 'doc has no ledger tasks', { code: 'empty_ledger' });

  const remaining = mine.filter((id) => s.ledger[id].status !== 'COMPLETED').map((id) => s.ledger[id].title);
  const p = progress(s, doc);
  const progressStr = `${p.done}/${p.total}`;
  if (remaining.length) {
    throw new GuardError(409, 'tasks remain incomplete', {
      code: 'incomplete',
      remaining,
      progress: progressStr,
    });
  }
  s.docs[doc].done = true;
  return { doc, completed: true, progress: progressStr };
}

function checkLease(v) {
  if (v === undefined || v === null) return LEASE.DEFAULT;
  if (!Number.isInteger(v) || v < LEASE.MIN || v > LEASE.MAX) {
    throw new GuardError(400, `lease_seconds must be an integer ${LEASE.MIN}..${LEASE.MAX}`);
  }
  return v;
}

export function checkAgentId(v) {
  if (typeof v !== 'string' || !AGENT_ID_RE.test(v)) {
    throw new GuardError(400, 'agent_id must match ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$', { code: 'invalid_agent_id' });
  }
}

const otherOwner = (task, id) => new GuardError(409, `task ${id} is claimed by another agent`, {
  code: 'claimed_by_other',
  claimed_by: task.claimed_by,
  lease_until: task.lease_until,
});

const taskView = (id, t) => ({
  id,
  title: t.title,
  doc: t.doc,
  status: t.status,
  marker: MARKER[t.status] ?? '[ ]',
  claimed_by: t.claimed_by ?? null,
  lease_until: t.lease_until ?? null,
});

// The only function that sets claim fields. Runs inside mutate (under the Store lock, on fresh state).
// Renews when the same agent holds a live lease; reclaims an expired lease held by another agent.
export function claimTask(s, a = {}, now = Date.now()) {
  checkAgentId(a.agent_id);
  const lease = checkLease(a.lease_seconds);
  assertMutable(s);
  if (s.phase !== 'implementation') {
    throw new GuardError(409, 'tasks can be claimed only in the implementation phase', { code: 'wrong_phase', phase: s.phase });
  }
  const id = a.task_id;
  if (!nonEmpty(id)) throw new GuardError(400, 'task_id is required');
  if (!has(s.ledger, id)) throw new GuardError(404, `task ${id} not found`);
  const t = s.ledger[id];
  if (t.status === 'COMPLETED') throw new GuardError(409, `task ${id} is already completed`, { code: 'already_completed' });

  const live = t.status === 'IN_PROGRESS' && typeof t.lease_until === 'number' && t.lease_until > now;
  if (live && t.claimed_by !== a.agent_id) {
    throw new GuardError(409, `task ${id} is claimed by another agent`, {
      code: 'claimed',
      claimed_by: t.claimed_by,
      lease_until: t.lease_until,
    });
  }
  if (t.status === 'IN_PROGRESS' && t.claimed_by === a.agent_id) {
    t.lease_until = now + lease * 1000;
    return { task: taskView(id, t), renewed: true, reclaimed: false, previous_agent: null, progress: progress(s, t.doc) };
  }
  const previous = t.status === 'IN_PROGRESS' && t.claimed_by ? t.claimed_by : null;
  t.status = 'IN_PROGRESS';
  t.claimed_by = a.agent_id;
  t.claimed_at = now;
  t.lease_until = now + lease * 1000;
  return {
    task: taskView(id, t),
    renewed: false,
    reclaimed: previous !== null,
    previous_agent: previous,
    progress: progress(s, t.doc),
  };
}

export function status(s) {
  const p = progress(s);
  return {
    phase: s.phase,
    decisions: Object.keys(s.decisions).map((id) => ({ id, title: s.decisions[id].title, state: s.decisions[id].state })),
    docs: Object.keys(s.docs).map((id) => ({
      id,
      title: s.docs[id].title,
      kind: s.docs[id].kind,
      parent: s.docs[id].parent,
      link: s.docs[id].link,
      done: s.docs[id].done,
      consumers: consumersOf(s, id),
    })),
    ledger: Object.keys(s.ledger).map((id) => ({
      id,
      doc: s.ledger[id].doc,
      title: s.ledger[id].title,
      status: s.ledger[id].status,
    })),
    counts: {
      pending: pendingCount(s),
      needs_review: needsReviewCount(s),
      tasks_done: p.done,
      tasks_total: p.total,
      orphans: orphanCount(s),
    },
    last_updated: s.updated,
  };
}

// The one place that builds the HUD. Fixed order:
// phase, pending, needs_review, ledger (implementation and complete only), in_progress, stale, orphans.
// in_progress and stale appear only in implementation; stale counts IN_PROGRESS tasks with an expired lease.
const LEDGER_HUD_PHASES = new Set(['implementation', 'complete']);
export function hudFragments(s, now = Date.now()) {
  const parts = [`phase=${s.phase}`, `pending=${pendingCount(s)}`, `needs_review=${needsReviewCount(s)}`];
  if (LEDGER_HUD_PHASES.has(s.phase)) {
    const { done, total } = progress(s);
    const hashes = total ? Math.round((done / total) * 10) : 0;
    parts.push(`ledger ${done}/${total} ${'#'.repeat(hashes)}${'-'.repeat(10 - hashes)}`);
  }
  if (s.phase === 'implementation') {
    const inProgress = Object.values(s.ledger).filter((t) => t.status === 'IN_PROGRESS');
    const stale = inProgress.filter((t) => claimOf(t, now) === 'expired').length;
    if (inProgress.length > 0) parts.push(`in_progress=${inProgress.length}`);
    if (stale > 0) parts.push(`stale=${stale}`);
  }
  const orphaned = orphanCount(s);
  if (orphaned > 0) parts.push(`orphans=${orphaned}`);
  return parts;
}

export function hudLine(s, now = Date.now()) {
  if (!LEDGER_HUD_PHASES.has(s.phase) && pendingCount(s) === 0 && needsReviewCount(s) === 0 && orphanCount(s) === 0) {
    return null;
  }
  return `[SYNAPTREE HUD] ${hudFragments(s, now).join(' | ')}`;
}

// get_scoped_node (read-only). Node ids: K doc, T task, D decision.
export const SCOPED_NODE_ID = /^[KTD][0-9]+$/;
export const SCOPED_CAP = 12000;
const STATE_RANK = { DECIDED: 0, REJECTED: 1, PENDING: 2 };
const MARKER = { TODO: '[ ]', IN_PROGRESS: '[/]', COMPLETED: '[x]' };
const hasOwn = (obj, k) => obj != null && Object.prototype.hasOwnProperty.call(obj, k);
const clip = (v, n) => String(v ?? '').slice(0, n);

// Lease claim per the spec: live and expired need IN_PROGRESS with a numeric lease_until.
export function claimOf(task, now) {
  if (task.status !== 'IN_PROGRESS' || typeof task.lease_until !== 'number') return 'none';
  return task.lease_until > now ? 'live' : 'expired';
}

export function claimableOf(task, claim) {
  return (claim === 'none' || claim === 'expired') && task.status !== 'COMPLETED';
}

const docRef = (s, id) => (id != null && hasOwn(s.docs, id)
  ? { id, title: clip(s.docs[id].title, 120), kind: clip(s.docs[id].kind, 120) }
  : null);

// Direct hops only: the doc's own decisions (self), then its immediate parent's (parent).
// Deduplicated by decision id with self winning; ordered DECIDED, REJECTED, PENDING.
function constraintsOf(s, docId) {
  const doc = s.docs[docId];
  const seen = new Map();
  const add = (id, via) => {
    if (!seen.has(id) && hasOwn(s.decisions, id)) seen.set(id, { id, d: s.decisions[id], via });
  };
  for (const id of docDecisions(doc)) add(id, 'self');
  if (doc.parent != null && hasOwn(s.docs, doc.parent)) {
    for (const id of docDecisions(s.docs[doc.parent])) add(id, 'parent');
  }
  return [...seen.values()]
    .sort((a, b) => (STATE_RANK[a.d.state] ?? 3) - (STATE_RANK[b.d.state] ?? 3))
    .map(({ id, d, via }) => ({
      id,
      title: clip(d.title, 120),
      state: d.state,
      summary: clip(d.summary, 400),
      reason: clip(d.reason, 200),
      via,
    }));
}

const byteLen = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// Cuts only while over SCOPED_CAP, in the spec's order, reporting each cut in `truncated`.
// The last two steps are a safety net after the spec list: 50 long tasks alone can exceed the cap.
function applyBudget(out) {
  const over = () => byteLen(out) > SCOPED_CAP;
  const steps = [
    () => {
      if (out.children.length > 20) {
        out.truncated.children += out.children.length - 20;
        out.children = out.children.slice(0, 20);
      }
    },
    () => {
      if (out.tasks.length > 50) {
        out.truncated.tasks += out.tasks.length - 50;
        out.tasks = out.tasks.slice(0, 50);
      }
    },
    () => {
      if (out.constraints.length > 20) {
        out.truncated.constraints += out.constraints.length - 20;
        out.constraints = out.constraints.slice(0, 20);
      }
    },
    () => {
      if (typeof out.node.content === 'string' && out.node.content.length > 200) {
        out.node.content = out.node.content.slice(0, 200);
        out.truncated.content = true;
      }
    },
    () => {
      if (typeof out.node.summary === 'string') out.node.summary = out.node.summary.slice(0, 100);
      if (typeof out.node.reason === 'string') out.node.reason = out.node.reason.slice(0, 50);
      for (const c of out.constraints) {
        c.summary = c.summary.slice(0, 100);
        c.reason = c.reason.slice(0, 50);
      }
    },
  ];
  for (const step of steps) {
    if (!over()) return out;
    step();
  }
  while (over() && out.constraints.length) {
    out.constraints.pop();
    out.truncated.constraints += 1;
  }
  while (over() && out.tasks.length) {
    out.tasks.pop();
    out.truncated.tasks += 1;
  }
  return out;
}

export function scopedNode(s, nodeId, { maxContent = 1500, now = Date.now() } = {}) {
  if (typeof nodeId !== 'string' || !SCOPED_NODE_ID.test(nodeId)) {
    throw new GuardError(400, 'node_id must match ^[KTD][0-9]+$');
  }
  if (!Number.isInteger(maxContent) || maxContent < 0 || maxContent > 4096) {
    throw new GuardError(400, 'max_content must be an integer 0..4096');
  }
  const kind = nodeId[0];
  const exists = kind === 'K' ? hasOwn(s.docs, nodeId) : kind === 'T' ? hasOwn(s.ledger, nodeId) : hasOwn(s.decisions, nodeId);
  if (!exists) throw new GuardError(404, `${nodeId} not found`);

  const truncated = { content: false, constraints: 0, tasks: 0, children: 0 };
  const global_constraints = Object.keys(s.decisions)
    .filter((id) => decisionScope(s.decisions[id]) === 'project')
    .slice(0, 10)
    .map((id) => ({ id, title: clip(s.decisions[id].title, 120), state: s.decisions[id].state }));

  let node;
  let parent = null;
  let constraints = [];
  let tasks = [];
  let children = [];

  if (kind === 'K') {
    const doc = s.docs[nodeId];
    const content = clip(doc.content, Infinity);
    if (content.length > maxContent) truncated.content = true;
    node = {
      type: 'doc',
      id: nodeId,
      title: clip(doc.title, 120),
      kind: clip(doc.kind, 120),
      content: content.slice(0, maxContent),
      parent: doc.parent ?? null,
      link: doc.link,
      done: doc.done === true,
      progress: progress(s, nodeId),
    };
    parent = docRef(s, doc.parent);
    constraints = constraintsOf(s, nodeId);
    tasks = Object.keys(s.ledger)
      .filter((id) => s.ledger[id].doc === nodeId)
      .map((id) => {
        const t = s.ledger[id];
        const claim = claimOf({ status: t.status, lease_until: t.lease_until ?? null }, now);
        return {
          id,
          title: clip(t.title, 120),
          status: t.status,
          marker: MARKER[t.status] ?? '[ ]',
          claimed_by: t.claimed_by ?? null,
          claim,
        };
      });
    children = consumersOf(s, nodeId).map((id) => ({
      id,
      title: clip(s.docs[id].title, 120),
      done: s.docs[id].done === true,
    }));
  } else if (kind === 'T') {
    const t = s.ledger[nodeId];
    const claim = claimOf({ status: t.status, lease_until: t.lease_until ?? null }, now);
    parent = docRef(s, t.doc);
    node = {
      type: 'task',
      id: nodeId,
      title: clip(t.title, 120),
      status: t.status,
      marker: MARKER[t.status] ?? '[ ]',
      doc: parent,
      claimed_by: t.claimed_by ?? null,
      claim,
      claimable: claimableOf(t, claim),
    };
    if (hasOwn(s.docs, t.doc)) constraints = constraintsOf(s, t.doc);
  } else {
    const d = s.decisions[nodeId];
    node = {
      type: 'decision',
      id: nodeId,
      title: clip(d.title, 120),
      state: d.state,
      summary: clip(d.summary, 400),
      reason: clip(d.reason, 200),
      scope: decisionScope(d),
      applies_to: appliesToOf(s, nodeId).slice(0, MAX_DECISION_LINKS).map((id) => docRef(s, id)),
    };
  }

  const out = {
    v: 1,
    phase: s.phase,
    node,
    parent,
    constraints,
    global_constraints,
    tasks,
    children,
    truncated,
  };
  return applyBudget(out);
}

export const HUD_EXEMPT = new Set(['guardrail_status']);

export function withHud(ctx, name, args, blocks) {
  try {
    if (!args?.project || HUD_EXEMPT.has(name) || !ctx?.tenant?.user_id) return blocks;
    if (!hasState(ctx, args.project)) return blocks;
    const line = hudLine(getState(ctx, args.project));
    return line ? [...blocks, { type: 'text', text: line }] : blocks;
  } catch {
    return blocks;
  }
}
