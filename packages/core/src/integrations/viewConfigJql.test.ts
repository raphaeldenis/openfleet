import { describe, expect, it } from 'vitest';
import { MAX_JQL_CHARS, MAX_JQL_CLAUSES, checkViewConfig } from './viewConfigJql.js';

const FIELDS = ['summary', 'status'];

const accepted = (jql: string) => {
  const outcome = checkViewConfig({ jql, fields: FIELDS });
  if (!outcome.ok) throw new Error(`expected an accepted query, got: ${outcome.issues.join(' | ')}`);
  return outcome.config;
};
const issuesOf = (jql: string, fields: string[] = FIELDS) => {
  const outcome = checkViewConfig({ jql, fields });
  return outcome.ok ? [] : outcome.issues;
};

describe('the JQL of a view configuration', () => {
  it('rebuilds a simple query from its parts, with every value quoted', () => {
    const { jql } = accepted('project = CCM and status in (Open, "In Progress") order by updated desc');

    expect(jql).toBe('project = "CCM" AND status IN ("Open", "In Progress") ORDER BY updated DESC');
  });

  it('accepts the owner of the credential, an unresolved issue, an empty field and a relative date', () => {
    const { jql } = accepted('assignee = currentUser() AND resolution = Unresolved AND priority != EMPTY AND updated >= -7d');

    expect(jql).toBe('assignee = currentUser() AND resolution = "Unresolved" AND priority != EMPTY AND updated >= -7d');
  });

  it('escapes the quotes and backslashes of a value so that it cannot close its string', () => {
    const { jql } = accepted('labels = "a\\"b\\\\c"');

    expect(jql).toBe('labels = "a\\"b\\\\c"');
  });

  it.each([
    ['an OR', 'project = CCM OR project = ABC'],
    ['a function that is not currentUser', 'assignee = membersOf("admins")'],
    ['currentUser on a field that is not a person', 'project = currentUser()'],
    ['a field outside the list', 'description = x'],
    ['a text search operator', 'summary ~ "x"'],
    ['a clause with no operator', 'project'],
    ['a trailing garbage', 'project = CCM AND'],
    ['a semicolon', 'project = CCM; DROP'],
    ['a comment marker', 'project = CCM -- x'],
    ['an unterminated string', 'project = "CCM'],
    ['a bad escape in a string', 'labels = "a\\nb"'],
    ['a control character in a string', 'labels = "a\u0007b"'],
    ['a relative date on a field that is not a date', 'project >= -7d'],
    ['an ordering operator on a name', 'project > CCM'],
    ['an ORDER BY on a field outside the list', 'project = CCM ORDER BY description'],
    ['two ORDER BY', 'project = CCM ORDER BY updated ORDER BY created'],
    ['an empty text', '   '],
    ['an empty list', 'status IN ()'],
    ['a curly brace', 'project = {CCM}'],
  ])('refuses %s', (_name, jql) => {
    expect(issuesOf(jql)).not.toEqual([]);
  });

  it('refuses a text longer than the bound', () => {
    expect(issuesOf(`project = "${'A'.repeat(MAX_JQL_CHARS)}"`)).not.toEqual([]);
  });

  it('refuses more clauses than the bound and accepts exactly the bound', () => {
    const clauses = (count: number) => Array.from({ length: count }, (_, index) => `labels = l${index}`).join(' AND ');

    expect(issuesOf(clauses(MAX_JQL_CLAUSES))).toEqual([]);
    expect(issuesOf(clauses(MAX_JQL_CLAUSES + 1))).not.toEqual([]);
  });

  it('refuses a list of more values than the bound', () => {
    const values = Array.from({ length: 21 }, (_, index) => `v${index}`).join(', ');

    expect(issuesOf(`labels IN (${values})`)).not.toEqual([]);
  });

  it('never echoes the refused text in its issues', () => {
    const issues = issuesOf('description = leaked-marker-text');

    expect(issues.join(' ')).not.toContain('leaked-marker-text');
  });
});

describe('the canonical form of the JQL of a view configuration', () => {
  const labelsInTwentyValues = 'labels in (a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t)';
  const eightClausesOfTwentyLabels = Array(8).fill(labelsInTwentyValues).join(' and ');

  it('refuses a query whose canonical form exceeds the bound even though the typed text is within it', () => {
    const typedLength = eightClausesOfTwentyLabels.length;

    const issues = issuesOf(eightClausesOfTwentyLabels);

    expect(typedLength).toBeLessThanOrEqual(MAX_JQL_CHARS);
    expect(issues).not.toEqual([]);
  });

  it('names the bound in the refusal, never the text', () => {
    const issues = issuesOf(eightClausesOfTwentyLabels);

    expect(issues.join(' ')).toContain(String(MAX_JQL_CHARS));
    expect(issues.join(' ')).not.toContain('labels in');
  });

  it.each([
    ['a simple query', 'project = CCM and status in (Open, "In Progress") order by updated desc'],
    ['bare values that gain quotes', 'labels in (a,b,c) and component = x'],
    ['escaped quotes and backslashes', 'labels = "a\\"b\\\\c"'],
    ['the keywords EMPTY and currentUser', 'assignee = currentUser() AND priority != EMPTY'],
    ['a quoted keyword that stays a string', 'labels = "EMPTY" AND labels = "currentUser"'],
    ['dates, relative and absolute', 'updated >= -7d AND created < 2026-11-09'],
    ['mixed case operators and newlines', 'project = CCM\nAND\tstatus not in (Open,Closed)\nORDER BY priority asc'],
    ['an expansion that just fits', Array(2).fill(labelsInTwentyValues).join(' and ')],
  ])('is idempotent: validating the canonical form of %s returns the same canonical form', (_name, jql) => {
    const once = accepted(jql);

    const twice = accepted(once.jql);

    expect(twice).toEqual(once);
  });
});

describe('the displayed fields of a view configuration', () => {
  it('keeps the fields of the list, once each, in the order of the list', () => {
    const outcome = checkViewConfig({ jql: 'project = CCM', fields: ['status', 'summary', 'status'] });

    expect(outcome).toMatchObject({ ok: true, config: { fields: ['summary', 'status'] } });
  });

  it.each([
    ['an unknown field', ['summary', 'description']],
    ['no field', []],
    ['a list with no summary', ['status']],
  ])('refuses %s', (_name, fields) => {
    expect(issuesOf('project = CCM', fields)).not.toEqual([]);
  });
});
