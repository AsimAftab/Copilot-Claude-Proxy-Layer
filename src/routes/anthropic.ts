/**
 * Anthropic API routes — the endpoints Claude Code talks to.
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getCopilotToken,
  ensureValidCopilotToken,
} from '../services/auth-service.js';
import {
  makeAnthropicCompletionRequest,
  createAnthropicError,
  callCopilot,
  CopilotApiError,
  statusToAnthropicErrorType,
} from '../services/anthropic-service.js';
import {
  StreamTranslator,
  generateMessageId,
} from '../services/translation/response.js';
import { flattenSystemPrompt } from '../services/translation/request.js';
import { getAvailableModels } from '../utils/model-mapper.js';
import { AnthropicMessageRequest, ContentBlock } from '../types/anthropic.js';
import { OpenAIStreamChunk } from '../types/copilot-chat.js';
import { logger } from '../utils/logger.js';
import { trackRequest } from '../services/usage-service.js';

export const anthropicRoutes = express.Router();

/** Keep-alive ping interval for long agentic turns. */
const PING_INTERVAL_MS = 15_000;

/**
 * Ensure a usable Copilot token, refreshing before giving up.
 */
const requireAuth = async (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const token = await ensureValidCopilotToken();

    if (!token) {
      return res
        .status(401)
        .json(
          createAnthropicError(
            'authentication_error',
            'GitHub Copilot authentication required. Please authenticate at /auth.html'
          )
        );
    }

    next();
  } catch (error) {
    logger.error('Token refresh failed in Anthropic middleware:', error);
    return res
      .status(401)
      .json(
        createAnthropicError(
          'authentication_error',
          'GitHub Copilot authentication failed. Please re-authenticate.'
        )
      );
  }
};

// GET /v1/models - List models discovered from Copilot
anthropicRoutes.get('/models', requireAuth, async (_req, res) => {
  try {
    res.json(await getAvailableModels());
  } catch (error) {
    logger.error('Error listing models:', error);
    res
      .status(500)
      .json(createAnthropicError('api_error', 'Failed to list models'));
  }
});

// POST /v1/messages/count_tokens
anthropicRoutes.post('/messages/count_tokens', requireAuth, async (req, res) => {
  try {
    const { messages, system, tools } = req.body ?? {};
    let totalChars = 0;

    totalChars += flattenSystemPrompt(system).length;

    // Tool schemas are part of the prompt and can be substantial.
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        totalChars += JSON.stringify(tool ?? {}).length;
      }
    }

    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg?.content === 'string') {
          totalChars += msg.content.length;
        } else if (Array.isArray(msg?.content)) {
          for (const block of msg.content as ContentBlock[]) {
            if (!block || typeof block !== 'object') continue;

            if (block.type === 'text') {
              totalChars += block.text?.length ?? 0;
            } else if (block.type === 'tool_use') {
              totalChars +=
                JSON.stringify(block.input ?? {}).length + (block.name?.length ?? 0);
            } else if (block.type === 'tool_result') {
              totalChars +=
                typeof block.content === 'string'
                  ? block.content.length
                  : JSON.stringify(block.content ?? '').length;
            } else if (block.type === 'image') {
              // Images are billed by tile; approximate a mid-size image.
              totalChars += 4000;
            }
          }
        }
      }
    }

    res.json({ input_tokens: Math.ceil(totalChars / 4) });
  } catch (error) {
    logger.error('Error counting tokens:', error);
    res.status(500).json(createAnthropicError('api_error', 'Failed to count tokens'));
  }
});

// POST /v1/messages - main chat endpoint
anthropicRoutes.post('/messages', requireAuth, async (req, res) => {
  const sessionId = res.locals.sessionId || uuidv4();

  try {
    const request = req.body as AnthropicMessageRequest;
    const validationError = validateRequest(request);
    if (validationError) {
      return res
        .status(400)
        .json(createAnthropicError('invalid_request_error', validationError));
    }

    const copilotToken = getCopilotToken();
    if (!copilotToken) {
      return res
        .status(401)
        .json(
          createAnthropicError('authentication_error', 'GitHub Copilot token not available')
        );
    }

    // Stop billing upstream work when Claude Code cancels a turn.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    if (request.stream) {
      await handleStreaming(res, request, copilotToken.token, sessionId, abortController.signal);
    } else {
      const response = await makeAnthropicCompletionRequest(
        request,
        copilotToken.token,
        abortController.signal
      );

      trackRequest(
        sessionId,
        response.usage.input_tokens + response.usage.output_tokens
      );
      res.json(response);
    }
  } catch (error) {
    handleRouteError(error, res);
  }
});

