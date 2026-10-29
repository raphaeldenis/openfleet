import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { evaluateGateStep, type GateStepVerdict } from '@openfleet/shared';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
/** After the kill the step settles without waiting for a process that left the group and still holds the output pipe. */
const SETTLE_AFTER_KILL_MS = 250;
const INHERITED_VARIABLES = ['PATH', 'HOME'] as const;

export interface RunGateStepInput {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  /** Variables the command sees on top of PATH and HOME; the environment of the daemon is never passed on. */
  env?: Record<string, string>;
  /** Tells whether the report can be read; only the answer `true` counts. */
  isReportParsable?: (stdout: string) => boolean;
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function environmentOf(extra: Record<string, string> | undefined): Record<string, string> {
  const inherited = INHERITED_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]] as const]));
  return { ...Object.fromEntries(inherited), ...extra };
}

function killGroupOf(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
}

/**
 * Runs one command without a shell, in its own process group, with stdin closed and a minimal environment, and judges it.
 * A missing binary, a missing working directory, a spawn failure (such as EACCES), a signal, a timeout, a non-zero exit,
 * a blank output and an unreadable report all fail the step. On timeout the whole group gets SIGKILL and the step fails
 * whatever the command printed or exited with; it settles shortly after the kill even when a process that escaped the group keeps the pipe open.
 */
export function runGateStep({ file, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env, isReportParsable }: RunGateStepInput): Promise<GateStepVerdict> {
  if (!isDirectory(cwd)) return Promise.resolve({ isPass: false, reason: 'cwd_not_found' });

  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: environmentOf(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let wasStopped = false;
    let isSettled = false;

    let timer: NodeJS.Timeout;

    const settle = (outcome: { exitCode: number | null; notFound: boolean }) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      const exitCode = wasStopped ? null : outcome.exitCode;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      resolve(evaluateGateStep({ exitCode, notFound: outcome.notFound, stdout, isReportParsable }));
    };

    const stop = () => {
      wasStopped = true;
      killGroupOf(child.pid);
      setTimeout(() => settle({ exitCode: null, notFound: false }), SETTLE_AFTER_KILL_MS).unref();
    };
    timer = setTimeout(stop, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_REPORT_BYTES) return stop();
      stdoutChunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', (error: NodeJS.ErrnoException) => settle({ exitCode: null, notFound: error.code === 'ENOENT' }));
    child.on('close', (code) => settle({ exitCode: code, notFound: false }));
  });
}
