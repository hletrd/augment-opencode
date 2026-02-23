// Model and session types
export interface ModelConfig {
  auggie: string;
  name: string;
  context: number;
  output: number;
}

export interface Session {
  accessToken: string;
  tenantURL: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'function';
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  workspaceRoot?: string;
}

// ACP Protocol Types
export type SessionUpdateType =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ToolKind =
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
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type PlanEntryPriority = 'high' | 'medium' | 'low';

export interface ContentBlock {
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

export interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal';
  content?: ContentBlock;
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
  _meta?: Record<string, unknown>;
}

export interface ToolCallLocation {
  path: string;
  line?: number;
  _meta?: Record<string, unknown>;
}

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
  _meta?: Record<string, unknown>;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
  _meta?: Record<string, unknown>;
}

export interface SessionUpdate {
  sessionUpdate: SessionUpdateType;
  content?: ContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  toolContent?: ToolCallContent[];
  locations?: ToolCallLocation[];
  entries?: PlanEntry[];
  availableCommands?: AvailableCommand[];
  currentModeId?: string;
  _meta?: Record<string, unknown>;
}

export interface SessionNotification {
  sessionId?: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown>;
}

export interface AuggieClient {
  prompt(message: string): Promise<string>;
  onSessionUpdate(callback: ((notification: SessionNotification) => void) | null): void;
  close(): Promise<void>;
}

export interface ClientPool {
  available: AuggieClient[];
  inUse: Set<AuggieClient>;
  creating: number;
}

export interface AuggieSDK {
  create: (options: { model?: string; apiKey?: string; apiUrl?: string; workspaceRoot?: string; allowIndexing?: boolean }) => Promise<AuggieClient>;
}

// Request metrics
export interface RequestMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  activeRequests: number;
  totalLatencyMs: number;
  requestsByModel: Record<string, number>;
  errorsByType: Record<string, number>;
}

// Logging
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Error types
export type OpenAIErrorType = 'invalid_request_error' | 'rate_limit_error' | 'server_error' | 'api_error';
export type OpenAIErrorCode =
  | 'context_length_exceeded'
  | 'rate_limit_exceeded'
  | 'server_error'
  | 'invalid_api_key'
  | 'model_not_found'
  | 'request_timeout'
  | 'connection_error'
  | null;

export interface OpenAIError {
  error: {
    message: string;
    type: OpenAIErrorType;
    code: OpenAIErrorCode;
    param?: string | null;
    suggestion?: string;
  };
}

export interface AugmentAPIError extends Error {
  statusCode?: number;
  code?: string;
  retryable?: boolean;
}

// Validation
export interface ValidationResult {
  valid: boolean;
  error?: {
    message: string;
    type: string;
    code: string;
    param?: string;
  };
}

export interface RawChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
}

export interface RawChatMessage {
  role?: unknown;
  content?: unknown;
}

// Health
export interface HealthStatus {
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

// Stream callback
export interface StreamCallbackResult {
  callback: (notification: SessionNotification) => void;
}
