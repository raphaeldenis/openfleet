const SCAPE_TOOL_PREFIX = 'mcp__scape__';
const OPENFLEET_TOOL_PREFIX = 'mcp__openfleet__';
const PLAYBOOK_SHIMS_DOC = 'docs/playbook-shims.md';
const NOT_PART_OF_AN_IDENTIFIER = '(?<![A-Za-z0-9_])';

/** The Scape tools an OpenFleet tool answers, by the Scape name; the OpenFleet name follows the prefix. */
export const SCAPE_TOOL_RENAMES: Readonly<Record<string, string>> = Object.fromEntries([
  'add_data_store_column', 'append_to_note', 'close_session', 'create_data_store', 'create_data_store_view', 'create_note', 'create_session', 'create_worktree',
  'delete_data_store_row', 'delete_data_store_view', 'delete_note', 'describe_data_store', 'get_argus_status', 'get_note', 'get_note_version', 'get_session_status',
  'get_argus_governance', 'get_working_state', 'insert_data_store_rows', 'list_children', 'list_data_store_views', 'list_note_versions', 'list_notes', 'list_project_folders', 'list_projects',
  'list_row_changes', 'list_sessions', 'message_parent', 'move_note', 'propose_law', 'propose_permission', 'pulse_now', 'query_data_store', 'request_resource_access',
  'restore_note_version', 'search_notes', 'send_session_message', 'set_argus_log_store', 'withdraw_proposal', 'update_data_store_row', 'update_data_store_rows', 'update_data_store_view', 'update_note', 'update_note_section', 'update_session', 'update_working_state',
].map((toolName) => [toolName, toolName]));

const PLAYBOOK_ARCHIVE_POINTER = `the "Playbooks (ex-Scape)" note (see ${PLAYBOOK_SHIMS_DOC})`;
const PLAYBOOK_TOOL_POINTERS: Readonly<Record<string, string>> = {
  run_playbook: `a playbook shim script (see ${PLAYBOOK_SHIMS_DOC})`,
  get_playbook_run: `the exit status and output of the playbook shim script (see ${PLAYBOOK_SHIMS_DOC})`,
  get_playbook: PLAYBOOK_ARCHIVE_POINTER,
  list_playbooks: PLAYBOOK_ARCHIVE_POINTER,
};

const PLAYBOOK_TOOL_REFERENCE = new RegExp(`${NOT_PART_OF_AN_IDENTIFIER}(?:${SCAPE_TOOL_PREFIX})?(${Object.keys(PLAYBOOK_TOOL_POINTERS).join('|')})(?![A-Za-z0-9_])`, 'g');
const SCAPE_TOOL_REFERENCE = new RegExp(`${NOT_PART_OF_AN_IDENTIFIER}${SCAPE_TOOL_PREFIX}([A-Za-z0-9_]+)`, 'g');

const OPENFLEET_MISSION_TOOL = 'get_manager_mission';
const STATUS_TOOL_NAME = 'get_argus_status';
const STATUS_TOOL = `(?<scapePrefix>${SCAPE_TOOL_PREFIX})?${STATUS_TOOL_NAME}(?![A-Za-z0-9_])`;
const STATUS_TOOL_REFERENCE = new RegExp(`${NOT_PART_OF_AN_IDENTIFIER}${STATUS_TOOL}`, 'g');
const MISSION_FIELD = '`?manager\\.missionText`?';
const MISSION_FIELD_RIGHT_BEFORE_STATUS_TOOL = new RegExp(`${MISSION_FIELD}\\s+(?:of|in|from)\\s+(?<openingBacktick>\`?)${NOT_PART_OF_AN_IDENTIFIER}${STATUS_TOOL}`, 'g');
const MISSION_FIELD_RIGHT_AFTER_STATUS_TOOL = new RegExp(`${NOT_PART_OF_AN_IDENTIFIER}${STATUS_TOOL}(?<closingBacktick>\`?)(?:\\(\\))?\\s*(?:(?::|→|->|\\.)\\s*)?${MISSION_FIELD}`, 'g');
const MISSION_READING_VERBS = ['read', 're-read', 'reread', 'fetch', 'lis', 'lisez', 'lire', 'relis', 'relisez', 'relire', 'consulte', 'consulter'];
const SENTENCE_END_OR_CLAUSE_BREAK = '.!?,;\\n';
const MAX_CHARACTERS_BETWEEN_SENTENCE_PARTS = 300;
const WITHIN_THE_SENTENCE = `[^${SENTENCE_END_OR_CLAUSE_BREAK}]{0,${MAX_CHARACTERS_BETWEEN_SENTENCE_PARTS}}`;
const SENTENCE_READING_THE_MISSION_UP_TO_STATUS_TOOL = new RegExp(
  `\\b(?:${MISSION_READING_VERBS.join('|')})\\b(?!-)${WITHIN_THE_SENTENCE}\\bmission\\b${WITHIN_THE_SENTENCE}?${NOT_PART_OF_AN_IDENTIFIER}${STATUS_TOOL}`,
  'gi',
);

