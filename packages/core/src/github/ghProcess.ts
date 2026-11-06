import { execFile } from 'node:child_process';
import { OpenFleetError } from '@openfleet/shared';
import type { z } from 'zod';

const GH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const GH_EXIT_CODE_AUTHENTICATION_REQUIRED = 4;
const OUTPUT_OVER_THE_BOUND = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

export interface GhProcessOptions {
  ghExecutable?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export const badOutput = (hint: string) => new OpenFleetError('gh_bad_output', 'the GitHub CLI answered something the daemon cannot read.', { hint });

/** What execFile reports: a string `code` for a system error, a number for an exit status, `killed` when the process was stopped. */
type GhProcessError = Error & { code?: string | number; killed?: boolean };

function ghFailureOf(error: GhProcessError): OpenFleetError {
  const isMissingBinary = error.code === 'ENOENT' || error.code === 'EACCES';
  if (isMissingBinary) return new OpenFleetError('gh_unavailable', 'the GitHub CLI is not available to the daemon.', { hint: 'install gh, or start the daemon from a shell where gh runs.' });
  const isOutputOverTheBound = error.code === OUTPUT_OVER_THE_BOUND;
  if (isOutputOverTheBound) return badOutput('gh printed more than the daemon reads; narrow the request.');
  if (error.killed) return new OpenFleetError('gh_timeout', 'the GitHub CLI took too long to answer.', { hint: 'the daemon polls again later.' });
  if (error.code === GH_EXIT_CODE_AUTHENTICATION_REQUIRED) return new OpenFleetError('gh_not_authenticated', 'the GitHub CLI is not signed in.', { hint: 'run `gh auth login` in a terminal.' });
  return badOutput('gh exited with an error; check the repository, the pull request number and your access.');
}

/** gh gets only PATH, HOME and non-interactive switches: the daemon environment never reaches it, and the daemon reads no token. */
function minimalGhEnvironment(): NodeJS.ProcessEnv {
  const { PATH, HOME } = process.env;
  return {
    ...(PATH === undefined ? {} : { PATH }),
    ...(HOME === undefined ? {} : { HOME }),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
}

/** Returns a function that runs gh with the given argument list (`execFile`, never a shell) and resolves with its stdout; failures are typed OpenFleetErrors. */
export function createGhRunner(options: GhProcessOptions = {}): (argv: string[]) => Promise<string> {
  const { ghExecutable = 'gh', timeoutMs = GH_TIMEOUT_MS, maxBufferBytes = MAX_OUTPUT_BYTES } = options;
  return (argv) =>
    new Promise((resolve, reject) => {
      const child = execFile(ghExecutable, argv, {
        env: minimalGhEnvironment(),
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: maxBufferBytes,
      }, (error, stdout) => (error ? reject(ghFailureOf(error)) : resolve(stdout)));
      child.stdin?.end();
    });
}

/** Parses gh's stdout as JSON and checks it against the schema; anything else is gh_bad_output. */
export function parseGhJson<Schema extends z.ZodTypeAny>(stdout: string, schema: Schema): z.output<Schema> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw badOutput('gh did not print JSON; update gh and retry.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw badOutput('gh printed JSON of an unexpected shape; update gh and retry.');
  return parsed.data;
}
