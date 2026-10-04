import { HANDOFF_SECTION_KEYS, type HandoffContent, type Note } from '@openfleet/shared';

export const IDENTICAL_HANDOFF_WINDOW_MS = 60_000;

export interface SavedHandoff {
  note: Note;
  relativePath: string;
}

interface RememberedSave {
  bodyKey: string;
  savedAtMs: number;
  saved: SavedHandoff;
}

/**
 * Remembers the last handoff saved for each session so that the same body sent again within
 * `IDENTICAL_HANDOFF_WINDOW_MS` answers with that save instead of writing a duplicate file.
 * In memory: a daemon restart forgets it.
 */
export class IdenticalHandoffGuard {
  private readonly lastSaveBySession = new Map<string, RememberedSave>();

  constructor(private readonly clock: () => string) {}

  recentSaveOf(sessionId: string, content: HandoffContent): SavedHandoff | undefined {
    const last = this.lastSaveBySession.get(sessionId);
    if (!last) return undefined;
    const isSameBody = last.bodyKey === bodyKeyOf(content);
    const isWithinWindow = Date.parse(this.clock()) - last.savedAtMs < IDENTICAL_HANDOFF_WINDOW_MS;
    return isSameBody && isWithinWindow ? last.saved : undefined;
  }

  remember(sessionId: string, content: HandoffContent, saved: SavedHandoff): void {
    this.lastSaveBySession.set(sessionId, { bodyKey: bodyKeyOf(content), savedAtMs: Date.parse(this.clock()), saved });
  }
}

function bodyKeyOf(content: HandoffContent): string {
  return JSON.stringify(HANDOFF_SECTION_KEYS.map((key) => content[key]));
}
