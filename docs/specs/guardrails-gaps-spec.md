# Guardrails gaps: implementation specification

Status: APPROVED v2 (2026-11-13). Reviewed by the six EGM lenses (design, codebase-details, zoom-out, comprehension, implementation-readiness, structural) and the synthesizer; all accepted findings are folded in. The user approved all eight open points in section 7 as recommended.
Scope: the four remaining gaps in the uncommitted guardrails work (`src/guardrails.js`, `src/store.js`, `src/tools.js`, `src/mcp.js`), plus one prerequisite the review found (G0).

## 0. Decisions carried in from the earlier round

These were the recommended choices put to the user. The user moved on to this brainstorm without changing them, so they are treated as accepted.

| # | Decision |
|---|---|
| A | The ledger stays inside the store's `guardrails` key (`store.json`). There is no separate `execution-ledger.json`. The markers `[ ]`, `[/]`, `[x]` are accepted as input aliases for TODO, IN_PROGRESS, COMPLETED, and tool output adds a `marker` field. |
| B | Task claiming uses an `O_EXCL` lockfile with a stale-lock timeout. |
| C | `complete_doc` stays per document. A separate project-wide finish call is added. |
| D | New tools use the existing unprefixed naming: `get_scoped_node`, `claim_task`, `finish_project`. |

Fact check: this repo has no SQLite. `Store` is a single JSON file (`store.json`) rewritten in full on every save. The "SQLite/JSON" wording in the brief means JSON only here. `Store.withLock(fn)` (G0) is the seam where a future SQLite backend would use `BEGIN IMMEDIATE`; its contract is: synchronous, depth-counted, and the only way a write reaches disk.

## 1. G0 (prerequisite): cross-process safety in `Store`

### Finding

`Store` loads `store.json` once in the constructor and keeps it in `this.data`. `_save()` rewrites the whole file from that memory. Two processes (two stdio MCP servers, a server plus the client, two agents each running their own `synaptree-mcp`) therefore have stale memory, and the second writer silently erases the first writer's changes. This already happens today, without any new feature. The unlocked writers are: `store.update('token_savings', ...)` from `track()` (only for `get_code_snippet`, `search_graph`, `trace_path`, `get_architecture`, and only on the MCP transport), `setMeta` and `annotate_element` in `src/tools.js`, and `src/llm.js` (cache and usage writes; the `llm_cache` also grows `store.json`). Any of these, after a stale load, can wipe another process's guardrail state.

A lockfile used only inside `claim_task` cannot fix this. Process B would claim based on stale memory and then overwrite process A's claim on save. The lock must cover every write and must be paired with a fresh read under the lock.

### Design

All changes are in `src/store.js`. The public API (`get`, `set`, `update`, `seal`, `open`, `audit`) is unchanged. New export: `StoreError` (an `Error` with `status` and `extra`), defined in `store.js` because `store.js` cannot import `GuardError` or `HttpError`. `mcp.js` and `server.js` already report `e.status` and `e.extra` for any error.

1. **Commit lifecycle (`withLock(fn)`).** acquire lock, reload from disk, run `fn` on the fresh data, save, release.
   - `set(k, v)` and `update(k, fn, d)` are built on `withLock`.
   - `fn` must be synchronous and must not `await`. A depth counter makes a nested call run inline (no acquire, no reload, so unsaved outer changes are not lost).
   - The lock is released in a `finally`.
   - On any failure after `fn` ran (`fn` throws, rename fails, `lock_lost`), the cache stamp is marked unknown and the next access reloads from disk, so memory never serves a mutation that was not committed.
   - `mutate()` in `guardrails.js` is already synchronous; the spec forbids making it async.
