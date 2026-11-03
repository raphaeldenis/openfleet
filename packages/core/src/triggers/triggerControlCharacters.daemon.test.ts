import { afterEach, describe, expect, it } from 'vitest';
import { startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** Right-to-left override: JSON leaves it as it is, and a reader shows the text after it backwards. */
const RLO = String.fromCharCode(0x202e);

const hostileTrigger = async () => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  const triggerId = await world.createArmedTrigger({
    title: `Alert${NUL}${ESC}[31m${RLO}evil`,
    conditions: [{ lhs: 'event.session.name', op: 'contains', rhs: `bad${ESC}[0m${NUL}` }],
    run: { kind: 'prompt_manager', managerId: lead.id, prompt: `Look${NUL}${ESC}[2J here` },
  });
  return { world, lead, triggerId };
};

const textOfTool = async (client: Awaited<ReturnType<TriggerWorld['connect']>>, name: string, args: Record<string, unknown>) =>
  ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;

describe('control characters in a title, a value and a prompt', () => {
  it('are stored inert: the REST record keeps them in a value and a prompt, and a title loses only its NUL, which a text column cannot hold', async () => {
    const { world, triggerId } = await hostileTrigger();

    const record = await world.json<{ title: string; conditions: { rhs: string }[]; run: { prompt: string } }>(await world.api(`/api/triggers/${triggerId}`));

    expect(record.title).toBe(`Alert${ESC}[31m${RLO}evil`);
    expect(record.conditions[0]!.rhs).toBe(`bad${ESC}[0m${NUL}`);
    expect(record.run.prompt).toBe(`Look${NUL}${ESC}[2J here`);
  });

  it('are shown escaped by the tools an agent reads with, never raw', async () => {
    const { world, lead, triggerId } = await hostileTrigger();
    const client = await world.connect(lead.id);

    const one = await textOfTool(client, 'get_trigger', { trigger: triggerId });
    const all = await textOfTool(client, 'list_triggers', {});

    expect(one).not.toMatch(CONTROL_CHARACTER);
    expect(all).not.toMatch(CONTROL_CHARACTER);
    expect(one).not.toContain(RLO);
    expect(all).not.toContain(RLO);
    expect(one).toContain('\\\\u202e');
    expect(all).toContain('\\\\u202e');
  });

  it('do not reach the manager in the message of a fire', async () => {
    const { world, lead, triggerId } = await hostileTrigger();

    world.engine.submit({ triggerId, dedupKey: 'k', event: { session: { id: 'w', name: `bad${ESC}[0m${NUL}` } } });

    const [message] = world.messagesTo(lead.id);
    expect(message!.body).toContain('Look');
    expect(message!.body).not.toMatch(CONTROL_CHARACTER);
  });
});

describe('the bounds of a trigger as the REST API applies them', () => {
  const putRun = async (world: TriggerWorld, triggerId: string, run: unknown) =>
    world.api(`/api/triggers/${triggerId}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, run }) });

  it('refuses the inputs of a run_playbook that are too large or too deep, and accepts modest ones', async () => {
    const { world, triggerId } = await hostileTrigger();

    const tooLarge = await putRun(world, triggerId, { kind: 'run_playbook', playbookId: 'p', inputs: { text: 'x'.repeat(9000) } });
    const tooDeep = await putRun(world, triggerId, { kind: 'run_playbook', playbookId: 'p', inputs: { a: { b: { c: { d: { e: 1 } } } } } });
    const modest = await putRun(world, triggerId, { kind: 'run_playbook', playbookId: 'p', inputs: { ticket: 'CCM-1' } });

    expect([tooLarge.status, tooDeep.status, modest.status]).toEqual([400, 400, 200]);
  });

  it('refuses a cron expression or a time zone that is far too long', async () => {
    const { world, triggerId } = await hostileTrigger();
    const putWhen = (when: unknown) => world.api(`/api/triggers/${triggerId}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, when }) });

    const longExpression = await putWhen({ source: 'cron', expression: `${'1,'.repeat(5000)}1 * * * *`, timezone: 'Europe/Paris' });
    const longZone = await putWhen({ source: 'cron', expression: '* * * * *', timezone: `Europe/${'P'.repeat(5000)}` });

    expect([longExpression.status, longZone.status]).toEqual([400, 400]);
  });
});
