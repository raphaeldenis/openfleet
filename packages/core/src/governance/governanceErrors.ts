import { MAX_PENDING_PROPOSALS_PER_MANAGER } from '@openfleet/shared';

export class GovernanceQueueFullError extends Error {
  constructor() {
    super(`the governance queue already holds ${MAX_PENDING_PROPOSALS_PER_MANAGER} pending proposals.`);
  }
}

/** The proposal does not exist, or belongs to another manager: both read the same. */
export class ProposalNotFoundError extends Error {
  constructor() {
    super('the proposal does not exist.');
  }
}

export class LawNotFoundError extends Error {
  constructor() {
    super('the law does not exist.');
  }
}

/** The law changed since the caller read it. */
export class LawRevisionConflictError extends Error {
  constructor(readonly currentRev: number) {
    super('the law changed since it was read.');
  }
}

/** A withdrawn law is history: it is neither edited nor withdrawn again. */
export class LawWithdrawnError extends Error {
  constructor() {
    super('the law is withdrawn.');
  }
}
