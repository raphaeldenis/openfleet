// The masking rules shared by the error envelope (describeError) and the structured logger, so both hide the same secrets.
//
// Documented ceilings, left readable on purpose:
// - A JWT payload that does not start with `eyJ` (valid JSON whitespace before its first key) is not recognised by format.
// - A quoted value, a Cookie or Authorization value longer than QUOTED_VALUE_LIMIT is masked by its first 16 KiB per pass; four passes leave a finite prefix masked (the desktop masker counts bytes, this one UTF-16 units).
// - A collection that runs past QUOTED_VALUE_LIMIT is cut there: what follows the cut (a second element, a suffix object) stays readable.
// - A short, numeric or literal-looking unquoted value (`token: abc`, `token: 123456789`, `token: null`) and a backtick-quoted value stay readable: they cannot be told from a counter or prose.
// - A collection is masked only under a key whose last noun is a credential (`token`, `accessToken`, `x-api-key`, `token_value`) and, under a plural one (`tokens`, `secrets`, `credentials`), only when it holds a string value: `tokens: [1,2]` and `maxTokens: {"in":12}` count things and stay readable, `maxTokens: {"model":"x"}` is masked. `tokenizer`, `password_policy` and `ticketCount` are diagnostics whatever they hold. A string under such a key (`tokenizer: cl100k_base`) is still masked: any key holding a secret word hides its string.

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

const QUOTED_VALUE_LIMIT = 16 * 1024;
const COOKIE_NAME_CHARACTER = new RegExp(`[^=;${WHITESPACE}${QUOTES}]`);
const COOKIE_VALUE_CHARACTER = new RegExp(`[^;${WHITESPACE}${QUOTES}]`);
const QUOTE_CHARACTER = new RegExp(`[${QUOTES}]`);
const COOKIE_HEADER_START = /\b(Set-Cookie|Cookie)[ \t]*:[ \t]*/gi;

const endOfRun = (text: string, from: number, isRunCharacter: RegExp): number => {
  let end = from;
  while (end < text.length && isRunCharacter.test(text.charAt(end))) end += 1;
  return end;
};

type QuoteScan = { quote: string; limit: number; areLineBreaksPartOfTheString: boolean; areQuotesEscaped: boolean };

/** Where the string whose content starts at `contentStart` closes: at its closing quote (a backslash and a quote inside an escaped JSON document), or at the line break (when line breaks end the string) or the limit when it never closes; a backslash escapes the next character of a plain string. */
const closingQuoteAt = (text: string, contentStart: number, scan: QuoteScan): number => {
  let at = contentStart;
  while (at < scan.limit) {
    const character = text.charAt(at);
    const isLineBreak = character === '\n' || character === '\r';
    const closesTheString = scan.areQuotesEscaped ? character === '\\' && text.charAt(at + 1) === scan.quote : character === scan.quote;
    if (closesTheString || (isLineBreak && !scan.areLineBreaksPartOfTheString)) return at;
    const escapesTheNextCharacter = character === '\\' && !scan.areQuotesEscaped;
    at += escapesTheNextCharacter ? 2 : 1;
  }
  return Math.min(at, scan.limit);
};

const NOT_FOLDED = -1;

/** A header continues on the next line when that line starts with a space or a tab (the legacy folded form): where that line starts after the line break at `lineBreakAt`, or NOT_FOLDED. */
const startOfFoldedLineAfter = (text: string, lineBreakAt: number): number => {
  const nextLineStart = text.charAt(lineBreakAt) === '\r' && text.charAt(lineBreakAt + 1) === '\n' ? lineBreakAt + 2 : lineBreakAt + 1;
  const isFoldedLine = text.charAt(nextLineStart) === ' ' || text.charAt(nextLineStart) === '\t';
  return isFoldedLine ? nextLineStart : NOT_FOLDED;
};

const endOfHeaderValue = (text: string, from: number): number => {
  let at = from;
  while (at < text.length) {
    const character = text.charAt(at);
    const isLineBreak = character === '\n' || character === '\r';
    if (!isLineBreak) {
      at += 1;
      continue;
    }
    const foldedLineStart = startOfFoldedLineAfter(text, at);
    if (foldedLineStart === NOT_FOLDED) return at;
    at = foldedLineStart;
  }
  return text.length;
};

