import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/server.js';
import { startTestServer, stopTestServer, makeRequest } from '../helpers/http-helpers.js';

describe('Chat Completions', () => {
  let port: number;

  beforeAll(async () => {
    const app = createApp();
    port = await startTestServer(app);
  });

  afterAll(async () => {
    await stopTestServer();
  });

  it('should return valid chat completion for non-streaming request', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });
    expect(res.status).toBe(200);
    const body = res.json<{
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }>();
    expect(body.object).toBe('chat.completion');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]!.message.role).toBe('assistant');
    expect(body.choices[0]!.finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('should return 400 for missing messages', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'claude-opus-4-6' },
    });
    expect(res.status).toBe(400);
    const body = res.json<{ error: { message: string; type: string } }>();
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('should return 400 for empty messages array', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: { messages: [] },
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for invalid message format', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'invalid', content: 'test' }] },
    });
    expect(res.status).toBe(400);
  });

  it('should use default model when unknown model provided', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    // Should still succeed - falls back to default model
    expect(res.status).toBe(200);
  });

  it('should propagate X-Request-ID header', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
      headers: { 'X-Request-ID': 'test-req-123' },
    });
    expect(res.headers['x-request-id']).toBe('test-req-123');
  });

  it('should generate X-Request-ID when not provided', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('should include id starting with chatcmpl-', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    const body = res.json<{ id: string }>();
    expect(body.id).toMatch(/^chatcmpl-/);
  });
});
