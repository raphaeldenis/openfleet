// Builds token-shaped strings at runtime: no source file holds a literal credential shape, so secret scanners have nothing to flag.
// The shape tests (`noLiteralTokenShape.test.ts`) fail on any literal that looks like one of these.

const SHAPE_PREFIX_FRAGMENTS = {
  gitlab: ['gl', 'pat-'],
  github: ['gh', 'p_'],
  githubFineGrained: ['github', '_pat_'],
  openai: ['s', 'k-'],
  anthropic: ['s', 'k-ant-api03-'],
  aws: ['AK', 'IA'],
  awsSession: ['AS', 'IA'],
  slackBot: ['xo', 'xb-'],
  slackUser: ['xo', 'xp-'],
  slackRefresh: ['xo', 'xe-'],
  jwt: ['ey', 'J'],
} as const;

export type TokenShape = keyof typeof SHAPE_PREFIX_FRAGMENTS;

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const MIXED_ALPHABET = `${UPPER}${LOWER}${DIGITS}`;
const UPPER_ALPHABET = `${UPPER}${DIGITS}`;
const URL_SAFE_ALPHABET = `${MIXED_ALPHABET}-_`;
const DEFAULT_SEED = 1;

export function tokenPrefixOf(shape: TokenShape): string {
  return SHAPE_PREFIX_FRAGMENTS[shape].join('');
}

function nextXorshift(state: number): number {
  let next = state | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

/** Returns `length` deterministic characters drawn from `alphabet`; the same seed gives the same body. */
export function syntheticBody({ length, seed = DEFAULT_SEED, alphabet = MIXED_ALPHABET }: { length: number; seed?: number; alphabet?: string }): string {
  let state = seed >>> 0 || DEFAULT_SEED;
  let body = '';
  for (let index = 0; index < length; index += 1) {
    state = nextXorshift(state);
    body += alphabet[state % alphabet.length];
  }
  return body;
}

/** Returns the shape's prefix followed by a deterministic body of `bodyLength` characters. */
export function syntheticToken({ shape, bodyLength, seed = DEFAULT_SEED }: { shape: TokenShape; bodyLength: number; seed?: number }): string {
  const alphabet = shape === 'aws' || shape === 'awsSession' ? UPPER_ALPHABET : MIXED_ALPHABET;
  return `${tokenPrefixOf(shape)}${syntheticBody({ length: bodyLength, seed, alphabet })}`;
}

export interface JwtParts {
  header: string;
  payload: string;
  signature: string;
}

/** Returns the three segments of a JWT-shaped string; header and payload start with the base64 of `{"`, the lengths count what follows that start. */
export function syntheticJwtParts({
  headerBodyLength,
  payloadBodyLength,
  signatureLength,
  seed = DEFAULT_SEED,
}: {
  headerBodyLength: number;
  payloadBodyLength: number;
  signatureLength: number;
  seed?: number;
}): JwtParts {
  return {
    header: syntheticToken({ shape: 'jwt', bodyLength: headerBodyLength, seed }),
    payload: syntheticToken({ shape: 'jwt', bodyLength: payloadBodyLength, seed: seed + 1 }),
    signature: syntheticBody({ length: signatureLength, seed: seed + 2, alphabet: URL_SAFE_ALPHABET }),
  };
}

/** Returns a three-segment JWT-shaped string whose segments each carry `segmentBodyLength` characters after their start. */
export function syntheticJwt({ segmentBodyLength, seed = DEFAULT_SEED }: { segmentBodyLength: number; seed?: number }): string {
  const { header, payload, signature } = syntheticJwtParts({ headerBodyLength: segmentBodyLength, payloadBodyLength: segmentBodyLength, signatureLength: segmentBodyLength, seed });
  return `${header}.${payload}.${signature}`;
}
