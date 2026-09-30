import { ZodError } from 'zod';

// Names each offending key and its problem on one line, where a ZodError's own message is a multi-line JSON dump.
export function readableConfigReason(error: unknown): string {
  if (!(error instanceof ZodError)) return (error as Error).message;
  return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}
