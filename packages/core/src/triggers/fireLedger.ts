import type { TriggerFireReason, TriggerFireView, TriggerLedgerState } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';

export interface TriggerFire {
  id: string;
  triggerId: string;
  dedupKey: string;
  ledgerState: TriggerLedgerState;
  firedAt: string;
  settledAt: string | null;
  settleReason: TriggerFireReason | null;
  runId: string | null;
  eventDigest: string | null;
  event: Record<string, unknown>;
  /** 1 for an event nothing in the fleet caused; one more than the fire whose message set the session going. */
  chainDepth: number;
}

interface FireRow {
  id: string; trigger_id: string; dedup_key: string; ledger_state: TriggerLedgerState; fired_at: string; settled_at: string | null;
  settle_reason: TriggerFireReason | null; run_id: string | null; event_digest: string | null; event_json: string; chain_depth: number;
}

const COLUMNS = 'id, trigger_id, dedup_key, ledger_state, fired_at, settled_at, settle_reason, run_id, event_digest, event_json, chain_depth';

const toFire = (row: FireRow): TriggerFire => ({
  id: row.id, triggerId: row.trigger_id, dedupKey: row.dedup_key, ledgerState: row.ledger_state, firedAt: row.fired_at, settledAt: row.settled_at,
  settleReason: row.settle_reason, runId: row.run_id, eventDigest: row.event_digest, event: JSON.parse(row.event_json), chainDepth: row.chain_depth,
});

const STATES_THAT_REACHED_THE_EFFECT: readonly TriggerLedgerState[] = ['attempted', 'completed', 'needs_review'];
const STATES_SQL_LIST = STATES_THAT_REACHED_THE_EFFECT.map((state) => `'${state}'`).join(', ');

export type AcceptResult = { wasAccepted: true; fire: TriggerFire } | { wasAccepted: false; fire: TriggerFire };

/** The fire as the API shows it. */
export const fireViewOf = (fire: TriggerFire): TriggerFireView => ({
  id: fire.id, triggerId: fire.triggerId, ledgerState: fire.ledgerState, firedAt: fire.firedAt, settledAt: fire.settledAt, reason: fire.settleReason, runId: fire.runId, chainDepth: fire.chainDepth,
});

/** The ledger of the fires: each state change is one row update, written before the step it announces. */
export class FireLedger {
  constructor(private readonly db: DatabaseSync) {}

  /** Inserts the fire `accepted`; a fire of the same trigger with the same dedup key answers with the existing one and inserts nothing. */
  accept(input: { id: string; triggerId: string; dedupKey: string; firedAt: string; eventDigest: string; eventJson: string; chainDepth: number }): AcceptResult {
    const result = this.db.prepare(
      `INSERT INTO trigger_fires (id, trigger_id, dedup_key, ledger_state, fired_at, event_digest, event_json, chain_depth) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)
       ON CONFLICT (trigger_id, dedup_key) DO NOTHING`,
    ).run(input.id, input.triggerId, input.dedupKey, input.firedAt, input.eventDigest, input.eventJson, input.chainDepth);
    const wasAccepted = Number(result.changes) > 0;
    const fire = wasAccepted ? this.get(input.id) : this.getByDedupKey(input.triggerId, input.dedupKey);
    if (fire === undefined) throw new Error(`trigger fire ${input.id} vanished after insert`);
    return { wasAccepted, fire };
  }

