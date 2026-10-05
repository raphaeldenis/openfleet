import { describe, expect, it } from 'vitest';
import { rewriteScapeToolReferences } from './scapeToolNames.js';

describe('rewriteScapeToolReferences', () => {
  it('turns the Scape prefix of a tool with an OpenFleet equivalent into the OpenFleet prefix', () => {
    const { text, renamedCount } = rewriteScapeToolReferences('Log with mcp__scape__insert_data_store_rows then `mcp__scape__update_data_store_row`.');

    expect(text).toBe('Log with mcp__openfleet__insert_data_store_rows then `mcp__openfleet__update_data_store_row`.');
    expect(renamedCount).toBe(2);
  });

  it('leaves a tool name without the Scape prefix as it is', () => {
    const original = 'Call message_parent, create_session and mcp__repowise__get_overview.';

    const { text, renamedCount } = rewriteScapeToolReferences(original);

    expect(text).toBe(original);
    expect(renamedCount).toBe(0);
  });

  it('leaves a Scape tool with no OpenFleet equivalent and reports its name once per occurrence', () => {
    const { text, unmappedToolNames } = rewriteScapeToolReferences('See mcp__scape__list_triggers and mcp__scape__list_triggers, then mcp__scape__create_chart.');

    expect(text).toBe('See mcp__scape__list_triggers and mcp__scape__list_triggers, then mcp__scape__create_chart.');
    expect(unmappedToolNames).toEqual(['list_triggers', 'list_triggers', 'create_chart']);
  });

  it.each([
    ['mcp__scape__run_playbook', 'a playbook shim script'],
    ['run_playbook', 'a playbook shim script'],
    ['mcp__scape__get_playbook_run', 'the exit status and output of the playbook shim script'],
    ['get_playbook_run', 'the exit status and output of the playbook shim script'],
    ['mcp__scape__get_playbook', 'the "Playbooks (ex-Scape)" note'],
    ['list_playbooks', 'the "Playbooks (ex-Scape)" note'],
  ])('points %s at the playbook shims', (reference, expectedWording) => {
    const { text, playbookPointerCount, unmappedToolNames } = rewriteScapeToolReferences(`Use ${reference} for CI.`);

    expect(text).toContain(expectedWording);
    expect(text).toContain('docs/playbook-shims.md');
    expect(text).not.toContain('playbook_run');
    expect(playbookPointerCount).toBe(1);
    expect(unmappedToolNames).toEqual([]);
  });

  it('does not take a longer identifier for a playbook tool', () => {
    const original = 'Names like my_run_playbook_helper and run_playbooks_all stay.';

    const { text, playbookPointerCount } = rewriteScapeToolReferences(original);

    expect(text).toBe(original);
    expect(playbookPointerCount).toBe(0);
  });

  it('keeps every other character of the text, newlines and markdown included', () => {
    const original = '# Title\n\n- step one\n- call mcp__scape__get_note\n\n```\nmcp__scape__query_data_store\n```\n';

    const { text } = rewriteScapeToolReferences(original);

    expect(text).toBe(original.replaceAll('mcp__scape__', 'mcp__openfleet__'));
  });

  it('is idempotent: a text it already rewrote comes back unchanged', () => {
    const once = rewriteScapeToolReferences('mcp__scape__get_note and run_playbook').text;

    const twice = rewriteScapeToolReferences(once);

    expect(twice.text).toBe(once);
    expect(twice.renamedCount).toBe(0);
    expect(twice.playbookPointerCount).toBe(0);
  });
});
