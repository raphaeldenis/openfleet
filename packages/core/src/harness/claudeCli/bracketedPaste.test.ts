import { describe, expect, it } from 'vitest';
import { frameForPaste } from './bracketedPaste.js';

describe('frameForPaste', () => {
  it('wraps the body between the bracketed-paste start and end sequences', () => {
    expect(frameForPaste('hello')).toBe('\x1b[200~hello\x1b[201~');
  });

  it('strips every ESC byte the body carries, so an embedded paste-end sequence cannot close the paste early', () => {
    const bodyWithEmbeddedPasteEnd = 'before\x1b[201~after\r malicious';

    const framed = frameForPaste(bodyWithEmbeddedPasteEnd);

    expect(framed).toBe('\x1b[200~before[201~after malicious\x1b[201~');
    expect(framed.split('\x1b')).toHaveLength(3); // only the two framing ESC bytes survive
  });

  it('strips C0 and C1 control characters the terminal could interpret as keystrokes or escape introducers', () => {
    const bodyWithControlCharacters = 'a\x03b\rc\x9bd\x7fe\x00f\x08g\x0bh\x1fi\x80j\x9fk';

    expect(frameForPaste(bodyWithControlCharacters)).toBe('\x1b[200~abcdefghijk\x1b[201~');
  });

  it('transmits no control byte but the two framing ESC bytes for a hostile body', () => {
    const hostileBody = 'x\x1b[201~\x1b]0;title\x07\x00\x9b2~\r\ny\x03';

    const framed = frameForPaste(hostileBody);

    const body = framed.slice('\x1b[200~'.length, -'\x1b[201~'.length);
    expect(body).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(framed.startsWith('\x1b[200~')).toBe(true);
    expect(framed.endsWith('\x1b[201~')).toBe(true);
  });

  it('keeps tabs, newlines and printable text including accents and emoji', () => {
    const body = 'ligne 1\n\tligne 2 é 🚀\nligne 3';

    expect(frameForPaste(body)).toBe(`\x1b[200~${body}\x1b[201~`);
  });
});
