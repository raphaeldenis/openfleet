import { ESCALATING_CLASSES } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';
import { visibleTextOf } from '../governance/visibleText.js';
import type { StoredQuestion } from './escalationRepository.js';

export const ESCALATION_ITEM_PREFIX = '[esc:';
export const UNCLASSIFIED_LABEL = 'unclassified';

const MAX_BODY_CHARS = 2000;

/** The text a human reads in the Inbox and in the questions of the manager: plain, without invisible characters, secrets masked. */
export const humanReadableText = (text: string): string => maskedSecrets(visibleTextOf(text));

const cappedAt = (text: string, maxChars: number) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);

const classLabelsOf = (questions: readonly StoredQuestion[]): string[] => {
  const effectiveClasses = ESCALATING_CLASSES.filter((escalatingClass) => questions.some((question) => question.effectiveClasses.includes(escalatingClass)));
  const hasUnclassifiedQuestion = questions.some((question) => question.reason === UNCLASSIFIED_LABEL);
  return hasUnclassifiedQuestion ? [...effectiveClasses, UNCLASSIFIED_LABEL] : effectiveClasses;
};

const lineOfQuestion = (question: StoredQuestion, position: number): string[] => {
  const classes = question.effectiveClasses.length > 0 ? question.effectiveClasses.join(', ') : question.reason ?? question.declaredClass;
  const options = question.options && `   options: ${question.options.join(' | ')}`;
  const recommendation = question.recommendation && `   the manager recommends: ${question.recommendation}`;
  return [`${position}. [${question.questionId} · ${classes}] ${question.text}`, options, recommendation].filter((line): line is string => Boolean(line));
};

/** The body the daemon writes for an escalation: its header, then every question with its options and the recommendation of the manager. */
export function renderEscalationBody({ id, ticket, questions }: { id: string; ticket: string; questions: readonly StoredQuestion[] }): string {
  const header = `Escalation ${id} on ${ticket}: ${questions.length} question(s) — ${classLabelsOf(questions).join(', ')}`;
  const lines = [header, '', ...questions.flatMap((question, index) => lineOfQuestion(question, index + 1))];
  return cappedAt(lines.join('\n'), MAX_BODY_CHARS);
}

/** The one line the daemon adds to the questions of the manager; it stays identical when the escalation grows, so the human is notified once. */
export const escalationItemOf = ({ id, ticket }: { id: string; ticket: string }): string =>
  `${ESCALATION_ITEM_PREFIX}${id}] Escalation on ${ticket}: a human answer is needed, see the Inbox`;