/** Skips the spaces, tabs and folded line breaks of a header, up to the length limit. */
const endOfFoldedPadding = (text: string, from: number): number => {
  const limit = Math.min(text.length, from + QUOTED_VALUE_LIMIT);
  let at = from;
  while (at < limit) {
    if (PADDING_CHARACTER.test(text.charAt(at))) {
      at += 1;
      continue;
    }
    const foldedLineStart = startOfFoldedLineAfter(text, at);
    const isFoldedLineBreak = (text.charAt(at) === '\n' || text.charAt(at) === '\r') && foldedLineStart !== NOT_FOLDED;
    if (!isFoldedLineBreak) break;
    at = foldedLineStart;
  }
  return at;
};

type CookieValue = { start: number; end: number; next: number };

/** A quoted value is masked between its quotes; one that never closes is masked to the end of the header or the limit. */
const cookieValueFrom = (pairs: string, valueStart: number): CookieValue => {
  const quote = pairs.charAt(valueStart);
  if (!QUOTE_CHARACTER.test(quote)) {
    const end = endOfRun(pairs, valueStart, COOKIE_VALUE_CHARACTER);
    return { start: valueStart, end, next: end };
  }
  const contentStart = valueStart + 1;
  const limit = Math.min(pairs.length, contentStart + QUOTED_VALUE_LIMIT);
  const contentEnd = closingQuoteAt(pairs, contentStart, { quote, limit, areLineBreaksPartOfTheString: true, areQuotesEscaped: false });
  const isClosed = pairs.charAt(contentEnd) === quote;
  return { start: contentStart, end: contentEnd, next: isClosed ? contentEnd + 1 : contentEnd };
};

/** Masks the value of every `name=value` pair (`Cookie`), or of the first one only (`Set-Cookie`, whose attributes stay readable). */
const maskedCookiePairs = (pairs: string, isSetCookie: boolean): string => {
  let masked = '';
  let copiedUpTo = 0;
  let cursor = 0;
  while (cursor < pairs.length) {
    const nameEnd = endOfRun(pairs, cursor, COOKIE_NAME_CHARACTER);
    if (nameEnd === cursor) {
      if (isSetCookie) break;
      cursor += 1;
      continue;
    }
    const hasValueMark = pairs.charAt(nameEnd) === '=';
    const value = hasValueMark ? cookieValueFrom(pairs, nameEnd + 1) : null;
    const hasContent = value !== null && value.end > value.start;
    if (value && hasContent) {
      masked += pairs.slice(copiedUpTo, value.start) + MASK;
      copiedUpTo = value.end;
    }
    if (isSetCookie) break;
    cursor = value && hasContent ? value.next : nameEnd;
  }
  return masked + pairs.slice(copiedUpTo);
};

/** Masks the value of every cookie, whatever its name: a `Cookie` header lists pairs, a `Set-Cookie` header starts with one pair and goes on with readable attributes (Path, HttpOnly, Max-Age, …). */
const maskingCookieHeaders = (text: string): string => {
  const headers = new RegExp(COOKIE_HEADER_START.source, 'gi');
  let masked = '';
  let copiedUpTo = 0;
  for (let header = headers.exec(text); header; header = headers.exec(text)) {
    const [headerStart = '', headerName = ''] = header;
    const pairsStart = header.index + headerStart.length;
    const pairsEnd = endOfHeaderValue(text, pairsStart);
    const isSetCookie = headerName.length > 'Cookie'.length;
    masked += text.slice(copiedUpTo, pairsStart) + maskedCookiePairs(text.slice(pairsStart, pairsEnd), isSetCookie);
    copiedUpTo = pairsEnd;
    headers.lastIndex = pairsEnd;
  }
  return masked + text.slice(copiedUpTo);
};

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
const PADDING_CHARACTER = /[ \t]/;
const HEADER_WHITESPACE_CHARACTER = /[ \t\r\n]/;
const COLLECTION_DEPTH_LIMIT = 32;
// The key of a header such as `Authorization` or `Proxy-Authorization`, not `myauthorization`.
const AUTHORIZATION_HEADER_NAME = /(?:^|[^A-Za-z0-9])authorization$/i;
const AUTHORIZATION_SCHEME = /^[A-Za-z0-9._~+/-]{3,}$/;
const COLLECTION_OPENERS = '[{';
const COLLECTION_CLOSERS = ']}';
const COLLECTION_WHITESPACE = new RegExp(`[${WHITESPACE}]`);

