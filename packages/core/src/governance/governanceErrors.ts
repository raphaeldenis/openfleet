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
