import { describe, expect, it } from 'vitest';
import { maskedActivityText, maskedStructureText, maskedTextOrJson } from './activityMasking.js';

// Built at run time: no token-shaped literal sits in the source.
const SECRET = ['plain', 'value', '0042'].join('-');

describe('masking the text of an activity row', () => {
  it('hides a secret flag whose name is split by a bidirectional character', () => {
    const masked = maskedActivityText(`run --to‮ken ${SECRET} --name keep`);

    expect(masked).not.toContain(SECRET);
    expect(masked).toContain('--name keep');
  });

  it('hides a secret flag whose name is split by a control character', () => {
    const masked = maskedActivityText(`run --pass\u0000word ${SECRET}`);

    expect(masked).not.toContain(SECRET);
  });
});

describe('masking a structure before it is serialized', () => {
  it('hides the whole quoted value of a secret flag held in a string', () => {
    const masked = maskedStructureText({ command: `deploy --token "first ${SECRET}" --name keep` });

    expect(masked).not.toContain(SECRET);
    expect(masked).toContain('--name keep');
  });

  it('hides the value of a key that names a credential, whatever it holds', () => {
    const masked = maskedStructureText({ apiKey: SECRET, nested: { password: [SECRET] }, count: 3 });

    expect(masked).not.toContain(SECRET);
    expect(JSON.parse(masked)).toMatchObject({ count: 3 });
  });

  it('answers a mark for a structure it cannot serialize and for a circular one', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(maskedStructureText(circular)).toContain('[circular]');
    expect(maskedStructureText({ big: 1n })).toBe('[unserializable]');
  });

  it('keeps a value that is not a secret as it was given', () => {
    expect(maskedStructureText({ title: 'Plan', tags: ['a', 'b'], done: false })).toBe('{"title":"Plan","tags":["a","b"],"done":false}');
  });
});

describe('masking a result text', () => {
  it('masks the strings of a JSON text one by one', () => {
    const masked = maskedTextOrJson(JSON.stringify({ body: `curl --token "first ${SECRET}"` }));

    expect(masked).not.toContain(SECRET);
  });

  it('masks a text that is not JSON as a whole', () => {
    const masked = maskedTextOrJson(`error invalid: --token ${SECRET}`);

    expect(masked).not.toContain(SECRET);
  });
});
