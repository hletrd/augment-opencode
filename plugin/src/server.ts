/**
 * Embedded HTTP server for the Augment Code OpenCode plugin.
 * Provides an OpenAI-compatible API backed by the Auggie SDK.
 * Started in-process by the plugin loader on an OS-assigned port.
 */

import type { IncomingMessage, ServerResponse } from "http";
import http from "http";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { MODEL_MAP, DEFAULT_MODEL } from "./models.js";
import type { ModelConfig } from "./models.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Session {
  accessToken: string;
  tenantURL: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool" | "function";
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

// ACP Protocol Types
interface ContentBlock {
  type: string;
  text?: string;
}

interface SessionUpdate {
  sessionUpdate: string;
  content?: ContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  entries?: Array<{ content: string; status: string; priority: string }>;
  availableCommands?: Array<{ name: string; description: string }>;
  currentModeId?: string;
}

interface SessionNotification {
  sessionId?: string;
  update: SessionUpdate;
}

interface AuggieClient {
  prompt(message: string): Promise<string>;
  onSessionUpdate(
    callback: ((notification: SessionNotification) => void) | null
  ): void;
  close(): Promise<void>;
}

interface ClientPool {
  available: AuggieClient[];
  inUse: Set<AuggieClient>;
  creating: number;
}

