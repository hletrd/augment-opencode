import { describe, it, expect } from 'vitest';
import {
  isRateLimitError,
  isContextLengthError,
  isSessionError,
  isTransientError,
  isRetryableError,
  createOpenAIError,
} from '../../src/errors.js';

// Helper to create an Error with statusCode
function createAugmentError(message: string, statusCode?: number): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  if (statusCode !== undefined) {
    error.statusCode = statusCode;
  }
  return error;
}

describe('isRateLimitError', () => {
  it('should detect 429 status code', () => {
    expect(isRateLimitError(createAugmentError('error', 429))).toBe(true);
  });

  it('should detect "rate limit" in message', () => {
    expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
  });

  it('should detect "rate_limit" in message', () => {
    expect(isRateLimitError(new Error('rate_limit_exceeded'))).toBe(true);
  });

  it('should detect "too many requests"', () => {
    expect(isRateLimitError(new Error('Too many requests'))).toBe(true);
  });

  it('should detect "quota exceeded"', () => {
    expect(isRateLimitError(new Error('Quota exceeded'))).toBe(true);
  });

  it('should detect "throttl"', () => {
    expect(isRateLimitError(new Error('Request throttled'))).toBe(true);
  });

  it('should return false for regular errors', () => {
    expect(isRateLimitError(new Error('Something went wrong'))).toBe(false);
  });
});

describe('isContextLengthError', () => {
  it('should detect "context length"', () => {
    expect(isContextLengthError(new Error('Context length exceeded'))).toBe(true);
  });

  it('should detect "context_length"', () => {
    expect(isContextLengthError(new Error('context_length_exceeded'))).toBe(true);
  });

  it('should detect "token limit"', () => {
    expect(isContextLengthError(new Error('Token limit reached'))).toBe(true);
  });

  it('should detect "too long"', () => {
    expect(isContextLengthError(new Error('Input too long'))).toBe(true);
  });

  it('should detect "maximum context"', () => {
    expect(isContextLengthError(new Error('Exceeds maximum context'))).toBe(true);
  });

  it('should detect "message too large"', () => {
    expect(isContextLengthError(new Error('Message too large'))).toBe(true);
  });

  it('should detect "exceeds the model"', () => {
    expect(isContextLengthError(new Error('Input exceeds the model limit'))).toBe(true);
  });

  it('should detect "max_tokens"', () => {
    expect(isContextLengthError(new Error('max_tokens exceeded'))).toBe(true);
  });

  it('should return false for regular errors', () => {
    expect(isContextLengthError(new Error('Network error'))).toBe(false);
  });
});

describe('isSessionError', () => {
  it('should detect "not connected"', () => {
    expect(isSessionError(new Error('Client not connected'))).toBe(true);
  });

  it('should detect "no session"', () => {
    expect(isSessionError(new Error('No session available'))).toBe(true);
  });

  it('should detect "initialization failed"', () => {
    expect(isSessionError(new Error('Initialization failed'))).toBe(true);
  });

  it('should detect "session expired"', () => {
    expect(isSessionError(new Error('Session expired'))).toBe(true);
  });

  it('should detect "websocket"', () => {
    expect(isSessionError(new Error('WebSocket connection closed'))).toBe(true);
  });

  it('should detect "disconnected"', () => {
    expect(isSessionError(new Error('Client disconnected'))).toBe(true);
  });

  it('should return false for regular errors', () => {
    expect(isSessionError(new Error('Bad request'))).toBe(false);
  });
});

describe('isTransientError', () => {
  it('should detect 5xx status codes', () => {
    expect(isTransientError(createAugmentError('error', 500))).toBe(true);
    expect(isTransientError(createAugmentError('error', 502))).toBe(true);
    expect(isTransientError(createAugmentError('error', 503))).toBe(true);
  });

  it('should treat session errors as transient', () => {
    expect(isTransientError(new Error('Client disconnected'))).toBe(true);
  });

  it('should detect network errors', () => {
    expect(isTransientError(new Error('Network error'))).toBe(true);
  });

  it('should detect timeout errors', () => {
    expect(isTransientError(new Error('Request timed out'))).toBe(true);
  });

  it('should detect econnreset', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });

  it('should detect socket hang up', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('should detect service unavailable', () => {
    expect(isTransientError(new Error('Service unavailable'))).toBe(true);
  });

  it('should return false for client errors', () => {
    expect(isTransientError(createAugmentError('bad request', 400))).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('should return true for rate limit errors', () => {
    expect(isRetryableError(createAugmentError('rate limit', 429))).toBe(true);
  });

  it('should return true for transient errors', () => {
    expect(isRetryableError(createAugmentError('error', 500))).toBe(true);
  });

  it('should return false for context length errors', () => {
    expect(isRetryableError(new Error('Context length exceeded'))).toBe(false);
  });

  it('should return false for regular errors', () => {
    expect(isRetryableError(new Error('Invalid request'))).toBe(false);
  });
});

describe('createOpenAIError', () => {
  it('should create context length error', () => {
    const result = createOpenAIError(new Error('Context length exceeded'));
    expect(result.error.type).toBe('invalid_request_error');
    expect(result.error.code).toBe('context_length_exceeded');
    expect(result.error.param).toBe('messages');
  });

  it('should create rate limit error', () => {
    const result = createOpenAIError(createAugmentError('Rate limit exceeded', 429));
    expect(result.error.type).toBe('rate_limit_error');
    expect(result.error.code).toBe('rate_limit_exceeded');
  });

  it('should create session error', () => {
    const result = createOpenAIError(new Error('Client not connected'));
    expect(result.error.type).toBe('server_error');
    expect(result.error.code).toBe('connection_error');
  });

  it('should create transient error', () => {
    const result = createOpenAIError(createAugmentError('Internal server error', 500));
    expect(result.error.type).toBe('server_error');
    expect(result.error.code).toBe('server_error');
  });

  it('should create auth error for "unauthorized"', () => {
    const result = createOpenAIError(new Error('Unauthorized access'));
    expect(result.error.type).toBe('invalid_request_error');
    expect(result.error.code).toBe('invalid_api_key');
  });

  it('should create model not found error', () => {
    const result = createOpenAIError(new Error('Model not found: bad-model'));
    expect(result.error.type).toBe('invalid_request_error');
    expect(result.error.code).toBe('model_not_found');
    expect(result.error.param).toBe('model');
  });

  it('should create timeout error for AbortError', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    const result = createOpenAIError(error);
    expect(result.error.code).toBe('request_timeout');
  });

  it('should create generic error for unknown errors', () => {
    const result = createOpenAIError(new Error('Something unknown happened'));
    expect(result.error.type).toBe('api_error');
    expect(result.error.code).toBeNull();
  });

  it('should always include suggestion field', () => {
    const result = createOpenAIError(new Error('Any error'));
    expect(result.error.suggestion).toBeDefined();
    expect(typeof result.error.suggestion).toBe('string');
  });
});
