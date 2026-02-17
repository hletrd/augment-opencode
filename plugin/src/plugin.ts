import type { Plugin, AuthHook } from "@opencode-ai/plugin";
import {
  startEmbeddedServer,
  checkSessionFile,
  setOverrideCredentials,
} from "./server.js";
import { MODEL_MAP, DEFAULT_MODEL } from "./models.js";

/**
 * Provider ID registered with OpenCode.
 */
const PROVIDER_ID = "augment";

const LOG_PREFIX = "[augment]";
const isDebug = () =>
  process.env.DEBUG === "true" ||
  process.env.DEBUG === "1" ||
  process.env.AUGMENT_DEBUG === "true" ||
  process.env.AUGMENT_DEBUG === "1";
const debug = (...args: unknown[]) => {
  if (isDebug()) console.log(...args);
};

// ─── Embedded Server Singleton ──────────────────────────────────────────────

let embeddedServerPort: number | null = null;
let embeddedServerClose: (() => Promise<void>) | null = null;
let serverStarting: Promise<{ port: number; close: () => Promise<void> }> | null = null;

/**
 * Check if the embedded server is still alive by hitting its health endpoint.
 */
async function isServerAlive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Start or restart the embedded server. Uses a startup lock to prevent
 * concurrent starts (e.g., if the loader is called multiple times in parallel).
 * Also checks liveness of an existing server and restarts if it died.
 */
