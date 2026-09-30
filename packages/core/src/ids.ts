import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const newId = (): string => randomUUID();
export const shortId = (): string => randomUUID().slice(0, 8);
export const newToken =(): string => randomBytes(32).toString('base64url');

// A plain === leaks a secret's length and, byte by byte, how much of it a guess got right through how
// long the comparison takes. timingSafeEqual needs equal-length buffers, so a length mismatch is checked
// (and rejected) before it, never inside a branch whose timing itself could leak the true length.
// ponytail: the constant-time property itself can't be pinned by a black-box test — timing is not an
// assertable output. Trust is placed in timingSafeEqual, guarded by the length check running first.
export function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}
