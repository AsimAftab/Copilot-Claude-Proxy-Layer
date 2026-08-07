# Architecture

How an Anthropic Messages request from Claude Code becomes a GitHub Copilot
chat-completions request, and how the answer gets back.

## Overview

```
┌──────────────┐   Anthropic Messages    ┌───────────────────┐   OpenAI chat/completions   ┌────────────────┐
│ Claude Code  │ ──────────────────────▶ │   Copilot Proxy   │ ─────────────────────────▶  │ GitHub Copilot │
│              │ ◀────────────────────── │                   │ ◀─────────────────────────  │                │
└──────────────┘   SSE / JSON            └───────────────────┘   SSE / JSON                └────────────────┘
```

Claude Code speaks the Anthropic Messages API. Copilot exposes an
OpenAI-compatible endpoint. Everything in between is translation.

## Module map

| Path | Responsibility |
|---|---|
| `src/routes/anthropic.ts` | `/v1/messages`, `/v1/models`, `/v1/messages/count_tokens`; SSE loop; error mapping |
| `src/services/anthropic-service.ts` | Upstream call, retry/backoff, payload assembly |
| `src/services/translation/request.ts` | Anthropic → OpenAI (messages, tools, images) |
| `src/services/translation/response.ts` | OpenAI → Anthropic (blocks, usage, `StreamTranslator`) |
| `src/services/models-service.ts` | `GET /models` discovery + cache |
| `src/utils/model-mapper.ts` | Model name resolution, `/v1/models` payload |
| `src/utils/copilot-headers.ts` | Upstream header construction |
| `src/services/auth-service.ts` | OAuth device flow, token refresh, API base discovery |

## Request lifecycle

1. **Rate limit** — `rateLimiter()` assigns `res.locals.sessionId`. Request-count based only.
2. **Auth** — `requireAuth` calls `ensureValidCopilotToken()`, which refreshes an expired
   token *before* failing. (Previously the 401 was returned first, making refresh unreachable.)
3. **Validate** — `messages`, `model`, `max_tokens` and per-message roles.
4. **Resolve model** — `resolveModel()` against the live catalog (see `MODELS.md`).
5. **Translate request** — `convertMessages()` + `convertTools()`.
6. **Build headers** — `buildCopilotHeaders()`, including `X-Initiator` and vision flags.
7. **Call upstream** — `callCopilot()` with bounded retry on 408/429/5xx.
8. **Translate response** — non-streaming via `convertToAnthropicResponse()`, streaming via
   `StreamTranslator`.

## Translation reference

### Content blocks (Anthropic → OpenAI)

| Anthropic | OpenAI |
|---|---|
| `text` | `content` string, or a `text` part in a multimodal array |
| `image` (base64) | `image_url` part with a `data:<media_type>;base64,…` URI |
| `image` (url) | `image_url` part with the URL |
| `tool_use` (assistant) | `tool_calls[]` entry; `input` is JSON-stringified into `function.arguments` |
| `tool_result` (user) | a separate `role:"tool"` message with `tool_call_id` |
| `thinking`, `redacted_thinking` | dropped — Copilot never round-trips them |
| `system` (string or block array) | leading `role:"system"` message |

**Ordering rule.** Copilot enforces the OpenAI contract: an assistant message with
`tool_calls` must be followed by the matching `role:"tool"` messages *before* any further
user content. `convertMessage()` therefore emits tool results ahead of any remaining user
text found in the same Anthropic message.

### Tools and tool choice

| Anthropic | OpenAI |
|---|---|
| `tools[].input_schema` | `tools[].function.parameters` |
| `tool_choice: "auto"` | `"auto"` |
| `tool_choice: "any"` | `"required"` |
| `tool_choice: "none"` | `"none"` |
| `tool_choice: {type:"tool",name}` | `{type:"function",function:{name}}` |

### Stop reasons (OpenAI → Anthropic)