2. **Reload rules.** Only `ENOENT` maps to `{}`. A JSON parse error, `EBUSY`, or `EPERM` gets a bounded retry (5 tries, 10 to 50 ms backoff). If it still fails, throw `StoreError` with `status = 503`, `extra = { code: 'store_unreadable', retry: true }`, and save nothing. The constructor's current swallow-to-`{}` behaviour is not reused for any reload. (The constructor itself keeps its first-run semantics for ENOENT; for any other error it uses the same retry-then-throw.)
3. **Reads use a cheap freshness check.** `get(k, d)` calls `statSync(file, { bigint: true })` and reloads only when `mtimeNs`, `size`, or `ino` differs from the last loaded stamp (a rename always changes `ino`). Reads take no lock. A read that hits `EPERM`/`EBUSY` mid-rename uses the same bounded retry as rule 2. Stale-by-coarse-timestamp reads are possible on filesystems with coarse mtime, which is acceptable because every mutation re-reads fully under the lock and never decides on stale data. The one added hot-path cost is this `statSync`, because `withHud` reads guardrail state on every MCP call.
4. **Lock file** is `<dir>/store.lock`, created with `fs.openSync(path, 'wx')` (O_CREAT|O_EXCL), then written with `{ pid, host, token, at }` (`token` is 16 random bytes in hex). `pid` and `host` are diagnostics only and are never used to judge liveness.
5. **Acquire loop.** On `EEXIST`, check staleness (rule 6), otherwise sleep and retry. Sleep uses `Atomics.wait` on a `SharedArrayBuffer` with 5 to 25 ms of jitter, so the synchronous API is preserved. Total wait is capped at `SYNAPTREE_LOCK_TIMEOUT_MS` (default 5000). On timeout throw `StoreError` with `status = 503`, `extra = { code: 'lock_timeout', retry: true }`.
6. **Stale rule (mtime only).** A lock is stale when its file mtime is older than `SYNAPTREE_LOCK_STALE_MS` (default **10000**). A critical section takes milliseconds, so a 10 s old lock means a crashed holder. An empty or unparsable lock file counts as live until the mtime rule fires (a holder may be between `open` and `write`). There is no PID-liveness rule and no host comparison, which makes behaviour identical on Windows, Linux, and Docker bind mounts.
7. **Steal.** Rename `store.lock` to `store.lock.stale-<random>` (atomic; a second stealer gets `ENOENT` and retries), then unlink the moved file, then retry acquisition. There is no put-back. If a live lock was displaced by mistake, its holder fails the fence check (rule 8) with `lock_lost`, nothing is saved, and the caller retries. No data is lost.
8. **Fence check before commit.** Immediately before the rename of the temp file over `store.json`, the holder re-reads `store.lock` and aborts with `lock_lost` (503, retriable) if its token is gone. The residual window (microseconds between the check and the rename) requires two waiters to steal the same crashed lock at the same instant; it is stated, not eliminated.
9. **Release** reads `store.lock` and unlinks it only if the token matches.
10. **Temp file** is `store.json.<pid>.<rand>.tmp`, not the fixed `.tmp` name used now. Leftover temp files from a crash are ignored. The rename retries up to 5 times on `EPERM`, `EBUSY`, `EACCES` (Windows virus scanners and indexers) with 10 to 50 ms backoff.
11. **`.secret` creation** uses flag `wx`; on `EEXIST` the file is re-read and that value is used. This closes the race where two first-run processes mint different keys.
12. **Not supported:** network filesystems without atomic `O_EXCL` (NFSv2); multi-replica deployments sharing one volume (they need a database-backed store); Docker Desktop bind-mount `O_EXCL` semantics are unverified and the tests cover a local disk only.

### Cost

Every `store.update` already rewrites the file. The change adds one lock create, one lock unlink, and one full read per write, plus one `statSync` per read. Target: p95 added latency under 15 ms per write on a local disk for a 1 MB store. The implementer records the measured number in the task result; no benchmark file is committed. If it is exceeded, the writers listed under "Finding" that fire most often (`token_savings`, `llm_cache`) move to a separate file outside the locked store.

### Edge cases

After a crashed holder, writers see retriable 503 `lock_timeout` for up to about 10 s, then the lock is stolen. Lock timeout under heavy contention is a 503 with `retry: true`; the call changed nothing and is safe to repeat.

### Tests (`tests/unit/store-lock.test.js`)

