import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, input, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { MAX_ROW_BATCH, orderedKanbanOptions, type DataStore, type DsColumn, type DsRow, type DsRowHistoryEntry, type DsView, type Project } from '@openfleet/shared';
import { ApiError, FleetApiService, type StoreScope } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { RowHistoryComponent } from './row-history.component';
import { TableGridComponent } from './table-grid.component';
import { isBlank, selectColumnsWithOptions, titleOf } from './table-cells';
import { NO_VALUE_GROUP_ID, TableKanbanComponent, type KanbanGroup } from './table-kanban.component';
import { TableListComponent } from './table-list.component';
import { TableCellEditorComponent } from './table-cell-editor.component';
import { RowDetailsComponent } from './row-details.component';
import { canEditCell, type CellEditRequest } from './table-cell-editor-values';

type LoadTarget = 'projects' | 'stores' | 'table';
interface LoadFailure { target: LoadTarget; reason: string }
type LoadFailures = Partial<Record<LoadTarget, string>>;
interface TableLoadOptions { keepsSelection?: boolean }
type ViewMode = 'grid' | 'kanban';
interface Mismatch { rowId: string; column: DsColumn }
interface CellEditing extends CellEditRequest, StoreScope { value: unknown; rowTitle: string; tableRequest: number }

const LOAD_TARGETS_BY_PRIORITY: LoadTarget[] = ['projects', 'stores', 'table'];
const ROWS_PAGE_LIMIT = 1000;
const HISTORY_PAGE_LIMIT = 500;
const TABLE_NAME_MAX_LENGTH = 200;
const SKELETON_ROW_COUNT = 6;
const describeFailure = (error: unknown): string => {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 0) return 'The daemon did not answer this request.';
  if (status === 404) return 'This no longer exists on the daemon.';
  if (status >= 500) return 'The daemon hit an error while handling this request.';
  return `The daemon refused this request (${status}).`;
};
const describeCreateFailure = (error: unknown, displayName: string): string => {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'duplicate_name') return `A table named “${displayName}” already exists.`;
  if (code === 'project_not_found') return 'This project no longer exists.';
  if (code === 'invalid_body') return `The table name is not valid (1 to ${TABLE_NAME_MAX_LENGTH} characters).`;
  return 'Could not create the table.';
};
const describeCellFailure = (error: unknown): string => {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'constraint_violation') return 'This value conflicts with a table constraint or another row’s natural key.';
  if (code === 'invalid_body') return 'The daemon refused this value. Check the input and try again.';
  return describeFailure(error);
};

