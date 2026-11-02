import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { TOOL_CATALOG, TOOL_CATEGORIES, isMutatingTool, type ToolCategory } from './toolCatalog.js';

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

const registeredToolNames = async (): Promise<string[]> => {
  const client = await fixture.connect(fixture.lead.id);
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
};

describe('the tool catalog', () => {
  it('has an entry for every tool a manager sees, so a new tool cannot ship without a category', async () => {
    const registered = await registeredToolNames();

    const withoutEntry = registered.filter((name) => !(name in TOOL_CATALOG));

    expect(withoutEntry).toEqual([]);
  });

  it('has no entry for a tool that is not registered, so a removed tool leaves the catalog', async () => {
    const registered = new Set(await registeredToolNames());

    const staleEntries = Object.keys(TOOL_CATALOG).filter((name) => !registered.has(name));

    expect(staleEntries).toEqual([]);
  });

  it('gives each entry one of the known categories and a domain', () => {
    const entries = Object.entries(TOOL_CATALOG);

    const malformed = entries.filter(([, entry]) => !TOOL_CATEGORIES.includes(entry.category) || entry.domain.length === 0);

    expect(malformed).toEqual([]);
  });

  const toolsOfCategory = (category: ToolCategory) => Object.entries(TOOL_CATALOG).filter(([, entry]) => entry.category === category).map(([name]) => name).sort();

  it('classifies as destructive every tool that removes data or overwrites content or settings in place without history', () => {
    expect(toolsOfCategory('destructive')).toEqual([
      'add_data_store_column', // natural_key: true replaces the natural key of the store with no history
      'cancel_argus_event',
      'clear_playbook_secret', // removes the value of a secret from this device
      'close_session',
      'delete_data_store_column',
      'delete_data_store_row',
      'delete_data_store_view',
      'delete_note',
      'remove_worktree',
      'reorder_data_store_columns',
      'set_argus_log_store',
      'set_data_store_natural_key',
      'set_manager_profile',
      'unwatch_pr',
      'update_data_store_column',
      'update_data_store_view',
      'update_session',
      'update_working_state',
      'withdraw_proposal',
    ]);
  });

  it('classifies as execution_external every tool that runs git or a process, or delivers a message into a session', () => {
    expect(toolsOfCategory('execution_external')).toEqual([
      'create_session',
      'create_worktree',
      'message_argus',
      'message_parent',
      'pulse_now',
      'report_arbiter_opinion', // closes the arbiter session once its opinion is recorded
      'report_ship_verdict', // runs git in the worktree and messages the manager on a no-go
      'report_step_finding', // runs git in the worktree
      'send_session_message',
      'submit_plan_questions', // launches an arbiter session
    ]);
  });

  it('classifies a note move as additive, since it makes a new revision and keeps the history', () => {
    expect(TOOL_CATALOG['move_note']?.category).toBe('additive');
  });

  it('classifies tools that only read as read_only and tools that create or append as additive', () => {
    expect(TOOL_CATALOG['list_notes']?.category).toBe('read_only');
    expect(TOOL_CATALOG['query_data_store']?.category).toBe('read_only');
    expect(TOOL_CATALOG['create_note']?.category).toBe('additive');
    expect(TOOL_CATALOG['update_note']?.category).toBe('additive');
  });
});

describe('telling a mutating tool from a read', () => {
  it('counts every category but read_only as mutating', () => {
    expect(isMutatingTool('create_note')).toBe(true);
    expect(isMutatingTool('delete_note')).toBe(true);
    expect(isMutatingTool('send_session_message')).toBe(true);
    expect(isMutatingTool('list_notes')).toBe(false);
  });

  it('counts a tool the catalog does not know as mutating, so the log errs towards recording', () => {
    expect(isMutatingTool('a_tool_nobody_catalogued')).toBe(true);
  });
});
