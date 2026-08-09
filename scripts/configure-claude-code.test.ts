import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'configure-claude-code.mjs'
);

interface RunResult {
  status: number;
  stdout: string;
}

let home: string;

function run(args: string[], cwd: string = home): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        PORT: '3000',
        HOST: 'localhost',
      },
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const settingsPath = () => path.join(home, '.claude', 'settings.json');
const credentialsPath = () => path.join(home, '.claude', '.credentials.json');
const backupRoot = () => path.join(home, '.claude', '.copilot-proxy-backups');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function seedExistingConfig(): void {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: 'real-key' }, permissions: { allow: ['Bash(ls:*)'] } })
  );
  fs.writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: 'secret' } }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-home-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('configure-claude-code', () => {
  it('writes gateway settings when nothing exists yet', () => {
    const result = run(['--yes']);
    expect(result.status).toBe(0);

    const settings = readJson(settingsPath()) as { env: Record<string, string> };
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://localhost:3000');
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-dummy');
    expect(settings.env.ANTHROPIC_MODEL).toBe('claude-opus-5');
    expect(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('renames existing settings and credentials instead of deleting them', () => {
    seedExistingConfig();
    expect(run(['--yes']).status).toBe(0);

    expect(fs.existsSync(credentialsPath())).toBe(false);

    const runs = fs.readdirSync(backupRoot()).filter((e) => e !== 'manifest.json');
    expect(runs).toHaveLength(1);
    const backupDir = path.join(backupRoot(), runs[0]);
    const backedUp = fs.readdirSync(backupDir).sort();
    expect(backedUp).toEqual(['.credentials.json', 'settings.json']);

    const oldSettings = readJson(path.join(backupDir, 'settings.json')) as {
      env: Record<string, string>;
    };
    expect(oldSettings.env.ANTHROPIC_API_KEY).toBe('real-key');
  });

  it('drops old env keys by default and keeps them with --merge', () => {
    seedExistingConfig();
    run(['--yes']);
    let settings = readJson(settingsPath()) as { env: Record<string, string>; permissions?: unknown };
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(settings.permissions).toBeUndefined();

    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    seedExistingConfig();
    run(['--yes', '--merge']);
    settings = readJson(settingsPath()) as { env: Record<string, string>; permissions?: unknown };
    expect(settings.env.ANTHROPIC_API_KEY).toBe('real-key');
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://localhost:3000');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
  });

  it('honours --keep-credentials', () => {
    seedExistingConfig();
    run(['--yes', '--keep-credentials']);
    expect(fs.existsSync(credentialsPath())).toBe(true);
  });

  it('changes nothing with --dry-run', () => {
    seedExistingConfig();
    const before = fs.readFileSync(settingsPath(), 'utf-8');
    expect(run(['--dry-run']).status).toBe(0);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
    expect(fs.existsSync(credentialsPath())).toBe(true);
    expect(fs.existsSync(backupRoot())).toBe(false);
  });

  it('restores the previous configuration exactly', () => {
    seedExistingConfig();
    const originalSettings = fs.readFileSync(settingsPath(), 'utf-8');
    const originalCredentials = fs.readFileSync(credentialsPath(), 'utf-8');

    run(['--yes']);
    expect(run(['--restore', '--yes']).status).toBe(0);

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(originalSettings);
    expect(fs.readFileSync(credentialsPath(), 'utf-8')).toBe(originalCredentials);
  });

  it('removes the written file on restore when there was no prior config', () => {
    run(['--yes']);
    expect(fs.existsSync(settingsPath())).toBe(true);
    expect(run(['--restore', '--yes']).status).toBe(0);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('refuses to restore over a hand-edited file without --force', () => {
    seedExistingConfig();
    run(['--yes']);
    fs.writeFileSync(settingsPath(), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'mine' } }));

    const blocked = run(['--restore', '--yes']);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('--force');

    expect(run(['--restore', '--yes', '--force']).status).toBe(0);
  });

  it('supports repeated runs without clobbering earlier backups', () => {
    seedExistingConfig();
    run(['--yes']);
    run(['--yes']);

    const runs = fs.readdirSync(backupRoot()).filter((e) => e !== 'manifest.json');
    expect(runs.length).toBe(2);

    const manifest = readJson(path.join(backupRoot(), 'manifest.json')) as { runs: unknown[] };
    expect(manifest.runs).toHaveLength(2);
  });

  it('configures a project-local settings file with --project', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-proj-'));
    try {
      expect(run(['--yes', '--project', '--port', '8080'], projectDir).status).toBe(0);
      const settings = readJson(path.join(projectDir, '.claude', 'settings.local.json')) as {
        env: Record<string, string>;
      };
      expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://localhost:8080');
      expect(fs.existsSync(settingsPath())).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('lists backup sets', () => {
    seedExistingConfig();
    run(['--yes']);
    const listed = run(['--list']);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('active');
  });

  it('fails on unknown options', () => {
    const result = run(['--nope']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Unknown option');
  });
});
