#!/usr/bin/env node

import 'dotenv/config';
import http, { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import nodePath from 'path';
import os from 'os';
import modelsConfig from './models.json' with { type: 'json' };

// Types
interface ModelConfig {
  auggie: string;
  name: string;
  context: number;
  output: number;
}

interface Session {
  accessToken: string;
  tenantURL: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

interface SessionUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string };
  title?: string;
  status?: string;
  toolCallId?: string;
  entries?: unknown[];
}

interface SessionNotification {
  update: SessionUpdate;
}

interface AuggieClient {
  prompt(message: string): Promise<string>;
  onSessionUpdate(callback: ((notification: SessionNotification) => void) | null): void;
  close(): Promise<void>;
}

interface ClientPool {
  available: AuggieClient[];
  inUse: Set<AuggieClient>;
  creating: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuggieSDK = {
  create: (options: { model?: string; apiKey?: string; apiUrl?: string }) => Promise<AuggieClient>;
};

// Configuration
const PORT = process.env.PORT || 8765;
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
const DEFAULT_MODEL = modelsConfig.defaultModel;
const POOL_SIZE = 5;

// Debug logging utility
function debugLog(category: string, data: unknown): void {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  console.log(`\n[DEBUG ${timestamp}] === ${category} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log('='.repeat(60));
}

// Model mapping: OpenAI-style model name -> Auggie model ID (loaded from JSON)
const MODEL_MAP: Record<string, ModelConfig> = modelsConfig.models;

// State
const clientPools: Record<string, ClientPool> = {};
let AuggieClass: AuggieSDK | null = null;
let session: Session | null = null;

async function loadSession(): Promise<Session> {
  if (session) return session;
  const sessionPath = nodePath.join(os.homedir(), '.augment', 'session.json');
  try {
    const data = await fs.readFile(sessionPath, 'utf-8');
    session = JSON.parse(data) as Session;
    return session;
  } catch (err) {
    console.error(`Failed to read session from ${sessionPath}:`, (err as Error).message);
    console.error('Please run "auggie login" first.');
    process.exit(1);
  }
}

async function initAuggie(): Promise<void> {
  if (!AuggieClass) {
    const sdk = await import('@augmentcode/auggie-sdk');
    // Cast to our flexible type since SDK types are incomplete for newer models
    AuggieClass = sdk.Auggie as unknown as AuggieSDK;
  }
}

async function createAuggieClient(auggieModel: string): Promise<AuggieClient> {
  await initAuggie();
  const sess = await loadSession();
  const client = await AuggieClass!.create({
    model: auggieModel,
    apiKey: sess.accessToken,
    apiUrl: sess.tenantURL,
  });
  console.log(`New Auggie client created for model: ${auggieModel}`);
  return client;
}

async function getAuggieClient(modelId: string): Promise<AuggieClient> {
  const modelConfig = MODEL_MAP[modelId] || MODEL_MAP[DEFAULT_MODEL];
  const auggieModel = modelConfig.auggie;

  if (!clientPools[auggieModel]) {
    clientPools[auggieModel] = { available: [], inUse: new Set(), creating: 0 };
  }

  const pool = clientPools[auggieModel];

  if (pool.available.length > 0) {
    const client = pool.available.pop()!;
    pool.inUse.add(client);
    console.log(`Reusing client for ${auggieModel} (available: ${pool.available.length}, inUse: ${pool.inUse.size})`);
    return client;
  }

  const totalClients = pool.inUse.size + pool.creating;
  if (totalClients < POOL_SIZE) {
    pool.creating++;
    try {
      const client = await createAuggieClient(auggieModel);
      pool.creating--;
      pool.inUse.add(client);
      console.log(`Created new client for ${auggieModel} (available: ${pool.available.length}, inUse: ${pool.inUse.size})`);
      return client;
    } catch (err) {
      pool.creating--;
      throw err;
    }
  }

  console.log(`Pool at capacity for ${auggieModel}, creating temporary client`);
  return await createAuggieClient(auggieModel);
}

function releaseAuggieClient(modelId: string, client: AuggieClient): void {
  const modelConfig = MODEL_MAP[modelId] || MODEL_MAP[DEFAULT_MODEL];
  const auggieModel = modelConfig.auggie;
  const pool = clientPools[auggieModel];
  if (!pool) return;

  if (pool.inUse.has(client)) {
    pool.inUse.delete(client);
    if (pool.available.length < POOL_SIZE) {
      pool.available.push(client);
      console.log(`Client returned to pool for ${auggieModel} (available: ${pool.available.length}, inUse: ${pool.inUse.size})`);
    } else {
      client.close().catch(() => {});
      console.log(`Pool full, closed client for ${auggieModel}`);
    }
  }
}

function getModels() {
  const now = Math.floor(Date.now() / 1000);
  return Object.entries(MODEL_MAP).map(([id, config]) => ({
    id,
    object: 'model',
    created: now,
    owned_by: 'augment-code',
    permission: [],
    root: id,
    parent: null,
    _auggie_model: config.auggie,
    _display_name: config.name,
  }));
}

function parseBody(req: IncomingMessage): Promise<ChatCompletionRequest> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk.toString());
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function formatMessages(messages: ChatMessage[]): string {
  return messages.map(m => {
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
    return `${role}: ${m.content}`;
  }).join('\n\n');
}

function createChatResponse(content: string, model: string) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function createStreamChunk(content: string, model: string, isLast = false): string {
  const chunk = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{ index: 0, delta: isLast ? {} : { content }, finish_reason: isLast ? 'stop' : null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createStreamCallback(res: ServerResponse, model: string, requestId: string) {
  return (notification: SessionNotification): void => {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text' && update.content.text) {
          res.write(createStreamChunk(update.content.text, model));
        }
        break;
      case 'agent_thought_chunk':
        if (update.content?.type === 'text' && update.content.text) {
          const thoughtChunk = {
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: null, reasoning: update.content.text }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(thoughtChunk)}\n\n`);
        }
        break;
      case 'tool_call':
        console.log(`[${requestId}] Tool call: ${update.title} (${update.status || 'started'})`);
        break;
      case 'tool_call_update':
        console.log(`[${requestId}] Tool update: ${update.toolCallId} (${update.status || 'updating'})`);
        break;
      case 'plan':
        console.log(`[${requestId}] Plan updated: ${update.entries?.length || 0} entries`);
        break;
    }
  };
}

