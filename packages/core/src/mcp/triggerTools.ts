import {
  EVENT_PREFIXES_BY_SOURCE, MAX_TRIGGER_CONDITIONS, OpenFleetError, PROMPT_MANAGER_ALIAS, TRIGGER_BACKLOG_POLICIES, TRIGGER_BATCH_MODES, TRIGGER_CONDITION_JOINS,
  TRIGGER_CONDITION_OPERATORS, TRIGGER_LEDGER_STATES, TRIGGER_RUN_KINDS, TRIGGER_WHEN_SOURCES, TriggerConditionInputSchema, TriggerPolicySchema, TriggerRunSchema, TriggerWhenSchema,
  type Session, type TriggerCondition, type TriggerLedgerState,
} from '@openfleet/shared';
import type { FireLedger, TriggerFire } from '../triggers/fireLedger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { newId } from '../ids.js';
import type { TriggerRecord } from '../triggers/triggerRepository.js';
import type { TriggerService } from '../triggers/triggerService.js';
import { ok } from './toolResults.js';

const conditionView = (condition: TriggerCondition) => ({
  id: condition.id, lhs: condition.lhs, op: condition.op, ...(condition.rhs !== undefined && { rhs: condition.rhs }), join: condition.join, case_insensitive: condition.caseInsensitive,
});

/** A trigger as an agent reads it: the rule, its revision and whether a human armed it. */
export const triggerView = (trigger: TriggerRecord) => ({
  id: trigger.id, title: trigger.title, project_id: trigger.projectId, when: trigger.when, conditions: trigger.conditions.map(conditionView), run: trigger.run, policy: trigger.policy,
  content_rev: trigger.contentRev, armed: trigger.armedAt !== null, ...(trigger.armedAt !== null && { armed_at: trigger.armedAt, approved_rev: trigger.approvedRev }),
});

const FIELDS_BY_SOURCE = {
  session_state: { required: ['state'], optional: ['minutes (required unless state is closed_with_error)'] },
  silent_run: { required: ['minutes'], optional: [] },
  data_store_query: { required: ['storeId', 'event'], optional: ['op', 'value (op and value are required for row_count)'] },
  cron: { required: ['expression', 'timezone'], optional: ['catchUp'] },
  integration_records: { required: ['itemId', 'event'], optional: ['field (required for field_changed)'] },
} as const;

const FIELDS_BY_RUN_KIND = {
  prompt_manager: { required: ['prompt'], optional: ['managerId'] },
  notify: { required: ['title', 'message'], optional: [] },
  prompt_session: { required: ['sessionId', 'prompt'], optional: [] },
  close_session: { required: ['sessionId'], optional: [] },
  run_playbook: { required: ['playbookId'], optional: ['inputs'] },
} as const;

const triggerSchemaView = () => ({
  notes: 'A trigger is one WHEN source, 0..32 conditions, one RUN action and a policy. A new trigger starts with a session_state idle WHEN and a notify RUN. It cannot fire until a human arms it in the desktop app; every edit clears the arming.',
  when: { sources: TRIGGER_WHEN_SOURCES.map((source) => ({ source, ...FIELDS_BY_SOURCE[source], eventPrefixes: EVENT_PREFIXES_BY_SOURCE[source].map((prefix) => `${prefix}*`) })) },
  conditions: { fields: ['join', 'lhs', 'op', 'rhs', 'case_insensitive'], ops: [...TRIGGER_CONDITION_OPERATORS], joins: [...TRIGGER_CONDITION_JOINS], max: MAX_TRIGGER_CONDITIONS, notes: "The first condition's join is forced to 'and'. exists and not_exists ignore rhs. Consecutive 'and' rows bind; 'or' starts a new group. lhs must start with a prefix of the WHEN source." },
  run: { kinds: TRIGGER_RUN_KINDS.map((kind) => ({ kind, ...FIELDS_BY_RUN_KIND[kind] })), aliases: { [PROMPT_MANAGER_ALIAS]: 'prompt_manager' } },
  policy: {
    fields: ['cooldownSeconds', 'maxFiresPerDay', 'batchMode', 'backlogPolicy', 'backlogMaxAgeMinutes'],
    enums: { backlogPolicy: [...TRIGGER_BACKLOG_POLICIES].sort(), batchMode: [...TRIGGER_BATCH_MODES].sort() },
    defaults: TriggerPolicySchema.parse({}),
  },
});

