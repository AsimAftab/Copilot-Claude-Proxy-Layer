/**
 * Opt-in request/response tracing for diagnosing translation bugs.
 *
 * Mocks encode our assumptions about the upstream API, so when Claude Code
 * misbehaves the only reliable evidence is the real traffic. Enabling
 * `COPILOT_PROXY_TRACE=1` appends one JSON line per turn to
 * `$COPILOT_PROXY_DATA_DIR/trace.jsonl`, capturing the Anthropic request, the
 * translated Copilot payload and what we sent back.
 *
 * Disabled by default: traces contain full prompt text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

const DATA_DIR =
  process.env.COPILOT_PROXY_DATA_DIR || path.join(os.homedir(), '.github-copilot-proxy');

const TRACE_PATH = path.join(DATA_DIR, 'trace.jsonl');

/** Cap each record so a huge context doesn't produce an unusable file. */
const MAX_FIELD_CHARS = 200_000;

export function isTraceEnabled(): boolean {
  const flag = process.env.COPILOT_PROXY_TRACE;
  return flag === '1' || flag === 'true';
}

function truncate(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  if (json.length <= MAX_FIELD_CHARS) return value;
  return { truncated: true, chars: json.length, head: json.slice(0, MAX_FIELD_CHARS) };
}

/**
 * Append one trace record. Never throws: tracing must not break a live turn.
 */
export function trace(kind: string, record: Record<string, unknown>): void {
  if (!isTraceEnabled()) return;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const entry: Record<string, unknown> = { ts: new Date().toISOString(), kind };
    for (const [key, value] of Object.entries(record)) {
      entry[key] = truncate(value);
    }

    fs.appendFileSync(TRACE_PATH, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    logger.debug('Trace write failed', { error });
  }
}

export const tracePath = TRACE_PATH;
