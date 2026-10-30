import type { ManagerMissionReport } from './managerMissionReport.js';
import { emptyLawsReport, type LawsReport } from './scapeLaws.js';

export const ENTITY_NAMES = ['projects', 'notes', 'noteVersions', 'playbooks', 'dataStores', 'columns', 'views', 'rows', 'history', 'managers', 'workingStates', 'memories', 'laws'] as const;
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

export interface SourceLosses {
  orphanDatastoreFiles: string[];
  storesWithoutTables: string[];
  droppedColumnFormats: { columnId: string; format: string }[];
  droppedViewFields: { viewId: string; fields: string[] }[];
  /** A column field (required, config, display column, width, wrap) the source holds and OpenFleet cannot keep, with its source value. */
  droppedColumnMetadata: { columnId: string; field: string; value: string }[];
  /** An option color that is neither a hex color nor a standard CSS color name. */
  droppedOptionColors: { columnId: string; optionId: string; color: string }[];
}

export const emptySourceLosses = (): SourceLosses => ({
  orphanDatastoreFiles: [], storesWithoutTables: [], droppedColumnFormats: [], droppedViewFields: [], droppedColumnMetadata: [], droppedOptionColors: [],
});

export interface ImportReport extends SourceLosses {
  dryRun: boolean;
  counts: Record<EntityName, EntityCounts>;
  projectsWithoutDocsFolder: string[];
  unconvertedNodeTypes: Record<string, number>;
  /** Playbook mentions in manager missions that have no native resource to resolve. */
  pendingPlaybookMentions: number;
  /** Scape tool references in manager missions: renamed to the OpenFleet tool, pointed at the playbook shims, or left because OpenFleet has no equivalent (name -> occurrences). */
  missionToolReferences: { renamed: number; pointedAtPlaybookShims: number; withoutEquivalent: Record<string, number> };
  /** Sections of the manager state files that are no working state section and were folded into one under their heading. */
  mergedStateSections: number;
  /** One line per imported manager: what its mission holds that the shared manager base owns. Read-only: no mission is rewritten. */
  managerMissions: ManagerMissionReport[];
  /** One line per manager whose model or working state is not converted as the Scape card or state file says, led by the manager name. */
  managerFindings: string[];
  /** What the Scape laws came to: counts only, never a law text. */
  laws: LawsReport;
  reportPath?: string;
}

