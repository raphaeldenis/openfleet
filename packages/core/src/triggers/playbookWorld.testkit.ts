import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import type { SecretStore } from '../secrets/secretStore.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { PROJECT_ID, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A secret store whose reads wait for the test to let them through: a playbook start is held between its validation and its journal. */
export interface GatedSecretStore extends InMemorySecretStore {
  holdReads: () => void;
  releaseReads: () => void;
  untilAReadWaits: () => Promise<void>;
}

export const createGatedSecretStore = (): GatedSecretStore => {
  const inner = createInMemorySecretStore();
  let gate: Promise<void> = Promise.resolve();
  let openGate: (() => void) | undefined;
  let waitingReads = 0;
  const store: SecretStore = {
    ...inner,
    read: async (scope, name) => {
      if (openGate !== undefined) {
        waitingReads += 1;
        await gate;
      }
      return inner.read(scope, name);
    },
  };
  return {
    ...inner, ...store,
    holdReads: () => { gate = new Promise((resolve) => { openGate = resolve; }); },
    releaseReads: () => { openGate?.(); openGate = undefined; },
    untilAReadWaits: async () => { while (waitingReads === 0) await settle(); },
  };
};

export const scriptCell = (id: string, program: string, env: Record<string, string> = {}) => ({ id, kind: 'script', program, args: [], env });

/** A real daemon whose playbooks run scripts written under a throwaway script root, on the fake clock of the trigger world. */
export async function startPlaybookWorld({ secretStore }: { secretStore?: SecretStore } = {}) {
  const directories = createTempDirTracker();
  const scriptRoot = directories.make('trigger-playbook-scripts-');
  const world = await startTriggerWorld({ configJson: { playbooks: { scriptRoots: [scriptRoot] } }, ...(secretStore !== undefined && { secretStore }) });

  const writeScript = (name: string, body: string) => {
    const path = join(scriptRoot, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
  };

  /** A script that adds one row to a table through the REST API, the way a script the admin approved can: the daemon records the author as the human "You". */
  const writeRowWriterScript = (name: string, target: { storeId: string; columnId: string }) => {
    const request = 'fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.argv[2] }, body: process.argv[3] }).then((response) => process.exit(response.status === 201 ? 0 : 1))';
    const url = `${world.daemon.server.url}/api/data-stores/${target.storeId}/rows`;
    const body = JSON.stringify({ projectId: PROJECT_ID, rows: [{ [target.columnId]: 'written by a script' }] });
    writeScript(name, `exec "${process.execPath}" -e '${request}' '${url}' '${world.config.adminToken}' '${body}'`);
  };

  const createPlaybook = async ({ program = 'quick.sh', projectId = PROJECT_ID, inputs = [], env = {} }: { program?: string; projectId?: string; inputs?: unknown[]; env?: Record<string, string> } = {}) =>
    world.json<{ id: string; contentRev: number }>(await world.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId, name: 'P', inputs, cells: [scriptCell('say', program, env)] }) }));

  const approve = async (playbookId: string) => {
    const { digest } = await world.json<{ digest: string }>(await world.api(`/api/playbooks/${playbookId}/approval`));
    const approved = await world.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest }) });
    expect(approved.status).toBe(200);
  };

  const createApprovedPlaybook = async (options: Parameters<typeof createPlaybook>[0] = {}) => {
    const playbook = await createPlaybook(options);
    await approve(playbook.id);
    return playbook;
  };

  const runRows = () => world.db.prepare('SELECT id, playbook_id, status, started_at, ended_at FROM playbook_runs ORDER BY started_at, rowid').all() as unknown as { id: string; playbook_id: string; status: string; started_at: string; ended_at: string | null }[];
  const runsOf = (playbookId: string) => runRows().filter((run) => run.playbook_id === playbookId);
  const untilNoRunIsRunning = async () => { while (runRows().some((run) => run.status === 'running')) await settle(); };
  const untilRunsStarted = async (count: number) => { while (runRows().length < count) await settle(); };

  const fireRowsOf = (triggerId: string) =>
    world.db.prepare('SELECT ledger_state, settle_reason, chain_depth, run_id FROM trigger_fires WHERE trigger_id = ? ORDER BY fired_at, rowid').all(triggerId) as unknown as { ledger_state: string; settle_reason: string | null; chain_depth: number; run_id: string | null }[];
  const untilFiresLeaveAttempted = async (triggerId: string) => { while (fireRowsOf(triggerId).some((fire) => fire.ledger_state === 'attempted')) await settle(); };
  const offersSuppressedFor = (triggerId: string) =>
    (world.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'trigger.offer_suppressed' AND entity_id = ?").get(triggerId) as { n: number }).n;

  /** A trigger that starts the playbook when a row is added to the table. */
  const armTriggerOnNewRows = (storeId: string, playbookId: string) =>
    world.createArmedTrigger({ title: 'rows to playbook', when: { source: 'data_store_query', storeId, event: 'new_matching_rows' }, conditions: [], run: { kind: 'run_playbook', playbookId } });

  /** Moves the whole life of a run to the given dates, as if it had happened then. */
  const dateRun = (runId: string, dates: { startedAt: string; endedAt: string | null; status?: string }) =>
    world.db.prepare('UPDATE playbook_runs SET started_at = ?, ended_at = ?, status = COALESCE(?, status) WHERE id = ?').run(dates.startedAt, dates.endedAt, dates.status ?? null, runId);

  return {
    world, writeScript, writeRowWriterScript, createPlaybook, approve, createApprovedPlaybook, runRows, runsOf, untilNoRunIsRunning, untilRunsStarted,
    fireRowsOf, untilFiresLeaveAttempted, offersSuppressedFor, armTriggerOnNewRows, dateRun,
    close: async () => { await world.close(); directories.removeAll(); },
  };
}

export type PlaybookWorld = Awaited<ReturnType<typeof startPlaybookWorld>>;
export type { TriggerWorld };
