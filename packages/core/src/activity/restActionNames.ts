export interface RestActionName {
  action: string;
  /** The entity the route targets, its id read from the route parameter `idParam`. */
  entity?: { kind: string; idParam: string };
}

const NAMED_ROUTES: Readonly<Record<string, RestActionName>> = {
  'POST /api/approvals/:id/decide': { action: 'gate.decide', entity: { kind: 'approval', idParam: 'id' } },
  'POST /api/governance/proposals/:id/decide': { action: 'proposal.decide', entity: { kind: 'proposal', idParam: 'id' } },
  'PATCH /api/governance/laws/:id': { action: 'law.edit', entity: { kind: 'law', idParam: 'id' } },
  'POST /api/governance/laws/:id/withdraw': { action: 'law.withdraw', entity: { kind: 'law', idParam: 'id' } },
  'PUT /api/command-policy': { action: 'command_policy.save' },
  'PUT /api/secrets/:scopeKind/:scopeId/:name': { action: 'secret.set' },
  'DELETE /api/secrets/:scopeKind/:scopeId/:name': { action: 'secret.clear' },
  'POST /api/triggers/:id/arm': { action: 'trigger.arm', entity: { kind: 'trigger', idParam: 'id' } },
  'PUT /api/integrations/:id/view-config': { action: 'integration_view.propose', entity: { kind: 'integration', idParam: 'id' } },
  'POST /api/integrations/:id/view-config/approve': { action: 'integration_view.approve', entity: { kind: 'integration', idParam: 'id' } },
  'POST /api/triggers/:id/disarm': { action: 'trigger.disarm', entity: { kind: 'trigger', idParam: 'id' } },
};

/** The name a REST route goes by in the activity log: a semantic one for the routes above, `METHOD template` for the others. */
export const restActionOf = ({ method, template }: { method: string; template: string }): RestActionName =>
  NAMED_ROUTES[`${method} ${template}`] ?? { action: `${method} ${template}` };