interface StatusToolMatchGroups { scapePrefix?: string; openingBacktick?: string; closingBacktick?: string }
const groupsOf = (replaceArguments: unknown[]) => replaceArguments.at(-1) as StatusToolMatchGroups;

const missionToolWrittenLike = ({ scapePrefix }: StatusToolMatchGroups) => `${scapePrefix === undefined ? '' : OPENFLEET_TOOL_PREFIX}${OPENFLEET_MISSION_TOOL}`;

const pointStatusToolOfSentence = (sentence: string) => sentence.replace(STATUS_TOOL_REFERENCE, (...replaceArguments) => missionToolWrittenLike(groupsOf(replaceArguments)));

function pointMissionReadsOfLine(line: string): string {
  const mentionsStatusTool = line.includes(STATUS_TOOL_NAME);
  if (!mentionsStatusTool) return line;
  return line
    .replace(MISSION_FIELD_RIGHT_BEFORE_STATUS_TOOL, (...replaceArguments) => {
      const groups = groupsOf(replaceArguments);
      return `${groups.openingBacktick}${missionToolWrittenLike(groups)}`;
    })
    .replace(MISSION_FIELD_RIGHT_AFTER_STATUS_TOOL, (...replaceArguments) => {
      const groups = groupsOf(replaceArguments);
      return `${missionToolWrittenLike(groups)}${groups.closingBacktick}`;
    })
    .replace(SENTENCE_READING_THE_MISSION_UP_TO_STATUS_TOOL, pointStatusToolOfSentence);
}

/** Returns the text with, on mission lines, get_argus_status references written get_manager_mission: the forms that read `manager.missionText` from the status, and a sentence with a reading verb, "mission" and the tool. A sentence cut over two lines is not followed. */
function pointMissionReadsAtMissionTool(text: string): string {
  return text.split('\n').map(pointMissionReadsOfLine).join('\n');
}

export interface RewrittenToolReferences {
  text: string;
  renamedCount: number;
  playbookPointerCount: number;
  /** The name of each Scape tool reference left as it is because OpenFleet has no equivalent, once per occurrence. */
  unmappedToolNames: string[];
}

/** Rewrites the Scape tool references of a text to what an OpenFleet agent can call: renamed tools, playbook tools pointed at the shims, the rest left and listed. It does not point mission reads at get_manager_mission. */
export function renameScapeToolReferences(text: string): RewrittenToolReferences {
  let playbookPointerCount = 0;
  const withPlaybookPointers = text.replace(PLAYBOOK_TOOL_REFERENCE, (_reference, toolName: string) => {
    playbookPointerCount++;
    return PLAYBOOK_TOOL_POINTERS[toolName]!;
  });

  let renamedCount = 0;
  const unmappedToolNames: string[] = [];
  const withRenamedTools = withPlaybookPointers.replace(SCAPE_TOOL_REFERENCE, (reference, toolName: string) => {
    const openFleetToolName = Object.hasOwn(SCAPE_TOOL_RENAMES, toolName) ? SCAPE_TOOL_RENAMES[toolName] : undefined;
    if (openFleetToolName === undefined) {
      unmappedToolNames.push(toolName);
      return reference;
    }
    renamedCount++;
    return `${OPENFLEET_TOOL_PREFIX}${openFleetToolName}`;
  });

  return { text: withRenamedTools, renamedCount, playbookPointerCount, unmappedToolNames };
}

/** Rewrites the Scape tool references of a mission as `renameScapeToolReferences` does, after pointing its mission reads at get_manager_mission. */
export function rewriteScapeToolReferences(missionText: string): RewrittenToolReferences {
  return renameScapeToolReferences(pointMissionReadsAtMissionTool(missionText));
}