interface AuggieSDK {
  create: (options: {
    model?: string;
    apiKey?: string;
    apiUrl?: string;
    workspaceRoot?: string;
    allowIndexing?: boolean;
  }) => Promise<AuggieClient>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const POOL_SIZE = 5;
const REQUEST_TIMEOUT_MS = 3600000; // 1 hour
const RETRY_MAX = 3;
const RETRY_INITIAL_DELAY = 1000;
const RETRY_MAX_DELAY = 30000;

const clientPools: Record<string, ClientPool> = {};
let AuggieClass: AuggieSDK | null = null;
let session: Session | null = null;
let serverInstance: http.Server | null = null;
let overrideCredentials: Session | null = null;

const LOG_PREFIX = "[augment-server]";
const isDebug = () =>
  process.env.AUGMENT_DEBUG === "true" ||
  process.env.AUGMENT_DEBUG === "1";
const debug = (...args: unknown[]) => {
  if (isDebug()) console.log(...args);
};

// ─── Session ─────────────────────────────────────────────────────────────────

export async function checkSessionFile(): Promise<{
  exists: boolean;
  valid: boolean;
  message: string;
}> {
  const sessionPath = path.join(os.homedir(), ".augment", "session.json");
  try {
    await fs.access(sessionPath);
  } catch {
    return {
      exists: false,
      valid: false,
      message: "Session file not found. Run 'auggie login' first.",
    };
  }
  try {
    const data = await fs.readFile(sessionPath, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (
      typeof parsed["accessToken"] === "string" &&
      typeof parsed["tenantURL"] === "string"
    ) {
      return { exists: true, valid: true, message: "Session file is valid" };
    }
    return {
      exists: true,
      valid: false,
      message: "Session file is missing accessToken or tenantURL",
    };
  } catch {
    return {
      exists: true,
      valid: false,
      message: "Session file is not valid JSON",
    };
  }
}

/**
 * Set override credentials (API key + URL) so the server uses these
 * instead of reading from ~/.augment/session.json.
 */
export function setOverrideCredentials(
  accessToken: string,
  tenantURL: string
): void {
  overrideCredentials = { accessToken, tenantURL };
  session = null; // Clear cached session so next call picks up override
}

async function loadSession(): Promise<Session> {
  if (overrideCredentials) return overrideCredentials;
  if (session) return session;
  const sessionPath = path.join(os.homedir(), ".augment", "session.json");
  const data = await fs.readFile(sessionPath, "utf-8");
  session = JSON.parse(data) as Session;
  return session;
}

// ─── SDK & Client Pool ──────────────────────────────────────────────────────

async function initAuggie(): Promise<void> {
  if (!AuggieClass) {
    const sdk = await import("@augmentcode/auggie-sdk");
    AuggieClass = sdk.Auggie as unknown as AuggieSDK;
  }
}

async function createAuggieClient(
  auggieModel: string,
  workspaceRoot?: string
): Promise<AuggieClient> {
  await initAuggie();
  if (!AuggieClass) throw new Error("Auggie SDK not initialized");
  const sess = await loadSession();
  const workspace = workspaceRoot ?? os.homedir();
  debug(
    `${LOG_PREFIX} Creating client for ${auggieModel} (workspace: ${workspace})`
  );
  return AuggieClass.create({
    model: auggieModel,
    apiKey: sess.accessToken,
    apiUrl: sess.tenantURL,
    workspaceRoot: workspace,
    allowIndexing: true,
  });
}

function getPoolKey(auggieModel: string, workspaceRoot?: string): string {
  return `${auggieModel}:${workspaceRoot ?? os.homedir()}`;
}

async function getAuggieClient(
  modelId: string,
  workspaceRoot?: string
): Promise<AuggieClient> {
  const modelConfig = MODEL_MAP[modelId] ?? MODEL_MAP[DEFAULT_MODEL];
  if (!modelConfig) throw new Error(`Unknown model: ${modelId}`);
  const auggieModel = modelConfig.auggie;
  const poolKey = getPoolKey(auggieModel, workspaceRoot);

  clientPools[poolKey] ??= { available: [], inUse: new Set(), creating: 0 };
  const pool = clientPools[poolKey];

  if (pool.available.length > 0) {
    const client = pool.available.pop();
    if (client) {
      pool.inUse.add(client);
      return client;
    }
  }

  if (pool.inUse.size + pool.creating < POOL_SIZE) {
    pool.creating++;
    try {
      const client = await createAuggieClient(auggieModel, workspaceRoot);
      pool.creating--;
      pool.inUse.add(client);
      return client;
    } catch (err) {
      pool.creating--;
      throw err;
    }
  }

  // Pool at capacity — create temporary client
  return createAuggieClient(auggieModel, workspaceRoot);
}

function releaseAuggieClient(
  modelId: string,
  client: AuggieClient,
  workspaceRoot?: string
): void {
  const modelConfig = MODEL_MAP[modelId] ?? MODEL_MAP[DEFAULT_MODEL];
  if (!modelConfig) return;
  const poolKey = getPoolKey(modelConfig.auggie, workspaceRoot);
  const pool = clientPools[poolKey];
  if (!pool) return;

  if (pool.inUse.has(client)) {
    pool.inUse.delete(client);
    if (pool.available.length < POOL_SIZE) {
      pool.available.push(client);
    } else {
      void client.close();
    }
  }
}

function discardAuggieClient(
  modelId: string,
  client: AuggieClient,
  workspaceRoot?: string
): void {
  const modelConfig = MODEL_MAP[modelId] ?? MODEL_MAP[DEFAULT_MODEL];
  if (!modelConfig) return;
  const poolKey = getPoolKey(modelConfig.auggie, workspaceRoot);
  const pool = clientPools[poolKey];
  if (pool?.inUse.has(client)) {
    pool.inUse.delete(client);
  }
  void client.close();
}

// ─── Error Handling ─────────────────────────────────────────────────────────

function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (
    msg.includes("context length") ||
    msg.includes("token limit") ||
    msg.includes("too long")
  )
    return false;
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("not connected") ||
    msg.includes("no session") ||
    msg.includes("websocket") ||
    (error as any).statusCode >= 500
  );
}

function isSessionError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("not connected") ||
    msg.includes("no session") ||
    msg.includes("websocket") ||
    msg.includes("disconnected")
  );
}

