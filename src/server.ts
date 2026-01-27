#!/usr/bin/env node

import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'http';
import http from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import nodePath from 'path';
import os from 'os';
import modelsConfig from './models.json' with { type: 'json' };

// Types
interface ModelConfig {
  auggie: string;
  name: string;
  context: number;
  output: number;
}

interface Session {
  accessToken: string;
  tenantURL: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

// ACP Protocol Types - Session Update Types
type SessionUpdateType =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update';

type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';
type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
type PlanEntryPriority = 'high' | 'medium' | 'low';

interface ContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  description?: string;
  size?: number;
  title?: string;
  resource?: { text?: string; blob?: string; uri: string; mimeType?: string };
  annotations?: { audience?: string[]; lastModified?: string; priority?: number };
  _meta?: Record<string, unknown>;
}

interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal';
  content?: ContentBlock;
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
  _meta?: Record<string, unknown>;
}

interface ToolCallLocation {
  path: string;
  line?: number;
  _meta?: Record<string, unknown>;
}

interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
  _meta?: Record<string, unknown>;
}

interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
  _meta?: Record<string, unknown>;
}

interface SessionUpdate {
  sessionUpdate: SessionUpdateType;
  // For message chunks (user_message_chunk, agent_message_chunk, agent_thought_chunk)
  content?: ContentBlock;
  // For tool_call
  toolCallId?: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  // For tool_call (content array) and tool_call_update
  toolContent?: ToolCallContent[];
  locations?: ToolCallLocation[];
  // For plan
  entries?: PlanEntry[];
  // For available_commands_update
  availableCommands?: AvailableCommand[];
  // For current_mode_update
  currentModeId?: string;
  // Extension point
  _meta?: Record<string, unknown>;
}

interface SessionNotification {
  sessionId?: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown>;
}

interface AuggieClient {
  prompt(message: string): Promise<string>;
  onSessionUpdate(callback: ((notification: SessionNotification) => void) | null): void;
  close(): Promise<void>;
}

interface ClientPool {
  available: AuggieClient[];
  inUse: Set<AuggieClient>;
  creating: number;
}

interface AuggieSDK {
  create: (options: { model?: string; apiKey?: string; apiUrl?: string }) => Promise<AuggieClient>;
}

// Configuration
const PORT = process.env['PORT'] ?? 8765;
const DEBUG = process.env['DEBUG'] === 'true' || process.env['DEBUG'] === '1';
const DEFAULT_MODEL = modelsConfig.defaultModel;
const POOL_SIZE = 5;
const REQUEST_TIMEOUT_MS = parseInt(process.env['REQUEST_TIMEOUT_MS'] ?? '300000', 10); // 5 minutes default
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env['SHUTDOWN_TIMEOUT_MS'] ?? '30000', 10); // 30 seconds default

// Server start time for uptime tracking
const SERVER_START_TIME = Date.now();

// Request metrics
interface RequestMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  activeRequests: number;
  totalLatencyMs: number;
  requestsByModel: Record<string, number>;
  errorsByType: Record<string, number>;
}

const metrics: RequestMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  activeRequests: 0,
  totalLatencyMs: 0,
  requestsByModel: {},
  errorsByType: {},
};

// Active request tracking for cancellation
const activeRequests = new Map<string, AbortController>();

// Structured logging
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function structuredLog(
  level: LogLevel,
  category: string,
  message: string,
  options?: { requestId?: string; data?: unknown; durationMs?: number }
): void {
  if (level === 'debug' && !DEBUG) return;

  // Format for console output
  const prefix = options?.requestId ? `[${options.requestId}]` : '';
  const duration = options?.durationMs !== undefined ? ` (${String(options.durationMs)}ms)` : '';

  switch (level) {
    case 'debug':
      console.log(`[DEBUG] ${prefix} ${category}: ${message}${duration}`);
      if (options?.data) console.log(JSON.stringify(options.data, null, 2));
      break;
    case 'info':
      console.log(`[INFO] ${prefix} ${category}: ${message}${duration}`);
      break;
    case 'warn':
      console.warn(`[WARN] ${prefix} ${category}: ${message}${duration}`);
      break;
    case 'error':
      console.error(`[ERROR] ${prefix} ${category}: ${message}${duration}`);
      if (options?.data) console.error(options.data);
      break;
  }
}

// Debug logging utility (legacy, uses structured logging)
function debugLog(category: string, data: unknown): void {
  structuredLog('debug', category, 'Debug data', { data });
}

// Model mapping: OpenAI-style model name -> Auggie model ID (loaded from JSON)
const MODEL_MAP: Record<string, ModelConfig> = modelsConfig.models;

// State
const clientPools: Record<string, ClientPool> = {};
let AuggieClass: AuggieSDK | null = null;
let session: Session | null = null;
let isShuttingDown = false;

// Retry Configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
} as const;

// Error Types for OpenAI-compatible responses
type OpenAIErrorType = 'invalid_request_error' | 'rate_limit_error' | 'server_error' | 'api_error';
type OpenAIErrorCode =
  | 'context_length_exceeded'
  | 'rate_limit_exceeded'
  | 'server_error'
  | 'invalid_api_key'
  | 'model_not_found'
  | 'request_timeout'
  | 'connection_error'
  | null;

interface OpenAIError {
  error: {
    message: string;
    type: OpenAIErrorType;
    code: OpenAIErrorCode;
    param?: string | null;
    suggestion?: string;
  };
}

interface AugmentAPIError extends Error {
  statusCode?: number;
  code?: string;
  retryable?: boolean;
}

