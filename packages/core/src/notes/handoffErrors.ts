export class SessionNotFoundForHandoffError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}
