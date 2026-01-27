#!/usr/bin/env node

import http from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const PORT = process.env.PORT || 8765;
const DEFAULT_MODEL = 'claude-opus-4.5';

// Model mapping: OpenAI-style model name -> Auggie model ID
const MODEL_MAP = {
  'claude-opus-4.5': { auggie: 'opus4.5', name: 'Claude Opus 4.5', context: 200000, output: 32000 },
  'claude-sonnet-4.5': { auggie: 'sonnet4.5', name: 'Claude Sonnet 4.5', context: 200000, output: 16000 },
  'claude-sonnet-4': { auggie: 'sonnet4', name: 'Claude Sonnet 4', context: 200000, output: 16000 },
  'claude-haiku-4.5': { auggie: 'haiku4.5', name: 'Claude Haiku 4.5', context: 200000, output: 8000 },
};

// Cache for Auggie SDK clients (one per model)
const auggieClients = {};
let Auggie = null;
let session = null;

// Load session credentials from ~/.augment/session.json
async function loadSession() {
  if (session) return session;
  const sessionPath = path.join(os.homedir(), '.augment', 'session.json');
  try {
    const data = await fs.readFile(sessionPath, 'utf-8');
    session = JSON.parse(data);
    return session;
  } catch (err) {
    console.error(`Failed to read session from ${sessionPath}:`, err.message);
    console.error('Please run "auggie login" first.');
    process.exit(1);
  }
}

// Initialize the Auggie SDK
async function initAuggie() {
  if (!Auggie) {
    const sdk = await import('@augmentcode/auggie-sdk');
    Auggie = sdk.Auggie;
  }
}

// Get or create Auggie client for a specific model
async function getAuggieClient(modelId) {
  const modelConfig = MODEL_MAP[modelId] || MODEL_MAP[DEFAULT_MODEL];
  const auggieModel = modelConfig.auggie;

  if (auggieClients[auggieModel]) {
    return auggieClients[auggieModel];
  }

  try {
    await initAuggie();
    const sess = await loadSession();

    const client = await Auggie.create({
      model: auggieModel,
      apiKey: sess.accessToken,
      apiUrl: sess.tenantURL,
    });

    auggieClients[auggieModel] = client;
    console.log(`Auggie SDK client initialized for model: ${auggieModel}`);
    return client;
  } catch (err) {
    console.error(`Failed to initialize Auggie SDK for ${auggieModel}:`, err.message);
    throw err;
  }
}

// Generate OpenAI-compatible model list
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function formatMessages(messages) {
  // Convert OpenAI chat format to a single prompt for Auggie
  return messages.map(m => {
    const role = m.role === 'assistant' ? 'Assistant' :
                 m.role === 'system' ? 'System' : 'User';
    return `${role}: ${m.content}`;
  }).join('\n\n');
}

async function callAugmentAPI(prompt, modelId) {
  const client = await getAuggieClient(modelId);
  const response = await client.prompt(prompt);
  return response;
}

function createChatResponse(content, model) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function createStreamChunk(content, model, isLast = false) {
  const chunk = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      delta: isLast ? {} : { content },
      finish_reason: isLast ? 'stop' : null
    }]
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function handleChatCompletions(req, res) {
  try {
    const body = await parseBody(req);
    const messages = body.messages || [];
    const stream = body.stream || false;
    const model = body.model || DEFAULT_MODEL;

    if (messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No messages provided' } }));
      return;
    }

    // Validate model
    if (!MODEL_MAP[model]) {
      console.log(`Unknown model "${model}", using default: ${DEFAULT_MODEL}`);
    }

    const prompt = formatMessages(messages);

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      try {
        const response = await callAugmentAPI(prompt, model);
        // Stream the response in chunks
        const chunkSize = 20;
        for (let i = 0; i < response.length; i += chunkSize) {
          res.write(createStreamChunk(response.slice(i, i + chunkSize), model));
        }
        res.write(createStreamChunk('', model, true));
        res.write('data: [DONE]\n\n');
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
      res.end();
    } else {
      const response = await callAugmentAPI(prompt, model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatResponse(response, model)));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
}

function handleModels(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: getModels() }));
}

function handleModel(req, res, modelId) {
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

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  console.log(`${new Date().toISOString()} ${req.method} ${path}`);

  // Route handling
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res);
  } else if (path === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
  } else if (path.startsWith('/v1/models/') && req.method === 'GET') {
    const modelId = path.replace('/v1/models/', '');
    handleModel(req, res, modelId);
  } else if (path === '/health' || path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'Auggie Wrapper is running' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
});

server.listen(PORT, () => {
  const modelList = Object.keys(MODEL_MAP).map(m => `    - ${m}`).join('\n');
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Auggie Wrapper - OpenAI API Proxy                ║
╠════════════════════════════════════════════════════════════╣
║  Proxying OpenAI-compatible requests to Claude models      ║
║  via Augment Code SDK                                      ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${String(PORT).padEnd(24)}║
║  Default model:     ${DEFAULT_MODEL.padEnd(35)}║
╠════════════════════════════════════════════════════════════╣
║  Available models:                                         ║
${Object.entries(MODEL_MAP).map(([id, cfg]) => `║    - ${id.padEnd(52)}║`).join('\n')}
╠════════════════════════════════════════════════════════════╣
║  For OpenCode, run /models and select augment/*            ║
╚════════════════════════════════════════════════════════════╝
  `);
});
