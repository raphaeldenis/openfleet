import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import type { CliResult } from '../importCli.js';
import { importKnowledge, type KnowledgeImportOptions } from './knowledgeImporter.js';
import { activateKnowledgeSnapshot } from './knowledgeActivation.js';
import { rejectedKnowledgeReport, renderKnowledgeReport } from './knowledgeImportReport.js';

const usage = 'usage: import knowledge --file <absolute.json> --mapping <absolute.json> --home <absolute-home> [--dry-run] [--final | --activate] [--mem02-acceptance <accepted-delivery-reference>] [--report-file <absolute.json>]\n';

export async function runKnowledgeImportCli(argv: string[]): Promise<CliResult> {
  let parsed: ReturnType<typeof parseKnowledgeArgs>;
  try { parsed = parseKnowledgeArgs(argv); }
  catch { return { exitCode: 2, output: renderKnowledgeReport(rejectedKnowledgeReport({ reason: 'INVALID_ARGUMENTS', dryRun: false })) }; }
  if (parsed.values.help) return { exitCode: 0, output: usage };
  const { values } = parsed;
  const validPaths = [values.home, values.file, values.mapping].every((value) => value !== undefined && isAbsolute(value));
  const reportPathIsAbsolute = values['report-file'] === undefined || isAbsolute(values['report-file']);
  const incompatibleFlags = Boolean(values.final && values.activate) || Boolean(values.activate && values['dry-run']);
  if (!validPaths || !reportPathIsAbsolute || parsed.positionals.length > 0 || incompatibleFlags) return { exitCode: 2, output: renderKnowledgeReport(rejectedKnowledgeReport({ reason: 'INVALID_ARGUMENTS', dryRun: values['dry-run'] ?? false })) };
  const options: KnowledgeImportOptions = { home: values.home!, file: values.file!, mappingFile: values.mapping!, reportFile: values['report-file'], dryRun: values['dry-run'] ?? false, final: values.final ?? false, mem02Acceptance: values['mem02-acceptance'] };
  const report = values.activate ? await activateKnowledgeSnapshot(options) : await importKnowledge(options);
  return { exitCode: report.success ? 0 : 1, output: renderKnowledgeReport(report) };
}

function parseKnowledgeArgs(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, options: { home: { type: 'string' }, file: { type: 'string' }, mapping: { type: 'string' }, 'report-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, final: { type: 'boolean' }, activate: { type: 'boolean' }, 'mem02-acceptance': { type: 'string' }, help: { type: 'boolean' } } });
}