// Error detection utilities
function isRateLimitError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const augmentError = error as AugmentAPIError;
  return (
    augmentError.statusCode === 429 ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too many requests') ||
    message.includes('quota exceeded') ||
    message.includes('throttl')
  );
}

function isContextLengthError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('context length') ||
    message.includes('context_length') ||
    message.includes('token limit') ||
    message.includes('too long') ||
    message.includes('maximum context') ||
    message.includes('message too large') ||
    message.includes('input too long') ||
    message.includes('exceeds the model') ||
    message.includes('max_tokens')
  );
}

function isSessionError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('not connected') ||
    message.includes('no session') ||
    message.includes('initialization failed') ||
    message.includes('session expired') ||
    message.includes('session invalid') ||
    message.includes('websocket') ||
    message.includes('disconnected')
  );
}

function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const augmentError = error as AugmentAPIError;
  const statusCode = augmentError.statusCode ?? 0;

  // 5xx server errors are transient
  if (statusCode >= 500 && statusCode < 600) return true;

  // Session/connection errors from SDK are transient (can retry with new client)
  if (isSessionError(error)) return true;

  // Network-related errors
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('connection') ||
    message.includes('temporarily unavailable') ||
    message.includes('service unavailable') ||
    message.includes('internal server error')
  ) {
    return true;
  }

  return false;
}

function isRetryableError(error: Error): boolean {
  // Context length errors are NOT retryable - need to reduce input
  if (isContextLengthError(error)) return false;

  // Rate limits and transient errors are retryable
  return isRateLimitError(error) || isTransientError(error);
}

function createOpenAIError(error: Error): OpenAIError {
  const errorMsg = error.message.toLowerCase();

  if (isContextLengthError(error)) {
    return {
      error: {
        message: `Context length exceeded: ${error.message}`,
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        param: 'messages',
        suggestion:
          'Reduce the number of messages, shorten message content, or use a model with larger context window.',
      },
    };
  }

  if (isRateLimitError(error)) {
    return {
      error: {
        message: `Rate limit exceeded: ${error.message}`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        param: null,
        suggestion:
          'Wait a moment before retrying. Consider reducing request frequency or implementing exponential backoff.',
      },
    };
  }

  // Session/connection errors from SDK - provide specific guidance
  if (isSessionError(error)) {
    return {
      error: {
        message: `SDK session error: ${error.message}`,
        type: 'server_error',
        code: 'connection_error',
        param: null,
        suggestion:
          'The Augment SDK connection was lost. This is usually temporary. ' +
          'If the issue persists: 1) Run "auggie login" to refresh authentication, ' +
          '2) Restart the server, 3) Check your network connection.',
      },
    };
  }

  if (isTransientError(error)) {
    return {
      error: {
        message: `Server error: ${error.message}`,
        type: 'server_error',
        code: 'server_error',
        param: null,
        suggestion: 'This is likely a temporary issue. Please retry your request in a few seconds.',
      },
    };
  }

  // Authentication errors
  if (errorMsg.includes('unauthorized') || errorMsg.includes('invalid api key')) {
    return {
      error: {
        message: `Authentication failed: ${error.message}`,
        type: 'invalid_request_error',
        code: 'invalid_api_key',
        param: null,
        suggestion:
          'Run "auggie login" to authenticate with Augment Code, then restart the server.',
      },
    };
  }

  // Model not found
  if (
    errorMsg.includes('model') &&
    (errorMsg.includes('not found') || errorMsg.includes('invalid'))
  ) {
    return {
      error: {
        message: `Invalid model: ${error.message}`,
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
        suggestion: `Use GET /v1/models to see available models. Default model: ${DEFAULT_MODEL}`,
      },
    };
  }

  // Timeout error
  if (
    errorMsg.includes('timeout') ||
    errorMsg.includes('timed out') ||
    error.name === 'AbortError'
  ) {
    return {
      error: {
        message: `Request timeout: ${error.message}`,
        type: 'server_error',
        code: 'request_timeout',
        param: null,
        suggestion:
          'The request took too long to process. Try a shorter prompt or increase REQUEST_TIMEOUT_MS.',
      },
    };
  }

  // Connection errors
  if (
    errorMsg.includes('econnrefused') ||
    errorMsg.includes('enotfound') ||
    errorMsg.includes('network')
  ) {
    return {
      error: {
        message: `Connection error: ${error.message}`,
        type: 'server_error',
        code: 'connection_error',
        param: null,
        suggestion: 'Check your network connection and ensure the Augment Code API is reachable.',
      },
    };
  }

  // Generic API error
  return {
    error: {
      message: error.message,
      type: 'api_error',
      code: null,
      param: null,
      suggestion: 'Check the error message for details. If the issue persists, check server logs.',
    },
  };
}

// Sleep utility with jitter
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateRetryDelay(attempt: number): number {
  const baseDelay = Math.min(
    RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
    RETRY_CONFIG.maxDelayMs
  );
  // Add jitter (±10%)
  const jitter = baseDelay * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.floor(baseDelay + jitter);
}

// Retry wrapper for async operations
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  requestId: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Don't retry non-retryable errors
      if (!isRetryableError(lastError)) {
        console.error(
          `[${requestId}] ${operationName} failed with non-retryable error:`,
          lastError.message
        );
        throw lastError;
      }

      // Don't retry on last attempt
      if (attempt === RETRY_CONFIG.maxRetries) {
        console.error(
          `[${requestId}] ${operationName} failed after ${String(RETRY_CONFIG.maxRetries + 1)} attempts:`,
          lastError.message
        );
        throw lastError;
      }

      const delay = calculateRetryDelay(attempt);
      const errorType = isRateLimitError(lastError) ? 'rate_limit' : 'transient';
      console.warn(
        `[${requestId}] ${operationName} failed (${errorType}), attempt ${String(attempt + 1)}/${String(RETRY_CONFIG.maxRetries + 1)}, ` +
          `retrying in ${String(delay)}ms: ${lastError.message}`
      );

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error('Unknown error during retry');
}

