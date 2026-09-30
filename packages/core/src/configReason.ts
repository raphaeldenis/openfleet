import { ZodError } from 'zod';

const JSON_POSITION = /position (\d+)/;

function describeJsonSyntaxError(error: SyntaxError): string {
  const position = JSON_POSITION.exec(error.message)?.[1];
  return position === undefined ? 'not valid JSON' : `not valid JSON at position ${position}`;
}

function messageOfThrown(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  const message = (thrown as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : 'unknown error';
}

// Names each offending key and its problem on one line, where a ZodError's own message is a multi-line JSON dump
// and a JSON SyntaxError's message quotes a snippet of the file.
export function readableConfigReason(error: unknown): string {
  if (error instanceof SyntaxError) return describeJsonSyntaxError(error);
  if (!(error instanceof ZodError)) return messageOfThrown(error);
  return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}
