import { REPRO_CLAIM_EXAMPLE, ReproClaimSchema, SHAPE_MESSAGE } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { refuseInvalidBody } from './claimRefusal.js';

const MESSAGE_CAP = 300;

const refusalText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const messageOf = (text: string) => text.replace(/^error invalid_body: /, '').split(' Example: ')[0]!;
const messagesOfClaims = (claims: unknown[]) => {
  const parsed = ReproClaimSchema.array().safeParse(claims);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('refuseInvalidBody on invalid claims', () => {
  it('states the shape and every distinct problem within the message cap for a plain-text claim, a bad status and a proven claim without output', () => {
    const plainTextClaim = 'the filter is missing';
    const badStatusClaim = { claim: 'the filter is missing', status: 'bogus' };
    const provenWithoutOutput = { claim: 'the filter is missing', status: 'proven', command: 'pnpm test' };

    const text = refusalText(refuseInvalidBody(messagesOfClaims([plainTextClaim, badStatusClaim, provenWithoutOutput])));

    const message = messageOf(text);
    expect(message.length).toBeLessThanOrEqual(MESSAGE_CAP);
    expect(message).toContain(SHAPE_MESSAGE);
    expect(message).toContain('status');
    expect(message).toContain('output');
    expect(text).not.toContain('…');
    expect(text).not.toContain('.;');
    expect(text).toContain(REPRO_CLAIM_EXAMPLE);
  });

  it('states the shape once for a plain-text claim alone', () => {
    const text = refusalText(refuseInvalidBody(messagesOfClaims(['the filter is missing'])));

    expect(messageOf(text)).toBe(SHAPE_MESSAGE);
  });
});
