import http from 'http';

let testServer: http.Server | null = null;
let testPort = 0;

export async function startTestServer(app: http.Server): Promise<number> {
  testServer = app;
  return new Promise((resolve) => {
    testServer!.listen(0, () => {
      const addr = testServer!.address();
      if (addr && typeof addr === 'object') {
        testPort = addr.port;
        resolve(testPort);
      }
    });
  });
}

export async function stopTestServer(): Promise<void> {
  if (testServer) {
    return new Promise((resolve) => {
      testServer!.close(() => {
        testServer = null;
        resolve();
      });
    });
  }
}

export function getTestPort(): number {
  return testPort;
}

export interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: <T = unknown>() => T;
}

export async function makeRequest(options: RequestOptions): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: 'localhost',
        port: testPort,
        path: options.path,
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
            json: <T = unknown>() => JSON.parse(data) as T,
          });
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
