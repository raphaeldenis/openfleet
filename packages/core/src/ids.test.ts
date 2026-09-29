import { describe, expect, it } from 'vitest';
import { tokensMatch } from './ids.js';

describe('tokensMatch', () => {
  it('is true for two identical tokens', () => {
    expect(tokensMatch('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('is false for tokens that differ only past a shared prefix', () => {
    expect(tokensMatch('Bearer abc123', 'Bearer abc999')).toBe(false);
  });

  it('is false for tokens of different lengths, without throwing', () => {
    expect(tokensMatch('short', 'a much longer candidate')).toBe(false);
  });

  it('is false against an empty candidate', () => {
    expect(tokensMatch('', 'Bearer abc123')).toBe(false);
  });
});