async function ensureServer(): Promise<number> {
  // Fast path: server exists and is alive
  if (embeddedServerPort) {
    if (await isServerAlive(embeddedServerPort)) {
      return embeddedServerPort;
    }
    // Server died — clean up stale state
    debug(
      `${LOG_PREFIX} Embedded server on port ${embeddedServerPort} is no longer responding, restarting...`
    );
    embeddedServerPort = null;
    embeddedServerClose = null;
    serverStarting = null;
  }

  // Prevent concurrent starts — if another call is already starting, wait for it
  if (serverStarting) {
    const result = await serverStarting;
    return result.port;
  }

  // Start a new server
  serverStarting = (async () => {
    debug(`${LOG_PREFIX} Starting embedded server...`);
    try {
      const result = await startEmbeddedServer();
      embeddedServerPort = result.port;
      embeddedServerClose = result.close;
      debug(
        `${LOG_PREFIX} ✅ Embedded server running on port ${embeddedServerPort}`
      );
      return result;
    } catch (err) {
      // Clear the lock so next call can retry
      serverStarting = null;
      throw err;
    }
  })();

  try {
    const result = await serverStarting;
    return result.port;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} ❌ Failed to start embedded server:`,
      (err as Error).message
    );
    throw err;
  }
}

// ─── Config Hook ────────────────────────────────────────────────────────────

/**
 * Auto-inject the Augment Code provider into OpenCode's config.
 * This means users DON'T need to manually configure the provider in opencode.json.
 * They only need: { "plugin": ["opencode-augment-auth"] }
 */
function createConfigHook() {
  return async (config: Record<string, any>): Promise<void> => {
    if (!config.provider) config.provider = {};

    // Only inject if not already configured
    if (!config.provider[PROVIDER_ID]) {
      debug(`${LOG_PREFIX} Auto-configuring Augment Code provider...`);

      config.provider[PROVIDER_ID] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Augment Code",
        models: Object.fromEntries(
          Object.entries(MODEL_MAP).map(([id, cfg]) => [
            id,
            {
              name: cfg.name,
              limit: { context: cfg.context, output: cfg.output },
            },
          ])
        ),
      };

      debug(
        `${LOG_PREFIX} ✅ Registered ${Object.keys(MODEL_MAP).length} models (default: ${DEFAULT_MODEL})`
      );
    }
  };
}

// ─── Auth Hook ──────────────────────────────────────────────────────────────

/**
 * Create the auth hook for the Augment Code provider.
 * Two auth methods:
 *   1. Auggie CLI Session — auto-detect from ~/.augment/session.json (via `auggie login`)
 *   2. API Key — manually enter token from `auggie tokens print`
 * The loader starts an embedded HTTP server automatically.
 */
function createAuthHook(): AuthHook {
  return {
    provider: PROVIDER_ID,

    /**
     * Loader: checks stored auth type, sets override credentials if API key,
     * ensures the embedded server is running, and returns connection details.
     */
    loader: async (getAuth) => {
      const auth = (await getAuth()) as Record<string, unknown> | undefined;
      const key = (auth?.key as string) ?? "session";

      // If auth was done with API key, parse and set override credentials
      if (key !== "session") {
        try {
          const creds = JSON.parse(key) as {
            token: string;
            url: string;
          };
          setOverrideCredentials(creds.token, creds.url);
        } catch {
          // Not JSON — treat as session-based auth
        }
      }

      const port = await ensureServer();
      return {
        apiKey: "augment-embedded",
        baseURL: `http://127.0.0.1:${port}/v1`,
      };
    },

    methods: [
      // ── Method 1: Auggie CLI Session ──────────────────────────────────
      {
        type: "api" as const,
        label: "Auggie CLI Session (auggie login)",
        prompts: [],
        authorize: async () => {
          const sessionCheck = await checkSessionFile();
          if (!sessionCheck.valid) {
            console.error(`${LOG_PREFIX} ❌ ${sessionCheck.message}`);
            console.error(
              `${LOG_PREFIX} Run 'auggie login' to authenticate with Augment Code.`
            );
            return { type: "failed" as const };
          }

          debug(`${LOG_PREFIX} ✅ ${sessionCheck.message}`);
          return { type: "success" as const, key: "session" };
        },
      },

      // ── Method 2: API Key ─────────────────────────────────────────────
      {
        type: "api" as const,
        label: "API Key (from auggie tokens print)",
        prompts: [
          {
            type: "text" as const,
            key: "token",
            message: "API token (run: auggie tokens print)",
            validate: (value: string) =>
              value.trim() ? undefined : "Token is required",
          },
          {
            type: "text" as const,
            key: "url",
            message: "API URL (from auggie tokens print --api-url)",
            validate: (value: string) =>
              value.trim() ? undefined : "URL is required",
          },
        ],
        authorize: async (inputs?: Record<string, string>) => {
          const token = inputs?.token?.trim();
          const url = inputs?.url?.trim();
          if (!token || !url) {
            console.error(`${LOG_PREFIX} ❌ Token and URL are both required.`);
            return { type: "failed" as const };
          }

          debug(`${LOG_PREFIX} ✅ API key credentials provided`);
          // Store as JSON so the loader can parse it
          return {
            type: "success" as const,
            key: JSON.stringify({ token, url }),
          };
        },
      },
    ],
  };
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Graceful shutdown: clean up the embedded server when the process exits.
 */
function registerCleanup(): void {
  const cleanup = () => {
    if (embeddedServerClose) {
      void embeddedServerClose().catch(() => {});
      embeddedServerPort = null;
      embeddedServerClose = null;
      serverStarting = null;
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// ─── Plugin Export ───────────────────────────────────────────────────────────

/**
 * OpenCode plugin for Augment Code.
 *
 * Features:
 * - Auto-configures the Augment Code provider (no manual opencode.json editing)
 * - Embeds an HTTP server (no separate process to manage)
 * - Auto-detects authentication from ~/.augment/session.json
 * - Self-healing: restarts the server if it dies
 * - Safe with multiple instances: each gets its own OS-assigned port
 *
 * Setup:
 * 1. Add "opencode-augment-auth" to plugins in opencode.json
 * 2. Run `auggie login` to authenticate
 * 3. Run `opencode auth login` → select "Augment Code"
 * 4. Use any augment/* model (e.g., augment/claude-opus-4-6)
 */
export const AugmentAuthPlugin: Plugin = async () => {
  registerCleanup();
  return {
    config: createConfigHook(),
    auth: createAuthHook(),
  };
};
