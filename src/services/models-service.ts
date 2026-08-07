/**
 * Copilot model catalog discovery.
 *
 * Model IDs are inconsistent upstream — `claude-opus-4.8` uses a dot while
 * `claude-opus-5` has no minor version at all — so hardcoding them is fragile.
 * Instead we read the live catalog from `GET {base}/models` and cache it, which
 * also means newly released models appear without a code change.
 */

import fetch from 'node-fetch';
import { config, FALLBACK_CLAUDE_MODELS } from '../config/index.js';
import { getCopilotApiBase, ensureValidCopilotToken } from './auth-service.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { logger } from '../utils/logger.js';

export interface CopilotModelLimits {
  max_context_window_tokens?: number;
  max_output_tokens?: number;
  max_prompt_tokens?: number;
}

export interface CopilotModelSupports {
  tool_calls?: boolean;
  parallel_tool_calls?: boolean;
  streaming?: boolean;
  structured_outputs?: boolean;
  vision?: boolean;
}

export interface CopilotModel {
  id: string;
  name?: string;
  object?: string;
  version?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  policy?: { state?: string; terms?: string };
  capabilities?: {
    family?: string;
    type?: string;
    tokenizer?: string;
    limits?: CopilotModelLimits;
    supports?: CopilotModelSupports;
  };
}

interface ModelsResponse {
  object?: string;
  data?: CopilotModel[];
}

let cache: { models: CopilotModel[]; fetchedAt: number } | null = null;
let inFlight: Promise<CopilotModel[]> | null = null;
let catalogIsLive = false;
/** Short TTL applied after a failure so a broken catalog isn't refetched per request. */
const FAILURE_CACHE_MS = 30_000;

/**
 * Build the fallback catalog used when the live endpoint is unreachable.
 */
function fallbackModels(): CopilotModel[] {
  return FALLBACK_CLAUDE_MODELS.map((m) => ({
    id: m.id,
    name: m.display_name,
    object: 'model',
    vendor: 'Anthropic',
    model_picker_enabled: true,
    preview: false,
    capabilities: {
      family: m.id,
      type: 'chat',
      supports: { tool_calls: true, streaming: true, parallel_tool_calls: true },
    },
  }));
}

/**
 * Fetch the model catalog, using a cached copy when still fresh.
 *
 * @param force - Bypass the cache
 */
export async function getCopilotModels(force = false): Promise<CopilotModel[]> {
  const ttl = config.models.cacheTtlMs;

  if (!force && cache && Date.now() - cache.fetchedAt < ttl) {
    return cache.models;
  }

  // Collapse concurrent refreshes into a single upstream call.
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    /** Cache a fallback briefly so a failing catalog isn't refetched per request. */
    const useFallback = (): CopilotModel[] => {
      const models = cache?.models ?? fallbackModels();
      cache = { models, fetchedAt: Date.now() - ttl + FAILURE_CACHE_MS };
      catalogIsLive = false;
      return models;
    };

    try {
      const token = await ensureValidCopilotToken();
      if (!token) {
        logger.warn('No Copilot token available; using fallback model catalog');
        return useFallback();
      }

      const url = `${getCopilotApiBase()}/models`;
      const response = await fetch(url, {
        method: 'GET',
        headers: buildCopilotHeaders({ token: token.token }),
      });

      if (!response.ok) {
        logger.warn('Model catalog request failed; using fallback', {
          status: response.status,
          statusText: response.statusText,
        });
        return useFallback();
      }

      const body = (await response.json()) as ModelsResponse;
      const models = Array.isArray(body.data) ? body.data.filter((m) => m && m.id) : [];

      if (models.length === 0) {
        logger.warn('Model catalog was empty; using fallback');
        return useFallback();
      }

      cache = { models, fetchedAt: Date.now() };
      catalogIsLive = true;
      logger.info(`Discovered ${models.length} Copilot models`, {
        anthropic: models.filter(isAnthropicChatModel).map((m) => m.id),
      });
      return models;
    } catch (error) {
      logger.error('Error fetching Copilot model catalog:', error);
      return useFallback();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * True when the cached catalog came from a successful upstream fetch rather
 * than the static fallback.
 */
export function isLiveCatalog(): boolean {
  return catalogIsLive;
}

/**
 * True when a model is an Anthropic chat model that the account may actually use.
 */
export function isAnthropicChatModel(model: CopilotModel): boolean {
  const isChat = !model.capabilities?.type || model.capabilities.type === 'chat';
  const vendorMatch =
    model.vendor?.toLowerCase() === 'anthropic' ||
    model.id.toLowerCase().startsWith('claude');
  const policyOk = !model.policy?.state || model.policy.state === 'enabled';

  return isChat && vendorMatch && policyOk;
}

/**
 * Models to advertise on /v1/models.
 */
export async function getExposedModels(): Promise<CopilotModel[]> {
  const models = await getCopilotModels();
  const chatModels = models.filter(
    (m) => !m.capabilities?.type || m.capabilities.type === 'chat'
  );

  return config.models.exposeAll ? chatModels : chatModels.filter(isAnthropicChatModel);
}

/**
 * Look up a model's declared limits, if known.
 */
export async function getModelLimits(id: string): Promise<CopilotModelLimits | undefined> {
  const models = await getCopilotModels();
  return models.find((m) => m.id === id)?.capabilities?.limits;
}

/** Reset cached state (used by tests). */
export function clearModelCache(): void {
  cache = null;
  inFlight = null;
}
