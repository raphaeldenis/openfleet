import { MASK, maskedSecrets } from '../redact.js';

const SECRET_WORD = '(?:password|passwd|passphrase|secret|token|api-?key|auth|credentials?)';
const QUOTED_OR_PLAIN_VALUE = '(?:"[^"]*"|\'[^\']*\'|\\S+)';
const FLAG_NAMES_A_SECRET = `--(?:[a-z0-9]+-)*${SECRET_WORD}(?!-(?:stdin|file|prompt)\\b)(?:-[a-z0-9]+)*`;

const SECRET_FLAG_WITH_EQUALS = new RegExp(`(${FLAG_NAMES_A_SECRET}=)${QUOTED_OR_PLAIN_VALUE}`, 'gi');
const SECRET_FLAG_WITH_NEXT_ARGUMENT = new RegExp(`(${FLAG_NAMES_A_SECRET}\\s+)(?!-)${QUOTED_OR_PLAIN_VALUE}`, 'gi');

const SECRET_ENVIRONMENT_ASSIGNMENT = new RegExp(`(\\b[A-Za-z0-9_]*${SECRET_WORD.replaceAll('-?', '_?')}[A-Za-z0-9_]*=)${QUOTED_OR_PLAIN_VALUE}`, 'gi');

// `-p` is a password only for these programs: `mkdir -p`, `cp -p` and `ls -p` are not.
const PASSWORD_ATTACHED_TO_P_FLAG = /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*?\s-p)(?=\S)\S+/g;
const PASSWORD_AFTER_P_FLAG = /(\bsshpass\b[^;&|\n]*?\s-p\s+)\S+/g;
const PASSWORD_AFTER_A_FLAG = /(\bredis-cli\b[^;&|\n]*?\s-a\s+)\S+/g;
const PASSWORD_AFTER_USER_COLON = /(\b(?:curl|wget)\b[^;&|\n]*?\s(?:-u|--user|--proxy-user)\s+[^\s:]+:)\S+/g;

const MASK_AFTER_PREFIX = `$1${MASK}`;

/** Returns the command with the value of every credential option, assignment and URL replaced by a mask. */
export function maskedCommandSecrets(command: string): string {
  const withoutOptionSecrets = command
    .replace(SECRET_FLAG_WITH_EQUALS, MASK_AFTER_PREFIX)
    .replace(SECRET_FLAG_WITH_NEXT_ARGUMENT, MASK_AFTER_PREFIX)
    .replace(SECRET_ENVIRONMENT_ASSIGNMENT, MASK_AFTER_PREFIX)
    .replace(PASSWORD_ATTACHED_TO_P_FLAG, MASK_AFTER_PREFIX)
    .replace(PASSWORD_AFTER_P_FLAG, MASK_AFTER_PREFIX)
    .replace(PASSWORD_AFTER_A_FLAG, MASK_AFTER_PREFIX)
    .replace(PASSWORD_AFTER_USER_COLON, MASK_AFTER_PREFIX);
  return maskedSecrets(withoutOptionSecrets);
}