/**
 * Validate the incoming Anthropic request. Returns an error message or null.
 */
function validateRequest(request: AnthropicMessageRequest): string | null {
  if (!request || typeof request !== 'object') {
    return 'invalid request body';
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return 'messages: field required';
  }
  if (!request.model) {
    return 'model: field required';
  }
  if (!request.max_tokens || typeof request.max_tokens !== 'number') {
    return 'max_tokens: field required and must be a number';
  }

  for (const msg of request.messages) {
    if (!msg.role || !['user', 'assistant'].includes(msg.role)) {
      return 'messages: each message must have a valid role (user or assistant)';
    }
    if (msg.content === undefined || msg.content === null) {
      return 'messages: each message must have content';
    }
  }

  return null;
}

/**
 * Translate an upstream/internal error into an Anthropic error response.
 */
function handleRouteError(error: unknown, res: express.Response): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  if (error instanceof CopilotApiError) {
    // 499 is our sentinel for a client-cancelled request; nothing to report.
    if (error.status === 499) {
      res.end();
      return;
    }

    if (error.retryAfter) {
      res.setHeader('Retry-After', error.retryAfter);
    }

    logger.error('Copilot API error:', { status: error.status, message: error.message });
    res
      .status(error.status)
      .json(createAnthropicError(statusToAnthropicErrorType(error.status), error.message));
    return;
  }

  logger.error('Error processing Anthropic request:', error);
  res
    .status(500)
    .json(
      createAnthropicError(
        'api_error',
        error instanceof Error ? error.message : 'Internal server error'
      )
    );
}

/**
 * Stream a Copilot response back to Claude Code as Anthropic SSE events.
 *
 * The upstream request is issued before any headers are written, so a failure
 * during connection setup still yields a proper JSON error with a real status.
 */
async function handleStreaming(
  res: express.Response,
  request: AnthropicMessageRequest,
  copilotToken: string,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  const upstream = await callCopilot(request, copilotToken, true, signal);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const messageId = generateMessageId();
  const translator = new StreamTranslator();
  let outputChars = 0;

  const pingTimer = setInterval(() => {
    if (!res.writableEnded) send('ping', { type: 'ping' });
  }, PING_INTERVAL_MS);

  try {
    send('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: request.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    let buffer = '';

    const processFrame = (frame: string) => {
      for (const line of frame.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '') continue;
        if (payload === '[DONE]') continue;

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          logger.debug('Skipping unparsable SSE payload', { payload: payload.slice(0, 200) });
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        outputChars += delta?.content?.length ?? 0;
        for (const tc of delta?.tool_calls ?? []) {
          outputChars += tc.function?.arguments?.length ?? 0;
        }

        for (const { event, data } of translator.translate(chunk)) {
          send(event, data);
        }
      }
    };

    for await (const rawChunk of upstream.body as unknown as AsyncIterable<Buffer>) {
      buffer += rawChunk.toString('utf-8');
      buffer = buffer.replace(/\r\n/g, '\n');

      // SSE frames are separated by a blank line; keep any partial tail.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        processFrame(frame);
      }
    }

    if (buffer.trim() !== '') {
      processFrame(buffer);
    }

    for (const { event, data } of translator.finish(Math.ceil(outputChars / 4))) {
      send(event, data);
    }

    const usage = translator.getUsage();
    trackRequest(sessionId, usage.input_tokens + usage.output_tokens);

    res.end();
  } catch (error) {
    logger.error('Error in Anthropic streaming:', error);

    if (!res.writableEnded) {
      send('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : 'Streaming error',
        },
      });
      res.end();
    }
  } finally {
    clearInterval(pingTimer);
  }
}