function classifyError(error: Error): {
  status: number;
  body: { error: { message: string; type: string; code: string | null } };
} {
  const msg = error.message.toLowerCase();
  if (msg.includes("context length") || msg.includes("token limit")) {
    return {
      status: 400,
      body: {
        error: {
          message: `Context length exceeded: ${error.message}`,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      },
    };
  }
  if (msg.includes("rate limit") || msg.includes("too many requests")) {
    return {
      status: 429,
      body: {
        error: {
          message: `Rate limit exceeded: ${error.message}`,
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        message: error.message,
        type: "server_error",
        code: null,
      },
    },
  };
}

// ─── Retry ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  name: string
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err as Error;
      if (!isRetryableError(lastError) || attempt === RETRY_MAX) throw lastError;
      const delay = Math.min(
        RETRY_INITIAL_DELAY * Math.pow(2, attempt),
        RETRY_MAX_DELAY
      );
      const jitter = delay * 0.1 * (Math.random() * 2 - 1);
      debug(
        `${LOG_PREFIX} ${name} failed (attempt ${attempt + 1}/${RETRY_MAX + 1}), retrying in ${Math.floor(delay + jitter)}ms`
      );
      await sleep(Math.floor(delay + jitter));
    }
  }
  throw lastError ?? new Error("Unknown retry error");
}

// ─── Message Formatting ─────────────────────────────────────────────────────

function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role =
        m.role === "assistant"
          ? "Assistant"
          : m.role === "system"
            ? "System"
            : m.role === "tool"
              ? "Tool Result"
              : m.role === "function"
                ? "Function Result"
                : "User";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

function extractWorkspaceFromMessages(
  messages: ChatMessage[]
): string | null {
  for (const msg of messages) {
    if (msg.role === "system" && msg.content) {
      const m1 = msg.content.match(
        /<supervisor>[^<]*?(?:workspace is opened at|workspace is)\s+[`"']?([^`"'<\n]+)[`"']?/i
      );
      if (m1?.[1]) return m1[1].trim().replace(/\.$/, "");
      const m2 = msg.content.match(
        /(?:workspace|working directory|cwd):\s*[`"']?([^\s`"'\n]+)/i
      );
      if (m2?.[1]) return m2[1].trim();
    }
  }
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Response Creation ──────────────────────────────────────────────────────

function createChatResponse(
  content: string,
  model: string,
  promptText?: string
) {
  const promptTokens = promptText ? estimateTokens(promptText) : 0;
  const completionTokens = estimateTokens(content);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ─── Streaming ──────────────────────────────────────────────────────────────

interface StreamHandler {
  callback: (notification: SessionNotification) => void;
  flush: () => void;
}

function createStreamCallback(
  res: ServerResponse,
  model: string,
  requestId: string
): StreamHandler {
  const chunkId = `chatcmpl-${requestId}`;

  // Reasoning buffer: collect thinking chunks and flush before first text content.
  // The Auggie SDK may send agent_thought_chunk events before or after
  // agent_message_chunk events. Buffering ensures reasoning appears before
  // content in the SSE stream, so OpenCode renders thinking at the top.
  const reasoningBuffer: string[] = [];
  let hasStartedTextContent = false;
  let hasFlushedReasoning = false;

  function flushReasoningBuffer(): void {
    if (hasFlushedReasoning || reasoningBuffer.length === 0) return;
    hasFlushedReasoning = true;
    const combined = reasoningBuffer.join("");
    reasoningBuffer.length = 0;
    const timestamp = Math.floor(Date.now() / 1000);
    res.write(
      `data: ${JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: timestamp,
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: combined },
            finish_reason: null,
            logprobs: null,
          },
        ],
      })}\n\n`
    );
  }

  const callback = (notification: SessionNotification): void => {
    const update = notification.update;
    const timestamp = Math.floor(Date.now() / 1000);

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && update.content.text) {
          // Flush any buffered reasoning before the first text content
          if (!hasStartedTextContent) {
            hasStartedTextContent = true;
            flushReasoningBuffer();
          }
          res.write(
            `data: ${JSON.stringify({
              id: chunkId,
              object: "chat.completion.chunk",
              created: timestamp,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: update.content.text },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            })}\n\n`
          );
        }
        break;

      case "agent_thought_chunk":
        if (update.content?.type === "text" && update.content.text) {
          if (!hasStartedTextContent) {
            // Buffer reasoning before text content starts
            reasoningBuffer.push(update.content.text);
          } else {
            // Late reasoning: text already started, send immediately
            res.write(
              `data: ${JSON.stringify({
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: update.content.text },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              })}\n\n`
            );
          }
        }
        break;

      case "tool_call":
      case "tool_call_update":
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
      case "user_message_chunk":
        // These are Augment-internal events, not streamed to client
        break;

      default:
        break;
    }
  };

  return { callback, flush: flushReasoningBuffer };
}

// ─── SDK Error Check ────────────────────────────────────────────────────────

function isSDKErrorResponse(
  response: string
): { isError: boolean; message?: string } {
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    if (typeof parsed["error"] === "string") {
      return { isError: true, message: parsed["error"] as string };
    }
    if (parsed["error"] && typeof parsed["error"] === "object") {
      const e = parsed["error"] as Record<string, unknown>;
      return { isError: true, message: (e["message"] as string) ?? String(e) };
    }
  } catch {
    // Not JSON
  }
  return { isError: false };
}

// ─── API Calls ──────────────────────────────────────────────────────────────

async function callStreamingInternal(
  prompt: string,
  modelId: string,
  res: ServerResponse,
  requestId: string,
  model: string,
  workspaceRoot?: string,
  signal?: AbortSignal
): Promise<void> {
  const client = await getAuggieClient(modelId, workspaceRoot);
  const streamHandler = createStreamCallback(res, model, requestId);
  client.onSessionUpdate(streamHandler.callback);
  let caughtError: Error | null = null;

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("Request aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("Request aborted")));
      })
    : null;

  try {
    const p = client.prompt(prompt);
    const response = abortPromise ? await Promise.race([p, abortPromise]) : await p;
    const check = isSDKErrorResponse(response);
    if (check.isError) caughtError = new Error(check.message ?? "SDK error");
  } catch (err) {
    caughtError = err as Error;
  } finally {
    // Flush any remaining buffered reasoning before cleanup
    streamHandler.flush();
    client.onSessionUpdate(null);
    if (caughtError && (caughtError.message === "Request aborted" || isSessionError(caughtError))) {
      discardAuggieClient(modelId, client, workspaceRoot);
    } else {
      releaseAuggieClient(modelId, client, workspaceRoot);
    }
  }
  if (caughtError) throw caughtError;
}

