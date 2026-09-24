import { describe, expect, it } from 'vitest';
import { FakeHarness } from './fakeHarness.js';

describe('FakeHarness', () => {
  it('records writes and replays data/exit to listeners', () => {
    const harness = new FakeHarness();
    const handle = harness.start({ sessionId: 's', directory: '/tmp', hookUrl: '', mcpUrl: '', mcpToken: '', displayName: 'x' });
    const seen: string[] = [];
    handle.onData((d) => seen.push(d));
    let exit = -1;
    handle.onExit((code) => (exit = code));
    handle.write('hello\r');
    harness.handles[0]!.emitData('ok');
    harness.handles[0]!.emitExit(0);
    expect(harness.handles[0]!.written).toEqual(['hello\r']);
    expect(seen).toEqual(['ok']);
    expect(exit).toBe(0);
  });
});
