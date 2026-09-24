import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService, ApprovalError } from './approvalService.js';
import type { ServerEvent } from '@openfleet/shared';

function setup(timeoutMs = 50) {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('s1','G','/tmp','fake','generating','t','h','m','t')`).run();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { db, bus, events, service: new ApprovalService({ db, bus, timeoutMs }) };
}

describe('ApprovalService', () => {
  it('creates a pending approval, emits it, and resolves with the human decision', async () => {
    const { service, events } = setup();
    const pending = service.request({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf x' } });
    const created = events.find((e) => e.type === 'approval.created');
    expect(created && created.type === 'approval.created' && created.approval.status).toBe('pending');
    const id = service.listPending()[0]!.id;
    service.decide({ approvalId: id, behavior: 'allow' });
    await expect(pending).resolves.toBe('allow');
    expect(service.listPending()).toEqual([]);
  });

  it('falls back to ask on timeout and refuses a late decision', async () => {
    const { service } = setup(10);
    const pending = service.request({ sessionId: 's1', toolName: 'Bash', toolInput: {} });
    await expect(pending).resolves.toBe('ask');
    const id = (service as never as { lastId: string }).lastId;
    expect(() => service.decide({ approvalId: id, behavior: 'allow' })).toThrow(ApprovalError);
  });

  it('throws not_found for an unknown approval', () => {
    const { service } = setup();
    expect(() => service.decide({ approvalId: 'nope', behavior: 'deny' })).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });
});