async function loadSession(): Promise<Session> {
  if (session) return session;
  const sessionPath = nodePath.join(os.homedir(), '.augment', 'session.json');
  try {
    const data = await fs.readFile(sessionPath, 'utf-8');
    session = JSON.parse(data) as Session;
    return session;
  } catch (err) {
    console.error(`Failed to read session from ${sessionPath}:`, (err as Error).message);
    console.error('Please run "auggie login" first.');
    process.exit(1);
  }
}

// Validate session file exists and has required fields before starting server
async function validateStartup(): Promise<void> {
  const sessionPath = nodePath.join(os.homedir(), '.augment', 'session.json');

  console.log('🔍 Validating startup configuration...');

  // Check session file exists
  try {
    await fs.access(sessionPath);
  } catch {
    console.error(`
╔════════════════════════════════════════════════════════════╗
║  ERROR: Session file not found                             ║
╠════════════════════════════════════════════════════════════╣
║  Expected location: ${sessionPath.padEnd(39)}║
║                                                            ║
║  Please run "auggie login" to authenticate with            ║
║  Augment Code before starting the server.                  ║
╚════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  // Validate session file contents
  try {
    const data = await fs.readFile(sessionPath, 'utf-8');
    const sessionData = JSON.parse(data) as Record<string, unknown>;

    const errors: string[] = [];

    if (!sessionData['accessToken'] || typeof sessionData['accessToken'] !== 'string') {
      errors.push('Missing or invalid "accessToken" field');
    }

    if (!sessionData['tenantURL'] || typeof sessionData['tenantURL'] !== 'string') {
      errors.push('Missing or invalid "tenantURL" field');
    }

    if (errors.length > 0) {
      console.error(`
╔════════════════════════════════════════════════════════════╗
║  ERROR: Invalid session file                               ║
╠════════════════════════════════════════════════════════════╣
${errors.map((e) => `║  • ${e.padEnd(57)}║`).join('\n')}
║                                                            ║
║  Please run "auggie login" to re-authenticate.             ║
╚════════════════════════════════════════════════════════════╝
`);
      process.exit(1);
    }

    // Optionally validate token is not empty
    if ((sessionData['accessToken'] as string).length < 10) {
      console.error(`
╔════════════════════════════════════════════════════════════╗
║  WARNING: Access token appears to be invalid               ║
╠════════════════════════════════════════════════════════════╣
║  The access token is suspiciously short.                   ║
║  Consider running "auggie login" again.                    ║
╚════════════════════════════════════════════════════════════╝
`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`
╔════════════════════════════════════════════════════════════╗
║  ERROR: Session file is not valid JSON                     ║
╠════════════════════════════════════════════════════════════╣
║  The session file appears to be corrupted.                 ║
║  Please run "auggie login" to re-authenticate.             ║
╚════════════════════════════════════════════════════════════╝
`);
      process.exit(1);
    }
    throw err;
  }

  console.log('✅ Session file validated successfully');

  // Validate models configuration
  if (Object.keys(MODEL_MAP).length === 0) {
    console.error('ERROR: No models configured in models.json');
    process.exit(1);
  }

  console.log(`✅ ${String(Object.keys(MODEL_MAP).length)} models configured`);
  console.log(`✅ Default model: ${DEFAULT_MODEL}`);
  console.log('');
}

async function initAuggie(): Promise<void> {
  if (!AuggieClass) {
    const sdk = await import('@augmentcode/auggie-sdk');
    // Cast to our flexible type since SDK types are incomplete for newer models
    AuggieClass = sdk.Auggie as unknown as AuggieSDK;
  }
}

async function createAuggieClient(auggieModel: string): Promise<AuggieClient> {
  await initAuggie();
  if (!AuggieClass) {
    throw new Error('Auggie SDK not initialized');
  }
  const sess = await loadSession();
  debugLog('Creating Auggie Client', { model: auggieModel, apiUrl: sess.tenantURL });
  const client = await AuggieClass.create({
    model: auggieModel,
    apiKey: sess.accessToken,
    apiUrl: sess.tenantURL,
  });
  console.log(`New Auggie client created for model: ${auggieModel}`);
  return client;
}

async function getAuggieClient(modelId: string): Promise<AuggieClient> {
  const modelConfig = MODEL_MAP[modelId] ?? MODEL_MAP[DEFAULT_MODEL];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelId} and default model not configured`);
  }
  const auggieModel = modelConfig.auggie;
  debugLog('getAuggieClient', {
    requestedModel: modelId,
    resolvedAuggieModel: auggieModel,
    usingDefault: !MODEL_MAP[modelId],
  });

  clientPools[auggieModel] ??= { available: [], inUse: new Set(), creating: 0 };

  const pool = clientPools[auggieModel];

  if (pool.available.length > 0) {
    const client = pool.available.pop();
    if (client) {
      pool.inUse.add(client);
      console.log(
        `Reusing client for ${auggieModel} (available: ${String(pool.available.length)}, inUse: ${String(pool.inUse.size)})`
      );
      return client;
    }
  }

  const totalClients = pool.inUse.size + pool.creating;
  if (totalClients < POOL_SIZE) {
    pool.creating++;
    try {
      const client = await createAuggieClient(auggieModel);
      pool.creating--;
      pool.inUse.add(client);
      console.log(
        `Created new client for ${auggieModel} (available: ${String(pool.available.length)}, inUse: ${String(pool.inUse.size)})`
      );
      return client;
    } catch (err) {
      pool.creating--;
      throw err;
    }
  }

  console.log(`Pool at capacity for ${auggieModel}, creating temporary client`);
  return await createAuggieClient(auggieModel);
}

