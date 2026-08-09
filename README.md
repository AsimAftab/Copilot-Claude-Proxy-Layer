# Copilot-Claude-Proxy-Layer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18.0+-green.svg)](https://nodejs.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

> ⚠️ **Disclaimer**: This project is for **educational purposes only**. It demonstrates API proxy patterns and OAuth device flow authentication. Use at your own risk and ensure compliance with GitHub Copilot's Terms of Service.

Run **Claude Code's full agentic harness** on your **GitHub Copilot** subscription.

This is an Anthropic-Messages-compatible proxy that translates Claude Code's requests to GitHub
Copilot's API — including **tool calling**, **real SSE streaming**, and **vision** — so Claude Code
can read, edit, and run code using Copilot's Claude models (**Opus 5**, Sonnet 5, Opus 4.8, …).
It also exposes an OpenAI-compatible endpoint for Cursor IDE.

## 🚀 Features

- **Full Agentic Tool Calling**: Forwards `tools`/`tool_choice` and translates `tool_use` ↔ `tool_result`, so Claude Code's Read/Edit/Bash/Grep tools actually work — including parallel tool calls
- **Dynamic Model Discovery**: Reads the live model catalog from Copilot, so Opus 5 and future models appear with no code change
- **Real SSE Streaming**: True incremental streaming, including streamed tool-call arguments
- **Anthropic API Compatibility**: Implements the Anthropic Messages API (`/v1/messages`, `/v1/models`, `/v1/messages/count_tokens`)
- **OpenAI API Compatibility**: OpenAI-format endpoint for Cursor IDE
- **Vision Support**: Image content blocks forwarded as multimodal parts
- **Endpoint Discovery**: Resolves your plan's real API host (individual / enterprise) from the token
- **Seamless Authentication**: GitHub OAuth device flow with automatic token refresh

📖 See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the translation reference and [`docs/MODELS.md`](docs/MODELS.md) for model resolution details.

## 📋 Prerequisites

- Node.js 18.0 or higher
- A GitHub Copilot subscription with access to Claude models
  (Opus-class models require Copilot **Pro+**, **Max**, **Business**, or **Enterprise**)
- Claude Code or Cursor IDE

## 🔧 Installation

```bash
git clone https://github.com/AsimAftab/Copilot-Claude-Proxy-Layer.git
cd Copilot-Claude-Proxy-Layer
npm install
npm run build
npm start
```

The server starts at http://localhost:3000

### 🐳 Running with Docker (background service)

Best option if you want the proxy running permanently without keeping a terminal open.

```bash
docker compose up -d --build
```

That's it — the container restarts with Docker (`restart: unless-stopped`), so it survives
reboots and you never have to start it manually again.

```bash
docker compose logs -f      # follow logs
docker compose ps           # health status
docker compose down         # stop (auth is kept in the volume)
```

Or without compose:

```bash
docker build -t copilot-claude-proxy .
docker run -d --name copilot-claude-proxy --restart unless-stopped \
  -p 3000:3000 -v copilot-proxy-data:/data copilot-claude-proxy
```

Then authenticate once at http://localhost:3000/auth.html.

Notes:

- OAuth tokens are stored in `/data` (set via `COPILOT_PROXY_DATA_DIR`). The named volume keeps
  you signed in across rebuilds, restarts and `docker rm`. **Don't skip the volume** or you'll
  re-authenticate every time.
- The image runs as the non-root `node` user and ships a `HEALTHCHECK`, so `docker ps` reports
  `healthy` once the proxy is serving.
- Node 20+ is required (the image uses `node:22-alpine`); Node 18 cannot load the built output.
- Already authenticated on the host? Seed the volume instead of re-authenticating:
  ```bash
  docker cp ~/.github-copilot-proxy/. copilot-claude-proxy:/data/
  docker restart copilot-claude-proxy
  ```

## 🔑 Authentication (getting credentials)

You do **not** create an API key. The proxy uses your existing GitHub Copilot subscription via
GitHub's OAuth device flow. There is nothing to paste into `.env`.

