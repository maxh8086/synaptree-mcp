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
