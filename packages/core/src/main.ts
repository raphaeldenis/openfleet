const isImportCommand = process.argv[2] === 'import';

if (isImportCommand) {
  const { homedir } = await import('node:os');
  const { runImportCli } = await import('./import/importCli.js');
  const result = runImportCli(process.argv.slice(3), { homeDirectory: homedir(), env: process.env });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
} else {
  await import('./daemonEntry.js');
}