| `finish_reason` | `stop_reason` |
|---|---|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` / `function_call` | `tool_use` |
| `content_filter` | `end_turn` |

### ⚠️ Copilot quirk: multi-choice responses

For Claude models, Copilot's **non-streaming** response splits a single assistant turn across
**multiple `choices` entries** — the text arrives in one choice and `tool_calls` in another:

```json
{"choices": [
  {"finish_reason": "tool_calls", "message": {"content": "I'll read that file for you."}},
  {"finish_reason": "tool_calls", "message": {"tool_calls": [{"id": "toolu_…", "function": {"name": "Read", …}}]}}
]}
```

Standard OpenAI puts both in a single choice. `convertToAnthropicResponse()` therefore
aggregates text and tool calls across **all** choices — reading only `choices[0]` yields a
response with `stop_reason: "tool_use"` but no `tool_use` block, which stalls the agent loop.

Streaming does *not* exhibit this: it uses one choice with conventional deltas (the tool call
simply carries a non-zero `tool_calls[].index`). The stream translator still iterates every
choice, and namespaces tool-block keys by choice index, for safety.

### Sampling parameters

`temperature`, `top_p` and `stop_sequences` (→ `stop`) are forwarded. `top_k` is dropped —
it has no OpenAI equivalent. `max_tokens` is clamped to the model's advertised
`limits.max_output_tokens` rather than a hardcoded constant.

### Usage

`prompt_tokens_details.cached_tokens` is reported as Anthropic's
`cache_read_input_tokens`, and subtracted from `input_tokens` to match Anthropic's
accounting.

## Streaming

Streaming is a genuine passthrough: the proxy issues `stream: true` upstream, parses the SSE
frames incrementally, and emits Anthropic events as bytes arrive.

The upstream request is made **before** any response headers are written, so a connection-time
failure still produces a normal JSON error with a real status code instead of a half-open
event stream.

`StreamTranslator` maintains content-block indices, because Anthropic blocks may not
interleave while OpenAI freely mixes text and parallel tool calls in one delta stream:

- The first `delta.content` opens a `text` block.
- The first `delta.tool_calls[i]` **closes any open text block**, then opens a `tool_use` block.
- **Only one tool block is open at a time.** OpenAI may interleave fragments for several
  parallel calls; fragments for any call other than the active one are buffered and replayed
  when that call's turn comes, so every block gets a complete
  `content_block_start` → `input_json_delta`* → `content_block_stop` envelope with no overlap.
- Tool blocks are keyed by `tool_calls[].index`, falling back to `id` when the index is
  absent (collapsing them onto `0` would merge two distinct calls and corrupt their JSON).
- A fragment arriving for an already-closed block is discarded rather than opening a new,
  nameless `tool_use` block.
- `finish()` closes every open block, then emits `message_delta` (stop reason + output
  tokens) and `message_stop`.

Event order for a turn that emits text then a tool call:

```
message_start
content_block_start   (index 0, text)
content_block_delta   (index 0, text_delta) ×N
content_block_stop    (index 0)
content_block_start   (index 1, tool_use)
content_block_delta   (index 1, input_json_delta) ×N
content_block_stop    (index 1)
message_delta         (stop_reason: tool_use)
message_stop
```

A `ping` event is emitted every 15s to keep long agentic turns alive.

## Upstream headers

Copilot authenticates the *client* as well as the user; requests that don't look like a
supported editor integration are rejected, and newer models are gated behind recent editor
versions. All values are env-overridable (see `.env.example`).

| Header | Value |
|---|---|
| `Authorization` | `Bearer <copilot token>` |
| `Copilot-Integration-Id` | `vscode-chat` |
| `Editor-Version` | `vscode/1.102.0` |
| `Editor-Plugin-Version` | `copilot-chat/0.26.7` |
| `User-Agent` | `GitHubCopilotChat/0.26.7` |
| `X-GitHub-Api-Version` | `2025-04-01` |
| `X-Request-Id` | fresh UUID per request |
| `Openai-Intent` | `conversation-panel` |
| `X-Initiator` | `agent` when the conversation contains assistant/tool turns, else `user` |
| `Copilot-Vision-Request` | `true`, only when image content is present |

## API base discovery

The Copilot token exchange returns a per-plan host in `endpoints.api` — individual plans use
`https://api.individual.githubcopilot.com`, not the generic `api.githubcopilot.com`.
`getCopilotApiBase()` resolves in this order:

1. `COPILOT_API_BASE` env override
2. `endpoints.api` from the token
3. `https://api.githubcopilot.com` fallback

## Rate limiting

Request-count based only, using a **sliding 60-second window** per session. Token-based
per-request caps were removed: agentic turns legitimately send very large contexts, and the
earlier lifetime-cumulative counter permanently rate-limited any session that exceeded the
per-minute total. Set `DISABLE_RATE_LIMIT=1` to bypass.

## Error handling

Upstream statuses map to Anthropic error types (401 → `authentication_error`,
403 → `permission_error`, 404 → `not_found_error`, 429 → `rate_limit_error`,
5xx → `api_error`), preserving the status code and `Retry-After`. Requests retry up to 3
times with exponential backoff on 408/429/500/502/503/504.

Client disconnects abort the upstream request via `AbortController`, so a cancelled Claude
Code turn stops consuming credits.

Route handlers are individually wrapped in `try/catch`, and `src/index.ts` installs a
non-fatal `unhandledRejection` handler — Express 4 does not catch rejections from async
handlers, and the existing `uncaughtException` handler exits the process.