// The words of a key (`accessToken`, `x-api-key`, `API_KEY`, `auth.token` → access token, x api key, …); each alternative stops where the next one starts, so a long run is split in one pass.
const KEY_WORD = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g;
const SINGULAR_CREDENTIAL_NOUNS = new Set(['token', 'secret', 'password', 'passwd', 'authorization', 'credential', 'cookie', 'ticket', 'apikey']);
// A plural noun also counts things (`tokens: [1,2]`): its collection is a credential only when it holds a string.
const PLURAL_CREDENTIAL_NOUNS = new Set(['tokens', 'secrets', 'passwords', 'credentials', 'cookies', 'tickets']);
const CREDENTIAL_NOUN_PAIRS = new Set(['api key', 'private key', 'secret key']);
// `token_value`, `secretData`: the noun after the secret word only says how the credential is held.
const CONTAINER_WORDS = new Set(['value', 'values', 'string', 'data', 'list', 'map', 'json']);

type CredentialNoun = 'singular' | 'plural' | 'none';

/** The last noun of a key: `token`, `accessToken`, `x-api-key`, `private_key`, `token_value` end on a credential; `tokens` and `authTokens` end on a plural one. `tokenizer`, `maxTokens`-as-a-counter, `password_policy`, `ticketCount` and `secretary` only hold a secret word inside another word or before another noun: they describe a credential, they are not one. */
const credentialNounOf = (keyName: string): CredentialNoun => {
  const words = (keyName.match(KEY_WORD) ?? []).map((word) => word.toLowerCase());
  while (CONTAINER_WORDS.has(words[words.length - 1] ?? '')) words.pop();
  const lastWord = words[words.length - 1] ?? '';
  const lastPair = words.slice(-2).join(' ');
  if (SINGULAR_CREDENTIAL_NOUNS.has(lastWord) || CREDENTIAL_NOUN_PAIRS.has(lastPair)) return 'singular';
  return PLURAL_CREDENTIAL_NOUNS.has(lastWord) ? 'plural' : 'none';
};

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
  return { start: contentStart, end: contentEnd, isCredential: content.length > 0 };
};

const isAuthorizationSchemeBeforeMask = (value: string, text: string, valueEnd: number): boolean =>
  AUTHORIZATION_SCHEMES.has(value.toLowerCase()) && text.startsWith(MASK, endOfMatchAt(PADDING, text, valueEnd));

const looksLikeCredential = (value: string, text: string, valueEnd: number): boolean => {
  const isLongEnough = Array.from(value).length >= UNQUOTED_VALUE_MINIMUM_LENGTH;
  const isUsageCounterOrLiteral = PLAIN_NUMBER.test(value) || LITERALS_THAT_HOLD_NO_SECRET.has(value.toLowerCase());
  return isLongEnough && !isUsageCounterOrLiteral && !isAuthorizationSchemeBeforeMask(value, text, valueEnd);
};

const unquotedValueFrom = (text: string, start: number): ColonValue => {
  const end = endOfMatchAt(UNQUOTED_VALUE, text, start);
  return { start, end, isCredential: looksLikeCredential(text.slice(start, end), text, end) };
};

/** The quote delimiting a string at `at`: a plain quote, or, inside an escaped JSON document, a backslash and a quote; empty when none starts there. */
const quoteDelimiterAt = (text: string, at: number, areQuotesEscaped: boolean): string => {
  const character = text.charAt(at);
  if (!areQuotesEscaped) return QUOTE_CHARACTER.test(character) ? character : '';
  const nextCharacter = text.charAt(at + 1);
  return character === '\\' && QUOTE_CHARACTER.test(nextCharacter) ? nextCharacter : '';
};

type Collection = { end: number; holdsAString: boolean };