async function callAugmentAPIStreaming(prompt: string, modelId: string, res: ServerResponse, requestId: string, model: string): Promise<void> {
  const client = await getAuggieClient(modelId);
  client.onSessionUpdate(createStreamCallback(res, model, requestId));
  try {
    await client.prompt(prompt);
  } finally {
    client.onSessionUpdate(null);
    releaseAuggieClient(modelId, client);
  }
}

async function callAugmentAPI(prompt: string, modelId: string): Promise<string> {
  const client = await getAuggieClient(modelId);
  try {
    return await client.prompt(prompt);
  } finally {
    releaseAuggieClient(modelId, client);
  }
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = randomUUID().slice(0, 8);

  try {
    const body = await parseBody(req);
    debugLog(`Request ${requestId}`, { body });
    const messages = body.messages || [];
    const stream = body.stream || false;
    const model = body.model || DEFAULT_MODEL;

    if (messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No messages provided' } }));
      return;
    }

    if (!MODEL_MAP[model]) {
      console.log(`[${requestId}] Unknown model "${model}", using default: ${DEFAULT_MODEL}`);
    }

    const prompt = formatMessages(messages);
    console.log(`[${requestId}] Processing request for model: ${model}, stream: ${stream}`);

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
      });

      try {
        await callAugmentAPIStreaming(prompt, model, res, requestId, model);
        res.write(createStreamChunk('', model, true));
        res.write('data: [DONE]\n\n');
      } catch (err) {
        console.error(`[${requestId}] Streaming error:`, (err as Error).message);
        res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
      }
      res.end();
    } else {
      const response = await callAugmentAPI(prompt, model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatResponse(response, model)));
    }
  } catch (err) {
    console.error(`[${requestId}] Request error:`, (err as Error).message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message } }));
  }
}

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: getModels() }));
}

function handleModel(_req: IncomingMessage, res: ServerResponse, modelId: string): void {
  const models = getModels();
  const model = models.find(m => m.id === modelId);
  if (model) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(model));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Model not found' } }));
  }
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const urlPath = url.pathname;

  console.log(`${new Date().toISOString()} ${req.method} ${urlPath}`);

  if (urlPath === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res);
  } else if (urlPath === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
  } else if (urlPath.startsWith('/v1/models/') && req.method === 'GET') {
    const modelId = urlPath.replace('/v1/models/', '');
    handleModel(req, res, modelId);
  } else if (urlPath === '/health' || urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'Auggie Wrapper is running' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Auggie Wrapper - OpenAI API Proxy                ║
╠════════════════════════════════════════════════════════════╣
║  Proxying OpenAI-compatible requests to Claude models      ║
║  via Augment Code SDK                                      ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${String(PORT).padEnd(22)}║
║  Default model:     ${DEFAULT_MODEL.padEnd(39)}║
╠════════════════════════════════════════════════════════════╣
║  Available models:                                         ║
${Object.entries(MODEL_MAP).map(([id]) => `║    - ${id.padEnd(54)}║`).join('\n')}
╠════════════════════════════════════════════════════════════╣
║  For OpenCode, run /models and select augment/*            ║
╚════════════════════════════════════════════════════════════╝
  `);
});
