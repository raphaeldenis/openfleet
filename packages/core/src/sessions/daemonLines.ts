import { AGENT_MESSAGE_BEGIN } from './messageEnvelope.js';

export const PULSE_PREFIX = '[pulse]';
export const SCHEDULED_EVENT_PREFIX = '[scheduled event';
export const CHILD_RESTARTED_PREFIX = '[child_restarted]';
export const CHILD_RESTART_EXHAUSTED_PREFIX = '[child_restart_exhausted]';
export const HARNESS_EXITED_PREFIX = '[harness_exited]';
export const SLEEP_PREFIX = '[sleep]';
export const OPENFLEET_NOTICE_PREFIX = '[openfleet]';
export const VERDICT_PREFIX = '[verdict]';

/** The openings of the lines listed here, written by the daemon into a manager's message queue, none of them typed by a human. */
export const DAEMON_LINE_PREFIXES: readonly string[] = [
  PULSE_PREFIX,
  SCHEDULED_EVENT_PREFIX,
  CHILD_RESTARTED_PREFIX,
  CHILD_RESTART_EXHAUSTED_PREFIX,
  HARNESS_EXITED_PREFIX,
  SLEEP_PREFIX,
  OPENFLEET_NOTICE_PREFIX,
  VERDICT_PREFIX,
];

const ENVELOPE_HEADER_PREFIX = '[from agent ';
const ENVELOPE_BEGIN_LINE = `char(10) || '${AGENT_MESSAGE_BEGIN}' || char(10)`;
const ENVELOPE_BEGIN_POSITION = `instr(body, ${ENVELOPE_BEGIN_LINE})`;
const ENVELOPE_PAYLOAD_POSITION = `(${ENVELOPE_BEGIN_POSITION} + ${AGENT_MESSAGE_BEGIN.length + 2})`;
const IS_ENVELOPED = `(substr(body, 1, ${ENVELOPE_HEADER_PREFIX.length}) = '${ENVELOPE_HEADER_PREFIX}' AND ${ENVELOPE_BEGIN_POSITION} > 0)`;

/**
 * The SQL condition that keeps a queue query away from the daemon lines; it compares substrings because `_` is a LIKE wildcard.
 * A daemon line is recognised at the start of the body and at the start of the payload of an agent message envelope.
 */
export const notADaemonLineCondition = (): string =>
  DAEMON_LINE_PREFIXES.map((prefix) => {
    const opensBody = `substr(body, 1, ${prefix.length}) = '${prefix}'`;
    const opensEnvelopePayload = `${IS_ENVELOPED} AND substr(body, ${ENVELOPE_PAYLOAD_POSITION}, ${prefix.length}) = '${prefix}'`;
    return `NOT (${opensBody} OR (${opensEnvelopePayload}))`;
  }).join(' AND ');