/** Where the `[…]` or `{…}` that opens at `start` closes, strings and nesting included; one that never balances, nests deeper than the limit or runs past the length limit is cut at the limit. It also says whether a string value sits inside (an object key does not count; a string cut by the limit or a collection cut by the depth limit does). */
const collectionFrom = (text: string, start: number, areQuotesEscaped: boolean): Collection => {
  const limit = Math.min(text.length, start + QUOTED_VALUE_LIMIT);
  const delimiterWidth = areQuotesEscaped ? 2 : 1;
  let depth = 0;
  let openQuote = '';
  let holdsAString = false;
  let isLastStringAKeyOrAValue = false;
  for (let at = start; at < limit; at += 1) {
    const character = text.charAt(at);
    const delimiter = quoteDelimiterAt(text, at, areQuotesEscaped);
    const isInsideAString = openQuote !== '';
    if (isInsideAString) {
      const closesTheString = delimiter === openQuote;
      const escapesTheNextCharacter = character === '\\' && !areQuotesEscaped;
      if (closesTheString) openQuote = '';
      if (closesTheString) isLastStringAKeyOrAValue = true;
      if (closesTheString) at += delimiterWidth - 1;
      else if (escapesTheNextCharacter) at += 1;
      continue;
    }
    const isStringJustClosed = isLastStringAKeyOrAValue && !COLLECTION_WHITESPACE.test(character);
    if (isStringJustClosed) {
      const isAKey = character === ':';
      holdsAString ||= !isAKey;
      isLastStringAKeyOrAValue = false;
    }
    if (delimiter) {
      openQuote = delimiter;
      at += delimiterWidth - 1;
      continue;
    }
    if (COLLECTION_OPENERS.includes(character)) depth += 1;
    if (depth > COLLECTION_DEPTH_LIMIT) return { end: limit, holdsAString: true };
    if (COLLECTION_CLOSERS.includes(character)) depth -= 1;
    if (depth === 0) return { end: at + 1, holdsAString };
  }
  const isStringCutByTheLimit = openQuote !== '' || isLastStringAKeyOrAValue;
  return { end: limit, holdsAString: holdsAString || isStringCutByTheLimit };
};

/** `response = "…"`: the quote at `at` follows an equals sign, whatever padding sits between them. */
const followsAnEqualsSign = (text: string, at: number, credentialsStart: number): boolean => {
  let beforePadding = at;
  while (beforePadding > credentialsStart && PADDING_CHARACTER.test(text.charAt(beforePadding - 1))) beforePadding -= 1;
  return text.charAt(beforePadding - 1) === '=';
};

/** Where the credentials of an authorization scheme end: at a line break that no folded line follows, a closing bracket, a quote that opens no parameter value (`response="…"` belongs to them) or the limit; trailing whitespace stays out. */
const endOfAuthorizationCredentials = (text: string, start: number): number => {
  const limit = Math.min(text.length, start + QUOTED_VALUE_LIMIT);
  let at = start;
  while (at < limit) {
    const character = text.charAt(at);
    const endsTheLine = character === '\n' || character === '\r';
    const foldedLineStart = endsTheLine ? startOfFoldedLineAfter(text, at) : NOT_FOLDED;
    const isFoldedLineBreak = foldedLineStart !== NOT_FOLDED;
    if (isFoldedLineBreak) {
      at = foldedLineStart;
      continue;
    }
    const isEscapedQuote = character === '\\' && QUOTE_CHARACTER.test(text.charAt(at + 1));
    const quote = isEscapedQuote ? text.charAt(at + 1) : character;
    const quoteWidth = isEscapedQuote ? 2 : 1;
    const isQuote = QUOTE_CHARACTER.test(quote);
    const opensAParameterValue = isQuote && followsAnEqualsSign(text, at, start);
    if (endsTheLine || COLLECTION_CLOSERS.includes(character) || (isQuote && !opensAParameterValue)) break;
    if (!opensAParameterValue) {
      at += 1;
      continue;
    }
    const closingAt = closingQuoteAt(text, at + quoteWidth, { quote, limit, areLineBreaksPartOfTheString: false, areQuotesEscaped: isEscapedQuote });
    const isClosed = text.startsWith(isEscapedQuote ? `\\${quote}` : quote, closingAt);
    at = isClosed ? closingAt + quoteWidth : closingAt;
  }
  let end = at;
  while (end > start && HEADER_WHITESPACE_CHARACTER.test(text.charAt(end - 1))) end -= 1;
  return end;
};

/** `Token X` or `Digest username="U", …` behind an authorization header: the scheme word stays readable, everything it introduces is the credential. */
const authorizationCredentialsFrom = (text: string, valueStart: number, keyName: string): ColonValue | null => {
  if (!AUTHORIZATION_HEADER_NAME.test(keyName)) return null;
  const schemeEnd = endOfMatchAt(UNQUOTED_VALUE, text, valueStart);
  const scheme = text.slice(valueStart, schemeEnd);
  const isGenericScheme = AUTHORIZATION_SCHEME.test(scheme) && !AUTHORIZATION_SCHEMES.has(scheme.toLowerCase());
  const credentialsStart = endOfFoldedPadding(text, schemeEnd);
  if (!isGenericScheme || credentialsStart === schemeEnd) return null;
  const credentialsEnd = endOfAuthorizationCredentials(text, credentialsStart);
  if (credentialsEnd <= credentialsStart) return null;
  return { start: credentialsStart, end: credentialsEnd, isCredential: text.slice(credentialsStart, credentialsEnd) !== MASK };
};

