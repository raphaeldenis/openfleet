import { copyFor } from '../core/error-copy';

export type CreatedKind = 'session' | 'manager';

export function createdButNotOpenedMessage(kind: CreatedKind): string {
  return `The ${kind} was created but could not be opened — press Create again to open it. Editing the form creates a new ${kind} instead.`;
}

export function createSessionErrorMessage(error: unknown, kind: CreatedKind): string {
  const action = kind === 'session' ? 'create_session' : 'create_manager';
  return copyFor(error, { action }).text;
}
