import { describe, expect, it } from 'vitest';
import { EXIT_CODES } from './exitCodes.js';

describe('EXIT_CODES', () => {
  it('is the contract of a supervisor: 0 clean, 1 failed, 2 runtime fatal, 3 shutdown hung', () => {
    expect(EXIT_CODES).toEqual({ cleanShutdown: 0, failed: 1, runtimeFatal: 2, shutdownHung: 3 });
  });
});
