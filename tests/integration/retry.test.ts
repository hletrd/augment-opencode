import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateRetryDelay, RETRY_CONFIG, sleep } from '../../src/utils.js';
import { isRetryableError, isRateLimitError } from '../../src/errors.js';

describe('Retry Logic', () => {
  describe('calculateRetryDelay', () => {
    it('should return initialDelayMs range for first attempt', () => {
      const delay = calculateRetryDelay(0);
      const min = RETRY_CONFIG.initialDelayMs * (1 - RETRY_CONFIG.jitterFactor);
      const max = RETRY_CONFIG.initialDelayMs * (1 + RETRY_CONFIG.jitterFactor);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(min));
      expect(delay).toBeLessThanOrEqual(Math.ceil(max));
    });

    it('should use exponential backoff', () => {
      // Attempt 2: initialDelay * backoffMultiplier^2 = 5000 * 4 = 20000
      const expectedBase = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, 2);
      const delay = calculateRetryDelay(2);
      const min = expectedBase * (1 - RETRY_CONFIG.jitterFactor);
      const max = expectedBase * (1 + RETRY_CONFIG.jitterFactor);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(min));
      expect(delay).toBeLessThanOrEqual(Math.ceil(max));
    });

    it('should cap at maxDelayMs', () => {
      const delay = calculateRetryDelay(50); // Very high attempt
      const maxWithJitter = RETRY_CONFIG.maxDelayMs * (1 + RETRY_CONFIG.jitterFactor);
      expect(delay).toBeLessThanOrEqual(Math.ceil(maxWithJitter));
    });

    it('should add jitter within expected range', () => {
      // Run multiple times to verify jitter varies
      const delays = Array.from({ length: 50 }, () => calculateRetryDelay(0));
      const unique = new Set(delays);
      // With jitter, we should get multiple different values
      expect(unique.size).toBeGreaterThan(1);
    });
  });

  describe('Retry error classification', () => {
    it('should retry rate limit errors', () => {
      const error = Object.assign(new Error('Rate limit'), { statusCode: 429 });
      expect(isRetryableError(error)).toBe(true);
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should retry transient server errors', () => {
      const error = Object.assign(new Error('Server error'), { statusCode: 500 });
      expect(isRetryableError(error)).toBe(true);
    });

    it('should NOT retry context length errors', () => {
      const error = new Error('Context length exceeded');
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('sleep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should resolve after the specified delay', async () => {
      const start = Date.now();
      const promise = sleep(1000);
      vi.advanceTimersByTime(1000);
      await promise;
      expect(Date.now() - start).toBe(1000);
    });

    it('should not resolve before the delay', async () => {
      let resolved = false;
      const promise = sleep(1000).then(() => { resolved = true; });
      vi.advanceTimersByTime(500);
      await Promise.resolve(); // flush microtasks
      expect(resolved).toBe(false);
      vi.advanceTimersByTime(500);
      await promise;
      expect(resolved).toBe(true);
    });
  });
});
