import { HARNESSES } from '@openfleet/shared';

export type HarnessAvailability = 'supported' | 'unknown';

export interface KnownHarness {
  readonly id: string;
  readonly label: string;
  readonly availability: HarnessAvailability;
}

const harness = (id: string, label: string, daemonHarnessId?: string): KnownHarness => {
  const isLaunchedByTheDaemon = daemonHarnessId !== undefined && (HARNESSES as readonly string[]).includes(daemonHarnessId);
  return { id, label, availability: isLaunchedByTheDaemon ? 'supported' : 'unknown' };
};

/** The harnesses the fleet may drive; the daemon reports no state for them, so only the ones it launches are marked supported. */
export const KNOWN_HARNESSES: readonly KnownHarness[] = [
  harness('claude-code', 'Claude Code', 'claude-cli'),
  harness('codex', 'Codex'),
  harness('opencode', 'opencode'),
  harness('pi', 'pi'),
  harness('omp', 'omp'),
  harness('copilot', 'Copilot'),
  harness('cursor', 'Cursor'),
  harness('kimi', 'Kimi'),
];
