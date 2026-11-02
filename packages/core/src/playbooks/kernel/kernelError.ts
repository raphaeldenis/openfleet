export type KernelErrorCode =
  | 'too_many_conditions'
  | 'unknown_operator'
  | 'unknown_token'
  | 'unresolved_reference'
  | 'secret_missing'
  | 'invalid_secret_name'
  | 'secret_not_allowed_here'
  | 'untrusted_reference'
  | 'secret_too_short'
  | 'not_canonical_json';

/** A refusal of the shared kernel; `code` is the stable, wire-safe reason. */
export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}
