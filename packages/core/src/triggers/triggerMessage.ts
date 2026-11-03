import type { TriggerWhenSource } from '@openfleet/shared';
import { valueAtDottedPath } from '../playbooks/kernel/dottedPath.js';
import { wrapTriggerMessage } from '../sessions/messageEnvelope.js';
import type { TriggerFire } from './fireLedger.js';
import type { TriggerRecord } from './triggerRepository.js';

export const MAX_TOKEN_VALUE_CHARS = 120;
const MAX_PROMPT_CHARS = 6000;
const ELLIPSIS = '…';

/** The paths of the event a prompt may name with {{...}}, by source: any other path stays written as it is. */
export const EVENT_TOKEN_PATHS_BY_SOURCE: Readonly<Record<TriggerWhenSource, readonly string[]>> = {
  session_state: ['event.session.id', 'event.session.name', 'event.session.state', 'event.session.parentId', 'event.session.minutes'],
  silent_run: ['event.session.id', 'event.session.name', 'event.session.minutes'],
  data_store_query: [],
  cron: [],
  integration_records: [],
};

const TOKEN = /\{\{\s*(event\.[A-Za-z0-9_.-]+)\s*\}\}/g;
const CONTROL_EXCEPT_LINE_BREAK_AND_TAB = /[^\P{Cc}\n\t]/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

const truncated = (text: string, maxChars: number): string => {
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, maxChars).join('')}${ELLIPSIS}`;
};

/** A value taken from a record: one line, without control or format characters, cut short. */
export const inertValueOf = (value: unknown): string => {
  const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  return truncated(text.replace(CONTROL_OR_FORMAT, ' ').replace(/ {2,}/g, ' ').trim(), MAX_TOKEN_VALUE_CHARS);
};

/** The text of a prompt as its author wrote it, minus the control characters other than line breaks and tabs. */
export const promptWithoutControlsOf = (prompt: string): string => prompt.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_LINE_BREAK_AND_TAB, '');

/** Replaces the tokens of the allow-list in one pass, so a value that looks like a token is not expanded. Other tokens stay as written. */
export function promptWithTokensOf({ prompt, source, event }: { prompt: string; source: TriggerWhenSource; event: Record<string, unknown> }): string {
  const allowed = EVENT_TOKEN_PATHS_BY_SOURCE[source];
  const readable = promptWithoutControlsOf(prompt).replace(TOKEN, (written, path: string) => (allowed.includes(path) ? inertValueOf(valueAtDottedPath({ event }, path)) : written));
  return truncated(readable, MAX_PROMPT_CHARS);
}

const SESSION_STATES_OF_THE_HEADER = ['waiting_permission', 'idle', 'closed_with_error'];

/**
 * The message a trigger sends to a session: a header of ids and enumerations the daemon writes, then the prompt, with the allow-listed tokens filled in,
 * inside an envelope marked untrusted. Nothing of a record reaches the header.
 */
export function triggerMessageOf({ trigger, fire, prompt, batchSize }: { trigger: TriggerRecord; fire: TriggerFire; prompt: string; batchSize: number }): string {
  const { source } = trigger.when;
  const state = trigger.when.source === 'session_state' ? trigger.when.state : undefined;
  const stateField = state !== undefined && SESSION_STATES_OF_THE_HEADER.includes(state) ? ` state=${state}` : '';
  const header = `trigger.fired trigger=${trigger.id} fire=${fire.id} source=${source}${stateField} batch=${batchSize}`;
  return wrapTriggerMessage({ header, body: promptWithTokensOf({ prompt, source, event: fire.event }) });
}
