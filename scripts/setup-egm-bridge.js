// Injects SynapTree data-access permissions into EGM sub-agent prompts under <workspace>/.egm/skills/.
//
// Workspace resolution: EGM_WORKSPACE_PATH, else process.cwd(). npm lifecycle scripts run with the package
// root as cwd, so during `npm install` in this repo the fallback points at the repo itself, where no .egm
// tree exists, and the script does nothing. Point EGM_WORKSPACE_PATH at the EGM workspace to inject there.
//
// Safe to run repeatedly: a file that already mentions "SYNAPTREE" is left alone. Missing files are skipped.
// The script never exits non-zero, so a missing or unusual EGM layout cannot break `npm install`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'SYNAPTREE';

// Sub-agent prompts that get the block, relative to <workspace>/.egm/skills/.
export const TARGETS = [
  'egm-review/system.md',
  'egm-blueprint/system.md',
  'review/system.md',
];

export const BLOCK = [
  '## CONFIGURATION & DATA ACCESS (AUTOMATED BY SYNAPTREE)',
  '- You are explicitly allowed to use the local Model Context Protocol (MCP) server named `synaptree`.',
  '- Before reporting an isolated or "missing" artifact path as an error, you MUST invoke `synaptree` graph queries to locate the structural layout of the file workspace.',
  '',
].join('\n');

// Returns the text to write, or null when the file should be left alone.
export function injectInto(existing) {
  if (existing.includes(MARKER)) return null;
  const sep = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + BLOCK;
}

export async function setupEgmBridge({ workspace = process.env.EGM_WORKSPACE_PATH || process.cwd(), log = console.error } = {}) {
  const skillsDir = path.resolve(workspace, '.egm', 'skills');
  const result = { skillsDir, updated: [], skipped: [], missing: [] };

  try {
    await fs.access(skillsDir);
  } catch {
    log(`[setup-egm-bridge] no .egm/skills under ${path.resolve(workspace)}; nothing to do`);
    return result;
  }

  for (const rel of TARGETS) {
    const file = path.join(skillsDir, rel);
    let existing;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') { result.missing.push(rel); continue; }
      log(`[setup-egm-bridge] cannot read ${rel}: ${err.message}`);
      continue;
    }
    const next = injectInto(existing);
    if (next === null) { result.skipped.push(rel); continue; }
    try {
      await fs.writeFile(file, next, 'utf8');
      result.updated.push(rel);
    } catch (err) {
      log(`[setup-egm-bridge] cannot write ${rel}: ${err.message}`);
    }
  }

  log(`[setup-egm-bridge] ${skillsDir}: updated=${result.updated.length} already-set=${result.skipped.length} missing=${result.missing.length}`);
  return result;
}

// Run as a script (postinstall / postbuild). Always exits 0.
const isEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  setupEgmBridge().catch((err) => console.error(`[setup-egm-bridge] skipped: ${err.message}`));
}