- Four child processes each do 25 `store.update('c', n => n + 1)`. Final value is 100.
- A lock file with an old mtime and any content (valid JSON, garbage, empty) is stolen.
- An empty lock file with a fresh mtime is not stolen; a second `Store` times out with 503 `lock_timeout` when `SYNAPTREE_LOCK_TIMEOUT_MS=300`.
- Stealing a live lock makes its holder fail with `lock_lost` and nothing is saved (fence check).
- `store.json` containing garbage: `update` throws 503 `store_unreadable` and the file bytes are unchanged afterwards.
- Failure paths (`fn` throws, simulated rename error, `lock_lost`, nested `update` that throws): the lock is released, and the in-memory value equals the on-disk value afterwards.
- Nested `update` inside `update` keeps the outer unsaved change.
- Reading after another process wrote returns the new value without a restart.
- `.secret` race: two simultaneous first-run `Store`s end up with the same key.

## 2. G1: orphan gate

### What "orphan" means here

There is no manifest concept in the code, and a graph of docs with one `parent` pointer each cannot produce a classic zero-incoming-edge node through the existing tools: `create_doc` and `link_doc` both require the parent to exist, `link_doc` refuses cycles, and the root cannot be re-parented. The real structural gap is on the decision side: decisions have no edge to anything, so a `DECIDED` decision can constrain nothing and nobody can find it from a doc. Gap 2 (`get_scoped_node` must return "parental decisions") needs that edge anyway.

A separate `unreachable_docs` class was considered and **dropped**: the tools cannot produce it, and it would add a gate key and a root-selection rule for nothing. If corruption detection is wanted later, add it as a read-only diagnostic.

The decision-to-doc edge is a scope addition and is flagged for sign-off in section 7.

### Data model change

- Doc gains `decisions: string[]` (ids of decisions constraining it; default `[]`). Stored on the doc, the same direction as `parent`.
- Decision gains `scope: 'doc' | 'project'`. A `project` decision applies everywhere and is never an orphan.
  - **New** decisions are written with an explicit `scope` at creation (default `'doc'`).
  - **Legacy** decisions with no stored `scope` read as `'project'` (`?? 'project'`), so existing projects are never blocked by this change.
  - A `record_decision` update carries the existing `scope` forward; omitting `scope` on update never resets it.
- "applies_to" of a decision is computed on read, never stored, exactly like `consumers`.
- Docs without `decisions` read as `[]`. No migration.

Tool changes:

| Tool | Change |
|---|---|
| `record_decision` | optional `scope`, optional `applies_to: string[]` of doc ids (all validated to exist before anything is mutated). On update, `applies_to` replaces the previous attachment list; omitting it leaves the list unchanged. The read of the previous record moves inside the `mutate` callback (today it is read outside, at about `tools.js:314`, which is stale under concurrency). |
| `create_doc` | optional `decisions: string[]` (validated) |
| `link_doc` | `parent` becomes optional; adds optional `decisions` and `remove_decisions`; at least one of the three is required (400 otherwise). **`link` is changed only when `parent` is supplied.** A decisions-only call edits `doc.decisions` and leaves `link` untouched, so it cannot clear `needs_review` and bypass the review gate. |

Limit: at most 20 decision ids per doc, enforced on both sides (`decisions` on the doc and `applies_to` on the decision). Exceeding it returns 400 and mutates nothing.

### Orphan classes (pure function `orphans(s)`, computed, never stored)

| Key | Definition |
|---|---|
| `orphan_decisions` | A decision in state `DECIDED`, `scope === 'doc'`, referenced by no doc. `PENDING` is already a blocker; `REJECTED` is a record and exempt. |
| `unmanifested_docs` | A doc that has no child docs (a leaf), has zero ledger tasks, is not `done`, and whose `kind` (after `trim().toLowerCase()`) is not in `NON_EXECUTABLE_KINDS = ['reference', 'note', 'research']`. This is the "missing registration in the ledger" case: nothing would ever implement it. |

### Gate matrix

`gateBlockers(s, target)` returns all four arrays, always present, empty when clear.

| Target phase | Blocks on |
|---|---|
| `goldfish_review` | `pending_decisions`, `unlinked_docs`, `orphan_decisions` |
| `implementation` | all of the above plus `unmanifested_docs` |

