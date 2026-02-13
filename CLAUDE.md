# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Auggie Wrapper is an OpenAI-compatible API proxy that routes requests to Claude models via the Augment Code SDK. It enables [OpenCode](https://opencode.ai) and other OpenAI-compatible clients to use Claude models through Augment Code's infrastructure.

**Repository**: https://github.com/hletrd/augment-opencode

## Architecture

```
OpenCode/Client → HTTP Request → src/server.ts (builds to dist/server.js) → Auggie SDK → Augment Code API → Claude Model
```

### Key Components

| File | Purpose |
|------|---------|
| `src/server.ts` | Main HTTP server - OpenAI-compatible API proxy (TypeScript) |
| `setup.sh` | Automated setup script for dependencies and OpenCode config |
| `package.json` | Node.js project configuration |
| `README.md` | User documentation |
| `CLAUDE.md` | AI assistant guidance (this file) |

### server.ts Details

- Single-file Node.js HTTP server using native `http` module
- ES modules (`"type": "module"` in package.json)
- Exposes OpenAI-compatible endpoints:
  - `POST /v1/chat/completions` - Chat completions (streaming supported)
  - `GET /v1/models` - List available models
  - `GET /v1/models/{id}` - Get specific model
  - `GET /health` - Detailed health check with metrics
  - `GET /version` - Server version and configuration info
  - `GET /metrics` - Raw request metrics
  - `GET /`, `/healthz`, `/ready` - Simple health check for load balancers
- Maintains per-model Auggie SDK client pool (up to 5 clients per model)
- True real-time streaming via Server-Sent Events with all ACP protocol update types
- Authentication from `~/.augment/session.json`
- Automatic retry with exponential backoff for transient errors
- Graceful shutdown with connection draining

## Available Models

| OpenCode Model ID | Auggie Model ID | Context | Output | Description |
|-------------------|-----------------|---------|--------|-------------|
| `claude-opus-4-6` | `opus4.6` | 200K | 32K | **Default**, most capable |
| `claude-opus-4-5` | `opus4.5` | 200K | 32K | Previous Opus generation |
| `claude-sonnet-4-5` | `sonnet4.5` | 200K | 16K | Balanced performance |
| `claude-sonnet-4` | `sonnet4` | 200K | 16K | Previous generation |
| `claude-haiku-4-5` | `haiku4.5` | 200K | 8K | Fastest, lightweight |
| `gpt-5` | `gpt5` | 128K | 16K | GPT-5 legacy |
| `gpt-5-1` | `gpt5.1` | 128K | 16K | Strong reasoning and planning |
| `gpt-5-2` | `gpt5.2` | 128K | 16K | Smarter, slower, more expensive |

**Important**: Use OpenCode Model IDs (e.g., `claude-opus-4-5`, `gpt-5-1`) in API requests, not Auggie Model IDs.

## Commands

```bash
# Install dependencies
npm install

# Start server (production)
npm start

# Start server (development with auto-reload)
npm run dev

# Run automated setup
./setup.sh

# Test endpoints
curl http://localhost:8765/health
curl http://localhost:8765/v1/models
curl -X POST http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-5", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Code Patterns

### Model Mapping (src/server.ts)

```javascript
const DEFAULT_MODEL = 'claude-opus-4-6';

const MODEL_MAP = {
  // Claude models
  'claude-opus-4-6': { auggie: 'opus4.6', name: 'Claude Opus 4.6', context: 200000, output: 32000 },
  'claude-opus-4-5': { auggie: 'opus4.5', name: 'Claude Opus 4.5', context: 200000, output: 32000 },
  'claude-sonnet-4-5': { auggie: 'sonnet4.5', name: 'Claude Sonnet 4.5', context: 200000, output: 16000 },
  'claude-sonnet-4': { auggie: 'sonnet4', name: 'Claude Sonnet 4', context: 200000, output: 16000 },
  'claude-haiku-4-5': { auggie: 'haiku4.5', name: 'Claude Haiku 4.5', context: 200000, output: 8000 },
  // GPT models
  'gpt-5': { auggie: 'gpt5', name: 'GPT-5', context: 128000, output: 16000 },
  'gpt-5-1': { auggie: 'gpt5.1', name: 'GPT-5.1', context: 128000, output: 16000 },
  'gpt-5-2': { auggie: 'gpt5.2', name: 'GPT-5.2', context: 128000, output: 16000 },
};
```

### SDK Client Caching

Clients are cached per Auggie model ID to avoid re-initialization:

```javascript
const auggieClients = {};  // Cache: { 'opus4.5': client, 'sonnet4.5': client, ... }

