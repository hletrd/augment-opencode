import { vi } from 'vitest';
import type { SessionNotification } from '../../src/types.js';

export interface MockAuggieClient {
  prompt: ReturnType<typeof vi.fn>;
  onSessionUpdate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _simulateUpdate: (notification: SessionNotification) => void;
}

export function createMockClient(response?: string): MockAuggieClient {
  let updateCallback: ((notification: SessionNotification) => void) | null = null;

  const client: MockAuggieClient = {
    prompt: vi.fn().mockResolvedValue(response ?? 'Mock response'),
    onSessionUpdate: vi.fn().mockImplementation((cb: ((notification: SessionNotification) => void) | null) => {
      updateCallback = cb;
    }),
    close: vi.fn().mockResolvedValue(undefined),
    _simulateUpdate: (notification: SessionNotification) => {
      if (updateCallback) {
        updateCallback(notification);
      }
    },
  };

  return client;
}

export function createMockSDK(client?: MockAuggieClient) {
  const mockClient = client ?? createMockClient();
  return {
    Auggie: {
      create: vi.fn().mockResolvedValue(mockClient),
    },
  };
}
