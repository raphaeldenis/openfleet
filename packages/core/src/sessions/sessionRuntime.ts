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
}

export class SessionRuntime {
  private readonly launches = new Map<string, ActiveLaunch>();
  private readonly attention = new Map<string, RuntimeAttention>();

  constructor(private readonly bus: EventBus) {}

  observeLaunch(sessionId: string, handle: HarnessHandle): void {
    const launch: ActiveLaunch = { handle, launchId: randomUUID(), hookSequence: 0, outputSequence: 0 };
    this.launches.set(sessionId, launch);
    this.setAttention(sessionId, undefined);
    handle.onData((data) => {
      const isCurrentLaunch = this.launches.get(sessionId) === launch;
      if (isCurrentLaunch && data.length > 0) launch.outputSequence += 1;
    });
    handle.onExit(() => {
      if (this.launches.get(sessionId) === launch) this.launches.delete(sessionId);
    });
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
    return runtimeAttention ? { ...session, runtimeAttention: { ...runtimeAttention } } : session;
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
