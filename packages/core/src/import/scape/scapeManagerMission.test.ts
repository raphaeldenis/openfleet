import { describe, expect, it } from 'vitest';
import type { ScapeGovernanceRequest } from './scapeArguses.js';
import { composeMission } from './scapeManagerMission.js';

const NOTE_BODY = '# Rules\n\nbe kind';
const NO_BOUND = { scope: '', condition: '', exclusions: '' };

const anApprovedRequest = (input: { kind: 'law' | 'permission'; text: string; createdAt?: number }): ScapeGovernanceRequest => ({
  id: `${input.kind}-${input.text}`, status: 'approved', createdAt: 0, ...NO_BOUND, ...input,
});

const composeWith = (input: { governanceRequests: ScapeGovernanceRequest[]; resourceGrants?: { resourceType: string; resourceId: string; access: string }[] }) =>
  composeMission({ noteBody: NOTE_BODY, governanceRequests: input.governanceRequests, resourceGrants: input.resourceGrants ?? [], availabilityOf: () => 'available' });

describe('composeMission and a note that sends the manager to the status tool for its mission', () => {
  it('writes get_manager_mission in the imported mission and keeps the other status reads', () => {
    const noteBody = '# Rules\n\nRelis ta mission avec mcp__scape__get_argus_status à chaque réveil.\nVérifie ton cap avec mcp__scape__get_argus_status.';

    const { text } = composeMission({ noteBody, governanceRequests: [], resourceGrants: [], availabilityOf: () => 'available' });

    expect(text).toBe('# Rules\n\nRelis ta mission avec mcp__openfleet__get_manager_mission à chaque réveil.\nVérifie ton cap avec mcp__openfleet__get_argus_status.');
  });
});

describe('composeMission with a mission note, permissions and exposed resources that all speak of the mission', () => {
  it('points every mission read of the composed mission at get_manager_mission, the permissions included, and keeps the other status reads', () => {
    const noteBody = '# Rules\n\nRelis ta mission avec mcp__scape__get_argus_status.\nVérifie ton cap avec mcp__scape__get_argus_status.';
    const permission = anApprovedRequest({ kind: 'permission', text: 'Read your mission with mcp__scape__get_argus_status before any spawn.' });

    const { text } = composeMission({ noteBody, governanceRequests: [permission], resourceGrants: [{ resourceType: 'note', resourceId: 'n-1', access: 'read' }], availabilityOf: () => 'available' });

    expect(text).toBe([
      '# Rules',
      '',
      'Relis ta mission avec mcp__openfleet__get_manager_mission.',
      'Vérifie ton cap avec mcp__openfleet__get_argus_status.',
      '',
      '## Laws',
      '',
      '### Permissions',
      '- Read your mission with mcp__openfleet__get_manager_mission before any spawn.',
      '',
      '## Exposed Resources',
      '- @note:n-1 (read)',
    ].join('\n'));
  });
});

describe('composeMission and a permission that uses the status tool without reading the mission', () => {
  it('keeps the status tool of the permission, with its prefix renamed', () => {
    const permission = anApprovedRequest({ kind: 'permission', text: 'Check your cap with mcp__scape__get_argus_status before any spawn.' });

    const { text } = composeMission({ noteBody: NOTE_BODY, governanceRequests: [permission], resourceGrants: [], availabilityOf: () => 'available' });

    expect(text).toContain('- Check your cap with mcp__openfleet__get_argus_status before any spawn.');
  });
});

describe('composeMission and the approved laws', () => {
  it('has neither a Laws section nor a Standing laws section when the Argus has only laws', () => {
    const { text } = composeWith({ governanceRequests: [anApprovedRequest({ kind: 'law', text: 'First law.' }), anApprovedRequest({ kind: 'law', text: 'Second law.' })] });

    expect(text).toBe(NOTE_BODY);
  });

  it('states a Laws section holding only the Permissions when the Argus has laws and permissions', () => {
    const { text } = composeWith({ governanceRequests: [anApprovedRequest({ kind: 'law', text: 'A law.' }), anApprovedRequest({ kind: 'permission', text: 'A permission.' })] });

    expect(text).toBe(`${NOTE_BODY}\n\n## Laws\n\n### Permissions\n- A permission.`);
    expect(text).not.toContain('A law.');
    expect(text).not.toContain('Standing laws');
  });

  it('is the note, the permissions and the exposed resources, byte for byte, whatever the laws', () => {
    const resourceGrants = [{ resourceType: 'note', resourceId: 'note-1', access: 'read' }];
    const permission = anApprovedRequest({ kind: 'permission', text: 'A permission.' });

    const withLaws = composeWith({ governanceRequests: [anApprovedRequest({ kind: 'law', text: 'A law.' }), permission], resourceGrants });
    const withoutLaws = composeWith({ governanceRequests: [permission], resourceGrants });

    expect(withLaws.text).toBe(`${NOTE_BODY}\n\n## Laws\n\n### Permissions\n- A permission.\n\n## Exposed Resources\n- @note:note-1 (read)`);
    expect(Buffer.from(withLaws.text, 'utf8').equals(Buffer.from(withoutLaws.text, 'utf8'))).toBe(true);
  });
});
