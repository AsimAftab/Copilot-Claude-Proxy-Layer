import dotenv from 'dotenv';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };

// Load environment variables
dotenv.config();

// Schema for env validation
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('localhost'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  GITHUB_COPILOT_CLIENT_ID: z.string().default('Iv1.b507a08c87ecfe98'),
  // Override the Copilot API base URL. Normally discovered from the token's
  // `endpoints.api` field (e.g. https://api.individual.githubcopilot.com).
  COPILOT_API_BASE: z.string().optional(),
  // Editor identity headers sent upstream. Copilot rejects requests from
  // unrecognised/old editor versions, so these are overridable without a release.
  COPILOT_INTEGRATION_ID: z.string().default('vscode-chat'),
  COPILOT_EDITOR_VERSION: z.string().default('vscode/1.102.0'),
  COPILOT_PLUGIN_VERSION: z.string().default('copilot-chat/0.26.7'),
  COPILOT_USER_AGENT: z.string().default('GitHubCopilotChat/0.26.7'),
  COPILOT_API_VERSION: z.string().default('2025-04-01'),
  // Model catalog behaviour
  DEFAULT_MODEL: z.string().default('claude-opus-5'),
  EXPOSE_ALL_MODELS: z.string().optional(),
  MODEL_CACHE_TTL_MS: z.string().default('3600000'),
  // Rate limiting settings (requests per minute)
  RATE_LIMIT_DEFAULT: z.string().default('600'),
  RATE_LIMIT_CHAT_COMPLETIONS: z.string().default('600'),
  DISABLE_RATE_LIMIT: z.string().optional(),
});

// Parse and validate environment variables
const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  LOG_LEVEL: process.env.LOG_LEVEL,
  GITHUB_COPILOT_CLIENT_ID: process.env.GITHUB_COPILOT_CLIENT_ID,
  COPILOT_API_BASE: process.env.COPILOT_API_BASE,
  COPILOT_INTEGRATION_ID: process.env.COPILOT_INTEGRATION_ID,
  COPILOT_EDITOR_VERSION: process.env.COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION: process.env.COPILOT_PLUGIN_VERSION,
  COPILOT_USER_AGENT: process.env.COPILOT_USER_AGENT,
  COPILOT_API_VERSION: process.env.COPILOT_API_VERSION,
  DEFAULT_MODEL: process.env.DEFAULT_MODEL,
  EXPOSE_ALL_MODELS: process.env.EXPOSE_ALL_MODELS,
  MODEL_CACHE_TTL_MS: process.env.MODEL_CACHE_TTL_MS,
  RATE_LIMIT_DEFAULT: process.env.RATE_LIMIT_DEFAULT,
  RATE_LIMIT_CHAT_COMPLETIONS: process.env.RATE_LIMIT_CHAT_COMPLETIONS,
  DISABLE_RATE_LIMIT: process.env.DISABLE_RATE_LIMIT,
});

// API endpoints for OpenAI-compatible Copilot API
const API_ENDPOINTS = {
  GITHUB_COPILOT_TOKEN: 'https://api.github.com/copilot_internal/v2/token',
  GITHUB_COPILOT_COMPLETIONS: 'https://copilot-proxy.githubusercontent.com/v1/engines/copilot-codex/completions',
};

// API endpoints for Anthropic-compatible Copilot API (Claude models)
const ANTHROPIC_API_ENDPOINTS = {
  // Fallback base URL. The real host is discovered per-plan from the Copilot
  // token's `endpoints.api` field (see auth-service.getCopilotApiBase).
  COPILOT_API_BASE: 'https://api.githubcopilot.com',
};

/**
 * Fallback Claude model catalog.
 *
 * This is ONLY used when `GET {base}/models` is unreachable. The live catalog is
 * authoritative — see services/models-service.ts. Model IDs are inconsistent
 * upstream (`claude-opus-4.8` uses a dot, `claude-opus-5` has no minor version),
 * which is precisely why discovery is preferred over hardcoding.
 */
export const FALLBACK_CLAUDE_MODELS = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', family: 'opus' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', family: 'sonnet' },
  { id: 'claude-opus-4.8', display_name: 'Claude Opus 4.8', family: 'opus' },
  { id: 'claude-opus-4.7', display_name: 'Claude Opus 4.7', family: 'opus' },
  { id: 'claude-opus-4.6', display_name: 'Claude Opus 4.6', family: 'opus' },
  { id: 'claude-opus-4.5', display_name: 'Claude Opus 4.5', family: 'opus' },
  { id: 'claude-sonnet-4.6', display_name: 'Claude Sonnet 4.6', family: 'sonnet' },
  { id: 'claude-sonnet-4.5', display_name: 'Claude Sonnet 4.5', family: 'sonnet' },
  { id: 'claude-haiku-4.5', display_name: 'Claude Haiku 4.5', family: 'haiku' },
];

/**
 * Preference order used to resolve bare family aliases (`opus`, `sonnet`, `haiku`)
 * when the live catalog is unavailable. Newest first.
 */
export const FAMILY_ALIAS_PREFERENCE: Record<string, string[]> = {
  opus: ['claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5'],
  sonnet: ['claude-sonnet-5', 'claude-sonnet-4.6', 'claude-sonnet-4.5'],
  haiku: ['claude-haiku-4.5'],
};

// Configuration object
export const config = {
  version: pkg.version,
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  server: {
    port: parseInt(env.PORT, 10),
    host: env.HOST,
  },
  logging: {
    level: env.LOG_LEVEL,
  },
  github: {
    copilot: {
      clientId: env.GITHUB_COPILOT_CLIENT_ID,
      apiEndpoints: API_ENDPOINTS,
      anthropicEndpoints: ANTHROPIC_API_ENDPOINTS,
      apiBaseOverride: env.COPILOT_API_BASE,
      headers: {
        integrationId: env.COPILOT_INTEGRATION_ID,
        editorVersion: env.COPILOT_EDITOR_VERSION,
        pluginVersion: env.COPILOT_PLUGIN_VERSION,
        userAgent: env.COPILOT_USER_AGENT,
        apiVersion: env.COPILOT_API_VERSION,
      },
    }
  },
  models: {
    default: env.DEFAULT_MODEL,
    exposeAll: env.EXPOSE_ALL_MODELS === '1' || env.EXPOSE_ALL_MODELS === 'true',
    cacheTtlMs: parseInt(env.MODEL_CACHE_TTL_MS, 10),
  },
  rateLimits: {
    disabled: env.DISABLE_RATE_LIMIT === '1' || env.DISABLE_RATE_LIMIT === 'true',
    default: parseInt(env.RATE_LIMIT_DEFAULT, 10),
    chatCompletions: parseInt(env.RATE_LIMIT_CHAT_COMPLETIONS, 10),
  }
};
