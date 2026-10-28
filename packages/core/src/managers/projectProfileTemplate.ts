import type { AutoValue, ColumnFormat, ColumnType } from '@openfleet/shared';

export interface ColumnTemplate {
  displayName: string;
  columnType: ColumnType;
  format?: ColumnFormat;
  autoValue?: AutoValue;
  isNaturalKey?: boolean;
}

export interface TableTemplate {
  name: string;
  columns: ColumnTemplate[];
}

export const JOURNAL_TABLE: TableTemplate = {
  name: 'Manager journal',
  columns: [
    { displayName: 'Time', columnType: 'date', format: 'datetime', autoValue: 'created_at' },
    { displayName: 'Entry', columnType: 'text', format: 'longText' },
  ],
};

export const BACKLOG_TABLE: TableTemplate = {
  name: 'Manager backlog',
  columns: [
    { displayName: 'Ticket', columnType: 'text', isNaturalKey: true },
    { displayName: 'Title', columnType: 'text' },
    { displayName: 'Status', columnType: 'text' },
  ],
};

export const PROFILE_TABLES: readonly TableTemplate[] = [JOURNAL_TABLE, BACKLOG_TABLE];

/** What the manager asks the human for on each table of the skeleton. */
export const TABLE_ACCESS_REQUEST = { access: 'readWrite', role: 'manager table of the project skeleton' } as const;

export const missionNoteTitleOf = (managerName: string): string => `Mission - ${managerName}`;

export const MISSION_NOTE_BODY = [
  '# Mission',
  '',
  'Describe what this manager delivers for the project.',
  '',
  '## Tables',
  '',
  `- ${JOURNAL_TABLE.name}: the log of the manager.`,
  `- ${BACKLOG_TABLE.name}: the tickets the manager follows.`,
  '',
].join('\n');
