import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, Injector, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { type CreateProjectRequest, MAX_PROJECT_NAME_CHARS, type Project, type UpdateProjectRequest } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

const DOCS_FOLDER_ERROR_CODES: ReadonlySet<string> = new Set(['invalid_body', 'docs_folder_not_writable', 'path_escapes_docs_folder']);
const NAME_REQUIRED = 'Name is required';
const NAME_TOO_LONG = `The name must be ${MAX_PROJECT_NAME_CHARS} characters or fewer`;
const DOCS_FOLDER_REQUIRED = 'Docs folder is required';

interface ProjectFields {
  name: string;
  docsFolderPath: string;
}

interface SaveFailure {
  text: string;
  isAboutDocsFolder: boolean;
}

let nextFormSequence = 0;

/**
 * Creates a project, or edits the name and docs folder of the project it is given.
 * It is a group, not a `<form>`, so a page that already is a form can host it: Enter saves, Escape cancels.
 */
@Component({
  selector: 'of-project-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="project-form" role="group" [attr.aria-label]="groupLabel()" [attr.aria-busy]="pending() || null" (keydown.escape)="cancelOnEscape($event)">
      <div class="of-field">
        <label class="of-label" [for]="nameId">Name</label>
        <input #nameInput [id]="nameId" class="of-input" data-testid="project-name" [value]="name()" [readonly]="pending()" (input)="editName($event)" (keydown.enter)="saveOnEnter($event)" [attr.aria-invalid]="nameError() ? 'true' : null" [attr.aria-describedby]="nameError() ? nameErrorId : null" />
        @if (nameError(); as error) {
          <span [id]="nameErrorId" role="alert" class="of-error">{{ error }}</span>
        }
      </div>
      <div class="of-field">
        <label class="of-label" [for]="docsFolderId">Docs folder</label>
        <input #docsFolderInput [id]="docsFolderId" class="of-input" data-testid="project-docs-folder" placeholder="/path/to/docs" [value]="docsFolder()" [readonly]="pending()" (input)="editDocsFolder($event)" (keydown.enter)="saveOnEnter($event)" [attr.aria-invalid]="isDocsFolderInvalid() ? 'true' : null" [attr.aria-describedby]="docsFolderDescribedBy()" />
        <span [id]="docsFolderHintId" class="hint">Optional. Type the absolute path of an existing folder — there is no folder picker yet.</span>
        @if (docsFolderMessage(); as message) {
          <span [id]="docsFolderErrorId" role="alert" class="of-error" data-testid="project-form-error">{{ message }}</span>
        }
      </div>
      <div class="actions">
        <button type="button" class="of-btn of-btn--secondary" data-testid="project-cancel" [attr.aria-disabled]="pending() ? 'true' : null" (click)="cancel()">Cancel</button>
        <button type="button" class="of-btn of-btn--primary" data-testid="project-save" [attr.aria-disabled]="pending() ? 'true' : null" (click)="save()">{{ isEditing() ? 'Save' : 'Create project' }}</button>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .project-form { display: flex; flex-direction: column; gap: 1rem; }
    .hint { font-size: .75rem; color: var(--mut); }
    .of-error::before { content: '✕ '; }
    .actions { display: flex; justify-content: flex-end; gap: .5rem; }
  `,
})
export class ProjectFormComponent {
  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly docsFolderInput = viewChild.required<ElementRef<HTMLInputElement>>('docsFolderInput');
  private hasBeenDestroyed = false;

  /** The project to edit; the form creates a project when it has none. */
  readonly project = input<Project>();
  readonly saved = output<Project>();
  readonly cancelled = output<void>();

  private readonly sequence = nextFormSequence++;
  protected readonly nameId = `project-name-${this.sequence}`;
  protected readonly nameErrorId = `project-name-error-${this.sequence}`;
  protected readonly docsFolderId = `project-docs-folder-${this.sequence}`;
  protected readonly docsFolderHintId = `project-docs-folder-hint-${this.sequence}`;
  protected readonly docsFolderErrorId = `project-docs-folder-error-${this.sequence}`;

  protected readonly isEditing = computed(() => this.project() !== undefined);
  protected readonly groupLabel = computed(() => (this.isEditing() ? 'Edit docs folder' : 'Create a project'));
  protected readonly name = linkedSignal(() => this.project()?.name ?? '');
  protected readonly docsFolder = linkedSignal(() => this.project()?.docsFolderPath ?? '');
  protected readonly pending = signal(false);
  protected readonly nameError = signal('');
  private readonly docsFolderRequiredError = signal('');
  private readonly saveFailure = signal<SaveFailure | undefined>(undefined);

  protected readonly docsFolderMessage = computed(() => this.docsFolderRequiredError() || this.saveFailure()?.text || '');
  protected readonly isDocsFolderInvalid = computed(() => this.docsFolderRequiredError() !== '' || this.saveFailure()?.isAboutDocsFolder === true);
  protected readonly docsFolderDescribedBy = computed(() => (this.docsFolderMessage() ? `${this.docsFolderHintId} ${this.docsFolderErrorId}` : this.docsFolderHintId));

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.hasBeenDestroyed = true));
    afterNextRender(() => this.focusFirstField(), { injector: this.injector });
  }

  protected editName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.nameError.set('');
  }

  protected editDocsFolder(event: Event): void {
    this.docsFolder.set((event.target as HTMLInputElement).value);
    this.docsFolderRequiredError.set('');
    this.saveFailure.set(undefined);
  }

  protected saveOnEnter(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  protected cancelOnEscape(event: Event): void {
    event.stopPropagation();
    this.cancel();
  }

  protected cancel(): void {
    if (this.pending()) return;
    this.cancelled.emit();
  }

  protected async save(): Promise<void> {
    if (this.pending()) return;
    this.saveFailure.set(undefined);
    const fields = this.validFieldsOrFocusFirstInvalid();
    if (!fields) return;
    this.pending.set(true);
    try {
      const project = await this.saveFields(fields);
      if (!this.hasBeenDestroyed) this.saved.emit(project);
    } catch (error) {
      this.showFailure(error);
    } finally {
      this.pending.set(false);
    }
  }

  private validFieldsOrFocusFirstInvalid(): ProjectFields | undefined {
    const name = this.name().trim();
    const docsFolderPath = this.docsFolder().trim();
    const nameError = name === '' ? NAME_REQUIRED : name.length > MAX_PROJECT_NAME_CHARS ? NAME_TOO_LONG : '';
    const isDocsFolderMissing = this.isEditing() && docsFolderPath === '';
    this.nameError.set(nameError);
    this.docsFolderRequiredError.set(isDocsFolderMissing ? DOCS_FOLDER_REQUIRED : '');
    if (nameError) return this.focusAfterRender(() => this.nameInput().nativeElement.focus());
    if (isDocsFolderMissing) return this.focusAfterRender(() => this.docsFolderInput().nativeElement.focus());
    return { name, docsFolderPath };
  }

  private saveFields({ name, docsFolderPath }: ProjectFields): Promise<Project> {
    const editedProject = this.project();
    if (!editedProject) {
      const request: CreateProjectRequest = { name, ...(docsFolderPath ? { docsFolderPath } : {}) };
      return this.api.createProject(request);
    }
    const patch: UpdateProjectRequest = { ...(name === editedProject.name ? {} : { name }), docsFolderPath };
    return this.api.updateProject(editedProject.id, patch);
  }

  private showFailure(error: unknown): void {
    const isAboutDocsFolder = error instanceof ApiError && DOCS_FOLDER_ERROR_CODES.has(error.code ?? '');
    this.saveFailure.set({ text: copyFor(error, { action: 'save_project' }).text, isAboutDocsFolder });
    if (isAboutDocsFolder) this.focusAfterRender(() => this.docsFolderInput().nativeElement.focus());
  }

  private focusFirstField(): void {
    const field = this.isEditing() ? this.docsFolderInput() : this.nameInput();
    field.nativeElement.focus();
  }

  private focusAfterRender(focus: () => void): undefined {
    afterNextRender(focus, { injector: this.injector });
    return undefined;
  }
}
