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

// Whitespace for every rule: JavaScript's `\s` misses the next-line character (U+0085) that the desktop logger's Rust side treats as a separator; masking after it is the safer reading.
const WHITESPACE = '\\s\\u0085';
const QUOTES = '"\'`';

const SLASH = `(?:/|${ESCAPE_PREFIX}2F)`;
const BEARER_SEPARATOR = `(?:[${WHITESPACE}:=]|${ESCAPE_PREFIX}(?:20|3A|3D|09))+`;
// A token segment keeps every escape, valid or not: masking the whole segment is what hides a token spelled with escapes.
const BEARER_PREFIX = `${spelledWithEscapes('Bearer')}${BEARER_SEPARATOR}`;
// The prefix may repeat (`Bearer Bearer <token>`): each repetition starts on the literal, so the scan stays linear.
const BEARER_TOKEN = new RegExp(`${BEARER_PREFIX}(?:${BEARER_PREFIX})*[A-Za-z0-9._~+/=%-]+`, 'gi');
// `/hooks/:token` is the route pattern, not a secret.
const HOOK_TOKEN = new RegExp(`${SLASH}${spelledWithEscapes('hooks')}${SLASH}(?!:token(?![\\w-]))[^/${WHITESPACE}${QUOTES}&]+`, 'gi');
const BASIC_CREDENTIAL = new RegExp(`\\bBasic[${WHITESPACE}]+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}`, 'g');
// Behind an Authorization header the word Basic is certain to introduce a credential, whatever characters it holds.
const AUTHORIZED_BASIC_CREDENTIAL = new RegExp(`\\b((?:Proxy-)?Authorization[${WHITESPACE}]*[:=][${WHITESPACE}]*)Basic[${WHITESPACE}]+[^${WHITESPACE}${QUOTES}&;]+`, 'gi');
// A head cut inside a credential leaves a prefix too short or too plain for the rules above to recognise.
const CREDENTIAL_CUT_BY_THE_HEAD = new RegExp(`\\b(Basic[${WHITESPACE}]+)[A-Za-z0-9+/=]+$`);
// The scan starts at `://` only and stops at the next `/`, so its runs never overlap; the credentials end at the last `@` before it (a password may hold a raw `@`, not a raw `/`).
const URL_CREDENTIALS = new RegExp(`(:\\/\\/)[^${WHITESPACE}/${QUOTES}]+@`, 'g');
// The key class excludes every character that can start a parameter: a run of them stays linear.
const QUERY_PARAMETER = new RegExp(`(^|[?&;#${WHITESPACE}])([^=&?;${WHITESPACE}${QUOTES}#]*)=([^&;${WHITESPACE}${QUOTES}]*)`, 'g');
const NESTED_PARAMETER_START = /[?#]/;
const NESTED_PARAMETERS_CHECKED = 4;
const NESTED_DECODINGS_CHECKED = 4;

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

/** A value that decodes to a URL or header carrying a secret (`next=%2Fx%3Ftoken%3D…`) hides that secret behind its escapes; one that still holds escapes after the deepest check is masked, so the recursion is bounded. */
const hidesSecretBehindEscapes = (value: string, depth: number): boolean => {
  const decoded = withEscapesDecoded(value);
  if (decoded === value) return false;
  const isDeeperThanChecked = depth >= NESTED_DECODINGS_CHECKED;
  return isDeeperThanChecked || maskedSecretsOnce(decoded, depth + 1) !== decoded;
};

/** A value holding more nested `?` or `#` than the check reaches is masked whole; the bound keeps the rescans of one value linear. */
const nestsMoreParametersThanChecked = (value: string): boolean => {
  const nestedStarts = /[?#]/g;
  for (let count = 0; count <= NESTED_PARAMETERS_CHECKED; count += 1) if (!nestedStarts.test(value)) return false;
  return true;
};

/** Masks the value of a secret-named parameter; a parameter nested behind a `?` or `#` of a plain value is scanned on its own. */
const maskingQueryParameters = (text: string, depth: number): string => {
  const parameters = new RegExp(QUERY_PARAMETER.source, 'g');
  let masked = '';
  let copiedUpTo = 0;
  for (let found = parameters.exec(text); found; found = parameters.exec(text)) {
    const [parameter = '', prefix = '', key = '', value = ''] = found;
    const isSecretParameter = SECRET_KEY.test(withEscapesDecoded(key)) || nestsMoreParametersThanChecked(value) || hidesSecretBehindEscapes(value, depth);
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
    // A lookbehind, not `\b`: `-` is in the class, so `\b` would restart a scan after every `-eyJ` of one run (quadratic). The signature is optional: a header and a payload already identify the token.
    '(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}(?:\\.[A-Za-z0-9_-]*)?',
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

const COOKIE_NAME_CHARACTER = `[^=;${WHITESPACE}${QUOTES}]`;
const COOKIE_VALUE = `[^;${WHITESPACE}${QUOTES}]+`;
const COOKIE_HEADER = /\b(Set-Cookie|Cookie)[ \t]*:[ \t]*([^\r\n]*)/gi;
// The lookbehind leaves one start per run of name characters, so a run without `=` is scanned once.
const COOKIE_PAIRS = new RegExp(`(?<!${COOKIE_NAME_CHARACTER})(${COOKIE_NAME_CHARACTER}+)=${COOKIE_VALUE}`, 'g');
const FIRST_COOKIE_PAIR = new RegExp(`^(${COOKIE_NAME_CHARACTER}+)=${COOKIE_VALUE}`);

/** Masks the value of every cookie, whatever its name: a `Cookie` header lists pairs, a `Set-Cookie` header starts with one pair and goes on with readable attributes (Path, HttpOnly, Max-Age, …). */
const maskingCookieHeaders = (text: string): string =>
  text.replace(COOKIE_HEADER, (header, headerName: string, pairs: string) => {
    const isSetCookie = headerName.length > 'Cookie'.length;
    const maskedPairs = pairs.replace(isSetCookie ? FIRST_COOKIE_PAIR : COOKIE_PAIRS, `$1=${MASK}`);
    return header.slice(0, header.length - pairs.length) + maskedPairs;
  });

const KEY_RUN = /[A-Za-z0-9_.-]+/g;
// The header names the cookie rule matches: `Cookie`, `Set-Cookie`, `X-Cookie`, … but not `mycookie`.
const COOKIE_HEADER_NAME = /(?:^|[^A-Za-z0-9_])(?:Set-)?Cookie$/i;
const QUOTES_AND_BACKSLASHES = /["'\\]*/y;
const BACKSLASHES = /\\*/y;
const PADDING = /[ \t]*/y;
const UNQUOTED_VALUE = new RegExp(`[^${WHITESPACE}${QUOTES},;&{}\\[\\]]*`, 'y');
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
const LITERALS_THAT_HOLD_NO_SECRET = new Set(['null', 'true', 'false', 'undefined']);
const AUTHORIZATION_SCHEMES = new Set(['bearer', 'basic']);
// A shorter unquoted value is a word of the sentence (`the token: is expired`), not a credential.
const UNQUOTED_VALUE_MINIMUM_LENGTH = 4;
const QUOTED_VALUE_LIMIT = 16 * 1024;

type ColonValue = { start: number; end: number; isCredential: boolean };

const endOfMatchAt = (pattern: RegExp, text: string, from: number): number => {
  pattern.lastIndex = from;
  pattern.exec(text);
  return pattern.lastIndex;
};

/** A quoted value ends at its closing quote, the end of the line or the limit; a JSON document escaped inside a string (`\"token\":\"…\"`) ends at the first quote. */
const quotedValueFrom = (text: string, contentStart: number, quote: string, isOpeningQuoteEscaped: boolean): ColonValue => {
  const limit = Math.min(text.length, contentStart + QUOTED_VALUE_LIMIT);
  let end = contentStart;
  while (end < limit) {
    const character = text.charAt(end);
    const endsTheValue = character === quote || character === '\n' || character === '\r';
    if (endsTheValue) break;
    const escapesTheNextCharacter = character === '\\' && !isOpeningQuoteEscaped;
    end += escapesTheNextCharacter ? 2 : 1;
  }
  let contentEnd = Math.min(end, limit);
  while (isOpeningQuoteEscaped && contentEnd > contentStart && text.charAt(contentEnd - 1) === '\\') contentEnd -= 1;
  const content = text.slice(contentStart, contentEnd);
  return { start: contentStart, end: contentEnd, isCredential: content.length > 0 && content !== MASK };
};

const isAuthorizationSchemeBeforeMask = (value: string, text: string, valueEnd: number): boolean =>
  AUTHORIZATION_SCHEMES.has(value.toLowerCase()) && text.startsWith(MASK, endOfMatchAt(PADDING, text, valueEnd));

const looksLikeCredential = (value: string, text: string, valueEnd: number): boolean => {
  const isLongEnough = Array.from(value).length >= UNQUOTED_VALUE_MINIMUM_LENGTH;
  const isMaskedAlready = value === MASK;
  const isUsageCounterOrLiteral = PLAIN_NUMBER.test(value) || LITERALS_THAT_HOLD_NO_SECRET.has(value.toLowerCase());
  return isLongEnough && !isMaskedAlready && !isUsageCounterOrLiteral && !isAuthorizationSchemeBeforeMask(value, text, valueEnd);
};

const unquotedValueFrom = (text: string, start: number): ColonValue => {
  const end = endOfMatchAt(UNQUOTED_VALUE, text, start);
  return { start, end, isCredential: looksLikeCredential(text.slice(start, end), text, end) };
};

/** The value after `key": ` or `key: `, or null when no colon follows the key; a cookie header's unquoted value belongs to the cookie rule. */
const colonValueAfter = (text: string, keyEnd: number, keyName: string): ColonValue | null => {
  const colonAt = endOfMatchAt(PADDING, text, endOfMatchAt(QUOTES_AND_BACKSLASHES, text, keyEnd));
  if (text.charAt(colonAt) !== ':') return null;
  const valueStart = endOfMatchAt(PADDING, text, colonAt + 1);
  const quoteAt = endOfMatchAt(BACKSLASHES, text, valueStart);
  const isOpeningQuoteEscaped = quoteAt > valueStart;
  const quote = text.charAt(quoteAt);
  const opensQuotedValue = quote === '"' || quote === "'";
  if (opensQuotedValue) return quotedValueFrom(text, quoteAt + 1, quote, isOpeningQuoteEscaped);
  const isCookieHeaderValue = COOKIE_HEADER_NAME.test(keyName);
  if (isOpeningQuoteEscaped || isCookieHeaderValue) return null;
  return unquotedValueFrom(text, valueStart);
};

/** Masks the value that follows a secret-named key with a colon (`{"token":"…"}`, `password: …`); the scan visits each key run once and resumes after the value it read. */
const maskingColonValues = (text: string): string => {
  const keys = new RegExp(KEY_RUN.source, 'g');
  let masked = '';
  let copiedUpTo = 0;
  for (let key = keys.exec(text); key; key = keys.exec(text)) {
    const [keyName = ''] = key;
    if (!SECRET_KEY.test(keyName)) continue;
    const value = colonValueAfter(text, key.index + keyName.length, keyName);
    if (!value) continue;
    keys.lastIndex = value.end;
    if (!value.isCredential) continue;
    masked += `${text.slice(copiedUpTo, value.start)}${MASK}`;
    copiedUpTo = value.end;
  }
  return masked + text.slice(copiedUpTo);
};

/** `depth` counts the escape decodings already unwrapped. */
function maskedSecretsOnce(text: string, depth: number): string {
  const withoutUrlCredentials = text
    .replace(WELL_KNOWN_CREDENTIAL, MASK)
    .replace(BEARER_TOKEN, `Bearer ${MASK}`)
    .replace(AUTHORIZED_BASIC_CREDENTIAL, `$1Basic ${MASK}`)
    .replace(BASIC_CREDENTIAL, `Basic ${MASK}`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`);
  const withoutSecretParameters = maskingQueryParameters(maskingCookieHeaders(maskingColonValues(withoutUrlCredentials)), depth);
  return withoutSecretParameters.replace(HOOK_TOKEN, `/hooks/${MASK}`);
}

// A mask can leave text that reads as a new secret to an earlier rule (a hook segment, then `/token=`; `Authorization::=`): passes repeat until the text settles, so masking twice equals masking once.
const MASKING_PASSES_UNTIL_SETTLED = 4;

export function maskedSecrets(text: string): string {
  let masked = text;
  for (let pass = 0; pass < MASKING_PASSES_UNTIL_SETTLED; pass += 1) {
    const next = maskedSecretsOnce(masked, 0);
    if (next === masked) break;
    masked = next;
  }
  return masked;
}

// The cut fell between `://` and the `@` that ends the credentials, so the `@` the rule above needs is gone.
const URL_CREDENTIALS_CUT_BY_THE_HEAD = /(:\/\/)[^\s/@"'`]+$/;

// A well-known credential the cut left under its rule's minimum length: only its prefix and its first characters remain.
const WELL_KNOWN_CREDENTIAL_CUT_BY_THE_HEAD =
  /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA|eyJ|xoxe\.|xox[abcdeprs]-|xapp-|AIza|npm_|glpat-|[sr]k_(?:live|test)_|whsec_|hf_)[A-Za-z0-9_.%-]*$/;

const CREDENTIAL_CHARACTER = /[A-Za-z0-9_.%-]/;
const LONGEST_CUT_CREDENTIAL_TAIL = 512;

const JWT_SEGMENT_CHARACTER = /[A-Za-z0-9_-]/;
const UNFINISHED_JWT_PAYLOAD = /^[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?$/;
const JWT_PAYLOAD_MARK = '.eyJ';
const JWT_HEADER_MARK = 'eyJ';

const startOfFinalCredentialRun = (head: string): number => {
  let runStart = head.length;
  while (runStart > 0 && CREDENTIAL_CHARACTER.test(head.charAt(runStart - 1))) runStart -= 1;
  return runStart;
};

/** Where the final run holds `eyJ<header>.eyJ<payload prefix>` with the signature missing or cut, whatever the payload length; -1 when it does not. */
const startOfUnfinishedJwt = (head: string, finalRunStart: number): number => {
  const payloadMarkAt = head.lastIndexOf(JWT_PAYLOAD_MARK);
  const isInFinalRun = payloadMarkAt >= finalRunStart;
  if (!isInFinalRun) return -1;
  const endsLikeAPayload = UNFINISHED_JWT_PAYLOAD.test(head.slice(payloadMarkAt + JWT_PAYLOAD_MARK.length));
  if (!endsLikeAPayload) return -1;
  let headerStart = payloadMarkAt;
  while (headerStart > finalRunStart && JWT_SEGMENT_CHARACTER.test(head.charAt(headerStart - 1))) headerStart -= 1;
  const startsWithAJwtHeader = head.startsWith(JWT_HEADER_MARK, headerStart) && payloadMarkAt - headerStart >= JWT_HEADER_MARK.length;
  return startsWithAJwtHeader ? headerStart : -1;
};

// Only the final run of credential characters can hold a cut credential: testing just its last characters keeps the anchored rule linear, and the unfinished JWT is located by its marks alone.
const maskingCutWellKnownCredential = (head: string): string => {
  const finalRunStart = startOfFinalCredentialRun(head);
  const unfinishedJwtStart = startOfUnfinishedJwt(head, finalRunStart);
  if (unfinishedJwtStart >= 0) return head.slice(0, unfinishedJwtStart) + MASK;
  const tailStart = Math.max(finalRunStart, head.length - LONGEST_CUT_CREDENTIAL_TAIL);
  return head.slice(0, tailStart) + head.slice(tailStart).replace(WELL_KNOWN_CREDENTIAL_CUT_BY_THE_HEAD, MASK);
};

export const maskingCutCredential = (head: string): string =>
  maskingCutWellKnownCredential(head.replace(CREDENTIAL_CUT_BY_THE_HEAD, `$1${MASK}`).replace(URL_CREDENTIALS_CUT_BY_THE_HEAD, `$1${MASK}`));
