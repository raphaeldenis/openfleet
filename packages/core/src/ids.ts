import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const newId = (): string => randomUUID();
export const newToken = (): string => randomBytes(32).toString('base64url');

// A plain === leaks a secret's length and, byte by byte, how much of it a guess got right through how
// long the comparison takes. timingSafeEqual needs equal-length buffers, so a length mismatch is checked
// (and rejected) before it, never inside a branch whose timing itself could leak the true length.
export function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}
