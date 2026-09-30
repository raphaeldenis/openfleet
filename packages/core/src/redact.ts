// The masking rules shared by the error envelope (describeError) and the structured logger, so both hide the same secrets.

// Any key naming a credential, in any case and anywhere in the name: `token`, `authTokens`, `refreshTokenString`, `TOKENS`, …
export const SECRET_KEY = /token|secret|authorization|password|cookie|ticket|api[_-]?key/i;

/** A number under such a key (`tokens: 450000`) counts usage; a credential is a string, a list or an object. */
export const isSecretEntry = (key: string, value: unknown): boolean => SECRET_KEY.test(key) && !(typeof value === 'number' && Number.isFinite(value));
export const MASK = '***';
export const escapedForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A percent-escape encoded up to five times (%2F, %252F, …); the bound keeps every scan linear. */
const ESCAPE_PREFIX = '%(?:25){0,4}';
const hexOf = (character: string) => character.charCodeAt(0).toString(16).padStart(2, '0');

/** Matches `word` with any of its characters written as a percent-escape. */
const spelledWithEscapes = (word: string): string =>
  Array.from(word)
    .map((character) => `(?:${escapedForRegExp(character)}|${ESCAPE_PREFIX}(?:${hexOf(character.toLowerCase())}|${hexOf(character.toUpperCase())}))`)
    .join('');

