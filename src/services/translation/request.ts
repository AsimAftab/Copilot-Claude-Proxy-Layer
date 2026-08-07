/**
 * Anthropic Messages request -> Copilot (OpenAI) chat-completions request.
 *
 * The critical pieces for an agentic harness are tool translation and message
 * ordering: Copilot follows the OpenAI spec strictly, so an assistant turn
 * carrying `tool_calls` must be followed immediately by `role:"tool"` messages
 * with matching `tool_call_id` before any further user content.
 */

import {
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicTool,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../types/anthropic.js';
import {
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIToolDefinition,
} from '../../types/copilot-chat.js';

type OpenAIImagePartResult = Extract<OpenAIContentPart, { type: 'image_url' }>;

/**
 * Flatten a system prompt that may be a plain string or an array of content
 * blocks (Claude Code sends the latter, carrying cache_control markers we drop).
 */
export function flattenSystemPrompt(system?: string | ContentBlock[]): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';

  return system
    .filter((block): block is TextBlock => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n\n');
}

/**
 * Extract plain text from Anthropic content.
 */
export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Convert an Anthropic image block to an OpenAI `image_url` data URI.
 */
function imageBlockToPart(block: ImageBlock): OpenAIImagePartResult | null {
  const source = block.source;
  if (!source) return null;

  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }

  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type ?? 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }

  return null;
}

/**
 * Render a tool_result's content (string or nested blocks) as a plain string,
 * which is what OpenAI `role:"tool"` messages expect.
 */
function renderToolResult(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';

  return block.content
    .map((inner) => {
      if (inner.type === 'text') return inner.text;
      if (inner.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * True when the request contains any image content (drives the vision header).
 */
export function requestHasImages(request: AnthropicMessageRequest): boolean {
  return request.messages.some(
    (msg) => Array.isArray(msg.content) && msg.content.some((b) => b.type === 'image')
  );
}

/**
 * True once a conversation contains assistant or tool turns, i.e. it is an
 * agent loop continuation rather than a fresh user-initiated request.
 */
export function isAgentConversation(request: AnthropicMessageRequest): boolean {
  return request.messages.some(
    (msg) =>
      msg.role === 'assistant' ||
      (Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result'))
  );
}

/**
 * Convert one Anthropic message into one or more OpenAI messages.
 */
function convertMessage(message: AnthropicMessage): OpenAIChatMessage[] {
  const { role, content } = message;

  if (typeof content === 'string') {
    return [{ role, content }];
  }

  if (!Array.isArray(content)) return [];

  if (role === 'assistant') {
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];

    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        const toolUse = block as ToolUseBlock;
        toolCalls.push({
          id: toolUse.id,
          type: 'function',
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input ?? {}),
          },
        });
      }
      // thinking / redacted_thinking are dropped: Copilot never round-trips them.
    }

    if (textParts.length === 0 && toolCalls.length === 0) return [];

    const assistantMessage: OpenAIChatMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    };
    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }
    return [assistantMessage];
  }

  // User message: tool results must be emitted BEFORE any remaining user
  // content so the tool_use -> tool_result -> user ordering holds.
  const toolMessages: OpenAIChatMessage[] = [];
  const userParts: OpenAIContentPart[] = [];

  for (const block of content) {
    if (block.type === 'tool_result') {
      const result = block as ToolResultBlock;
      toolMessages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: renderToolResult(result),
      });
    } else if (block.type === 'text') {
      userParts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const part = imageBlockToPart(block as ImageBlock);
      if (part) userParts.push(part);
    }
  }

  const messages = [...toolMessages];

  if (userParts.length > 0) {
    const onlyText = userParts.every((p) => p.type === 'text');
    messages.push({
      role: 'user',
      content: onlyText
        ? userParts.map((p) => (p as { text: string }).text).join('\n')
        : userParts,
    });
  }

  return messages;
}

/**
 * Convert a full Anthropic message list to OpenAI format.
 */
export function convertMessages(
  messages: AnthropicMessage[],
  system?: string | ContentBlock[]
): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];

  const systemPrompt = flattenSystemPrompt(system);
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages) {
    result.push(...convertMessage(message));
  }

  return result;
}

/**
 * Convert Anthropic tool definitions to OpenAI function tools.
 */
export function convertTools(tools?: AnthropicTool[]): OpenAIToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.input_schema as unknown as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    },
  }));
}

/**
 * Convert Anthropic tool_choice to its OpenAI equivalent.
 */
export function convertToolChoice(
  toolChoice?: AnthropicMessageRequest['tool_choice']
): OpenAIToolChoice | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') return 'auto';
    if (toolChoice === 'any') return 'required';
    if (toolChoice === 'none') return 'none';
    return undefined;
  }

  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }

  return undefined;
}
