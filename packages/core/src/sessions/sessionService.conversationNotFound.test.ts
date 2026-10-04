import type { ServerEvent } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from './sessionService.js';

const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;
const CLI_EXIT_CODE_OF_A_REFUSED_RESUME = 1;

function bootDaemon() {
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db: openDatabase(':memory:'), bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError });
  return { harness, service, events };
}

const closuresOf = (events: ServerEvent[]) => events.filter((event) => event.type === 'session.closed');
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function closedSessionWhoseResumeTheCliRefuses() {
  const daemon = bootDaemon();
  const session = await daemon.service.create(spec);
  daemon.harness.markPrompted(session.id);
  await daemon.service.close(session.id);
  daemon.harness.conversationsRefusedOnResume.add(session.id);
  daemon.events.length = 0;
  return { ...daemon, sessionId: session.id };
}

describe('a resume whose conversation the CLI says it cannot find', () => {
  it('ends the session closed with reason conversation_not_found, carried by the session.closed event', async () => {
    const { service, events, sessionId } = await closedSessionWhoseResumeTheCliRefuses();

    service.reopen(sessionId);
    await nextTick();

    expect(closuresOf(events)).toEqual([{ type: 'session.closed', sessionId, exitCode: CLI_EXIT_CODE_OF_A_REFUSED_RESUME, reason: 'conversation_not_found' }]);
    expect(service.get(sessionId)).toMatchObject({ state: 'closed', exitCode: CLI_EXIT_CODE_OF_A_REFUSED_RESUME });
  });

  it('leaves a resume that fails for another reason a harness_exit', async () => {
    const { harness, service, events, sessionId } = await closedSessionWhoseResumeTheCliRefuses();
    harness.conversationsRefusedOnResume.delete(sessionId);

    service.reopen(sessionId);
    harness.handles.at(-1)!.emitExit(CLI_EXIT_CODE_OF_A_REFUSED_RESUME);

    expect(closuresOf(events)).toMatchObject([{ reason: 'harness_exit' }]);
  });

  it('keeps closed_by_user when the user closes the session while the resume is refused', async () => {
    const { service, events, sessionId } = await closedSessionWhoseResumeTheCliRefuses();

    service.reopen(sessionId);
    await service.close(sessionId);
    await nextTick();

    expect(closuresOf(events)).toMatchObject([{ reason: 'closed_by_user' }]);
  });
});
