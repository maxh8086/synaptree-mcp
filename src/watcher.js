// Background watcher for EGM planning artifacts. Watches docs/designs/ under the working directory and routes
// Markdown add/change/unlink events into the existing indexer (indexFiles) and purge (deleteFile + pruneFolders).
// Writes are only processed once the writer has released the file (chokidar awaitWriteFinish), and events are
// applied one at a time so concurrent EGM writes never interleave in the graph.
import path from 'node:path';
import fs from 'node:fs/promises';
import { watch } from 'chokidar';
import { indexFiles } from './indexer.js';

export const DESIGNS_DIR = path.join('docs', 'designs');
export const WRITE_STABILITY_MS = 1000;
export const WRITE_POLL_MS = 100;

const isMarkdown = (p) => /\.(md|markdown)$/i.test(p);

// True when any path segment below `dir` is hidden (".git", ".cache", ...).
export function isHiddenPath(dir, full) {
  const rel = path.relative(dir, full);
  return rel.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '');
}

// True for the watched directory and its ancestors, and for everything under docs/designs/, excluding hidden paths.
export function isOnDesignsBranch(root, full) {
  const rel = path.relative(root, full).split(path.sep).join('/');
  if (rel.split('/').some((seg) => seg.startsWith('.') && seg !== '')) return false;
  const designs = DESIGNS_DIR.split(path.sep).join('/');
  if (rel === '') return true;
  return designs === rel || designs.startsWith(rel + '/') || rel.startsWith(designs + '/');
}

// Repo-relative, forward-slash path, matching the `rel` keys indexRepository uses.
const relOf = (root, full) => path.relative(root, full).split(path.sep).join('/');

// Folder nodes that no surviving File lives under are removed (same rule as indexRepository).
async function pruneOrphanFolders(db, t, project) {
  if (typeof db.pruneFolders !== 'function') return;
  const keep = new Set([project]);
  for (const rel of (await db.fileHashes(t)).keys()) {
    let acc = project;
    for (const seg of rel.split('/').slice(0, -1)) keep.add((acc = `${acc}.${seg}`));
  }
  await db.pruneFolders(t, keep);
}

// Serialised event handlers. Every upsert/remove is queued behind the previous one; a failure is logged and
// does not stop the queue.
export function createDesignIngestor({ db, tenant, project, root, grammarsDir, log = console.error }) {
  const t = { user_id: tenant.user_id, repo_name: project };
  let queue = Promise.resolve();
  const enqueue = (task, label) => {
    queue = queue.then(task).catch((err) => log(`[synaptree-watch] ${label}: ${err.message}`));
    return queue;
  };

  return {
    upsert(full) {
      return enqueue(async () => {
        if (!isMarkdown(full)) return null;
        const source = await fs.readFile(full, 'utf8');
        return indexFiles(db, t, project, [{ rel: relOf(root, full), source }], { grammarsDir });
      }, `index ${full}`);
    },
    remove(full) {
      return enqueue(async () => {
        if (!isMarkdown(full)) return null;
        await db.deleteFile(t, relOf(root, full));
        await pruneOrphanFolders(db, t, project);
        return true;
      }, `remove ${full}`);
    },
    idle() { return queue; },
  };
}

// Starts the watcher. Returns { close, ingestor } or null when disabled.
export function startDesignWatcher(ctx, { root = process.cwd(), project, log = console.error } = {}) {
  const proj = project || process.env.SYNAPTREE_PROJECT || path.basename(path.resolve(root));
  const dir = path.resolve(root, DESIGNS_DIR);
  const ingestor = createDesignIngestor({
    db: ctx.db, tenant: ctx.tenant, project: proj, root: path.resolve(root), grammarsDir: ctx.cfg.grammarsDir, log,
  });

  // chokidar does not pick up a directory created after the watch starts, so the watch root is the working
  // directory and everything outside the docs/designs/ branch is ignored. Only ancestors of docs/designs/ are
  // traversed, which keeps node_modules and the rest of the repo out of the walk.
  const watcher = watch(path.resolve(root), {
    persistent: true,
    ignoreInitial: true, // the full index is still run explicitly via index_repository
    ignorePermissionErrors: true,
    ignored: (p) => !isOnDesignsBranch(path.resolve(root), p),
    awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
  });

  watcher
    .on('add', (full) => { if (isMarkdown(full)) ingestor.upsert(full); })
    .on('change', (full) => { if (isMarkdown(full)) ingestor.upsert(full); })
    .on('unlink', (full) => { if (isMarkdown(full)) ingestor.remove(full); })
    .on('error', (err) => log(`[synaptree-watch] error: ${err.message}`));

  log(`[synaptree-watch] watching ${dir} as project "${proj}"`);
  return {
    ingestor,
    close: () => watcher.close(),
  };
}
