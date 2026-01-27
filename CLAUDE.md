# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Auggie Wrapper is an OpenAI-compatible API proxy that routes requests to Claude models via the Augment Code SDK. It enables [OpenCode](https://opencode.ai) and other OpenAI-compatible clients to use Claude models through Augment Code's infrastructure.

**Repository**: https://github.com/hletrd/augment-opencode

## Architecture

```
OpenCode/Client → HTTP Request → server.js → Auggie SDK → Augment Code API → Claude Model
```

### Key Components

| File | Purpose |
|------|---------|
| `server.js` | Main HTTP server - OpenAI-compatible API proxy (ES modules) |
| `setup.sh` | Automated setup script for dependencies and OpenCode config |
| `package.json` | Node.js project configuration |
| `README.md` | User documentation |
| `CLAUDE.md` | AI assistant guidance (this file) |

### server.js Details

- Single-file Node.js HTTP server using native `http` module
- ES modules (`"type": "module"` in package.json)
- Exposes OpenAI-compatible endpoints:
  - `POST /v1/chat/completions` - Chat completions (streaming supported)
  - `GET /v1/models` - List available models
  - `GET /v1/models/{id}` - Get specific model
  - `GET /health` or `GET /` - Health check
- Maintains per-model Auggie SDK client cache (`auggieClients` object)
- Streaming via Server-Sent Events (simulated - fetches complete response, then chunks)
- Authentication from `~/.augment/session.json`

## Available Models

| OpenCode Model ID | Auggie Model ID | Context | Output | Description |
|-------------------|-----------------|---------|--------|-------------|
| `claude-opus-4.5` | `opus4.5` | 200K | 32K | **Default**, most capable |
| `claude-sonnet-4.5` | `sonnet4.5` | 200K | 16K | Balanced performance |
| `claude-sonnet-4` | `sonnet4` | 200K | 16K | Previous generation |
| `claude-haiku-4.5` | `haiku4.5` | 200K | 8K | Fastest, lightweight |
| `gpt-5` | `gpt5` | 128K | 16K | GPT-5 legacy |
| `gpt-5.1` | `gpt5.1` | 128K | 16K | Strong reasoning and planning |
| `gpt-5.2` | `gpt5.2` | 128K | 16K | Smarter, slower, more expensive |

**Important**: Use OpenCode Model IDs (e.g., `claude-opus-4.5`, `gpt-5.1`) in API requests, not Auggie Model IDs.

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
  -d '{"model": "claude-opus-4.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Code Patterns

### Model Mapping (server.js)

```javascript
const DEFAULT_MODEL = 'claude-opus-4.5';

const MODEL_MAP = {
  // Claude models
  'claude-opus-4.5': { auggie: 'opus4.5', name: 'Claude Opus 4.5', context: 200000, output: 32000 },
  'claude-sonnet-4.5': { auggie: 'sonnet4.5', name: 'Claude Sonnet 4.5', context: 200000, output: 16000 },
  'claude-sonnet-4': { auggie: 'sonnet4', name: 'Claude Sonnet 4', context: 200000, output: 16000 },
  'claude-haiku-4.5': { auggie: 'haiku4.5', name: 'Claude Haiku 4.5', context: 200000, output: 8000 },
  // GPT models
  'gpt-5': { auggie: 'gpt5', name: 'GPT-5', context: 128000, output: 16000 },
  'gpt-5.1': { auggie: 'gpt5.1', name: 'GPT-5.1', context: 128000, output: 16000 },
  'gpt-5.2': { auggie: 'gpt5.2', name: 'GPT-5.2', context: 128000, output: 16000 },
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

### OpenCode Configuration

Location: `~/.config/opencode/opencode.json`

Provider uses `@ai-sdk/openai-compatible` npm package:

```json
{
  "provider": {
    "augment": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Augment Code",
      "options": { "baseURL": "http://localhost:8765/v1" },
      "models": {
        "claude-opus-4.5": { "name": "Claude Opus 4.5 (Augment)", "limit": { "context": 200000, "output": 32000 } }
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
- Node.js 22+ (ES modules, native fetch)
- Auggie CLI authenticated (`auggie login`)

## Development Guidelines

### Adding a New Model

1. Add entry to `MODEL_MAP` in `server.js`:
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

The server now supports **true real-time streaming** using the Auggie SDK's session update callbacks:

### Session Update Types

| Update Type | Description |
|-------------|-------------|
| `agent_message_chunk` | Real-time text output (streamed as OpenAI content chunks) |
| `agent_thought_chunk` | Thinking/reasoning status (streamed as `reasoning` field) |
| `tool_call` | Tool execution started (logged to console) |
| `tool_call_update` | Tool execution progress (logged to console) |
| `plan` | Execution plan updates (logged to console) |

### Client Pooling

The server maintains a pool of up to 5 clients per model to support parallel requests. When a request completes, the client is returned to the pool for reuse.

## Known Limitations

- **Token usage**: Not tracked (returns 0 for all token counts)
- **Function calling**: Not supported
- **Tool use**: Not supported
- **Image/multimodal**: Not supported

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Please run auggie login first" | Run `auggie login` to authenticate |
| Server not responding | Ensure server is running with `npm start` |
| Model not in OpenCode | Check `~/.config/opencode/opencode.json` has augment provider |
| "Unknown model" warning | Use correct model ID (e.g., `claude-opus-4.5`, not `opus4.5`) |
| Port already in use | Change port with `PORT=8766 npm start` |

## Git Workflow

```bash
# Push changes (using specific SSH key)
GIT_SSH_COMMAND="ssh -i ~/.ssh/hletrd-Github -o IdentitiesOnly=yes" git push origin main
```

