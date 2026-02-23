import type { AugmentAPIError, OpenAIError } from './types.js';

// Default model for error messages - will be overridden by server config
let defaultModel = 'claude-opus-4-6';

export function setDefaultModel(model: string): void {
  defaultModel = model;
}

export function isRateLimitError(error: Error): boolean {
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

export function isContextLengthError(error: Error): boolean {
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

export function isSessionError(error: Error): boolean {
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

export function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const augmentError = error as AugmentAPIError;
  const statusCode = augmentError.statusCode ?? 0;

  if (statusCode >= 500 && statusCode < 600) return true;
  if (isSessionError(error)) return true;

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

export function isRetryableError(error: Error): boolean {
  if (isContextLengthError(error)) return false;
  return isRateLimitError(error) || isTransientError(error);
}

export function createOpenAIError(error: Error): OpenAIError {
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
        suggestion: `Use GET /v1/models to see available models. Default model: ${defaultModel}`,
      },
    };
  }

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