const WHITESPACE_AND_CONTROL_RUN = /[\p{C}\s]+/gu;
const MARKDOWN_SYNTAX_CHARACTER = /[\\`*_{}[\]<>#|]/g;

/** Returns the text as one line of inert Markdown: line breaks and control characters become a space, syntax characters are escaped. */
export const inlineMarkdownText = (text: string): string => text.replace(WHITESPACE_AND_CONTROL_RUN, ' ').trim().replace(MARKDOWN_SYNTAX_CHARACTER, '\\$&');

export function addManagerFinding(report: ImportReport, finding: { managerName: string; text: string }): void {
  report.managerFindings.push(`${inlineMarkdownText(finding.managerName)} — ${finding.text}`);
}

export const emptyCounts = ():EntityCounts => ({ expected: 0, written: 0, updated: 0, alreadyPresent: 0, conflict: 0, deletedInOpenFleet: 0, removedInScape: 0, notConverted: 0 });

/** What a record write came to; a record deleted in OpenFleet is a conflict of its own kind. */
export type RecordOutcome = 'written' | 'updated' | 'alreadyPresent' | 'conflict' | 'deletedInOpenFleet';

export function countOutcome(counts: EntityCounts, outcome: RecordOutcome, amount = 1): void {
  const isDeletedInOpenFleet = outcome === 'deletedInOpenFleet';
  counts[isDeletedInOpenFleet ? 'conflict' : outcome] += amount;
  if (isDeletedInOpenFleet) counts.deletedInOpenFleet += amount;
}

export const emptyReport = (input: { dryRun: boolean }): ImportReport => ({
  ...emptySourceLosses(),
  dryRun: input.dryRun,
  counts: Object.fromEntries(ENTITY_NAMES.map((name) => [name, emptyCounts()])) as Record<EntityName, EntityCounts>,
  projectsWithoutDocsFolder: [],
  unconvertedNodeTypes: {},
  pendingPlaybookMentions: 0,
  missionToolReferences: { renamed: 0, pointedAtPlaybookShims: 0, withoutEquivalent: {} },
  mergedStateSections: 0,
  managerMissions: [],
  managerFindings: [],
  laws: emptyLawsReport(),
});

const countsRow = (name: EntityName, counts: EntityCounts) =>
  `| ${name} | ${counts.expected} | ${counts.written} | ${counts.updated} | ${counts.alreadyPresent} | ${counts.conflict} | ${counts.deletedInOpenFleet} | ${counts.removedInScape} | ${counts.notConverted} |`;

export const hasChanges = (report: ImportReport): boolean =>
  ENTITY_NAMES.some((name) => report.counts[name].written + report.counts[name].updated > 0);

const bulletList = (items: string[]) => (items.length === 0 ? ['none'] : items.map((item) => `- ${item}`));

const yesOrNo = (flag: boolean) => (flag ? 'yes' : 'no');

function missionFindingsOf(mission: ManagerMissionReport): string[] {
  const name = inlineMarkdownText(mission.name);
  return [
    ...mission.numberedChildrenCaps.map((line) => `${name} — number of children: ${line}`),
    ...mission.exactModelIds.map((modelId) => `${name} — exact model id: ${modelId}`),
    ...mission.humanQaPhrases.map((line) => `${name} — QA for the human: ${line}`),
    ...mission.baseSectionDuplicates.map(({ sectionId, heading }) => `${name} — repeats ${sectionId} of the base: ${heading}`),
  ];
}

function lawsSection({ laws }: ImportReport): string[] {
  const perManagerRows = laws.perManager.map((entry) => `| ${entry.argus} | ${entry.approved} | ${entry.inserted} | ${entry.updated} | ${entry.conflict} | ${entry.alreadyPresent} |`);
  return [
    '## Laws',
    'Approved Scape laws of the imported managers, written to the laws table (the mission still holds them). An edited, withdrawn or deleted law is never overwritten, reactivated or written again.',
    `${laws.approvedInSource} approved; ignored: ${laws.skippedNotApproved.denied} denied, ${laws.skippedNotApproved.pending} pending, ${laws.invalidText} with a blank or too long text; ${laws.exactDuplicates} exact duplicate(s); keyed by request id: ${laws.keyedBy.requestId}, by text fingerprint: ${laws.keyedBy.fingerprint}.`,
    '',
    '| manager | approved | inserted | updated | conflict | already present |',
    '| --- | --- | --- | --- | --- | --- |',
    ...perManagerRows,
    '',
  ];
}

function managerMissionsSection(missions: ManagerMissionReport[]): string[] {
  const rows = missions.map((mission) => `| ${inlineMarkdownText(mission.name)} | ${mission.bytes} | ${yesOrNo(mission.isLegacyMission)} |`);
  return [
    '## Manager missions',
    'What each imported mission holds that the shared manager base owns. Nothing is rewritten: the missions are imported as they are.',
    '',
    '| manager | bytes | legacy mission (over 8192 bytes) |',
    '| --- | --- | --- |',
    ...rows,
    '',
    ...bulletList(missions.flatMap(missionFindingsOf)),
    '',
  ];
}

export function renderImportReport(report: ImportReport): string {
  const unconvertedNodeTypes = Object.entries(report.unconvertedNodeTypes).map(([type, count]) => `${type}: ${count}`);
  const toolsWithoutEquivalent = Object.entries(report.missionToolReferences.withoutEquivalent).map(([toolName, count]) => `${toolName}: ${count}`);
  const droppedColumnFormats = report.droppedColumnFormats.map(({ columnId, format }) => `${columnId}: ${format}`);
  const droppedViewFields = report.droppedViewFields.map(({ viewId, fields }) => `${viewId}: ${fields.join(', ')}`);
  const droppedColumnMetadata = report.droppedColumnMetadata.map(({ columnId, field, value }) => `${columnId}: ${field} = ${value}`);
  const droppedOptionColors = report.droppedOptionColors.map(({ columnId, optionId, color }) => `${columnId} / ${optionId}: ${color}`);
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
    'Not converted: notes and versions holding at least one lexical node without a markdown form; playbooks archived as inert text in one note per project (playbook counts follow the archive write outcome); columns whose display format, a setting or an option color is dropped; views whose settings are dropped or that cannot be mapped; rows holding a select value that is not one of the column options; log entries that changed nothing; managers whose mission note is outside the import or whose mission is unusable, whose model is not a known alias, or whose granted note or table is not imported.',
    '',
    '## Orphan datastore files — ignored',
    'These files have no project in the Scape project catalog. Their tables are not read or imported.',
    ...bulletList(report.orphanDatastoreFiles),
    '',
    '## Stores without a backing table',
    'The store definitions are imported; no rows can be read. An empty existing table is not listed here.',
    ...bulletList(report.storesWithoutTables),
    '',
    '## Column display formats not converted',
    'Values and column types are kept; the Scape display formats have no OpenFleet equivalent.',
    ...bulletList(droppedColumnFormats),
    '',
    '## Column settings not converted',
    'OpenFleet keeps required, config, display column, width and wrap when valid; a value it cannot hold (unknown or cyclic display column, width outside 60-1200, config it does not know, config on a non-number column, wrap lines without wrap) is left out.',
    ...bulletList(droppedColumnMetadata),
    '',
    '## Option colors not converted',
    'Hex colors are kept and standard CSS color names are converted to hex; any other color is left out.',
    ...bulletList(droppedOptionColors),
    '',
    '## View settings not converted',
    'OpenFleet keeps supported kanban grouping, card fields, title, column order and ungrouped settings. Unsupported or invalid source properties listed below are lost in whole or in part.',
    ...bulletList(droppedViewFields),
    '',
    '## Lexical node types not converted',
    ...bulletList(unconvertedNodeTypes),
    '',
    '## Playbook mentions — MIG-05 archives and native resolution',
    `${report.pendingPlaybookMentions} playbook mention(s) in manager missions have no native playbook resource to resolve. MIG-05 archives their authoring text as notes; native playbook mentions remain "not resolved".`,
    '',
    '## Scape tool references in manager missions',
    `${report.missionToolReferences.renamed} reference(s) renamed to the OpenFleet tool, ${report.missionToolReferences.pointedAtPlaybookShims} playbook tool reference(s) pointed at docs/playbook-shims.md. Left as they are, no OpenFleet equivalent:`,
    ...bulletList(toolsWithoutEquivalent),
    '',
    ...managerMissionsSection(report.managerMissions),
    '## Managers whose model or working state needs a look',
    ...bulletList(report.managerFindings),
    '',
    ...lawsSection(report),
    '## Working states',
    `${report.mergedStateSections} section(s) of the state files were merged into a working state section under a line carrying their heading. Not converted: a state file with an item cut, items dropped for the item limit or the size cap, or a manager whose own record was left as it is.`,
    '',
    '## Claude memory',
    'Counts are memory files (MEMORY.md and the topic files), copied to the Claude memory folder of the manager working directory. Not converted: a link, a file over the per-file or per-manager size cap, a memory folder that is a link, or a working directory whose Claude folder name the Claude CLI hashes.',
    '',
    '## Projects without a docs folder',
    ...bulletList(report.projectsWithoutDocsFolder),
    '',
  ].join('\n');
}