const rhsSchema = z.union([z.string(), z.number(), z.boolean()]);
const triggerParameter = z.string().describe('Trigger id (from list_triggers) or its exact title');
const expectedRevParameter = z.number().optional().describe('The content_rev you read; the write is refused when the trigger has moved since');

export interface TriggerToolDeps {
  triggers: TriggerService;
  fires: Pick<FireLedger, 'listOfTrigger'>;
  caller: Session;
}

const MAX_FIRES_LISTED = 200;
const DEFAULT_FIRES_LISTED = 50;

/** A fire as an agent reads it: ids, times, the state and why it ended; no dedup key and no text of the event. */
const fireToolView = (fire: TriggerFire) => ({
  id: fire.id, ledger_state: fire.ledgerState, fired_at: fire.firedAt, settled_at: fire.settledAt ?? undefined,
  ...(fire.settleReason !== null && { reason: fire.settleReason }), ...(fire.runId !== null && { run_id: fire.runId }), chain_depth: fire.chainDepth,
});

export function registerTriggerTools(server: McpServer, { triggers, fires, caller }: TriggerToolDeps): void {
  const projectIdOfCaller = (): string => {
    if (caller.projectId === undefined) throw new OpenFleetError('project_not_found', 'your session belongs to no project.');
    return caller.projectId;
  };
  const triggerOf = (reference: string): TriggerRecord => triggers.getInProject(projectIdOfCaller(), reference);

  server.registerTool('get_trigger_schema', {
    description: 'The shapes the trigger tools validate against: WHEN sources and their args, condition operators and event prefixes, RUN kinds and args, policy fields. Read it before authoring a trigger.',
    inputSchema: {},
  }, async () => ok(triggerSchemaView()));

  server.registerTool('list_triggers', { description: 'The triggers of your project: id, title, content_rev and whether a human armed each. Agents can build and edit triggers but never arm them.', inputSchema: {} }, async () =>
    ok({ triggers: triggers.list(projectIdOfCaller()).map((trigger) => ({ id: trigger.id, title: trigger.title, content_rev: trigger.contentRev, armed: trigger.armedAt !== null })) }),
  );

  server.registerTool('get_trigger', { description: 'One trigger: WHEN, conditions with their ids, RUN, policy, content_rev and armed state', inputSchema: { trigger: triggerParameter } }, async ({ trigger }) =>
    ok(triggerView(triggerOf(trigger))),
  );

  server.registerTool('list_trigger_fires', {
    description: 'The fires of a trigger, newest first: id, ledger_state (accepted, attempted, completed, cancelled, needs_review), times, why a fire was cancelled or needs review. A needs_review fire may or may not have had its effect and is never replayed. Optional state filter and limit (default 50, at most 200).',
    inputSchema: { trigger: triggerParameter, state: z.string().optional().describe('Only the fires in this ledger state'), limit: z.number().optional() },
  }, async ({ trigger, state, limit }) => {
    const target = triggerOf(trigger);
    const isKnownState = state === undefined || (TRIGGER_LEDGER_STATES as readonly string[]).includes(state);
    if (!isKnownState) throw new OpenFleetError('invalid_body', `state is one of ${TRIGGER_LEDGER_STATES.join(', ')}.`);
    const count = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_FIRES_LISTED), 1), MAX_FIRES_LISTED);
    const listed = fires.listOfTrigger(target.id, { limit: count, ...(state !== undefined && { state: state as TriggerLedgerState }) });
    return ok({ fires: listed.map(fireToolView) });
  });

  server.registerTool('create_trigger', {
    description: 'Create a trigger in your project. It starts with a session_state idle WHEN and a notify RUN; shape it with set_trigger_when, add_trigger_condition, set_trigger_run and set_trigger_policy. It cannot fire until a human arms it.',
    inputSchema: { title: z.string().optional().describe("Display name (default 'Untitled Trigger')") },
  }, async ({ title }) => ok(triggerView(triggers.create({ projectId: projectIdOfCaller(), title }))));

  server.registerTool('delete_trigger', { description: 'Delete a trigger and its fire history. Irreversible.', inputSchema: { trigger: triggerParameter } }, async ({ trigger }) => {
    const target = triggerOf(trigger);
    triggers.delete(target.id);
    return ok({ deleted: target.id });
  });

  server.registerTool('set_trigger_when', {
    description: `Set the WHEN source of a trigger: kind is one of ${TRIGGER_WHEN_SOURCES.join(', ')}, with kind-specific args (get_trigger_schema). Replaces the WHEN. Any edit clears the arming: a human must arm it again.`,
    inputSchema: { trigger: triggerParameter, kind: z.string(), args: z.record(z.string(), z.unknown()).optional(), expected_rev: expectedRevParameter },
  }, async ({ trigger, kind, args, expected_rev }) => {
    const isKnownSource = (TRIGGER_WHEN_SOURCES as readonly string[]).includes(kind);
    if (!isKnownSource) throw new OpenFleetError('invalid_body', `unknown WHEN kind; it is one of ${TRIGGER_WHEN_SOURCES.join(', ')}.`);
    const when = TriggerWhenSchema.parse({ ...args, source: kind });
    return ok(triggerView(triggers.edit(triggerOf(trigger).id, () => ({ when }), { expectedRev: expected_rev })));
  });

  server.registerTool('set_trigger_run', {
    description: `Set the RUN action of a trigger: kind is one of ${TRIGGER_RUN_KINDS.join(', ')} (${PROMPT_MANAGER_ALIAS} is read as prompt_manager), with kind-specific args (get_trigger_schema). Replaces the RUN. Any edit clears the arming.`,
    inputSchema: { trigger: triggerParameter, kind: z.string(), args: z.record(z.string(), z.unknown()).optional(), expected_rev: expectedRevParameter },
  }, async ({ trigger, kind, args, expected_rev }) => {
    const isKnownKind = [...TRIGGER_RUN_KINDS, PROMPT_MANAGER_ALIAS].includes(kind);
    if (!isKnownKind) throw new OpenFleetError('invalid_body', `unknown RUN kind; it is one of ${TRIGGER_RUN_KINDS.join(', ')}.`);
    const run = TriggerRunSchema.parse({ ...args, kind });
    return ok(triggerView(triggers.edit(triggerOf(trigger).id, () => ({ run }), { expectedRev: expected_rev })));
  });

  server.registerTool('set_trigger_policy', {
    description: 'Update the firing policy of a trigger; pass any of the fields, the others keep their value. Any edit clears the arming.',
    inputSchema: {
      trigger: triggerParameter, cooldown_seconds: z.number().optional(), max_fires_per_day: z.number().optional(), batch_mode: z.string().optional(),
      backlog_policy: z.string().optional(), backlog_max_age_minutes: z.number().optional(), expected_rev: expectedRevParameter,
    },
  }, async ({ trigger, cooldown_seconds, max_fires_per_day, batch_mode, backlog_policy, backlog_max_age_minutes, expected_rev }) => {
    const changes = {
      cooldownSeconds: cooldown_seconds, maxFiresPerDay: max_fires_per_day, batchMode: batch_mode, backlogPolicy: backlog_policy, backlogMaxAgeMinutes: backlog_max_age_minutes,
    };
    const givenChanges = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    return ok(triggerView(triggers.edit(triggerOf(trigger).id, (current) => ({ policy: TriggerPolicySchema.parse({ ...current.policy, ...givenChanges }) }), { expectedRev: expected_rev })));
  });

  server.registerTool('add_trigger_condition', {
    description: `Add a condition (AND/OR filter on the event): lhs is an event path such as event.row.title (its prefix must fit the WHEN source), op one of the ${TRIGGER_CONDITION_OPERATORS.length} comparators, rhs the value (omit for exists and not_exists). Consecutive 'and' rows bind, 'or' starts a new group. At most ${MAX_TRIGGER_CONDITIONS}. Any edit clears the arming.`,
    inputSchema: {
      trigger: triggerParameter, lhs: z.string(), op: z.string(), rhs: rhsSchema.optional(), join: z.string().optional(), case_insensitive: z.boolean().optional(),
      after: z.string().optional().describe('Insert after this condition id (default: at the end)'), expected_rev: expectedRevParameter,
    },
  }, async ({ trigger, lhs, op, rhs, join, case_insensitive, after, expected_rev }) => {
    const target = triggerOf(trigger);
    const input = TriggerConditionInputSchema.parse({ lhs, op, rhs, ...(join !== undefined && { join }), ...(case_insensitive !== undefined && { caseInsensitive: case_insensitive }) });
    const edited = triggers.edit(target.id, (current) => {
      const added: TriggerCondition = { id: newId(), ...input };
      const afterPosition = after === undefined ? current.conditions.length - 1 : current.conditions.findIndex((condition) => condition.id === after);
      if (after !== undefined && afterPosition < 0) throw conditionNotFound();
      return { conditions: [...current.conditions.slice(0, afterPosition + 1), added, ...current.conditions.slice(afterPosition + 1)] };
    }, { expectedRev: expected_rev });
    return ok(triggerView(edited));
  });

  server.registerTool('update_trigger_condition', {
    description: 'Update a condition by id (from get_trigger): pass any of join, lhs, op, rhs, case_insensitive. Any edit clears the arming.',
    inputSchema: {
      trigger: triggerParameter, condition_id: z.string(), lhs: z.string().optional(), op: z.string().optional(), rhs: rhsSchema.optional(),
      join: z.string().optional(), case_insensitive: z.boolean().optional(), expected_rev: expectedRevParameter,
    },
  }, async ({ trigger, condition_id, lhs, op, rhs, join, case_insensitive, expected_rev }) => {
    const target = triggerOf(trigger);
    const edited = triggers.edit(target.id, (current) => {
      const position = current.conditions.findIndex((condition) => condition.id === condition_id);
      if (position < 0) throw conditionNotFound();
      const { id, ...existing } = current.conditions[position]!;
      const given = { lhs, op, rhs, join, caseInsensitive: case_insensitive };
      const givenChanges = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
      const updated: TriggerCondition = { id, ...TriggerConditionInputSchema.parse({ ...existing, ...givenChanges }) };
      return { conditions: current.conditions.map((condition, index) => (index === position ? updated : condition)) };
    }, { expectedRev: expected_rev });
    return ok(triggerView(edited));
  });

  server.registerTool('delete_trigger_condition', {
    description: 'Delete a condition by id (from get_trigger). Any edit clears the arming.',
    inputSchema: { trigger: triggerParameter, condition_id: z.string(), expected_rev: expectedRevParameter },
  }, async ({ trigger, condition_id, expected_rev }) => {
    const target = triggerOf(trigger);
    const edited = triggers.edit(target.id, (current) => {
      const exists = current.conditions.some((condition) => condition.id === condition_id);
      if (!exists) throw conditionNotFound();
      return { conditions: current.conditions.filter((condition) => condition.id !== condition_id) };
    }, { expectedRev: expected_rev });
    return ok(triggerView(edited));
  });
}

const conditionNotFound = () => new OpenFleetError('trigger_condition_not_found', 'condition not found on this trigger');