@Component({
  selector: 'of-tables-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'tables-view' },
  imports: [ErrorLineComponent, TableListComponent, TableGridComponent, TableKanbanComponent, RowHistoryComponent, TableCellEditorComponent, RowDetailsComponent],
  template: `
    <div class="toolbar" [attr.inert]="editing() ? '' : null">
      @if (projects().length > 0) {
        <select class="scope of-focus-ring" data-testid="tables-project-scope" aria-label="Project scope" [value]="activeProjectId()" (change)="chooseProject($any($event.target).value)">
          @for (project of projects(); track project.id) {
            <option [value]="project.id" [selected]="project.id === activeProjectId()">{{ project.name }}</option>
          }
        </select>
      }
      <of-table-list [stores]="stores()" [activeStoreId]="activeStoreId()" (selected)="openStore($event)" (addRequested)="startCreatingTable()" />
      <span class="spacer"></span>
      <div class="toggle" role="group" aria-label="Layout">
        <button type="button" class="of-focus-ring" data-testid="tables-toggle-grid" [class.on]="viewMode() === 'grid'" [attr.aria-pressed]="viewMode() === 'grid'" (click)="viewMode.set('grid')">▦ Grid</button>
        <button type="button" class="of-focus-ring" data-testid="tables-toggle-kanban" [class.on]="viewMode() === 'kanban'" [attr.aria-pressed]="viewMode() === 'kanban'" (click)="viewMode.set('kanban')">▥ Kanban</button>
      </div>
      <button type="button" class="of-btn of-btn--primary" data-testid="tables-add-row" [disabled]="!activeStoreId() || isClearingMismatches()" (click)="addRow()">+ Row</button>
    </div>

    @if (isCreatingTable()) {
      <form class="create-table" [attr.inert]="editing() ? '' : null" (submit)="$event.preventDefault(); createTable()">
        <input class="of-input" data-testid="tables-new-name" aria-label="Table name" [attr.maxlength]="tableNameMaxLength" placeholder="Table name" [value]="newTableName()" (input)="newTableName.set($any($event.target).value)" />
        <button type="submit" class="of-btn of-btn--primary" data-testid="tables-create" [disabled]="newTableName().trim() === ''">Create</button>
        @if (createError(); as message) {
          <of-error-line role="status" data-testid="tables-create-error" [glyph]="false">{{ message }}</of-error-line>
        }
      </form>
    }

    @if (actionError(); as message) {
      <div class="action-error" role="status" data-testid="tables-action-error"><of-error-line [glyph]="false">{{ message }}</of-error-line></div>
    }

    <div class="body" [attr.inert]="editing() ? '' : null">
      <div class="main">
        @if (isViewingMismatchedRows()) {
          <div class="banner" role="region" aria-label="Schema mismatch" data-testid="tables-mismatch-banner">
            <span class="muted">{{ mismatchSummary() }}</span>
            <button #clearMismatchesShortcut type="button" class="of-btn of-btn--secondary" data-testid="tables-clear-mismatches" [disabled]="isClearingMismatches()" (click)="clearMismatchedValues()">Clear those values</button>
          </div>
        }
        @if (loadFailure(); as failure) {
          <div class="card" role="status" data-testid="tables-load-error">
            <of-error-line class="card-title">{{ failureTitle() }}</of-error-line>
            <span class="muted">{{ failure.reason }}</span>
            <div class="actions"><button type="button" class="of-btn of-btn--secondary" data-testid="tables-retry" (click)="retry()">Retry</button></div>
          </div>
        } @else if (hasNoProject()) {
          <div class="message" data-testid="tables-no-project">
            <span class="message-title">No project yet</span>
            <span>Create a project first, tables live inside one.</span>
          </div>
        } @else if (hasNoTables()) {
          <div class="message" data-testid="tables-no-tables">
            <span class="message-title">No tables yet</span>
            <span>Use + to create the first one.</span>
          </div>
        } @else if (isLoadingTable()) {
          <div class="skeleton" data-testid="tables-loading">
            @for (bar of skeletonBars; track bar) {
              <div class="skeleton-row"></div>
            }
          </div>
        } @else if (mustResolveMismatches()) {
          <div class="card" role="region" [attr.aria-label]="'Schema mismatch in ' + activeStoreName()" data-testid="tables-schema-mismatch">
            <of-error-line class="card-title">Schema mismatch in “{{ activeStoreName() }}”</of-error-line>
            <span class="muted">{{ mismatchSummary() }}</span>
            <div class="actions">
              <button type="button" class="of-btn of-btn--secondary" data-testid="tables-clear-mismatches" [disabled]="isClearingMismatches()" (click)="clearMismatchedValues()">Clear those values</button>
              <button type="button" class="of-btn of-btn--secondary" data-testid="tables-view-rows" (click)="viewRowsAnyway()">View rows</button>
            </div>
          </div>
        } @else if (rows().length === 0) {
          <div class="message" data-testid="tables-empty">
            <span class="message-title">“{{ activeStoreName() }}” has no rows</span>
            <span>Add one, or let a manager fill it from its mission.</span>
            <button type="button" class="of-btn of-btn--primary" data-testid="tables-add-first-row" (click)="addRow()">+ Add first row</button>
          </div>
        } @else if (columns().length === 0) {
          <div class="message" data-testid="tables-no-columns">
            <span class="message-title">Add a column first</span>
            <span>Rows have nothing to show until the table has a column.</span>
          </div>
        } @else if (viewMode() === 'grid') {
          <of-table-grid [columns]="columns()" [rows]="rows()" [selectedRowId]="selectedRowId()" [readonly]="mismatches().length > 0" (rowSelected)="openRow($event)" (editRequested)="startEditing($event)" />
        } @else if (kanbanGroups(); as groups) {
          <of-table-kanban [columns]="columns()" [groups]="groups" [config]="activeKanbanView()?.config ?? {}" [selectedRowId]="selectedRowId()" (rowSelected)="openRow($event)" />
        } @else {
          <div class="message" data-testid="tables-kanban-needs-select">
            <span class="message-title">A kanban needs a select column</span>
            <span>Add a select column to group the rows by.</span>
          </div>
        }
        @if (hasMoreRows()) {
          <div class="truncated" data-testid="tables-rows-truncated">
            <span>Showing {{ rows().length }} of {{ rowTotal() }}</span>
            <button type="button" class="of-btn of-btn--secondary" data-testid="tables-load-more" (click)="loadMoreRows()">Load more</button>
          </div>
        }
      </div>

      @if (selectedRowId()) {
        <aside #historyPanel class="history of-focus-ring" tabindex="-1" aria-label="Row history" data-testid="tables-history" (keydown.escape)="closeHistory()">
          <button type="button" class="close of-focus-ring" data-testid="tables-history-close" aria-label="Close history" (click)="closeHistory()">✕</button>
          @if (selectedRow(); as row) {
            <of-row-details [row]="row" [columns]="columns()" [readonly]="mismatches().length > 0" (editRequested)="startEditing($event)" />
          }
          @if (historyFailed()) {
            <div class="history-error" role="status" data-testid="tables-history-error"><of-error-line>{{ historyRefreshAfterSaveFailed() ? 'Saved; history could not be refreshed.' : 'The history of this row could not be loaded.' }}</of-error-line></div>
            <button type="button" (click)="retryHistory()">Retry history</button>
          } @else {
            <of-row-history [entries]="history()" [columns]="columns()" [heading]="selectedRowTitle()" />
          }
        </aside>
      }
    </div>
    @if (editing(); as edit) {
      <of-table-cell-editor [column]="edit.column" [initialValue]="edit.value" [rowTitle]="edit.rowTitle" [saving]="isSavingCell()" [error]="cellError()" (submitted)="saveCell($event)" (cancelled)="closeEditor()" />
    }
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
    .create-table { flex: none; display: flex; align-items: center; gap: .5rem; padding: .5rem 1rem; border-bottom: 1px solid var(--line) }
    .action-error { flex: none; padding: .375rem 1rem; border-bottom: 1px solid var(--line) }
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
    .card-title { font-weight: 600 }
    .truncated { display: flex; align-items: center; justify-content: center; gap: .75rem; padding: .75rem; font-size: .75rem; color: var(--mut) }
    .muted { color: var(--mut) }
    .actions { display: flex; gap: .5rem }
    .history { position: relative; width: 20rem; flex: none; border-left: 1px solid var(--line); background: var(--panel); overflow: auto; display: flex; flex-direction: column }
    .history-error { padding: 2.5rem .875rem .875rem }
    .close { position: absolute; top: .5rem; right: .5rem; border: 0; background: transparent; color: var(--mut); cursor: pointer }
    .banner { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); font-size: .75rem }
  `,
})
export class TablesViewComponent {
  /** Bound from the `projectId` query parameter; overrides the default project. */
  readonly projectId = input<string | undefined>(undefined);

  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly historyPanel = viewChild<ElementRef<HTMLElement>>('historyPanel');
  private readonly clearMismatchesShortcut = viewChild<ElementRef<HTMLElement>>('clearMismatchesShortcut');

