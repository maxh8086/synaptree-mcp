# Changelog

## Unreleased

### Added

- Guardrails for agents: new tools `record_decision`, `set_phase`, `create_doc`, `link_doc`, `manage_ledger`, `complete_doc` and `guardrail_status`. Project-scoped MCP responses get a one-line status line (HUD) once the project has guardrail state. Per-project state is kept in the synaptree store, not in the repository.
- Guardrails: new tools `get_scoped_node`, `claim_task` and `finish_project`, and a new terminal `complete` phase, reachable only from `implementation`.
- Guardrails: decision scope (`doc` or `project`), `applies_to` on `record_decision`, and `decisions` on `create_doc` and `link_doc`, with an orphan gate (`orphan_decisions`, `unmanifested_docs`). Legacy decisions without a scope count as project-scoped.
- Guardrails: task claim leases (default 900 s) with `agent_id`, a `force` override with `reason` on `manage_ledger`, and marker aliases `[ ]`, `[/]`, `[x]` for ledger status.

### Changed

- The store is now safe across processes: writes take a lock file and reload the store under it.
- The store constructor and reads fail with 503 `store_unreadable` on a corrupt `store.json` instead of silently starting empty.
- `gate_blocked` blockers have four keys: `pending_decisions`, `unlinked_docs`, `orphan_decisions` and `unmanifested_docs`.
- `link_doc` `parent` is optional. At least one of `parent`, `decisions` or `remove_decisions` is required.
- In `implementation`, setting a task `IN_PROGRESS` through `manage_ledger` requires `agent_id`.

### Fixed

- The store now saves via a temp file and rename, so a crash cannot truncate `store.json`.
- The plugin launcher looks up the synaptree container by its compose service label (`docker compose ps -q synaptree`) instead of a fixed name. A stale hash-prefixed container no longer breaks the bridge. `SYNAPTREE_CONTAINER` still overrides the lookup.
- The default data directory is anchored to the repository root, not the process working directory. A server launched from `C:\Windows\System32` no longer fails with `EPERM` creating its store. `SYNAPTREE_DATA_DIR` still overrides it.
