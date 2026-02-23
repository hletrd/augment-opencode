import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatMessages,
  estimateTokens,
  extractWorkspaceFromMessages,
  createChatResponse,
  formatUptime,
  calculateRetryDelay,
  getPoolKey,
  isSDKErrorResponse,
  formatToolCallContent,
  formatLocations,
  safeWrite,
  sleep,
  RETRY_CONFIG,
} from '../../src/utils.js';
import type { ChatMessage, ToolCallContent, ToolCallLocation } from '../../src/types.js';

describe('formatMessages', () => {
  it('should map user role correctly', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    expect(formatMessages(messages)).toBe('User: Hello');
  });

  it('should map assistant role correctly', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'Hi there' }];
    expect(formatMessages(messages)).toBe('Assistant: Hi there');
  });

  it('should map system role correctly', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'You are helpful' }];
    expect(formatMessages(messages)).toBe('System: You are helpful');
  });

  it('should map tool role correctly', () => {
    const messages: ChatMessage[] = [{ role: 'tool', content: 'result' }];
    expect(formatMessages(messages)).toBe('Tool Result: result');
  });

  it('should map function role correctly', () => {
    const messages: ChatMessage[] = [{ role: 'function', content: 'output' }];
    expect(formatMessages(messages)).toBe('Function Result: output');
  });

  it('should join multiple messages with double newlines', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    expect(formatMessages(messages)).toBe('User: Hello\n\nAssistant: Hi');
  });

  it('should handle empty messages array', () => {
    expect(formatMessages([])).toBe('');
  });
});

describe('estimateTokens', () => {
  it('should return ceil(length/4) for simple text', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('should ceil for non-divisible lengths', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should handle longer strings', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });
});

describe('extractWorkspaceFromMessages', () => {
  it('should extract workspace from supervisor tag with "workspace is opened at"', () => {
    const messages: ChatMessage[] = [{
      role: 'system',
      content: '<supervisor>The user\'s workspace is opened at /home/user/project.</supervisor>',
    }];
    expect(extractWorkspaceFromMessages(messages)).toBe('/home/user/project');
  });

  it('should extract workspace from workspace: pattern', () => {
    const messages: ChatMessage[] = [{
      role: 'system',
      content: 'workspace: /home/user/project',
    }];
    expect(extractWorkspaceFromMessages(messages)).toBe('/home/user/project');
  });

  it('should extract workspace from working directory: pattern', () => {
    const messages: ChatMessage[] = [{
      role: 'system',
      content: 'working directory: /tmp/test',
    }];
    expect(extractWorkspaceFromMessages(messages)).toBe('/tmp/test');
  });

  it('should extract workspace from cwd: pattern', () => {
    const messages: ChatMessage[] = [{
      role: 'system',
      content: 'cwd: /var/app',
    }];
    expect(extractWorkspaceFromMessages(messages)).toBe('/var/app');
  });

  it('should return null when no workspace found', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    expect(extractWorkspaceFromMessages(messages)).toBeNull();
  });

  it('should return null for empty messages', () => {
    expect(extractWorkspaceFromMessages([])).toBeNull();
  });

  it('should only check system messages', () => {
    const messages: ChatMessage[] = [{
      role: 'user',
      content: 'workspace: /home/user/project',
    }];
    expect(extractWorkspaceFromMessages(messages)).toBeNull();
  });
});

describe('createChatResponse', () => {
  it('should return valid OpenAI chat completion structure', () => {
    const response = createChatResponse('Hello', 'test-model', 'default-model');
    expect(response.object).toBe('chat.completion');
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0]!.message.role).toBe('assistant');
    expect(response.choices[0]!.message.content).toBe('Hello');
    expect(response.choices[0]!.finish_reason).toBe('stop');
  });

  it('should use provided model', () => {
    const response = createChatResponse('Hi', 'my-model', 'default');
    expect(response.model).toBe('my-model');
  });

  it('should fall back to default model when model is empty', () => {
    const response = createChatResponse('Hi', '', 'default-model');
    expect(response.model).toBe('default-model');
  });

  it('should estimate tokens correctly', () => {
    const response = createChatResponse('Hello', 'model', 'default', 'prompt text');
    expect(response.usage.prompt_tokens).toBe(estimateTokens('prompt text'));
    expect(response.usage.completion_tokens).toBe(estimateTokens('Hello'));
    expect(response.usage.total_tokens).toBe(
      response.usage.prompt_tokens + response.usage.completion_tokens
    );
  });

  it('should have zero prompt tokens when no prompt provided', () => {
    const response = createChatResponse('Hi', 'model', 'default');
    expect(response.usage.prompt_tokens).toBe(0);
  });

  it('should have a unique id prefixed with chatcmpl-', () => {
    const r1 = createChatResponse('a', 'm', 'd');
    const r2 = createChatResponse('a', 'm', 'd');
    expect(r1.id).not.toBe(r2.id);
    expect(r1.id).toMatch(/^chatcmpl-/);
  });
});

describe('formatUptime', () => {
  it('should format seconds only', () => {
    expect(formatUptime(45)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatUptime(125)).toBe('2m 5s');
  });

  it('should format hours, minutes, seconds', () => {
    expect(formatUptime(3661)).toBe('1h 1m 1s');
  });

  it('should format days', () => {
    expect(formatUptime(90061)).toBe('1d 1h 1m 1s');
  });

  it('should handle zero', () => {
    expect(formatUptime(0)).toBe('0s');
  });
});

