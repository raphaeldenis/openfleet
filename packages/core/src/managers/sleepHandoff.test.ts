import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ManagerRepository, sleepHandoffMessageId } from './managerRepository.js';
import { SLEEP_HANDOFF_TEXT, SleepHandoff } from './sleepHandoff.js';

const MANAGER_ID = 'lead';
const SWITCHED_AT = '2026-10-29T08:00:00.000Z';
const DELIVERED_AT = '2026-10-29T08:00:05.000Z';
const HANDOFF_MESSAGE_ID = sleepHandoffMessageId({ sessionId: MANAGER_ID, modeChangedAt: SWITCHED_AT });

interface SentMessage { sessionId: string; messageId?: string; body: string }

let managers: ManagerRepository;
let bus: EventBus;
let sent: SentMessage[];
let statusOfSend: 'delivered' | 'queued';
let managerState: 'idle' | 'closed';

const aSleepingManagerOwingItsHandoff = () => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', 'h', 'm', 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(MANAGER_ID);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(MANAGER_ID);
  managers = new ManagerRepository(db);
  managers.setMode({ sessionId: MANAGER_ID, mode: 'sleeping', at: SWITCHED_AT });
};

const startHandoff = () => {
  const handoff = new SleepHandoff({
    bus,
    sessions: {
      get: () => ({ state: managerState }) as never,
      sendMessage: (input: SentMessage) => { sent.push(input); return { status: statusOfSend, messageId: input.messageId ?? 'generated' }; },
    },
    managers,
    clock: () => DELIVERED_AT,
  });
  handoff.start();
};

beforeEach(() => {
  bus = new EventBus();
  sent = [];
  statusOfSend = 'queued';
  managerState = 'idle';
  aSleepingManagerOwingItsHandoff();
});

describe('the sleep handoff of a manager after the daemon restarts', () => {
  it('queues the message when it owes one and none exists', () => {
    startHandoff();

    expect(sent).toEqual([{ sessionId: MANAGER_ID, messageId: HANDOFF_MESSAGE_ID, body: SLEEP_HANDOFF_TEXT }]);
    expect(managers.get(MANAGER_ID)?.sleepHandoffPending).toBe(true);
  });

  it('lets the message that is still queued go, under the same id, without owing it any less', () => {
    statusOfSend = 'queued';

    startHandoff();

    expect(sent.map((message) => message.messageId)).toEqual([HANDOFF_MESSAGE_ID]);
    expect(managers.get(MANAGER_ID)?.sleepHandoffPending).toBe(true);
  });

  it('finishes the switch without a new message when the message was already delivered', () => {
    statusOfSend = 'delivered';

    startHandoff();

    expect(managers.get(MANAGER_ID)).toMatchObject({ sleepHandoffPending: false, sleepHandoffDeliveredAt: DELIVERED_AT });
  });

  it('sends nothing to a closed manager, and keeps owing it', () => {
    managerState = 'closed';

    startHandoff();

    expect(sent).toEqual([]);
    expect(managers.get(MANAGER_ID)?.sleepHandoffPending).toBe(true);
  });

  it('records the delivery when the queue types the message', () => {
    startHandoff();

    bus.emit({ type: 'message.delivered', sessionId: MANAGER_ID, messageId: HANDOFF_MESSAGE_ID });

    expect(managers.get(MANAGER_ID)).toMatchObject({ sleepHandoffPending: false, sleepHandoffDeliveredAt: DELIVERED_AT });
  });

  it('ignores the delivery of a handoff message of an earlier switch', () => {
    startHandoff();

    bus.emit({ type: 'message.delivered', sessionId: MANAGER_ID, messageId: sleepHandoffMessageId({ sessionId: MANAGER_ID, modeChangedAt: '2026-10-28T08:00:00.000Z' }) });

    expect(managers.get(MANAGER_ID)?.sleepHandoffPending).toBe(true);
  });

  it('owes nothing once the manager woke up before the message was delivered', () => {
    managers.setMode({ sessionId: MANAGER_ID, mode: 'watching', at: '2026-10-29T08:01:00.000Z' });

    startHandoff();

    expect(sent).toEqual([]);
    expect(managers.get(MANAGER_ID)?.sleepHandoffPending).toBe(false);
  });
});
