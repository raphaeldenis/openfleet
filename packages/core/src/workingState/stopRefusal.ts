import { WORKING_STATE_SECTIONS, type StopHookOutput, type WorkingState, type WorkingStateSections } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { renderWorkingState } from './renderWorkingState.js';
import { ageInWholeMinutes, ageMsOf, isOlderThanLimit, isWrittenBeforeFleetChanged, minutesLabel } from './stateFreshness.js';
import type { FleetChange, WorkingStateService } from './workingStateService.js';
import type { WorkingStateSettings } from './workingStateSettings.js';

const MAX_CHILDREN_NAMED = 10;
const UPDATE_TOOL_NAME = 'update_working_state';
const SECTION_ARGUMENT_NAMES = 'plan, todo, remaining, questions_for_human, internal_questions, blockers';

export interface StopRefusalDeps { db: DatabaseSync; workingStates: WorkingStateService; settings: WorkingStateSettings; clock: () => string }

/** Decides whether the end of a turn is refused: a block answers the Stop, no block lets the turn end. */
export class StopRefusal {
  constructor(private readonly deps: StopRefusalDeps) {}

  decide({ sessionId, stopHookActive }: { sessionId: string; stopHookActive: boolean }): StopHookOutput | undefined {
    const isContinuationOfEarlierRefusal = stopHookActive;
    if (isContinuationOfEarlierRefusal || !this.deps.settings.enforce) return undefined;

    const state = this.deps.workingStates.get(sessionId);
    const reason = state === undefined ? this.missingStateReason() : this.reasonToRefuseStoredState(state);
    return reason === undefined ? undefined : { decision: 'block', reason };
  }

  private reasonToRefuseStoredState(state: WorkingState): string | undefined {
    const ageMs = ageMsOf(state, this.deps.clock());
    if (isOlderThanLimit(ageMs, this.deps.settings.maxAgeMinutes)) return this.staleByAgeReason(ageInWholeMinutes(ageMs));
    if (isWrittenBeforeFleetChanged(state)) return this.staleByFleetReason(state);

    const sizeInBytes = Buffer.byteLength(renderWorkingState(sectionsOf(state)), 'utf8');
    const isOverCap = sizeInBytes > this.deps.settings.maxBytes;
    if (isOverCap) return this.oversizeReason(sizeInBytes);
    return undefined;
  }

  private missingStateReason(): string {
    return `No working state is recorded for this session. Before ending the turn, call the MCP tool ${UPDATE_TOOL_NAME} with all six sections (${SECTION_ARGUMENT_NAMES}), each a list of short lines.`;
  }

  private staleByAgeReason(ageMinutes: number): string {
    return `Your working state is ${minutesLabel(ageMinutes)} old (the limit is ${this.deps.settings.maxAgeMinutes}). Before ending the turn, refresh it with the MCP tool ${UPDATE_TOOL_NAME}.`;
  }

  private staleByFleetReason(state: WorkingState): string {
    const distinctEntries = distinctChildKindEntries(this.fleetChangesSince(state.sessionId, state.updatedAt));
    const named = distinctEntries.slice(0, MAX_CHILDREN_NAMED);
    const hiddenCount = distinctEntries.length - named.length;
    const listing = hiddenCount > 0 ? `${named.join(', ')} and ${hiddenCount} more` : named.join(', ');
    return `Your working state was written before your fleet changed: ${listing}. Before ending the turn, update it with the MCP tool ${UPDATE_TOOL_NAME} so it matches your live children.`;
  }

  private oversizeReason(sizeInBytes: number): string {
    return `Your working state is ${sizeInBytes} bytes, the cap is ${this.deps.settings.maxBytes}: keep the current state only, move history to the log. Before ending the turn, replace it with the MCP tool ${UPDATE_TOOL_NAME}.`;
  }

  private fleetChangesSince(sessionId: string, since: string): FleetChange[] {
    return this.deps.workingStates.fleetChanges(sessionId).filter((change) => change.changedAt > since);
  }
}

/** Returns one "name (kind)" entry per distinct child and kind, in the chronological order of its first change. */
function distinctChildKindEntries(changesOldestFirst: FleetChange[]): string[] {
  const entries = changesOldestFirst.map((change) => `${change.name} (${change.kind})`);
  return [...new Set(entries)];
}

function sectionsOf(state: WorkingState): WorkingStateSections {
  return Object.fromEntries(WORKING_STATE_SECTIONS.map((key) => [key, state[key]])) as unknown as WorkingStateSections;
}
