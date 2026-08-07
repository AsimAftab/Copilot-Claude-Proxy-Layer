# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Project Overview

**Copilot-Claude-Proxy-Layer** — an Anthropic-Messages-compatible proxy that lets **Claude Code**
run its full agentic harness against **GitHub Copilot's** Claude models (Opus 5, Sonnet 5, …)
instead of the Anthropic API directly. It also exposes an OpenAI-compatible route for Cursor.

### Architecture

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│   Claude Code   │────▶│   Copilot Proxy Layer    │────▶│  GitHub Copilot API │
│  (Anthropic API │     │  - OAuth device flow     │     │  - claude-opus-5    │
│     format)     │     │  - Tool call translation │     │  - claude-sonnet-5  │
└─────────────────┘     │  - Real SSE streaming    │     │  - claude-opus-4.8  │
                        │  - Dynamic model catalog │     └─────────────────────┘
                        └──────────────────────────┘
```

Full detail lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/MODELS.md`](docs/MODELS.md). Read those before changing the translation layer.

### Key components

| Component | Purpose |
|-----------|---------|
| `src/routes/anthropic.ts` | `/v1/messages`, `/v1/models`, `count_tokens`, SSE loop |
| `src/services/translation/request.ts` | Anthropic → OpenAI (messages, tools, images, system) |
| `src/services/translation/response.ts` | OpenAI → Anthropic (blocks, usage, `StreamTranslator`) |
| `src/services/anthropic-service.ts` | Upstream call, retry/backoff, payload assembly |
| `src/services/models-service.ts` | `GET /models` discovery + cache |
| `src/services/auth-service.ts` | OAuth device flow, token refresh, API base discovery |
| `src/utils/model-mapper.ts` | Model name resolution |
| `src/utils/copilot-headers.ts` | Upstream header construction |

## Gotchas that will bite you

These were discovered by probing the live API. Violating them silently breaks the agent loop.

1. **Copilot splits non-streaming Claude responses across multiple `choices`** — text in one,
   `tool_calls` in another. Always aggregate across *all* choices; reading `choices[0]` yields
   `stop_reason: "tool_use"` with no tool block. Streaming does not do this.
2. **Model IDs are inconsistent** (`claude-opus-4.8` has a dot, `claude-opus-5` has no minor).
   Never hardcode — resolve through `resolveModel()` against the live catalog.
3. **The API host is per-plan** (`api.individual.…` / `api.enterprise.githubcopilot.com`) and comes
   from the token's `endpoints.api`. Never hardcode `api.githubcopilot.com`.
4. **Anthropic content blocks must not overlap.** Only one block may be open at a time; parallel
   OpenAI tool calls are buffered and flushed as sequential envelopes.
5. **Tool ordering**: an assistant message with `tool_calls` must be followed by matching
   `role:"tool"` messages before any further user content.
6. **Express 4 does not catch async handler rejections** and `uncaughtException` exits the process.
   Wrap every async route handler in try/catch.

## Development

```bash
npm install           # Install dependencies
npm run build         # Build TypeScript
npm run dev           # Development mode
npm start             # Production mode
npm test              # Run tests
npm run lint          # Lint
```

Run build, lint, and tests before committing. Tests use Jest with ESM
(`node --experimental-vm-modules`) and `jest.unstable_mockModule` for mocking.

> ⚠️ Mocks encode assumptions about the upstream API. When changing translation behaviour,
> verify against the real Copilot API — a full green suite proved insufficient once already.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, complete ALL steps. Work is NOT complete until `git push` succeeds.

1. **File issues for remaining work**
2. **Run quality gates** — `npm run build`, `npm run lint`, `npm test`
3. **Update issue status** — close finished work
4. **PUSH TO REMOTE** (mandatory):
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** — clear stashes, prune remote branches
6. **Verify** — all changes committed AND pushed
7. **Hand off** — provide context for the next session

**Critical rules:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing — that leaves work stranded locally
- If push fails, resolve and retry until it succeeds
