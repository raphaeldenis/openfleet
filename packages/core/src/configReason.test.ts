import { describe, expect, it } from 'vitest';
import { readableConfigReason } from './configReason.js';

describe('readableConfigReason', () => {
  it.each([
    ['a string', 'disk on fire', 'disk on fire'],
    ['undefined', undefined, 'unknown error'],
    ['null', null, 'unknown error'],
    ['an object without a message', { code: 7 }, 'unknown error'],
    ['an object with a message', { message: 'from an object' }, 'from an object'],
  ])('describes a thrown %s without printing "undefined"', (_name, thrown, expected) => {
    expect(readableConfigReason(thrown)).toBe(expected);
  });

  it('never quotes the config file content of a JSON syntax error', () => {
    const syntaxError = (() => { try { JSON.parse('{ "a": FAKESECRET }'); } catch (error) { return error; } })();

    const reason = readableConfigReason(syntaxError);

    expect(reason).not.toContain('FAKESECRET');
    expect(reason).toContain('not valid JSON');
  });

  it('names the position of a JSON syntax error when node reports one', () => {
    const syntaxError = (() => { try { JSON.parse('{ not json'); } catch (error) { return error; } })();

    expect(readableConfigReason(syntaxError)).toMatch(/not valid JSON at position \d+/);
  });
});
