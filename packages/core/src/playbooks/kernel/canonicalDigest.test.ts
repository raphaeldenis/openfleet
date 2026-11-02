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

  it('writes an array element holding undefined as null, as JSON does', () => {
    expect(canonicalJsonOf([1, undefined, 3])).toBe('[1,null,3]');
  });

  it.each([
    ['a hole in the middle', [1, , 3]], // eslint-disable-line no-sparse-arrays
    ['only holes', new Array(2)],
    ['a trailing hole', Object.assign([1, 2], { length: 3 })],
  ])('refuses a sparse array (%s) with not_canonical_json instead of writing it as []', (_label, sparse) => {
    expect(codeOfThrown(() => canonicalJsonOf(sparse))).toBe('not_canonical_json');
  });

  describe('depth', () => {
    const nestedArrays = (depth: number): unknown => {
      let nested: unknown = [];
      for (let level = 1; level < depth; level += 1) nested = [nested];
      return nested;
    };
    const nestedObjects = (depth: number): unknown => {
      let nested: unknown = {};
      for (let level = 1; level < depth; level += 1) nested = { k: nested };
      return nested;
    };

    it('writes a structure nested 64 levels deep', () => {
      expect(canonicalJsonOf(nestedArrays(64))).toBe(`${'['.repeat(64)}${']'.repeat(64)}`);
      expect(canonicalJsonOf(nestedObjects(64)).startsWith('{"k":{"k":')).toBe(true);
    });

    it.each([
      ['65 levels of arrays', nestedArrays(65)],
      ['65 levels of objects', nestedObjects(65)],
      ['100 000 levels of arrays', nestedArrays(100_000)],
    ])('refuses %s with not_canonical_json, not a RangeError', (_label, tooDeep) => {
      expect(codeOfThrown(() => canonicalJsonOf(tooDeep))).toBe('not_canonical_json');
    });
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