1. Start the server: `npm start`
2. Open **http://localhost:3000/auth.html**
3. Click login — you'll get an 8-character code like `5A34-DB8F`
4. Open **https://github.com/login/device**, enter the code, and approve
5. Done. Verify with:
   ```bash
   curl http://localhost:3000/auth/status
   # {"status":"authenticated","expiresAt":1786130901}
   ```

Tokens are cached in `~/.github-copilot-proxy/` and survive restarts. The short-lived Copilot
token (~30 min) is refreshed automatically, so you normally authenticate once.

The `ANTHROPIC_AUTH_TOKEN` you put in Claude Code's settings is a **dummy placeholder**
(`sk-dummy`) — Claude Code requires the variable to be set, but the proxy authenticates to
Copilot with your GitHub token instead.

### Prefer the terminal?

```bash
# 1. request a device code
curl -s -X POST http://localhost:3000/auth/login
# 2. approve it at https://github.com/login/device, then confirm
curl -s -X POST http://localhost:3000/auth/check
```

Other endpoints: `GET /auth/status`, `POST /auth/logout`.

## 🤖 Configuration with Claude Code

### Automatic setup (recommended)

```bash
npm run setup:claude
```

(or `copilot-claude-proxy configure` if you installed the CLI globally)

The script:

1. **Renames** any existing Claude Code configuration — `~/.claude/settings.json` and
   `~/.claude/.credentials.json` — into `~/.claude/.copilot-proxy-backups/<timestamp>/`.
   Claude Code no longer detects the old setup, but **nothing is deleted**.
2. **Writes** a fresh `~/.claude/settings.json` pointing at this gateway.
3. Prints the exact command to undo everything.

It shows a plan and asks for confirmation before touching anything.

| Option | Effect |
|--------|--------|
| `--project` | Configure `./.claude/settings.local.json` instead of the global file |
| `--port <n>` / `--host <h>` | Override the proxy address (defaults come from `.env`) |
| `--model <id>` / `--small-model <id>` | Override `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` |
| `--merge` | Keep existing non-`env` keys (permissions, hooks, statusLine) |
| `--keep-credentials` | Leave `~/.claude/.credentials.json` in place |
| `--dry-run` | Show the plan, change nothing |
| `--yes` | Skip the confirmation prompt |
| `--list` | List backup sets |
| `--restore [id]` | Put the previous configuration back |

> ⚠️ Moving `.credentials.json` signs Claude Code out of your Anthropic account until you run
> `--restore`. That is deliberate — otherwise an existing subscription login can bypass the proxy.
> Pass `--keep-credentials` if you'd rather leave it alone.

To undo:

```bash
npm run setup:claude -- --restore
```

### Manual setup

1. Start the proxy server:
   ```bash
   npm start
   ```
   You should see the authentication portal at http://localhost:3000

2. Complete GitHub authentication by pasting your auth code in the browser

3. Configure Claude Code to use the proxy by adding environment variables to your settings file:

   **Option A: Project-specific configuration** (recommended)
   
   Add to `.claude/settings.local.json` in your project:
   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:3000",
       "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
       "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
     }
   }
   ```

   **Option B: Global configuration**
   
   Add to `~/.claude/settings.json`:
   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:3000",
       "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
       "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
     }
   }
   ```

4. Enter `claude` in your terminal to start Claude Code with the proxy

### How to Verify It's Working

✅ **Server logs show 200 responses**: Look for `POST /v1/messages - 200` in the server output

✅ **Token usage is tracked**: You'll see `Tracked request for session ... +XX tokens`

✅ **Model being used**: Shows `Model resolution: "claude-opus-5" -> "claude-opus-5"` in the logs

✅ **Tools work**: Ask Claude Code to read or edit a file — it should actually do it, not just describe it

✅ **Claude Code gets responses**: Your commands should complete without errors

✅ **Usage stats**: Check http://localhost:3000/usage.html in your browser to see how many tokens you've used

### Supported Models

