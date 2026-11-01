import type { ActivityRow } from '@openfleet/shared';
import { argumentsExcerpt, keptTokenOrMark, resultExcerpt } from './activityExcerpts.js';
import { maskedActivityText } from './activityMasking.js';
import type { ActivityRepository, ActivityRowToStore } from './activityRepository.js';

export const ACTIVITY_RETENTION = { maxRows: 100_000, maxAgeDays: 90 };
const PRUNE_EVERY_INSERTS = 500;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const MAX_DETAIL_CHARS = 300;
const MAX_ARGS_CHARS = 400;
const MAX_RESULT_CHARS = 200;
const MAX_NAME_CHARS = 200;

export interface ActivityRetention {
  maxRows: number;
  maxAgeDays: number;
}

/** What the caller knows about an action; the recorder adds the instant, keeps only what the Audit reads and bounds it. */
export interface ActivityDraft {
  actorKind: ActivityRow['actorKind'];
  actorLabel: string;
  sessionId?: string;
  managerId?: string;
  source: ActivityRow['source'];
  action: string;
  entityKind?: string;
  /** Kept when it is an identifier; any other text is stored as its length and fingerprint. */
  entityId?: string;
  entityLabel?: string;
  outcome: ActivityRow['outcome'];
  durationMs?: number;
  /** An error code, a class name or a version; any other text is stored as its length and fingerprint. */
  detail?: string;
  /** The arguments as the call received them: only short identifiers, enumeration members, numbers and booleans are kept. */
  args?: unknown;
  /** The text the call answered: only its length and its short scalar fields are kept. */
  resultText?: string;
}

const maskedExcerpt = (text: string, maxChars: number): string => maskedActivityText(text).slice(0, maxChars);

const excerptWhenGiven = <Value>(value: Value | undefined, excerptOf: (given: Value) => string, maxChars: number) =>
  (value === undefined ? undefined : excerptOf(value).slice(0, maxChars));

/** Writes the activity log without ever failing its caller: an audit failure is reported to `onFailure` and the call goes on. */
export class ActivityRecorder {
  private insertsSincePrune = 0;

  constructor(private readonly deps: {
    repository: ActivityRepository;
    clock: () => string;
    onFailure: (error: unknown) => void;
    retention?: ActivityRetention;
    pruneEvery?: number;
  }) {}

  record(draft: ActivityDraft): void {
    try {
      this.deps.repository.insert(this.rowToStore(draft));
      this.insertsSincePrune += 1;
      const isPruneDue = this.insertsSincePrune >= (this.deps.pruneEvery ?? PRUNE_EVERY_INSERTS);
      if (isPruneDue) this.prune();
    } catch (error) {
      this.deps.onFailure(error);
    }
  }

  pruneAtBoot(): void {
    try {
      this.prune();
    } catch (error) {
      this.deps.onFailure(error);
    }
  }

  private prune(): void {
    this.insertsSincePrune = 0;
    const retention = this.deps.retention ?? ACTIVITY_RETENTION;
    const oldestKept = new Date(Date.parse(this.deps.clock()) - retention.maxAgeDays * MILLISECONDS_PER_DAY).toISOString();
    this.deps.repository.prune({ keepNewest: retention.maxRows, olderThan: oldestKept });
  }

  private rowToStore(draft: ActivityDraft): ActivityRowToStore {
    const optionalField = <Value>(key: keyof ActivityRowToStore, value: Value | undefined, excerptOf: (given: Value) => string, maxChars: number) => {
      const excerpt = excerptWhenGiven(value, excerptOf, maxChars);
      return (excerpt === undefined ? {} : { [key]: excerpt }) as Partial<ActivityRowToStore>;
    };
    const optionalText = (key: keyof ActivityRowToStore, text: string | undefined, maxChars: number) => optionalField(key, text, maskedActivityText, maxChars);
    return {
      at: this.deps.clock(),
      actorKind: draft.actorKind,
      actorLabel: maskedExcerpt(draft.actorLabel, MAX_NAME_CHARS),
      ...(draft.sessionId === undefined ? {} : { sessionId: draft.sessionId }),
      ...(draft.managerId === undefined ? {} : { managerId: draft.managerId }),
      source: draft.source,
      action: maskedExcerpt(draft.action, MAX_NAME_CHARS),
      ...optionalText('entityKind', draft.entityKind, MAX_NAME_CHARS),
      ...optionalField('entityId', draft.entityId, keptTokenOrMark, MAX_NAME_CHARS),
      ...optionalText('entityLabel', draft.entityLabel, MAX_NAME_CHARS),
      outcome: draft.outcome,
      ...(draft.durationMs === undefined ? {} : { durationMs: draft.durationMs }),
      ...optionalField('detail', draft.detail, keptTokenOrMark, MAX_DETAIL_CHARS),
      ...optionalField('argsExcerpt', draft.args, argumentsExcerpt, MAX_ARGS_CHARS),
      ...optionalField('resultExcerpt', draft.resultText, resultExcerpt, MAX_RESULT_CHARS),
    };
  }
}
