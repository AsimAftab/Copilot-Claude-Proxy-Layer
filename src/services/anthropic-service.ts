/**
 * Anthropic Service — translation layer between Claude Code and GitHub Copilot.
 *
 * Claude Code speaks the Anthropic Messages API; Copilot exposes an
 * OpenAI-compatible chat-completions endpoint. This module owns the upstream
 * call, including tool calling, real SSE streaming, retries and error mapping.
 */

import fetch, { Response as FetchResponse } from 'node-fetch';
import { config } from '../config/index.js';
import {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicError,
} from '../types/anthropic.js';
import { OpenAIChatRequest, OpenAIChatResponse } from '../types/copilot-chat.js';
import { resolveModel } from '../utils/model-mapper.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { getCopilotApiBase } from './auth-service.js';
import { getModelLimits } from './models-service.js';
import {
  convertMessages,
  convertTools,
  convertToolChoice,
  requestHasImages,
  isAgentConversation,
} from './translation/request.js';
import { convertToAnthropicResponse } from './translation/response.js';
import { logger } from '../utils/logger.js';
import { trace } from '../utils/trace.js';

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Error carrying an upstream HTTP status so routes can mirror it.
 */
export class CopilotApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = 'CopilotApiError';
  }
}

/**
 * Map an upstream HTTP status onto an Anthropic error type.
 */
export function statusToAnthropicErrorType(status: number): AnthropicError['error']['type'] {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

/**
 * Build the Copilot chat-completions payload for an Anthropic request.
 */
export async function buildCopilotRequest(
  request: AnthropicMessageRequest,
  stream: boolean
): Promise<OpenAIChatRequest> {
  const model = await resolveModel(request.model);
  const limits = await getModelLimits(model);

  // Respect the model's real output ceiling rather than a hardcoded default.
  let maxTokens = request.max_tokens;
  if (limits?.max_output_tokens && maxTokens > limits.max_output_tokens) {
    logger.debug(
      `Clamping max_tokens ${maxTokens} -> ${limits.max_output_tokens} for ${model}`
    );
    maxTokens = limits.max_output_tokens;
  }

  const body: OpenAIChatRequest = {
    model,
    messages: convertMessages(request.messages, request.system),
    max_tokens: maxTokens,
    stream,
  };

  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.top_p === 'number') body.top_p = request.top_p;
  if (request.stop_sequences?.length) body.stop = request.stop_sequences;
  // top_k has no OpenAI equivalent and is intentionally dropped.

  const tools = convertTools(request.tools);
  if (tools) {
    body.tools = tools;
    const toolChoice = convertToolChoice(request.tool_choice);
    if (toolChoice) body.tool_choice = toolChoice;
  }

  return body;
}

/**
 * POST to Copilot's chat-completions endpoint with bounded retry.
 */
export async function callCopilot(
  request: AnthropicMessageRequest,
  copilotToken: string,
  stream: boolean,
  signal?: AbortSignal
): Promise<FetchResponse> {
  const body = await buildCopilotRequest(request, stream);
  const endpoint = `${getCopilotApiBase()}/chat/completions`;

  trace('request', { stream, anthropic: request, copilot: body });

  const headers = buildCopilotHeaders({
    token: copilotToken,
    isAgent: isAgentConversation(request),
    hasImages: requestHasImages(request),
  });

  let lastError: CopilotApiError | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new CopilotApiError('Request aborted by client', 499);
    }

    logger.debug('Calling Copilot chat completions', {
      endpoint,
      model: body.model,
      stream,
      tools: body.tools?.length ?? 0,
      attempt: attempt + 1,
    });

    let response: FetchResponse;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal as never,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CopilotApiError('Request aborted by client', 499);
      }
      lastError = new CopilotApiError(
        error instanceof Error ? error.message : 'Network error calling Copilot',
        503
      );
      await backoff(attempt);
      continue;
    }

    if (response.ok) {
      return response;
    }

    const errorText = await response.text().catch(() => '');
    logger.error('Copilot chat API error', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.slice(0, 500),
    });

    lastError = new CopilotApiError(
      errorText || `Copilot API error: ${response.status} ${response.statusText}`,
      response.status,
      response.headers.get('retry-after') ?? undefined
    );

    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRIES - 1) {
      throw lastError;
    }

    await backoff(attempt, lastError.retryAfter);
  }

  throw lastError ?? new CopilotApiError('Copilot request failed', 500);
}

/**
 * Exponential backoff, honouring Retry-After when present.
 */
async function backoff(attempt: number, retryAfter?: string): Promise<void> {
  const headerDelay = retryAfter ? parseInt(retryAfter, 10) * 1000 : NaN;
  const delay = Number.isFinite(headerDelay)
    ? Math.min(headerDelay, 10_000)
    : Math.min(500 * 2 ** attempt, 8_000);

  logger.debug(`Retrying Copilot request in ${delay}ms`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Perform a non-streaming completion and return an Anthropic response.
 */
export async function makeAnthropicCompletionRequest(
  request: AnthropicMessageRequest,
  copilotToken: string,
  signal?: AbortSignal
): Promise<AnthropicMessageResponse> {
  const response = await callCopilot(request, copilotToken, false, signal);
  const data = (await response.json()) as OpenAIChatResponse;

  const translated = convertToAnthropicResponse(data, request.model);
  trace('response', { stream: false, copilot: data, anthropic: translated });

  return translated;
}

/**
 * Create an Anthropic error response object.
 */
export function createAnthropicError(
  type: AnthropicError['error']['type'],
  message: string
): AnthropicError {
  return { type: 'error', error: { type, message } };
}

export { generateMessageId } from './translation/response.js';
export { extractTextContent, flattenSystemPrompt } from './translation/request.js';

/** Re-exported so routes can reference the configured default model. */
export const defaultModel = config.models.default;