  protected readonly skeletonBars = Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => index);
  protected readonly projects = signal<Project[]>([]);
  protected readonly stores = signal<DataStore[]>([]);
  protected readonly activeStoreId = signal<string | null>(null);
  protected readonly columns = signal<DsColumn[]>([]);
  protected readonly rows = signal<DsRow[]>([]);
  protected readonly rowTotal = signal(0);
  protected readonly views = signal<DsView[]>([]);
  protected readonly isLoadingTable = signal(true);
  protected readonly viewMode = signal<ViewMode>('grid');
  protected readonly selectedRowId = signal<string | null>(null);
  protected readonly history = signal<DsRowHistoryEntry[]>([]);
  protected readonly historyFailed = signal(false);
  protected readonly editing = signal<CellEditing | null>(null);
  protected readonly historyRefreshAfterSaveFailed = signal(false);
  protected readonly isSavingCell = signal(false);
  protected readonly cellError = signal<string | null>(null);
  protected readonly selectedRow = computed(() => this.rows().find((row) => row.id === this.selectedRowId()));
  private latestHistoryRequest = 0;
  protected readonly tableNameMaxLength = TABLE_NAME_MAX_LENGTH;
  protected readonly actionError = signal<string | null>(null);
  protected readonly isCreatingTable = signal(false);
  protected readonly newTableName = signal('');
  protected readonly createError = signal<string | null>(null);

  private readonly chosenProjectId = linkedSignal<string | undefined>(() => this.projectId());
  private readonly loadFailures = signal<LoadFailures>({});
  protected readonly loadFailure = computed<LoadFailure | null>(() => {
    const failures = this.loadFailures();
    const target = LOAD_TARGETS_BY_PRIORITY.find((candidate) => failures[candidate] !== undefined);
    return target ? { target, reason: failures[target] ?? '' } : null;
  });
  private readonly hasLoadedProjects = signal(false);
  private readonly hasLoadedStores = signal(false);
  private readonly ignoresMismatches = signal(false);
  protected readonly isClearingMismatches = signal(false);
  private latestTableRequest = 0;
  private latestStoresRequest = 0;
  private readonly actionsInFlight = new Set<string>();

  protected readonly activeProjectId = computed(() => this.chosenProjectId() ?? this.projects()[0]?.id);
  protected readonly hasNoProject = computed(() => this.hasLoadedProjects() && this.activeProjectId() === undefined);
  protected readonly hasNoTables = computed(() => this.hasLoadedStores() && this.stores().length === 0);
  protected readonly failureTitle = computed(() => {
    const target = this.loadFailure()?.target;
    if (target === 'projects') return 'Could not load the projects';
    if (target === 'stores') return 'Could not load the tables';
    return `Could not load “${this.activeStoreName()}”`;
  });
  protected readonly hasMoreRows = computed(() => !this.isLoadingTable() && this.loadFailure() === null && this.rows().length < this.rowTotal());
  protected readonly activeStoreName = computed(() => this.stores().find((store) => store.id === this.activeStoreId())?.displayName ?? '');

  protected readonly mismatches = computed<Mismatch[]>(() => {
    const constrainedColumns = selectColumnsWithOptions(this.columns());
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
  protected readonly isViewingMismatchedRows = computed(
    () => this.mismatches().length > 0 && this.ignoresMismatches() && !this.isLoadingTable() && this.loadFailure() === null,
  );
  protected readonly mismatchSummary = computed(() => {
    const columnNames = [...new Set(this.mismatches().map(({ column }) => `“${column.displayName}”`))].join(', ');
    const rowCount = new Set(this.mismatches().map(({ rowId }) => rowId)).size;
    const rowLabel = rowCount === 1 ? '1 row' : `${rowCount} rows`;
    return `Values in ${columnNames} no longer match the column options for ${rowLabel}. Rows are read-only until fixed.`;
  });

  protected readonly activeKanbanView = computed(() => this.views().find((view) => view.viewType === 'kanban' && view.config.groupByColumnId));
  private readonly groupColumn = computed(() => {
    const selectColumns = selectColumnsWithOptions(this.columns());
    const kanbanView = this.activeKanbanView();
    const viewGroupColumn = selectColumns.find((column) => column.id === kanbanView?.config.groupByColumnId);
    return viewGroupColumn ?? selectColumns[0];
  });
  protected readonly kanbanGroups = computed<KanbanGroup[] | null>(() => {
    const column = this.groupColumn();
    if (!column) return null;
    const config = this.activeKanbanView()?.config;
    const options = orderedKanbanOptions({ options: column.options ?? [], columnOrder: config?.columnOrder });
    const groups = options.map((option) => ({ option, rows: this.rows().filter((row) => row.data[column.id] === option.id) }));
    const rowsWithoutKnownOption = this.rows().filter((row) => !options.some((option) => option.id === row.data[column.id]));
    const noValueGroup = { option: { id: NO_VALUE_GROUP_ID, label: 'No value' }, rows: rowsWithoutKnownOption };
    const showsUngrouped = config?.showUngrouped !== false;
    return showsUngrouped && rowsWithoutKnownOption.length > 0 ? [...groups, noValueGroup] : groups;
  });
  protected readonly selectedRowTitle = computed(() => {
    const selectedRow = this.rows().find((row) => row.id === this.selectedRowId());
    return selectedRow ? titleOf(this.columns(), selectedRow) || null : null;
  });

  constructor() {
    void this.loadProjects();
    effect(() => {
      const projectId = this.activeProjectId();
      if (projectId) untracked(() => void this.loadStores(projectId));
    });
  }

  protected chooseProject(projectId: string): void {
    this.closeEditor();
    this.chosenProjectId.set(projectId);
  }

  protected openStore(storeId: string): void {
    this.closeEditor();
    const projectId = this.activeProjectId();
    if (!projectId) return;
    this.actionError.set(null);
    void this.loadTable({ projectId, storeId });
  }

  protected retry(): void {
    const failures = this.loadFailures();
    const scope = this.currentScope();
    const projectId = this.activeProjectId();
    const mustReloadProjects = failures.projects !== undefined;
    const mustReloadStores = failures.stores !== undefined && projectId !== undefined;
    const mustReloadTable = failures.table !== undefined && scope !== null;
    if (mustReloadProjects) void this.loadProjects();
    if (mustReloadStores) void this.loadStores(projectId);
    else if (mustReloadTable) void this.loadTable(scope);
  }

  protected viewRowsAnyway(): void {
    this.ignoresMismatches.set(true);
    afterNextRender(() => this.clearMismatchesShortcut()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async clearMismatchedValues(): Promise<void> {
    const patchesByRow = new Map<string, Record<string, unknown>>();
    for (const { rowId, column } of this.mismatches()) patchesByRow.set(rowId, { ...patchesByRow.get(rowId), [column.id]: null });
    const updates = [...patchesByRow].map(([rowId, patch]) => ({ rowId, patch }));
    const totalValues = this.mismatches().length;
    const scope = this.currentScope();
    if (!scope) return;
    await this.runAction('clear-mismatches', async () => {
      this.isClearingMismatches.set(true);
      try {
        let clearedValues = 0;
        let hasFailed = false;
        for (let start = 0; start < updates.length; start += MAX_ROW_BATCH) {
          const batch = updates.slice(start, start + MAX_ROW_BATCH);
          try {
            await this.api.updateRows({ ...scope, updates: batch });
          } catch (error) {
            if (this.hasLeft(scope)) return;
            if (clearedValues === 0) throw error;
            hasFailed = true;
            break;
          }
          clearedValues += batch.reduce((count, { patch }) => count + Object.keys(patch).length, 0);
        }
        if (this.hasLeft(scope)) return;
        await this.loadTable(scope, { keepsSelection: true });
        if (hasFailed) this.actionError.set(`Cleared ${clearedValues} of ${totalValues} values; the rest could not be saved. Retry to clear the remaining ones`);
      } finally {
        this.isClearingMismatches.set(false);
      }
    });
  }

  protected async addRow(): Promise<void> {
    await this.writeThenReload('add-row', (scope) => this.api.insertRows({ ...scope, rows: [{}] }));
  }

  protected async loadMoreRows(): Promise<void> {
    const scope = this.currentScope();
    if (!scope) return;
    const request = this.latestTableRequest;
    await this.runAction('load-more', async () => {
      const rowPage = await this.api.queryDataStore({ ...scope, limit: ROWS_PAGE_LIMIT, offset: this.rows().length });
      if (request !== this.latestTableRequest) return;
      this.rows.update((loadedRows) => {
        const loadedIds = new Set(loadedRows.map((loadedRow) => loadedRow.id));
        return [...loadedRows, ...rowPage.items.filter((item) => !loadedIds.has(item.id))];
      });
      this.rowTotal.set(rowPage.total);
    }, 'More rows could not be loaded.');
  }

  protected startCreatingTable(): void {
    if (this.activeProjectId() === undefined) {
      this.actionError.set('No project to create a table in yet.');
      return;
    }
    this.createError.set(null);
    this.newTableName.set('');
    this.isCreatingTable.set(true);
  }

  protected async createTable(): Promise<void> {
    const projectId = this.activeProjectId();
    const displayName = this.newTableName().trim();
    const isAlreadyCreating = this.actionsInFlight.has('create-table');
    if (!projectId || displayName === '' || isAlreadyCreating) return;
    this.actionsInFlight.add('create-table');
    try {
      const created = await this.api.createDataStore({ projectId, displayName });
      this.isCreatingTable.set(false);
      const projectChangedMeanwhile = this.activeProjectId() !== projectId;
      if (projectChangedMeanwhile) return;
      this.stores.update((stores) => [...stores, created]);
      await this.loadTable({ projectId, storeId: created.id });
    } catch (error) {
      this.createError.set(describeCreateFailure(error, displayName));
    } finally {
      this.actionsInFlight.delete('create-table');
    }
  }

  protected async openRow(rowId: string): Promise<void> {
    const scope = this.currentScope();
    if (!scope) return;
    this.selectedRowId.set(rowId);
    this.history.set([]);
    this.historyFailed.set(false);
    this.historyRefreshAfterSaveFailed.set(false);
    afterNextRender(() => this.historyPanel()?.nativeElement.focus(), { injector: this.injector });
    await this.refreshHistory(scope, rowId);
  }

  protected retryHistory(): void {
    const scope = this.currentScope();
    const rowId = this.selectedRowId();
    if (scope && rowId) void this.refreshHistory(scope, rowId);
  }

  private async refreshHistory(scope: StoreScope, rowId: string, options: { followsSave?: boolean } = {}): Promise<void> {
    const request = ++this.latestHistoryRequest;
    const isCurrentRequest = () => request === this.latestHistoryRequest && !this.hasLeft(scope) && this.selectedRowId() === rowId;
    try {
      const { items } = await this.api.listRowChanges({ ...scope, rowId, limit: HISTORY_PAGE_LIMIT });
      if (!isCurrentRequest()) return;
      this.history.set(items);
      this.historyFailed.set(false);
      this.historyRefreshAfterSaveFailed.set(false);
    } catch (error) {
      if (!isCurrentRequest()) return;
      const hasNoRecordedChanges = error instanceof ApiError && error.status === 404;
      const followsSave = options.followsSave === true;
      this.historyFailed.set(followsSave || !hasNoRecordedChanges);
      this.historyRefreshAfterSaveFailed.set(followsSave);
    }
  }

  protected startEditing(request: CellEditRequest): void {
    const scope = this.currentScope();
    const row = this.rows().find((candidate) => candidate.id === request.rowId);
    const isReadonly = !canEditCell(request.column) || this.mismatches().length > 0;
    if (!scope || !row || isReadonly || this.editing()) return;
    this.cellError.set(null);
    this.editing.set({ ...request, ...scope, value: row.data[request.column.id], rowTitle: titleOf(this.columns(), row) || row.id, tableRequest: this.latestTableRequest });
  }

  protected closeEditor(): void {
    const edit = this.editing();
    if (!edit) return;
    this.editing.set(null);
    this.isSavingCell.set(false);
    this.cellError.set(null);
    afterNextRender(() => {
      if (edit.trigger.isConnected) {
        edit.trigger.focus();
        return;
      }
      const rowElements = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-row-id]'));
      const fallback = rowElements.find((element) => element.dataset['rowId'] === edit.rowId) ?? this.historyPanel()?.nativeElement ?? this.host.nativeElement.querySelector<HTMLElement>('button');
      fallback?.focus();
    }, { injector: this.injector });
  }

  protected async saveCell(value: unknown): Promise<void> {
    const edit = this.editing();
    if (!edit || this.isSavingCell()) return;
    if (!this.isCurrentEdit(edit)) {
      this.closeEditor();
      return;
    }
    const isUnchanged = value === (edit.value ?? null);
    if (isUnchanged) {
      this.closeEditor();
      return;
    }
    this.isSavingCell.set(true);
    this.cellError.set(null);
    try {
      const { items } = await this.api.updateRows({ projectId: edit.projectId, storeId: edit.storeId, updates: [{ rowId: edit.rowId, patch: { [edit.column.id]: value } }] });
      if (!this.isCurrentEdit(edit)) return;
      const savedRow = items.find((row) => row.id === edit.rowId);
      if (!savedRow) throw new Error('The saved row is missing from the response.');
      this.rows.update((rows) => rows.map((row) => row.id === savedRow.id ? savedRow : row));
      this.closeEditor();
      if (this.selectedRowId() === edit.rowId) await this.refreshHistory(edit, edit.rowId, { followsSave: true });
    } catch (error) {
      if (!this.isCurrentEdit(edit)) return;
      this.cellError.set(describeCellFailure(error));
    } finally {
      const currentEdit = this.editing();
      if (currentEdit === edit || currentEdit === null) this.isSavingCell.set(false);
    }
  }

  private isCurrentEdit(edit: CellEditing): boolean {
    const isSameEditor = this.editing() === edit;
    const isSameTableRequest = edit.tableRequest === this.latestTableRequest;
    return isSameEditor && isSameTableRequest && !this.hasLeft(edit);
  }

  protected closeHistory(): void {
    this.latestHistoryRequest++;
    const closedRowId = this.selectedRowId();
    this.selectedRowId.set(null);
    const rowElements = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-row-id]'));
    rowElements.find((element) => element.dataset['rowId'] === closedRowId)?.focus();
  }

  private currentScope(): StoreScope | null {
    const projectId = this.activeProjectId();
    const storeId = this.activeStoreId();
    return projectId && storeId ? { projectId, storeId } : null;
  }

  private async writeThenReload(name: string, write: (scope: StoreScope) => Promise<unknown>): Promise<void> {
    const scope = this.currentScope();
    if (!scope) return;
    await this.runAction(name, async () => {
      try {
        await write(scope);
      } catch (error) {
        if (this.hasLeft(scope)) return;
        throw error;
      }
      if (this.hasLeft(scope)) return;
      await this.loadTable(scope, { keepsSelection: true });
    });
  }

  private hasLeft({ projectId, storeId }: StoreScope): boolean {
    return this.activeProjectId() !== projectId || this.activeStoreId() !== storeId;
  }

  private async runAction(name: string, action: () => Promise<void>, failureMessage = 'That change could not be saved.'): Promise<void> {
    if (this.actionsInFlight.has(name)) return;
    this.actionsInFlight.add(name);
    this.actionError.set(null);
    try {
      await action();
    } catch {
      this.actionError.set(failureMessage);
    } finally {
      this.actionsInFlight.delete(name);
    }
  }

  private async loadProjects(): Promise<void> {
    this.clearFailureOf('projects');
    try {
      const { items } = await this.api.listProjects();
      this.projects.set(items);
      this.hasLoadedProjects.set(true);
    } catch (error) {
      this.recordFailure('projects', error);
    }
  }

  private recordFailure(target: LoadTarget, error: unknown): void {
    this.loadFailures.update((failures) => ({ ...failures, [target]: describeFailure(error) }));
  }

  private clearFailureOf(...targets: LoadTarget[]): void {
    this.loadFailures.update((failures) => {
      const remaining = { ...failures };
      for (const target of targets) delete remaining[target];
      return remaining;
    });
  }

  private async loadStores(projectId: string): Promise<void> {
    this.closeEditor();
    this.latestHistoryRequest++;
    const request = ++this.latestStoresRequest;
    this.latestTableRequest++;
    this.clearFailureOf('stores', 'table');
    this.hasLoadedStores.set(false);
    this.stores.set([]);
    this.actionError.set(null);
    this.isLoadingTable.set(true);
    this.activeStoreId.set(null);
    this.selectedRowId.set(null);
    try {
      const { items } = await this.api.listDataStores(projectId);
      if (request !== this.latestStoresRequest) return;
      this.stores.set(items);
      this.hasLoadedStores.set(true);
      if (items[0]) await this.loadTable({ projectId, storeId: items[0].id });
    } catch (error) {
      if (request === this.latestStoresRequest) this.recordFailure('stores', error);
    }
  }

  private async loadTable({ projectId, storeId }: StoreScope, { keepsSelection = false }: TableLoadOptions = {}): Promise<void> {
    this.closeEditor();
    this.latestHistoryRequest++;
    const request = ++this.latestTableRequest;
    this.activeStoreId.set(storeId);
    this.isLoadingTable.set(true);
    this.clearFailureOf('table');
    this.ignoresMismatches.set(false);
    if (!keepsSelection) this.selectedRowId.set(null);
    try {
      const [detail, rowPage, viewList] = await Promise.all([
        this.api.getDataStore({ projectId, storeId }),
        this.api.queryDataStore({ projectId, storeId, limit: ROWS_PAGE_LIMIT }),
        this.api.listViews({ projectId, storeId }),
      ]);
      if (request !== this.latestTableRequest) return;
      this.columns.set(detail.columns);
      this.rows.set(rowPage.items);
      this.rowTotal.set(rowPage.total);
      this.views.set(viewList.items);
      this.isLoadingTable.set(false);
    } catch (error) {
      if (request === this.latestTableRequest) this.recordFailure('table', error);
    }
  }
}