`unmanifested_docs` is evaluated and counted only for the `implementation` target and only while phase is `implementation` in status and HUD, so brainstorm-phase projects are not flooded with leaf docs that are simply not yet planned. Forward moves only are gated, as today. A move from `brainstorm` straight to `implementation` is evaluated against the `implementation` row. Backward moves stay free.

The 409 body keeps `code: 'gate_blocked'` and `blockers` (now with four keys). `setPhase` today hardcodes two keys; it must switch to `gateBlockers(s, target)`.

### HUD and status

- `status().counts` gains `orphans` (count of `orphan_decisions`, plus `unmanifested_docs` only when phase is `implementation`).
- HUD fragments are built in one named place, in a fixed order: `phase=... | ledger ... | in_progress=N | stale=M | orphans=N`. Each of `in_progress`, `stale`, `orphans` appears only when its count is greater than zero.
- `hudLine` returns null only when **no** fragment applies. Today it returns null when `pending === 0 && nr === 0` (`guardrails.js` near line 340); that condition gains "and orphans is 0".

### Edge cases

- DECIDED to REJECTED after attachment: no longer an orphan.
- REJECTED to DECIDED with no attachments: an orphan again; the next gate catches it.
- Doc created or decision added after entering `implementation`: the gate is not re-run (it only runs on transitions). `finish_project` (G4) re-evaluates the full set, so these cannot slip through to completion.
- A single-doc project with no tasks cannot enter `implementation` (that doc is an unmanifested leaf).

### Test impact (every existing assertion that changes)

Line numbers are approximate. The implementer re-reads `tests/unit/guardrails.test.js` first, runs it in full, and lists each changed assertion in the task result.

| Approx. lines in `guardrails.test.js` | Why it breaks | Fixture change |
|---|---|---|
| 95 and 109 | `deepEqual` on a two-key `blockers` object | update to the four-key shape |
| 112 to 123 | D1 is DECIDED with no doc edge, so it is an orphan decision and entering `goldfish_review` (line ~121) now returns 409 | record D1 with `scope: 'project'`, or attach it with `applies_to` |
| 314 to 328 | single leaf doc K1 with no tasks is unmanifested, so entering `implementation` (line ~317) is blocked | add one ledger task to K1 before the phase change |
| ~320 | exact HUD string | keep the fixture so no new fragment appears, or update the string |
| 330 to 336 | null-HUD case | re-check against the new null rule |
| ~433 | reads only `blockers.pending_decisions` | unaffected |

New tests: a legacy store with DECIDED decisions and no `scope` can move forward with no orphans; an unlinked doc plus a decisions-only `link_doc` is still in `unlinked_docs`; kind comparison is case-insensitive; the 20-decision limit on both sides; `applies_to` replace-versus-keep on update; scope carried forward on update.

## 3. G2: `get_scoped_node`

Read-only. No audit event, no mutation. Tenant-scoped through the existing `ctx.tenant` keyed state.

### Input

`{ project, node_id, max_content?: int 0..4096 (default 1500) }`

`node_id` must match `^[KTD][0-9]+$` (400 otherwise). K is a doc, T a task, D a decision. Unknown id: 404.

### Output (version 1)

```json
{
  "v": 1,
  "phase": "implementation",
  "node": { "type": "doc", "id": "K3", "title": "...", "kind": "...", "content": "...", "parent": "K1", "link": "linked", "done": false, "progress": { "done": 1, "total": 4 } },
  "parent": { "id": "K1", "title": "...", "kind": "..." },
  "constraints": [
    { "id": "D2", "title": "...", "state": "DECIDED", "summary": "...", "reason": "", "via": "self" },
    { "id": "D1", "title": "...", "state": "DECIDED", "summary": "...", "reason": "", "via": "parent" }
  ],
  "global_constraints": [ { "id": "D9", "title": "...", "state": "DECIDED" } ],
  "tasks": [ { "id": "T7", "title": "...", "status": "IN_PROGRESS", "marker": "[/]", "claimed_by": "agent-2", "claim": "live" } ],
  "children": [ { "id": "K5", "title": "...", "done": false } ],
  "truncated": { "content": false, "constraints": 0, "tasks": 0, "children": 0 }
}
```