/** The value after `key": ` or `key: `, or null when no colon follows the key; a cookie header's unquoted value belongs to the cookie rule. */
const colonValueAfter = (text: string, keyEnd: number, keyName: string): ColonValue | null => {
  const afterKeyQuotes = endOfMatchAt(QUOTES_AND_BACKSLASHES, text, keyEnd);
  const colonAt = endOfMatchAt(PADDING, text, afterKeyQuotes);
  if (text.charAt(colonAt) !== ':') return null;
  const isAuthorizationHeader = AUTHORIZATION_HEADER_NAME.test(keyName);
  const valueStart = isAuthorizationHeader ? endOfFoldedPadding(text, colonAt + 1) : endOfMatchAt(PADDING, text, colonAt + 1);
  const quoteAt = endOfMatchAt(BACKSLASHES, text, valueStart);
  const isOpeningQuoteEscaped = quoteAt > valueStart;
  const quote = text.charAt(quoteAt);
  const opensQuotedValue = quote === '"' || quote === "'";
  if (opensQuotedValue) return quotedValueFrom(text, quoteAt + 1, quote, isOpeningQuoteEscaped);
  const opensCollection = !isOpeningQuoteEscaped && quote !== '' && COLLECTION_OPENERS.includes(quote);
  const credentialNoun = credentialNounOf(keyName);
  if (opensCollection && credentialNoun !== 'none') {
    const isInsideAnEscapedDocument = text.slice(keyEnd, afterKeyQuotes).includes('\\');
    const collection = collectionFrom(text, valueStart, isInsideAnEscapedDocument);
    const isCounterCollection = credentialNoun === 'plural' && !collection.holdsAString;
    if (!isCounterCollection) return { start: valueStart, end: collection.end, isCredential: true };
  }
  const isCookieHeaderValue = COOKIE_HEADER_NAME.test(keyName);
  const isKeyKnownToQuotedAndCollectionRulesOnly = !SECRET_KEY.test(keyName);
  if (isOpeningQuoteEscaped || isCookieHeaderValue || isKeyKnownToQuotedAndCollectionRulesOnly) return null;
  return authorizationCredentialsFrom(text, valueStart, keyName) ?? unquotedValueFrom(text, valueStart);
};

/** Masks the value that follows a secret-named key with a colon (`{"token":"…"}`, `password: …`); the scan visits each key run once and resumes after the value it read. */
const maskingColonValues = (text: string): string => {
  const keys = new RegExp(KEY_RUN.source, 'g');
  let masked = '';
  let copiedUpTo = 0;
  for (let key = keys.exec(text); key; key = keys.exec(text)) {
    const [keyName = ''] = key;
    if (!SECRET_KEY.test(keyName) && credentialNounOf(keyName) === 'none') continue;
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
const JWT_PAYLOAD_MARK = '.eyJ';
const JWT_HEADER_MARK = 'eyJ';

const startOfFinalCredentialRun = (head: string): number => {
  let runStart = head.length;
  while (runStart > 0 && CREDENTIAL_CHARACTER.test(head.charAt(runStart - 1))) runStart -= 1;
  return runStart;
};

/** Where the final run holds `eyJ<header>.eyJ<payload prefix>` with the signature missing or cut, whatever the payload length; -1 when it does not (a mark before the final run leaves the header scan empty). */
const startOfUnfinishedJwt = (head: string, finalRunStart: number): number => {
  const payloadMarkAt = head.lastIndexOf(JWT_PAYLOAD_MARK);
  let headerStart = payloadMarkAt;
  while (headerStart > finalRunStart && JWT_SEGMENT_CHARACTER.test(head.charAt(headerStart - 1))) headerStart -= 1;
  const startsWithAJwtHeader = payloadMarkAt - headerStart >= JWT_HEADER_MARK.length && head.startsWith(JWT_HEADER_MARK, headerStart);
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
