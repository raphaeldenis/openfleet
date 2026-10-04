export class PayloadTooLargeError extends Error {}

/** Names no part of the body: the parser's own message quotes an excerpt of it. */
const INVALID_JSON_DIAGNOSTIC = 'the request body could not be parsed as JSON';

export class InvalidJsonBodyError extends Error {
  constructor() {
    super(INVALID_JSON_DIAGNOSTIC);
  }
}
