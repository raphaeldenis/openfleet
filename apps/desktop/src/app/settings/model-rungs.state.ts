import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

export const MODEL_RUNGS: ReadonlyArray<{ rung: string; description: string }> = [
  { rung: 'haiku', description: 'Model id for the haiku rung' },
  { rung: 'sonnet', description: 'Model id for the sonnet rung' },
  { rung: 'opus', description: 'Model id for the opus rung' },
  { rung: 'fable', description: 'Model id for the fable rung' },
];

export interface ModelChange {
  rung: string;
  modelId: string;
}

type ModelSaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; change: ModelChange }
  | { kind: 'saved'; rung: string }
  | { kind: 'failed'; change: ModelChange; cause: string };

const GENERIC_SAVE_FAILURE = 'Something went wrong. Your change was not applied.';

function describeSaveFailure(failure: unknown): string {
  if (!(failure instanceof ApiError)) return GENERIC_SAVE_FAILURE;
  const isConfigReadOnly = failure.status === 409 && failure.code === 'config_read_only';
  if (isConfigReadOnly) return 'config.json is read-only. Your change was not applied.';
  const isConfigUnreadable = failure.status === 409 && failure.code === 'config_unreadable';
  if (isConfigUnreadable) return 'config.json couldn’t be read. Your change was not applied.';
  const isModelIdRefused = failure.status === 400;
  if (isModelIdRefused) return 'The daemon rejected this model id.';
  return GENERIC_SAVE_FAILURE;
}

function isModelTable(body: unknown): body is Record<string, string> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function isAvailableModels(body: unknown): body is { models: string[] } {
  return typeof body === 'object' && body !== null && 'models' in body && Array.isArray(body.models);
}

/** The model id of each rung as the daemon holds it, the ids a rung can take, and the save of one rung's id. Lives as long as the Settings screen so switching sections never refetches. */
@Injectable()
export class ModelRungsState {
  private readonly api = inject(FleetApiService);

  readonly modelTable = signal<Record<string, string> | null>(null);
  readonly hasFailedToLoad = signal(false);
  readonly saveState = signal<ModelSaveState>({ kind: 'idle' });
  private readonly availableModels = signal<string[]>([]);

  readonly isSaving = computed(() => this.saveState().kind === 'saving');

  /** Each rung offers every available model, plus its current id when the daemon does not list it, so a custom id stays selectable. */
  readonly optionIdsByRung = computed(() => {
    const available = this.availableModels();
    const table = this.modelTable() ?? {};
    return Object.fromEntries(
      MODEL_RUNGS.map(({ rung }) => {
        const currentId = table[rung];
        const currentIdIsMissing = !!currentId && !available.includes(currentId);
        return [rung, currentIdIsMissing ? [...available, currentId] : available];
      }),
    );
  });

  /** One persistent live region carries every progress and success notice, so a screen reader announces the text change. */
  readonly saveStatusMessage = computed(() => {
    const state = this.saveState();
    if (state.kind === 'saving') return `Saving ${state.change.rung}…`;
    if (state.kind === 'saved') return `✓ Saved ${state.rung}.`;
    return '';
  });

  /** The id a rung shows: the one being saved while its save runs, otherwise the one the daemon holds; empty when the daemon sent none. */
  displayedIdOf(rung: string): string {
    const state = this.saveState();
    const isBeingSaved = state.kind === 'saving' && state.change.rung === rung;
    return isBeingSaved ? state.change.modelId : (this.modelTable()?.[rung] ?? '');
  }

  async load(): Promise<void> {
    const [tableResult, availableResult] = await Promise.allSettled([this.api.models(), this.api.availableModels()]);
    if (availableResult.status === 'fulfilled' && isAvailableModels(availableResult.value)) this.availableModels.set(availableResult.value.models);
    const table: unknown = tableResult.status === 'fulfilled' ? tableResult.value : undefined;
    if (isModelTable(table)) this.modelTable.set(table);
    else this.hasFailedToLoad.set(true);
  }

  /** Saves the chosen id at once; a choice that repeats the saved id, or that arrives while another save runs, is ignored. */
  async choose(change: ModelChange): Promise<void> {
    const isAlreadySaved = this.modelTable()?.[change.rung] === change.modelId;
    if (this.isSaving() || isAlreadySaved) return;
    await this.save(change);
  }

  async retry(change: ModelChange): Promise<void> {
    await this.save(change);
  }

  private async save(change: ModelChange): Promise<void> {
    const { rung, modelId } = change;
    this.saveState.set({ kind: 'saving', change });
    try {
      const { models } = await this.api.saveModels({ [rung]: modelId });
      this.modelTable.set(models);
      this.saveState.set({ kind: 'saved', rung });
    } catch (failure) {
      this.saveState.set({ kind: 'failed', change, cause: describeSaveFailure(failure) });
    }
  }
}
