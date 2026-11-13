# synaptree-mcp

A multi-tenant **code knowledge graph** for AI agents. It parses a repository with Tree-sitter,
links symbols across files, stores the result in Neo4j, and exposes it through an
[MCP](https://modelcontextprotocol.io) server (stdio and SSE). It also ships an admin web UI with a
animated call-flow trace, architecture view, and database ERDs that are saved into the same graph so
agents can see your schema next to your code.

> **Syntax is no longer the bottleneck. Creativity is.**
> I just shipped this project using solely AI coding agents, proof that impact is now defined by the depth of your thought and the clarity of your vision, not just writing lines of code.
> I'd love your feedback on what I built: [linkedin.com/in/vpavtekar](https://linkedin.com/in/vpavtekar)

**Read-only by design.** The MCP never changes your repository or your source databases. The only thing
it writes is its own index (graph, annotations, ADRs, saved database schemas).

## Benchmark

Retrieving code through the graph used 4,953 tokens against 52,140 for `git grep` plus line-window reads across 16 tasks (90% fewer). Per-task charts, table and method: [Benchmark/README.md](Benchmark/README.md).

![Total tokens: baseline vs synaptree](Benchmark/charts/hero.png)

## Performance

Latency over SSE against the Docker server, single warm run. Method and the script are in [docs/BENCHMARK.md](docs/BENCHMARK.md).

```
Operation                      synaptree-mcp   mid-size repo   small repo
Full index (force)             3.7 s           10.2 s          4.8 s
Fast index (nothing changed)   529 ms          489 ms          632 ms
Cypher: count Functions        10 ms           7 ms            9 ms
Name search (regex)            151 ms          410 ms          157 ms
Dead-code detection            21 ms           9 ms            13 ms
trace_path depth 5             34 ms           36 ms           28 ms
Graph size (nodes / edges)     587 / 1,961     2,054 / 6,268   666 / 1,288
```

## Querying

```
Tool               Answers                                  How an LLM uses it
search_graph       Where is symbol X defined?               Name or pattern in, TSV of qualified names out
search_code        Which files mention this text?           Regex in, file:line:text lines out
get_code_snippet   What does this function look like?       Qualified name in, only that symbol's lines out
trace_path         Who calls this? What breaks if it moves? Qualified name, direction, depth in; flat edge list out
query_graph        Dead code, hierarchy, counts             Read-only Cypher with $user_id and $repo_name; 500 rows max
get_architecture   What is in this repo?                    One call: counts, layers, entrypoints, hotspots
detect_changes     Is the index stale?                      Compares the stored commit sha; A/M/D path lines out
```

## Graph data model

Every node carries the label `CodeNode` plus a kind label, and the tenant keys `user_id` and `repo_name`.
Symbol names are stored as `qualified_name` (for example `src/tools.js::buildTools`).

```
Kinds   File, Folder, Function, Method, Class, Interface, Route, Type, Module, ...
Edges   CONTAINS_FOLDER, CONTAINS_FILE, DEFINES, DEFINES_METHOD, MEMBER_OF, IMPORTS,
        CALLS, CALL_REFERENCE, USAGE, IMPLEMENTS, INHERITS, USES_TYPE, HANDLES
```

`get_graph_schema` returns the exact labels and edges your graph contains. Example, functions nothing calls:

```cypher
MATCH (f:Function {user_id:$user_id, repo_name:$repo_name})
WHERE NOT ()-[:CALLS]->(f) RETURN f.qualified_name LIMIT 100
```

## Configuration

```
Variable                       Default                  Purpose
NEO4J_URI                      bolt://127.0.0.1:17687   Bolt endpoint
NEO4J_USERNAME / PASSWORD      neo4j / (empty)          Database credentials (or NEO4J_AUTH=user/password)
NEO4J_DATABASE                 server default           Database name
PORT / HOST                    8787 / 127.0.0.1         HTTP bind (the Docker image binds 0.0.0.0)
SYNAPTREE_TOKEN                (none)                   Require a bearer token on /sse, /api/v1
SYNAPTREE_USER_ID              default                  Tenant id
SYNAPTREE_DATA_DIR             ./data                   Settings, usage and saved connections
SYNAPTREE_GRAMMARS_DIR         (none)                   Extra tree-sitter-<name>.wasm grammars
SYNAPTREE_SUMMARIZE_ON_INDEX   off                      Local LLM writes summaries after indexing
SYNAPTREE_SUMMARIZE_LIMIT      25                       Max symbols summarised per run
SYNAPTREE_IGNORE              (none)                   Extra ignore entries, comma separated (see below)
SYNAPTREE_PROJECT             folder basename          Project name the EGM watcher writes under (see EGM linkup)
SYNAPTREE_WATCH               on                       Set to 0 to disable the docs/designs watcher
EGM_PLUGIN_PATH               (auto: newest cache)     EGM plugin root for setup-egm-bridge (see EGM linkup)
SYNAPTREE_EGM_BRIDGE          on                       Set to 0 to skip writing the data-access block into EGM
EMBEDDINGS_URL / _API_KEY      (none)                   Optional embeddings endpoint
EMBEDDINGS_MODEL               text-embedding-3-small   Embedding model name
WORKSPACE_DIR (compose)        (set in .env)            Host folder mounted read-only at /workspace
```

### Ignore list and staleness

Indexing skips `node_modules`, `.git`, `.claude`, `.claude/worktrees`, `.worktrees`, build output and virtualenvs by default. `SYNAPTREE_IGNORE` appends more entries: a bare name (`vendor`) matches a directory anywhere, a root-relative path (`apps/legacy/generated`) matches that one directory. Any directory holding a `.git` *file* (a linked worktree or submodule) is a separate checkout and is skipped too.

Re-running `index_repository` is incremental and prunes: files that were deleted, renamed or newly ignored lose their nodes, and Folder nodes with no remaining files are removed. `index_status` returns `head_sha`, `index_sha` and `head_changed`; `stale` is true when HEAD moved since the last index (or the project has not synced for the stale period). Re-run `index_repository` (or the git hooks in `scripts/git-hooks`) to refresh. Index from the main checkout path, not a worktree.

Local model for `SYNAPTREE_SUMMARIZE_ON_INDEX`: in a 36-answer screen of nine Ollama models, `llama3.2:3b-16k` scored 28/36 at 0.8 s/task, one answer behind `llama3.1:8b` (29/36, 6.1 s/task); models under 3B failed every summary task. See [docs/BENCHMARK.md](docs/BENCHMARK.md#local-model-for-summaries-and-review-thinker-role).

## What problem does it solve?

AI coding agents work blind on large codebases. To answer "what breaks if I change `verifyJwt`?"
they usually grep, open file after file, and stuff raw source into the context window. That is
slow, burns tokens, misses relationships that span files, and gets worse as the repo grows.

synaptree-mcp indexes the repository once into a graph of symbols (functions, classes, routes,
types, files) and the relationships between them (calls, imports, inheritance, type usage). The
agent then asks precise structural questions instead of reading code. The same graph can hold your
database schema (SQL and NoSQL), so the agent also knows which tables a piece of code touches.

## How it helps

- **Fewer tokens, faster answers:** a query returns a small, relevant slice (a call path, a list
  of callers, one snippet) instead of whole files.
- **Impact analysis:** `trace_path` and `detect_changes` show what calls a symbol and what a
  change may affect before you make it.
- **Navigation and onboarding:** `get_architecture`, `search_graph` and `search_code` give a map
  of an unfamiliar repo in a few calls.
- **Schema-aware agents:** `erd_save_to_index`, `get_db_schema` and `get_table_relationships` let an
  LLM understand tables, collections and how they relate.
- **Stays current:** `synaptree-client` (chokidar, 500 ms debounce) re-indexes only the files you change.
- **Scales and isolates:** the graph lives in Neo4j and is partitioned per user and repository.
- **Token guardrails for paid sources:** asks sent to a paid remote API (Claude, Codex or similar) are estimated first, and large asks need approval. Local LLMs and annotation-generating calls are never gated. Limits are editable in Settings.
- **Works with any MCP client:** stdio for local agents, SSE for remote or shared setups.

## Architecture

**High-level design**

<img src="docs/hld.svg" alt="High-level design" width="100%">

**Low-level design**

<img src="docs/lld.svg" alt="Low-level design" width="100%">

### Screenshots

Live data from this repository's own index.

[![Trace tab: call flow for runTool](docs/ui-trace.png)](docs/ui-trace.png)

| Architecture | Sync |
| --- | --- |
| [![Architecture tab](docs/ui-architecture.png)](docs/ui-architecture.png) | [![Sync tab](docs/ui-sync.png)](docs/ui-sync.png) |

## The UI

Start the server and open <http://localhost:8787/ui/>. Light and dark themes are supported.

- **Trace:** a call graph (React + xyflow). Edges animate only for the selected
  node, so the rest stays still. Depth 1-5, SVG (grouped layers) and CSV export, reset button.
- **Architecture:** counts, languages, layers, entrypoints, hotspots and ADRs, plus a **Tokens saved**
  card (today's estimated saving, calls, with/without-graph bars and a by-tool table; demo data until an agent has made MCP calls).
- **ERD:** pick a saved connection and its stored schema loads from the index. **Sync up** reads the
  database (read-only), **Generate** uses a *local* LLM to infer relationships and group tables
  (grayed out with a tooltip until a local LLM is configured). Every result is saved to the index
  automatically. **Delete** removes only the saved schema in the synaptree index and needs the
  authorization checkbox; your database and repos are never touched.
- **Sync:** a collapsible **Add new (Claude | Codex)** banner stays on top of the project table
  with two copy-paste sets: add the MCP once, then say `index this repo` in Claude Code or Codex
  inside any repo. Force re-sync, delete a project (two guardrails: type the repo name,
  then type `yes, delete my repo`; this clears the index only). Stale projects can be kept for
  3 or 6 more months.
- **Settings:** read-only database connections (PostgreSQL, MySQL, Oracle, ODBC, SQLite, MongoDB),
  LLM provider (Local or API) with editable token guardrails (paid sources only, conservative defaults).
- **Query / Chat:** read-only Cypher and questions answered from the graph.

## Quick start

```bash
git clone https://github.com/maxh8086/synaptree-mcp && cd synaptree-mcp
npm install
node scripts/init-env.mjs     # writes .env with a random Neo4j password and ports (never printed)
docker compose up -d          # bundled Neo4j 5 Community, compose project "synaptree"
npm start                     # API + UI + SSE on http://127.0.0.1:8787
```

Or run everything in Docker: the image binds `0.0.0.0`; outside Docker the default bind is
`127.0.0.1`. `.env` is authoritative for `NEO4J_*` and `SYNAPTREE_*` (it overrides the parent
environment), and the default Bolt URI is `bolt://127.0.0.1:17687`, not the usual 7687, so it never
collides with another Neo4j on your machine. Use `NEO4J_URI` to point at Neo4j Enterprise, Aura or Memgraph.

### Use it from an MCP client

Claude Code plugin (talks to the Docker container, so run `docker compose up -d` first):

```bash
claude plugin marketplace add maxh8086/synaptree-mcp
claude plugin install synaptree@synaptree-mcp
```

Codex (same Docker-backed stdio bridge):

```bash
codex mcp add synaptree -- docker exec -i synaptree-synaptree-1 node src/cli.js --stdio
```

Or run the server directly on the host:

```bash
claude mcp add synaptree -- node /path/to/synaptree-mcp/src/cli.js --stdio
codex mcp add synaptree -- node /path/to/synaptree-mcp/src/cli.js --stdio
```

SSE clients connect to `http://127.0.0.1:8787/sse`. Set `SYNAPTREE_TOKEN` to require a bearer token.
Every tool takes a `project` argument. If a gateway injects the project name for you, index your
checkout under that same name (the checkout folder slug).

### EGM linkup (new in 1.1.1)

The [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) (EGM) writes planning artifacts as Markdown under `docs/designs/`. This integration is new in 1.1.1. When the server starts (`serve` or `--stdio`), it watches that folder in the background, so new and changed designs appear in the graph without running `index_repository`. It has two parts: the docs watcher, and a bridge that lets EGM's agents query `synaptree`.

**How it works**

1. **Design docs are written.** EGM (or you) saves a `.md` file under `docs/designs/` in the repo.
2. **The watcher picks it up.** After the file is stable for 1 s, it is indexed as a `File` node with one `Resource` node per heading, under the project name below.
3. **The plugin bridge lets EGM read the graph.** `scripts/setup-egm-bridge.js` appends a short "data access" block to the EGM skill prompts (`skills/egm_review`, `skills/egm_brainstorm`) and every `agents/*.md`. The block tells those agents they may call the `synaptree` MCP server to locate files before reporting a path as missing. It runs automatically each time the server starts, so there is no manual step. If the EGM plugin is installed, the block is applied, and it is applied again after EGM updates to a new cached version. Files that already contain the block are skipped, so it is safe to repeat. Set `SYNAPTREE_EGM_BRIDGE=0` to turn it off.
4. **Queries see the docs.** Because the docs and the code share one project name, `search_graph`, `trace_path` and `ask_flow` can answer questions across both.

**Where the bridge finds EGM**, in order:

1. `EGM_PLUGIN_PATH`, if set. Always used, even with `--no-auto`.
2. Otherwise, the newest version under `%USERPROFILE%\.claude\plugins\cache\egm\egm\` (or `$HOME/.claude/plugins/cache/egm/egm/` elsewhere). The npm install and build hooks pass `--no-auto`, so they only write when `EGM_PLUGIN_PATH` is set. To patch the cache, run `node scripts/setup-egm-bridge.js` by hand.

If no EGM plugin is found, the script logs where it looked and changes nothing.

**Variables to declare**

You need no new variables for the default setup: the repo folder is the project name, and you start the server from the repo root. Declare a variable only in these cases:

| Variable | Declare it when | Example |
| --- | --- | --- |
| `SYNAPTREE_PROJECT` | The name you indexed under differs from the folder name, for example you indexed `market-scanner` but the folder is `Market-Scanner`. | `SYNAPTREE_PROJECT=market-scanner` |
| `EGM_PLUGIN_PATH` | EGM is not in the default cache location, or you want the bridge applied at install time. | `EGM_PLUGIN_PATH=C:\Users\me\Downloads\Projects\elephant-goldfish-model` |
| `SYNAPTREE_WATCH` | You do not want the docs watcher to run. Set it to `0`. | `SYNAPTREE_WATCH=0` |
| `SYNAPTREE_EGM_BRIDGE` | You do not want the server to write the data-access block into EGM. Set it to `0`. | `SYNAPTREE_EGM_BRIDGE=0` |

Set each variable in one place only (see the precedence note below).

**Example: a repo that lives in its own folder**

For a repo at `C:\Users\me\Downloads\Projects\Market-Scanner` that keeps its EGM docs in `docs/designs/`:

1. Index it once with `index_repository` (project `Market-Scanner`).
2. Start the server from that folder, so the watcher reads its `docs/designs/`.
3. Check `index_status`. If the project name is not `Market-Scanner`, set `SYNAPTREE_PROJECT` as shown above.

Nothing to run for the bridge: starting the server applies it. If EGM is installed somewhere other than the default cache, set `EGM_PLUGIN_PATH`.

- **What is indexed**: each `.md` file becomes a `File` node, and each ATX heading (`#` to `######`) becomes a `Resource` node. A heading's span runs to the next heading. Headings inside fenced code blocks are ignored.
- **Timing**: a file is read only after the writer releases it (1000 ms stability window, polled every 100 ms), so partial writes are never indexed.
- **Deletes**: removing a file deletes its `File` node and its heading nodes, and prunes Folder nodes that no longer hold files.
- **Startup**: the watcher does not index existing files. Run `index_repository` once for the initial state.
- **Opt out**: `SYNAPTREE_WATCH=0`.

**Where it watches**: the watcher uses the server's working directory, so start the server from the root of the repo whose `docs/designs/` you want. A server started from another folder watches that folder's `docs/designs/`, or nothing if it has none.

**Project name**: the watcher writes under the same project name `index_repository` uses. If the two names differ, the docs end up in a separate project and queries on your code project will not see them. The name is chosen in this order:

1. `SYNAPTREE_PROJECT`, if set.
2. The basename of the working directory (`C:\dev\my-app` becomes `my-app`).

**When to set `SYNAPTREE_PROJECT`**:

- The folder name differs from the name you indexed under (you indexed the repo as `synaptree`, but the folder is `synaptree-mcp`).
- The server runs in a different working directory from the repo, for example a stdio host that starts it from its own folder.

**How to set it**:

- **Host install (`claude mcp add` or `codex mcp add`)**: pass it as an environment variable when adding the server. The working directory is then the folder the client starts in, so start the client from the repo root.

  ```bash
  claude mcp add -e SYNAPTREE_PROJECT=my-app synaptree -- node /path/to/synaptree-mcp/src/cli.js --stdio
  ```

- **`npm start` from the server checkout**: export it in the shell before starting, or put it in the server's own `.env`.

  ```bash
  SYNAPTREE_PROJECT=my-app npm start
  ```

  ```bash
  # PowerShell
  $env:SYNAPTREE_PROJECT = "my-app"; npm start
  ```

- **Docker**: add it to the `environment:` block of the `synaptree` service in `docker-compose.yml`, or to the `.env` next to it. Inside the container the working directory is the server's own folder, not your repo, so the watcher cannot see your `docs/designs/` through a container unless the server is started there. Run the host install if you want EGM linkup for a repo on your machine.

**Precedence**: `.env` is authoritative for `SYNAPTREE_*` keys. If `SYNAPTREE_PROJECT` is set in the server's `.env`, it overrides a value set in your shell or in `claude mcp add -e`. Set it in one place only.

### Keep it in sync

Run `synaptree-client` next to your code. It watches the folder and posts changed files to
`/api/v1/sync`; each file is purged and rebuilt atomically. Service files for systemd, NSSM
(Windows) and launchd are in `client/`.

#### Standalone client binaries

No Node install needed. Each binary is a Node single-executable build and must be built on its own
OS, so CI builds one per platform (`.github/workflows/client-binaries.yml`; pushing a `v*` tag
attaches them to a GitHub Release, otherwise they are workflow artifacts):

| Platform | Binary |
| --- | --- |
| Windows x64 | `synaptree-client-win-x64.exe` |
| macOS Apple Silicon | `synaptree-client-macos-arm64` |
| macOS Intel | `synaptree-client-macos-x64` |
| Linux x64 (generic, glibc) | `synaptree-client-linux-x64` |
| Linux arm64 (glibc) | `synaptree-client-linux-arm64` |

```bash
synaptree-client path/to/synaptree-client.json
```

Or build for your own OS with `npm run build:client` (output in `dist-client/`). musl distros such
as Alpine are not covered; use the Node client there. Only the Windows binary has been verified by
hand; the macOS and Linux ones are built and smoke-tested by CI.

### Re-index on every commit

`scripts/git-hooks/post-commit` and `post-merge` call `/api/v1/sync/auto` in the background, so the graph always matches HEAD. Enable once per clone:

```bash
git config core.hooksPath scripts/git-hooks
```

Set `SYNAPTREE_ROOT=/workspace/<repo>` when the server runs in Docker, and `SYNAPTREE_PROJECT`, `SYNAPTREE_URL`, `SYNAPTREE_TOKEN` as needed.

**Agent swarms and worktrees.** The hook skips worktrees on purpose: each throwaway worktree would create an orphan project. Policy for LLM agents: the graph describes the main checkout (base branch, refreshed on every commit/merge there). Inside a worktree, use the graph for structure (`search_graph`, `trace_path`, `get_code_snippet`) and treat it as base-branch state; use `git diff` / `git grep` for your own uncommitted or branch-local changes. After a worktree branch merges, the post-merge hook in the main checkout re-indexes it.

## Tools

Indexing and graph: `index_repository`, `list_projects`, `index_status`, `snooze_project`,
`delete_project`, `search_graph`, `search_code`, `get_code_snippet`, `trace_path`, `query_graph`
(read-only, writes return 403), `get_architecture`, `get_graph_schema`, `detect_changes`,
`manage_adr`, `ingest_traces`, `annotate_element`, `get_annotations`, `export_graph`, `import_graph`.

`export_graph` returns a project's nodes, edges and annotations as portable JSON
(`synaptree-export/1`; embeddings and tenant ids are stripped). `import_graph` loads that JSON into
any project name, validating labels and edge types first. Use it to back up, move or share an index.

LLM: `estimate_cost`, `ask_flow`, `summarize_symbol`, `get_llm_settings`, `set_llm_settings`,
`get_usage`. Most calls arrive through MCP from the Claude or Codex chat. Guardrails apply only to a
paid remote API source: asks under 50k tokens run, 50k-100k need approval, above 100k need a strong
confirmation, plus a per-minute call cap, a daily budget and a timeout. A local LLM, and calls that
generate annotations (`summarize_symbol`), are exempt. All limits are editable in Settings or via
`set_llm_settings`; the defaults are conservative.

Tokens saved (an estimate): every successful MCP call to `get_code_snippet`, `search_graph`,
`trace_path` or `get_architecture` records `response` (~4 chars/token of the result) and `baseline`
(the same estimate for the whole distinct files the result touches, i.e. the files an agent would
open without the graph; `get_architecture` uses all indexed files). `saved = max(0, baseline -
response)`. Totals are stored per tool and per day, returned by `get_usage` as
`savings: {saved, baseline, response, calls, by_tool, history}`, and shown as a "Tokens saved" card
on the Architecture tab. Failed calls and the admin UI's own REST calls are not counted.

Databases (read-only): `erd_list_connections`, `erd_save_connection`, `erd_delete_connection`,
`erd_test_connection`, `erd_get_model`, `erd_export`, `erd_ai_generate`, `erd_save_to_index`,
`list_db_schemas`, `delete_db_schema`, `get_db_schema`, `get_table_relationships`. NoSQL schemas
are sampled and depth/field-limited, and are reported as truncated when limits apply. Only names,
types and flags are stored, never row values.

## Guardrails: decisions, doc links, phase gate, ledger

Four advisory guardrails for agents using synaptree. State is stored per project in synaptree's own
store (`store.json`), never in your repository. There are no `manifest.yaml` or `execution-ledger.json`
files.

| Tool | Purpose |
| --- | --- |
| `record_decision` | Records a decision as PENDING, DECIDED or REJECTED. DECIDED needs a summary of 20+ characters. REJECTED, or reopening a decision, needs a reason. |
| `set_phase` | Sets the phase: `brainstorm`, `planning`, `goldfish_review`, `implementation` or `complete`. Moving forward into `goldfish_review` or `implementation` is blocked with a 409 `gate_blocked` while any decision is PENDING or any doc is `needs_review`. Moving backward is never blocked. |
| `create_doc` | Registers a doc. Uses an explicit `parent`, or a word-overlap suggestion. The suggestion auto-links only when at least 3 docs exist, the best score is >= 0.35 and it beats the runner-up by >= 0.10. Otherwise the doc attaches to the first doc and is marked `needs_review`. |
| `link_doc` | Sets a parent explicitly, clears `needs_review`, and rejects cycles. |
| `manage_ledger` | Adds, updates and lists tasks per doc. Task states: TODO, IN_PROGRESS, COMPLETED. |
| `complete_doc` | Returns 409 `incomplete` (listing the remaining tasks) or 409 `empty_ledger` until every task of that doc is COMPLETED. |
| `guardrail_status` | Read-only snapshot of the phase, decisions, docs and ledger. |
| `get_scoped_node` | Read-only. Takes `node_id` `K#` (doc), `T#` (task) or `D#` (decision) and returns it with its direct constraints (its own decisions and its parent's), project-wide decisions, tasks and children. Output is capped at about 12 KB. |
| `claim_task` | Claims a task for `agent_id` with a lease (`lease_seconds`, 30 to 3600, default 900). The same agent renews; an expired lease can be reclaimed. A live lease held by another agent returns 409 `claimed`. |
| `finish_project` | Closes the project by moving it to the `complete` phase. Refuses with 409 `finish_blocked` (see below). |

`set_phase` also accepts `complete`. Mutations are refused with 409 `project_complete` once the project is complete, except `set_phase`.

**The status line (HUD).** Tools that take a `project` add one line as a second content block of the
MCP response, once that project has guardrail state.

- The line always starts with `phase=`, `pending=` and `needs_review=`.
  In `implementation` and `complete` it also shows ledger progress with a 10-character bar.
- In other phases it appears only when something is PENDING, `needs_review` or an orphan.
- It is not added to REST responses, to `guardrail_status`, or to tools without a `project`.
- It is not counted in the token-savings figures.

**Decision scope and the orphan gate.** A decision has a `scope`: `doc` (the default for new decisions) or
`project` (applies everywhere, never an orphan). `record_decision` takes `applies_to` (doc ids), `create_doc`
takes `decisions`, and `link_doc` takes `decisions` and `remove_decisions`. A decision or doc can hold at
most 20 links. Decisions recorded before this change have no stored scope and count as `project`. Updating a
decision keeps its scope unless you pass one.

- `orphan_decisions`: a DECIDED, doc-scoped decision that no doc references.
- `unmanifested_docs`: a leaf doc with no ledger tasks, not `done`, and a kind other than `reference`, `note`
  or `research` (compared case-insensitively).

`gate_blocked` blockers have four keys: `pending_decisions`, `unlinked_docs`, `orphan_decisions` and
`unmanifested_docs`. Entering `goldfish_review` checks the first three. Entering `implementation` checks all
four. `link_doc` now takes an optional `parent`, but at least one of `parent`, `decisions` or `remove_decisions`
is required. A call without `parent` never clears `needs_review`.

**Completion.** `finish_project` and `set_phase` with `complete` both run the same check. It returns 409
`finish_blocked` with a `reasons` list (all failures, not just the first). The reason codes are `wrong_phase`,
`empty_ledger`, `incomplete` (up to 20 items), `docs_not_done` and `gate_blocked`. `complete_doc` must be
called for each doc that has tasks. Completing one doc is never blocked by another doc. Changing a task in a
`done` doc reopens that doc (`doc_reopened`). Moving back from `complete` to `implementation` is allowed, and
the next finish re-runs the check.

**Ledger and claims.** `manage_ledger` status accepts `TODO`, `IN_PROGRESS`, `COMPLETED` and the markers
`[ ]`, `[/]`, `[x]`. Results include a `marker` field. In the `implementation` phase, setting `IN_PROGRESS`
requires `agent_id` (400 `agent_id_required`). A task with a live lease can move to `COMPLETED` or `TODO` only
for its claimant (409 `claimed_by_other`). After a lease expires, anyone can release the task. `force: true`
with a `reason` overrides ownership and writes a `ledger_forced` audit event. `agent_id` is self-asserted and
advisory: it is a coordination label, not authentication, and anyone can pass any id.

**HUD fragments.** The status line is built in one fixed order: `phase=... | pending=N | needs_review=N | ledger n/n bar
| in_progress=N | stale=M | orphans=N`. The ledger fragment appears only in `implementation` and `complete`.
`in_progress` and `stale` appear only in `implementation`. `in_progress`, `stale` and `orphans` appear only
when their count is above zero.

**Store locking.** Writes from different processes on the same machine are serialized by a lock file,
`store.lock`, in the data directory. Each write reloads the store under the lock. A lock older than the stale
age is taken over. `SYNAPTREE_LOCK_TIMEOUT_MS` (default 5000) sets how long a write waits. `SYNAPTREE_LOCK_STALE_MS`
(default 10000) sets the stale age. A corrupt `store.json` returns 503 `store_unreadable` and is never
replaced by an empty store. The retriable 503 codes are `lock_timeout`, `lock_lost` and `store_unreadable`
(`retry: true`). A 503 means nothing was written, so the call is safe to repeat.
### What this does not do

- synaptree only sees tool calls. It cannot read the agent's prose and cannot stop file edits. The gate
  blocks only its own `set_phase` and `complete_doc` calls.
- Only decisions the agent records are tracked.
- The gate checks that records exist, not that they are true.
- Phase is per project and shared by every agent using that project.
- Processes on one machine may share a data directory; writes are serialized by `store.lock`. Sharing a data
  directory across hosts or over network filesystems is unsupported.
- A project with no indexed content cannot be cleared with `delete_project`, so its guardrail state
  stays until the project is indexed and then deleted.
- Word-overlap linking is a suggestion. Check the returned score.
- The store lock covers one machine with local disk. Its atomic file creation (`O_EXCL`) is not
  supported on network filesystems without it (for example NFSv2). Multiple replicas sharing one data volume
  are not supported; they need a database-backed store. Locking on Docker Desktop bind mounts is not verified.
  The tests cover local disk only.
- `agent_id` is advisory (see "Ledger and claims"). Claims coordinate cooperating agents; they do not stop others.

**Caps per project:** 200 docs, 500 tasks, 100 decisions. Doc content is cut to 4 KB.

## Accuracy: linking is heuristic

Cross-file linking is **not** a full language server. The "Hybrid LST/LSP" pass is Tree-sitter
definitions (Pass 1) plus a cross-file linker (Pass 2) that matches import paths and call
expressions against a global symbol table; no live language servers are run. Calls that match exactly one target become `CALLS`; ambiguous
ones are recorded as `USAGE`. Dynamic dispatch, reflection, macros and generated code can be
missed or mislinked. Treat the graph as a fast, useful map rather than ground truth. Relationships
inferred by name or by a local LLM in an ERD are marked `inferred_name` / `inferred_llm`, not declared.

Edge types: the linker and indexer currently produce `CONTAINS_FOLDER`, `CONTAINS_FILE`, `DEFINES`,
`DEFINES_METHOD`, `MEMBER_OF`, `IMPORTS`, `CALLS`, `CALL_REFERENCE`, `USAGE`, `IMPLEMENTS`, `INHERITS`,
`USES_TYPE` and `HANDLES`. The other names in the schema are reserved for future passes and are never
written today; `get_graph_schema` lists them separately as `produced_edge_types` and
`reserved_edge_types`, plus `populated_edge_types` for what your graph really contains.

Stored source and summaries: each symbol node keeps a capped copy of its source (8 KB), so `get_code_snippet` works without the repo mounted (disk is the fallback) and `export_graph` leaves it out. Set `SYNAPTREE_SUMMARIZE_ON_INDEX=1` (off by default) to have a *local* LLM write a one-paragraph `summary` for functions, methods and classes without a docstring after each `index_repository`; `SYNAPTREE_SUMMARIZE_LIMIT` (default 25) caps symbols per run. Paid sources are never used for this.

Embeddings (optional, `embeddings.url`): at most `embeddings.maxNodes` nodes (default 5000) are embedded,
and a batch is dropped if the returned vectors do not match the index dimension, so a wrong model
cannot corrupt the vector index.

Extra languages: set `SYNAPTREE_GRAMMARS_DIR` to a folder holding `tree-sitter-<name>.wasm` files. A
grammar found there wins over the bundled one; anything missing falls back to the bundled set. A new
language also needs an entry in `src/langs.js` describing its definition and call node types.

Languages without a bundled Tree-sitter grammar (for example R, SQL, GraphQL, Protocol Buffers)
get lightweight pattern-based extraction instead of a full parse. Grammars run as WASM
(`web-tree-sitter`), so there are no native bindings and nothing to compile.

**Choosing `trace_path` parameters.** Callers / impact: `direction:"in"`, depth 1-3. True callees: `direction:"out"`, depth 1 (depth 2+ adds same-name noise). Test files are excluded unless `include_tests:true`.

## Troubleshooting

```
Symptom                                        Cause and fix
index_repository: "No local path known"        Pass root_path (absolute, as seen by the server; /workspace/<repo> in Docker)
root_path is not a directory                   The path must exist inside the container; check WORKSPACE_DIR in .env
Git Bash rewrites /workspace/... to C:/...     Set MSYS_NO_PATHCONV=1 or use PowerShell
UI shows demo data                             Open /ui/ (with the trailing slash) and pick a project in the dropdown
Graph looks stale after a commit               Run index_repository, or enable the git hooks above
Tools return 401                               Send Authorization: Bearer <SYNAPTREE_TOKEN>
Cannot connect to Neo4j                        docker compose up -d; Bolt is on 17687, not 7687
EGM docs missing from the graph                Check the project name (SYNAPTREE_PROJECT) matches index_repository, and that the server started in the repo root
```

## Tests

```bash
npm test      # node --test tests/unit/*.test.js
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Support

I provide the vibes, the agents provide the code, and hopefully, you provide the coffee. ☕ Keep the local LLMs humming and my prompt-typing fingers caffeinated right here: https://buymeacoffee.com/maxh8086

<a href="https://buymeacoffee.com/maxh8086"><img src="docs/buymeacoffee-qr.png" alt="Buy Me a Coffee QR code" width="220"></a>
