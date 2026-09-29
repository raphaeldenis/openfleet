import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { DataStore, DsColumn, DsRow, DsRowHistoryEntry, DsView } from '@openfleet/shared';
import { ApiError, FleetApiService, type Project } from '../core/fleet-api.service';
import { RowHistoryComponent } from './row-history.component';
import { TableGridComponent } from './table-grid.component';
import { cellText, sortedColumns } from './table-cells';
import { TableKanbanComponent, type KanbanGroup } from './table-kanban.component';
import { TableListComponent } from './table-list.component';

export interface UsedByEntry {
  name: string;
  mode: string;
  tip?: string;
}

type TableStatus = 'loading' | 'ready' | 'error';
type ViewMode = 'grid' | 'kanban';
interface Mismatch { rowId: string; column: DsColumn }

const ROWS_PAGE_LIMIT = 1000;
const SKELETON_ROW_COUNT = 6;
const isBlank = (value: unknown) => value === undefined || value === null || value === '';

@Component({
  selector: 'of-tables-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'tables-view' },
  imports: [TableListComponent, TableGridComponent, TableKanbanComponent, RowHistoryComponent],
  template: `
    <div class="toolbar">
      @if (projects().length > 0) {
        <select class="scope" data-testid="tables-project-scope" aria-label="Project scope" [value]="activeProjectId()" (change)="chooseProject($any($event.target).value)">
          @for (project of projects(); track project.id) {
            <option [value]="project.id" [selected]="project.id === activeProjectId()">{{ project.name }}</option>
          }
        </select>
      }
      <of-table-list [stores]="stores()" [activeStoreId]="activeStoreId()" (selected)="openStore($event)" (addRequested)="startCreatingTable()" />
      <span class="spacer"></span>
      <div class="toggle" role="group" aria-label="Layout">
        <button type="button" data-testid="tables-toggle-grid" [class.on]="viewMode() === 'grid'" [attr.aria-pressed]="viewMode() === 'grid'" (click)="viewMode.set('grid')">▦ Grid</button>
        <button type="button" data-testid="tables-toggle-kanban" [class.on]="viewMode() === 'kanban'" [attr.aria-pressed]="viewMode() === 'kanban'" (click)="viewMode.set('kanban')">▥ Kanban</button>
      </div>
      <button type="button" class="of-btn of-btn--primary compact" data-testid="tables-add-row" [disabled]="!activeStoreId()" (click)="addRow()">+ Row</button>
    </div>

    @if (isCreatingTable()) {
      <form class="create-table" (submit)="$event.preventDefault(); createTable()">
        <input class="of-input" data-testid="tables-new-name" aria-label="Table name" placeholder="Table name" [value]="newTableName()" (input)="newTableName.set($any($event.target).value)" />
        <button type="submit" class="of-btn of-btn--primary compact" data-testid="tables-create" [disabled]="newTableName().trim() === ''">Create</button>
        @if (createError(); as message) {
          <span class="create-error" data-testid="tables-create-error">{{ message }}</span>
        }
      </form>
    }

    @if (usedBy(); as entries) {
      <div class="used-by" data-testid="tables-used-by">
        <span>Used by</span>
        @for (entry of entries; track entry.name) {
          <span class="used-by-entry" [attr.title]="entry.tip">{{ entry.name }} <span class="mode">{{ entry.mode }}</span></span>
        }
      </div>
    }

    @if (actionError(); as message) {
      <div class="action-error" data-testid="tables-action-error">{{ message }}</div>
    }

    <div class="body">
      <div class="main">
        @if (hasNoProject()) {
          <div class="message" data-testid="tables-no-project">
            <span class="message-title">No project yet</span>
            <span>Create a project first, tables live inside one.</span>
          </div>
        } @else if (hasNoTables()) {
          <div class="message" data-testid="tables-no-tables">
            <span class="message-title">No tables yet</span>
            <span>Use + to create the first one.</span>
          </div>
        } @else if (status() === 'loading') {
          <div class="skeleton" data-testid="tables-loading">
            @for (bar of skeletonBars; track bar) {
              <div class="skeleton-row"></div>
            }
          </div>
        } @else if (status() === 'error') {
          <div class="card" data-testid="tables-load-error">
            <span class="card-title">✕ Could not load “{{ activeStoreName() }}”</span>
            <span class="muted">The daemon did not answer this request.</span>
            <div class="actions"><button type="button" class="of-btn of-btn--secondary compact" data-testid="tables-retry" (click)="retry()">Retry</button></div>
          </div>
        } @else if (mustResolveMismatches()) {
          <div class="card" data-testid="tables-schema-mismatch">
            <span class="card-title">✕ Schema mismatch in “{{ activeStoreName() }}”</span>
            <span class="muted">{{ mismatchSummary() }}</span>
            <div class="actions">
              <button type="button" class="of-btn of-btn--secondary compact" data-testid="tables-clear-mismatches" (click)="clearMismatchedValues()">Clear those values</button>
              <button type="button" class="of-btn of-btn--secondary compact" data-testid="tables-view-rows" (click)="viewRowsAnyway()">View rows</button>
            </div>
          </div>
        } @else if (rows().length === 0) {
          <div class="message" data-testid="tables-empty">
            <span class="message-title">{{ activeStoreName() }} has no rows</span>
            <span>Add one, or let a manager fill it from its mission.</span>
            <button type="button" class="of-btn of-btn--primary" data-testid="tables-add-first-row" (click)="addRow()">+ Add first row</button>
          </div>
        } @else if (viewMode() === 'grid') {
          <of-table-grid [columns]="columns()" [rows]="rows()" [selectedRowId]="selectedRowId()" (rowSelected)="openRow($event)" />
        } @else if (kanbanGroups(); as groups) {
          <of-table-kanban [columns]="columns()" [groups]="groups" [selectedRowId]="selectedRowId()" (rowSelected)="openRow($event)" />
        } @else {
          <div class="message" data-testid="tables-kanban-needs-select">
            <span class="message-title">A kanban needs a select column</span>
            <span>Add a select column to group the rows by.</span>
          </div>
        }
      </div>

      @if (selectedRowId()) {
        <aside class="history" data-testid="tables-history">
          <button type="button" class="close" data-testid="tables-history-close" aria-label="Close history" (click)="closeHistory()">✕</button>
          <of-row-history [entries]="history()" [columns]="columns()" [heading]="selectedRowTitle()" />
        </aside>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--bg) }
    .toolbar {
      flex: none; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: .375rem .5rem;
      padding: .625rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel);
    }
    .scope {
      height: 1.625rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem;
      background: var(--sunk); color: var(--fg); font: inherit; font-size: .75rem;
    }
    .spacer { flex: 1 }
    .toggle { display: flex; padding: .125rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk) }
    .toggle button {
      height: 1.375rem; padding: 0 .625rem; border: 0; border-radius: .25rem; background: transparent;
      color: var(--fg); font: inherit; font-size: .75rem; cursor: pointer; white-space: nowrap;
    }
    .toggle button.on { background: var(--panel) }
    .compact { height: 1.625rem; font-size: .75rem; padding: 0 .625rem; white-space: nowrap }
    .create-table { flex: none; display: flex; align-items: center; gap: .5rem; padding: .5rem 1rem; border-bottom: 1px solid var(--line) }
    .create-error, .action-error { color: var(--state-error); font-size: .75rem }
    .action-error { flex: none; padding: .375rem 1rem; border-bottom: 1px solid var(--line) }
    .used-by {
      flex: none; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: .375rem .5rem;
      padding: .4375rem 1rem; border-bottom: 1px solid var(--line); font-size: .75rem; color: var(--mut);
    }
    .used-by-entry { display: flex; align-items: center; gap: .25rem; padding: 0 .4375rem; border: 1px solid var(--line); border-radius: .25rem; background: var(--panel); color: var(--fg); white-space: nowrap }
    .mode { font-family: var(--mono); font-size: .625rem; color: var(--faint) }
    .body { flex: 1; min-height: 0; display: flex }
    .main { flex: 1; min-width: 0; overflow: auto; padding: 1rem }
    .skeleton { display: flex; flex-direction: column; gap: .5rem }
    .skeleton-row { height: 2rem; border-radius: .25rem; background: var(--sunk); animation: shimmer 1.4s infinite }
    @keyframes shimmer { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }
    @media (prefers-reduced-motion: reduce) { .skeleton-row { animation: none } }
    .message { margin: 3rem auto; display: flex; flex-direction: column; align-items: center; gap: .5rem; color: var(--mut) }
    .message-title { color: var(--fg); font-weight: 500 }
    .card {
      max-width: 30rem; margin: 2rem auto; display: flex; flex-direction: column; gap: .5rem; padding: 1.25rem;
      border: 1px solid var(--line); border-radius: .625rem; background: var(--panel);
    }
    .card-title { color: var(--state-error); font-weight: 600 }
    .muted { color: var(--mut) }
    .actions { display: flex; gap: .5rem }
    .history { position: relative; width: 20rem; flex: none; border-left: 1px solid var(--line); background: var(--panel); overflow: auto; display: flex; flex-direction: column }
    .close { position: absolute; top: .5rem; right: .5rem; border: 0; background: transparent; color: var(--faint); cursor: pointer }
    .close:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
  `,
})
export class TablesViewComponent {
  /** Bound from the `projectId` query parameter; overrides the default project. */
  readonly projectId = input<string | undefined>(undefined);
  /** Renders the "Used by" bar only when supplied. */
  readonly usedBy = input<UsedByEntry[] | undefined>(undefined);