### Definitions

- `claim` (on a task): `live` means status IN_PROGRESS and `lease_until > now`; `expired` means IN_PROGRESS and `lease_until <= now`; `none` is everything else.
- `claimable`: true when `claim` is `none` or `expired` and status is not COMPLETED.
- `done` on a doc node is reported straight from the stored doc.
- `progress` appears only on doc nodes. `via` appears only on constraints.

### Resolution by node type

| Node | `node` | `parent` | `constraints` | `tasks` | `children` |
|---|---|---|---|---|---|
| doc (K) | the doc | its parent doc ref, or null | decisions on the doc (`via: self`) plus decisions on the parent doc (`via: parent`) | ledger tasks of this doc | child docs as refs |
| task (T) | the task, with its `doc` ref and `claimable` boolean; no `progress` | its doc (as ref) | same constraints as its doc | `[]` | `[]` |
| decision (D) | the decision, with `applies_to` doc refs (max 20) | null | `[]` | `[]` | `[]` |

Constraint rules:

- Only direct hops: the node and its immediate parent. No grandparents, siblings, or other tasks.
- Deduplicated by decision id; `self` wins over `parent`.
- Order: `DECIDED`, then `REJECTED`, then `PENDING`. Each entry carries its state so a subagent can see a negative or unresolved constraint.
- `summary` is cut to 400 characters, `reason` to 200.
- `global_constraints` lists `scope: 'project'` decisions (including legacy decisions without a stored scope) as id, title, state only (max 10). Full text is one `get_scoped_node(D#)` call away.
- Every title in the payload is truncated to 120 characters.

### Size budget

Soft cap of 12 000 bytes of JSON. Cuts apply in this order until under the cap: `content` to `max_content`, children beyond 20, tasks beyond 50, constraints beyond 20, `content` to 200 characters, then `summary` to 100 and `reason` to 50 characters, then constraints dropped from the tail. Each cut is reported in `truncated`. The HUD line added by `withHud` is outside the payload and costs about 25 tokens.

### Tests

Doc, task, and decision resolution; direct-hop only (grandparent decision absent); malformed id 400; unknown id 404; another tenant's id 404; byte budget with 20 long-titled constraints and 50 long-titled tasks (serialized size at most 12000); legacy state without `decisions` or `scope`; `max_content: 0` omits content; `claim` live/expired/none and `claimable`; `done` reported from the doc.

## 4. G4: project-wide completion lock

(Numbered before G3 because the `complete` phase must exist before `claim_task` refers to it; see the task order in section 6.)

### Relationship between the two completion calls

| Call | Question it answers | Looks at |
|---|---|---|
| `complete_doc(doc)` | Is this one doc finished? | Only that doc's own ledger tasks. Unchanged. Not blocked by any other doc. |
| `finish_project` | Is the whole workspace finished? | Every task, every doc with tasks, and the full gate. |

Per-document rule, stated explicitly: completing a doc does not require its child docs to be done. Finishing K2 is never blocked by open tasks in K3 or anywhere else.

### New terminal phase

`PHASES` becomes `['brainstorm', 'planning', 'goldfish_review', 'implementation', 'complete']`. `GATED` is unchanged. `complete` is reachable only from `implementation`.

Code that must change for this (not just `PHASES`):

- the `set_phase` zod enum and description (`src/tools.js` near line 323) gain `complete`;
- the `manage_ledger` status enum (near line 348) is widened for the marker aliases in section 5;
- `setPhase` gets an explicit `complete` branch that calls `enforceImplementationProgress` (it currently gates only `GATED` phases);
- the `set_phase` handler's audit catch (near lines 331 to 335, today only `gate_blocked`) also audits `finish_blocked`.

### `enforceImplementationProgress(s)`

A pure function in `guardrails.js`. It is the only place that decides whether the project may close. It runs in both code paths that can set `phase = 'complete'`:

1. the new tool `finish_project { project }`, and
2. `set_phase { phase: 'complete' }`, which calls the same function (there is no bypass through `set_phase`).

It passes only when all of these hold; otherwise it throws a 409 `GuardError` with `code: 'finish_blocked'` and body `{ code: 'finish_blocked', reasons: [{ code, ...detail }] }` listing every failed reason, not just the first:

| Reason code | Condition |
|---|---|
| `wrong_phase` | Phase is not `implementation`. |
| `empty_ledger` | The ledger has no tasks. |
| `incomplete` | Any task is not COMPLETED. Reports the count and up to 20 items (`id`, `title`, `status`, `claimed_by`; `claimed_by` is null-tolerant because claim fields arrive in G3). |
| `docs_not_done` | Any doc that has at least one task is not `done`. `complete_doc` is the explicit sign-off per doc, and finish does not do it silently. |
| `gate_blocked` | The full gate matrix for `implementation` is not clear (pending decisions, unlinked docs, orphan decisions, unmanifested docs). This catches anything added after entering `implementation`. |

Audit events: `project_finished` on success, `finish_blocked` (with the reasons) on refusal; the refusal audit is written in the handler catch, as the existing gate audit is.

### State rules around completion

- While phase is `complete`, every guardrail mutation except `set_phase` is refused with 409 `project_complete` (`create_doc`, `record_decision`, `link_doc`, `manage_ledger` add and update, `complete_doc`, and later `claim_task`). Implemented as one `assertMutable(s)` helper at the top of each operation.
- Reopening: `set_phase('implementation')` from `complete` is a backward move, so it is ungated and audited as `phase_changed`. Finishing again re-runs the full check.
- `manage_ledger add` on a doc that is already `done` sets it back to `done: false` and writes audit `doc_reopened`. A status change of a task from COMPLETED to anything else, in a doc that is `done`, does the same. Without this a finished doc could hold an open task.
- Tasks cannot be deleted by any tool, so a task cannot be removed to dodge the check.
- HUD in `complete`: `phase=complete | ledger n/n ##########`.

### Honest limit

The server can only gate the explicit tool calls `finish_project` and `set_phase`. It cannot observe an agent saying "I am done" in free text. The guarantee is that the recorded project state cannot reach `complete` while work is open, not that an agent cannot claim to be finished.

### Tests

`complete_doc` on K2 succeeds while K3 has open tasks; `finish_project` and `set_phase('complete')` both reject on the same fixtures with identical reason codes; every reason code individually; success path; mutation refused in `complete`; reopen then re-finish; `manage_ledger add` reopening a done doc; a COMPLETED to TODO status change in a done doc reopening it; the `finish_blocked` audit event is written; `set_phase('complete')` is accepted by the schema (400 before this change).

## 5. G3: `claim_task`

### Inputs

`{ project, task_id, agent_id, lease_seconds?: int 30..3600 (default 900) }`

