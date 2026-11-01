export const TOOL_CATEGORIES = ['read_only', 'additive', 'destructive', 'execution_external'] as const;

/**
 * read_only: changes nothing.
 * additive: creates or appends, or edits a record that keeps its history.
 * destructive: removes data, or overwrites content or settings in place without history.
 * execution_external: runs git or a process, or delivers a message into a session.
 */
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export type ToolDomain = 'data_stores' | 'notes' | 'sessions' | 'managers' | 'governance' | 'escalation' | 'review' | 'worktrees' | 'projects' | 'knowledge' | 'working_state';

export interface ToolCatalogEntry {
  domain: ToolDomain;
  category: ToolCategory;
}

/** A tool the catalog does not know counts as mutating, so the activity log errs towards recording. */
export const isMutatingTool = (toolName: string): boolean => TOOL_CATALOG[toolName]?.category !== 'read_only';

/** Metadata for every MCP tool; a test fails when a registered tool has no entry. It enforces nothing. */
export const TOOL_CATALOG: Readonly<Record<string, ToolCatalogEntry>> = {
  add_data_store_column: { domain: 'data_stores', category: 'additive' },
  create_data_store: { domain: 'data_stores', category: 'additive' },
  create_data_store_view: { domain: 'data_stores', category: 'additive' },
  delete_data_store_column: { domain: 'data_stores', category: 'destructive' },
  delete_data_store_row: { domain: 'data_stores', category: 'destructive' },
  delete_data_store_view: { domain: 'data_stores', category: 'destructive' },
  describe_data_store: { domain: 'data_stores', category: 'read_only' },
  get_data_store: { domain: 'data_stores', category: 'read_only' },
  insert_data_store_rows: { domain: 'data_stores', category: 'additive' },
  list_data_store_views: { domain: 'data_stores', category: 'read_only' },
  list_row_changes: { domain: 'data_stores', category: 'read_only' },
  query_data_store: { domain: 'data_stores', category: 'read_only' },
  reorder_data_store_columns: { domain: 'data_stores', category: 'destructive' },
  set_data_store_natural_key: { domain: 'data_stores', category: 'destructive' },
  update_data_store_column: { domain: 'data_stores', category: 'destructive' },
  update_data_store_row: { domain: 'data_stores', category: 'additive' },
  update_data_store_rows: { domain: 'data_stores', category: 'additive' },
  update_data_store_view: { domain: 'data_stores', category: 'destructive' },

  append_to_note: { domain: 'notes', category: 'additive' },
  create_note: { domain: 'notes', category: 'additive' },
  delete_note: { domain: 'notes', category: 'destructive' },
  get_note: { domain: 'notes', category: 'read_only' },
  get_note_version: { domain: 'notes', category: 'read_only' },
  list_note_versions: { domain: 'notes', category: 'read_only' },
  list_notes: { domain: 'notes', category: 'read_only' },
  move_note: { domain: 'notes', category: 'destructive' },
  restore_note_version: { domain: 'notes', category: 'additive' },
  search_notes: { domain: 'notes', category: 'read_only' },
  update_note: { domain: 'notes', category: 'additive' },
  update_note_section: { domain: 'notes', category: 'additive' },

  close_session: { domain: 'sessions', category: 'destructive' },
  create_session: { domain: 'sessions', category: 'execution_external' },
  get_session_card: { domain: 'sessions', category: 'read_only' },
  get_session_status: { domain: 'sessions', category: 'read_only' },
  list_children: { domain: 'sessions', category: 'read_only' },
  list_sessions: { domain: 'sessions', category: 'read_only' },
  message_parent: { domain: 'sessions', category: 'execution_external' },
  send_session_message: { domain: 'sessions', category: 'execution_external' },
  update_session: { domain: 'sessions', category: 'destructive' },

  cancel_argus_event: { domain: 'managers', category: 'destructive' },
  get_argus_governance: { domain: 'managers', category: 'read_only' },
  get_argus_status: { domain: 'managers', category: 'read_only' },
  get_manager_base: { domain: 'managers', category: 'read_only' },
  get_manager_mission: { domain: 'managers', category: 'read_only' },
  list_argus_events: { domain: 'managers', category: 'read_only' },
  list_watched_prs: { domain: 'managers', category: 'read_only' },
  message_argus: { domain: 'managers', category: 'execution_external' },
  pulse_now: { domain: 'managers', category: 'execution_external' },
  schedule_argus_event: { domain: 'managers', category: 'additive' },
  set_argus_log_store: { domain: 'managers', category: 'destructive' },
  set_manager_profile: { domain: 'managers', category: 'destructive' },
  unwatch_pr: { domain: 'managers', category: 'destructive' },
  watch_pr: { domain: 'managers', category: 'additive' },

  list_denied_commands: { domain: 'governance', category: 'read_only' },
  propose_law: { domain: 'governance', category: 'additive' },
  propose_permission: { domain: 'governance', category: 'additive' },
  request_resource_access: { domain: 'governance', category: 'additive' },
  withdraw_proposal: { domain: 'governance', category: 'destructive' },

  approve_plan_criteria: { domain: 'escalation', category: 'additive' },
  report_arbiter_opinion: { domain: 'escalation', category: 'additive' },
  submit_plan_questions: { domain: 'escalation', category: 'additive' },

  report_ship_verdict: { domain: 'review', category: 'additive' },
  report_step_finding: { domain: 'review', category: 'additive' },

  create_worktree: { domain: 'worktrees', category: 'execution_external' },
  list_worktrees: { domain: 'worktrees', category: 'read_only' },
  remove_worktree: { domain: 'worktrees', category: 'destructive' },

  bootstrap_project_profile: { domain: 'projects', category: 'additive' },
  list_project_folders: { domain: 'projects', category: 'read_only' },
  list_projects: { domain: 'projects', category: 'read_only' },

  search_knowledge: { domain: 'knowledge', category: 'read_only' },

  get_working_state: { domain: 'working_state', category: 'read_only' },
  update_working_state: { domain: 'working_state', category: 'destructive' },
};
