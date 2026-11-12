import { INTEGRATION_TOKEN_SECRET_NAME, OpenFleetError, type IntegrationHealthStatus } from '@openfleet/shared';
import { log } from '../logger.js';
import type { SecretService } from '../secrets/secretService.js';
import { credentialEchoMaskerOf, type MaskText } from './credentialEchoMasker.js';
import { allowedHostOf, isAddressAllowedFor, originOf, type IntegrationProvider, type IntegrationProviderRegistry } from './integrationProviders.js';
import type { ConnectionRecord, IntegrationRepository, ProfileRecord } from './integrationRepository.js';
import { pollQueryOf, type PollQuery } from './integrationViewConfig.js';
import { MAX_ISSUES_PER_POLL, issuesOfSearchBody } from './jiraIssues.js';
import type { ProviderAnswer, ProviderReader } from './providerReader.js';

export const POLL_INTERVAL_MS = 5 * 60_000;
export const POLL_TICK_MS = 60_000;
export const FIRST_RETRY_DELAY_MS = 60_000;
export const MAX_RETRY_DELAY_MS = 60 * 60_000;
/** A credential that three polls in a row were refused stops the polling of its connection: a fourth try could lock the account of a Data Center instance. */
export const MAX_CONSECUTIVE_AUTH_FAILURES = 3;
export const MAX_PROFILES_PER_PASS = 20;

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const ISSUE_FIELDS = 'summary,status,priority,issuetype,assignee,updated';
const UNRESOLVED_NEWEST_FIRST = 'resolution = Unresolved ORDER BY updated DESC';

/**
 * The query the daemon runs against a provider when the integration has no view configuration: fixed by the daemon, never typed by an agent.
 * A profile narrowed to a project key reads that project; any other resource reads what is assigned to the credential's owner.
 * An integration with an active view configuration runs the query a human approved; a proposal waiting for approval changes nothing. An active row that no longer matches its approval runs nothing at all.
 */
export const pollJqlOf = (resource: string | undefined): string => {
  const isProjectKey = resource !== undefined && PROJECT_KEY.test(resource);
  return isProjectKey ? `project = ${resource} AND ${UNRESOLVED_NEWEST_FIRST}` : `assignee = currentUser() AND ${UNRESOLVED_NEWEST_FIRST}`;
};

/** The wait after the `failures`-th failure in a row: one minute, doubling, never more than an hour. */
export const retryDelayMsAfter = (failures: number): number => Math.min(FIRST_RETRY_DELAY_MS * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);

/** A refused credential ends the pass for the other profiles of its connection: they share it, and each extra try is one more refusal. */
type PollOutcome = 'credential_refused' | 'settled';

export interface IntegrationPollerDeps {
  repository: IntegrationRepository;
  credentials: Pick<SecretService, 'resolve'>;
  providers: IntegrationProviderRegistry;
  reader: ProviderReader;
  clock: () => number;
}

/** What the daemon presents to the provider for one connection: the Authorization value, and the masker of every spelling of the credential behind it. */
interface Presentation { authorization: string; maskText: MaskText }

/**
 * Keeps the issues of the integrations whose provider has an issue search up to date, read only.
 * A pass asks every profile that is due, one after the other; the profile attempted longest ago comes first.
 * Whatever the provider sends back passes the masker of the credential of its connection before it is kept. `stop()` aborts the read in flight, name resolution included. A success waits `POLL_INTERVAL_MS`; a failure waits `retryDelayMsAfter` its count, the 429's own Retry-After if longer.
 * The ETag of the last answer is sent back, so an unchanged answer costs a 304. A credential refused `MAX_CONSECUTIVE_AUTH_FAILURES` times in a row stops its connection until a refresh finds it working.
 * Time comes from the injected clock; the only timer is the one that wakes a pass.
 */
export class IntegrationPoller {
  private passInProgress: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private isStopped = false;
  private abortion = new AbortController();

  constructor(private readonly deps: IntegrationPollerDeps) {}

  start(): void {
    this.isStopped = false;
    this.abortion = new AbortController();
    this.armNextPass();
  }

  /** Aborts the read in flight and resolves once the pass has finished: a pass waiting for the secret store writes nothing and asks the provider nothing once it is stopped. */
  async stop(): Promise<void> {
    this.isStopped = true;
    this.abortion.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.passInProgress?.catch(() => undefined);
  }

  /** Polls every profile that is due; a pass already running is joined, never doubled. */
  pollOnce(): Promise<void> {
    this.passInProgress ??= this.pollDueProfiles().finally(() => { this.passInProgress = undefined; });
    return this.passInProgress;
  }

