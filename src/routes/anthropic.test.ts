import { jest } from '@jest/globals';
import { Readable } from 'stream';

/**
 * Route-level integration tests: real Express router, real translation layer,
 * stubbed auth and stubbed Copilot upstream. This exercises the agentic path
 * (tools out, tool_use back) and the real SSE streaming loop.
 */

const TOKEN = { token: 'test-token', expires_at: Date.now() / 1000 + 3600 };

jest.unstable_mockModule('../services/auth-service.js', () => ({
  getCopilotToken: () => TOKEN,
  ensureValidCopilotToken: async () => TOKEN,
  getCopilotApiBase: () => 'https://api.test.githubcopilot.com',
  isTokenValid: () => true,
  refreshCopilotToken: async () => TOKEN,
}));

jest.unstable_mockModule('../services/models-service.js', () => ({
  getCopilotModels: async () => [
    { id: 'claude-opus-5', vendor: 'Anthropic', name: 'Claude Opus 5', capabilities: { type: 'chat' } },
  ],
  getExposedModels: async () => [
    { id: 'claude-opus-5', vendor: 'Anthropic', name: 'Claude Opus 5', capabilities: { type: 'chat' } },
  ],
  isAnthropicChatModel: () => true,
  isLiveCatalog: () => true,
  getModelLimits: async () => ({ max_output_tokens: 8192 }),
}));

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
  default: fetchMock,
  Response: class {},
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { anthropicRoutes } = await import('./anthropic.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', anthropicRoutes);
  return app;
}

/** Build a fake SSE upstream response from a list of chunk objects. */
function sseResponse(chunks: unknown[]) {
  const body = Readable.from(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).concat('data: [DONE]\n\n')
  );
  return { ok: true, status: 200, body };
}

function rawSseResponse(chunks: string[]) {
  return { ok: true, status: 200, body: Readable.from(chunks) };
}

function eventNames(body: string) {
  return [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('POST /v1/messages', () => {
  it('rejects a request with no messages', async () => {
    const res = await request(makeApp())
      .post('/v1/messages')
      .send({ model: 'claude-opus-5', max_tokens: 10, messages: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('forwards tools upstream and returns tool_use blocks', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }) as never
    );

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'read a.ts' }],
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        tool_choice: 'auto',
      });

    expect(res.status).toBe(200);

    // The upstream request must actually carry the tool definitions.
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.model).toBe('claude-opus-5');
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.tools[0].function.name).toBe('Read');
    expect(sentBody.tool_choice).toBe('auto');

    // And the response must come back as an Anthropic tool_use block.
    expect(res.body.stop_reason).toBe('tool_use');
    expect(res.body.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
    ]);
  });

  it('sends X-Initiator agent once the conversation has assistant turns', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) as never
    );

    await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 50,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'again' },
        ],
      });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Initiator']).toBe('agent');
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
  });

  it('clamps max_tokens to the model limit', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) as never
    );

    await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 999999,
        messages: [{ role: 'user', content: 'hi' }],
      });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.max_tokens).toBe(8192);
  });

  it('maps upstream errors to Anthropic error types', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'model not entitled',
      headers: { get: () => null },
    } as never);

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('permission_error');
  });

  it('streams real SSE events including tool call deltas', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { content: 'Loo' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'king' }, finish_reason: null }] },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 5 } },
      ]) as never
    );

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'read a.ts' }],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const body = res.text;
    const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

    expect(events[0]).toBe('message_start');
    expect(events).toContain('content_block_start');
    expect(events).toContain('content_block_delta');
    expect(events[events.length - 1]).toBe('message_stop');

    // Text streamed incrementally as text_delta.
    expect(body).toContain('"type":"text_delta","text":"Loo"');
    expect(body).toContain('"type":"text_delta","text":"king"');

    // Tool call opened as its own block with input_json_delta arguments.
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"Read"');
    expect(body).toContain('"type":"input_json_delta"');

    // Final stop reason propagated.
    expect(body).toContain('"stop_reason":"tool_use"');
  });

  it('streams SSE frames split across chunk boundaries without losing events', async () => {
    const first = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Hel' }, finish_reason: null }],
    })}\n\n`;
    const second = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }],
    })}\n\n`;

    fetchMock.mockResolvedValue(
      rawSseResponse([
        first.slice(0, 13),
        first.slice(13),
        second.slice(0, -1),
        second.slice(-1),
        'data: [DONE]\n\n',
      ]) as never
    );

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(200);
    expect(eventNames(res.text).at(-1)).toBe('message_stop');
    expect([...res.text.matchAll(/"type":"text_delta","text":"([^"]+)"/g)].map((m) => m[1])).toEqual([
      'Hel',
      'lo',
    ]);
  });

  it('processes a final SSE frame even when it is not blank-line terminated', async () => {
    fetchMock.mockResolvedValue(
      rawSseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'tail' }, finish_reason: 'stop' }],
        })}`,
      ]) as never
    );

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"text_delta","text":"tail"');
    expect(res.text).toContain('"stop_reason":"end_turn"');
  });

  it('accepts CRLF-delimited upstream SSE frames', async () => {
    fetchMock.mockResolvedValue(
      rawSseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'crlf' }, finish_reason: 'stop' }],
        })}\r\n\r\n`,
        'data: [DONE]\r\n\r\n',
      ]) as never
    );

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"text_delta","text":"crlf"');
    expect(eventNames(res.text).at(-1)).toBe('message_stop');
  });

  it('returns a valid Anthropic stream when upstream only sends DONE', async () => {
    fetchMock.mockResolvedValue(rawSseResponse(['data: [DONE]\n\n']) as never);

    const res = await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    expect(res.status).toBe(200);
    expect(eventNames(res.text)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect(res.text).toContain('"stop_reason":"end_turn"');
  });

  it('sends the upstream request with stream:true when streaming', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]) as never
    );

    await request(makeApp())
      .post('/v1/messages')
      .send({
        model: 'claude-opus-5',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.stream).toBe(true);
  });
});

describe('GET /v1/models', () => {
  it('lists discovered models', async () => {
    const res = await request(makeApp()).get('/v1/models');

    expect(res.status).toBe(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data[0].id).toBe('claude-opus-5');
  });
});

describe('POST /v1/messages/count_tokens', () => {
  it('accounts for tool schemas and tool results', async () => {
    const res = await request(makeApp())
      .post('/v1/messages/count_tokens')
      .send({
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(40) }] },
        ],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      });

    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(10);
  });

  // Malformed blocks previously threw inside an async handler, which Express 4
  // does not catch; Node escalated it to uncaughtException and exited.
  it.each([
    ['text block missing text', { messages: [{ role: 'user', content: [{ type: 'text' }] }] }],
    ['tool_use missing name', { messages: [{ role: 'user', content: [{ type: 'tool_use' }] }] }],
    ['null system entry', { messages: [], system: [null] }],
    ['null content block', { messages: [{ role: 'user', content: [null] }] }],
    ['empty body', {}],
  ])('survives a malformed body: %s', async (_label, body) => {
    const res = await request(makeApp()).post('/v1/messages/count_tokens').send(body);

    expect(res.status).toBe(200);
    expect(typeof res.body.input_tokens).toBe('number');
  });
});
