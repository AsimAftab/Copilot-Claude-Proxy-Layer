/**
 * Copilot (OpenAI) chat-completions response -> Anthropic Messages response.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AnthropicMessageResponse,
  AnthropicUsage,
  ContentBlock,
} from '../../types/anthropic.js';
import {
  OpenAIChatResponse,
  OpenAIStreamChunk,
  OpenAIStreamDelta,
  OpenAIUsage,
} from '../../types/copilot-chat.js';

export type AnthropicStopReason = AnthropicMessageResponse['stop_reason'];

/**
 * Generate an Anthropic-style message ID.
 */
export function generateMessageId(): string {
  return `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
}

/**
 * Map an OpenAI finish_reason onto an Anthropic stop_reason.
 */
export function mapStopReason(finishReason?: string | null): AnthropicStopReason {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return finishReason ? 'end_turn' : null;
  }
}

/**
 * Map OpenAI usage onto Anthropic usage, including prompt cache hits.
 */
export function mapUsage(usage?: OpenAIUsage): AnthropicUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const promptTokens = usage?.prompt_tokens ?? 0;

  const result: AnthropicUsage = {
    // Anthropic reports cache reads separately from fresh input tokens.
    input_tokens: cached ? Math.max(promptTokens - cached, 0) : promptTokens,
    output_tokens: usage?.completion_tokens ?? 0,
  };

  if (cached) {
    result.cache_read_input_tokens = cached;
  }

  return result;
}

/**
 * Safely parse tool-call argument JSON, tolerating partial/invalid payloads.
 */
export function parseToolArguments(raw?: string): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Convert a complete Copilot chat response into an Anthropic message response.
 *
 * Copilot splits Claude responses across MULTIPLE `choices` entries — the
 * assistant text arrives in one choice and `tool_calls` in another — unlike
 * standard OpenAI, which puts both in a single choice. All choices are
 * therefore aggregated; reading only `choices[0]` silently drops tool calls.
 */
export function convertToAnthropicResponse(
  data: OpenAIChatResponse,
  model: string
): AnthropicMessageResponse {
  const choices = data.choices ?? [];
  const content: ContentBlock[] = [];
  const texts: string[] = [];

  for (const choice of choices) {
    const text = choice.message?.content;
    if (text) {
      texts.push(text);
    }
  }

  if (texts.length > 0) {
    content.push({ type: 'text', text: texts.join('') });
  }

  for (const choice of choices) {
    for (const toolCall of choice.message?.tool_calls ?? []) {
      content.push({
        type: 'tool_use',
        id: toolCall.id || `toolu_${uuidv4().replace(/-/g, '').substring(0, 20)}`,
        name: toolCall.function?.name ?? '',
        input: parseToolArguments(toolCall.function?.arguments),
      });
    }
  }

  // Anthropic requires at least one content block.
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Prefer a tool_use stop reason from whichever choice carried the tool calls.
  const finishReasons = choices.map((c) => c.finish_reason).filter(Boolean);
  const finishReason =
    finishReasons.find((r) => r === 'tool_calls' || r === 'function_call') ??
    finishReasons[0];

  let stopReason = mapStopReason(finishReason) ?? 'end_turn';

  // Copilot frequently reports finish_reason "stop" even when it emitted tool
  // calls. Claude Code only dispatches tools when stop_reason is "tool_use", so
  // a mismatch stalls the agent loop with the call rendered but never executed.
  if (stopReason !== 'max_tokens' && content.some((b) => b.type === 'tool_use')) {
    stopReason = 'tool_use';
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(data.usage),
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface BlockState {
  anthropicIndex: number;
  type: 'text' | 'tool_use';
}

interface ToolBlockState {
  type: 'tool_use';
  /** Assigned lazily on emission so indices stay gapless and ordered. */
  anthropicIndex: number | null;
  id: string;
  name?: string;
  pendingArguments: string;
  started: boolean;
}

/**
 * Incremental translator from OpenAI stream chunks to Anthropic SSE events.
 *
 * Tracks content-block indices so a turn that interleaves text with one or more
 * parallel tool calls produces a correctly numbered sequence of
 * content_block_start / _delta / _stop events.
 */
export class StreamTranslator {
  private nextIndex = 0;
  private textBlock: BlockState | null = null;
  /** Keyed by the OpenAI `tool_calls[].index` (or id when index is absent). */
  private toolBlocks = new Map<number | string, ToolBlockState>();
  /** Keys already emitted and closed; late fragments for these are ignored. */
  private closedToolKeys = new Set<number | string>();
  /**
   * OpenAI index of the tool block currently open. Anthropic content blocks are
   * strictly sequential, so at most one may be open at a time; fragments for any
   * other tool call are buffered until this one closes.
   */
  private activeToolKey: number | string | null = null;
  /** True once any tool_use block has been emitted in this turn. */
  private emittedToolUse = false;
  private stopReason: AnthropicStopReason = null;
  private usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  private sawUsage = false;

  /**
   * Translate one chunk into zero or more Anthropic SSE events.
   */
  translate(chunk: OpenAIStreamChunk): Array<{ event: string; data: unknown }> {
    const events: Array<{ event: string; data: unknown }> = [];

    if (chunk.usage) {
      this.usage = mapUsage(chunk.usage);
      this.sawUsage = true;
    }

    // Copilot can split a Claude response across multiple choices (text in one,
    // tool_calls in another), so every choice in the chunk must be processed.
    for (const choice of chunk.choices ?? []) {
      events.push(...this.translateChoice(choice));
    }

    return events;
  }

  private translateChoice(choice: {
    delta?: OpenAIStreamDelta;
    finish_reason?: string | null;
    index?: number;
  }): Array<{ event: string; data: unknown }> {
    const events: Array<{ event: string; data: unknown }> = [];
    const delta = choice.delta;

    if (delta?.content) {
      if (this.toolBlocks.size > 0) {
        events.push(...this.closeToolBlocks());
      }

      if (!this.textBlock) {
        this.textBlock = { anthropicIndex: this.nextIndex++, type: 'text' };
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: this.textBlock.anthropicIndex,
            content_block: { type: 'text', text: '' },
          },
        });
      }

      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.textBlock.anthropicIndex,
          delta: { type: 'text_delta', text: delta.content },
        },
      });
    }

    for (const toolCall of delta?.tool_calls ?? []) {
      // Don't collapse index-less tool calls onto key 0: that would merge two
      // distinct parallel calls into one and corrupt their argument JSON.
      // Namespaced by choice index, since Copilot may use separate choices.
      const localKey =
        typeof toolCall.index === 'number'
          ? toolCall.index
          : (toolCall.id ?? `auto-${this.toolBlocks.size}`);
      const key = `${choice.index ?? 0}:${localKey}`;

      // A late fragment for a block we already closed cannot be reopened;
      // dropping it is better than emitting a phantom nameless tool_use.
      if (this.closedToolKeys.has(key)) {
        continue;
      }

      let block = this.toolBlocks.get(key);

      if (!block) {
        // Close the text block first: Anthropic blocks don't interleave.
        events.push(...this.closeTextBlock());

        block = {
          // Index is allocated when the block is actually emitted, so a
          // buffered or discarded call never leaves a gap in the sequence.
          anthropicIndex: null,
          type: 'tool_use',
          id: toolCall.id || `toolu_${uuidv4().replace(/-/g, '').substring(0, 20)}`,
          name: toolCall.function?.name,
          pendingArguments: '',
          started: false,
        };
        this.toolBlocks.set(key, block);

        if (this.activeToolKey === null) {
          this.activeToolKey = key;
        }
      } else {
        if (toolCall.id) block.id = toolCall.id;
        if (toolCall.function?.name !== undefined) block.name = toolCall.function.name;
      }

      const isActive = this.activeToolKey === key;

      // Only the active block may emit; parallel calls buffer until their turn.
      if (isActive && !block.started && block.name !== undefined) {
        events.push(...this.startToolBlock(block));
      }

      if (toolCall.function?.arguments) {
        if (isActive && block.started) {
          events.push(this.toolArgumentEvent(block, toolCall.function.arguments));
        } else {
          block.pendingArguments += toolCall.function.arguments;
        }
      }
    }

    if (choice.finish_reason) {
      this.stopReason = mapStopReason(choice.finish_reason);
    }

    return events;
  }

  /**
   * Emit the closing events for any open blocks plus message_delta/message_stop.
   */
  finish(fallbackOutputTokens = 0): Array<{ event: string; data: unknown }> {
    const events: Array<{ event: string; data: unknown }> = [];

    events.push(...this.closeTextBlock());
    events.push(...this.closeToolBlocks());

    const outputTokens = this.sawUsage ? this.usage.output_tokens : fallbackOutputTokens;
    // Keep getUsage() consistent with what we report, so usage tracking isn't
    // zeroed when the upstream stream omits a usage chunk.
    this.usage = { ...this.usage, output_tokens: outputTokens };

    // Copilot frequently ends a tool-calling turn with finish_reason "stop"
    // (or no finish_reason at all). Claude Code only dispatches tools when
    // stop_reason is "tool_use", so without this the turn renders the tool
    // call and then hangs forever waiting for a result it never requested.
    let stopReason = this.stopReason ?? 'end_turn';
    if (this.emittedToolUse && stopReason !== 'max_tokens') {
      stopReason = 'tool_use';
    }

    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
    });

    events.push({ event: 'message_stop', data: { type: 'message_stop' } });

    return events;
  }

  /** Usage accumulated so far. */
  getUsage(): AnthropicUsage {
    return this.usage;
  }

  /** True if any content block was opened. */
  hasContent(): boolean {
    return this.nextIndex > 0;
  }

  private closeTextBlock(): Array<{ event: string; data: unknown }> {
    if (!this.textBlock) return [];

    const event = {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: this.textBlock.anthropicIndex },
    };
    this.textBlock = null;
    return [event];
  }

  private startToolBlock(block: ToolBlockState): Array<{ event: string; data: unknown }> {
    block.started = true;
    block.anthropicIndex = this.nextIndex++;
    this.emittedToolUse = true;

    const events: Array<{ event: string; data: unknown }> = [
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: block.anthropicIndex,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        },
      },
    ];

    if (block.pendingArguments) {
      events.push(this.toolArgumentEvent(block, block.pendingArguments));
      block.pendingArguments = '';
    }

    return events;
  }

  private toolArgumentEvent(
    block: ToolBlockState,
    partialJson: string
  ): { event: string; data: unknown } {
    return {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: block.anthropicIndex as number,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      },
    };
  }

  private closeToolBlocks(): Array<{ event: string; data: unknown }> {
    const events: Array<{ event: string; data: unknown }> = [];

    // Emit the active block first, then each buffered parallel call as its own
    // complete start/delta/stop envelope so blocks never overlap.
    const ordered = [...this.toolBlocks.entries()].sort(([a], [b]) => {
      if (a === this.activeToolKey) return -1;
      if (b === this.activeToolKey) return 1;
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return 0;
    });

    for (const [key, block] of ordered) {
      // A tool call whose name never arrived cannot be dispatched by Claude
      // Code; emitting it would stall the harness on an unknown tool.
      if (!block.started && !block.name) {
        this.closedToolKeys.add(key);
        continue;
      }

      if (!block.started) {
        events.push(...this.startToolBlock(block));
      } else if (block.pendingArguments) {
        events.push(this.toolArgumentEvent(block, block.pendingArguments));
        block.pendingArguments = '';
      }

      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: block.anthropicIndex },
      });
      this.closedToolKeys.add(key);
    }

    this.toolBlocks.clear();
    this.activeToolKey = null;
    return events;
  }
}
