import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/server.js';
import { startTestServer, stopTestServer, makeRequest } from '../helpers/http-helpers.js';

describe('API Endpoints', () => {
  let port: number;

  beforeAll(async () => {
    const app = createApp();
    port = await startTestServer(app);
  });

  afterAll(async () => {
    await stopTestServer();
  });

  describe('GET /v1/models', () => {
    it('should return list of models', async () => {
      const res = await makeRequest({ path: '/v1/models' });
      expect(res.status).toBe(200);
      const body = res.json<{ object: string; data: unknown[] }>();
      expect(body.object).toBe('list');
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('should return correct model shape', async () => {
      const res = await makeRequest({ path: '/v1/models' });
      const body = res.json<{ data: Array<{ id: string; object: string; owned_by: string }> }>();
      const model = body.data[0]!;
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('object', 'model');
      expect(model).toHaveProperty('owned_by', 'augment-code');
      expect(model).toHaveProperty('created');
      expect(model).toHaveProperty('root');
    });
  });

  describe('GET /v1/models/:id', () => {
    it('should return specific model', async () => {
      const res = await makeRequest({ path: '/v1/models/claude-opus-4-6' });
      expect(res.status).toBe(200);
      const body = res.json<{ id: string }>();
      expect(body.id).toBe('claude-opus-4-6');
    });

    it('should return 404 for unknown model', async () => {
      const res = await makeRequest({ path: '/v1/models/nonexistent-model' });
      expect(res.status).toBe(404);
      const body = res.json<{ error: { message: string } }>();
      expect(body.error.message).toBe('Model not found');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await makeRequest({ path: '/health' });
      expect(res.status).toBe(200);
      const body = res.json<{
        status: string;
        message: string;
        timestamp: string;
        uptime: { seconds: number; formatted: string };
        metrics: object;
        models: { available: string[]; default: string };
        memory: object;
        config: object;
      }>();
      expect(body.status).toBe('ok');
      expect(body.message).toBe('Auggie Wrapper is running');
      expect(body.uptime).toBeDefined();
      expect(body.metrics).toBeDefined();
      expect(body.models.available).toBeInstanceOf(Array);
      expect(body.models.default).toBeDefined();
      expect(body.memory).toBeDefined();
      expect(body.config).toBeDefined();
    });
  });

  describe('GET /version', () => {
    it('should return version info', async () => {
      const res = await makeRequest({ path: '/version' });
      expect(res.status).toBe(200);
      const body = res.json<{
        name: string;
        runtime: { node: string };
        api: { openaiCompatible: boolean; defaultModel: string };
      }>();
      expect(body.name).toBe('auggie-wrapper');
      expect(body.runtime.node).toBeDefined();
      expect(body.api.openaiCompatible).toBe(true);
      expect(body.api.defaultModel).toBeDefined();
    });
  });

  describe('GET /metrics', () => {
    it('should return metrics', async () => {
      const res = await makeRequest({ path: '/metrics' });
      expect(res.status).toBe(200);
      const body = res.json<{ totalRequests: number; timestamp: string }>();
      expect(body).toHaveProperty('totalRequests');
      expect(body).toHaveProperty('timestamp');
    });
  });

  describe('Simple health checks', () => {
    it('GET / should return 200', async () => {
      const res = await makeRequest({ path: '/' });
      expect(res.status).toBe(200);
      const body = res.json<{ status: string }>();
      expect(body.status).toBe('ok');
    });

    it('GET /healthz should return 200', async () => {
      const res = await makeRequest({ path: '/healthz' });
      expect(res.status).toBe(200);
    });

    it('GET /ready should return 200', async () => {
      const res = await makeRequest({ path: '/ready' });
      expect(res.status).toBe(200);
    });
  });

  describe('CORS', () => {
    it('OPTIONS should return 204 with CORS headers', async () => {
      const res = await makeRequest({ method: 'OPTIONS', path: '/v1/models' });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  describe('Unknown routes', () => {
    it('should return 404 for unknown path', async () => {
      const res = await makeRequest({ path: '/unknown' });
      expect(res.status).toBe(404);
      const body = res.json<{ error: { message: string } }>();
      expect(body.error.message).toBe('Not found');
    });
  });
});
