export const ENTITY_NAMES = ['projects', 'notes', 'noteVersions', 'playbooks', 'dataStores', 'columns', 'views', 'rows', 'history'] as const;
export type EntityName = (typeof ENTITY_NAMES)[number];

export interface EntityCounts {
  expected: number;
  written: number;
  updated: number;
  alreadyPresent: number;
  /** Records left as they are because OpenFleet holds a newer or foreign change. */
  conflict: number;
  notConverted: number;
}

export interface ImportReport {
  dryRun: boolean;
  counts: Record<EntityName, EntityCounts>;
  projectsWithoutDocsFolder: string[];
  unconvertedNodeTypes: Record<string, number>;
  reportPath?: string;
}

export const emptyCounts = (): EntityCounts => ({ expected: 0, written: 0, updated: 0, alreadyPresent: 0, conflict: 0, notConverted: 0 });

export const emptyReport = (input: { dryRun: boolean }): ImportReport => ({
  dryRun: input.dryRun,
  counts: Object.fromEntries(ENTITY_NAMES.map((name) => [name, emptyCounts()])) as Record<EntityName, EntityCounts>,
  projectsWithoutDocsFolder: [],
  unconvertedNodeTypes: {},
});

const countsRow = (name: EntityName, counts: EntityCounts) =>
  `| ${name} | ${counts.expected} | ${counts.written} | ${counts.updated} | ${counts.alreadyPresent} | ${counts.conflict} | ${counts.notConverted} |`;

export const hasChanges = (report: ImportReport): boolean =>
  ENTITY_NAMES.some((name) => report.counts[name].written + report.counts[name].updated > 0);

const bulletList = (items: string[]) => (items.length === 0 ? ['none'] : items.map((item) => `- ${item}`));

export function renderImportReport(report: ImportReport): string {
  const unconvertedNodeTypes = Object.entries(report.unconvertedNodeTypes).map(([type, count]) => `${type}: ${count}`);
  return [
    `# Scape import report${report.dryRun ? ' (dry run: nothing written)' : ''}`,
    '',
    '| entity | expected | written | updated | already present | conflict | not converted |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...ENTITY_NAMES.map((name) => countsRow(name, report.counts[name])),
    '',
    'Conflict: the record was changed in OpenFleet (newer row, foreign history entry or note version, higher note rev, renamed definition, deleted row) and is left as it is.',
    '',
    'Not converted: notes and versions holding at least one lexical node without a markdown form; playbooks archived as inert text in one note per project (playbook counts follow the archive write outcome); kanban views whose card fields were dropped or that could not be mapped; rows holding a select value that is not one of the column options; log entries that changed nothing.',
    '',
    '## Lexical node types not converted',
    ...bulletList(unconvertedNodeTypes),
    '',
    '## Projects without a docs folder',
    ...bulletList(report.projectsWithoutDocsFolder),
    '',
  ].join('\n');
}
