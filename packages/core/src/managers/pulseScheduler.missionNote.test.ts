import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from '../sessions/sessionService.js';
import { ManagerRepository } from './managerRepository.js';
import { PULSE_MESSAGE, PulseScheduler } from './pulseScheduler.js';

const MISSION_NOTE_ID = 'note-mission-42';
const PULSE_SECONDS = 5;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

async function anIdleManager({ withMissionNote }: { withMissionNote: boolean }) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ managers, sessions, bus });
  const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
  sessions.applyInput(manager.id, { kind: 'hook', event: { session_id: manager.id, hook_event_name: 'SessionStart' } as never });
  managers.insert({ sessionId: manager.id, pulseSeconds: PULSE_SECONDS, childrenCap: 1, missionText: 'x', createdAt: CREATED_AT });
  if (withMissionNote) {
    new ProjectRepository(db).insert({ id: 'project', name: 'Fleet', docsFolderPath: null, createdAt: CREATED_AT });
    new NoteRepository(db).insert({ id: MISSION_NOTE_ID, projectId: 'project', title: 'Mission', bodyMd: '# Mission', folder: null, filePath: null, sourceHash: null, rev: 1, shared: false, createdAt: CREATED_AT, updatedAt: CREATED_AT });
    managers.setMissionNote(manager.id, MISSION_NOTE_ID);
  }
  scheduler.onManagerCreated(managers.get(manager.id)!);
  return { harness };
}

const pulseWrittenAfterOneInterval = (harness: FakeHarness) => {
  vi.advanceTimersByTime(PULSE_SECONDS * 1000);
  vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
  return harness.handles[0]!.written.find((entry) => entry.startsWith('[pulse]'));
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PulseScheduler: the pulse of a manager with a mission note', () => {
  it('tells the manager its mission note id and to read it with get_note', async () => {
    const { harness } = await anIdleManager({ withMissionNote: true });

    const pulse = pulseWrittenAfterOneInterval(harness);

    expect(pulse).toContain(`Your mission note id is ${MISSION_NOTE_ID}; read it every time you wake with get_note`);
  });

  it('keeps the plain pulse for a manager without a mission note', async () => {
    const { harness } = await anIdleManager({ withMissionNote: false });

    const pulse = pulseWrittenAfterOneInterval(harness);

    expect(pulse).toBe(PULSE_MESSAGE);
  });
});