  private armNextPass(): void {
    if (this.isStopped) return;
    this.timer = setTimeout(() => void this.pollOnce().catch(() => log('error', 'an integration polling pass failed; the next pass retries')).finally(() => this.armNextPass()), POLL_TICK_MS);
    this.timer.unref();
  }

  private async pollDueProfiles(): Promise<void> {
    const dueProfiles = this.deps.repository.listProfilesDueForPolling({ nowIso: this.nowIso(), limit: MAX_PROFILES_PER_PASS, pollableProviderIds: this.pollableProviderIds() });
    const connectionsRefusedInThisPass = new Set<string>();
    for (const profile of dueProfiles) {
      if (this.isStopped) return;
      const isConnectionAlreadyRefused = connectionsRefusedInThisPass.has(profile.connectionId);
      if (isConnectionAlreadyRefused) continue;
      const outcome = await this.pollProfile(profile);
      if (outcome === 'credential_refused') connectionsRefusedInThisPass.add(profile.connectionId);
    }
  }

  private pollableProviderIds(): string[] {
    const { providers } = this.deps;
    return providers.ids().filter((providerId) => providers.find(providerId)?.issueSearchPath !== undefined);
  }

  private async pollProfile(profile: ProfileRecord): Promise<PollOutcome> {
    const connection = this.deps.repository.findConnection(profile.connectionId);
    const provider = connection === undefined ? undefined : this.deps.providers.find(connection.provider);
    const issueSearchPath = provider?.issueSearchPath;
    if (connection === undefined || provider === undefined || issueSearchPath === undefined) return 'settled';

    const pollQuery = pollQueryOf(this.deps.repository.findViewConfig(profile.id));
    const isNothingApprovedToRun = pollQuery.kind === 'withheld';
    if (isNothingApprovedToRun) {
      this.recordNothingToPoll(profile);
      return 'settled';
    }

    const host = this.allowedHostOrUndefined(provider, connection);
    if (host === undefined) {
      this.recordFailure({ profile, connection }, { kind: 'unreachable' });
      return 'settled';
    }
    const presentation = await this.presentationOrUndefined(provider, connection);
    if (this.isStopped) return 'settled';
    if (this.isRevokedSince(profile, pollQuery)) return 'settled';
    if (presentation === undefined) {
      this.recordNothingToPoll(profile);
      return 'settled';
    }

    const etag = this.deps.repository.pollStateOf(profile.id)?.etag;
    const jql = pollQuery.kind === 'approved' ? pollQuery.jql : pollJqlOf(profile.resource);
    const fields = pollQuery.kind === 'approved' ? pollQuery.fields.join(',') : ISSUE_FIELDS;
    const query = new URLSearchParams({ jql, fields, maxResults: String(MAX_ISSUES_PER_POLL) });
    const answer = await this.deps.reader({
      scheme: provider.scheme, host, ...(provider.port !== undefined && { port: provider.port }), path: `${issueSearchPath}?${query.toString()}`,
      headers: { authorization: presentation.authorization, ...(etag !== undefined && { 'if-none-match': etag }) }, isAddressAllowed: (address) => isAddressAllowedFor(provider, address),
      signal: this.abortion.signal,
    });
    if (this.isStopped) return 'settled';
    if (this.isRevokedSince(profile, pollQuery)) return 'settled';
    this.record({ profile, connection, provider, host, maskText: presentation.maskText }, answer);
    return answer.kind === 'auth_failed' ? 'credential_refused' : 'settled';
  }

  /**
   * True when the configuration behind a request is no longer the one it was decided on: approved, replaced or edited while the pass waited.
   * What was decided for the old configuration is dropped whole, and the profile keeps the deadline and the empty ETag the approval gave it.
   */
  private isRevokedSince(profile: ProfileRecord, decidedQuery: PollQuery): boolean {
    const currentQuery = pollQueryOf(this.deps.repository.findViewConfig(profile.id));
    return currentQuery.identity !== decidedQuery.identity;
  }

  private allowedHostOrUndefined(provider: IntegrationProvider, connection: ConnectionRecord): string | undefined {
    try {
      return allowedHostOf(provider, connection.allowedHosts[0] ?? '');
    } catch {
      return undefined;
    }
  }

