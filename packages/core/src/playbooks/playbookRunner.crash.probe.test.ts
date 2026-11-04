import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_MAIN = join(CORE_ROOT, 'src', 'main.ts');
const BOOT_TIMEOUT_MS = 30_000;

const directories = createTempDirTracker();
const children: ChildProcess[] = [];
const orphanScriptPids: number[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of orphanScriptPids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  directories.removeAll();
});

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (what: string, isDone: () => boolean | Promise<boolean>, timeoutMs = BOOT_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await isDone())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(50);
  }
};
const freePort = () => new Promise<number>((resolve) => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });

interface BootedDaemon { child: ChildProcess; url: string; api: (path: string, init?: RequestInit) => Promise<Response> }

/** A real daemon process on the given home: the only way to see a `kill -9`, which no handler of the daemon can answer. */
async function bootDaemon(home: string, adminToken: string): Promise<BootedDaemon> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', SRC_MAIN], { cwd: CORE_ROOT, env: { ...process.env, OPENFLEET_HOME: home, OPENFLEET_PORT: String(port) } });
  children.push(child);
  let stdout = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; });
  await waitUntil('the daemon to listen', () => stdout.includes('listening'));
  const url = `http://127.0.0.1:${port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...init.headers } });
  return { child, url, api };
}

const killedWithSigkill = (child: ChildProcess) => new Promise<void>((resolve) => { child.once('close', () => resolve()); child.kill('SIGKILL'); });

describe('probe: a daemon killed with kill -9 in the middle of a step', () => {
  it('finds the run needs_review at the next boot and never starts the step again', async () => {
    const home = directories.make('playbook-crash-home-');
    const scriptRoot = directories.make('playbook-crash-scripts-');
    const markers = directories.make('playbook-crash-markers-');
    const adminToken = randomBytes(24).toString('hex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'admin.token'), adminToken, { mode: 0o600 });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ playbooks: { scriptRoots: [scriptRoot] } }));
    const script = join(scriptRoot, 'hang.sh');
    writeFileSync(script, `#!/bin/sh\nprintf '%s' "$$" > ${join(markers, 'pid')}\nprintf x >> ${join(markers, 'ran')}\nsleep 60\n`);
    chmodSync(script, 0o700);

    const first = await bootDaemon(home, adminToken);
    const project = await (await first.api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Crash' }) })).json() as { id: string };
    const playbook = await (await first.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: project.id, name: 'Hang', cells: [{ id: 'hang', kind: 'script', program: 'hang.sh' }] }) })).json() as { id: string };
    const { digest } = await (await first.api(`/api/playbooks/${playbook.id}/approval`)).json() as { digest: string };
    await first.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) });
    const started = await first.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({}) });
    const { id: runId } = await started.json() as { id: string };
    await waitUntil('the script to start', () => existsSync(join(markers, 'pid')) && existsSync(join(markers, 'ran')));
    orphanScriptPids.push(Number(readFileSync(join(markers, 'pid'), 'utf8')));

    await killedWithSigkill(first.child);
    const second = await bootDaemon(home, adminToken);
    const afterRestart = await (await second.api(`/api/playbook-runs/${runId}`)).json() as { status: string; errorCode: string; steps: { status: string; errorCode: string }[] };
    await sleepMs(1500);
    const startsOfTheScriptAfterRecovery = readFileSync(join(markers, 'ran'), 'utf8');
    const newRun = await second.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({}) });
    await waitUntil('the script of the new run to start', () => readFileSync(join(markers, 'ran'), 'utf8') === 'xx');
    orphanScriptPids.push(Number(readFileSync(join(markers, 'pid'), 'utf8')));

    expect(afterRestart.status).toBe('needs_review');
    expect(afterRestart.errorCode).toBe('interrupted');
    expect(afterRestart.steps.map((step) => [step.status, step.errorCode])).toEqual([['needs_review', 'interrupted']]);
    expect(startsOfTheScriptAfterRecovery).toBe('x');
    expect(newRun.status).toBe(202);
    await killedWithSigkill(second.child);
  }, 90_000);
});
