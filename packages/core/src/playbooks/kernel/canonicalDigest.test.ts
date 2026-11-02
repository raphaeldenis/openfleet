import { describe, expect, it } from 'vitest';
import { canonicalDigestOf, canonicalJsonOf } from './canonicalDigest.js';
import { KernelError } from './kernelError.js';

const codeOfThrown = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof KernelError ? error.code : 'not_a_kernel_error';
  }
  return undefined;
};

describe('canonicalJsonOf', () => {
  it('sorts object keys at every depth and writes no whitespace', () => {
    const flow = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } };

    expect(canonicalJsonOf(flow)).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it('keeps the order of array elements', () => {
    expect(canonicalJsonOf([2, 1, 3])).toBe('[2,1,3]');
  });

  it('omits an object key holding undefined, as JSON does', () => {
    expect(canonicalJsonOf({ kept: 1, dropped: undefined })).toBe('{"kept":1}');
  });

  it('escapes strings the way JSON does', () => {
    expect(canonicalJsonOf({ text: 'line\n"quoted"' })).toBe('{"text":"line\\n\\"quoted\\""}');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 10n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['undefined at the root', undefined],
  ])('refuses %s with not_canonical_json', (_label, value) => {
    expect(codeOfThrown(() => canonicalJsonOf(value))).toBe('not_canonical_json');
  });

  it('refuses a cyclic structure instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(codeOfThrown(() => canonicalJsonOf(cyclic))).toBe('not_canonical_json');
  });
});

describe('canonicalDigestOf', () => {
  const approvedVersion = { cells: [{ id: 'build', kind: 'script', program: 'scripts/verify.sh' }], inputs: { branch: 'main' } };

  it('returns a lowercase sha256 hex digest', () => {
    expect(canonicalDigestOf(approvedVersion)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known sha256 of the canonical text (golden)', () => {
    expect(canonicalDigestOf({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  });

  it('is stable to the order of keys', () => {
    const sameVersionOtherKeyOrder = { inputs: { branch: 'main' }, cells: [{ program: 'scripts/verify.sh', kind: 'script', id: 'build' }] };

    expect(canonicalDigestOf(sameVersionOtherKeyOrder)).toBe(canonicalDigestOf(approvedVersion));
  });

  it.each([
    ['a changed string', { ...approvedVersion, inputs: { branch: 'main2' } }],
    ['a changed type', { ...approvedVersion, inputs: { branch: 1 } }],
    ['an added key', { ...approvedVersion, extra: true }],
    ['a reordered array', { ...approvedVersion, cells: [{ id: 'build', kind: 'script', program: 'scripts/verify.sh' }, { id: 'x' }].reverse() }],
    ['a changed nested value', { ...approvedVersion, cells: [{ id: 'build', kind: 'script', program: 'scripts/other.sh' }] }],
  ])('changes with %s', (_label, changed) => {
    expect(canonicalDigestOf(changed)).not.toBe(canonicalDigestOf(approvedVersion));
  });

  it('tells the number 1 from the string "1"', () => {
    expect(canonicalDigestOf({ v: 1 })).not.toBe(canonicalDigestOf({ v: '1' }));
  });
});