The model list is discovered from your Copilot subscription at runtime, so it always reflects
what your plan can actually reach. Check yours with:

```bash
curl http://localhost:3000/v1/models
```

Typical Claude models available via Copilot:

| Model | Notes |
|-------|-------|
| `claude-opus-5` | Most capable; requires Pro+/Max/Business/Enterprise |
| `claude-sonnet-5` | Strong general default, available from Pro |
| `claude-opus-4.8` / `4.7` / `4.6` | Previous Opus generations |
| `claude-sonnet-4.6` / `4.5` | Previous Sonnet generations |
| `claude-haiku-4.5` | Fastest / cheapest, good for the small-fast model slot |

Aliases `opus`, `sonnet` and `haiku` always resolve to the newest model in that family.
Anthropic-style names such as `claude-opus-4-5-20250514` are normalised automatically.

> ℹ️ If `claude-opus-5` is missing from `/v1/models`, your plan isn't entitled to it.
> See [`docs/MODELS.md`](docs/MODELS.md).

### Selecting a model

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "claude-opus-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4.5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Copilot's GPT and Gemini models also pass through by name (e.g. `"ANTHROPIC_MODEL": "gpt-5.2"`).
Set `EXPOSE_ALL_MODELS=1` to list them on `/v1/models` as well.

## 🔌 Configuration with Cursor IDE

1. Open Cursor IDE
2. Go to Settings > API Keys
3. In the "Override OpenAI Base URL" section, enter:
   ```
   http://localhost:3000
   ```
4. Go to http://localhost:3000 in your browser
5. Follow the authentication steps to connect to GitHub

## 💡 Usage

Once configured, you can use Cursor IDE as normal. All AI-powered features will now use your GitHub Copilot subscription instead of Cursor's API.

To switch back to Cursor's API:
1. Go to Settings > API Keys
2. Remove the Override OpenAI Base URL

## 🤔 How It Works

### For Claude Code (Anthropic API)

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│   Claude Code   │────▶│   Copilot Proxy Server   │────▶│  GitHub Copilot API │
│  (Anthropic API │     │                          │     │  (Anthropic Models) │
│     format)     │     │  - Auth (OAuth device)   │     │  - claude-opus-5    │
└─────────────────┘     │  - Tool call translation │     │  - claude-sonnet-5  │
                        │  - Response translation  │     │  - claude-opus-4.8  │
                        │  - Real SSE streaming    │     └─────────────────────┘
                        └──────────────────────────┘
```

1. The proxy authenticates with GitHub using the OAuth device flow
2. GitHub provides a token that the proxy uses to obtain a Copilot token, including the
   per-plan API host to talk to
3. Claude Code sends requests to the proxy in Anthropic format (`/v1/messages`)
4. The proxy translates messages, tool definitions and content blocks into Copilot's
   OpenAI-compatible format
5. Responses are translated back into Anthropic format — including `tool_use` blocks — and
   streamed incrementally as Anthropic SSE events

### For Cursor IDE (OpenAI API)

1. The proxy authenticates with GitHub using the OAuth device flow
2. GitHub provides a token that the proxy uses to obtain a Copilot token
3. Cursor sends requests to the proxy in OpenAI format
4. The proxy converts these requests to GitHub Copilot's format
5. The proxy forwards responses back to Cursor in OpenAI format

## 🛠️ Development

### Running in development mode:
```bash
npm run dev
```

### Testing:
```bash
npm test
```

### Linting:
```bash
npm run lint
```

## 📄 License

Licensed under the [MIT License](LICENSE) — Copyright (c) 2026 Asim Aftab.

Originally based on earlier MIT-licensed work by Bjorn Melin, whose copyright notice is retained
in [`LICENSE`](LICENSE) as that license requires. The Anthropic translation layer has since been
substantially rewritten to add agentic tool calling, real SSE streaming, dynamic model discovery,
and Claude Opus 5 support.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes using conventional commits (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please run `npm run build`, `npm run lint`, and `npm test` before opening a PR.
