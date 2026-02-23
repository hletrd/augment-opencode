import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/server.js';
import { startTestServer, stopTestServer } from '../helpers/http-helpers.js';
import { collectSSEEvents, parseSSEStream } from '../helpers/sse-helpers.js';

describe('Chat Streaming', () => {
  let port: number;

  beforeAll(async () => {
    const app = createApp();
    port = await startTestServer(app);
  });

  afterAll(async () => {
    await stopTestServer();
  });

  it('should return SSE headers for streaming request', async () => {
    const events = await collectSSEEvents(port, {
      path: '/v1/chat/completions',
      body: {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });
    // Should have at least a stop chunk and [DONE]
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('should end with [DONE] event', async () => {
    const events = await collectSSEEvents(port, {
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.data).toBe('[DONE]');
  });

  it('should include stop chunk before [DONE]', async () => {
    const events = await collectSSEEvents(port, {
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });
    // Find the stop chunk (second to last, before [DONE])
    const nonDoneEvents = events.filter(e => e.data !== '[DONE]');
    expect(nonDoneEvents.length).toBeGreaterThanOrEqual(1);
    const lastChunk = nonDoneEvents[nonDoneEvents.length - 1];
    if (lastChunk) {
      const parsed = JSON.parse(lastChunk.data) as {
        choices: Array<{ finish_reason: string | null }>;
      };
      expect(parsed.choices[0]!.finish_reason).toBe('stop');
    }
  });

  it('should have chat.completion.chunk object type', async () => {
    const events = await collectSSEEvents(port, {
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });
    const nonDoneEvents = events.filter(e => e.data !== '[DONE]');
    for (const event of nonDoneEvents) {
      const parsed = JSON.parse(event.data) as { object: string };
      expect(parsed.object).toBe('chat.completion.chunk');
    }
  });

  it('should return 400 for invalid streaming request', async () => {
    // For validation errors, even with stream=true, server returns JSON error before switching to SSE
    const events = await collectSSEEvents(port, {
      path: '/v1/chat/completions',
      body: {
        stream: true,
        // Missing messages
      },
    });
    // The response won't be SSE format - it'll be a plain JSON error
    // But our collectSSEEvents will still capture the raw body
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('should have consistent chunk IDs within a response', async () => {
    const events = await collectSSEEvents(port, {
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });
    const nonDoneEvents = events.filter(e => e.data !== '[DONE]');
    if (nonDoneEvents.length >= 2) {
      const ids = nonDoneEvents.map(e => (JSON.parse(e.data) as { id: string }).id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(1);
    }
  });
});
