#!/usr/bin/env node

/**
 * CLI entry point for copilot-claude-proxy
 * Usage: copilot-claude-proxy [start|--help|--version]
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const command = args[0] || 'start';

// Read package.json for version
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

if (command === '--version' || command === '-v') {
  console.log(`copilot-claude-proxy v${packageJson.version}`);
  process.exit(0);
}

if (command === '--help' || command === '-h') {
  console.log(`
copilot-claude-proxy v${packageJson.version}

Run Claude Code's agentic harness on your GitHub Copilot subscription.

Usage:
  copilot-claude-proxy [command]

Commands:
  start       Start the proxy server (default)
  configure   Point Claude Code at this proxy (backs up any existing config)
  --version   Show version number
  --help      Show this help message

Configure options:
  configure --help          Show all configuration options
  configure --dry-run       Preview changes without applying them
  configure --restore       Undo a previous configure run

Configuration:
  PORT                Server port (default: 3000)
  DEFAULT_MODEL       Model used when none is specified (default: claude-opus-5)
  COPILOT_API_BASE    Override the discovered Copilot API host
  EXPOSE_ALL_MODELS   Set to 1 to also list non-Anthropic models
  DISABLE_RATE_LIMIT  Set to 1 to disable rate limiting

Example:
  copilot-claude-proxy start
  copilot-claude-proxy configure
  PORT=8080 copilot-claude-proxy

After starting, visit http://localhost:3000/auth.html to authenticate with GitHub.

Documentation: ${packageJson.homepage}
`);
  process.exit(0);
}

if (command === 'configure') {
  const scriptPath = join(__dirname, '..', 'scripts', 'configure-claude-code.mjs');
  const { main } = await import(pathToFileURL(scriptPath).href);
  process.exit(await main(args.slice(1)));
}

if (command === 'start' || !command.startsWith('-')) {
  // Import and start the server
  const serverPath = join(__dirname, '..', 'dist', 'index.js');
  await import(pathToFileURL(serverPath).href);
}
