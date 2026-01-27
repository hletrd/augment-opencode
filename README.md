# Auggie Wrapper

An OpenAI-compatible API proxy that routes requests to Claude Opus 4.5 via Augment Code SDK.

This wrapper allows you to use [OpenCode](https://opencode.ai) or any other OpenAI-compatible client with Claude Opus 4.5 through Augment Code's powerful context engine.

## Prerequisites

- Node.js 22 or later
- Auggie CLI installed and authenticated
- An Augment Code account

## Quick Start

### Automated Setup

Run the setup script to install dependencies and configure OpenCode automatically:

```bash
./setup.sh
```

This will:
1. Install npm dependencies
2. Configure OpenCode globally to use the Augment provider
3. Provide instructions for starting the server

### Manual Installation

1. **Install Auggie CLI and authenticate:**

   ```bash
   npm install -g @augmentcode/auggie
   auggie login
   ```

2. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/your-username/auggie-wrapper.git
   cd auggie-wrapper
   npm install
   ```

3. **Start the server:**

   ```bash
   npm start
   ```

   The server will start on `http://localhost:8765`.

## OpenCode Configuration

### Automated Configuration

Run the setup script to automatically configure OpenCode:

```bash
./setup.sh
```

### Manual Configuration

Add the following to your OpenCode config file at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "augment": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Augment Code (Claude Opus)",
      "options": {
        "baseURL": "http://localhost:8765/v1"
      },
      "models": {
        "claude-opus-4-via-augment": {
          "name": "Claude Opus 4.5 via Augment",
          "limit": {
            "context": 200000,
            "output": 32000
          }
        }
      }
    }
  }
}
```

If you already have an `opencode.json` file, merge the `augment` provider into your existing `provider` section.

### Using with OpenCode

1. **Start the wrapper server:**

   ```bash
   cd /path/to/auggie-wrapper
   npm start
   ```

2. **In OpenCode, select the model:**

   ```
   /models
   ```

3. **Select `augment/claude-opus-4-via-augment`**

## Usage

### Start the Server

```bash
# Production mode
npm start

# Development mode (auto-reload on changes)
npm run dev
```

### Test with curl

```bash
# Health check
curl http://localhost:8765/health

# List models
curl http://localhost:8765/v1/models

# Chat completion
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-via-augment",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-via-augment",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Server port |
| `MODEL_NAME` | `claude-opus-4-via-augment` | Model name exposed to clients |
| `AUGMENT_MODEL` | `opus4.5` | Augment model to use (see below) |

### Available Augment Models

| Model ID | Description |
|----------|-------------|
| `opus4.5` | Claude Opus 4.5 (default, most capable) |
| `sonnet4.5` | Claude Sonnet 4.5 (balanced) |
| `sonnet4` | Claude Sonnet 4 |
| `haiku4.5` | Claude Haiku 4.5 (fastest) |

Example using a different model:

```bash
AUGMENT_MODEL=sonnet4.5 npm start
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (supports streaming) |
| `/v1/models` | GET | List available models |
| `/v1/models/{id}` | GET | Get model details |
| `/health` | GET | Health check |
| `/` | GET | Health check |

## How It Works

1. The wrapper exposes OpenAI-compatible API endpoints
2. When a chat completion request is received, it formats the messages into a prompt
3. The prompt is sent to the Augment Code SDK using your authenticated session
4. The SDK processes the request using Claude Opus 4.5 through Augment's infrastructure
5. The response is formatted back into OpenAI's response format

## Authentication

The wrapper uses your existing Augment Code authentication from `~/.augment/session.json`, which is created when you run `auggie login`.

If you see authentication errors, re-authenticate:

```bash
auggie login
```

## Troubleshooting

### "Please run auggie login first"

Your Augment session has expired or doesn't exist. Run:

```bash
auggie login
```

### Server not responding

Make sure the server is running:

```bash
npm start
```

### Model not appearing in OpenCode

1. Ensure the wrapper server is running
2. Check that `~/.config/opencode/opencode.json` contains the `augment` provider configuration
3. Run `/models` in OpenCode and look for `augment/claude-opus-4-via-augment`

### Wrong model being used

Check the server logs. If you see "Unknown model" warnings, update to the latest version which uses `opus4.5`.

## License

MIT

