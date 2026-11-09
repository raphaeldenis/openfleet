import type { IntegrationIssueItem } from '@openfleet/shared';

export const MAX_ISSUES_PER_POLL = 50;
export const MAX_SUMMARY_CHARS = 200;
export const MAX_LABEL_CHARS = 64;

/** An issue as the daemon keeps it: the key is checked and the address built here, the text a person typed in Jira is cleaned, cut and kept under `untrusted`. */
export type IssueSummary = IntegrationIssueItem;

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;
const CONTROL_AND_INVISIBLE_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const ELLIPSIS = '…';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const withoutMarkup = (text: string): string => text.replaceAll('<', '‹').replaceAll('>', '›');

/** Removes control, bidirectional and zero-width characters, turns every run of blanks into one space, defuses angle brackets and cuts to `maxChars` characters. */
const cleanedText = (text: string, maxChars: number): string => {
  const visible = text.replace(CONTROL_AND_INVISIBLE_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(withoutMarkup(visible));
  const isTooLong = characters.length > maxChars;
  return isTooLong ? `${characters.slice(0, maxChars - 1).join('')}${ELLIPSIS}` : characters.join('');
};

const cleanedLabelOf = (value: unknown, maxChars: number): string | undefined => (typeof value === 'string' ? cleanedText(value, maxChars) : undefined);

const nameOf = (field: unknown, nameKey: string): string | undefined => (isObject(field) ? cleanedLabelOf(field[nameKey], MAX_LABEL_CHARS) : undefined);

const isoOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};

const issueOf = (entry: unknown, origin: string): IssueSummary | undefined => {
  if (!isObject(entry) || !isObject(entry.fields)) return undefined;
  const { key, fields } = entry;
  const isValidKey = typeof key === 'string' && ISSUE_KEY.test(key);
  if (!isValidKey) return undefined;
  const status = nameOf(fields.status, 'name');
  const priority = nameOf(fields.priority, 'name');
  const issueType = nameOf(fields.issuetype, 'name');
  const assignee = nameOf(fields.assignee, 'displayName');
  const updatedAt = isoOf(fields.updated);
  return {
    key, url: `${origin}/browse/${key}`, ...(updatedAt !== undefined && { updatedAt }),
    untrusted: {
      summary: cleanedLabelOf(fields.summary, MAX_SUMMARY_CHARS) ?? '',
      ...(status !== undefined && { status }), ...(priority !== undefined && { priority }), ...(issueType !== undefined && { issueType }), ...(assignee !== undefined && { assignee }),
    },
  };
};

/** The issues of the first page of a search answer, or undefined when the answer is not the shape of a search. An entry that is not a well-formed issue is skipped. */
export const issuesOfSearchBody = (body: unknown, origin: string): IssueSummary[] | undefined => {
  if (!isObject(body) || !Array.isArray(body.issues)) return undefined;
  const issues = body.issues.map((entry) => issueOf(entry, origin)).filter((issue): issue is IssueSummary => issue !== undefined);
  return issues.slice(0, MAX_ISSUES_PER_POLL);
};