  get(id: string): TriggerFire | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM trigger_fires WHERE id = ?`).get(id) as FireRow | undefined;
    return row && toFire(row);
  }

  private getByDedupKey(triggerId: string, dedupKey: string): TriggerFire | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM trigger_fires WHERE trigger_id = ? AND dedup_key = ?`).get(triggerId, dedupKey) as FireRow | undefined;
    return row && toFire(row);
  }

  /** The newest fires of a trigger first. */
  listOfTrigger(triggerId: string, options: { limit: number; state?: TriggerLedgerState }): TriggerFire[] {
    const stateFilter = options.state === undefined ? '' : 'AND ledger_state = ?';
    const parameters = options.state === undefined ? [triggerId, options.limit] : [triggerId, options.state, options.limit];
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM trigger_fires WHERE trigger_id = ? ${stateFilter} ORDER BY fired_at DESC, rowid DESC LIMIT ?`).all(...parameters) as unknown as FireRow[];
    return rows.map(toFire);
  }

  /** The fires that never reached their effect, oldest first. */
  listAccepted(): TriggerFire[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM trigger_fires WHERE ledger_state = 'accepted' ORDER BY fired_at, rowid`).all() as unknown as FireRow[];
    return rows.map(toFire);
  }

  /** Moves `accepted` to `attempted` and stamps when the effect starts, in one statement; false when the fire is no longer accepted, so nothing runs for it. */
  markAttempted(input: { id: string; effectStartedAt: string }): boolean {
    const result = this.db.prepare("UPDATE trigger_fires SET ledger_state = 'attempted', effect_started_at = ? WHERE id = ? AND ledger_state = 'accepted'").run(input.effectStartedAt, input.id);
    return Number(result.changes) > 0;
  }

  /** Settles a fire that was `attempted` as `completed`. */
  markCompleted(input: { id: string; settledAt: string; runId?: string }): void {
    this.db.prepare("UPDATE trigger_fires SET ledger_state = 'completed', settled_at = ?, run_id = COALESCE(?, run_id) WHERE id = ? AND ledger_state = 'attempted'")
      .run(input.settledAt, input.runId ?? null, input.id);
  }

  /** Settles a fire that has not run, or whose run failed cleanly, as `cancelled`. */
  markCancelled(input: { id: string; settledAt: string; reason: TriggerFireReason }): void {
    this.db.prepare("UPDATE trigger_fires SET ledger_state = 'cancelled', settled_at = ?, settle_reason = ? WHERE id = ? AND ledger_state IN ('accepted', 'attempted')")
      .run(input.settledAt, input.reason, input.id);
  }

  /** Every fire left `attempted` by a stopped daemon becomes `needs_review`: its effect may or may not have happened, so it never runs again. Returns how many. */
  markInterruptedForReview(settledAt: string): number {
    const result = this.db.prepare("UPDATE trigger_fires SET ledger_state = 'needs_review', settled_at = ?, settle_reason = 'interrupted' WHERE ledger_state = 'attempted'").run(settledAt);
    return Number(result.changes);
  }

  /** The fires of a trigger whose effect started in `[fromIso, untilIso)`, not counting `exceptId`. */
  countEffectsStartedBetween(input: { triggerId: string; fromIso: string; untilIso: string; exceptId: string }): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM trigger_fires WHERE trigger_id = ? AND effect_started_at >= ? AND effect_started_at < ? AND id != ? AND ledger_state IN (${STATES_SQL_LIST})`)
      .get(input.triggerId, input.fromIso, input.untilIso, input.exceptId) as { n: number };
    return row.n;
  }

  /** When the effect of the latest fire of the trigger happened (its settling, else its acceptance), not counting `exceptId`. */
  latestReachedEffectAt(input: { triggerId: string; exceptId: string }): string | undefined {
    const row = this.db.prepare(`SELECT MAX(COALESCE(settled_at, fired_at)) AS at FROM trigger_fires WHERE trigger_id = ? AND id != ? AND ledger_state IN (${STATES_SQL_LIST})`)
      .get(input.triggerId, input.exceptId) as { at: string | null };
    return row.at ?? undefined;
  }

  /** The fires of a trigger that wait for their turn, oldest first. */
  listAcceptedOf(triggerId: string): TriggerFire[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM trigger_fires WHERE trigger_id = ? AND ledger_state = 'accepted' ORDER BY fired_at, rowid`).all(triggerId) as unknown as FireRow[];
    return rows.map(toFire);
  }

  /** The fires whose message was queued for one of the sessions in `[sinceIso, untilIso]`: the triggers that may have set those sessions going, with the depth of their chain. The date is the one of the message, not of the event: a fire made while the daemon was stopped, or held back, sends its message later. */
  causesOf(input: { sessionIds: readonly string[]; sinceIso: string; untilIso: string }): { triggerId: string; chainDepth: number }[] {
    if (input.sessionIds.length === 0) return [];
    const placeholders = input.sessionIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT DISTINCT f.trigger_id AS triggerId, f.chain_depth AS chainDepth FROM trigger_fires f JOIN message_queue m ON m.id = f.id
       WHERE m.session_id IN (${placeholders}) AND m.created_at >= ? AND m.created_at <= ? AND f.ledger_state IN (${STATES_SQL_LIST})`,
    ).all(...input.sessionIds, input.sinceIso, input.untilIso) as unknown as { triggerId: string; chainDepth: number }[];
    return rows;
  }

  /** The deepest chain among the fires whose message went to one of the sessions since `sinceIso`; 0 when none did. The message of a fire carries the id of the fire. */
  deepestChainMessagedSince(input: { sessionIds: readonly string[]; sinceIso: string }): number {
    if (input.sessionIds.length === 0) return 0;
    const placeholders = input.sessionIds.map(() => '?').join(', ');
    const row = this.db.prepare(
      `SELECT MAX(f.chain_depth) AS depth FROM trigger_fires f JOIN message_queue m ON m.id = f.id
       WHERE m.session_id IN (${placeholders}) AND f.fired_at >= ? AND f.ledger_state IN (${STATES_SQL_LIST})`,
    ).get(...input.sessionIds, input.sinceIso) as { depth: number | null };
    return row.depth ?? 0;
  }
}
