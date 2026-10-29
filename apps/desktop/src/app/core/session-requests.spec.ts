import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Session } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { FleetEventsService } from './fleet-events.service';
import { SessionRequestsService } from './session-requests';

const SESSION_ID = 's1';

function sessionIn(state: Session['state'], patch: Partial<Session> = {}): Session {
  return { id: SESSION_ID, name: 'Gimli', emoji: '⚔️', directory: '/tmp', harness: 'fake', state, stateSince: 't', createdAt: 't', ...patch } as Session;
}

function setup(initialSession: Session) {
  const sessions = signal([initialSession]);
  TestBed.configureTestingModule({ providers: [{ provide: FleetEventsService, useValue: { sessions } }] });
  const requests = TestBed.inject(SessionRequestsService);
  TestBed.tick();
  const fail = async (kind: Parameters<SessionRequestsService['errorOf']>[1]) => {
    await requests.run({ sessionId: SESSION_ID, kind, message: 'it failed', action: () => Promise.reject(new Error('boom')) });
    TestBed.tick();
  };
  const report = (session: Session) => {
    sessions.set([session]);
    TestBed.tick();
  };
  return { requests, fail, report };
}

describe('SessionRequestsService failures', () => {
  it('keeps a close failure while the session stays open', async () => {
    const { requests, fail, report } = setup(sessionIn('idle'));

    await fail('close');
    report(sessionIn('generating'));

    expect(requests.errorOf(SESSION_ID, 'close')).toBe('it failed');
  });

  it('drops a close failure once the session is reported closed', async () => {
    const { requests, fail, report } = setup(sessionIn('idle'));

    await fail('close');
    report(sessionIn('closed'));

    expect(requests.errorOf(SESSION_ID, 'close')).toBeNull();
  });

  it('keeps a resume failure while the session stays closed', async () => {
    const { requests, fail, report } = setup(sessionIn('closed'));

    await fail('resume');
    report(sessionIn('closed'));

    expect(requests.errorOf(SESSION_ID, 'resume')).toBe('it failed');
  });

  it('drops a resume failure once the session lives again', async () => {
    const { requests, fail, report } = setup(sessionIn('closed'));

    await fail('resume');
    report(sessionIn('starting'));

    expect(requests.errorOf(SESSION_ID, 'resume')).toBeNull();
  });

  it('does not keep a resume failure recorded after the session was already reported alive', async () => {
    const { requests, fail, report } = setup(sessionIn('closed'));

    report(sessionIn('starting'));
    await fail('resume');

    expect(requests.errorOf(SESSION_ID, 'resume')).toBeNull();
  });

  it.each(['close', 'interrupt'] as const)('does not keep a %s failure recorded after the session was already reported closed', async (kind) => {
    const { requests, fail, report } = setup(sessionIn('idle'));

    report(sessionIn('closed'));
    await fail(kind);

    expect(requests.errorOf(SESSION_ID, kind)).toBeNull();
  });

  it('drops a model switch failure once the daemon reports another model', async () => {
    const { requests, fail, report } = setup(sessionIn('idle', { model: 'claude-sonnet-5-5' }));

    await fail('model');
    report(sessionIn('idle', { model: 'claude-opus-5-5' }));

    expect(requests.errorOf(SESSION_ID, 'model')).toBeNull();
  });
});
