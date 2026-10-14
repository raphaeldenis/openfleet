/** The hook answer gets a ~30 character prefix from the CLI on top of this budget. */
export const MAX_REFUSAL_TEXT_CHARS = 560;

const UNWATCHED_NOTICE = 'No human is watching this session, so the command was refused instead of asked. Rephrase and continue; do not retry the same command.';
const ESCALATION_NOTICE = 'If you really need it, message your manager (message_parent): it can file a permission proposal.';

const ellipsized = (text: string, maxChars: number): string => (text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`);

/** Builds what the session reads when a command is refused: the rule, the reason, the alternative and where to turn. */
export function refusalTextOf({ ruleId, reason, alternative, isUnwatched }: { ruleId: string; reason: string; alternative: string; isUnwatched: boolean }): string {
  const noticeLines = isUnwatched ? [UNWATCHED_NOTICE, ESCALATION_NOTICE] : [ESCALATION_NOTICE];
  const noticeChars = noticeLines.join('\n').length + noticeLines.length;
  const headline = `OpenFleet command policy [${ruleId}]: `;
  const alternativeLabel = 'Alternative: ';
  const textBudget = MAX_REFUSAL_TEXT_CHARS - noticeChars - headline.length - alternativeLabel.length - 1;
  const budgetPerText = Math.floor(textBudget / 2);
  return [`${headline}${ellipsized(reason, budgetPerText)}`, `${alternativeLabel}${ellipsized(alternative, budgetPerText)}`, ...noticeLines].join('\n');
}
