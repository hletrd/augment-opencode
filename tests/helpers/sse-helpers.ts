import http from 'http';

export interface SSEEvent {
  data: string;
  event?: string;
}

export function parseSSEStream(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = raw.split('\n');
  let currentEvent: Partial<SSEEvent> = {};

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      currentEvent.data = line.slice(6);
    } else if (line.startsWith('event: ')) {
      currentEvent.event = line.slice(7);
    } else if (line.trim() === '' && currentEvent.data !== undefined) {
      events.push({ data: currentEvent.data, event: currentEvent.event });
      currentEvent = {};
    }
  }

  // Handle trailing event without final newline
  if (currentEvent.data !== undefined) {
    events.push({ data: currentEvent.data, event: currentEvent.event });
  }

  return events;
}

export async function collectSSEEvents(port: number, options: {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<SSEEvent[]> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: options.path,
        method: options.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          resolve(parseSSEStream(raw));
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}
