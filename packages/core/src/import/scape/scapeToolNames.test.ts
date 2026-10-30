import { describe, expect, it } from 'vitest';
import { renameScapeToolReferences, rewriteScapeToolReferences } from './scapeToolNames.js';

describe('rewriteScapeToolReferences', () => {
  it('turns the Scape prefix of a tool with an OpenFleet equivalent into the OpenFleet prefix', () => {
    const { text, renamedCount } = rewriteScapeToolReferences('Log with mcp__scape__insert_data_store_rows then `mcp__scape__update_data_store_row`.');

    expect(text).toBe('Log with mcp__openfleet__insert_data_store_rows then `mcp__openfleet__update_data_store_row`.');
    expect(renamedCount).toBe(2);
  });

  it('renames the log table tool of an imported manager mission to the OpenFleet tool', () => {
    const { text, unmappedToolNames } = rewriteScapeToolReferences('Bind your log with mcp__scape__set_argus_log_store.');

    expect(text).toBe('Bind your log with mcp__openfleet__set_argus_log_store.');
    expect(unmappedToolNames).toEqual([]);
  });

  it.each(['propose_law', 'propose_permission', 'request_resource_access', 'withdraw_proposal', 'get_argus_governance'])('renames the governance tool %s of an imported manager mission', (toolName) => {
    const { text, unmappedToolNames } = rewriteScapeToolReferences(`Call mcp__scape__${toolName} when a rule is missing.`);

    expect(text).toBe(`Call mcp__openfleet__${toolName} when a rule is missing.`);
    expect(unmappedToolNames).toEqual([]);
  });

  describe('a line that sends the manager to the status tool to read its mission', () => {
    it.each([
      ['Re-read your mission with mcp__scape__get_argus_status.', 'Re-read your mission with mcp__openfleet__get_manager_mission.'],
      ['Relis ta mission avec get_argus_status.', 'Relis ta mission avec get_manager_mission.'],
      ['Read your mission: `manager.missionText` of `get_argus_status`.', 'Read your mission: `get_manager_mission`.'],
      ['Your mission is in get_argus_status: manager.missionText.', 'Your mission is in get_manager_mission.'],
      ['Lis get_argus_status().manager.missionText au réveil.', 'Lis get_manager_mission au réveil.'],
      ['Your mission: `get_argus_status` → `manager.missionText`.', 'Your mission: `get_manager_mission`.'],
      ['The text is get_argus_status -> manager.missionText.', 'The text is get_manager_mission.'],
      ['Consulte la mission via mcp__scape__get_argus_status.', 'Consulte la mission via mcp__openfleet__get_manager_mission.'],
      ['Fetch the mission from get_argus_status at each wake.', 'Fetch the mission from get_manager_mission at each wake.'],
      ['The mission text is in manager.missionText of get_argus_status.', 'The mission text is in get_manager_mission.'],
    ])('points %j at get_manager_mission', (line, expected) => {
      const { text } = rewriteScapeToolReferences(line);

      expect(text).toBe(expected);
    });

    it.each([
      "Vérifie l'avancement de la mission et tes enfants avec get_argus_status.",
      'Check the progress of the mission and your children with mcp__scape__get_argus_status.',
      'The mission is long. Read the cap with get_argus_status.',
      'Compare manager.missionText of the old copy, then call get_argus_status for your cap.',
      'Read the mission note, then check your children with get_argus_status.',
      'Read the mission note; check your children with get_argus_status.',
      'Use read-only access to the mission through get_argus_status.',
    ])('leaves the status tool alone on %j, which speaks of the mission without reading it from the tool', (line) => {
      const { text } = rewriteScapeToolReferences(line);

      expect(text).not.toContain('get_manager_mission');
      expect(text).toContain('get_argus_status');
    });

    it('removes manager.missionText only right before the status tool, not elsewhere on the line', () => {
      const { text } = rewriteScapeToolReferences('Compare manager.missionText of the old copy with manager.missionText of get_argus_status.');

      expect(text).toBe('Compare manager.missionText of the old copy with get_manager_mission.');
    });

    describe('on a very long line', () => {
      const LONG_LINE_BYTES = 100_000;
      const FAST_ENOUGH_MS = 200;
      const durationOfRewriting = (text: string) => {
        const startedAt = performance.now();
        const rewritten = rewriteScapeToolReferences(text).text;
        return { rewritten, milliseconds: performance.now() - startedAt };
      };

      it('rewrites a line of "read mission" repeated, without the status tool, in under 200 ms and leaves it as it is', () => {
        const line = 'read mission '.repeat(LONG_LINE_BYTES / 'read mission '.length);

        const { rewritten, milliseconds } = durationOfRewriting(line);

        expect(rewritten).toBe(line);
        expect(milliseconds).toBeLessThan(FAST_ENOUGH_MS);
      });

      it('rewrites a line with one "read", many "mission" and the status tool at the end in under 200 ms', () => {
        const line = `read ${'mission '.repeat(LONG_LINE_BYTES / 'mission '.length)}get_argus_status`;

        const { milliseconds } = durationOfRewriting(line);

        expect(milliseconds).toBeLessThan(FAST_ENOUGH_MS);
      });

      it('rewrites a line of "read mission" repeated that ends with the status tool in under 200 ms', () => {
        const line = `${'read mission '.repeat(LONG_LINE_BYTES / 'read mission '.length)}get_argus_status`;

        const { milliseconds } = durationOfRewriting(line);

        expect(milliseconds).toBeLessThan(FAST_ENOUGH_MS);
      });

      it('rewrites a status tool followed by a long run of spaces in under 200 ms', () => {
        const line = `get_argus_status${' '.repeat(LONG_LINE_BYTES * 12)}x`;

        const { rewritten, milliseconds } = durationOfRewriting(line);

        expect(rewritten).toBe(line);
        expect(milliseconds).toBeLessThan(FAST_ENOUGH_MS);
      });
    });

    it('does not follow a sentence cut over two lines (known limit)', () => {
      const { text } = rewriteScapeToolReferences('Read your mission\nwith get_argus_status.');

      expect(text).toBe('Read your mission\nwith get_argus_status.');
    });

    it('keeps the status tool on a line that does not speak of the mission', () => {
      const { text } = rewriteScapeToolReferences('Check your cap with mcp__scape__get_argus_status, then bare get_argus_status.');

      expect(text).toBe('Check your cap with mcp__openfleet__get_argus_status, then bare get_argus_status.');
    });

    it('rewrites only the lines that speak of the mission', () => {
      const { text } = rewriteScapeToolReferences('Read your mission with get_argus_status.\nCheck your children with get_argus_status.');

      expect(text).toBe('Read your mission with get_manager_mission.\nCheck your children with get_argus_status.');
    });
  });

  describe('renameScapeToolReferences, which rebuilds what an earlier import wrote for a law', () => {
    it('only renames the prefix of the status tool on a law that speaks of the mission', () => {
      const { text } = renameScapeToolReferences('Relis ta mission avec mcp__scape__get_argus_status.');

      expect(text).toBe('Relis ta mission avec mcp__openfleet__get_argus_status.');
    });
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
