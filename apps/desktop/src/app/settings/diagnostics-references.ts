import type { DiagnosticsDocument } from '@openfleet/shared';

export const MAX_REFERENCES = 50;
const REFERENCE_PATTERN = /^[0-9a-f]{8}$/;

const isReference = (value: unknown): value is string => typeof value === 'string' && REFERENCE_PATTERN.test(value);

const referenceOfLogRecord = (record: unknown): string | undefined => {
  const id = typeof record === 'object' && record !== null ? (record as { id?: unknown }).id : undefined;
  return isReference(id) ? id : undefined;
};

/** The refs a person may have been shown, oldest first, each once: the ones in the log tail, then the degraded issues'. */
export function referencesOf(document: Pick<DiagnosticsDocument, 'log' | 'health'>): string[] {
  const loggedReferences = document.log.map(referenceOfLogRecord);
  const issueReferences = document.health.issues.map((issue) => issue.id);
  const references = [...loggedReferences, ...issueReferences].filter(isReference);
  return [...new Set(references)].slice(-MAX_REFERENCES);
}

export const referenceListText = (references: ReadonlyArray<string>): string => references.map((reference) => `ref ${reference}`).join('\n');

export const copiedReferencesLabel = (count: number): string => `Copied · ${count} ${count === 1 ? 'reference' : 'references'}`;
