/**
 * Model definitions for the Augment Code OpenCode plugin.
 * These are used by both the config hook (to register models with OpenCode)
 * and the embedded server (to route requests to the Auggie SDK).
 */

export interface ModelConfig {
  /** Auggie SDK model ID (e.g., "opus4.6") */
  auggie: string;
  /** Human-readable model name */
  name: string;
  /** Context window size in tokens */
  context: number;
  /** Maximum output tokens */
  output: number;
}

/** Default model used when none is specified */
export const DEFAULT_MODEL = "claude-opus-4-6";

/** Map of OpenCode model IDs to Auggie SDK model configurations */
export const MODEL_MAP: Record<string, ModelConfig> = {
  // Claude models
  "claude-opus-4-6": {
    auggie: "opus4.6",
    name: "Claude Opus 4.6",
    context: 200000,
    output: 32000,
  },
  "claude-opus-4-5": {
    auggie: "opus4.5",
    name: "Claude Opus 4.5",
    context: 200000,
    output: 32000,
  },
  "claude-sonnet-4-5": {
    auggie: "sonnet4.5",
    name: "Claude Sonnet 4.5",
    context: 200000,
    output: 16000,
  },
  "claude-sonnet-4": {
    auggie: "sonnet4",
    name: "Claude Sonnet 4",
    context: 200000,
    output: 16000,
  },
  "claude-haiku-4-5": {
    auggie: "haiku4.5",
    name: "Claude Haiku 4.5",
    context: 200000,
    output: 8000,
  },
  // GPT models
  "gpt-5": {
    auggie: "gpt5",
    name: "GPT-5",
    context: 128000,
    output: 16000,
  },
  "gpt-5-1": {
    auggie: "gpt5.1",
    name: "GPT-5.1",
    context: 128000,
    output: 16000,
  },
  "gpt-5-2": {
    auggie: "gpt5.2",
    name: "GPT-5.2",
    context: 128000,
    output: 16000,
  },
};