const SLASH = `(?:/|${ESCAPE_PREFIX}2F)`;
const BEARER_SEPARATOR = `(?:[\\s:=]|${ESCAPE_PREFIX}(?:20|3A|3D|09))+`;
// A token segment keeps every escape, valid or not: masking the whole segment is what hides a token spelled with escapes.
const BEARER_PREFIX = `${spelledWithEscapes('Bearer')}${BEARER_SEPARATOR}`;
// The prefix may repeat (`Bearer Bearer <token>`): each repetition starts on the literal, so the scan stays linear.
const BEARER_TOKEN = new RegExp(`${BEARER_PREFIX}(?:${BEARER_PREFIX})*[A-Za-z0-9._~+/=%-]+`, 'gi');
// `/hooks/:token` is the route pattern, not a secret.
const HOOK_TOKEN = new RegExp(`${SLASH}${spelledWithEscapes('hooks')}${SLASH}(?!:token(?![\\w-]))[^/\\s"'\`&]+`, 'gi');
const BASIC_CREDENTIAL = /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g;
// Behind an Authorization header the word Basic is certain to introduce a credential, whatever characters it holds.
const AUTHORIZED_BASIC_CREDENTIAL = /\b((?:Proxy-)?Authorization\s*[:=]\s*)Basic\s+[^\s"'`&;]+/gi;
// A head cut inside a credential leaves a prefix too short or too plain for the rules above to recognise.
const CREDENTIAL_CUT_BY_THE_HEAD = /\b(Basic\s+)[A-Za-z0-9+/=]+$/;
// The scan starts at `://` only and stops at the next `/`, so its runs never overlap; the credentials end at the last `@` before it (a password may hold a raw `@`, not a raw `/`).
const URL_CREDENTIALS = /(:\/\/)[^\s/"'`]+@/g;
// The key class excludes every character that can start a parameter: a run of them stays linear.
const QUERY_PARAMETER = /(^|[?&;#\s])([^=&?;\s"'`#]*)=([^&;\s"'`]*)/g;
const NESTED_PARAMETER_START = /[?#]/;
const NESTED_PARAMETERS_CHECKED = 4;

/** Decodes every well-formed percent-escape, up to three layers deep; a malformed one stays as it is and nothing throws. */
function withEscapesDecoded(text: string): string {
  let decoded = text;
  for (let layer = 0; layer < 3; layer += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/** A value that decodes to a URL or header carrying a secret (`next=%2Fx%3Ftoken%3D…`) hides that secret behind its escapes. */
const hidesSecretBehindEscapes = (value: string): boolean => {
  const decoded = withEscapesDecoded(value);
  return decoded !== value && maskedSecrets(decoded) !== decoded;
};

/** A value holding more nested `?` or `#` than the check reaches is masked whole; the bound keeps the rescans of one value linear. */
const nestsMoreParametersThanChecked = (value: string): boolean => {
  const nestedStarts = /[?#]/g;
  for (let count = 0; count <= NESTED_PARAMETERS_CHECKED; count += 1) if (!nestedStarts.test(value)) return false;
  return true;
};

/** Masks the value of a secret-named parameter; a parameter nested behind a `?` or `#` of a plain value is scanned on its own. */
const maskingQueryParameters = (text: string): string => {
  const parameters = new RegExp(QUERY_PARAMETER.source, 'g');
  let masked = '';
  let copiedUpTo = 0;
  for (let found = parameters.exec(text); found; found = parameters.exec(text)) {
    const [parameter = '', prefix = '', key = '', value = ''] = found;
    const isSecretParameter = SECRET_KEY.test(withEscapesDecoded(key)) || nestsMoreParametersThanChecked(value) || hidesSecretBehindEscapes(value);
    if (isSecretParameter) {
      masked += `${text.slice(copiedUpTo, found.index)}${prefix}${key}=${MASK}`;
      copiedUpTo = found.index + parameter.length;
      continue;
    }
    const nestedStart = value.search(NESTED_PARAMETER_START);
    if (nestedStart >= 0) parameters.lastIndex = found.index + parameter.length - value.length + nestedStart;
  }
  return masked + text.slice(copiedUpTo);
};

// Credentials that identify themselves by their format, whatever surrounds them: provider keys, JWTs, and PEM private keys (up to their footer, or to the end of a cut text).
const WELL_KNOWN_CREDENTIAL = new RegExp(
  [
    '\\bsk-[A-Za-z0-9_-]{20,}',
    '\\bgh[pousr]_[A-Za-z0-9]{36,}',
    '\\bgithub_pat_[A-Za-z0-9_]{50,}',
    '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
    // A lookbehind, not `\b`: `-` is in the class, so `\b` would restart a scan after every `-eyJ` of one run (quadratic).
    '(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}',
    // `xoxe.` fronts a Slack configuration token (`xoxe.xoxp-…`); `%` spells the escapes of an `xoxd-` cookie.
    '\\b(?:xoxe\\.)?xox[abcdeprs]-[A-Za-z0-9%-]{10,}',
    '\\bxapp-[A-Za-z0-9-]{10,}',
    '\\bAIza[0-9A-Za-z_-]{35,}',
    '\\bnpm_[A-Za-z0-9]{36}',
    '\\bglpat-[A-Za-z0-9_-]{20,}(?:\\.01\\.[A-Za-z0-9]{4,})?',
    '\\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}',
    '\\bwhsec_[A-Za-z0-9]{20,}',
    '\\bhf_[A-Za-z0-9]{30,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)',
  ].join('|'),
  'g',
);

export function maskedSecrets(text: string): string {
  const withoutUrlCredentials = text
    .replace(WELL_KNOWN_CREDENTIAL, MASK)
    .replace(BEARER_TOKEN, `Bearer ${MASK}`)
    .replace(AUTHORIZED_BASIC_CREDENTIAL, `$1Basic ${MASK}`)
    .replace(BASIC_CREDENTIAL, `Basic ${MASK}`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`);
  return maskingQueryParameters(withoutUrlCredentials).replace(HOOK_TOKEN, `/hooks/${MASK}`);
}

// The cut fell between `://` and the `@` that ends the credentials, so the `@` the rule above needs is gone.
const URL_CREDENTIALS_CUT_BY_THE_HEAD = /(:\/\/)[^\s/@"'`]+$/;

// A well-known credential the cut left under its rule's minimum length: only its prefix and its first characters remain.
const WELL_KNOWN_CREDENTIAL_CUT_BY_THE_HEAD =
  /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA|eyJ|xoxe\.|xox[abcdeprs]-|xapp-|AIza|npm_|glpat-|[sr]k_(?:live|test)_|whsec_|hf_)[A-Za-z0-9_.-]*$/;

const CREDENTIAL_CHARACTER = /[A-Za-z0-9_.-]/;
const LONGEST_CUT_CREDENTIAL_TAIL = 512;

// Only the final run of credential characters can hold a cut credential: testing just that tail keeps the anchored rule linear.
const maskingCutWellKnownCredential = (head: string): string => {
  let tailStart = head.length;
  const earliestTailStart = Math.max(0, head.length - LONGEST_CUT_CREDENTIAL_TAIL);
  while (tailStart > earliestTailStart && CREDENTIAL_CHARACTER.test(head.charAt(tailStart - 1))) tailStart -= 1;
  return head.slice(0, tailStart) + head.slice(tailStart).replace(WELL_KNOWN_CREDENTIAL_CUT_BY_THE_HEAD, MASK);
};

export const maskingCutCredential = (head: string): string =>
  maskingCutWellKnownCredential(head.replace(CREDENTIAL_CUT_BY_THE_HEAD, `$1${MASK}`).replace(URL_CREDENTIALS_CUT_BY_THE_HEAD, `$1${MASK}`));
