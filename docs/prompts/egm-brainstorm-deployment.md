# EGM brainstorm prompt: interactive install, deployment roles, and scaled server deployment

Use with `egm:egm-brainstorm`. Target repo: `C:\Users\vaibh\Downloads\Projects\synaptree-mcp`.
Trigger reason: feature-sized (touches more than one module, adds an interface, config and schema, and has open requirements).

---

## Prompt

You are the EGM planner for `synaptree-mcp`, a Node.js MCP server (`src/cli.js`, Express in `src/server.js`, Neo4j via `src/db.js`) with a client (`client/synaptree-client.js`), a Claude Code plugin launcher (`src/launcher.js`), and Docker assets (`Dockerfile`, `docker-compose.yml`, `scripts/init-env.mjs`).

Brainstorm, draft a design, and run the EGM review lenses on it. Do not write code yet. Produce a design that I can approve, then split into `plan_add` tasks.

### Goal

Replace the current manual setup with an **interactive installer** that asks how synaptree should run, and provide a **server deployment** that can run on Docker, Kubernetes, or OpenShift and scale with load.

### Current state (verify each claim against the code before relying on it)

- Setup is manual: `node scripts/init-env.mjs`, then `docker compose up -d`, then `npm start` (README quick start). No prompts exist anywhere. `init-env.mjs` writes `.env` non-interactively.
- The role is implicit: `serve` mode runs the HTTP API, SSE `/sse`, and UI; `--stdio` runs a local MCP bridge; `synaptree-client` runs next to code and pushes to `/api/v1/sync` and `/api/v1/index-file`.
- Auth is a single optional bearer token (`SYNAPTREE_TOKEN`, `src/server.js` `guard`). It is compared with `timingSafeEqual`. There is no TLS in the server.
- Tenancy is one `user_id` per process (`SYNAPTREE_USER_ID`). There is no per-user isolation.
- Known scaling blockers to design around:
  1. SSE sessions live in an in-process `Map` (`src/server.js`, `sessions`). A second replica cannot answer `/messages` for a session opened on the first.
  2. `Store` writes settings, usage, and saved connections to a local `dataDir` (`src/store.js`). Replicas do not share it.
  3. The background design watcher (`src/watcher.js`, started in `src/cli.js`) runs in every process and watches `process.cwd()`. Only one replica should own it.
  4. The EGM bridge (`scripts/setup-egm-bridge.js`) writes into the user's local plugin cache. It is meaningful only on a developer machine, not on a cluster pod.
  5. The launcher (`src/launcher.js`) hard-codes `docker compose` and `docker exec`. It cannot run on Kubernetes or OpenShift.
  6. Neo4j is a single bundled instance in `docker-compose.yml`. Scaling the app does not scale the graph store.
- Verify each of these before designing. If any is wrong, say so.

### Required features

**A. Interactive installer** (`scripts/install.mjs` or similar, one entry point)

1. Ask: *"Run everything locally, or use a central server?"*
   - **Local**: start the stdio bridge and optionally the Docker stack on this machine. Write the MCP registration line for the chosen client (Claude Code, Codex, or other).
   - **Central server**: go to question 2.
   - **Client only**: connect to an existing server. Ask for the URL and token, then write `synaptree-client.json` and optionally install the service (`client/service/*`).
2. If **central server**, ask: *"Is this machine the server, or a client of an existing server?"*
   - **Server**: ask for the deployment target (question 3).
   - **Client**: as above.
3. If **server**, ask for the target: **Docker (single host)**, **Kubernetes**, or **OpenShift**. Each target generates its own manifests or chart values. Docker generates compose; Kubernetes and OpenShift generate Helm values and/or Kustomize overlays. OpenShift adds Route, SCC-compatible security context, and an image stream option.
4. Ask for the scaling policy (question 4 only for server targets):
   - Minimum and maximum replicas.
   - Metric: CPU, request rate, or queue depth. Default CPU 70%.
   - Whether Neo4j is bundled or external (`NEO4J_URI`). Autoscaling is blocked for the bundled single instance, so the installer must warn and must not claim the graph scales.
