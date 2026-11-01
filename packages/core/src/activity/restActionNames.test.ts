import { describe, expect, it } from 'vitest';
import { restActionOf } from './restActionNames.js';

describe('naming a REST call for the activity log', () => {
  it.each([
    ['POST', '/api/approvals/:id/decide', 'gate.decide', 'approval'],
    ['POST', '/api/governance/proposals/:id/decide', 'proposal.decide', 'proposal'],
    ['PATCH', '/api/governance/laws/:id', 'law.edit', 'law'],
    ['POST', '/api/governance/laws/:id/withdraw', 'law.withdraw', 'law'],
  ])('names %s %s as %s on a %s', (method, template, action, entityKind) => {
    expect(restActionOf({ method, template })).toEqual({ action, entity: { kind: entityKind, idParam: 'id' } });
  });

  it('names the command policy save without an entity', () => {
    expect(restActionOf({ method: 'PUT', template: '/api/command-policy' })).toEqual({ action: 'command_policy.save' });
  });

  it('falls back to the method and the route template for a route it does not know', () => {
    expect(restActionOf({ method: 'DELETE', template: '/api/notes/:id' })).toEqual({ action: 'DELETE /api/notes/:id' });
  });

  it('does not take a GET of a known template for the mutation', () => {
    expect(restActionOf({ method: 'GET', template: '/api/governance/laws/:id' })).toEqual({ action: 'GET /api/governance/laws/:id' });
  });
});
