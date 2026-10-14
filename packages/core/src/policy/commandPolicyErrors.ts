/** The command policy file exists but is not a JSON object the daemon can read; it is left alone for the human to repair. */
export class CommandPolicyFileUnreadableError extends Error {}

/** The command policy file or its folder cannot be written. */
export class CommandPolicyFileReadOnlyError extends Error {}
