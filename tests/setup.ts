import { vi } from 'vitest';

// Mock the auggie SDK globally
vi.mock('@augmentcode/auggie-sdk', () => ({
  Auggie: {
    create: vi.fn().mockResolvedValue({
      prompt: vi.fn().mockResolvedValue('Mock response'),
      onSessionUpdate: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// Mock fs/promises for session.json reading
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFile: vi.fn().mockImplementation(async (path: string, _encoding?: string) => {
        if (typeof path === 'string' && path.includes('session.json')) {
          return JSON.stringify({
            accessToken: 'test-token-12345678',
            tenantURL: 'https://test.augmentcode.com',
          });
        }
        return actual.readFile(path, _encoding);
      }),
      access: vi.fn().mockResolvedValue(undefined),
    },
  };
});
