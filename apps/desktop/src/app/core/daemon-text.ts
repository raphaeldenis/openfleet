import { showInvisibleControlsAsEscapes } from '../inbox/bidi-escapes';

const MASK = '***';

// An invisible character inside a credential is already an escape when the masks run: the escape belongs to the credential.
const ESCAPE = '<U\\+[0-9A-F]{4,6}>';
const runOf = (characters: string) => `(?:${characters}|${ESCAPE})`;

const BEARER_TOKEN = new RegExp(`\\bBearer\\s+${runOf('[A-Za-z0-9._~+/=-]')}+`, 'gi');
const SECRET_KEY_SHAPES = [
  new RegExp(`\\bsk-${runOf('[A-Za-z0-9_-]')}{10,}`, 'g'),
  new RegExp(`\\b(?:gh[pousr]_|github_pat_)${runOf('[A-Za-z0-9_]')}{10,}`, 'g'),
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g,
];
const HOOK_URL_TOKEN = /\/hooks\/[^/\s]+/g;
const HOME_DIRECTORY = /(?<![A-Za-z0-9_.~-])\/(?:Users|home)\/[^/\s;:,)'"<>]+|[A-Za-z]:\\Users\\[^\\\s]+/g;

function withoutSecrets(text: string): string {
  const withoutBearer = text.replace(BEARER_TOKEN, `Bearer ${MASK}`);
  const withoutKeys = SECRET_KEY_SHAPES.reduce((remaining, shape) => remaining.replace(shape, MASK), withoutBearer);
  return withoutKeys.replace(HOOK_URL_TOKEN, `/hooks/${MASK}`);
}

/**
 * A string the daemon sent, made safe to show or to paste into a bug report: invisible and bidirectional characters
 * become visible escapes, known credential shapes are masked and a home directory is shortened to ~.
 */
export function readableDaemonText(text: string): string {
  const withVisibleControls = showInvisibleControlsAsEscapes(text);
  return withoutSecrets(withVisibleControls).replace(HOME_DIRECTORY, '~');
}
