import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { IntegrationRepository } from './integrationRepository.js';

const NOW = '2026-11-09T10:00:00.000Z';
const EARLIER = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const LATER = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const JIRA = 'jira_cloud';
const GITHUB = 'github';

let db: DatabaseSync;
let repository: IntegrationRepository;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run();
  repository = new IntegrationRepository(db);
  repository.insertConnection({ id: 'jira-connection', name: 'Jira', provider: JIRA, credentialKind: 'token', allowedHosts: ['acme.atlassian.net'] }, { createdAt: 'now' });
  repository.insertConnection({ id: 'github-connection', name: 'Hub', provider: GITHUB, credentialKind: 'token', allowedHosts: ['api.github.com'] }, { createdAt: 'now' });
});

const addProfile = (id: string, connectionId = 'jira-connection') =>
  repository.insertProfile({ id, projectId: 'p', connectionId, name: id, resource: 'CCM' }, { createdAt: 'now' });
const recordPoll = (profileId: string, { lastPolledAt, nextPollAt }: { lastPolledAt: string; nextPollAt: string }) =>
  repository.savePollState(profileId, { consecutiveFailures: 0, lastPolledAt, nextPollAt });
const dueIds = (overrides: Partial<Parameters<IntegrationRepository['listProfilesDueForPolling']>[0]> = {}) =>
  repository.listProfilesDueForPolling({ nowIso: NOW, limit: 20, pollableProviderIds: [JIRA], ...overrides }).map((profile) => profile.id);

describe('which profiles are due for polling', () => {
  it('never lists a profile whose provider is not pollable, however many there are before the others', () => {
    for (let index = 0; index < 25; index++) addProfile(`a${String(index).padStart(2, '0')}`, 'github-connection');
    addProfile('zjira');

    expect(dueIds()).toEqual(['zjira']);
  });

  it('lists nothing when no provider is pollable', () => {
    addProfile('jira-profile');

    expect(dueIds({ pollableProviderIds: [] })).toEqual([]);
  });

  it('lists the profiles of every pollable provider', () => {
    addProfile('jira-profile');
    addProfile('github-profile', 'github-connection');

    expect(dueIds({ pollableProviderIds: [JIRA, GITHUB] }).sort()).toEqual(['github-profile', 'jira-profile']);
  });

  it('lists a never-polled profile and one whose next poll is now or earlier, and not one whose next poll is later', () => {
    addProfile('never');
    addProfile('just-due');
    addProfile('overdue');
    addProfile('not-yet');
    recordPoll('just-due', { lastPolledAt: EARLIER(5), nextPollAt: NOW });
    recordPoll('overdue', { lastPolledAt: EARLIER(9), nextPollAt: EARLIER(4) });
    recordPoll('not-yet', { lastPolledAt: EARLIER(1), nextPollAt: LATER(1) });

    expect(dueIds().sort()).toEqual(['just-due', 'never', 'overdue']);
  });

  it('serves the profile never attempted first, then the one attempted longest ago, whatever their ids', () => {
    addProfile('a-recent');
    addProfile('b-oldest');
    addProfile('c-never');
    addProfile('d-middle');
    recordPoll('a-recent', { lastPolledAt: EARLIER(1), nextPollAt: EARLIER(1) });
    recordPoll('b-oldest', { lastPolledAt: EARLIER(30), nextPollAt: EARLIER(1) });
    recordPoll('d-middle', { lastPolledAt: EARLIER(10), nextPollAt: EARLIER(1) });

    expect(dueIds()).toEqual(['c-never', 'b-oldest', 'd-middle', 'a-recent']);
  });

  it('breaks a tie of last attempts by id', () => {
    addProfile('b');
    addProfile('a');
    recordPoll('a', { lastPolledAt: EARLIER(5), nextPollAt: EARLIER(1) });
    recordPoll('b', { lastPolledAt: EARLIER(5), nextPollAt: EARLIER(1) });

    expect(dueIds()).toEqual(['a', 'b']);
  });

  it('serves a profile that was attempted before a profile whose next poll is earlier but was attempted later', () => {
    addProfile('retrying-often');
    addProfile('waiting-long');
    recordPoll('retrying-often', { lastPolledAt: EARLIER(1), nextPollAt: EARLIER(3) });
    recordPoll('waiting-long', { lastPolledAt: EARLIER(20), nextPollAt: EARLIER(1) });

    expect(dueIds()).toEqual(['waiting-long', 'retrying-often']);
  });

  it('keeps to the limit, taking the oldest attempts', () => {
    for (const [id, minutesAgo] of [['p1', 5], ['p2', 4], ['p3', 3], ['p4', 2]] as const) {
      addProfile(id);
      recordPoll(id, { lastPolledAt: EARLIER(minutesAgo), nextPollAt: EARLIER(1) });
    }

    expect(dueIds({ limit: 2 })).toEqual(['p1', 'p2']);
  });

  it('leaves out the profiles of a connection whose polling is stopped', () => {
    addProfile('stopped-profile');
    repository.saveConnectionPolling('jira-connection', { consecutiveAuthFailures: 3, isStopped: true });

    expect(dueIds()).toEqual([]);
  });
});
