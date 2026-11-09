import { MIN_SECRET_LENGTH, createSecretMasker } from '../playbooks/kernel/secretMasker.js';

const MARKER_NAME = 'INTEGRATION_CREDENTIAL';
const TOKEN_SEPARATOR = ':';

export type MaskText = (text: string) => string;

/** A text from a provider is at most its body, which the reader caps at 1 MiB: a masker reading that many characters never cuts it, so it cannot leave the start of a value. */
const LARGEST_PROVIDER_TEXT_CHARS = 1_048_576;

/** The part after the first colon of an `email:token` credential: the API token alone, which a provider may echo without its email. */
export const tokenAloneOf =(credential: string): string | undefined => {
  const separatorIndex = credential.indexOf(TOKEN_SEPARATOR);
  return separatorIndex === -1 ? undefined : credential.slice(separatorIndex + 1);
};

/**
 * Builds the function that replaces, in a text a provider sent, every spelling of what the daemon sent it:
 * the credential, the whole Authorization value, and the token alone of an `email:token` credential.
 * Each is recognised plain, URL-encoded, form-encoded, in base64, in base64url and escaped for JSON; a match becomes `[secret:INTEGRATION_CREDENTIAL]`.
 * A value under the minimum length of a stored secret is left out, as masking it would destroy the text; the secret service refuses to store a credential whose token half is that short.
 * The returned function reads a text of any length a provider can send whole: it never cuts one.
 */
export const credentialEchoMaskerOf = ({ credential, authorization }: { credential: string; authorization: string }): MaskText => {
  const candidates = [credential, authorization, tokenAloneOf(credential)];
  const values = candidates.filter((value): value is string => value !== undefined && Array.from(value).length >= MIN_SECRET_LENGTH);
  const secrets = [...new Set(values)].map((value) => ({ name: MARKER_NAME, value }));
  return createSecretMasker(secrets, { maxInputChars: LARGEST_PROVIDER_TEXT_CHARS }).mask;
};
