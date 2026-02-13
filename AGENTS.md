# AGENTS.md

AI assistant context and working notes for the augment-opencode repository.

## Repository Overview

**augment-opencode** is an OpenAI-compatible API proxy that routes requests to Claude models (and GPT models) via the Augment Code SDK. This enables [OpenCode](https://opencode.ai) and other OpenAI-compatible clients to use Augment Code's infrastructure and models.

**Repository**: https://github.com/hletrd/augment-opencode
**Primary Language**: TypeScript (Node.js 24+)
**Main File**: `src/server.ts` (builds to `dist/server.js`)

## What is "Auggie"?

**Auggie** refers to the Augment Code CLI tool (`@augmentcode/auggie`), which provides:
- Authentication with Augment Code services (`auggie login`)
- SDK for programmatic access to Augment Code's API
- Access to Claude models (Opus 4.6, Opus 4.5, Sonnet 4.5, Haiku 4.5) and GPT models (5.x series)

This repository wraps the Auggie SDK to provide an OpenAI-compatible HTTP API.

## DGX-H100 Relationship

**Note**: This repository is **NOT** related to NVIDIA DGX-H100 systems. The initial query about DGX-H100 was a search request, but this repo's focus is on Augment Code API integration, not GPU infrastructure.

## Recent Changes (2026-02-07)

### Latest Pull
- Pulled latest changes from `origin/main`
- Updated `src/server.ts` with significant improvements (97 insertions, 22 deletions)
- Local changes stashed before pull:
  - `package-lock.json` (modified)
  - `src/server.ts` (modified)
  - `THINKING_PROGRESS_FIX.md` (untracked)

### Repository State
- **Branch**: `main`
- **Status**: Up to date with `origin/main` (commit 3342bb1)
- **Stashed changes**: 1 stash entry ("Auto-stash before pull for AGENTS.md update")

## Architecture

```
OpenCode/Client → HTTP (localhost:8765) → server.ts → Auggie SDK → Augment Code API → Claude/GPT Models
```

## Available Models

| Model ID | Backend | Context | Output | Use Case |
|----------|---------|---------|--------|----------|
| `claude-opus-4-6` | Augment | 200K | 32K | Default, most capable |
| `claude-opus-4-5` | Augment | 200K | 32K | Previous Opus generation |
| `claude-sonnet-4-5` | Augment | 200K | 16K | Balanced performance |
| `claude-sonnet-4` | Augment | 200K | 16K | Previous generation |
| `claude-haiku-4-5` | Augment | 200K | 8K | Fastest, lightweight |
| `gpt-5` | Augment | 128K | 16K | GPT-5 legacy |
| `gpt-5-1` | Augment | 128K | 16K | Strong reasoning |
| `gpt-5-2` | Augment | 128K | 16K | Smarter, slower |

## Key Files

| File | Purpose | Notes |
|------|---------|-------|
| `src/server.ts` | Main HTTP server | Single-file TypeScript server with OpenAI-compatible endpoints |
| `setup.sh` | Automated setup | Installs deps, configures OpenCode |
| `CLAUDE.md` | AI guidance | Comprehensive project documentation for Claude |
| `README.md` | User docs | Installation, usage, troubleshooting |
| `package.json` | Node config | Dependencies, scripts, metadata |

## Common Commands

```bash
# Install dependencies
npm install

# Start server (production)
npm start

# Development with auto-reload
npm run dev

# Run automated setup
./setup.sh

# Test endpoints
curl http://localhost:8765/health
curl http://localhost:8765/v1/models
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming supported) |
| `/v1/models` | GET | List available models |
| `/v1/models/{id}` | GET | Get specific model details |
| `/health` | GET | Detailed health check with metrics |
| `/version` | GET | Server version and config |
| `/metrics` | GET | Raw request metrics (JSON) |
| `/`, `/healthz`, `/ready` | GET | Simple health check |

## Features

- **OpenAI-compatible API** - Drop-in replacement
- **Real-time streaming** - True SSE streaming with all ACP protocol update types (8 types)
- **Multiple models** - Claude and GPT models accessible
- **Automatic retry** - Exponential backoff for rate limits and transient errors
- **Client pooling** - Up to 5 clients per model for parallel requests
- **Graceful shutdown** - Connection draining on SIGTERM/SIGINT
- **Health monitoring** - Detailed metrics, uptime, latency tracking
- **Structured logging** - JSON logs with request IDs and timing

## Streaming Update Types

When streaming is enabled, the server sends all 8 ACP protocol update types:

| Update Type | Description | OpenAI Field |
|-------------|-------------|--------------|
| `user_message_chunk` | User message streaming | Console only |
| `agent_message_chunk` | Real-time text output | `delta.content` |
| `agent_thought_chunk` | Thinking/reasoning | `delta.reasoning_content` |
| `tool_call` | Tool execution started | `delta.tool_calls[]` |
| `tool_call_update` | Tool progress/results | `delta.tool_metadata` |
| `plan` | Execution plan | `delta.plan[]` |
| `available_commands_update` | Commands | `delta.available_commands[]` |
| `current_mode_update` | Mode changes | `delta.current_mode` |

## Development Notes

### Adding a New Model
1. Add to `MODEL_MAP` in `src/server.ts`
2. Update OpenCode config in `setup.sh`
3. Update documentation

### Testing Changes
1. Stop running server
2. Start with `npm start`
3. Test models: `curl http://localhost:8765/v1/models | jq .`
4. Test chat completion with each model
5. Verify streaming: add `"stream": true`

### Authentication
- Session stored in `~/.augment/session.json`
- Created by `auggie login`
- Contains `accessToken` and `tenantURL`

## Known Limitations

- Token usage is estimated (not exact from API)
- Function calling not supported
- Tool use not supported (but tool execution is streamed)
- Image/multimodal not supported

## Git Workflow

This repo uses a specific SSH key for GitHub operations:

```bash
# Push changes
GIT_SSH_COMMAND="ssh -i ~/.ssh/hletrd-Github -o IdentitiesOnly=yes" git push origin main

# Pull changes
GIT_SSH_COMMAND="ssh -i ~/.ssh/hletrd-Github -o IdentitiesOnly=yes" git pull
```

## Related Repositories

This is a standalone proxy server. Related infrastructure:
- User might have other repos for infrastructure management (nas-ops, router-ops, etc.)
- This repo focuses solely on Augment Code API integration

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Please run auggie login first" | Run `auggie login` to authenticate |
| Server not responding | Ensure `npm start` is running |
| Model not in OpenCode | Check `~/.config/opencode/opencode.json` |
| Port in use | Use `PORT=8766 npm start` |

## Next Steps

After stash pop (if needed):
1. Review stashed changes: `git stash show -p stash@{0}`
2. Apply if needed: `git stash pop`
3. Review `THINKING_PROGRESS_FIX.md` for any pending work
4. Test server with latest changes

---

**Last Updated**: 2026-02-07
**Status**: Active development, up to date with origin/main
