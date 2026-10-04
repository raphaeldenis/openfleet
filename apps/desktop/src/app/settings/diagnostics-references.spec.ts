import { describe, expect, it } from 'vitest';
import { copiedReferencesLabel, referenceListText, referencesOf } from './diagnostics-references';

const issue = (id: string) => ({ code: 'db_stuck' as const, since: 't', message: 'm', id, count: 1 });

describe('referencesOf', () => {
  it('lists the refs of the log records, then the issues, each once, ignoring ids that are not refs', () => {
    const log = [{ id: 'aaaaaaaa' }, { msg: 'no id' }, 'a raw line', { id: 'not-a-ref' }, { id: 'bbbbbbbb' }, { id: 'aaaaaaaa' }];

    const references = referencesOf({ log, health: { status: 'degraded', issues: [issue('bbbbbbbb'), issue('cccccccc')] } });

    expect(references).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  });

  it('keeps the 50 newest', () => {
    const log = Array.from({ length: 60 }, (_, index) => ({ id: index.toString(16).padStart(8, '0') }));

    const references = referencesOf({ log, health: { status: 'ok', issues: [] } });

    expect(references).toHaveLength(50);
    expect(references[0]).toBe('0000000a');
    expect(references.at(-1)).toBe('0000003b');
  });
});

describe('the reference list text', () => {
  it('puts one "ref <id>" per line', () => {
    expect(referenceListText(['aaaaaaaa', 'bbbbbbbb'])).toBe('ref aaaaaaaa\nref bbbbbbbb');
  });

  it('counts references in the confirmation, singular included', () => {
    expect([copiedReferencesLabel(50), copiedReferencesLabel(1)]).toEqual(['Copied · 50 references', 'Copied · 1 reference']);
  });
});
