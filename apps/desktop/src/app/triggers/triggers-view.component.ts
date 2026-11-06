import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { Project } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { BannerComponent } from '../design/banner.component';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';
import { LOADING, failedLoadOf, loadedValueOf, type Load } from './load-state';
import { PlaybooksPanelComponent } from './playbooks-panel.component';
import { TriggersPanelComponent } from './triggers-panel.component';

type TriggersTab = 'playbooks' | 'triggers';

const TRIGGERS_TABS: ReadonlyArray<{ key: TriggersTab; label: string }> = [
  { key: 'playbooks', label: 'Playbooks' },
  { key: 'triggers', label: 'Triggers' },
];

/** Triggers & Playbooks: what a project automates and what fired. Execution, run log and approval of a playbook have no place here yet. */
@Component({
  selector: 'of-triggers-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, PlaybooksPanelComponent, TriggersPanelComponent],
  template: `
    <section class="triggers" data-testid="triggers-view">
      <header class="head">
        <h1>Triggers &amp; Playbooks</h1>
        <div class="tabs" role="tablist" aria-label="Sections de Triggers et Playbooks" (keydown)="onTabKeydown($event)">
          @for (tab of tabs; track tab.key) {
            <button
              type="button"
              role="tab"
              class="tab of-focus-ring"
              [id]="'triggers-tab-' + tab.key"
              [attr.aria-selected]="activeTab() === tab.key"
              [attr.aria-controls]="tabPanelId"
              [attr.tabindex]="activeTab() === tab.key ? 0 : -1"
              (click)="activeTab.set(tab.key)"
            >{{ tab.label }}</button>
          }
        </div>
        @if (projects().length > 1) {
          <select class="scope of-focus-ring" aria-label="Projet" data-testid="triggers-project-scope" (change)="chooseProject($any($event.target).value)">
            @for (project of projects(); track project.id) {
              <option [value]="project.id" [selected]="project.id === activeProjectId()">{{ project.name }}</option>
            }
          </select>
        }
      </header>

      <div class="panel" role="tabpanel" [id]="tabPanelId" [attr.aria-labelledby]="'triggers-tab-' + activeTab()">
        @switch (projectsLoad().status) {
          @case ('loading') { <div class="loading" data-testid="triggers-projects-loading" role="status" aria-label="Chargement des projets"></div> }
          @case ('failed') {
            <of-banner data-testid="triggers-projects-error" variant="error" glyph="✕" title="Projets indisponibles" description="Le démon n’a pas pu lister les projets.">
              <button type="button" class="of-btn of-btn--compact" (click)="loadProjects()">Réessayer</button>
            </of-banner>
          }
        }
        @if (hasNoProject()) {
          <p class="empty" data-testid="triggers-no-project"><span class="empty-title">Aucun projet</span>Créez d’abord un projet : les playbooks et les triggers vivent dedans.</p>
        }
        @if (activeProjectId(); as projectId) {
          @if (activeTab() === 'playbooks') { <of-playbooks-panel [projectId]="projectId" /> } @else { <of-triggers-panel [projectId]="projectId" /> }
        }
      </div>
    </section>
  `,
  styles: `
    :host { display: flex; flex: 1 1 0%; min-width: 0; min-height: 0; }
    .triggers { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .head { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; padding: .625rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: .9375rem; font-weight: 600; }
    .tabs { display: flex; gap: .125rem; }
    .tab { height: 1.75rem; padding: 0 .75rem; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--mut); font: inherit; font-size: .8125rem; font-weight: 500; cursor: pointer; }
    .tab[aria-selected='true'] { color: var(--fg); border-bottom-color: var(--accent); }
    .scope { margin-left: auto; }
    .panel { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
    .loading { height: 12rem; margin: 1rem; border-radius: .625rem; background: var(--sunk); }
    .empty { padding: 4rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .375rem; color: var(--mut); text-align: center; }
    .empty-title { color: var(--fg); font-weight: 500; }
  `,
})
export class TriggersViewComponent {
  private readonly api = inject(FleetApiService);
  protected readonly tabs = TRIGGERS_TABS;
  protected readonly tabPanelId = 'triggers-tabpanel';
  protected readonly activeTab = signal<TriggersTab>('playbooks');
  protected readonly projectsLoad = signal<Load<Project[]>>(LOADING);
  private readonly chosenProjectId = signal<string | undefined>(undefined);

  protected readonly projects = computed(() => loadedValueOf(this.projectsLoad()) ?? []);
  protected readonly activeProjectId = computed(() => this.chosenProjectId() ?? this.projects()[0]?.id);
  protected readonly hasNoProject = computed(() => this.projectsLoad().status === 'loaded' && this.projects().length === 0);

  constructor() {
    void this.loadProjects();
  }

  protected async loadProjects(): Promise<void> {
    this.projectsLoad.set(LOADING);
    try {
      this.projectsLoad.set({ status: 'loaded', value: (await this.api.listProjects()).items });
    } catch (error) {
      this.projectsLoad.set(failedLoadOf(error));
    }
  }

  protected chooseProject(projectId: string): void {
    this.chosenProjectId.set(projectId);
  }

  protected onTabKeydown(event: KeyboardEvent): void {
    const currentIndex = TRIGGERS_TABS.findIndex((tab) => tab.key === this.activeTab());
    const targetIndex = nextTabIndex(event, { currentIndex, tabCount: TRIGGERS_TABS.length, orientation: 'horizontal' });
    if (targetIndex === undefined) return;
    event.preventDefault();
    this.activeTab.set(TRIGGERS_TABS[targetIndex].key);
    focusTabAt(event.currentTarget as HTMLElement, targetIndex);
  }
}
