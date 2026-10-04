import { signal } from '@angular/core';
import type { HandoffContent, HandoffSectionKey, HandoffSectionSource, HandoffTargetUnavailableReason } from '@openfleet/shared';
import type { HandoffPreviewApi } from './handoff-preview.api';

export type HandoffPreviewState = 'idle' | 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'loadFailed';

export const LOAD_FAILED_MESSAGE = 'The handoff preview could not be collected — try again.';
export const SAVE_FAILED_MESSAGE = 'The handoff was not written — try again.';

const SAVE_OFF_NO_DOCS_FOLDER = 'Save is off: this project has no docs folder yet.';
const SAVE_OFF_DOCS_FOLDER_UNUSABLE = 'Save is off: the docs folder is not writable.';

const SAVE_OFF_REASON_TEXT: Record<HandoffTargetUnavailableReason, string> = {
  no_project: SAVE_OFF_NO_DOCS_FOLDER,
  no_docs_folder: SAVE_OFF_NO_DOCS_FOLDER,
  docs_folder_unusable: SAVE_OFF_DOCS_FOLDER_UNUSABLE,
};

const EMPTY_SECTIONS: HandoffContent = { goal: '', state: '', decisions: '', filesTouched: '', nextSteps: '', openQuestions: '' };
const NO_SOURCES: Record<HandoffSectionKey, HandoffSectionSource> = {
  goal: 'none',
  state: 'none',
  decisions: 'none',
  filesTouched: 'none',
  nextSteps: 'none',
  openQuestions: 'none',
};

/** Drives the handoff preview of one host: collects the draft, keeps the human's edits, saves once. */
export class HandoffPreviewStore {
  private readonly stateSignal = signal<HandoffPreviewState>('idle');
  private readonly sectionsSignal = signal<HandoffContent>(EMPTY_SECTIONS);
  private readonly sourcesSignal = signal(NO_SOURCES);
  private readonly relativePathSignal = signal<string | undefined>(undefined);
  private readonly saveDisabledReasonSignal = signal<string | undefined>(undefined);
  private readonly errorSignal = signal<string | undefined>(undefined);
  private sessionId = '';
  private loadSequence = 0;

  readonly state = this.stateSignal.asReadonly();
  readonly sections = this.sectionsSignal.asReadonly();
  readonly sources = this.sourcesSignal.asReadonly();
  readonly relativePath = this.relativePathSignal.asReadonly();
  readonly saveDisabledReason = this.saveDisabledReasonSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();

  constructor(private readonly api: HandoffPreviewApi) {}

  async open(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    const thisLoad = ++this.loadSequence;
    this.stateSignal.set('loading');
    this.errorSignal.set(undefined);
    try {
      const preview = await this.api.getPreview(sessionId);
      const isSupersededByAnotherOpen = thisLoad !== this.loadSequence;
      if (isSupersededByAnotherOpen) return;
      this.sectionsSignal.set(preview.sections);
      this.sourcesSignal.set(preview.sources);
      this.relativePathSignal.set(preview.target.relativePath);
      this.saveDisabledReasonSignal.set(saveDisabledReasonOf(preview));
      this.stateSignal.set('ready');
    } catch {
      const isSupersededByAnotherOpen = thisLoad !== this.loadSequence;
      if (isSupersededByAnotherOpen) return;
      this.errorSignal.set(LOAD_FAILED_MESSAGE);
      this.stateSignal.set('loadFailed');
    }
  }

  edit(sections: HandoffContent): void {
    const isLockedWhileInFlight = this.state() === 'saving' || this.state() === 'saved';
    if (isLockedWhileInFlight) return;
    this.sectionsSignal.set(sections);
  }

  async save(): Promise<void> {
    const canSave = (this.state() === 'ready' || this.state() === 'error') && this.saveDisabledReason() === undefined;
    if (!canSave) return;
    this.stateSignal.set('saving');
    this.errorSignal.set(undefined);
    try {
      const { relativePath } = await this.api.save(this.sessionId, this.sections());
      this.relativePathSignal.set(relativePath);
      this.stateSignal.set('saved');
    } catch {
      this.errorSignal.set(SAVE_FAILED_MESSAGE);
      this.stateSignal.set('error');
    }
  }

  /** Collects the preview again after a load failure, saves the kept edits again after a save failure. */
  async retry(): Promise<void> {
    if (this.state() === 'loadFailed') return this.open(this.sessionId);
    if (this.state() === 'error') return this.save();
  }

  reset(): void {
    this.loadSequence++;
    this.sessionId = '';
    this.sectionsSignal.set(EMPTY_SECTIONS);
    this.sourcesSignal.set(NO_SOURCES);
    this.relativePathSignal.set(undefined);
    this.saveDisabledReasonSignal.set(undefined);
    this.errorSignal.set(undefined);
    this.stateSignal.set('idle');
  }
}

function saveDisabledReasonOf({ target }: { target: { available: boolean; reason?: HandoffTargetUnavailableReason } }): string | undefined {
  if (target.available) return undefined;
  return SAVE_OFF_REASON_TEXT[target.reason ?? 'no_docs_folder'];
}