`agent_id` must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$` (400 otherwise).

**Limits.** `agent_id` is self-asserted: any caller can pass another agent's id. Claiming is coordination between cooperating agents, not authentication or a security boundary, and nothing may rely on it as enforcement. Two workers sharing an id are indistinguishable and both succeed.

### Task record additions

`claimed_by`, `claimed_at`, `lease_until` (epoch ms), all `null` by default. Legacy tasks read as `null`.

### Algorithm (runs inside `mutate`, so under the G0 lock on fresh state)

The clock `now` is an internal argument defaulting to `Date.now()`, so tests can inject time. It is not part of the public tool schema.

1. `assertMutable`: 409 `project_complete` if phase is `complete`; 409 `wrong_phase` unless phase is `implementation`.
2. 404 if the task does not exist. 409 `already_completed` if status is COMPLETED.
3. If status is IN_PROGRESS, `lease_until > now`, and `claimed_by !== agent_id`: 409 `claimed` with `{ claimed_by, lease_until }`.
4. If `claimed_by === agent_id`: renew (new `lease_until`, keep `claimed_at`), return `renewed: true`.
5. If a different agent's lease has expired: reclaim, audit `task_reclaimed` with `previous_agent`, return `reclaimed: true`.
6. Otherwise set status IN_PROGRESS, `claimed_by`, `claimed_at = now`, `lease_until`.
7. Audit `task_claimed`. Return the task (id, title, doc, status, marker, claimed_by, lease_until), `renewed`, `reclaimed`, and doc progress.

Leases are evaluated lazily at claim and read time. There is no background sweeper. Lease time uses the server wall clock on one machine; the 30 s minimum lease absorbs small clock steps.

### `manage_ledger` update changes

- Gains optional `agent_id`, optional `force: true`, and `reason`. `status` additionally accepts `[ ]`, `[/]`, `[x]`.
- In `implementation` phase, setting IN_PROGRESS requires `agent_id` (400 `agent_id_required`) and delegates to the same claim function. No second path can set the claim fields.
- A task with `claimed_by` set and a live lease can be moved to COMPLETED or TODO only with a matching `agent_id` (409 `claimed_by_other` otherwise).
- After a lease has expired, anyone may release the task to TODO; only the claimant may mark it COMPLETED.
- A COMPLETED task has `lease_until = null`, and a null lease on a COMPLETED task counts as releasable by anyone (moving it back to TODO). This prevents a task owned by a vanished agent from being stuck.
- **Orchestrator override.** `force: true` bypasses ownership checks, requires `reason`, and writes audit `ledger_forced` with the previous owner and the reason. It is documented as the orchestrator's override; because `agent_id` is advisory it is a record, not an access control.
- Unclaimed tasks (no `claimed_by`) stay updatable without `agent_id`, so the orchestrator can still close work directly and existing tests keep passing.
- Moving to TODO clears the three claim fields. COMPLETED keeps `claimed_by` as the record of who finished it and clears `lease_until`.

### HUD

In `implementation`: ` | in_progress=N` when N is greater than zero, and ` | stale=M` when M of them have expired leases (fixed order from section 2).

### Edge cases

| Case | Behaviour |
|---|---|
| Two agents claim simultaneously | The G0 lock serializes them; the second gets 409 `claimed`. |
| Holder process killed mid-write | Atomic rename means `store.json` is never partial; the orphaned lock is stolen after the stale age (about 10 s, retriable 503 meanwhile). |
| Agent crashes after claiming | Lease expires; another agent reclaims. |
| Agent A returns after being reclaimed and calls update COMPLETED | 409 `claimed_by_other`, because `claimed_by` is now B. |
| Task owned by an agent that no longer exists, lease still live | The orchestrator uses `force` with a reason, or waits for the lease to expire. |
| Lock timeout under heavy contention | 503 `lock_timeout` with `retry: true`; the call changed nothing and is safe to repeat. |

### Tests

Concurrent claims from child processes: exactly one succeeds. Renew, reclaim (with injected `now`), wrong phase, `project_complete`, completed task, `agent_id` format, ownership enforcement in `manage_ledger`, expired-lease release, null-lease COMPLETED release, `force` with and without `reason` and the `ledger_forced` audit, marker aliases, IN_PROGRESS requiring `agent_id`, legacy unclaimed task update, HUD `in_progress` and `stale` fragments in exact-string form.

## 6. Implementation tasks

All tasks touch the same few files, so they run one at a time, in this order. Each runs `node --test tests/unit/<its test file>` and then `npm test` before it is accepted. Verification and the git sha are recorded by the orchestrator, not the builder. Execution is delegated per the global rules (tokenfrugal first, Haiku subagent fallback); line numbers in this spec are approximate, so each builder re-reads the code it changes first.

| Task | Files (exact) | New or changed tests | Depends on | Tool-call limit |
|---|---|---|---|---|
| T1 Store lock, fresh reads, `StoreError`, `.secret` `wx` (G0) | `src/store.js` | `tests/unit/store-lock.test.js` (new) | none | 45 |
| T2 Decision to doc edges, orphans, gate v2, HUD builder, status (G1) | `src/guardrails.js`, `src/tools.js` | `tests/unit/guardrails.test.js` (update per the test-impact table, add orphan cases) | T1 | 45 |
| T3 `get_scoped_node` (G2) | `src/guardrails.js`, `src/tools.js` | `tests/unit/scoped-node.test.js` (new) | T2 | 35 |
| T4 `enforceImplementationProgress`, `finish_project`, phase `complete`, enum widening, `setPhase` branch, `assertMutable`, audit catch (G4) | `src/guardrails.js`, `src/tools.js` | `tests/unit/finish-project.test.js` (new) | T2 | 35 |
| T5 `claim_task`, ledger ownership, `force` override (G3) | `src/guardrails.js`, `src/tools.js` | `tests/unit/claim-task.test.js` (new) | T1, T2, T4 | 35 |
| T6 Docs | `README.md`, `CHANGELOG.md` (append only; both already carry uncommitted edits from earlier work) | none | T5 | 10 |

`src/mcp.js` is in scope for T1 (the `StoreError` 503 shape is already carried by its existing `e.status` / `e.extra` handling, so it should need no edit) and T2 to T5 (any error mapping needed). The builder reports if it had to touch it.

Must not change: the `guard` wrapper contract, the `HttpError` and `GuardError` shapes, tenant keying (`user_id/project`), the existing tool names and their input schemas, `src/server.js`. Existing input schemas change only by additive optional fields, with two intentional exceptions: (1) in `implementation` phase, setting a task IN_PROGRESS through `manage_ledger` requires `agent_id`; (2) `link_doc.parent` becomes optional (a relaxation, with at-least-one-of validation). New tools register through `add()` in `src/tools.js`. `src/server.js` exposes tools through explicit routes (`tool(name)`) and does not iterate `TOOLS`, so the new tools are MCP-only and no new REST routes are added (the admin UI does not use them); `src/mcp.js` picks them up from `TOOLS`.

## 7. Open points for sign-off

1. **Decision-to-doc edges** (`doc.decisions`, `decision.scope`) are a scope addition beyond the four gaps. Without them G2 has no "parental decision constraints" and G1 has no orphan to detect. Legacy decisions read as project-scoped so nothing existing is blocked. Accept?
2. `unreachable_docs` was dropped (the tools cannot produce it). Agree?
3. `NON_EXECUTABLE_KINDS = ['reference', 'note', 'research']` exempts docs from the unmanifested check. Is this list right for the doc kinds you use?
4. Default lease is 15 minutes. Right for the agents in use?
5. `finish_project` refuses when a doc with tasks is not `done` instead of closing it automatically. Accept the extra `complete_doc` call per doc?
6. The orchestrator `force` override on `manage_ledger` (audited, requires a reason). Accept?
7. Lock timing: stale age 10 s, acquire timeout 5 s, with up to about 10 s of retriable 503s after a crashed holder. Confirm?
8. Task order puts G4 (T4) before G3 (T5) so the `complete` phase exists before `claim_task` refers to it. Confirm?

## 8. Risks

| Risk | Mitigation |
|---|---|
| Synchronous lock wait blocks the Node event loop for up to 5 s under heavy contention | Critical sections last milliseconds; the bound is the timeout; a busy result is retriable. |
| A live lock is stolen by mistake (slow disk, holder paused over 10 s) | The fence check makes the displaced holder fail with `lock_lost` and save nothing; the caller retries. Residual window is microseconds and is documented. |
| Added write cost: one lock create, unlink, and full read per write; one `statSync` per read | Measured in T1; if p95 exceeds 15 ms, move the high-frequency writers (`token_savings`, `llm_cache`) to a separate file outside the locked store. |
| Transient read errors on Windows (EPERM/EBUSY mid-rename) wiping the store | Reload maps only ENOENT to empty; everything else retries then throws 503 and saves nothing. |
| Test churn from the four-key `blockers` shape and new gates | The full list of changed assertions is in section 2; new HUD fragments are conditional so other exact-string tests stay valid. |
| Legacy projects blocked by the new orphan rule | Legacy decisions read as `scope: 'project'`; covered by a test. |
| Multi-host replicas sharing a volume; Docker bind-mount `O_EXCL` | Declared unsupported; needs a database-backed store. |
