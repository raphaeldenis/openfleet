import type { Session } from '@openfleet/shared';

export interface ContextNotice {
  readonly session: Session;
  readonly tokens: number;
}

/** The open sessions the daemon says crossed a context threshold, one notice per session carrying the highest threshold crossed, in session order. */
export function contextNoticesOf(sessions: readonly Session[]): ContextNotice[] {
  return sessions.flatMap((session) => {
    const isClosed = session.state === 'closed';
    const { contextNoticeTokens: tokens } = session;
    if (isClosed || tokens === undefined) return [];
    return [{ session, tokens }];
  });
}

/** The sentence of a context notice; the session name is escaped by the caller. */
export function contextNoticeCopyOf({ sessionName, tokens }: { sessionName: string; tokens: number }): string {
  return `${sessionName} is at ${tokens.toLocaleString('en-US')} tokens of context. A good moment to compact it.`;
}
