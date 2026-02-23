import { describe, it, expect } from 'vitest';
import modelsConfig from '../../src/models.json' with { type: 'json' };

const MODEL_MAP = modelsConfig.models;

describe('Model Configuration', () => {
  it('should have the default model configured', () => {
    expect(MODEL_MAP[modelsConfig.defaultModel]).toBeDefined();
  });

  it('should have required fields for all models', () => {
    for (const [id, config] of Object.entries(MODEL_MAP)) {
      expect(config.auggie).toBeDefined();
      expect(config.name).toBeDefined();
      expect(config.context).toBeGreaterThan(0);
      expect(config.output).toBeGreaterThan(0);
      expect(typeof config.auggie).toBe('string');
      expect(typeof config.name).toBe('string');
    }
  });

  it('should have unique auggie model IDs', () => {
    const auggieIds = Object.values(MODEL_MAP).map((c) => c.auggie);
    const uniqueIds = new Set(auggieIds);
    expect(uniqueIds.size).toBe(auggieIds.length);
  });

  it('should include Claude models', () => {
    const claudeModels = Object.keys(MODEL_MAP).filter((id) => id.startsWith('claude-'));
    expect(claudeModels.length).toBeGreaterThan(0);
  });

  it('should have valid context and output sizes', () => {
    for (const config of Object.values(MODEL_MAP)) {
      expect(config.output).toBeLessThanOrEqual(config.context);
    }
  });
});
