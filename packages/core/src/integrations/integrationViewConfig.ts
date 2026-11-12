import type { ActiveViewStatus, ViewConfigContent } from '@openfleet/shared';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import type { ActiveViewRecord, ViewConfigRecord } from './integrationRepository.js';
import { checkViewConfig } from './viewConfigJql.js';

/** The digest a human approves: it covers the query and the displayed fields, so a change to either one voids the approval. */
export const reviewDigestOf = ({ jql, fields }: ViewConfigContent): string => canonicalDigestOf({ jql, fields });

const isInItsCanonicalForm = (content: ViewConfigContent): boolean => {
  const checked = checkViewConfig(content);
  return checked.ok && checked.config.jql === content.jql && checked.config.fields.join(',') === content.fields.join(',');
};

/** `running` only while the content still has the digest that was approved and is a query the daemon accepts as it stands; a row changed behind the service reads `withheld`. */
export const activeStatusOf = (active: ActiveViewRecord): ActiveViewStatus => {
  const hasTheApprovedDigest = active.approvedDigest === reviewDigestOf(active);
  return hasTheApprovedDigest && isInItsCanonicalForm(active) ? 'running' : 'withheld';
};

/**
 * What a poll of a profile runs: the query the daemon always ran, the active configuration a human approved, or nothing.
 * `identity` names the exact request the answer belongs to: it changes whenever the query, the fields or the approval behind it change.
 */
export type PollQuery =
  | { kind: 'default'; identity: string }
  | ({ kind: 'approved'; identity: string } & ViewConfigContent)
  | { kind: 'withheld'; identity: string };

const DEFAULT_QUERY_IDENTITY = JSON.stringify(['default']);

const identityOf = (kind: 'approved' | 'withheld', active: ActiveViewRecord): string =>
  JSON.stringify([kind, active.approvedRev, active.approvedDigest, active.jql, active.fields]);

/**
 * A profile with no active configuration runs the default query, whatever proposal is waiting: a proposal never changes what is polled.
 * A profile with one runs the content a human approved and nothing else; when the stored content no longer matches its approval, nothing runs at all, the default query included.
 */
export const pollQueryOf = (record: ViewConfigRecord | undefined): PollQuery => {
  const active = record?.active;
  if (active === undefined) return { kind: 'default', identity: DEFAULT_QUERY_IDENTITY };
  const isRunnable = activeStatusOf(active) === 'running';
  return isRunnable
    ? { kind: 'approved', identity: identityOf('approved', active), jql: active.jql, fields: active.fields }
    : { kind: 'withheld', identity: identityOf('withheld', active) };
};