  /** The Authorization value and the masker of the credential, or undefined when this device holds no credential for the connection or the secret store cannot answer: nobody is asked, nothing is counted against the provider. */
  private async presentationOrUndefined(provider: IntegrationProvider, connection: ConnectionRecord): Promise<Presentation | undefined> {
    try {
      const credential = await this.deps.credentials.resolve({ kind: 'connection', id: connection.id }, INTEGRATION_TOKEN_SECRET_NAME);
      const authorization = provider.authorizationOf(credential);
      return { authorization, maskText: credentialEchoMaskerOf({ credential, authorization }) };
    } catch (error) {
      const isExpected = error instanceof OpenFleetError && (error.code === 'secret_not_connected_on_this_device' || error.code === 'secret_store_unavailable');
      if (!isExpected) log('error', 'the credential of an integration could not be read for polling', error);
      return undefined;
    }
  }

  private record(context: { profile: ProfileRecord; connection: ConnectionRecord; provider: IntegrationProvider; host: string; maskText: MaskText }, answer: ProviderAnswer): void {
    const { profile, connection, provider, host, maskText } = context;
    if (answer.kind === 'not_modified') return this.recordSuccess({ profile, connection }, { health: 'ok', etag: this.deps.repository.pollStateOf(profile.id)?.etag });
    if (answer.kind !== 'ok') return this.recordFailure({ profile, connection }, answer);
    const issues = issuesOfSearchBody(answer.body, originOf(provider, host), { maskText });
    if (issues === undefined) return this.recordFailure({ profile, connection }, { kind: 'unreachable' });
    this.deps.repository.replaceItems(profile.id, issues, { fetchedAt: this.nowIso() });
    const isEtagFreeOfTheMaskedValue = answer.etag !== undefined && maskText(answer.etag) === answer.etag;
    this.recordSuccess({ profile, connection }, { health: 'ok', ...(isEtagFreeOfTheMaskedValue && { etag: answer.etag }) });
  }

  private recordSuccess({ profile, connection }: { profile: ProfileRecord; connection: ConnectionRecord }, { health, etag }: { health: IntegrationHealthStatus; etag?: string | undefined }): void {
    const now = this.deps.clock();
    this.deps.repository.saveConnectionPolling(connection.id, { consecutiveAuthFailures: 0, isStopped: false });
    this.deps.repository.saveHealth(profile.id, { status: health, checkedAt: this.nowIso() });
    this.deps.repository.savePollState(profile.id, { ...(etag !== undefined && { etag }), consecutiveFailures: 0, nextPollAt: new Date(now + POLL_INTERVAL_MS).toISOString(), lastPolledAt: new Date(now).toISOString() });
  }

  private recordFailure({ profile, connection }: { profile: ProfileRecord; connection: ConnectionRecord }, answer: Exclude<ProviderAnswer, { kind: 'ok' | 'not_modified' }>): void {
    const now = this.deps.clock();
    const previous = this.deps.repository.pollStateOf(profile.id);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const retryAfterMs = answer.kind === 'rate_limited' && answer.retryAfterSeconds !== undefined ? answer.retryAfterSeconds * 1000 : 0;
    const delayMs = Math.max(retryDelayMsAfter(consecutiveFailures), Math.min(retryAfterMs, MAX_RETRY_DELAY_MS));
    this.deps.repository.saveHealth(profile.id, { status: answer.kind, checkedAt: new Date(now).toISOString() });
    this.deps.repository.savePollState(profile.id, {
      ...(previous?.etag !== undefined && { etag: previous.etag }), consecutiveFailures, nextPollAt: new Date(now + delayMs).toISOString(), lastPolledAt: new Date(now).toISOString(),
    });
    if (answer.kind === 'auth_failed') this.countAuthFailure(connection);
  }

  private countAuthFailure(connection: ConnectionRecord): void {
    const consecutiveAuthFailures = this.deps.repository.connectionPollingOf(connection.id).consecutiveAuthFailures + 1;
    const isStopped = consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES;
    this.deps.repository.saveConnectionPolling(connection.id, { consecutiveAuthFailures, isStopped });
    if (isStopped) log('warn', 'polling of an integration connection stopped after its credential was refused', undefined, { connectionId: connection.id });
  }

  /** Nothing was asked of the provider: the profile is looked at again in a normal interval, with its failures and health as they were. */
  private recordNothingToPoll(profile: ProfileRecord): void {
    const now = this.deps.clock();
    const previous = this.deps.repository.pollStateOf(profile.id);
    this.deps.repository.savePollState(profile.id, {
      ...(previous?.etag !== undefined && { etag: previous.etag }), consecutiveFailures: previous?.consecutiveFailures ?? 0, nextPollAt: new Date(now + POLL_INTERVAL_MS).toISOString(), lastPolledAt: new Date(now).toISOString(),
    });
  }

  private nowIso(): string {
    return new Date(this.deps.clock()).toISOString();
  }
}
