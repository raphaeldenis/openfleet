import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, Injector, input, model, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAX_PROJECT_NAME_CHARS, renderProjectNote, type CreateProjectRequest, type DetectedRepository, type Project, type ProjectCommandName, type ProjectProfile } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { STEP_PANEL_STYLES } from './step-panel.styles';

const DOCS_FOLDER_ERROR_CODES: ReadonlySet<string> = new Set(['invalid_body', 'docs_folder_not_writable', 'docs_folder_already_used', 'path_escapes_docs_folder', 'docs_root_invalid', 'docs_root_forbidden', 'docs_root_not_writable']);
const NAME_REQUIRED = 'Name is required';
const NAME_TOO_LONG = `The name must be ${MAX_PROJECT_NAME_CHARS} characters or fewer`;
const DOCS_FOLDER_REQUIRED = 'Docs folder is required';
const DOCS_FOLDER_DOT_SEGMENT = 'That folder path cannot contain "." or ".." — type the full absolute path.';
const hasDotSegment = (path: string): boolean => path.split('/').some((segment) => segment === '.' || segment === '..');
const DOCS_SUBFOLDERS = ['specs/', 'plans/', 'handoffs/', 'reports/'];
const COMMAND_FIELDS: ReadonlyArray<{ kind: ProjectCommandName; label: string }> = [
  { kind: 'install', label: 'install' },
  { kind: 'build', label: 'build' },
  { kind: 'test', label: 'test' },
  { kind: 'dev', label: 'dev server' },
];

type CommandValues = Record<ProjectCommandName, string>;

const noCommands = (): CommandValues => ({ install: '', build: '', test: '', dev: '' });

