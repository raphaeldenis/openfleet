import { describe, expect, it } from 'vitest';
import { frameForPaste } from './bracketedPaste.js';

describe('frameForPaste', () => {
  it('wraps the body between the bracketed-paste start and end sequences', () => {
    expect(frameForPaste('hello')).toBe('\x1b[200~hello\x1b[201~');
  });

  it('strips every ESC byte the body carries, so an embedded paste-end sequence cannot close the paste early', () => {
    const bodyWithEmbeddedPasteEnd = 'before\x1b[201~after\r malicious';

    const framed = frameForPaste(bodyWithEmbeddedPasteEnd);

    expect(framed).toBe('\x1b[200~before[201~after\r malicious\x1b[201~');
    expect(framed.split('\x1b')).toHaveLength(3); // only the two framing ESC bytes survive
  });
});
