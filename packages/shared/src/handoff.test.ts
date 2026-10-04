import { describe, expect, it } from 'vitest';
import { CloseSessionRequestSchema, HANDOFF_SECTION_KEYS, HANDOFF_SECTION_MAX_CHARACTERS, HandoffContentSchema } from './handoff.js';

const validContent = () => ({
  goal: 'Ship the handoff preview',
  state: 'Session state: open',
  decisions: 'Inline the seed',
  filesTouched: 'M packages/shared/src/handoff.ts',
  nextSteps: 'Add the routes',
  openQuestions: '(none)',
});

describe('HandoffContentSchema', () => {
  it('accepts the six sections as strings', () => {
    const content = validContent();

    const parsed = HandoffContentSchema.parse(content);

    expect(parsed).toEqual(content);
  });

  it('names the six sections in the order the note renders them', () => {
    expect(HANDOFF_SECTION_KEYS).toEqual(['goal', 'state', 'decisions', 'filesTouched', 'nextSteps', 'openQuestions']);
  });

  it('accepts empty sections', () => {
    const emptyContent = Object.fromEntries(HANDOFF_SECTION_KEYS.map((key) => [key, '']));

    expect(HandoffContentSchema.safeParse(emptyContent).success).toBe(true);
  });

  it.each(HANDOFF_SECTION_KEYS)('accepts %s at the cap and refuses it one character above', (key) => {
    const atCap = { ...validContent(), [key]: 'a'.repeat(HANDOFF_SECTION_MAX_CHARACTERS) };
    const aboveCap = { ...validContent(), [key]: 'a'.repeat(HANDOFF_SECTION_MAX_CHARACTERS + 1) };

    expect(HandoffContentSchema.safeParse(atCap).success).toBe(true);
    expect(HandoffContentSchema.safeParse(aboveCap).success).toBe(false);
  });

  it('caps each section at 20000 characters', () => {
    expect(HANDOFF_SECTION_MAX_CHARACTERS).toBe(20_000);
  });

  it.each(HANDOFF_SECTION_KEYS)('refuses a payload without %s', (key) => {
    const { [key]: _omitted, ...withoutSection } = validContent();

    expect(HandoffContentSchema.safeParse(withoutSection).success).toBe(false);
  });

  it.each(HANDOFF_SECTION_KEYS)('refuses a non-string %s', (key) => {
    expect(HandoffContentSchema.safeParse({ ...validContent(), [key]: 4 }).success).toBe(false);
  });

  it('refuses an unknown key', () => {
    const withExtraKey = { ...validContent(), path: '../escape.md' };

    expect(HandoffContentSchema.safeParse(withExtraKey).success).toBe(false);
  });
});

describe('CloseSessionRequestSchema', () => {
  it.each([[{}], [{ writeHandoff: true }], [{ writeHandoff: false }]])('accepts %j', (body) => {
    expect(CloseSessionRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['an unknown key', { writeHandoff: true, force: true }],
    ['a non-boolean flag', { writeHandoff: 'yes' }],
  ])('refuses %s', (_label, body) => {
    expect(CloseSessionRequestSchema.safeParse(body).success).toBe(false);
  });
});
