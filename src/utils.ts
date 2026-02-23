import type { ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type {
  ChatMessage,
  ToolCallContent,
  ToolCallLocation,
  ValidationResult,
  RawChatCompletionRequest,
  RawChatMessage,
} from './types.js';

// Retry configuration (can be overridden for testing)
export const RETRY_CONFIG = {
  maxRetries: 30,
  initialDelayMs: 5000,
  maxDelayMs: 600000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
} as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateRetryDelay(attempt: number): number {
  const baseDelay = Math.min(
    RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
    RETRY_CONFIG.maxDelayMs
  );
  const jitter = baseDelay * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.floor(baseDelay + jitter);
}

export function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      let role: string;
      switch (m.role) {
        case 'assistant':
          role = 'Assistant';
          break;
        case 'system':
          role = 'System';
          break;
        case 'tool':
          role = 'Tool Result';
          break;
        case 'function':
          role = 'Function Result';
          break;
        default:
          role = 'User';
      }
      return `${role}: ${m.content}`;
    })
    .join('\n\n');
}

export function extractWorkspaceFromMessages(messages: ChatMessage[]): string | null {
  for (const msg of messages) {
    if (msg.role === 'system' && msg.content) {
      const supervisorMatch = msg.content.match(
        /<supervisor>[^<]*?(?:workspace is opened at|workspace is)\s+[`"']?([^`"'<\n]+)[`"']?/i
      );
      if (supervisorMatch?.[1]) {
        return supervisorMatch[1].trim().replace(/\.$/, '');
      }

      const workspaceMatch = msg.content.match(/(?:workspace|working directory|cwd):\s*[`"']?([^\s`"'\n]+)/i);
      if (workspaceMatch?.[1]) {
        return workspaceMatch[1].trim();
      }
    }
  }
  return null;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createChatResponse(content: string, model: string, defaultModel: string, promptText?: string) {
  const promptTokens = promptText ? estimateTokens(promptText) : 0;
  const completionTokens = estimateTokens(content);

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || defaultModel,
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

export function formatUptime(seconds: number): string {
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

export function getPoolKey(auggieModel: string, workspaceRoot?: string): string {
  const workspace = workspaceRoot ?? process.cwd();
  return `${auggieModel}:${workspace}`;
}

export function isSDKErrorResponse(response: string): { isError: boolean; message?: string } {
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

export function formatToolCallContent(toolContent?: ToolCallContent[]): string {
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

export function formatLocations(locations?: ToolCallLocation[]): string {
  if (!locations || locations.length === 0) return '';
  return locations.map((loc) => `${loc.path}${loc.line ? `:${String(loc.line)}` : ''}`).join(', ');
}

export function safeWrite(res: ServerResponse, data: string): boolean {
  if (!res.destroyed && res.writable) {
    return res.write(data);
  }
  return false;
}

export function validateChatCompletionRequest(body: RawChatCompletionRequest): ValidationResult {
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

    const validRoles = ['user', 'assistant', 'system', 'tool', 'function'];
    if (typeof msg.role !== 'string' || !validRoles.includes(msg.role)) {
      return {
        valid: false,
        error: {
          message: `messages[${String(i)}].role must be one of: ${validRoles.join(', ')}`,
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