async function callStreaming(
  prompt: string,
  modelId: string,
  res: ServerResponse,
  requestId: string,
  model: string,
  workspaceRoot?: string,
  signal?: AbortSignal
): Promise<void> {
  await withRetry(
    () => callStreamingInternal(prompt, modelId, res, requestId, model, workspaceRoot, signal),
    "Streaming API"
  );
}

async function callNonStreamingInternal(
  prompt: string,
  modelId: string,
  workspaceRoot?: string,
  signal?: AbortSignal
): Promise<string> {
  const client = await getAuggieClient(modelId, workspaceRoot);
  let caughtError: Error | null = null;
  let result = "";

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("Request aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("Request aborted")));
      })
    : null;

  try {
    const p = client.prompt(prompt);
    const response = abortPromise ? await Promise.race([p, abortPromise]) : await p;
    const check = isSDKErrorResponse(response);
    if (check.isError) caughtError = new Error(check.message ?? "SDK error");
    else result = response;
  } catch (err) {
    caughtError = err as Error;
  } finally {
    if (caughtError && (caughtError.message === "Request aborted" || isSessionError(caughtError))) {
      discardAuggieClient(modelId, client, workspaceRoot);
    } else {
      releaseAuggieClient(modelId, client, workspaceRoot);
    }
  }
  if (caughtError) throw caughtError;
  return result;
}