async function getAuggieClient(modelId) {
  const modelConfig = MODEL_MAP[modelId] || MODEL_MAP[DEFAULT_MODEL];
  const auggieModel = modelConfig.auggie;
  if (auggieClients[auggieModel]) return auggieClients[auggieModel];
  // Create new client via Auggie.create() and cache it
}
```

### Authentication

Session credentials loaded from `~/.augment/session.json`:
- `accessToken`: API authentication token
- `tenantURL`: Augment API endpoint

Created by running `auggie login`.

### Message Formatting

OpenAI chat messages are converted to a single prompt string:

```javascript
function formatMessages(messages) {
  return messages.map(m => {
    const role = m.role === 'assistant' ? 'Assistant' :
                 m.role === 'system' ? 'System' : 'User';
    return `${role}: ${m.content}`;
  }).join('\n\n');
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Server port |
| `DEBUG` | `false` | Enable debug logging (`true` or `1`) |
| `REQUEST_TIMEOUT_MS` | `300000` | Request timeout in ms (5 minutes) |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown timeout in ms (30 seconds) |

### OpenCode Configuration

Location: `~/.config/opencode/opencode.json`

Provider uses `@ai-sdk/openai-compatible` npm package:

```json
{
  "provider": {
    "augment-code": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Augment Code",
      "options": { "baseURL": "http://localhost:8765/v1" },
      "models": {
        "claude-opus-4-6": { "name": "Claude Opus 4.6 (Augment)", "limit": { "context": 200000, "output": 32000 } }
      }
    }
  }
}
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@augmentcode/auggie-sdk` | Augment Code SDK for API access |

**Runtime Requirements**:
- Node.js 24+ (ES modules, native fetch)
- Auggie CLI authenticated (`auggie login`)

## Development Guidelines

### Adding a New Model

1. Add entry to `MODEL_MAP` in `src/server.ts`:
   ```javascript
   'claude-new-model': { auggie: 'newmodel', name: 'Claude New Model', context: 200000, output: 16000 },
   ```

2. Update OpenCode config in `setup.sh` (both merge and create sections)

3. Update documentation in `README.md` and `CLAUDE.md`

### Modifying API Behavior

- Request handling: `handleChatCompletions()` function
- Response formatting: `createChatResponse()` and `createStreamChunk()` functions
- Model list: `getModels()` function

### Testing Changes

1. Stop any running server
2. Start with `npm start`
3. Test models endpoint: `curl http://localhost:8765/v1/models | jq .`
4. Test each model with chat completion
5. Verify streaming works: add `"stream": true` to request

## Streaming & Real-time Updates

The server supports **true real-time streaming** using the Auggie SDK's session update callbacks with all 8 ACP protocol update types:

### Session Update Types

| Update Type | Description | OpenAI Field |
|-------------|-------------|--------------|
| `user_message_chunk` | User message streaming | Console only |
| `agent_message_chunk` | Real-time text output | `delta.content` |
| `agent_thought_chunk` | Thinking/reasoning | `delta.reasoning_content` |
| `tool_call` | Tool execution started | `delta.tool_calls[]` + `delta.tool_metadata` |
| `tool_call_update` | Tool progress/results | `delta.tool_calls[]` + `delta.tool_metadata` |
| `plan` | Execution plan | `delta.plan[]` |
| `available_commands_update` | Available commands | `delta.available_commands[]` |
| `current_mode_update` | Mode changes | `delta.current_mode` |

### Client Pooling

The server maintains a pool of up to 5 clients per model to support parallel requests. When a request completes, the client is returned to the pool for reuse.

## Error Handling & Retry

### Automatic Retry

The server automatically retries on transient errors with exponential backoff:

| Configuration | Value |
|---------------|-------|
| Max retries | 3 |
| Initial delay | 1000ms |
| Max delay | 30000ms |
| Backoff multiplier | 2x |
| Jitter | ±10% |

### Error Classification

| Error Type | HTTP Status | Retry? |
|------------|-------------|--------|
| Rate limit | 429 | Yes |
| Server error (5xx) | 500 | Yes |
| Network timeout | 500 | Yes |
| Context length exceeded | 400 | No |
| Invalid API key | 401 | No |
| Validation error | 400 | No |

## Health & Metrics

### Health Check Endpoint (`GET /health`)

Returns detailed server status:

```json
{
  "status": "ok",
  "message": "Auggie Wrapper is running",
  "timestamp": "2026-01-27T...",
  "uptime": { "seconds": 3661, "formatted": "1h 1m 1s" },
  "metrics": {
    "totalRequests": 150,
    "successfulRequests": 148,
    "failedRequests": 2,
    "activeRequests": 1,
    "averageLatencyMs": 2500,
    "successRate": "98.67%"
  },
  "models": { "available": [...], "default": "claude-opus-4-6" },
  "memory": { "heapUsedMB": 45, "heapTotalMB": 80, "rssMB": 120 },
  "config": { "requestTimeoutMs": 300000, "shutdownTimeoutMs": 30000, "poolSize": 5 }
}
```

### Metrics Endpoint (`GET /metrics`)

Returns raw request metrics for monitoring systems.

## Graceful Shutdown

The server handles SIGTERM/SIGINT signals gracefully:

1. Stops accepting new connections
2. Waits for active requests to complete (up to `SHUTDOWN_TIMEOUT_MS`)
3. Cancels remaining requests if timeout reached
4. Cleans up client pools
5. Exits cleanly

## Known Limitations

- **Token usage**: Estimated (not exact from API)
- **Function calling**: Not supported
- **Tool use**: Not supported (but tool execution is streamed)
- **Image/multimodal**: Not supported

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Please run auggie login first" | Run `auggie login` to authenticate |
| Server not responding | Ensure server is running with `npm start` |
| Model not in OpenCode | Check `~/.config/opencode/opencode.json` has augment-code provider |
| "Unknown model" warning | Use correct model ID (e.g., `claude-opus-4-5`, not `opus4.5`) |
| Port already in use | Change port with `PORT=8766 npm start` |

## Git Workflow

```bash
# Push changes (using specific SSH key)
GIT_SSH_COMMAND="ssh -i ~/.ssh/hletrd-Github -o IdentitiesOnly=yes" git push origin main
```