function releaseAuggieClient(modelId: string, client: AuggieClient): void {
  const modelConfig = MODEL_MAP[modelId] ?? MODEL_MAP[DEFAULT_MODEL];
  if (!modelConfig) return;
  const auggieModel = modelConfig.auggie;
  const pool = clientPools[auggieModel];
  if (!pool) return;

  if (pool.inUse.has(client)) {
    pool.inUse.delete(client);
    if (pool.available.length < POOL_SIZE) {
      pool.available.push(client);
      console.log(
        `Client returned to pool for ${auggieModel} (available: ${String(pool.available.length)}, inUse: ${String(pool.inUse.size)})`
      );
    } else {
      void client.close();
      console.log(`Pool full, closed client for ${auggieModel}`);
    }
  }
}

// Discard a client without returning it to the pool (used when client has errors)
function discardAuggieClient(modelId: string, client: AuggieClient): void {
  const modelConfig = MODEL_MAP[modelId] ?? MODEL_MAP[DEFAULT_MODEL];
  if (!modelConfig) return;
  const auggieModel = modelConfig.auggie;
  const pool = clientPools[auggieModel];
  if (!pool) return;

  if (pool.inUse.has(client)) {
    pool.inUse.delete(client);
  }
  // Close the client without returning to pool
  void client.close();
  console.log(`Discarded faulty client for ${auggieModel} (session/connection error)`);
}

function getModels() {
  const now = Math.floor(Date.now() / 1000);
  return Object.entries(MODEL_MAP).map(([id, config]) => ({
    id,
    object: 'model',
    created: now,
    owned_by: 'augment-code',
    permission: [],
    root: id,
    parent: null,
    _auggie_model: config.auggie,
    _display_name: config.name,
  }));
}

function parseBody(req: IncomingMessage): Promise<ChatCompletionRequest> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as ChatCompletionRequest) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Request validation
interface ValidationResult {
  valid: boolean;
  error?: {
    message: string;
    type: string;
    code: string;
    param?: string;
  };
}

// Input type for validation (raw JSON input before type narrowing)
interface RawChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
}

interface RawChatMessage {
  role?: unknown;
  content?: unknown;
}

function validateChatCompletionRequest(body: RawChatCompletionRequest): ValidationResult {
  // Validate messages array
  if (!body.messages) {
    return {
      valid: false,
      error: {
        message: 'Missing required parameter: messages',
        type: 'invalid_request_error',
        code: 'missing_required_parameter',
        param: 'messages',
      },
    };
  }

  if (!Array.isArray(body.messages)) {
    return {
      valid: false,
      error: {
        message: 'messages must be an array',
        type: 'invalid_request_error',
        code: 'invalid_type',
        param: 'messages',
      },
    };
  }

  if (body.messages.length === 0) {
    return {
      valid: false,
      error: {
        message: 'messages array must not be empty',
        type: 'invalid_request_error',
        code: 'invalid_value',
        param: 'messages',
      },
    };
  }

  // Validate each message
  const messages = body.messages as RawChatMessage[];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (!msg.role) {
      return {
        valid: false,
        error: {
          message: `messages[${String(i)}].role is required`,
          type: 'invalid_request_error',
          code: 'missing_required_parameter',
          param: `messages[${String(i)}].role`,
        },
      };
    }

    if (typeof msg.role !== 'string' || !['user', 'assistant', 'system'].includes(msg.role)) {
      return {
        valid: false,
        error: {
          message: `messages[${String(i)}].role must be one of: user, assistant, system`,
          type: 'invalid_request_error',
          code: 'invalid_value',
          param: `messages[${String(i)}].role`,
        },
      };
    }

    if (msg.content === undefined || msg.content === null) {
      return {
        valid: false,
        error: {
          message: `messages[${String(i)}].content is required`,
          type: 'invalid_request_error',
          code: 'missing_required_parameter',
          param: `messages[${String(i)}].content`,
        },
      };
    }

    if (typeof msg.content !== 'string') {
      return {
        valid: false,
        error: {
          message: `messages[${String(i)}].content must be a string`,
          type: 'invalid_request_error',
          code: 'invalid_type',
          param: `messages[${String(i)}].content`,
        },
      };
    }
  }

  // Validate model if provided
  if (body.model !== undefined && typeof body.model !== 'string') {
    return {
      valid: false,
      error: {
        message: 'model must be a string',
        type: 'invalid_request_error',
        code: 'invalid_type',
        param: 'model',
      },
    };
  }

  // Validate stream if provided
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return {
      valid: false,
      error: {
        message: 'stream must be a boolean',
        type: 'invalid_request_error',
        code: 'invalid_type',
        param: 'stream',
      },
    };
  }

  return { valid: true };
}

function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      return `${role}: ${m.content}`;
    })
    .join('\n\n');
}

// Estimate token counts (rough approximation: ~4 chars per token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function createChatResponse(content: string, model: string, promptText?: string) {
  const promptTokens = promptText ? estimateTokens(promptText) : 0;
  const completionTokens = estimateTokens(content);

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    system_fingerprint: `auggie-wrapper-${process.env['npm_package_version'] ?? '1.0.0'}`,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    service_tier: 'default',
  };
}

