#!/usr/bin/env node

/**
 * Automatically point Claude Code at the Copilot proxy gateway.
 *
 * Existing Claude Code configuration is *renamed* into a backup folder that
 * Claude Code does not read, so the previous setup is no longer detected but is
 * never lost. `--restore` puts everything back.
 *
 * Dependency-free Node ESM so it runs on Windows, macOS and Linux without a build.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BACKUP_DIR_NAME = '.copilot-proxy-backups';
const MANIFEST_NAME = 'manifest.json';
const DUMMY_TOKEN = 'sk-dummy';
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_SMALL_MODEL = 'claude-haiku-4.5';
const DEFAULT_PORT = '3000';
const DEFAULT_HOST = 'localhost';

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), '..');

const c = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const supportsColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (color, text) => (supportsColor ? `${c[color]}${text}${c.reset}` : text);

const log = (msg = '') => console.log(msg);
const warn = (msg) => console.log(`${paint('yellow', '!')} ${msg}`);
const ok = (msg) => console.log(`${paint('green', 'OK')} ${msg}`);
const fail = (msg) => console.error(`${paint('red', 'ERROR')} ${msg}`);

const HELP = `
${paint('bold', 'copilot-claude-proxy configure')}

Point Claude Code at this Copilot proxy gateway. Any existing Claude Code
configuration is renamed into a backup folder (never deleted) so it is no
longer detected, then a fresh gateway configuration is written.

${paint('bold', 'Usage')}
  npm run setup:claude -- [options]
  copilot-claude-proxy configure [options]

${paint('bold', 'Options')}
  --project              Configure ./.claude/settings.local.json instead of the
                         global ~/.claude/settings.json
  --port <n>             Proxy port           (default: .env / PORT / ${DEFAULT_PORT})
  --host <h>             Proxy host           (default: .env / HOST / ${DEFAULT_HOST})
  --model <id>           ANTHROPIC_MODEL      (default: ${DEFAULT_MODEL})
  --small-model <id>     ANTHROPIC_SMALL_FAST_MODEL (default: ${DEFAULT_SMALL_MODEL})
  --keep-credentials     Do not move ~/.claude/.credentials.json aside
  --merge                Preserve existing non-"env" keys from the old settings
  --restore [id]         Undo: restore the latest (or given) backup set
  --list                 List available backup sets
  --dry-run              Print planned actions, change nothing
  --yes, -y              Skip the confirmation prompt
  --force                Allow restore to overwrite files this tool did not write
  --help, -h             Show this help

${paint('bold', 'Examples')}
  npm run setup:claude
  npm run setup:claude -- --project --port 8080
  npm run setup:claude -- --restore
`;

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    project: false,
    port: undefined,
    host: undefined,
    model: undefined,
    smallModel: undefined,
    keepCredentials: false,
    merge: false,
    restore: false,
    restoreId: undefined,
    list: false,
    dryRun: false,
    yes: false,
    force: false,
    help: false,
  };

  const needsValue = new Set(['--port', '--host', '--model', '--small-model']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (needsValue.has(arg)) {
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Option ${arg} requires a value`);
      }
      i++;
      if (arg === '--port') opts.port = next;
      else if (arg === '--host') opts.host = next;
      else if (arg === '--model') opts.model = next;
      else opts.smallModel = next;
      continue;
    }

    switch (arg) {
      case 'configure':
        break;
      case '--project':
        opts.project = true;
        break;
      case '--keep-credentials':
        opts.keepCredentials = true;
        break;
      case '--merge':
        opts.merge = true;
        break;
      case '--list':
        opts.list = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--restore':
        opts.restore = true;
        if (next !== undefined && !next.startsWith('-')) {
          opts.restoreId = next;
          i++;
        }
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// settings resolution
// ---------------------------------------------------------------------------

export function readDotEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function resolveSettings(opts, env = process.env, dotEnv = {}) {
  const port = opts.port ?? env.PORT ?? dotEnv.PORT ?? DEFAULT_PORT;
  let host = opts.host ?? env.HOST ?? dotEnv.HOST ?? DEFAULT_HOST;
  // The server may bind a wildcard address, but Claude Code must dial a real host.
  if (host === '0.0.0.0' || host === '::') host = DEFAULT_HOST;

  const model = opts.model ?? env.DEFAULT_MODEL ?? dotEnv.DEFAULT_MODEL ?? DEFAULT_MODEL;
  const smallModel = opts.smallModel ?? DEFAULT_SMALL_MODEL;

  return { host, port: String(port), baseUrl: `http://${host}:${port}`, model, smallModel };
}

export function buildSettingsEnv(resolved) {
  return {
    ANTHROPIC_BASE_URL: resolved.baseUrl,
    ANTHROPIC_AUTH_TOKEN: DUMMY_TOKEN,
    ANTHROPIC_MODEL: resolved.model,
    ANTHROPIC_SMALL_FAST_MODEL: resolved.smallModel,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// ---------------------------------------------------------------------------
// paths & manifest
// ---------------------------------------------------------------------------

export function resolvePaths(opts, home = homedir(), cwd = process.cwd()) {
  const claudeHome = path.join(home, '.claude');
  const backupRoot = path.join(claudeHome, BACKUP_DIR_NAME);
  const targetDir = opts.project ? path.join(cwd, '.claude') : claudeHome;
  const targetFile = path.join(targetDir, opts.project ? 'settings.local.json' : 'settings.json');
  const credentialsFile = path.join(claudeHome, '.credentials.json');
  return { claudeHome, backupRoot, targetDir, targetFile, credentialsFile };
}

function readManifest(backupRoot) {
  const file = path.join(backupRoot, MANIFEST_NAME);
  if (!fs.existsSync(file)) return { version: 1, runs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed.runs)) return { version: 1, runs: [] };
    return parsed;
  } catch {
    warn(`Backup manifest at ${file} is unreadable; starting a new one.`);
    return { version: 1, runs: [] };
  }
}

function writeManifest(backupRoot, manifest) {
  fs.mkdirSync(backupRoot, { recursive: true });
  writeFileAtomic(path.join(backupRoot, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
}

function newRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function uniquePath(target, exists = fs.existsSync) {
  if (!exists(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find a free backup path for ${target}`);
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, 'utf-8');
  fs.renameSync(tmp, file);
}

function moveWithRetry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Claude Code may briefly hold the file open on Windows.
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
      return;
    }
    throw err;
  }
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

async function probe(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: true, status: res.status, body: undefined };
    }
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function preflight(resolved) {
  const health = await probe(`${resolved.baseUrl}/health`);
  if (!health.ok) {
    warn(
      `Proxy is not responding at ${resolved.baseUrl}/health. ` +
        'Configuration will still be written - start it later with "npm start".'
    );
    return;
  }
  ok(`Proxy is reachable at ${resolved.baseUrl}`);

  const auth = await probe(`${resolved.baseUrl}/auth/status`);
  const authenticated = auth.ok && auth.body ? auth.body.authenticated ?? auth.body.isAuthenticated : undefined;
  if (authenticated === false) {
    warn(`Not signed in to GitHub Copilot yet - visit ${resolved.baseUrl}/auth.html`);
  }

  const models = await probe(`${resolved.baseUrl}/v1/models`);
  const ids =
    models.ok && models.body && Array.isArray(models.body.data)
      ? models.body.data.map((m) => m.id)
      : undefined;
  if (!ids || ids.length === 0) return;

  for (const [label, id] of [
    ['ANTHROPIC_MODEL', resolved.model],
    ['ANTHROPIC_SMALL_FAST_MODEL', resolved.smallModel],
  ]) {
    if (!ids.includes(id)) {
      warn(`${label} "${id}" is not in the live catalog. Available: ${ids.slice(0, 8).join(', ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// confirmation
// ---------------------------------------------------------------------------

async function confirm(question) {
  if (!process.stdin.isTTY) {
    warn('Not an interactive terminal - re-run with --yes to apply.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export function planActions(opts, paths) {
  const moves = [];
  if (fs.existsSync(paths.targetFile)) {
    moves.push({ kind: 'settings', from: paths.targetFile });
  }
  if (!opts.project && !opts.keepCredentials && fs.existsSync(paths.credentialsFile)) {
    moves.push({ kind: 'credentials', from: paths.credentialsFile });
  }
  return moves;
}

async function commandConfigure(opts) {
  const paths = resolvePaths(opts);
  const resolved = resolveSettings(opts, process.env, readDotEnv(REPO_ROOT));

  log();
  log(paint('bold', 'Claude Code -> Copilot proxy gateway'));
  log(`  Target file : ${paths.targetFile}`);
  log(`  Base URL    : ${resolved.baseUrl}`);
  log(`  Model       : ${resolved.model}  (small/fast: ${resolved.smallModel})`);
  log();

  await preflight(resolved);

  const moves = planActions(opts, paths);
  const id = newRunId();
  const runDir = path.join(paths.backupRoot, id);

  log();
  log(paint('bold', 'Planned actions'));
  if (moves.length === 0) {
    log(`  ${paint('dim', 'no existing configuration to move')}`);
  }
  for (const move of moves) {
    log(`  MOVE  ${move.from}`);
    log(`     -> ${path.join(runDir, path.basename(move.from))}`);
  }
  log(`  WRITE ${paths.targetFile}`);
  log();

  if (moves.some((m) => m.kind === 'credentials')) {
    warn(
      'Moving .credentials.json signs Claude Code out of your Anthropic account ' +
        'until you run --restore. Use --keep-credentials to skip this.'
    );
    log();
  }

  if (opts.dryRun) {
    log(paint('dim', 'Dry run - nothing was changed.'));
    return 0;
  }

  if (!opts.yes && !(await confirm('Apply these changes?'))) {
    log('Aborted.');
    return 1;
  }

  const previousSettings = opts.merge ? readJsonIfExists(paths.targetFile) : undefined;
  const performed = [];

  try {
    for (const move of moves) {
      const to = uniquePath(path.join(runDir, path.basename(move.from)));
      moveWithRetry(move.from, to);
      performed.push({ kind: move.kind, original: move.from, backup: to });
    }

    const settings = { ...(previousSettings ?? {}) };
    settings.env = { ...(previousSettings?.env ?? {}), ...buildSettingsEnv(resolved) };
    writeFileAtomic(paths.targetFile, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    fail(`Failed to apply configuration: ${err.message}`);
    for (const done of performed.reverse()) {
      try {
        moveWithRetry(done.backup, done.original);
      } catch (rollbackErr) {
        fail(`Rollback failed for ${done.original}: ${rollbackErr.message}`);
      }
    }
    log('Rolled back - your original configuration is untouched.');
    return 1;
  }

  const manifest = readManifest(paths.backupRoot);
  manifest.runs.push({
    id,
    createdAt: new Date().toISOString(),
    mode: opts.project ? 'project' : 'global',
    entries: performed,
    wrote: [paths.targetFile],
    restored: false,
  });
  writeManifest(paths.backupRoot, manifest);

  log();
  for (const done of performed) {
    ok(`Backed up ${path.basename(done.original)} -> ${done.backup}`);
  }
  ok(`Wrote ${paths.targetFile}`);
  log();
  log(paint('bold', 'Next steps'));
  log(`  1. Start the proxy:  ${paint('cyan', 'npm start')}`);
  log(`  2. Sign in:          ${paint('cyan', `${resolved.baseUrl}/auth.html`)}`);
  log(`  3. Run Claude Code:  ${paint('cyan', 'claude')}`);
  log();
  log(paint('dim', `Undo with: npm run setup:claude -- --restore ${id}`));
  return 0;
}

function commandList(opts) {
  const paths = resolvePaths(opts);
  const manifest = readManifest(paths.backupRoot);
  if (manifest.runs.length === 0) {
    log('No backup sets found.');
    return 0;
  }
  log(paint('bold', 'Backup sets'));
  for (const run of manifest.runs) {
    const state = run.restored ? paint('dim', 'restored') : paint('green', 'active');
    log(`  ${run.id}  ${String(run.mode).padEnd(7)}  ${state}`);
    for (const entry of run.entries) {
      log(`      ${paint('dim', entry.original)}`);
    }
  }
  return 0;
}

async function commandRestore(opts) {
  const paths = resolvePaths(opts);
  const manifest = readManifest(paths.backupRoot);
  const active = manifest.runs.filter((r) => !r.restored);
  const run = opts.restoreId
    ? manifest.runs.find((r) => r.id === opts.restoreId)
    : active[active.length - 1];

  if (!run) {
    fail(opts.restoreId ? `No backup set with id ${opts.restoreId}` : 'Nothing to restore.');
    return 1;
  }

  log();
  log(paint('bold', `Restoring backup set ${run.id}`));
  for (const wrote of run.wrote) {
    log(`  REMOVE ${wrote}`);
  }
  for (const entry of run.entries) {
    log(`  MOVE   ${entry.backup}`);
    log(`     ->  ${entry.original}`);
  }
  log();

  if (opts.dryRun) {
    log(paint('dim', 'Dry run - nothing was changed.'));
    return 0;
  }

  if (!opts.yes && !(await confirm('Apply this restore?'))) {
    log('Aborted.');
    return 1;
  }

  for (const wrote of run.wrote) {
    if (!fs.existsSync(wrote)) continue;
    const current = readJsonIfExists(wrote);
    const isOurs = current?.env?.ANTHROPIC_AUTH_TOKEN === DUMMY_TOKEN;
    if (!isOurs && !opts.force) {
      fail(`${wrote} was modified since it was written. Re-run with --force to overwrite.`);
      return 1;
    }
    fs.rmSync(wrote, { force: true });
  }

  for (const entry of run.entries) {
    if (!fs.existsSync(entry.backup)) {
      warn(`Backup missing, skipping: ${entry.backup}`);
      continue;
    }
    moveWithRetry(entry.backup, entry.original);
    ok(`Restored ${entry.original}`);
  }

  run.restored = true;
  run.restoredAt = new Date().toISOString();
  writeManifest(paths.backupRoot, manifest);

  log();
  ok('Claude Code is back to its previous configuration.');
  return 0;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    fail(err.message);
    log(HELP);
    return 1;
  }

  if (opts.help) {
    log(HELP);
    return 0;
  }
  if (opts.list) return commandList(opts);
  if (opts.restore) return commandRestore(opts);
  return commandConfigure(opts);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF_PATH.toLowerCase();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      fail(err.stack || err.message);
      process.exit(1);
    });
}
