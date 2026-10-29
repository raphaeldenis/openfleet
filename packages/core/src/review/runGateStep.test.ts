import { describe, expect, it } from 'vitest';
import { runGateStep } from './runGateStep.js';

const MISSING_BINARY = 'openfleet-binary-that-does-not-exist';
const nodeScript = (script: string) => ({ file: process.execPath, args: ['-e', script], cwd: process.cwd() });

describe('runGateStep', () => {
  it('turns the gate red when the binary is missing', async () => {
    const verdict = await runGateStep({ file: MISSING_BINARY, args: ['--scan'], cwd: process.cwd() });

    expect(verdict).toEqual({ isPass: false, reason: 'command_not_found' });
  });

  it('passes a command that exits 0 and prints a report', async () => {
    expect(await runGateStep(nodeScript('console.log("12 passed")'))).toEqual({ isPass: true });
  });

  it('fails a command that exits non-zero even though it printed a report', async () => {
    expect(await runGateStep(nodeScript('console.log("2 failed"); process.exit(3)'))).toEqual({ isPass: false, reason: 'non_zero_exit', exitCode: 3 });
  });

  it('fails a command that prints nothing', async () => {
    expect(await runGateStep(nodeScript(''))).toEqual({ isPass: false, reason: 'empty_output' });
  });

  it('fails a command killed by its timeout', async () => {
    const verdict = await runGateStep({ ...nodeScript('setTimeout(() => {}, 60000)'), timeoutMs: 200 });

    expect(verdict).toEqual({ isPass: false, reason: 'no_exit_code' });
  });

  it('fails a command that prints a report, ignores SIGTERM and exits 0 after its timeout', async () => {
    const trappedTimeout = 'process.on("SIGTERM", () => process.exit(0)); console.log("12 passed"); setTimeout(() => {}, 60000)';

    const verdict = await runGateStep({ ...nodeScript(trappedTimeout), timeoutMs: 300 });

    expect(verdict).toEqual({ isPass: false, reason: 'no_exit_code' });
  });

  it('fails a command whose grandchild keeps the pipe open past the timeout', async () => {
    const verdict = await runGateStep({ file: 'sh', args: ['-c', 'sleep 3 & echo ok'], cwd: process.cwd(), timeoutMs: 300 });

    expect(verdict).toEqual({ isPass: false, reason: 'no_exit_code' });
  });

  it('settles shortly after the kill when a process that left the group keeps the pipe open', async () => {
    const leavesTheGroup = 'require("node:child_process").spawn("sleep", ["5"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref(); console.log("ok"); setTimeout(() => {}, 60000)';
    const startedAt = Date.now();

    const verdict = await runGateStep({ ...nodeScript(leavesTheGroup), timeoutMs: 200 });

    expect(verdict).toEqual({ isPass: false, reason: 'no_exit_code' });
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('closes the stdin of the command', async () => {
    const readsUntilEnd = 'process.stdin.on("data", () => {}); process.stdin.on("end", () => console.log("stdin closed"))';

    expect(await runGateStep({ ...nodeScript(readsUntilEnd), timeoutMs: 5000 })).toEqual({ isPass: true });
  });

  it('fails a working directory that does not exist as cwd_not_found', async () => {
    const verdict = await runGateStep({ file: process.execPath, args: ['-e', 'console.log("ok")'], cwd: '/openfleet/directory/that/does/not/exist' });

    expect(verdict).toEqual({ isPass: false, reason: 'cwd_not_found' });
  });

  it('hides the environment of the daemon from the command', async () => {
    const secretName = `OPENFLEET_FAKE_${'SECRET'}_${Date.now()}`;
    process.env[secretName] = 'visible';
    const printsTheVariable = `console.log(process.env[${JSON.stringify(secretName)}] === undefined ? "hidden" : "leaked")`;
    const isHidden = (stdout: string) => stdout.trim() === 'hidden';

    const verdict = await runGateStep({ ...nodeScript(printsTheVariable), isReportParsable: isHidden });
    delete process.env[secretName];

    expect(verdict).toEqual({ isPass: true });
  });

  it('passes the variables the caller names in env', async () => {
    const printsTheVariable = 'console.log(process.env.OPENFLEET_GATE_INPUT)';
    const isNamedValue = (stdout: string) => stdout.trim() === 'given';

    const verdict = await runGateStep({ ...nodeScript(printsTheVariable), env: { OPENFLEET_GATE_INPUT: 'given' }, isReportParsable: isNamedValue });

    expect(verdict).toEqual({ isPass: true });
  });

  it('fails a report the caller cannot parse', async () => {
    const verdict = await runGateStep({ ...nodeScript('console.log("garbled")'), isReportParsable: (stdout) => stdout.startsWith('{') });

    expect(verdict).toEqual({ isPass: false, reason: 'unparsable_report' });
  });
});
