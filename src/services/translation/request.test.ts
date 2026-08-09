import {
  convertMessages,
  convertTools,
  convertToolChoice,
  flattenSystemPrompt,
  isAgentConversation,
  requestHasImages,
} from './request.js';
import { AnthropicMessage, AnthropicMessageRequest } from '../../types/anthropic.js';

describe('request translation', () => {
  describe('flattenSystemPrompt', () => {
    it('passes a plain string through', () => {
      expect(flattenSystemPrompt('be helpful')).toBe('be helpful');
    });

    // Claude Code sends system as an array of blocks, not a string.
    it('flattens an array of content blocks', () => {
      expect(
        flattenSystemPrompt([
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ])
      ).toBe('first\n\nsecond');
    });

    it('returns empty string for undefined', () => {
      expect(flattenSystemPrompt(undefined)).toBe('');
    });
  });

  describe('convertMessages', () => {
    it('prepends the system prompt as a system message', () => {
      const result = convertMessages(
        [{ role: 'user', content: 'hi' }],
        [{ type: 'text', text: 'sys' }]
      );

      expect(result[0]).toEqual({ role: 'system', content: 'sys' });
      expect(result[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('hoists inline system messages into the leading system prompt', () => {
      const result = convertMessages(
        [
          { role: 'user', content: 'hi' },
          { role: 'system', content: [{ type: 'text', text: 'agent catalog' }] },
        ],
        [{ type: 'text', text: 'sys' }]
      );

      expect(result).toEqual([
        { role: 'system', content: 'sys\n\nagent catalog' },
        { role: 'user', content: 'hi' },
      ]);
    });

    it('hoists an inline system message even without a top-level system prompt', () => {
      const result = convertMessages([
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'catalog' },
      ]);

      expect(result).toEqual([
        { role: 'system', content: 'catalog' },
        { role: 'user', content: 'hi' },
      ]);
    });

    it('converts assistant tool_use into OpenAI tool_calls', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me look' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
          ],
        },
      ];

      const [assistant] = convertMessages(messages);

      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toBe('let me look');
      expect(assistant.tool_calls).toEqual([
        {
          id: 'toolu_1',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ path: 'a.ts' }) },
        },
      ]);
    });

    it('emits tool_result as a tool message before remaining user text', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'and now continue' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
          ],
        },
      ];

      const result = convertMessages(messages);

      // Ordering matters: OpenAI requires tool results directly after the call.
      expect(result[0]).toEqual({
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: 'file contents',
      });
      expect(result[1]).toEqual({ role: 'user', content: 'and now continue' });
    });

    it('renders nested tool_result content blocks', () => {
      const result = convertMessages([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'line one' }],
            },
          ],
        },
      ]);

      expect(result[0].content).toBe('line one');
    });

    it('converts base64 images to data URI image_url parts', () => {
      const result = convertMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            },
          ],
        },
      ]);

      expect(result[0].content).toEqual([
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]);
    });

    it('drops thinking blocks', () => {
      const result = convertMessages([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'answer' },
          ],
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('answer');
    });

    it('preserves a full tool round trip in order', () => {
      const result = convertMessages([
        { role: 'user', content: 'read a.ts' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      ]);

      expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect(result[1].content).toBeNull();
    });

    it('drops assistant thinking-only turns without orphaning a following tool result', () => {
      const result = convertMessages([
        { role: 'user', content: 'read a.ts' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ]);

      expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect(result[2]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: 'ok' });
    });

    it('emits multiple tool_result blocks before remaining user text', () => {
      const result = convertMessages([
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'one' },
            { type: 'text', text: 'continue' },
            { type: 'tool_result', tool_use_id: 't2', content: 'two' },
          ],
        },
      ]);

      expect(result).toEqual([
        { role: 'tool', tool_call_id: 't1', content: 'one' },
        { role: 'tool', tool_call_id: 't2', content: 'two' },
        { role: 'user', content: 'continue' },
      ]);
    });

    it('preserves empty string content instead of dropping the message', () => {
      expect(
        convertMessages([
          { role: 'user', content: '' },
          { role: 'assistant', content: '' },
        ])
      ).toEqual([
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
      ]);
    });
  });

  describe('convertTools', () => {
    it('maps input_schema to function parameters', () => {
      const tools = convertTools([
        {
          name: 'Read',
          description: 'Reads a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ]);

      expect(tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'Reads a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ]);
    });

    it('returns undefined when there are no tools', () => {
      expect(convertTools([])).toBeUndefined();
      expect(convertTools(undefined)).toBeUndefined();
    });
  });

  describe('convertToolChoice', () => {
    it('maps anthropic choices to openai equivalents', () => {
      expect(convertToolChoice('auto')).toBe('auto');
      expect(convertToolChoice('any')).toBe('required');
      expect(convertToolChoice('none')).toBe('none');
      expect(convertToolChoice({ type: 'tool', name: 'Read' })).toEqual({
        type: 'function',
        function: { name: 'Read' },
      });
    });
  });

  describe('request inspection', () => {
    const base: AnthropicMessageRequest = {
      model: 'claude-opus-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    };

    it('detects a fresh user conversation', () => {
      expect(isAgentConversation(base)).toBe(false);
    });

    it('detects an agent loop continuation', () => {
      expect(
        isAgentConversation({
          ...base,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
          ],
        })
      ).toBe(true);
    });

    it('detects image content', () => {
      expect(requestHasImages(base)).toBe(false);
      expect(
        requestHasImages({
          ...base,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64', data: 'x' } }],
            },
          ],
        })
      ).toBe(true);
    });
  });
});
