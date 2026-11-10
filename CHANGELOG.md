# Changelog

## Unreleased

### Fixed

- The plugin launcher looks up the synaptree container by its compose service label (`docker compose ps -q synaptree`) instead of a fixed name. A stale hash-prefixed container no longer breaks the bridge. `SYNAPTREE_CONTAINER` still overrides the lookup.
- The default data directory is anchored to the repository root, not the process working directory. A server launched from `C:\Windows\System32` no longer fails with `EPERM` creating its store. `SYNAPTREE_DATA_DIR` still overrides it.
