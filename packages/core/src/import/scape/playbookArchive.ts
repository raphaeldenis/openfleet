import type { DatabaseSync } from 'node:sqlite';
import type { ImportReport } from './importReport.js';
import { IMPORT_AUTHOR } from './scapeMappers.js';
import type { ScapePlaybook, ScapeProject } from './scapeSource.js';
import { REPORT_DIFFERENCE_AS_CONFLICT, upsertRecord, type RecordValues } from './scapeTarget.js';
import { scapeNotesDateToIso } from './scapeTime.js';

export interface PlannedPlaybookArchive { id: string; record: RecordValues; extra: { playbookCount: number } }

const SHIM_PATHS: Readonly<Record<string, string>> = {
  verify: 'scripts/verify.sh',
  'open-pr': 'scripts/open-pr.sh',
  'dev-servers': '~/Documents/scape-team/openfleet/dev-servers.sh',
  'dev-servers-stop': '~/Documents/scape-team/openfleet/dev-servers-stop.sh',
  'github-issue': '~/Documents/scape-team/openfleet/github-issue.sh',
  'qa-browser': '~/Documents/scape-team/openfleet/qa-browser.sh',
};

const escapeText = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const textBlock = (text: string): string => `<pre>${escapeText(text)}</pre>`;

type LexicalNode = { type?: string; text?: string; kind?: string; label?: string; args?: unknown; children?: LexicalNode[] };

function authoringBlocks(node: LexicalNode): string[] {
  if (node.type === 'playbook-inputs') return [];
  if (node.type === 'playbook-step') {
    const stepBody = JSON.stringify({ kind: node.kind, label: node.label, args: node.args }, null, 2);
    return [textBlock(stepBody)];
  }
  if (typeof node.text === 'string') return [textBlock(node.text)];
  return (node.children ?? []).flatMap(authoringBlocks);
}

function declaredSecretNames(playbook: ScapePlaybook): string[] {
  const declarations: unknown = JSON.parse(playbook.secrets);
  if (!Array.isArray(declarations)) return [];
  return declarations.filter((name): name is string => typeof name === 'string');
}

function playbookSection(playbook: ScapePlaybook, project: ScapeProject): string[] {
  const document = JSON.parse(playbook.lexicalContent) as { root: LexicalNode };
  const shimPath = project.name.toLowerCase() === 'openfleet' ? SHIM_PATHS[playbook.name] : undefined;
  const replacement = shimPath === undefined ? 'Replacement: follow-up required (no shim configured).' : `Replacement: ${shimPath}`;
  return [textBlock(playbook.name), replacement, '[non converti: playbook]', ...authoringBlocks(document.root), ''];
}

export function planPlaybookArchive(input: { project: ScapeProject; playbooks: ScapePlaybook[]; secretNames: string[] }): PlannedPlaybookArchive | undefined {
  if (input.playbooks.length === 0) return undefined;
  const secretNames = [...new Set([...input.secretNames, ...input.playbooks.flatMap(declaredSecretNames)])].sort();
  const body = [
    '# Playbooks (ex-Scape)', '',
    'Archived authoring text only. Steps are not converted or executed. Run outputs, history and secret values are excluded.', '',
    '## Secrets — to set as environment variables',
    ...secretNames.map(textBlock), '',
    ...input.playbooks.flatMap((playbook) => playbookSection(playbook, input.project)),
  ].join('\n');
  const dates = input.playbooks.map((playbook) => ({ created: scapeNotesDateToIso(playbook.createdAt), updated: scapeNotesDateToIso(playbook.updatedAt) }));
  const createdAt = dates.map((date) => date.created).sort()[0]!;
  const updatedAt = dates.map((date) => date.updated).sort().at(-1)!;
  return {
    id: `${input.project.id}@scape-playbooks`,
    record: { project_id: input.project.id, title: 'Playbooks (ex-Scape)', body_md: body, folder: null, rev: 1, shared: 0, created_at: createdAt, updated_at: updatedAt },
    extra: { playbookCount: input.playbooks.length },
  };
}

export function writePlaybookArchives(input: { db: DatabaseSync; archives: PlannedPlaybookArchive[]; report: ImportReport }): void {
  for (const archive of input.archives) {
    const outcome = upsertRecord(input.db, { table: 'notes', id: archive.id, record: archive.record, policy: REPORT_DIFFERENCE_AS_CONFLICT });
    const counts = input.report.counts.playbooks;
    counts.expected += archive.extra.playbookCount;
    counts.notConverted += archive.extra.playbookCount;
    counts[outcome] += archive.extra.playbookCount;
    if (outcome === 'conflict') continue;
    const versionRecord = {
      note_id: archive.id, rev: 1, body_md: archive.record.body_md!, author: IMPORT_AUTHOR,
      change_summary: 'playbooks archive', created_at: archive.record.updated_at!,
    };
    const versionOutcome = upsertRecord(input.db, { table: 'note_versions', id: `${archive.id}@rev1`, record: versionRecord, policy: REPORT_DIFFERENCE_AS_CONFLICT });
    input.report.counts.noteVersions.expected++;
    input.report.counts.noteVersions[versionOutcome]++;
    input.report.counts.noteVersions.notConverted++;
  }
}