5. Ask for security: bearer token (generate and store as a Kubernetes Secret or OpenShift Secret, never print it), TLS termination (ingress, Route, or reverse proxy), and bind address.
6. Show the full plan of files to be written and commands to be run. Ask for approval before writing anything. Never print secrets. Never overwrite an existing `.env` (keep the existing `init-env.mjs` rule).
7. Make the installer idempotent and non-interactive with flags (`--role`, `--target`, `--min-replicas`, `--max-replicas`, `--yes`) for CI.

**B. Server deployment targets**

- **Docker**: keep `docker-compose.yml`. Add an explicit server profile. Keep the image binding `0.0.0.0` only inside the container as the README states.
- **Kubernetes**: Deployment, Service, Ingress, HorizontalPodAutoscaler (`autoscaling/v2`), PodDisruptionBudget, readiness and liveness probes on `/healthz`, Secret for `SYNAPTREE_TOKEN` and `NEO4J_PASSWORD`, ConfigMap for non-secret settings, and a PVC or external store for `dataDir` if settings must persist.
- **OpenShift**: the Kubernetes set plus Route with TLS edge termination, Security Context Constraints compatible (non-root, arbitrary UID, writable dirs only where needed), and optional ImageStream and BuildConfig.
- Helm chart or Kustomize base with overlays for each target. Choose one and justify it.

**C. Scaling design (decide and justify)**

- Make app replicas stateless. Decide how to handle the SSE `sessions` Map: sticky sessions on the load balancer, or move to the Streamable HTTP transport, or accept single-replica MCP-over-SSE and scale only the REST API. Give a recommendation.
- Move persistent settings and usage out of local files (`Store`) to the Neo4j graph or a shared database. Or state why local files are acceptable.
- Run the design watcher on exactly one replica (leader election via a Lease in Kubernetes, or a dedicated single-replica worker Deployment).
- Define the Neo4j story: external managed or clustered Neo4j, and the scale path if the graph becomes the bottleneck.
- Define the client path: many `synaptree-client` instances pushing files, and how `/sync` concurrency is safe per file.

**D. Security and network**

- TLS is required for any non-local server. Terminate at ingress or Route. Decide whether the app should also serve HTTPS (currently it does not).
- Token auth stays as the minimum. Recommend whether per-user tokens are needed for a shared server, given the single-tenant design today.
- Check that `neo4j+s://` or `bolt+s://` is used when the graph is remote.

**E. Non-goals**

- Do not rewrite the graph model or the indexer.
- Do not change the MCP tool surface.
- Do not add multi-tenant isolation in this round unless the design requires it, and if so, flag it as a separate plan.

### Required output from the brainstorm

1. Restated requirements and any ambiguity you found, with your assumed answer for each.
2. Verified current-state list (confirm or correct the six scaling blockers above, with file and line references).
3. Architecture: installer flow diagram, role matrix (local, central server, client), and the deployment target matrix (Docker, Kubernetes, OpenShift).
4. Decisions with recommendation and rejected alternatives for: SSE session handling, Store persistence, watcher ownership, Neo4j scaling, autoscaling metric, TLS placement, and installer technology.
5. Task breakdown for `plan_add`. Each task must give:
   - exact file paths,
   - one acceptance command (for example `node --test ...` or `helm lint ...` or `kubectl apply --dry-run=client ...`),
   - what must not change,
   - a tool-call limit.
   Order tasks so the installer skeleton and the Docker target come first, then Kubernetes, then OpenShift, then autoscaling tests.
6. Risks and open questions for me to answer before approval. Keep these short and specific.

### Constraints

- Node.js ESM, matching the existing code style. No new runtime dependency without listing it and its reason.
- Keep the default path unchanged: running `npm start` with no installer must still work exactly as before.
- Secrets never appear in logs, chat, or task text.
- Do not add Co-Authored-By trailers or generated-with footers to commits or PRs.
- Routine execution (edits, tests, builds) goes to Haiku subagents or the tokenfrugal builder. Sonnet and Opus plan and review.

### Review

Run the six EGM lenses (`egm-design`, `egm-codebase-details`, `egm-zoom-out`, `egm-comprehension`, `egm-implementation-readiness`, `egm-structural`) and `egm-synthesizer`, each as a fresh subagent. If fresh subagents are unavailable, self-review with a checklist and mark the design "unreviewed".

Wait for my approval of the design before dispatching any task.
