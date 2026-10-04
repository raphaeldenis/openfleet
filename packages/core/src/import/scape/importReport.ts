export const ENTITY_NAMES = ['projects', 'notes', 'noteVersions', 'dataStores', 'columns', 'views', 'rows', 'history'] as const;
export type EntityName = (typeof ENTITY_NAMES)[number];

export interface EntityCounts {
  expected: number;
  written: number;
  updated: number;
  alreadyPresent: number;
  notConverted: number;
}

export interface ImportReport {
  dryRun: boolean;
  counts: Record<EntityName, EntityCounts>;
  projectsWithoutDocsFolder: string[];
  unconvertedNodeTypes: Record<string, number>;
  reportPath?: string;
}

export const emptyCounts = (): EntityCounts => ({ expected: 0, written: 0, updated: 0, alreadyPresent: 0, notConverted: 0 });

export const emptyReport = (input: { dryRun: boolean }): ImportReport => ({
  dryRun: input.dryRun,
  counts: Object.fromEntries(ENTITY_NAMES.map((name) => [name, emptyCounts()])) as Record<EntityName, EntityCounts>,
  projectsWithoutDocsFolder: [],
  unconvertedNodeTypes: {},
});

const countsRow = (name: EntityName, counts: EntityCounts) =>
  `| ${name} | ${counts.expected} | ${counts.written} | ${counts.updated} | ${counts.alreadyPresent} | ${counts.notConverted} |`;

const bulletList = (items: string[]) => (items.length === 0 ? ['none'] : items.map((item) => `- ${item}`));

export function renderImportReport(report: ImportReport): string {
  const unconvertedNodeTypes = Object.entries(report.unconvertedNodeTypes).map(([type, count]) => `${type}: ${count}`);
  return [
    `# Scape import report${report.dryRun ? ' (dry run: nothing written)' : ''}`,
    '',
    '| entity | expected | written | updated | already present | not converted |',
    '| --- | --- | --- | --- | --- | --- |',
    ...ENTITY_NAMES.map((name) => countsRow(name, report.counts[name])),
    '',
    'Not converted: notes and versions holding at least one lexical node without a markdown form; kanban views whose card fields were dropped or that could not be mapped; rows holding a select value that is not one of the column options.',
    '',
    '## Lexical node types not converted',
    ...bulletList(unconvertedNodeTypes),
    '',
    '## Projects without a docs folder',
    ...bulletList(report.projectsWithoutDocsFolder),
    '',
  ].join('\n');
}