describe('calculateRetryDelay', () => {
  it('should return a number for attempt 0', () => {
    const delay = calculateRetryDelay(0);
    expect(typeof delay).toBe('number');
    expect(delay).toBeGreaterThan(0);
  });

  it('should increase with higher attempts on average', () => {
    const sample = (attempt: number) =>
      Array.from({ length: 100 }, () => calculateRetryDelay(attempt)).reduce((a, b) => a + b, 0) / 100;

    const avg0 = sample(0);
    const avg3 = sample(3);
    expect(avg3).toBeGreaterThan(avg0);
  });

  it('should cap near maxDelayMs with high jitter allowance', () => {
    const delay = calculateRetryDelay(100);
    const maxWithJitter = RETRY_CONFIG.maxDelayMs * (1 + RETRY_CONFIG.jitterFactor);
    expect(delay).toBeLessThanOrEqual(maxWithJitter);
  });

  it('should stay within jitter range of base delay for attempt 0', () => {
    const base = RETRY_CONFIG.initialDelayMs;
    const jitterRange = base * RETRY_CONFIG.jitterFactor;
    for (let i = 0; i < 20; i++) {
      const delay = calculateRetryDelay(0);
      expect(delay).toBeGreaterThanOrEqual(base - jitterRange);
      expect(delay).toBeLessThanOrEqual(base + jitterRange);
    }
  });
});

describe('getPoolKey', () => {
  it('should combine model and workspace', () => {
    expect(getPoolKey('opus4.5', '/home/user')).toBe('opus4.5:/home/user');
  });

  it('should use cwd when no workspace provided', () => {
    const key = getPoolKey('opus4.5');
    expect(key).toBe(`opus4.5:${process.cwd()}`);
  });
});

describe('isSDKErrorResponse', () => {
  it('should detect string error field', () => {
    const result = isSDKErrorResponse(JSON.stringify({ error: 'Something went wrong' }));
    expect(result.isError).toBe(true);
    expect(result.message).toBe('Something went wrong');
  });

  it('should detect object error field with message', () => {
    const result = isSDKErrorResponse(JSON.stringify({ error: { message: 'Bad request' } }));
    expect(result.isError).toBe(true);
    expect(result.message).toBe('Bad request');
  });

  it('should return false for valid non-error JSON', () => {
    const result = isSDKErrorResponse(JSON.stringify({ data: 'ok' }));
    expect(result.isError).toBe(false);
  });

  it('should return false for non-JSON string', () => {
    const result = isSDKErrorResponse('just plain text');
    expect(result.isError).toBe(false);
  });
});

describe('formatToolCallContent', () => {
  it('should return empty string for undefined', () => {
    expect(formatToolCallContent(undefined)).toBe('');
  });

  it('should return empty string for empty array', () => {
    expect(formatToolCallContent([])).toBe('');
  });

  it('should format text content', () => {
    const content: ToolCallContent[] = [{
      type: 'content',
      content: { type: 'text', text: 'Hello world' },
    }];
    expect(formatToolCallContent(content)).toBe('Hello world');
  });

  it('should format diff content', () => {
    const content: ToolCallContent[] = [{
      type: 'diff',
      path: '/src/file.ts',
      newText: 'new code',
    }];
    expect(formatToolCallContent(content)).toBe('[File: /src/file.ts]\nnew code');
  });

  it('should format terminal content', () => {
    const content: ToolCallContent[] = [{
      type: 'terminal',
      terminalId: 'term-1',
    }];
    expect(formatToolCallContent(content)).toBe('[Terminal: term-1]');
  });
});

describe('formatLocations', () => {
  it('should return empty string for undefined', () => {
    expect(formatLocations(undefined)).toBe('');
  });

  it('should return empty string for empty array', () => {
    expect(formatLocations([])).toBe('');
  });

  it('should format path with line', () => {
    const locations: ToolCallLocation[] = [{ path: '/src/file.ts', line: 42 }];
    expect(formatLocations(locations)).toBe('/src/file.ts:42');
  });

  it('should format path without line', () => {
    const locations: ToolCallLocation[] = [{ path: '/src/file.ts' }];
    expect(formatLocations(locations)).toBe('/src/file.ts');
  });

  it('should join multiple locations', () => {
    const locations: ToolCallLocation[] = [
      { path: '/a.ts', line: 1 },
      { path: '/b.ts', line: 2 },
    ];
    expect(formatLocations(locations)).toBe('/a.ts:1, /b.ts:2');
  });
});

describe('safeWrite', () => {
  it('should return false for destroyed response', () => {
    const res = { destroyed: true, writable: true, write: vi.fn() } as any;
    expect(safeWrite(res, 'data')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('should return false for non-writable response', () => {
    const res = { destroyed: false, writable: false, write: vi.fn() } as any;
    expect(safeWrite(res, 'data')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('should write and return the result for valid response', () => {
    const res = { destroyed: false, writable: true, write: vi.fn().mockReturnValue(true) } as any;
    expect(safeWrite(res, 'data')).toBe(true);
    expect(res.write).toHaveBeenCalledWith('data');
  });
});

describe('sleep', () => {
  it('should resolve after specified time', async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await promise;
    vi.useRealTimers();
  });
});
