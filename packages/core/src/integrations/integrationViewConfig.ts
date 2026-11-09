import type { ViewConfigContent, ViewConfigState } from '@openfleet/shared';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import type { ViewConfigRecord } from './integrationRepository.js';
import { checkViewConfig } from './viewConfigJql.js';

/** The digest a human approves: it covers the query and the displayed fields, so a change to either one voids the approval. */
export const reviewDigestOf = ({ jql, fields }: ViewConfigContent): string => canonicalDigestOf({ jql, fields });

/** `approved` only while the content still has the digest that was approved; a row changed behind the service reads `pending`. */
export const viewConfigStateOf = (record: ViewConfigRecord): ViewConfigState =>
  record.approvedDigest !== undefined && record.approvedDigest === reviewDigestOf(record) ? 'approved' : 'pending';

/** What a poll of a profile runs: the query the daemon always ran, the approved query of a view, or nothing. */
export type PollQuery = { kind: 'default' } | ({ kind: 'approved' } & ViewConfigContent) | { kind: 'withheld' };

const isInItsCanonicalForm = (record: ViewConfigRecord): boolean => {
  const checked = checkViewConfig(record);
  return checked.ok && checked.config.jql === record.jql && checked.config.fields.join(',') === record.fields.join(',');
};

/**
 * A profile with no view configuration runs the default query. A profile with one runs the content a human approved and nothing else:
 * a proposal that is pending, edited since its approval or no longer valid is withheld, so no request is made for it.
 */
export const pollQueryOf = (record: ViewConfigRecord | undefined): PollQuery => {
  if (record === undefined) return { kind: 'default' };
  const isRunnable = viewConfigStateOf(record) === 'approved' && isInItsCanonicalForm(record);
  return isRunnable ? { kind: 'approved', jql: record.jql, fields: record.fields } : { kind: 'withheld' };
};