@Component({
  selector: 'of-project-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorLineComponent],
  template: `
    <section class="step-panel" data-testid="onboarding-step-project">
      <header>
        <span class="kicker">Step 3 of 6 · Project</span>
        <h1>Define the project</h1>
        <p>Name, goal, repositories and commands. This becomes the “Project: &lt;name&gt;” note every manager reads.</p>
      </header>
      <form class="project-form" (ngSubmit)="continueToFirstSession()" (keydown.escape)="cancelOnEscape($event)">
        <div class="columns">
          <div class="card fields" [attr.aria-busy]="pending() || null">
            @if (savedProject(); as project) {
              <p>Project ready: <strong>{{ project.name }}</strong></p>
              @if (project.docsFolderPath; as savedFolder) {
                <p class="hint">Specs and docs are saved in <span class="mono">{{ savedFolder }}</span></p>
              }
            } @else {
              <div class="of-field">
                <label class="of-label" for="project-name">Name</label>
                <input id="project-name" class="of-input name-input" data-testid="project-name" [ngModel]="name()" (ngModelChange)="editName($event)" name="projectName" [readonly]="pending()" (keydown.enter)="createOnEnter($event)" [attr.aria-invalid]="nameError() ? 'true' : null" [attr.aria-describedby]="nameError() ? 'project-name-error' : null" />
                @if (nameError(); as error) {
                  <of-error-line id="project-name-error" role="alert">{{ error }}</of-error-line>
                }
              </div>
              <div class="of-field">
                <label class="of-label" for="project-goal">Goal · one paragraph</label>
                <textarea id="project-goal" class="of-input goal-input" rows="3" name="projectGoal" [ngModel]="goal()" (ngModelChange)="goal.set($event)" [readonly]="pending()"></textarea>
              </div>
            }
            <div class="of-field">
              <label class="of-label" for="repository-path">Repository path</label>
              <input id="repository-path" class="of-input" name="repositoryPath" [ngModel]="repositoryPath()" (ngModelChange)="repositoryPath.set($event)" (change)="detectFromRepository()" placeholder="/path/to/repository" />
            </div>
            @if (!savedProject()) {
              <div class="of-field">
                <label class="of-label" for="stack-draft">Stack</label>
                <div class="chips" data-testid="stack-chips">
                  @for (item of stack(); track item) {
                    <span class="chip">{{ item }} <button type="button" class="chip-remove" [attr.aria-label]="'Remove ' + item" (click)="removeStackItem(item)">×</button></span>
                  }
                  <input id="stack-draft" class="chip-input" name="stackDraft" placeholder="add…" [ngModel]="stackDraft()" (ngModelChange)="stackDraft.set($event)" (keydown.enter)="addStackItemOnEnter($event)" />
                </div>
              </div>
              <div class="of-field" data-testid="docs-folder-block">
                <span class="of-label" id="docs-folder-label">Specs and docs are saved in</span>
                <div class="folder-row">
                  @if (isEditingFolder()) {
                    <input #docsFolderInput id="project-docs-folder" class="of-input mono folder-input" data-testid="project-docs-folder" name="docsFolder" aria-labelledby="docs-folder-label" [attr.aria-describedby]="folderDescribedBy()" placeholder="/absolute/path/to/a/folder" [ngModel]="docsFolder()" (ngModelChange)="editDocsFolder($event)" [readonly]="pending()" (keydown.enter)="createOnEnter($event)" [attr.aria-invalid]="folderMessage() ? 'true' : null" />
                  } @else {
                    <span class="folder-path mono" data-testid="docs-folder-path">{{ docsFolder() }}</span>
                  }
                  <button type="button" class="of-btn of-btn--secondary" (click)="editFolder()">Change…</button>
                  <button type="button" class="of-btn of-btn--secondary" (click)="editFolder()">Use an existing folder</button>
                </div>
                <span class="hint">Creates {{ docsSubfolders }} · notes are stored there as Markdown files</span>
                @if (folderMessage(); as message) {
                  <of-error-line id="project-docs-folder-error" role="alert" data-testid="project-form-error">{{ message }}</of-error-line>
                }
              </div>
              <div class="of-field">
                <span class="of-label">Commands</span>
                @for (field of commandFields; track field.kind) {
                  <div class="command-row">
                    <label class="command-name" [for]="'command-' + field.kind">{{ field.label }}</label>
                    <input [id]="'command-' + field.kind" class="of-input mono" [name]="'command-' + field.kind" [ngModel]="commands()[field.kind]" (ngModelChange)="editCommand(field.kind, $event)" />
                    @if (isDetected(field.kind)) {
                      <span class="detected" data-testid="detected-label">detected</span>
                    }
                  </div>
                }
              </div>
              <div class="actions">
                <button type="button" class="of-btn of-btn--secondary" data-testid="project-cancel" [attr.aria-disabled]="pending() ? 'true' : null" (click)="cancel()">Cancel</button>
                <button type="button" class="of-btn of-btn--primary" data-testid="project-save" [attr.aria-disabled]="pending() ? 'true' : null" (click)="createProject()">Create project</button>
              </div>
              @if (otherFailure(); as failure) {
                <of-error-line role="alert">{{ failure }}</of-error-line>
              }
            }
          </div>
          @if (!savedProject()) {
            <aside class="card preview" aria-label="Note preview">
              <span class="preview-kicker">¶ Preview · note</span>
              <pre class="preview-note mono" data-testid="note-preview">{{ notePreview() }}</pre>
            </aside>
          }
        </div>
        <div class="footer">
          <span class="footer-note">Next: start your first session</span>
          <button type="submit" class="of-btn of-btn--primary" [disabled]="!canContinueToFirstSession()">Continue</button>
        </div>
      </form>
    </section>
  `,
  styles: [
    STEP_PANEL_STYLES,
    `
    :host { display: contents }
    .of-field { display: flex; flex-direction: column; gap: .25rem }
    .project-form { display: flex; flex-direction: column; gap: 1rem }
    .columns { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start }
    .fields { flex: 1 1 24rem; min-width: 0; gap: .75rem }
    .preview { flex: 0 0 19rem; max-width: 100%; box-sizing: border-box; gap: .5rem; font-size: .75rem }
    .preview-kicker { color: var(--mut); font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase }
    .preview-note { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .6875rem; line-height: 1.55 }
    .name-input { font-weight: 600 }
    .goal-input { resize: vertical; line-height: 1.45 }
    .chips { display: flex; flex-wrap: wrap; gap: .25rem; padding: .375rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk) }
    .chip { display: flex; align-items: center; gap: .25rem; height: 1.375rem; padding: 0 .4375rem; border-radius: .25rem; background: var(--panel); border: 1px solid var(--line); font-size: .6875rem }
    .chip-remove { border: 0; background: transparent; color: var(--mut); cursor: pointer; padding: 0 }
    .chip-input { flex: 1; min-width: 4rem; height: 1.375rem; border: 0; background: transparent; color: var(--fg); font-size: .6875rem; outline: 0 }
    .folder-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap }
    .folder-path, .folder-input { flex: 1 1 12rem; min-width: 0 }
    .folder-path { display: flex; align-items: center; height: 2rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); font-size: .75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .mono { font-family: var(--mono) }
    .hint { font-size: .6875rem; color: var(--mut) }
    .command-row { display: flex; align-items: center; gap: .5rem }
    .command-name { flex: 0 0 5rem; font-size: .75rem; color: var(--mut) }
    .detected { font-size: .6875rem; color: var(--state-idle); white-space: nowrap }
    .actions { display: flex; justify-content: flex-end; gap: .5rem }
    .footer { display: flex; align-items: center; justify-content: space-between }
    .footer-note { font-size: .75rem; color: var(--mut) }
  `,
  ],
})
export class ProjectStepComponent {
  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly docsFolderInput = viewChild<ElementRef<HTMLInputElement>>('docsFolderInput');
  private hasBeenDestroyed = false;