// System fingerprint for reproducibility tracking
const SYSTEM_FINGERPRINT = `auggie-wrapper-${process.env['npm_package_version'] ?? '1.0.0'}`;

function createStreamChunk(
  content: string,
  model: string,
  isLast = false,
  extraDelta: Record<string, unknown> = {}
): string {
  const chunk = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [
      {
        index: 0,
        delta: isLast ? {} : { content, ...extraDelta },
        finish_reason: isLast ? 'stop' : null,
        logprobs: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Helper to format tool call content for streaming
function formatToolCallContent(toolContent?: ToolCallContent[]): string {
  if (!toolContent || toolContent.length === 0) return '';
  return toolContent
    .map((tc) => {
      if (tc.type === 'content' && tc.content?.type === 'text' && tc.content.text) {
        return tc.content.text;
      }
      if (tc.type === 'diff') {
        return `[File: ${tc.path ?? 'unknown'}]\n${tc.newText ?? ''}`;
      }
      if (tc.type === 'terminal') {
        return `[Terminal: ${tc.terminalId ?? 'unknown'}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Helper to format locations
function formatLocations(locations?: ToolCallLocation[]): string {
  if (!locations || locations.length === 0) return '';
  return locations.map((loc) => `${loc.path}${loc.line ? `:${String(loc.line)}` : ''}`).join(', ');
}

// Track tool call indices for consistent streaming
const toolCallIndices = new Map<string, number>();
let toolCallCounter = 0;

function createStreamCallback(res: ServerResponse, model: string, requestId: string) {
  // Reset tool call tracking for this request
  toolCallIndices.clear();
  toolCallCounter = 0;

  return (notification: SessionNotification): void => {
    const update = notification.update;
    const sessionId = notification.sessionId ?? requestId;
    const timestamp = Math.floor(Date.now() / 1000);

    debugLog(`Stream Update [${requestId}]`, {
      sessionId,
      type: update.sessionUpdate,
      content: update.content,
      title: update.title,
      status: update.status,
      toolCallId: update.toolCallId,
      kind: update.kind,
      rawInput: update.rawInput,
      entries: update.entries,
    });

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // Echo user message chunks (useful for multi-turn visibility)
        if (update.content?.type === 'text' && update.content.text) {
          console.log(`[${requestId}] 👤 User: ${update.content.text.substring(0, 50)}...`);
        }
        break;

      case 'agent_message_chunk':
        if (update.content?.type === 'text' && update.content.text) {
          res.write(createStreamChunk(update.content.text, model));
        }
        break;

      case 'agent_thought_chunk':
        if (update.content?.type === 'text' && update.content.text) {
          const text = update.content.text;
          console.log(
            `[${requestId}] 💭 Thinking: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`
          );
          // Send thinking as extended thinking format (Anthropic-style)
          const thoughtChunk = {
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model,
            system_fingerprint: SYSTEM_FINGERPRINT,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  reasoning_content: text,
                },
                finish_reason: null,
                logprobs: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(thoughtChunk)}\n\n`);
        }
        break;

      case 'tool_call': {
        const toolId = update.toolCallId ?? `call_${randomUUID().slice(0, 8)}`;
        const toolName = update.title ?? 'unknown_tool';
        const toolKind = update.kind ?? 'other';
        const toolStatus = update.status ?? 'pending';
        const rawInput = update.rawInput;

        // Track tool call index
        if (!toolCallIndices.has(toolId)) {
          toolCallIndices.set(toolId, toolCallCounter++);
        }
        const toolIndex = toolCallIndices.get(toolId) ?? 0;

        // Format arguments from rawInput
        const args = rawInput ? JSON.stringify(rawInput) : '';

        console.log(
          `[${requestId}] 🔧 Tool[${String(toolIndex)}]: ${toolName} (${toolKind}) [${toolStatus}]` +
            (args ? ` args=${args.substring(0, 100)}...` : '')
        );

        // Send full tool call with arguments
        const toolChunk = {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: toolId,
                    type: 'function',
                    function: {
                      name: toolName,
                      arguments: args,
                    },
                  },
                ],
                // Include custom metadata for richer info
                tool_metadata: {
                  kind: toolKind,
                  status: toolStatus,
                  locations: formatLocations(update.locations),
                },
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
        break;
      }

      case 'tool_call_update': {
        const toolId = update.toolCallId ?? 'unknown';
        const toolStatus = update.status ?? 'in_progress';
        const toolTitle = update.title;
        const rawOutput = update.rawOutput;
        const toolContent = update.toolContent;
        const locations = update.locations;

        // Get or create tool index
        if (!toolCallIndices.has(toolId)) {
          toolCallIndices.set(toolId, toolCallCounter++);
        }
        const toolIndex = toolCallIndices.get(toolId) ?? 0;

        // Format output content
        const contentText = formatToolCallContent(toolContent);
        const outputText = rawOutput ? JSON.stringify(rawOutput) : contentText;
        const locationsText = formatLocations(locations);

        console.log(
          `[${requestId}] 🔧 Tool[${String(toolIndex)}] Update: ${toolId} [${toolStatus}]` +
            (toolTitle ? ` "${toolTitle}"` : '') +
            (locationsText ? ` @${locationsText}` : '') +
            (outputText ? ` output=${outputText.substring(0, 80)}...` : '')
        );

        // Stream tool update with output/result
        const updateChunk = {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: toolId,
                    type: 'function',
                    function: {
                      name: toolTitle ?? '',
                      // Stream output as additional arguments (result info)
                      arguments: outputText
                        ? JSON.stringify({ _result: outputText.substring(0, 500) })
                        : '',
                    },
                  },
                ],
                tool_metadata: {
                  status: toolStatus,
                  locations: locationsText,
                  has_content: contentText.length > 0,
                  has_output: Boolean(rawOutput),
                },
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(updateChunk)}\n\n`);
        break;
      }

      case 'plan': {
        const entries = update.entries ?? [];
        console.log(`[${requestId}] 📋 Plan: ${String(entries.length)} entries`);
        entries.forEach((entry, i) => {
          const statusIcon =
            entry.status === 'completed' ? '✅' : entry.status === 'in_progress' ? '🔄' : '⏳';
          console.log(`  ${statusIcon} [${String(i + 1)}] ${entry.content} (${entry.priority})`);
        });

        // Stream plan as a special metadata chunk
        const planChunk = {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              delta: {
                // Include plan in custom field
                plan: entries.map((e, i) => ({
                  index: i,
                  content: e.content,
                  status: e.status,
                  priority: e.priority,
                })),
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(planChunk)}\n\n`);
        break;
      }

      case 'available_commands_update': {
        const commands = update.availableCommands ?? [];
        console.log(`[${requestId}] 📜 Commands: ${commands.map((c) => c.name).join(', ')}`);

        // Stream available commands
        const commandsChunk = {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              delta: {
                available_commands: commands.map((c) => ({
                  name: c.name,
                  description: c.description,
                  input_hint: c.input?.hint,
                })),
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(commandsChunk)}\n\n`);
        break;
      }

      case 'current_mode_update': {
        const modeId = update.currentModeId ?? 'unknown';
        console.log(`[${requestId}] 🔀 Mode: ${modeId}`);

        // Stream mode change
        const modeChunk = {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              delta: {
                current_mode: modeId,
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(modeChunk)}\n\n`);
        break;
      }

      default:
        // Log unknown update types for debugging
        console.log(`[${requestId}] ❓ Unknown update: ${String(update.sessionUpdate)}`);
        debugLog(`Unknown Update [${requestId}]`, update);
    }
  };
}

