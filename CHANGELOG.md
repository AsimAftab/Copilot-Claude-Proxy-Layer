# Changelog

## [Unreleased]

### Fixed
- **`400 messages: each message must have a valid role`** with Claude Code 2.1.x — Claude Code
  appends a `role: "system"` message *inside* `messages` (the Agent-tool catalog). The proxy now
  accepts it and hoists its text into the leading system prompt, since Copilot rejects a system
  turn that follows user/assistant content

### Added
- **One-command Claude Code setup** — `npm run setup:claude` (or `copilot-claude-proxy configure`)
  renames any existing Claude Code configuration (`~/.claude/settings.json`,
  `~/.claude/.credentials.json`) into `~/.claude/.copilot-proxy-backups/<timestamp>/` so it is no
  longer detected but never lost, then writes a fresh gateway-pointing settings file
- `configure --restore [id]` / `--list` to undo a setup run and inspect backup sets
- `configure` flags: `--project`, `--port`, `--host`, `--model`, `--small-model`, `--merge`,
  `--keep-credentials`, `--dry-run`, `--yes`, `--force`
- Preflight probes against `/health`, `/auth/status` and `/v1/models` that warn (never block) when
  the proxy is down, unauthenticated, or the selected model is not in the live catalog

## [v1.0.0] - 2026-08-08

Major rewrite of the Anthropic translation layer. Claude Code's agentic harness now works
end to end against GitHub Copilot's Claude models, verified live against `claude-opus-5`.

### Added
- **Agentic tool calling** — `tools`/`tool_choice` are forwarded upstream, and `tool_use` ↔
  `tool_result` are translated in both directions with OpenAI-correct message ordering
- **Real SSE streaming** — genuine incremental translation with per-block index tracking and
  `input_json_delta` for streamed tool arguments (previously the full response was fetched and
  replayed in fake chunks)
- **Dynamic model discovery** — the catalog is read from `GET /models` at runtime, so Opus 5 and
  future models appear with no code change; static list kept only as an offline fallback
- **Claude Opus 5 / Sonnet 5 / Opus 4.8, 4.7, 4.6 / Sonnet 4.6** support
- **Per-plan API host discovery** from the token's `endpoints.api` (individual / enterprise)
- **Vision support** — image content blocks forwarded as multimodal parts
- **Image, multi-block system prompt, and sampling parameter** passthrough (`top_p`,
  `stop_sequences`); `max_tokens` clamped to each model's real limit
- Upstream error mapping to Anthropic error types with bounded exponential backoff
- Client-disconnect cancellation via `AbortController`
- `docs/ARCHITECTURE.md` and `docs/MODELS.md`
- Test suite covering the translation layer, streaming state machine, and routes

### Fixed
- **Tool calls were silently dropped**: Copilot splits non-streaming Claude responses across
  multiple `choices` (text in one, `tool_calls` in another). Reading `choices[0]` alone returned
  `stop_reason: "tool_use"` with no tool block, stalling the agent loop
- **Proxy permanently rate-limited itself** after roughly 300 requests — the limiter compared a
  lifetime-cumulative counter against a per-minute limit; replaced with a sliding window
- **Malformed `count_tokens` body crashed the process** via an uncaught async rejection
- Overlapping content blocks for parallel tool calls (Anthropic requires sequential envelopes)
- Index-less parallel tool calls collapsing into one, corrupting argument JSON
- Model resolution returning models absent from the account's catalog
- Unreachable token-refresh branch that returned 401 instead of refreshing
- `system` sent as a content-block array being mishandled
- Missing `Copilot-Integration-Id`, `X-Initiator`, and vision headers

### Changed
- Renamed to `copilot-claude-proxy-layer`; CLI binary is now `copilot-claude-proxy`
- Default model is `claude-opus-5`
- Rate limits raised substantially for agentic bursts; per-request token caps removed

## [v0.1.0] - 2025-03-24

### Added
- Initial release of GitHub Copilot Proxy
- OAuth Device Flow Authentication with GitHub
- OpenAI-Compatible API endpoints (`/v1/models` and `/v1/chat/completions`)
- Token management with automatic refresh and validation
- Streaming support for real-time completions
- Rate limiting based on requests and token usage
- Usage monitoring and metrics dashboard
- Web-based authentication UI
- Environment variable configuration with Zod validation
- Enhanced .gitignore with additional standard entries

