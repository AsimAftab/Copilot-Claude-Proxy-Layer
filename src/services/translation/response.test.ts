import {
  convertToAnthropicResponse,
  mapStopReason,
  mapUsage,
  parseToolArguments,
  StreamTranslator,
} from './response.js';
import { OpenAIStreamChunk } from '../../types/copilot-chat.js';

describe('response translation', () => {
  describe('mapStopReason', () => {
    it('maps openai finish reasons to anthropic stop reasons', () => {
      expect(mapStopReason('stop')).toBe('end_turn');
      expect(mapStopReason('length')).toBe('max_tokens');
      expect(mapStopReason('tool_calls')).toBe('tool_use');
      expect(mapStopReason(null)).toBeNull();
    });
  });

  describe('mapUsage', () => {
    it('splits cached tokens out of input tokens', () => {
      expect(
        mapUsage({
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 30 },
        })
      ).toEqual({
        input_tokens: 70,
        output_tokens: 20,
        cache_read_input_tokens: 30,
      });
    });

    it('handles missing usage', () => {
      expect(mapUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
    });
  });

  describe('parseToolArguments', () => {
    it('parses valid json', () => {
      expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns an empty object for invalid or empty json', () => {
      expect(parseToolArguments('{invalid')).toEqual({});
      expect(parseToolArguments('')).toEqual({});
      expect(parseToolArguments(undefined)).toEqual({});
    });
  });

  describe('convertToAnthropicResponse', () => {
    it('converts a plain text completion', () => {
      const result = convertToAnthropicResponse(
        {
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
        'claude-opus-5'
      );

      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(result.stop_reason).toBe('end_turn');
      expect(result.model).toBe('claude-opus-5');
      expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
    });

    it('converts tool_calls into tool_use blocks', () => {
      const result = convertToAnthropicResponse(
        {
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
        },
        'claude-opus-5'
      );

      expect(result.stop_reason).toBe('tool_use');
      expect(result.content).toEqual([
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
      ]);
    });

    it('always returns at least one content block', () => {
      const result = convertToAnthropicResponse({ choices: [{}] }, 'claude-opus-5');
      expect(result.content).toHaveLength(1);
    });

    // Real Copilot payload: Claude responses split text and tool_calls across
    // SEPARATE choices, unlike standard OpenAI. Reading only choices[0] dropped
    // the tool call while still reporting stop_reason "tool_use".
    it('aggregates text and tool_calls split across multiple choices', () => {
      const result = convertToAnthropicResponse(
        {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { role: 'assistant', content: "I'll read that file for you." },
            },
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'toolu_01Fh6CXPC3ct3SSidtqdbtff',
                    type: 'function',
                    function: { name: 'Read', arguments: '{"path":"src/config.ts"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 376, completion_tokens: 61 },
        },
        'claude-opus-5'
      );

      expect(result.stop_reason).toBe('tool_use');
      expect(result.content).toEqual([
        { type: 'text', text: "I'll read that file for you." },
        {
          type: 'tool_use',
          id: 'toolu_01Fh6CXPC3ct3SSidtqdbtff',
          name: 'Read',
          input: { path: 'src/config.ts' },
        },
      ]);
    });
  });

  describe('StreamTranslator', () => {
    const chunk = (delta: OpenAIStreamChunk['choices'][0]['delta'], finish?: string) =>
      ({ choices: [{ delta, finish_reason: finish ?? null }] } as OpenAIStreamChunk);

    it('opens a text block once and emits deltas', () => {
      const t = new StreamTranslator();

      const first = t.translate(chunk({ content: 'Hel' }));
      expect(first.map((e) => e.event)).toEqual([
        'content_block_start',
        'content_block_delta',
      ]);

      const second = t.translate(chunk({ content: 'lo' }));
      expect(second.map((e) => e.event)).toEqual(['content_block_delta']);
    });

    it('streams tool call arguments as input_json_delta', () => {
      const t = new StreamTranslator();

      const start = t.translate(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' } }] })
      );
      expect(start[0].event).toBe('content_block_start');
      expect(start[0].data).toMatchObject({
        index: 0,
        content_block: { type: 'tool_use', id: 'c1', name: 'Read' },
      });

      const args = t.translate(
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] })
      );
      expect(args[0].data).toMatchObject({
        delta: { type: 'input_json_delta', partial_json: '{"pa' },
      });
    });

    it('buffers tool call arguments until a later delta provides the name', () => {
      const t = new StreamTranslator();

      expect(t.translate(chunk({ tool_calls: [{ index: 0, id: 'c1' }] }))).toEqual([]);
      expect(
        t.translate(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }))
      ).toEqual([]);

      const named = t.translate(
        chunk({ tool_calls: [{ index: 0, function: { name: 'Read' } }] })
      );
      expect(named.map((e) => e.event)).toEqual([
        'content_block_start',
        'content_block_delta',
      ]);
      expect(named[0].data).toMatchObject({
        content_block: { type: 'tool_use', id: 'c1', name: 'Read' },
      });
      expect(named[1].data).toMatchObject({
        delta: { type: 'input_json_delta', partial_json: '{"pa' },
      });

      const rest = t.translate(
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] })
      );
      expect(rest[0].data).toMatchObject({
        delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' },
      });
    });

    it('closes the text block before starting a tool block', () => {
      const t = new StreamTranslator();
      t.translate(chunk({ content: 'thinking' }));

      const events = t.translate(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' } }] })
      );

      expect(events[0].event).toBe('content_block_stop');
      expect(events[0].data).toMatchObject({ index: 0 });
      expect(events[1].data).toMatchObject({ index: 1 });
    });

    it('closes a tool block before opening a later text block', () => {
      const t = new StreamTranslator();
      t.translate(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' } }] })
      );

      const events = t.translate(chunk({ content: 'done' }));

      expect(events.map((e) => e.event)).toEqual([
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
      ]);
      expect(events[0].data).toMatchObject({ index: 0 });
      expect(events[1].data).toMatchObject({
        index: 1,
        content_block: { type: 'text', text: '' },
      });
      expect(events[2].data).toMatchObject({
        index: 1,
        delta: { type: 'text_delta', text: 'done' },
      });
    });

    it('assigns distinct indices to parallel tool calls', () => {
      const t = new StreamTranslator();

      t.translate(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' } }] }));
      const second = t.translate(
        chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'Grep' } }] })
      );

      // The second tool must NOT open while the first is still active.
      expect(second).toEqual([]);
    });

    it('emits parallel tool calls as sequential non-overlapping blocks', () => {
      const t = new StreamTranslator();
      const events: Array<{ event: string; data: unknown }> = [];

      events.push(...t.translate(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' } }] })));
      events.push(...t.translate(chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'Grep' } }] })));
      events.push(...t.translate(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] })));
      events.push(...t.translate(chunk({ tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] })));
      events.push(...t.translate(chunk({}, 'tool_calls')));
      events.push(...t.finish());

      // Walk the stream and assert only one block is ever open.
      let open: number | null = null;
      const seen: number[] = [];
      for (const e of events) {
        const idx = (e.data as { index?: number }).index;
        if (e.event === 'content_block_start') {
          expect(open).toBeNull();
          open = idx!;
          seen.push(idx!);
        } else if (e.event === 'content_block_delta') {
          expect(open).toBe(idx);
        } else if (e.event === 'content_block_stop') {
          expect(open).toBe(idx);
          open = null;
        }
      }

      expect(open).toBeNull();
      expect(seen).toEqual([0, 1]);

      // Both tools' arguments must survive the buffering.
      const json = JSON.stringify(events);
      expect(json).toContain('{\\"a\\":1}');
      expect(json).toContain('{\\"b\\":2}');
      expect(json).toContain('"name":"Read"');
      expect(json).toContain('"name":"Grep"');
    });

    it('reports fallback output tokens through getUsage', () => {
      const t = new StreamTranslator();
      t.translate(chunk({ content: 'hello' }));
      t.finish(12);

      expect(t.getUsage().output_tokens).toBe(12);
    });

    // `index ?? 0` previously merged distinct index-less calls into one block,
    // corrupting the argument JSON and silently dropping the second tool.
    it('keeps index-less parallel tool calls distinct', () => {
      const t = new StreamTranslator();
      const events = [
        ...t.translate(chunk({ tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"a":1}' } }] as never })),
        ...t.translate(chunk({ tool_calls: [{ id: 'c2', function: { name: 'Grep', arguments: '{"b":2}' } }] as never })),
        ...t.finish(),
      ];

      const json = JSON.stringify(events);
      expect(json).toContain('"name":"Read"');
      expect(json).toContain('"name":"Grep"');

      const starts = events.filter((e) => e.event === 'content_block_start');
      expect(starts).toHaveLength(2);
    });

    // A late fragment for an already-closed block used to allocate a brand new
    // block with an empty name, which Claude Code would try to dispatch.
    it('never emits a tool_use block with an empty name', () => {
      const t = new StreamTranslator();
      const events = [
        ...t.translate(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"pa' } }] })),
        ...t.translate(chunk({ content: 'hmm' })),
        ...t.translate(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] })),
        ...t.finish(),
      ];

      for (const e of events) {
        const block = (e.data as { content_block?: { type: string; name?: string } }).content_block;
        if (block?.type === 'tool_use') {
          expect(block.name).toBeTruthy();
        }
      }
    });

    // Copilot commonly ends a tool-calling stream with finish_reason "stop".
    // Claude Code only dispatches tools on stop_reason "tool_use", so without
    // the override the tool renders and the turn hangs forever.
    it('forces stop_reason tool_use when a tool block was emitted', () => {
      const t = new StreamTranslator();
      t.translate(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{}' } }] })
      );
      t.translate(chunk({}, 'stop'));

      const events = t.finish(5);
      expect(events.find((e) => e.event === 'message_delta')?.data).toMatchObject({
        delta: { stop_reason: 'tool_use' },
      });
    });

    it('keeps max_tokens over tool_use when the turn was truncated', () => {
      const t = new StreamTranslator();
      t.translate(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{' } }] })
      );
      t.translate(chunk({}, 'length'));

      const events = t.finish(5);
      expect(events.find((e) => e.event === 'message_delta')?.data).toMatchObject({
        delta: { stop_reason: 'max_tokens' },
      });
    });

    // Anthropic content block indices must be gapless and ascending; a nameless
    // call that gets discarded used to burn an index and desync the client.
    it('emits gapless ascending block indices when a nameless call is dropped', () => {
      const t = new StreamTranslator();
      const events = [
        ...t.translate(chunk({ tool_calls: [{ index: 0, id: 'orphan' }] })),
        ...t.translate(
          chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'Read', arguments: '{}' } }] })
        ),
        ...t.finish(),
      ];

      const starts = events.filter((e) => e.event === 'content_block_start');
      expect(starts).toHaveLength(1);
      expect(starts[0].data).toMatchObject({ index: 0 });

      const stops = events.filter((e) => e.event === 'content_block_stop');
      expect(stops).toHaveLength(1);
      expect(stops[0].data).toMatchObject({ index: 0 });
    });

    it('emits closing events with the mapped stop reason', () => {
      const t = new StreamTranslator();
      t.translate(chunk({ content: 'hi' }));
      t.translate(chunk({}, 'tool_calls'));

      const events = t.finish(3);

      expect(events.map((e) => e.event)).toEqual([
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(events[1].data).toMatchObject({
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 3 },
      });
    });

    it('prefers upstream usage over the estimate', () => {
      const t = new StreamTranslator();
      t.translate({
        choices: [{ delta: { content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 7 },
      });

      const events = t.finish(999);
      expect(events.find((e) => e.event === 'message_delta')?.data).toMatchObject({
        usage: { output_tokens: 7 },
      });
    });

    it('ignores chunks with no choices', () => {
      const t = new StreamTranslator();
      expect(t.translate({ choices: [] })).toEqual([]);
    });
  });
});