// Check if response is an SDK error (JSON with error field)
function isSDKErrorResponse(response: string): { isError: boolean; message?: string } {
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    const errorField = parsed['error'];
    if (typeof errorField === 'string') {
      return { isError: true, message: errorField };
    }
    if (errorField && typeof errorField === 'object') {
      const errObj = errorField as Record<string, unknown>;
      return { isError: true, message: (errObj['message'] as string) ?? String(errObj) };
    }
  } catch {
    // Not JSON, so not an error response
  }
  return { isError: false };
}

async function callAugmentAPIStreamingInternal(
  prompt: string,
  modelId: string,
  res: ServerResponse,
  requestId: string,
  model: string
): Promise<void> {
  const client = await getAuggieClient(modelId);
  client.onSessionUpdate(createStreamCallback(res, model, requestId));
  let hasError = false;
  let caughtError: Error | null = null;
  try {
    const response = await client.prompt(prompt);
    // Check if SDK returned an error as a response string (can happen even in streaming mode)
    const errorCheck = isSDKErrorResponse(response);
    if (errorCheck.isError) {
      hasError = true;
      caughtError = new Error(errorCheck.message ?? 'Unknown SDK error');
    }
  } catch (err) {
    hasError = true;
    caughtError = err as Error;
  } finally {
    client.onSessionUpdate(null);
    // Discard client on session errors, otherwise return to pool
    if (hasError && caughtError && isSessionError(caughtError)) {
      discardAuggieClient(modelId, client);
    } else {
      releaseAuggieClient(modelId, client);
    }
  }
  if (caughtError) {
    throw caughtError;
  }
}

async function callAugmentAPIStreaming(
  prompt: string,
  modelId: string,
  res: ServerResponse,
  requestId: string,
  model: string
): Promise<void> {
  await withRetry(
    () => callAugmentAPIStreamingInternal(prompt, modelId, res, requestId, model),
    'Augment API Streaming',
    requestId
  );
}

async function callAugmentAPIInternal(prompt: string, modelId: string): Promise<string> {
  const client = await getAuggieClient(modelId);
  let hasError = false;
  let caughtError: Error | null = null;
  let result = '';
  try {
    const response = await client.prompt(prompt);
    // Check if SDK returned an error as a response string
    const errorCheck = isSDKErrorResponse(response);
    if (errorCheck.isError) {
      hasError = true;
      caughtError = new Error(errorCheck.message ?? 'Unknown SDK error');
    } else {
      result = response;
    }
  } catch (err) {
    hasError = true;
    caughtError = err as Error;
  } finally {
    // Discard client on session errors, otherwise return to pool
    if (hasError && caughtError && isSessionError(caughtError)) {
      discardAuggieClient(modelId, client);
    } else {
      releaseAuggieClient(modelId, client);
    }
  }
  if (caughtError) {
    throw caughtError;
  }
  return result;
}