  /** The project created in this step, shown instead of the fields once it exists. */
  readonly savedProject = input<Project>();
  readonly repositoryPath = model('');

  readonly projectSaved = output<Project>();
  readonly cancelled = output<void>();
  /** Emits when the user asks to move on; only fires once a project is saved and a repository path is typed. */
  readonly continued = output<void>();

  protected readonly commandFields = COMMAND_FIELDS;
  protected readonly docsSubfolders = DOCS_SUBFOLDERS.join(' ');
  protected readonly name = signal('');
  protected readonly goal = signal('');
  protected readonly stack = signal<string[]>([]);
  protected readonly stackDraft = signal('');
  protected readonly commands = signal<CommandValues>(noCommands());
  private readonly detectedCommands = signal<CommandValues>(noCommands());
  private readonly proposedFolder = signal('');
  private readonly typedFolder = signal<string | undefined>(undefined);
  protected readonly isEditingFolder = signal(false);
  protected readonly pending = signal(false);
  protected readonly nameError = signal('');
  private readonly folderRequiredError = signal('');
  private readonly folderFailure = signal('');
  protected readonly otherFailure = signal('');
  private latestFolderRequest = 0;
  private latestDetectRequest = 0;

  protected readonly docsFolder = computed(() => this.typedFolder() ?? this.proposedFolder());
  protected readonly folderMessage = computed(() => this.folderRequiredError() || this.folderFailure());
  protected readonly folderDescribedBy = computed(() => (this.folderMessage() ? 'project-docs-folder-error' : null));
  protected readonly notePreview = computed(() =>
    renderProjectNote({ name: this.name() || 'name', goal: this.goal(), repositories: this.repositoryList(), stack: this.stack(), commands: this.commands() }),
  );

