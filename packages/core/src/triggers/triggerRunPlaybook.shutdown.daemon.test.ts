import { afterEach, describe, expect, it } from 'vitest';
import { createGatedSecretStore, scriptCell, startPlaybookWorld, type GatedSecretStore, type PlaybookWorld } from './playbookWorld.testkit.js';

let secrets: GatedSecretStore;
let playbookWorld: PlaybookWorld | undefined;
afterEach(async () => { secrets?.releaseReads(); await playbookWorld?.close(); playbookWorld = undefined; });

const SECRET_NAME = 'API_TOKEN';
const settle = () => new Promise((resolve) => setImmediate(resolve));

const boot = async () => {
  secrets = createGatedSecretStore();
  playbookWorld = await startPlaybookWorld({ secretStore: secrets });
  return playbookWorld;
};

/** An approved playbook that uses a secret: its start waits for the store to answer before it writes the run. */
const createPlaybookWaitingForASecret = async (p: PlaybookWorld) => {
  p.writeScript('quick.sh', 'printf done');
  const playbook = await p.createApprovedPlaybook({ program: 'quick.sh', env: { [SECRET_NAME]: `{{secret:${SECRET_NAME}}}` } });
  await secrets.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, 'a-secret-value-long-enough-0123456789');
  return playbook;
};

const editTheCell = (p: PlaybookWorld, playbook: { id: string; contentRev: number }) =>
  p.world.api(`/api/playbooks/${playbook.id}`, {
    method: 'PUT',
    body: JSON.stringify({ expectedRev: playbook.contentRev, cells: [{ ...scriptCell('say', 'quick.sh', { [SECRET_NAME]: `{{secret:${SECRET_NAME}}}` }), args: ['--changed'] }] }),
  });

const startRun = (p: PlaybookWorld, playbookId: string) => {
  const started = p.world.daemon.playbookRunner.start({ playbookId, inputs: {}, actorKind: 'admin' });
  started.catch(() => {});
  return started;
};

describe('a run whose start waits for its secrets', () => {
  it('is refused, and writes no run, when the daemon stops during the wait', async () => {
    const p = await boot();
    const playbook = await createPlaybookWaitingForASecret(p);
    secrets.holdReads();
    const started = startRun(p, playbook.id);
    await secrets.untilAReadWaits();

    await p.world.daemon.playbookRunner.stop();
    secrets.releaseReads();

    await expect(started).rejects.toMatchObject({ code: 'playbook_run_busy' });
    expect(p.runRows()).toEqual([]);
  });

  it('is refused, and writes no run, when the playbook is edited during the wait', async () => {
    const p = await boot();
    const playbook = await createPlaybookWaitingForASecret(p);
    secrets.holdReads();
    const started = startRun(p, playbook.id);
    await secrets.untilAReadWaits();

    const edited = await editTheCell(p, playbook);
    secrets.releaseReads();

    expect(edited.status).toBe(200);
    await expect(started).rejects.toMatchObject({ code: 'playbook_unapproved' });
    expect(p.runRows()).toEqual([]);
  });

  it('is refused, and writes no run, when the playbook is edited and approved again at another digest during the wait', async () => {
    const p = await boot();
    const playbook = await createPlaybookWaitingForASecret(p);
    secrets.holdReads();
    const started = startRun(p, playbook.id);
    await secrets.untilAReadWaits();

    const edited = await editTheCell(p, playbook);
    await p.approve(playbook.id);
    secrets.releaseReads();

    expect(edited.status).toBe(200);
    await expect(started).rejects.toMatchObject({ code: 'playbook_conflict' });
    expect(p.runRows()).toEqual([]);
  });

  it('starts the run when nothing changed during the wait', async () => {
    const p = await boot();
    const playbook = await createPlaybookWaitingForASecret(p);
    secrets.holdReads();
    const started = startRun(p, playbook.id);
    await secrets.untilAReadWaits();

    secrets.releaseReads();

    await expect(started).resolves.toMatchObject({ playbookId: playbook.id, status: 'running' });
    await p.untilNoRunIsRunning();
    expect(p.runRows().map((run) => run.status)).toEqual(['succeeded']);
  });
});

describe('a fire of run_playbook that the daemon leaves before its run is journaled', () => {
  it('is reviewed, not replayed, after the restart: the real fire went through attempted while the runner had not answered', async () => {
    const p = await boot();
    const playbook = await createPlaybookWaitingForASecret(p);
    const triggerId = await p.world.createArmedTrigger({ run: { kind: 'run_playbook', playbookId: playbook.id } });
    secrets.holdReads();

    const result = p.world.engine.submit({ triggerId, dedupKey: 'k', event: { session: { id: 's1' } } });
    await secrets.untilAReadWaits();
    const stateWhileTheRunnerWaits = p.fireRowsOf(triggerId).map((fire) => fire.ledger_state);

    await p.world.restart();
    secrets.releaseReads();
    await settle();
    await settle();

    expect(result).toMatchObject({ outcome: 'fired', ledgerState: 'attempted' });
    expect(stateWhileTheRunnerWaits).toEqual(['attempted']);
    expect(p.fireRowsOf(triggerId)).toEqual([{ ledger_state: 'needs_review', settle_reason: 'interrupted', chain_depth: 1, run_id: null }]);
    expect(p.runRows()).toEqual([]);
  });
});