async function callAugmentAPI(prompt: string, modelId: string, requestId: string): Promise<string> {
  return withRetry(() => callAugmentAPIInternal(prompt, modelId), 'Augment API', requestId);
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Propagate X-Request-ID header from client or generate one
  const clientRequestId = req.headers['x-request-id'];
  const requestId =
    typeof clientRequestId === 'string' && clientRequestId.length > 0
      ? clientRequestId.slice(0, 36) // Limit length for safety
      : randomUUID().slice(0, 8);
  const startTime = Date.now();

  // Set request ID in response headers for tracing
  res.setHeader('X-Request-ID', requestId);

  // Track active request
  metrics.totalRequests++;
  metrics.activeRequests++;

  // Create abort controller for cancellation
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);

  // Set up request timeout
  const timeoutId = setTimeout(() => {
    structuredLog('warn', 'Request', 'Request timeout', {
      requestId,
      durationMs: REQUEST_TIMEOUT_MS,
    });
    abortController.abort();
  }, REQUEST_TIMEOUT_MS);

  // Handle client disconnect
  req.on('close', () => {
    if (!res.writableEnded) {
      structuredLog('info', 'Request', 'Client disconnected', { requestId });
      abortController.abort();
    }
  });

  const cleanup = (success: boolean, errorType?: string) => {
    clearTimeout(timeoutId);
    activeRequests.delete(requestId);
    metrics.activeRequests--;

    const durationMs = Date.now() - startTime;
    metrics.totalLatencyMs += durationMs;

    if (success) {
      metrics.successfulRequests++;
    } else {
      metrics.failedRequests++;
      if (errorType) {
        metrics.errorsByType[errorType] = (metrics.errorsByType[errorType] ?? 0) + 1;
      }
    }
  };

  try {
    // Check if server is shutting down
    if (isShuttingDown) {
      cleanup(false, 'server_shutdown');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'Server is shutting down', type: 'server_error' } })
      );
      return;
    }

    const body = await parseBody(req);
    structuredLog('debug', 'Request', 'Received request', { requestId, data: body });

    // Validate request
    const validation = validateChatCompletionRequest(body);
    if (!validation.valid) {
      cleanup(false, 'validation_error');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const messages = body.messages ?? [];
    const stream = body.stream ?? false;
    const model = body.model ?? DEFAULT_MODEL;

    // Track model usage
    metrics.requestsByModel[model] = (metrics.requestsByModel[model] ?? 0) + 1;

    if (!MODEL_MAP[model]) {
      structuredLog(
        'warn',
        'Request',
        `Unknown model "${model}", using default: ${DEFAULT_MODEL}`,
        { requestId }
      );
    }

    const prompt = formatMessages(messages);
    structuredLog('info', 'Request', `Processing request`, {
      requestId,
      data: { model, stream, messageCount: messages.length },
    });

    // Check for abort before making API call
    if (abortController.signal.aborted) {
      cleanup(false, 'aborted');
      return;
    }

    if (stream) {
      // Disable response buffering for real-time streaming
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
        'X-Request-Id': requestId,
      });
      // Flush headers immediately
      res.flushHeaders();

      try {
        await callAugmentAPIStreaming(prompt, model, res, requestId, model);
        res.write(createStreamChunk('', model, true));
        res.write('data: [DONE]\n\n');
        cleanup(true);
      } catch (err) {
        const error = err as Error;
        structuredLog('error', 'Request', 'Streaming error', { requestId, data: error.message });
        // Send OpenAI-compatible error in stream format
        const openAIError = createOpenAIError(error);
        res.write(`data: ${JSON.stringify(openAIError)}\n\n`);
        cleanup(false, error.name);
      }
      res.end();
    } else {
      const response = await callAugmentAPI(prompt, model, requestId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatResponse(response, model, prompt)));
      cleanup(true);
      structuredLog('info', 'Request', 'Request completed', {
        requestId,
        durationMs: Date.now() - startTime,
      });
    }
  } catch (err) {
    const error = err as Error;
    structuredLog('error', 'Request', 'Request error', { requestId, data: error.message });

    // Create OpenAI-compatible error response
    const openAIError = createOpenAIError(error);

    // Use appropriate HTTP status code
    let statusCode = 500;
    let errorType = 'unknown_error';
    if (isContextLengthError(error)) {
      statusCode = 400; // Bad request for context length errors
      errorType = 'context_length_exceeded';
    } else if (isRateLimitError(error)) {
      statusCode = 429; // Too Many Requests
      errorType = 'rate_limit_exceeded';
    }

    cleanup(false, errorType);

    if (!res.headersSent) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openAIError));
    }
  }
}

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: getModels() }));
}

function handleModel(_req: IncomingMessage, res: ServerResponse, modelId: string): void {
  const models = getModels();
  const model = models.find((m) => m.id === modelId);
  if (model) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(model));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Model not found' } }));
  }
}

// Enhanced health check with detailed status
interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  message: string;
  timestamp: string;
  uptime: {
    seconds: number;
    formatted: string;
  };
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    activeRequests: number;
    averageLatencyMs: number;
    successRate: string;
  };
  models: {
    available: string[];
    default: string;
  };
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
  };
  config: {
    requestTimeoutMs: number;
    shutdownTimeoutMs: number;
    poolSize: number;
  };
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  parts.push(`${String(secs)}s`);

  return parts.join(' ');
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const uptimeSeconds = (Date.now() - SERVER_START_TIME) / 1000;
  const memoryUsage = process.memoryUsage();
  const avgLatency = metrics.totalRequests > 0 ? metrics.totalLatencyMs / metrics.totalRequests : 0;
  const successRate =
    metrics.totalRequests > 0
      ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
      : '100.00';

  // Determine health status
  let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';
  let message = 'Auggie Wrapper is running';

  if (isShuttingDown) {
    status = 'unhealthy';
    message = 'Server is shutting down';
  } else if (metrics.activeRequests > POOL_SIZE * Object.keys(MODEL_MAP).length) {
    status = 'degraded';
    message = 'High request load';
  } else if (parseFloat(successRate) < 90 && metrics.totalRequests > 10) {
    status = 'degraded';
    message = 'High error rate detected';
  }

  const healthStatus: HealthStatus = {
    status,
    message,
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: Math.floor(uptimeSeconds),
      formatted: formatUptime(uptimeSeconds),
    },
    metrics: {
      totalRequests: metrics.totalRequests,
      successfulRequests: metrics.successfulRequests,
      failedRequests: metrics.failedRequests,
      activeRequests: metrics.activeRequests,
      averageLatencyMs: Math.round(avgLatency),
      successRate: `${successRate}%`,
    },
    models: {
      available: Object.keys(MODEL_MAP),
      default: DEFAULT_MODEL,
    },
    memory: {
      heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memoryUsage.rss / 1024 / 1024),
    },
    config: {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      poolSize: POOL_SIZE,
    },
  };

  const httpStatus = status === 'unhealthy' ? 503 : 200;
  res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(healthStatus, null, 2));
}

