import { describe, expect, it } from 'vitest';
import { maskedActivityText } from './activityMasking.js';

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

  it('hides the whole value of a secret flag past an escaped double quote', () => {
    const masked = maskedActivityText(`cmd --password "safe\\" ${SECRET}" --name keep`);

    expect(masked).toBe('cmd --password *** --name keep');
  });

  it('hides the whole value of a secret flag glued from single-quoted segments', () => {
    const masked = maskedActivityText(`cmd --password 'safe'\\'' ${SECRET}' --name keep`);

    expect(masked).toBe('cmd --password *** --name keep');
  });

  it.each([
    ['a program', `echo ok\nmysql -p${SECRET} db`],
    ['a secret assignment', `echo ok\r\nAPI_KEY=${SECRET} run`],
    ['a flag value', `run --token\n${SECRET}`],
    ['a flag value after a tab', `run --token\t${SECRET}`],
  ])('hides the secret of %s, whose separator the stored text drops', (_label, text) => {
    expect(maskedActivityText(text)).not.toContain(SECRET);
  });
});

const repeatedTo = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

describe('the bound on the text masked', () => {
  const MASKED_TEXT_BOUND = 8 * 1024;
  // Masking shrinks this padding below the logger's own cut, so what sits at the bound reaches the stored text.
  const SHRINKING_PADDING_UNIT = `--token ${'y'.repeat(50)} `;
  const fakeSecret = (label: string) => [label, 'Qz7', 'Wx4', 'Kp9', 'Mv2'].join('');
  // Pads the text so that the bound falls `charsBeforeTheBound` characters into the secret.
  const textCutInsideTheSecret = (head: string, secret: string, charsBeforeTheBound: number) => {
    const padding = repeatedTo(SHRINKING_PADDING_UNIT, MASKED_TEXT_BOUND - head.length - charsBeforeTheBound - 1);
    return `${padding} ${head}${secret} --name tail`;
  };

  it.each([
    ['a flag value', '--password '],
    ['a quoted flag value past an escaped quote', '--password "safe\\" '],
    ['an assignment', 'API_KEY='],
    ['an authorization header', '-H "Authorization: Bearer '],
    ['URL credentials', 'git clone https://alice:'],
    ['a mysql password', 'mysql -p'],
  ])('never leaves readable the part of %s that precedes the bound', (_label, head) => {
    const secret = fakeSecret('cut');
    for (const charsBeforeTheBound of [4, 8, secret.length - 1, secret.length]) {
      const masked = maskedActivityText(textCutInsideTheSecret(head, secret, charsBeforeTheBound));

      expect(masked).not.toContain(secret.slice(0, charsBeforeTheBound));
    }
  });

  it('never leaves readable a well-known credential the bound cuts short', () => {
    const credential = ['gh', 'p_'].join('') + 'a1B2c3D4'.repeat(5);
    const charsBeforeTheBound = 12;

    const masked = maskedActivityText(textCutInsideTheSecret('push with ', credential, charsBeforeTheBound));

    expect(masked).not.toContain(credential.slice(0, charsBeforeTheBound));
  });

  it('masks a text no longer than the bound in full', () => {
    const secret = fakeSecret('whole');

    const masked = maskedActivityText(`${repeatedTo(SHRINKING_PADDING_UNIT, MASKED_TEXT_BOUND - 100)} --password ${secret} --name tail`);

    expect(masked).not.toContain(secret);
    expect(masked).toContain('--name tail');
  });
});

describe('the cost of masking an adversarial text', () => {
  const ADVERSARIAL_LENGTH = 100_000;
  const MAX_MILLISECONDS = 20;
  const MEASURES = 3;
  const fastestMilliseconds = (mask: () => unknown) => {
    let fastest = Number.POSITIVE_INFINITY;
    for (let measure = 0; measure < MEASURES; measure += 1) {
      const startedAt = performance.now();
      mask();
      fastest = Math.min(fastest, performance.now() - startedAt);
    }
    return fastest;
  };

  it.each([
    ['curl', 'curl '],
    ['mysql', 'mysql '],
    ['sshpass', 'sshpass '],
    ['redis-cli', 'redis-cli '],
    ['double quotes', '"'],
    ['single quotes', "'"],
    ['escaped double quotes', '\\"'],
    ['glued single quotes', "'a'\\'"],
    ['secret flags', '--token '],
    ['secret assignments', 'TOKEN='],
    ['URL schemes', 'a://b@'],
    ['header colons', 'token:'],
  ])('masks %s repeated over 100000 characters in under 20 ms', (_label, unit) => {
    const text = repeatedTo(unit, ADVERSARIAL_LENGTH);

    const milliseconds = fastestMilliseconds(() => maskedActivityText(text));

    expect(milliseconds).toBeLessThan(MAX_MILLISECONDS);
  });
});
