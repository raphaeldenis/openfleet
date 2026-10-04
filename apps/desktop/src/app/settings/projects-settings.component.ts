import { afterNextRender, ChangeDetectionStrategy, Component, computed, ElementRef, inject, Injector, signal, viewChild, viewChildren } from '@angular/core';
import type { Project } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { ProjectFormComponent } from '../projects/project-form.component';
import { SettingsRowComponent } from './settings-row.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

type EditorTarget = { kind: 'create' } | { kind: 'edit'; project: Project };
/** Each opening gets its own key, so that opening another editor builds a fresh form with no leftover state. */
type Editor = EditorTarget & { key: number };

let nextEditorKey = 0;

const NO_DOCS_FOLDER = 'No docs folder';
const PROJECTS_LOAD_FAILED = "Couldn't load your projects.";
const NOTICE_BY_EDITOR_KIND = { create: 'Project created', edit: 'Project updated' } as const;

/** The projects of the daemon, with the form that creates one or edits the docs folder of one, open under the list. */
@Component({
  selector: 'of-projects-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsRowComponent, ProjectFormComponent],
  template: `
    <div class="projects" data-testid="settings-projects">
      <div class="rows">
        <of-settings-row name="Projects" detail="Each project keeps its notes and handoffs in a docs folder">
          <button #createTrigger type="button" class="value" data-testid="projects-create" [attr.aria-expanded]="isCreating()" (click)="openEditor({ kind: 'create' })">Create a project…</button>
        </of-settings-row>
        @for (project of projects(); track project.id) {
          <of-settings-row [name]="project.name" [detail]="project.docsFolderPath ?? noDocsFolder">
            <button #editTrigger type="button" class="value" [attr.data-project-id]="project.id" [attr.aria-label]="'Edit docs folder of ' + project.name" [attr.aria-expanded]="isEditing(project)" (click)="openEditor({ kind: 'edit', project })">Edit docs folder</button>
          </of-settings-row>
        } @empty {
          @if (hasLoaded()) {
            <of-settings-row name="No projects yet" detail="Create one to keep handoffs and notes together" />
          }
        }
      </div>
      <p class="hint" role="status" data-testid="projects-status">{{ status() }}</p>
      @for (editor of openEditors(); track editor.key) {
        <div class="editor">
          <of-project-form [project]="editedProjectOf(editor)" (saved)="finishEditing(editor)" (cancelled)="closeEditor(editor)" />
        </div>
      }
    </div>
  `,
  styles: `
    ${SETTINGS_VALUE_STYLES}
    .projects { display: flex; flex-direction: column; gap: .75rem; }
    .hint:empty { display: none; }
    .editor { padding: 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
  `,
})
export class ProjectsSettingsComponent {
  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly createTrigger = viewChild<ElementRef<HTMLButtonElement>>('createTrigger');
  private readonly editTriggers = viewChildren<ElementRef<HTMLButtonElement>>('editTrigger');

  protected readonly noDocsFolder = NO_DOCS_FOLDER;
  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly hasLoaded = signal(false);
  private readonly hasLoadFailed = signal(false);
  private readonly savedNotice = signal('');
  private readonly editor = signal<Editor | undefined>(undefined);

  protected readonly openEditors = computed(() => {
    const openEditor = this.editor();
    return openEditor ? [openEditor] : [];
  });
  protected readonly isCreating = computed(() => this.editor()?.kind === 'create');
  protected readonly status = computed(() => this.savedNotice() || (this.hasLoadFailed() ? PROJECTS_LOAD_FAILED : ''));

  constructor() {
    void this.refresh();
  }

  protected isEditing(project: Project): boolean {
    const openEditor = this.editor();
    return openEditor?.kind === 'edit' && openEditor.project.id === project.id;
  }

  protected editedProjectOf(editor: Editor): Project | undefined {
    return editor.kind === 'edit' ? editor.project : undefined;
  }

  protected openEditor(target: EditorTarget): void {
    this.savedNotice.set('');
    this.editor.set({ ...target, key: nextEditorKey++ });
  }

  protected closeEditor(editor: Editor): void {
    this.editor.set(undefined);
    this.focusTriggerOf(editor);
  }

  protected finishEditing(editor: Editor): void {
    this.savedNotice.set(NOTICE_BY_EDITOR_KIND[editor.kind]);
    this.closeEditor(editor);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const page = await this.api.listProjects();
      const isPageOfProjects = Array.isArray(page?.items);
      this.hasLoadFailed.set(!isPageOfProjects);
      if (!isPageOfProjects) return;
      this.projects.set(page.items);
      this.hasLoaded.set(true);
    } catch {
      this.hasLoadFailed.set(true);
    }
  }

  private focusTriggerOf(editor: Editor): void {
    afterNextRender(() => this.triggerOf(editor)?.nativeElement.focus(), { injector: this.injector });
  }

  private triggerOf(editor: Editor): ElementRef<HTMLButtonElement> | undefined {
    if (editor.kind === 'create') return this.createTrigger();
    return this.editTriggers().find((trigger) => trigger.nativeElement.dataset['projectId'] === editor.project.id);
  }
}