// Simple health check for load balancers (just returns 200 OK if running)
function handleHealthSimple(_req: IncomingMessage, res: ServerResponse): void {
  if (isShuttingDown) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'shutting_down' }));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }
}

// Version endpoint - returns server version and runtime info
function handleVersion(_req: IncomingMessage, res: ServerResponse): void {
  const version = {
    name: 'auggie-wrapper',
    version: modelsConfig.version,
    description: 'OpenAI-compatible API proxy for Augment Code',
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    api: {
      openaiCompatible: true,
      version: 'v1',
      defaultModel: DEFAULT_MODEL,
      availableModels: Object.keys(MODEL_MAP),
    },
    config: {
      port: PORT,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      maxPoolSize: POOL_SIZE,
      debug: DEBUG,
    },
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(version, null, 2));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const urlPath = url.pathname;

  structuredLog('info', 'HTTP', `${req.method ?? 'UNKNOWN'} ${urlPath}`);

  if (urlPath === '/v1/chat/completions' && req.method === 'POST') {
    void handleChatCompletions(req, res);
  } else if (urlPath === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
  } else if (urlPath.startsWith('/v1/models/') && req.method === 'GET') {
    const modelId = urlPath.replace('/v1/models/', '');
    handleModel(req, res, modelId);
  } else if (urlPath === '/health') {
    // Detailed health check
    handleHealth(req, res);
  } else if (urlPath === '/' || urlPath === '/healthz' || urlPath === '/ready') {
    // Simple health check for load balancers
    handleHealthSimple(req, res);
  } else if (urlPath === '/version') {
    // Version endpoint
    handleVersion(req, res);
  } else if (urlPath === '/metrics') {
    // Metrics endpoint
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ...metrics,
          averageLatencyMs:
            metrics.totalRequests > 0
              ? Math.round(metrics.totalLatencyMs / metrics.totalRequests)
              : 0,
        },
        null,
        2
      )
    );
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
});

// Configure keep-alive for better performance
// Keep connections alive for 60 seconds (default is 5 seconds in Node.js)
server.keepAliveTimeout = 60000;
// Ensure headers timeout is greater than keep-alive timeout
server.headersTimeout = 65000;

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    structuredLog('warn', 'Shutdown', 'Shutdown already in progress, ignoring signal', {
      data: signal,
    });
    return;
  }

  isShuttingDown = true;
  structuredLog('info', 'Shutdown', `Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    structuredLog('info', 'Shutdown', 'Server closed, no longer accepting new connections');
  });

  // Wait for active requests to complete (with timeout)
  const shutdownStart = Date.now();
  const checkInterval = 100; // Check every 100ms

  while (metrics.activeRequests > 0) {
    const elapsed = Date.now() - shutdownStart;
    if (elapsed >= SHUTDOWN_TIMEOUT_MS) {
      structuredLog(
        'warn',
        'Shutdown',
        `Timeout reached with ${String(metrics.activeRequests)} active requests, forcing shutdown`
      );
      // Cancel remaining requests
      for (const [requestId, controller] of activeRequests) {
        structuredLog('info', 'Shutdown', `Cancelling request ${requestId}`);
        controller.abort();
      }
      break;
    }

    structuredLog(
      'info',
      'Shutdown',
      `Waiting for ${String(metrics.activeRequests)} active requests to complete...`
    );
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  // Clean up client pools
  structuredLog('info', 'Shutdown', 'Cleaning up client pools...');
  // Clear all pools by reassigning each key to undefined (avoids dynamic delete)
  for (const poolName of Object.keys(clientPools)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete clientPools[poolName];
  }

  structuredLog('info', 'Shutdown', 'Graceful shutdown complete');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  structuredLog('error', 'Process', 'Uncaught exception', { data: error.message });
  void gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  structuredLog('error', 'Process', 'Unhandled rejection', { data: reason });
});

// Start server with validation
async function startServer(): Promise<void> {
  // Validate configuration before starting
  await validateStartup();

  server.listen(PORT, () => {
    structuredLog('info', 'Startup', `Server started on port ${String(PORT)}`);
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Auggie Wrapper - OpenAI API Proxy                ║
╠════════════════════════════════════════════════════════════╣
║  Proxying OpenAI-compatible requests to Claude models      ║
║  via Augment Code SDK                                      ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${String(PORT).padEnd(22)}║
║  Default model:     ${DEFAULT_MODEL.padEnd(39)}║
╠════════════════════════════════════════════════════════════╣
║  Available models:                                         ║
${Object.entries(MODEL_MAP)
  .map(([id]) => `║    - ${id.padEnd(54)}║`)
  .join('\n')}
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║    POST /v1/chat/completions - Chat completions            ║
║    GET  /v1/models           - List models                 ║
║    GET  /health              - Detailed health check       ║
║    GET  /version             - Server version info         ║
║    GET  /metrics             - Request metrics             ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}

// Start the server
void startServer();
