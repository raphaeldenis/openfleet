import { z } from 'zod';

// A model id becomes the value of the claude CLI's `--model <value>` flag (see launchConfig.ts): a leading
// '-' would be read as another flag, and whitespace or control characters could inject one. Every entry
// that accepts a model id or rung name validates against this one schema, so the check cannot drift
// between REST, MCP and the harness launch that spawns the CLI.
export const MODEL_ID_MAX_LENGTH = 100;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

export const ModelIdSchema = z.string().trim().min(1).max(MODEL_ID_MAX_LENGTH).regex(MODEL_ID_PATTERN, 'invalid model id');

export function isValidModelId(value: string): boolean {
  return value.length > 0 && value.length <= MODEL_ID_MAX_LENGTH && MODEL_ID_PATTERN.test(value);
}
