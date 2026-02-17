# Augment Code for OpenCode

Use Claude and GPT models **at zero cost** in [OpenCode](https://opencode.ai) through [Augment Code](https://augmentcode.com)'s infrastructure.

## Quick Start

### 1. Install Auggie CLI

```bash
npm install -g @augmentcode/auggie
```

### 2. Run the setup script

```bash
git clone https://github.com/hletrd/augment-opencode.git
cd augment-opencode
./setup.sh
```

Or configure manually — add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-augment-auth"],
  "model": "augment/claude-opus-4-6"
}
```

### 3. Authenticate in OpenCode

```bash
opencode auth login
```

You'll see two connection options:

#### Option A: Auggie CLI Session _(recommended)_

1. Run `auggie login` — this opens a browser to authenticate with Augment Code and saves credentials to `~/.augment/session.json`
2. In OpenCode, select **"Auggie CLI Session (auggie login)"**
3. The plugin auto-detects the session file — no further input needed

#### Option B: API Key

1. Run `auggie tokens print` to get your API token
2. Run `auggie tokens print --api-url` to get the API URL
3. In OpenCode, select **"API Key (from auggie tokens print)"**
4. Enter the token and URL when prompted

### 4. Use it

```bash
opencode
```

That's it. The plugin handles everything automatically:
- Registers the `augment` provider with all 8 models
- Starts an embedded HTTP server on a random port (no conflicts between instances)
- Routes requests through the Auggie SDK to Augment Code's API
- Self-heals if the embedded server crashes

## Available Models

Use `augment/<model-id>` in OpenCode (e.g., `augment/claude-opus-4-6`).

| Model ID | Description | Context | Output |
|----------|-------------|---------|--------|
| `claude-opus-4-6` | Most capable Claude | 200K | 32K |
| `claude-opus-4-5` | Previous Opus gen | 200K | 32K |
| `claude-sonnet-4-5` | Balanced performance | 200K | 16K |
| `claude-sonnet-4` | Previous Sonnet gen | 200K | 16K |
| `claude-haiku-4-5` | Fast, lightweight | 200K | 8K |
| `gpt-5` | GPT-5 | 128K | 16K |
| `gpt-5-1` | Strong reasoning | 128K | 16K |
| `gpt-5-2` | Smarter, slower | 128K | 16K |

## How It Works

```
OpenCode → Plugin (config + auth hooks) → Embedded Server → Auggie SDK → Augment Code API → Claude/GPT
```

1. The **config hook** auto-injects the `augment` provider with all models into OpenCode
2. The **auth hook** validates credentials (session file or API key) and starts an embedded HTTP server
3. The embedded server wraps the Auggie SDK with an OpenAI-compatible API
4. Each OpenCode instance gets its own server on an OS-assigned port (no collisions)
5. Streaming uses Server-Sent Events with `agent_message_chunk` → `delta.content` and `agent_thought_chunk` → `delta.reasoning_content`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Session file not found" | Run `auggie login` to create `~/.augment/session.json` |
| Auth login fails | Run `auggie login` again, or try the API Key method instead |
| "Token is required" | Run `auggie tokens print` and paste the output |
| Model not found | Use hyphenated IDs: `claude-opus-4-6`, not `claude-opus-4.6` |
| Switch auth method | Run `opencode auth login` again and pick the other option |
| Verbose logging | Set `AUGMENT_DEBUG=true` before running OpenCode |

## Advanced: Standalone Server

If you want to use Augment Code models with **other OpenAI-compatible clients** (not just OpenCode), you can run the standalone HTTP server directly:

```bash
cd augment-opencode
npm install
npm start
```

The server starts on `http://localhost:8765`.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming supported) |
| `/v1/models` | GET | List available models |
| `/v1/models/{id}` | GET | Get model details |
| `/health` | GET | Detailed health check with metrics |
| `/version` | GET | Server version and config |
| `/metrics` | GET | Raw request metrics |

### Example

```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Server port |
| `DEBUG` | `false` | Enable debug logging |
| `REQUEST_TIMEOUT_MS` | `300000` | Request timeout (5 min) |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown timeout (30s) |

## Project Structure

```
augment-opencode/
├── plugin/                  # OpenCode plugin
│   ├── src/
│   │   ├── plugin.ts        # Config + auth hooks, embedded server lifecycle
│   │   ├── server.ts        # Embedded HTTP server wrapping Auggie SDK
│   │   └── models.ts        # Shared model definitions
│   └── package.json
├── src/
│   └── server.ts            # Standalone HTTP server (advanced)
├── setup.sh                 # Automated setup script
└── README.md
```

## License

MIT
