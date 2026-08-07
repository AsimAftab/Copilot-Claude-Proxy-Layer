/**
 * Model name resolution: Claude Code model names -> Copilot model IDs.
 *
 * Claude Code sends canonical Anthropic names (`claude-opus-4-5-20250514`) while
 * Copilot's catalog uses its own inconsistent forms (`claude-opus-4.5`,
 * `claude-opus-5`). Rather than maintain a hand-written map that rots with every
 * release, resolve against the live catalog using progressively looser matching.
 */

import { config, FAMILY_ALIAS_PREFERENCE, FALLBACK_CLAUDE_MODELS } from '../config/index.js';
import {
  getCopilotModels,
  getExposedModels,
  isAnthropicChatModel,
  isLiveCatalog,
  CopilotModel,
} from '../services/models-service.js';
import { AnthropicModel, AnthropicModelList } from '../types/anthropic.js';
import { logger } from './logger.js';

// Avoid logging the same resolution on every request in an agentic loop.
const loggedResolutions = new Set<string>();

/**
 * Normalise a model name for comparison: lowercase, drop a trailing Anthropic
 * date stamp, and fold `.` and `-` separators together so `claude-opus-4.5`,
 * `claude-opus-4-5` and `claude-opus-4-5-20250514` all collapse to one key.
 */
function normalize(model: string): string {
  return model
    .toLowerCase()
    .replace(/-\d{8}$/, '')
    .replace(/[.]/g, '-')
    .replace(/-latest$/, '');
}

/**
 * Extract the Claude family (`opus`/`sonnet`/`haiku`) from a model name.
 */
function familyOf(model: string): string | null {
  const match = /(opus|sonnet|haiku)/.exec(model.toLowerCase());
  return match ? match[1] : null;
}

/**
 * Rank models within a family so the newest wins a bare alias like `opus`.
 * Version numbers sort numerically (5 beats 4.8).
 */
function versionScore(id: string): number {
  const match = /(\d+)(?:[.-](\d+))?/.exec(id.replace(/-\d{8}$/, ''));
  if (!match) return 0;

  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  return major * 1000 + minor;
}

/**
 * Pick the newest available model in a family.
 *
 * `catalogAvailable` distinguishes "the live catalog has no member of this
 * family" (in which case guessing a hardcoded ID would send the user upstream
 * to a model their plan cannot reach) from "we never got a catalog at all".
 */
function newestInFamily(
  models: CopilotModel[],
  family: string,
  catalogAvailable: boolean
): string | null {
  const candidates = models
    .filter(isAnthropicChatModel)
    .filter((m) => m.id.toLowerCase().includes(family))
    .sort((a, b) => versionScore(b.id) - versionScore(a.id));

  if (candidates.length > 0) {
    return candidates[0].id;
  }

  if (catalogAvailable) {
    return null;
  }

  // Catalog unavailable — fall back to the static preference order.
  const preferred = FAMILY_ALIAS_PREFERENCE[family];
  return preferred ? preferred[0] : null;
}

function fallbackCatalog(): CopilotModel[] {
  return FALLBACK_CLAUDE_MODELS.map((m) => ({
    id: m.id,
    name: m.display_name,
    vendor: 'Anthropic',
    capabilities: { type: 'chat' },
  }));
}

async function loadModels(): Promise<CopilotModel[]> {
  try {
    return await getCopilotModels();
  } catch (error) {
    logger.warn('Model catalog lookup failed during resolution; using fallback', { error });
    return fallbackCatalog();
  }
}

/**
 * Resolve a requested model name to a Copilot model ID.
 *
 * Resolution order: exact ID -> normalised ID -> family alias -> pass-through
 * (Copilot also serves GPT/Gemini models, which need no translation).
 */
export async function resolveModel(model: string): Promise<string> {
  if (!model) {
    return config.models.default;
  }

  const models = await loadModels();
  const requested = normalize(model);

  // 1. Exact match against the live catalog.
  const exact = models.find((m) => m.id === model);
  if (exact) {
    return exact.id;
  }

  // 2. Normalised match — handles dot/hyphen and date-suffix differences.
  const normalized = models.find((m) => normalize(m.id) === requested);
  if (normalized) {
    logResolution(model, normalized.id);
    return normalized.id;
  }

  // 3. Bare family alias, e.g. "opus" or an unknown Claude version.
  const family = familyOf(model);
  if (family && (model.toLowerCase() === family || model.toLowerCase().startsWith('claude'))) {
    const newest = newestInFamily(models, family, isLiveCatalog());
    if (newest) {
      logResolution(model, newest);
      return newest;
    }

    // The catalog is real but has nothing in this family (e.g. no Haiku on this
    // plan). Sending a guessed ID upstream would 404, so use the default model.
    if (model.toLowerCase().startsWith('claude')) {
      logResolution(model, config.models.default);
      return config.models.default;
    }
  }

  // 4. Non-Claude models (GPT, Gemini, ...) pass through untouched.
  logResolution(model, model);
  return model;
}

function logResolution(from: string, to: string): void {
  const key = `${from}=>${to}`;
  if (loggedResolutions.has(key)) return;

  loggedResolutions.add(key);
  logger.info(`Model resolution: "${from}" -> "${to}"`);
}

/**
 * Build the /v1/models response from the discovered catalog.
 */
export async function getAvailableModels(): Promise<AnthropicModelList> {
  const discovered = await getExposedModels();
  const created = Math.floor(Date.now() / 1000);

  const data: AnthropicModel[] = discovered.map((m) => ({
    id: m.id,
    object: 'model' as const,
    created,
    owned_by: m.vendor?.toLowerCase() ?? 'anthropic',
    display_name: m.name ?? getModelDisplayName(m.id),
  }));

  return { object: 'list', data };
}

/**
 * Human-readable name for a model ID.
 */
export function getModelDisplayName(model: string): string {
  const known = FALLBACK_CLAUDE_MODELS.find((m) => normalize(m.id) === normalize(model));
  if (known) {
    return known.display_name;
  }

  return model
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Exposed for tests. */
export const __testing = { normalize, familyOf, versionScore };
