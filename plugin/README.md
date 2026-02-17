# opencode-augment-auth

OpenCode plugin for [Augment Code](https://augmentcode.com) — access Claude and GPT models **at zero cost** through Augment Code's infrastructure.

**No separate server process needed.** The plugin embeds the API server directly inside OpenCode and auto-configures everything.

## Quick Start

### 1. Install the Auggie CLI and authenticate

```bash
npm install -g @augmentcode/auggie
auggie login
```

### 2. Add the plugin to your `opencode.json`

```json
{
  "plugin": ["opencode-augment-auth"],
  "model": "augment/claude-opus-4-6"
}
```

That's it — no provider config needed. The plugin auto-registers all models.

### 3. Authenticate in OpenCode

```bash
opencode auth login
# Select "Augment Code (auto-detect session.json)"
```

### 4. Use it

```bash
opencode
```

## How It Works

1. **Config hook** auto-injects the `augment` provider with all 8 models into OpenCode
2. **Auth hook** validates your `~/.augment/session.json` from `auggie login`
3. **Embedded server** starts automatically on a random port when OpenCode loads the provider
4. Requests flow: OpenCode → embedded server → Auggie SDK → Augment Code API → Claude/GPT

No separate process to manage. No port conflicts. Everything runs inside OpenCode.

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

## Local Development

```bash
cd plugin
npm install
npm run build
```

Reference the local build in `opencode.json`:

```json
{
  "plugin": ["/path/to/auggie-wrapper/plugin"]
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Session file not found" | Run `auggie login` to authenticate |
| Auth login fails | Ensure `~/.augment/session.json` exists and has `accessToken` + `tenantURL` |
| Model not found | Use hyphenated IDs: `claude-opus-4-6`, not `claude-opus-4.6` |

## License

MIT
