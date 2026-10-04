export const ENTITY_NAMES = ['projects', 'notes', 'noteVersions', 'playbooks', 'dataStores', 'columns', 'views', 'rows', 'history', 'managers', 'workingStates'] as const;
export type EntityName = (typeof ENTITY_NAMES)[number];

export interface EntityCounts {
  expected: number;
  written: number;
  updated: number;
  alreadyPresent: number;
  /** Records left as they are because OpenFleet holds a foreign change or deleted the record. */
  conflict: number;
  /** The conflicts that are records the last import wrote and OpenFleet has since deleted: never written again. */
  deletedInOpenFleet: number;
  /** Records the last import wrote that the Scape source no longer holds: reported, never deleted from OpenFleet. */
  removedInScape: number;
  notConverted: number;
}

export interface ImportReport {
  dryRun: boolean;
  counts: Record<EntityName, EntityCounts>;
  projectsWithoutDocsFolder: string[];
  unconvertedNodeTypes: Record<string, number>;
  /** Playbook mentions in manager missions that have no native resource to resolve. */
  pendingPlaybookMentions: number;
  /** Sections of the manager state files that are no working state section and were folded into one under their heading. */
  mergedStateSections: number;
  reportPath?: string;
}

export const emptyCounts = (): EntityCounts => ({ expected: 0, written: 0, updated: 0, alreadyPresent: 0, conflict: 0, deletedInOpenFleet: 0, removedInScape: 0, notConverted: 0 });

/** What a record write came to; a record deleted in OpenFleet is a conflict of its own kind. */
export type RecordOutcome = 'written' | 'updated' | 'alreadyPresent' | 'conflict' | 'deletedInOpenFleet';

export function countOutcome(counts: EntityCounts, outcome: RecordOutcome, amount = 1): void {
  const isDeletedInOpenFleet = outcome === 'deletedInOpenFleet';
  counts[isDeletedInOpenFleet ? 'conflict' : outcome] += amount;
  if (isDeletedInOpenFleet) counts.deletedInOpenFleet += amount;
}

export const emptyReport = (input: { dryRun: boolean }): ImportReport => ({
  dryRun: input.dryRun,
  counts: Object.fromEntries(ENTITY_NAMES.map((name) => [name, emptyCounts()])) as Record<EntityName, EntityCounts>,
  projectsWithoutDocsFolder: [],
  unconvertedNodeTypes: {},
  pendingPlaybookMentions: 0,
  mergedStateSections: 0,
});

const countsRow = (name: EntityName, counts: EntityCounts) =>
  `| ${name} | ${counts.expected} | ${counts.written} | ${counts.updated} | ${counts.alreadyPresent} | ${counts.conflict} | ${counts.deletedInOpenFleet} | ${counts.removedInScape} | ${counts.notConverted} |`;

export const hasChanges = (report: ImportReport): boolean =>
  ENTITY_NAMES.some((name) => report.counts[name].written + report.counts[name].updated > 0);

const bulletList = (items: string[]) => (items.length === 0 ? ['none'] : items.map((item) => `- ${item}`));

export function renderImportReport(report: ImportReport): string {
  const unconvertedNodeTypes = Object.entries(report.unconvertedNodeTypes).map(([type, count]) => `${type}: ${count}`);
  return [
    `# Scape import report${report.dryRun ? ' (dry run: nothing written)' : ''}`,
    '',
    '| entity | expected | written | updated | already present | conflict | of which deleted in OpenFleet | removed in Scape | not converted |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ENTITY_NAMES.map((name) => countsRow(name, report.counts[name])),
    '',
    'Updated: the record was changed in Scape and not in OpenFleet since the last import, so the Scape change is applied.',
    '',
    'Conflict: the record was changed in OpenFleet since the last import (edited, renamed, foreign history entry or note version) or deleted there, or OpenFleet holds a record of the same name that the import did not write; it is left as it is, and a record deleted in OpenFleet is never written again.',
    '',
    'Removed in Scape: the last import wrote the record and the Scape source no longer holds it; it stays in OpenFleet. Not counted by a run limited to one project.',
    '',
    'Not converted: notes and versions holding at least one lexical node without a markdown form; playbooks archived as inert text in one note per project (playbook counts follow the archive write outcome); kanban views whose card fields were dropped or that could not be mapped; rows holding a select value that is not one of the column options; log entries that changed nothing; managers whose mission note is outside the import or whose mission is unusable, whose model is not a known alias, or whose granted note or table is not imported.',
    '',
    '## Lexical node types not converted',
    ...bulletList(unconvertedNodeTypes),
    '',
    '## Playbook mentions — MIG-05 archives and native resolution',
    `${report.pendingPlaybookMentions} playbook mention(s) in manager missions have no native playbook resource to resolve. MIG-05 archives their authoring text as notes; native playbook mentions remain "not resolved".`,
    '',
    '## Working states',
    `${report.mergedStateSections} section(s) of the state files were merged into a working state section under a line carrying their heading. Not converted: a state file with an item cut, items dropped for the item limit or the size cap, or a manager whose own record was left as it is.`,
    '',
    '## Projects without a docs folder',
    ...bulletList(report.projectsWithoutDocsFolder),
    '',
  ].join('\n');
}
