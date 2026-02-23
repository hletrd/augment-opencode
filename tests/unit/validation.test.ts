import { describe, it, expect } from 'vitest';
import { validateChatCompletionRequest } from '../../src/utils.js';

describe('validateChatCompletionRequest', () => {
  it('should accept valid request with user message', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.valid).toBe(true);
  });

  it('should accept valid request with all roles', () => {
    const result = validateChatCompletionRequest({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'tool', content: 'result' },
        { role: 'function', content: 'output' },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('should accept request with model and stream', () => {
    const result = validateChatCompletionRequest({
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(result.valid).toBe(true);
  });

  it('should reject missing messages', () => {
    const result = validateChatCompletionRequest({});
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('missing_required_parameter');
    expect(result.error?.param).toBe('messages');
  });

  it('should reject non-array messages', () => {
    const result = validateChatCompletionRequest({ messages: 'not an array' });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('invalid_type');
  });

  it('should reject empty messages array', () => {
    const result = validateChatCompletionRequest({ messages: [] });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('invalid_value');
  });

  it('should reject message without role', () => {
    const result = validateChatCompletionRequest({
      messages: [{ content: 'Hello' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('missing_required_parameter');
    expect(result.error?.param).toBe('messages[0].role');
  });

  it('should reject invalid role', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'invalid_role', content: 'Hello' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('invalid_value');
  });

  it('should reject message without content', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'user' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('missing_required_parameter');
  });

  it('should reject null content', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'user', content: null }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('missing_required_parameter');
  });

  it('should reject non-string content', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'user', content: 123 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('invalid_type');
  });

  it('should reject non-string model', () => {
    const result = validateChatCompletionRequest({
      model: 123,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.param).toBe('model');
  });

  it('should reject non-boolean stream', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'user', content: 'Hi' }],
      stream: 'true',
    });
    expect(result.valid).toBe(false);
    expect(result.error?.param).toBe('stream');
  });

  it('should validate second message in array', () => {
    const result = validateChatCompletionRequest({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'bad', content: 'Hello' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.param).toBe('messages[1].role');
  });

  it('should accept undefined model and stream', () => {
    const result = validateChatCompletionRequest({
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(result.valid).toBe(true);
  });
});