  private readonly api = inject(FleetApiService);

  protected readonly skeletonBars = Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => index);
  protected readonly projects = signal<Project[]>([]);
  protected readonly stores = signal<DataStore[]>([]);
  protected readonly activeStoreId = signal<string | null>(null);
  protected readonly columns = signal<DsColumn[]>([]);
  protected readonly rows = signal<DsRow[]>([]);
  protected readonly views = signal<DsView[]>([]);
  protected readonly status = signal<TableStatus>('loading');
  protected readonly viewMode = signal<ViewMode>('grid');
  protected readonly selectedRowId = signal<string | null>(null);
  protected readonly history = signal<DsRowHistoryEntry[]>([]);
  protected readonly actionError = signal<string | null>(null);
  protected readonly isCreatingTable = signal(false);
  protected readonly newTableName = signal('');
  protected readonly createError = signal<string | null>(null);

  private readonly chosenProjectId = signal<string | undefined>(undefined);
  private readonly hasLoadedProjects = signal(false);
  private readonly hasLoadedStores = signal(false);
  private readonly ignoresMismatches = signal(false);
  private latestTableRequest = 0;

  protected readonly activeProjectId = computed(() => this.chosenProjectId() ?? this.projectId() ?? this.projects()[0]?.id);
  protected readonly hasNoProject = computed(() => this.hasLoadedProjects() && this.activeProjectId() === undefined);
  protected readonly hasNoTables = computed(() => this.hasLoadedStores() && this.stores().length === 0);
  protected readonly activeStoreName = computed(() => this.stores().find((store) => store.id === this.activeStoreId())?.displayName ?? '');

  private readonly mismatches = computed<Mismatch[]>(() => {
    const constrainedColumns = this.columns().filter((column) => column.columnType === 'select' && column.options);
    return this.rows().flatMap((row) =>
      constrainedColumns
        .filter((column) => {
          const value = row.data[column.id];
          const isKnownOption = column.options?.some((option) => option.id === value);
          return !isBlank(value) && !isKnownOption;
        })
        .map((column) => ({ rowId: row.id, column })),
    );
  });
  protected readonly mustResolveMismatches = computed(() => this.mismatches().length > 0 && !this.ignoresMismatches());
  protected readonly mismatchSummary = computed(() => {
    const columnNames = [...new Set(this.mismatches().map(({ column }) => `“${column.displayName}”`))].join(', ');
    const rowCount = new Set(this.mismatches().map(({ rowId }) => rowId)).size;
    const rowLabel = rowCount === 1 ? '1 row' : `${rowCount} rows`;
    return `Values in ${columnNames} no longer match the column options for ${rowLabel}. Rows are read-only until fixed.`;
  });

  private readonly groupColumn = computed(() => {
    const selectColumns = sortedColumns(this.columns()).filter((column) => column.columnType === 'select' && column.options);
    const kanbanView = this.views().find((view) => view.viewType === 'kanban' && view.config.groupByColumnId);
    const viewGroupColumn = selectColumns.find((column) => column.id === kanbanView?.config.groupByColumnId);
    return viewGroupColumn ?? selectColumns[0];
  });
  protected readonly kanbanGroups = computed<KanbanGroup[] | null>(() => {
    const column = this.groupColumn();
    if (!column) return null;
    return (column.options ?? []).map((option) => ({ option, rows: this.rows().filter((row) => row.data[column.id] === option.id) }));
  });
  protected readonly selectedRowTitle = computed(() => {
    const selectedRow = this.rows().find((row) => row.id === this.selectedRowId());
    const [titleColumn] = sortedColumns(this.columns()).filter((column) => column.columnType === 'text');
    return selectedRow && titleColumn ? cellText(titleColumn, selectedRow) : null;
  });

  constructor() {
    void this.loadProjects();
    effect(() => {
      const projectId = this.activeProjectId();
      if (projectId) untracked(() => void this.loadStores(projectId));
    });
  }

  protected chooseProject(projectId: string): void {
    this.chosenProjectId.set(projectId);
  }

  protected openStore(storeId: string): void {
    void this.loadTable(storeId);
  }

  protected retry(): void {
    const storeId = this.activeStoreId();
    const projectId = this.activeProjectId();
    if (storeId) void this.loadTable(storeId);
    else if (projectId) void this.loadStores(projectId);
    else void this.loadProjects();
  }

  protected viewRowsAnyway(): void {
    this.ignoresMismatches.set(true);
  }

  protected async clearMismatchedValues(): Promise<void> {
    const scope = this.currentScope();
    if (!scope) return;
    const patchesByRow = new Map<string, Record<string, unknown>>();
    for (const { rowId, column } of this.mismatches()) patchesByRow.set(rowId, { ...patchesByRow.get(rowId), [column.id]: null });
    const updates = [...patchesByRow].map(([rowId, patch]) => ({ rowId, patch }));
    await this.runAction(async () => {
      await this.api.updateRows({ ...scope, updates });
      await this.loadTable(scope.storeId);
    });
  }

  protected async addRow(): Promise<void> {
    const scope = this.currentScope();
    if (!scope) return;
    await this.runAction(async () => {
      await this.api.insertRows({ ...scope, rows: [{}] });
      await this.loadTable(scope.storeId);
    });
  }

  protected startCreatingTable(): void {
    this.createError.set(null);
    this.newTableName.set('');
    this.isCreatingTable.set(true);
  }

  protected async createTable(): Promise<void> {
    const projectId = this.activeProjectId();
    const displayName = this.newTableName().trim();
    if (!projectId || displayName === '') return;
    try {
      const created = await this.api.createDataStore({ projectId, displayName });
      this.stores.update((stores) => [...stores, created]);
      this.isCreatingTable.set(false);
      await this.loadTable(created.id);
    } catch (error) {
      const isNameTaken = error instanceof ApiError && error.code === 'duplicate_name';
      this.createError.set(isNameTaken ? `A table named “${displayName}” already exists.` : 'Could not create the table.');
    }
  }

  protected async openRow(rowId: string): Promise<void> {
    const scope = this.currentScope();
    if (!scope) return;
    this.selectedRowId.set(rowId);
    this.history.set([]);
    try {
      const { items } = await this.api.listRowChanges({ ...scope, rowId });
      if (this.selectedRowId() === rowId) this.history.set(items);
    } catch {
      // ponytail: any failure (404 = no recorded changes) reads as an empty history; surface real errors when the daemon reports a distinct code
      if (this.selectedRowId() === rowId) this.history.set([]);
    }
  }

  protected closeHistory(): void {
    this.selectedRowId.set(null);
  }

  private currentScope(): { projectId: string; storeId: string } | null {
    const projectId = this.activeProjectId();
    const storeId = this.activeStoreId();
    return projectId && storeId ? { projectId, storeId } : null;
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    this.actionError.set(null);
    try {
      await action();
    } catch {
      this.actionError.set('That change could not be saved.');
    }
  }

  private async loadProjects(): Promise<void> {
    try {
      const { items } = await this.api.listProjects();
      this.projects.set(items);
    } catch {
      this.status.set('error');
    }
    this.hasLoadedProjects.set(true);
  }

  private async loadStores(projectId: string): Promise<void> {
    this.hasLoadedStores.set(false);
    this.status.set('loading');
    this.activeStoreId.set(null);
    this.selectedRowId.set(null);
    try {
      const { items } = await this.api.listDataStores(projectId);
      this.stores.set(items);
      this.hasLoadedStores.set(true);
      if (items[0]) await this.loadTable(items[0].id);
    } catch {
      this.status.set('error');
    }
  }

  private async loadTable(storeId: string): Promise<void> {
    const projectId = this.activeProjectId();
    if (!projectId) return;
    const request = ++this.latestTableRequest;
    this.activeStoreId.set(storeId);
    this.status.set('loading');
    this.ignoresMismatches.set(false);
    this.selectedRowId.set(null);
    try {
      const [detail, rowPage, viewList] = await Promise.all([
        this.api.getDataStore({ projectId, storeId }),
        this.api.queryDataStore({ projectId, storeId, limit: ROWS_PAGE_LIMIT }),
        this.api.listViews({ projectId, storeId }),
      ]);
      if (request !== this.latestTableRequest) return;
      this.columns.set(detail.columns);
      this.rows.set(rowPage.items);
      this.views.set(viewList.items);
      this.status.set('ready');
    } catch {
      if (request === this.latestTableRequest) this.status.set('error');
    }
  }
}
