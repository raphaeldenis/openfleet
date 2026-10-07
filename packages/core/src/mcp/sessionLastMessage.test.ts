import { describe, expect, it } from 'vitest';
import { lastAssistantMessage } from './sessionLastMessage.js';

const assistantLine = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('lastAssistantMessage', () => {
  it('returns the newest assistant text while ignoring user and sidechain lines', () => {
    const tail = [assistantLine('First'), assistantLine('Latest'), JSON.stringify({ type: 'user', message: { content: 'Private prompt' } }), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: 'Sidechain' } }), 'invalid'].join('\n');
    expect(lastAssistantMessage(tail)).toBe('Latest');
    expect(lastAssistantMessage('')).toBeNull();
  });

  it('redacts credentials before bounding multibyte text to 8192 bytes', () => {
    const message = lastAssistantMessage(assistantLine('Bearer abcdefghijklmnop ' + 'é'.repeat(9000)))!;
    expect(message).not.toContain('abcdefghijklmnop');
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(8192);
    expect(message).not.toContain('�');
  });
});