async function callNonStreaming(
  prompt: string,
  modelId: string,
  workspaceRoot?: string,
  signal?: AbortSignal
): Promise<string> {
  return withRetry(
    () => callNonStreamingInternal(prompt, modelId, workspaceRoot, signal),
    "Non-streaming API"
  );
}

// ─── Request Handling ───────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<ChatCompletionRequest> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as ChatCompletionRequest) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = randomUUID().slice(0, 8);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const body = await parseBody(req);

    // Basic validation
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Missing or empty messages array",
            type: "invalid_request_error",
            code: "missing_required_parameter",
          },
        })
      );
      return;
    }

    const messages = body.messages;
    const stream = body.stream ?? false;
    const model = body.model ?? DEFAULT_MODEL;
    const workspaceRoot = extractWorkspaceFromMessages(messages) ?? undefined;
    const prompt = formatMessages(messages);

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      try {
        await callStreaming(
          prompt,
          model,
          res,
          requestId,
          model,
          workspaceRoot,
          abortController.signal
        );
        const stopChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
        };
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
      } catch (err) {
        const classified = classifyError(err as Error);
        res.write(`data: ${JSON.stringify(classified.body)}\n\n`);
      }
      res.end();
    } else {
      const response = await callNonStreaming(
        prompt,
        model,
        workspaceRoot,
        abortController.signal
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(createChatResponse(response, model, prompt)));
    }
  } catch (err) {
    const classified = classifyError(err as Error);
    if (!res.headersSent) {
      res.writeHead(classified.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(classified.body));
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Model Listing ──────────────────────────────────────────────────────────

function getModels() {
  const now = Math.floor(Date.now() / 1000);
  return Object.entries(MODEL_MAP).map(([id, config]) => ({
    id,
    object: "model",
    created: now,
    owned_by: "augment-code",
    permission: [],
    root: id,
    parent: null,
  }));
}

// ─── Server Startup ─────────────────────────────────────────────────────────

export async function startEmbeddedServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  // Guard: if a server is already running, close it first to avoid leaks
  if (serverInstance) {
    debug(`${LOG_PREFIX} Closing previous server instance before starting new one`);
    try {
      serverInstance.close();
    } catch {
      // Ignore close errors on stale instance
    }
    serverInstance = null;
  }

  // Validate credentials: override credentials skip session file check
  if (!overrideCredentials) {
    const sessionCheck = await checkSessionFile();
    if (!sessionCheck.valid) {
      throw new Error(`Cannot start embedded server: ${sessionCheck.message}`);
    }
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`
      );
      const urlPath = url.pathname;

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (urlPath === "/v1/chat/completions" && req.method === "POST") {
        void handleChatCompletions(req, res);
      } else if (urlPath === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: getModels() }));
      } else if (urlPath.startsWith("/v1/models/") && req.method === "GET") {
        const modelId = urlPath.replace("/v1/models/", "");
        const models = getModels();
        const model = models.find((m) => m.id === modelId);
        if (model) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(model));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Model not found" } }));
        }
      } else if (
        urlPath === "/health" ||
        urlPath === "/" ||
        urlPath === "/healthz" ||
        urlPath === "/ready"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            message: "Augment Code embedded server",
            models: Object.keys(MODEL_MAP).length,
            default: DEFAULT_MODEL,
          })
        );
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not found" } }));
      }
    });

    serverInstance = server;

    // Listen on port 0 for OS-assigned free port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      debug(`${LOG_PREFIX} Embedded server started on port ${port}`);

      resolve({
        port,
        close: async () => {
          // Clean up client pools
          for (const key of Object.keys(clientPools)) {
            const pool = clientPools[key];
            if (pool) {
              for (const client of pool.available) {
                void client.close();
              }
              for (const client of pool.inUse) {
                void client.close();
              }
            }
            delete clientPools[key];
          }
          session = null;

          return new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else {
                debug(`${LOG_PREFIX} Embedded server stopped`);
                res();
              }
            });
          });
        },
      });
    });

    server.on("error", reject);
  });
}

