// Injects SynapTree data-access permissions into the EGM plugin's skill and agent prompts.
//
// Plugin root resolution, in order:
//   1. EGM_PLUGIN_PATH, if set (always used, even with --no-auto).
//   2. Auto (default): the newest version directory under %USERPROFILE%\.claude\plugins\cache\egm\egm\
//      (or $HOME/.claude/... elsewhere).
//   3. --no-auto: skip the cache fallback. With no EGM_PLUGIN_PATH, nothing is written.
//
// Targets: skills/egm_review/SKILL.md, skills/egm_brainstorm/SKILL.md, and every agents/*.md.
//
// Safe to run repeatedly: a file that already mentions "SYNAPTREE" is left alone. Missing files and a
// missing plugin are reported as warnings. The script never exits non-zero, so a missing or unusual
// EGM install cannot break `npm install`.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'SYNAPTREE';

// Skill prompts that get the block, relative to the EGM plugin root. Agent prompts are added at run time
// from agents/*.md so new agents are picked up without editing this list.
export const TARGETS = [
  'skills/egm_review/SKILL.md',
  'skills/egm_brainstorm/SKILL.md',
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

export function egmCacheDir(home = os.homedir()) {
  return path.join(home, '.claude', 'plugins', 'cache', 'egm', 'egm');
}

// Compares dotted numeric versions, e.g. 0.10.0 > 0.9.2.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Returns { root, source } or { root: null, searched } when no plugin can be found.
export async function resolvePluginRoot({ env = process.env, home = os.homedir(), auto = true } = {}) {
  if (env.EGM_PLUGIN_PATH) {
    return { root: path.resolve(env.EGM_PLUGIN_PATH), source: 'EGM_PLUGIN_PATH' };
  }
  if (!auto) return { root: null, searched: '(auto off: set EGM_PLUGIN_PATH or drop --no-auto)' };
  const base = egmCacheDir(home);
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return { root: null, searched: base };
  }
  const versions = entries
    .filter((e) => e.isDirectory() && /^\d+(\.\d+)*$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => compareVersions(b, a));
  if (versions.length === 0) return { root: null, searched: base };
  return { root: path.join(base, versions[0]), source: `newest cached version ${versions[0]}` };
}

export async function setupEgmBridge({ env = process.env, home = os.homedir(), auto = true, log = console.error } = {}) {
  const result = { root: null, updated: [], skipped: [], missing: [] };

  const resolved = await resolvePluginRoot({ env, home, auto });
  if (!resolved.root) {
    log(`[setup-egm-bridge] EGM plugin not found; looked in ${resolved.searched}. Set EGM_PLUGIN_PATH to the plugin root. Nothing injected.`);
    return result;
  }
  result.root = resolved.root;
  log(`[setup-egm-bridge] plugin root: ${resolved.root} (${resolved.source})`);

  const files = [...TARGETS];
  const agentDir = path.join(resolved.root, 'agents');
  try {
    const agents = (await fs.readdir(agentDir)).filter((n) => n.endsWith('.md')).sort();
    files.push(...agents.map((n) => `agents/${n}`));
  } catch (err) {
    log(`[setup-egm-bridge] agents folder not found: ${agentDir} (${err.code || err.message})`);
  }

  for (const rel of files) {
    const file = path.join(resolved.root, rel);
    let existing;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        log(`[setup-egm-bridge] target not found: ${file}`);
        result.missing.push(rel);
      } else {
        log(`[setup-egm-bridge] cannot read ${file}: ${err.message}`);
      }
      continue;
    }
    const next = injectInto(existing);
    if (next === null) { result.skipped.push(rel); continue; }
    try {
      await fs.writeFile(file, next, 'utf8');
      result.updated.push(rel);
    } catch (err) {
      log(`[setup-egm-bridge] cannot write ${file}: ${err.message}`);
    }
  }

  log(`[setup-egm-bridge] updated=${result.updated.length} already-set=${result.skipped.length} missing=${result.missing.length}`);
  return result;
}

// Run as a script. Auto-resolve of the newest cache version is on by default; --no-auto turns it off
// (the npm postinstall/postbuild hooks pass --no-auto, so they only write when EGM_PLUGIN_PATH is set).
// Always exits 0.
const isEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  const auto = !process.argv.includes('--no-auto');
  setupEgmBridge({ auto }).catch((err) => console.error(`[setup-egm-bridge] skipped: ${err.message}`));
}
