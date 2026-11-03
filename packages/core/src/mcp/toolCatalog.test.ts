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
      'delete_playbook',
      'delete_playbook_cell',
      'delete_trigger',
      'delete_trigger_condition',
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

  it('files the trigger tools under the triggers domain: reads are read_only, creates and edits additive, deletes destructive', () => {
    const triggerEntries = Object.entries(TOOL_CATALOG).filter(([, entry]) => entry.domain === 'triggers').map(([name, entry]) => [name, entry.category]);

    expect(triggerEntries.sort()).toEqual([
      ['add_trigger_condition', 'additive'], ['create_trigger', 'additive'], ['delete_trigger', 'destructive'], ['delete_trigger_condition', 'destructive'],
      ['get_trigger', 'read_only'], ['get_trigger_schema', 'read_only'], ['list_trigger_fires', 'read_only'], ['list_triggers', 'read_only'], ['set_trigger_policy', 'additive'],
      ['set_trigger_run', 'additive'], ['set_trigger_when', 'additive'], ['update_trigger_condition', 'additive'],
    ]);
  });

  it('files the playbook authoring and version tools under the playbooks domain: reads are read_only, creates, edits and restores additive, deletes destructive', () => {
    const authoringEntries = Object.entries(TOOL_CATALOG)
      .filter(([name, entry]) => entry.domain === 'playbooks' && !name.endsWith('_secret') && !name.endsWith('_secret_statuses'))
      .map(([name, entry]) => [name, entry.category]);

    expect(authoringEntries.sort()).toEqual([
      ['add_playbook_cell', 'additive'], ['create_playbook', 'additive'], ['delete_playbook', 'destructive'], ['delete_playbook_cell', 'destructive'],
      ['get_playbook', 'read_only'], ['get_playbook_schema', 'read_only'], ['get_playbook_version', 'read_only'], ['list_playbook_cells', 'read_only'], ['list_playbook_versions', 'read_only'],
      ['list_playbooks', 'read_only'], ['reorder_playbook_cells', 'additive'], ['restore_playbook_version', 'additive'], ['set_playbook_inputs', 'additive'], ['update_playbook_cell', 'additive'],
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