  private readonly hasRepositoryPath = computed(() => this.repositoryPath().trim() !== '');
  protected readonly canContinueToFirstSession = computed(() => {
    const hasSavedProject = this.savedProject() !== undefined;
    return this.hasRepositoryPath() && hasSavedProject;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.hasBeenDestroyed = true));
    afterNextRender(() => void this.refreshProposedFolder(), { injector: this.injector });
  }

  protected editName(typedName: string): void {
    this.name.set(typedName);
    this.nameError.set('');
    void this.refreshProposedFolder();
  }

  /** Asks the daemon where the typed name would live; the proposal follows the name until the user types a folder. */
  private async refreshProposedFolder(): Promise<void> {
    const requestNumber = ++this.latestFolderRequest;
    let proposal = '';
    try {
      const view = await this.api.getDocsRoot(this.name().trim() || undefined);
      proposal = view.proposedPath ?? `${view.root}/`;
    } catch {
      proposal = '';
    }
    const isStale = requestNumber !== this.latestFolderRequest || this.hasBeenDestroyed;
    if (!isStale) this.proposedFolder.set(proposal);
  }

  protected editFolder(): void {
    this.typedFolder.set(this.docsFolder());
    this.isEditingFolder.set(true);
    this.focusDocsFolderAfterRender();
  }

  protected editDocsFolder(typedFolder: string): void {
    this.typedFolder.set(typedFolder);
    this.folderRequiredError.set('');
    this.folderFailure.set('');
  }

  protected addStackItemOnEnter(event: Event): void {
    event.preventDefault();
    const item = this.stackDraft().trim();
    const isNewItem = item !== '' && !this.stack().includes(item);
    if (isNewItem) this.stack.update((items) => [...items, item]);
    this.stackDraft.set('');
  }

  protected removeStackItem(item: string): void {
    this.stack.update((items) => items.filter((existing) => existing !== item));
  }

  protected editCommand(kind: ProjectCommandName, command: string): void {
    this.commands.update((commands) => ({ ...commands, [kind]: command }));
  }

  protected isDetected(kind: ProjectCommandName): boolean {
    const command = this.commands()[kind];
    return command !== '' && command === this.detectedCommands()[kind];
  }

  /** Fills the empty commands and the stack from what the daemon finds in the repository; a refused or failed detection changes nothing. */
  protected async detectFromRepository(): Promise<void> {
    const repositoryPath = this.repositoryPath().trim();
    if (repositoryPath === '' || this.savedProject()) return;
    const requestNumber = ++this.latestDetectRequest;
    let detection: DetectedRepository;
    try {
      detection = await this.api.detectRepository(repositoryPath);
    } catch {
      return;
    }
    const isStale = requestNumber !== this.latestDetectRequest || this.hasBeenDestroyed;
    if (!isStale) this.applyDetection(detection);
  }

  private applyDetection(detection: DetectedRepository): void {
    const previouslyDetected = this.detectedCommands();
    const detected = noCommands();
    for (const { kind } of COMMAND_FIELDS) detected[kind] = detection.commands[kind]?.command ?? '';
    this.detectedCommands.set(detected);
    this.commands.update((current) => {
      const refreshed = { ...current };
      for (const { kind } of COMMAND_FIELDS) {
        const isUntouchedByUser = current[kind] === '' || current[kind] === previouslyDetected[kind];
        if (isUntouchedByUser) refreshed[kind] = detected[kind];
      }
      return refreshed;
    });
    const knownStack = new Set(this.stack().map((item) => item.toLowerCase()));
    const newStack = detection.stack.filter((item) => !knownStack.has(item.toLowerCase()));
    if (newStack.length > 0) this.stack.update((items) => [...items, ...newStack]);
  }

  protected createOnEnter(event: Event): void {
    event.preventDefault();
    void this.createProject();
  }

  protected cancelOnEscape(event: Event): void {
    if (this.savedProject()) return;
    event.stopPropagation();
    this.cancel();
  }

  protected cancel(): void {
    if (this.pending()) return;
    this.cancelled.emit();
  }

  protected async createProject(): Promise<void> {
    if (this.pending()) return;
    this.folderFailure.set('');
    this.otherFailure.set('');
    const request = this.validRequestOrShowErrors();
    if (!request) return;
    this.pending.set(true);
    try {
      const project = await this.api.createProject(request);
      if (!this.hasBeenDestroyed) this.projectSaved.emit(project);
    } catch (error) {
      this.showFailure(error);
    } finally {
      this.pending.set(false);
    }
  }

  private validRequestOrShowErrors(): CreateProjectRequest | undefined {
    const name = this.name().trim();
    const docsFolderPath = this.docsFolder().trim();
    const nameError = name === '' ? NAME_REQUIRED : name.length > MAX_PROJECT_NAME_CHARS ? NAME_TOO_LONG : '';
    const isStillOnlyTheRoot = this.typedFolder() === undefined && docsFolderPath.endsWith('/');
    const isFolderMissing = docsFolderPath === '' || isStillOnlyTheRoot;
    this.nameError.set(nameError);
    const isFolderWithDotSegment = hasDotSegment(docsFolderPath);
    const folderError = isFolderMissing ? DOCS_FOLDER_REQUIRED : isFolderWithDotSegment ? DOCS_FOLDER_DOT_SEGMENT : '';
    this.folderRequiredError.set(nameError === '' ? folderError : '');
    if (nameError) return this.focusNameAfterRender();
    if (isFolderMissing || isFolderWithDotSegment) {
      this.isEditingFolder.set(true);
      return this.focusDocsFolderAfterRender();
    }
    return { name, docsFolderPath, profile: this.profile() };
  }

  private profile(): ProjectProfile {
    const goal = this.goal().trim();
    const commands = Object.fromEntries(COMMAND_FIELDS.map(({ kind }) => [kind, this.commands()[kind].trim()]).filter(([, command]) => command !== ''));
    return {
      ...(goal === '' ? {} : { goal }),
      ...(this.stack().length === 0 ? {} : { stack: this.stack() }),
      ...(Object.keys(commands).length === 0 ? {} : { commands }),
      ...(this.repositoryList().length === 0 ? {} : { repositories: this.repositoryList() }),
    };
  }

  private repositoryList(): string[] {
    const repositoryPath = this.repositoryPath().trim();
    return repositoryPath === '' ? [] : [repositoryPath];
  }

  private showFailure(error: unknown): void {
    const text = copyFor(error, { action: 'save_project' }).text;
    const isAboutDocsFolder = error instanceof ApiError && DOCS_FOLDER_ERROR_CODES.has(error.code ?? '');
    if (!isAboutDocsFolder) {
      this.otherFailure.set(text);
      return;
    }
    this.folderFailure.set(text);
    this.isEditingFolder.set(true);
    this.focusDocsFolderAfterRender();
  }

  protected continueToFirstSession(): void {
    if (!this.canContinueToFirstSession()) return;
    this.continued.emit();
  }

  private focusNameAfterRender(): undefined {
    afterNextRender(() => (document.getElementById('project-name') as HTMLInputElement | null)?.focus(), { injector: this.injector });
    return undefined;
  }

  private focusDocsFolderAfterRender(): undefined {
    afterNextRender(() => this.docsFolderInput()?.nativeElement.focus(), { injector: this.injector });
    return undefined;
  }
}
