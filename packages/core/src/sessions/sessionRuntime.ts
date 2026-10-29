import { randomUUID } from 'node:crypto';
import type { RuntimeAttention, Session } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import type { HarnessHandle, TranscriptCursor } from '../harness/harness.js';
import { transcriptProgress } from './transcriptProgress.js';

export interface RuntimeProgress {
  launchId: string;
  processState: 'alive' | 'exited' | 'unknown';
  hookSequence: number;
  outputSequence: number;
  transcriptCursor?: TranscriptCursor;
}

interface ActiveLaunch {
  handle: HarnessHandle;
  launchId: string;
  hookSequence: number;
  outputSequence: number;
  outputBytes: number;
}

export class SessionRuntime {
  private readonly launches = new Map<string, ActiveLaunch>();
  private readonly attention = new Map<string, RuntimeAttention>();
  private readonly outputBytesOfEndedLaunch = new Map<string, number>();
  private readonly idsWithRestartPending = new Set<string>();

  constructor(private readonly bus: EventBus) {}

  observeLaunch(sessionId: string, handle: HarnessHandle): void {
    const launch: ActiveLaunch = { handle, launchId: randomUUID(), hookSequence: 0, outputSequence: 0, outputBytes: 0 };
    this.launches.set(sessionId, launch);
    this.outputBytesOfEndedLaunch.delete(sessionId);
    this.setAttention(sessionId, undefined);
    handle.onData((data) => {
      const isCurrentLaunch = this.launches.get(sessionId) === launch;
      if (!isCurrentLaunch || data.length === 0) return;
      launch.outputSequence += 1;
      launch.outputBytes += Buffer.byteLength(data);
    });
    handle.onExit(() => {
      if (this.launches.get(sessionId) !== launch) return;
      this.outputBytesOfEndedLaunch.set(sessionId, launch.outputBytes);
      this.launches.delete(sessionId);
    });
  }

  /** The bytes the pty of the session's last launch sent before its process ended; undefined while no launch ended. */
  outputBytesOfLastEndedLaunch(sessionId: string): number | undefined {
    return this.outputBytesOfEndedLaunch.get(sessionId);
  }

  setRestartPending(sessionId: string, isPending: boolean): void {
    if (isPending) this.idsWithRestartPending.add(sessionId);
    else this.idsWithRestartPending.delete(sessionId);
  }

  isRestartPending(sessionId: string): boolean {
    return this.idsWithRestartPending.has(sessionId);
  }

  observeHook(sessionId: string): void {
    const launch = this.launches.get(sessionId);
    if (launch) launch.hookSequence += 1;
  }

  progress(sessionId: string, transcriptPath: string | undefined): RuntimeProgress | undefined {
    const launch = this.launches.get(sessionId);
    if (!launch) return undefined;
    let processState: RuntimeProgress['processState'] = 'unknown';
    try { processState = launch.handle.probeProcess?.() ?? 'unknown'; } catch { processState = 'unknown'; }
    let transcriptCursor: TranscriptCursor | undefined;
    try {
      transcriptCursor = launch.handle.probeTranscriptProgress ? launch.handle.probeTranscriptProgress() : transcriptProgress(transcriptPath);
    } catch { transcriptCursor = undefined; }
    return { launchId: launch.launchId, processState, hookSequence: launch.hookSequence, outputSequence: launch.outputSequence, ...(transcriptCursor && { transcriptCursor: { ...transcriptCursor } }) };
  }

  project(session: Session): Session {
    const runtimeAttention = this.attention.get(session.id);
    const withAttention = runtimeAttention ? { ...session, runtimeAttention: { ...runtimeAttention } } : session;
    return this.isRestartPending(session.id) ? { ...withAttention, restartPending: true } : withAttention;
  }

  setAttention(sessionId: string, attention: RuntimeAttention | undefined): void {
    const previous = this.attention.get(sessionId);
    if (previous === undefined && attention === undefined) return;
    if (previous?.launchId === attention?.launchId && previous?.reason === attention?.reason) return;
    if (attention) this.attention.set(sessionId, { ...attention });
    else this.attention.delete(sessionId);
    this.bus.emit({ type: 'session.attention', sessionId, runtimeAttention: attention ? { ...attention } : null });
  }
}
