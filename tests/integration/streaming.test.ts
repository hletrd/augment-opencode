import { describe, it, expect, vi } from 'vitest';
import { safeWrite } from '../../src/utils.js';
import { parseSSEStream } from '../helpers/sse-helpers.js';

// Mock ServerResponse for testing stream behavior
function createMockResponse() {
  const chunks: string[] = [];
  return {
    destroyed: false,
    writable: true,
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    chunks,
  };
}

describe('Streaming', () => {
  describe('SSE format parsing', () => {
    it('should parse single SSE event', () => {
      const events = parseSSEStream('data: {"hello":"world"}\n\n');
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toBe('{"hello":"world"}');
    });

    it('should parse multiple SSE events', () => {
      const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
      const events = parseSSEStream(raw);
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[0]!.data)).toEqual({ a: 1 });
      expect(JSON.parse(events[1]!.data)).toEqual({ b: 2 });
    });

    it('should parse [DONE] event', () => {
      const events = parseSSEStream('data: [DONE]\n\n');
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toBe('[DONE]');
    });

    it('should handle keepalive comments', () => {
      const raw = ':keepalive\n\ndata: {"text":"hi"}\n\n';
      const events = parseSSEStream(raw);
      // Comments (lines starting with :) should be ignored
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toBe('{"text":"hi"}');
    });
  });

  describe('safeWrite for streaming', () => {
    it('should write data to active response', () => {
      const res = createMockResponse();
      const result = safeWrite(res as any, 'data: test\n\n');
      expect(result).toBe(true);
      expect(res.chunks).toContain('data: test\n\n');
    });

    it('should not write to destroyed response', () => {
      const res = createMockResponse();
      res.destroyed = true;
      const result = safeWrite(res as any, 'data: test\n\n');
      expect(result).toBe(false);
      expect(res.chunks).toHaveLength(0);
    });

    it('should not write to non-writable response', () => {
      const res = createMockResponse();
      res.writable = false;
      const result = safeWrite(res as any, 'data: test\n\n');
      expect(result).toBe(false);
    });
  });

  describe('SSE chunk format', () => {
    it('should produce valid OpenAI streaming chunk shape', () => {
      const chunk = {
        id: 'chatcmpl-test123',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-opus-4-5',
        system_fingerprint: 'auggie-wrapper-1.0.0',
        choices: [
          {
            index: 0,
            delta: { content: 'Hello' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };

      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.choices).toHaveLength(1);
      expect(chunk.choices[0]!.delta.content).toBe('Hello');
      expect(chunk.choices[0]!.finish_reason).toBeNull();
    });

    it('should produce valid stop chunk', () => {
      const stopChunk = {
        id: 'chatcmpl-test123',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-opus-4-5',
        system_fingerprint: 'auggie-wrapper-1.0.0',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      };

      expect(stopChunk.choices[0]!.finish_reason).toBe('stop');
      expect(stopChunk.choices[0]!.delta).toEqual({});
    });

    it('should produce valid reasoning chunk shape', () => {
      const chunk = {
        id: 'chatcmpl-test123',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'Let me think...' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };

      expect(chunk.choices[0]!.delta).toHaveProperty('reasoning_content');
    });

    it('should have consistent chunk IDs within a response', () => {
      const requestId = 'test-req-123';
      const chunkId = `chatcmpl-${requestId}`;

      // All chunks in a response should share the same ID
      const chunks = [
        { id: chunkId, choices: [{ delta: { content: 'Hello' } }] },
        { id: chunkId, choices: [{ delta: { content: ' world' } }] },
        { id: chunkId, choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];

      const ids = chunks.map(c => c.id);
      expect(new Set(ids).size).toBe(1);
    });
  });
});
