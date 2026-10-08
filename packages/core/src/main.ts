const isImportCommand = process.argv[2] === 'import';

if (isImportCommand) {
  const { homedir } = await import('node:os');
  const importArgs = process.argv.slice(3);
  const result = importArgs[0] === 'knowledge'
    ? await (await import('./import/knowledge/knowledgeImportCli.js')).runKnowledgeImportCli(importArgs.slice(1))
    : (await import('./import/importCli.js')).runImportCli(importArgs, { homeDirectory: homedir(), env: process.env });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
} else {
  await import('./daemonEntry.js');
}
