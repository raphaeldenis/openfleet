import {
  DEFAULT_PLAYBOOK_NAME, MAX_PLAYBOOK_CELLS, MAX_PLAYBOOK_VERSIONS, OpenFleetError, PlaybookInputsSchema, PlaybookNameSchema, PlaybookPolicySchema,
  type PlaybookCell, type PlaybookInputDeclaration, type PlaybookOrigin, type PlaybookPolicy, type PlaybookVersionSource, type SecretScope,
} from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';
import type { SecretRefRepository } from '../secrets/secretRefRepository.js';
import { parsePlaybookCell } from './cellParsing.js';
import { canonicalDigestOf } from './kernel/canonicalDigest.js';
import { assertPlaybookIsSound, secretNamesReferencedBy } from './playbookRules.js';
import type { PlaybookContent, PlaybookRecord, PlaybookRepository } from './playbookRepository.js';
import type { PlaybookVersion, PlaybookVersionRepository } from './playbookVersionRepository.js';

/** Who writes: an agent through MCP, bound by the lock of the playbook, or the human through the admin REST. */
export type PlaybookWriter = 'agent' | 'admin';

/** Every write names the revision it read: a write on another revision is refused. */
export interface WriteOptions {
  writer: PlaybookWriter;
  expectedRev: number;
  /** How the content that this write replaces is recorded in the history; an ordinary write is an `edit`. */
  versionSource?: PlaybookVersionSource;
}

export interface PlaybookServiceDeps {
  db: DatabaseSync;
  repository: PlaybookRepository;
  versions: PlaybookVersionRepository;
  secretRefs: SecretRefRepository;
  projectExists: (projectId: string) => boolean;
  clock: () => string;
  newId: () => string;
}

/** The content a caller edits, from the playbook as it stands: returns what to replace. */
type ContentEdit = (current: PlaybookRecord) => PlaybookContent;

const notFound = () => new OpenFleetError('playbook_not_found', 'playbook not found');
const cellNotFound = () => new OpenFleetError('playbook_cell_not_found', 'cell not found on this playbook');
const locked = () => new OpenFleetError('playbook_locked', 'this playbook is locked: only the desktop app writes to it.', { hint: 'Ask the human to edit it or unlock it.' });
const conflict = (currentRev: number) => new OpenFleetError('playbook_conflict', `the playbook revision is stale, current rev: ${currentRev}.`, {
  hint: 'Reload the playbook, then write again.', detail: { currentRev },
});

const scopeOf = (playbookId: string): SecretScope => ({ kind: 'playbook', id: playbookId });

/** The first `cN` no cell carries, so an id read in a token stays short and stable. */
const freshCellId = (cells: readonly PlaybookCell[]): string => {
  const taken = new Set(cells.map((cell) => cell.id));
  let position = cells.length + 1;
  while (taken.has(`c${position}`)) position += 1;
  return `c${position}`;
};

const nameOf = (requested: string | undefined): string => PlaybookNameSchema.parse(requested?.trim() || DEFAULT_PLAYBOOK_NAME);

const versionNotFound = () => new OpenFleetError('playbook_version_not_found', 'that version of the playbook is not kept.', { hint: 'List the versions with list_playbook_versions.' });

const replacesVersionedContent = (content: PlaybookContent): boolean =>
  content.name !== undefined || content.inputs !== undefined || content.flow !== undefined || content.policy !== undefined;

const versionedContentOf = ({ name, inputs, flow, policy }: PlaybookRecord) => ({ name, inputs, flow, policy });

export class PlaybookService {
  constructor(private readonly deps: PlaybookServiceDeps) {}

  create(input: { projectId: string; writer: PlaybookWriter; name?: string; inputs?: unknown; cells?: Record<string, unknown>[]; policy?: Partial<PlaybookPolicy>; agentLocked?: boolean }): PlaybookRecord {
    const { repository, projectExists, clock, newId } = this.deps;
    if (!projectExists(input.projectId)) throw new OpenFleetError('project_not_found', 'project not found');
    const inputs = PlaybookInputsSchema.parse(input.inputs ?? []);
    const flow = { cells: (input.cells ?? []).map(parsePlaybookCell) };
    const { secretNames } = assertPlaybookIsSound({ inputs, flow });
    const id = newId();
    const origin: PlaybookOrigin = input.writer === 'agent' ? 'agent' : 'native';
    inTransaction(this.deps.db, 'playbook_create', () => {
      repository.insert({ id, projectId: input.projectId, name: nameOf(input.name), inputs, flow, policy: PlaybookPolicySchema.parse(input.policy ?? {}), agentLocked: input.agentLocked ?? false, origin, createdAt: clock() });
      this.declareReferencedSecrets(id, secretNames);
    });
    return this.getById(id);
  }

  getById(id: string): PlaybookRecord {
    const playbook = this.deps.repository.get(id);
    if (playbook === undefined) throw notFound();
    return playbook;
  }

  /** The playbook of the project named by its id or its exact name; a playbook of another project is not found. */
  getInProject(projectId: string, reference: string): PlaybookRecord {
    const ofProject = this.deps.repository.listOfProject(projectId);
    const byId = ofProject.find((playbook) => playbook.id === reference);
    if (byId !== undefined) return byId;
    const byName = ofProject.filter((playbook) => playbook.name === reference);
    if (byName.length > 1) throw new OpenFleetError('invalid_body', `ambiguous playbook name: ${byName.length} playbooks carry it. Use an id.`);
    if (byName[0] === undefined) throw notFound();
    return byName[0];
  }

  list(projectId: string): PlaybookRecord[] {
    return this.deps.repository.listOfProject(projectId);
  }

  /** Deletes the playbook and the declarations of its secrets that hold no value; a stored value keeps its declaration so a human can clear it. */
  delete(id: string, { writer, expectedRev }: WriteOptions): void {
    const playbook = this.getById(id);
    this.assertWriterMayWrite(playbook, writer);
    const isOnAnOldRevision = expectedRev !== playbook.contentRev;
    if (isOnAnOldRevision) throw conflict(playbook.contentRev);
    inTransaction(this.deps.db, 'playbook_delete', () => {
      const wasDeleted = this.deps.repository.delete({ id, expectedRev });
      if (!wasDeleted) throw conflict(this.getById(id).contentRev);
      this.declareReferencedSecrets(id, []);
    });
  }

  /** The names this playbook references, and the names still declared for it that no cell references any more (they hold a stored value). */
  secretNamesOf(playbook: PlaybookRecord): { referenced: string[]; unreferenced: string[] } {
    const referenced = secretNamesReferencedBy(playbook);
    const declared = this.deps.secretRefs.listOf(scopeOf(playbook.id)).map((ref) => ref.name);
    return { referenced, unreferenced: declared.filter((name) => !referenced.includes(name)) };
  }

  /** Replaces the content, checks the whole playbook, bumps the revision and keeps the secret declarations equal to the secrets referenced. A write on a revision other than `expectedRev` is refused. */
  edit(id: string, edit: ContentEdit, options: WriteOptions): PlaybookRecord {
    const { repository, clock } = this.deps;
    const current = this.getById(id);
    this.assertWriterMayWrite(current, options.writer);
    const isOnAnOldRevision = options.expectedRev !== current.contentRev;
    if (isOnAnOldRevision) throw conflict(current.contentRev);

    const content = edit(current);
    const { name, inputs, flow, policy, ...unchecked } = content;
    const parsedInputs = inputs === undefined ? undefined : PlaybookInputsSchema.parse(inputs);
    const parsedFlow = flow === undefined ? undefined : { ...flow, cells: flow.cells.map(parsePlaybookCell) };
    const sound = { inputs: parsedInputs ?? current.inputs, flow: parsedFlow ?? current.flow };
    const { secretNames } = assertPlaybookIsSound(sound);
    const checkedContent: PlaybookContent = {
      ...unchecked,
      ...(name !== undefined && { name: nameOf(name) }),
      ...(parsedInputs !== undefined && { inputs: parsedInputs }),
      ...(parsedFlow !== undefined && { flow: parsedFlow }),
      ...(policy !== undefined && { policy: PlaybookPolicySchema.parse(policy) }),
    };
    const clearsAnApproval = current.approvedDigest !== null;
    const mustKeepCurrentVersion = replacesVersionedContent(checkedContent) || clearsAnApproval;

    inTransaction(this.deps.db, 'playbook_edit', () => {
      const wasReplaced = repository.replaceContent({ id, expectedRev: current.contentRev, content: checkedContent, now: clock() });
      if (!wasReplaced) throw conflict(this.getById(id).contentRev);
      if (mustKeepCurrentVersion) this.keepVersionOf(current, options.versionSource ?? 'edit');
      this.declareReferencedSecrets(id, secretNames);
    });
    return this.getById(id);
  }

  /** The versions kept for a playbook, newest first. */
  listVersions(id: string): PlaybookVersion[] {
    this.getById(id);
    return this.deps.versions.listOf(id);
  }

  getVersion(id: string, rev: number): PlaybookVersion {
    this.getById(id);
    const version = this.deps.versions.get(id, rev);
    if (version === undefined) throw versionNotFound();
    return version;
  }

  /** Puts the content of a kept version back through the path of every write: the same checks, the same revision guard, a new revision, the approval cleared; the content it replaces is kept as a version first. */
  restoreVersion(id: string, input: { rev: number }, options: WriteOptions): PlaybookRecord {
    const { name, inputs, flow, policy } = this.getVersion(id, input.rev);
    return this.edit(id, () => ({ name, inputs, flow, policy }), { ...options, versionSource: 'restore' });
  }

  private keepVersionOf(replaced: PlaybookRecord, source: PlaybookVersionSource): void {
    const { versions, clock } = this.deps;
    versions.insert({
      playbookId: replaced.id, rev: replaced.contentRev, ...versionedContentOf(replaced), sha256: canonicalDigestOf(versionedContentOf(replaced)),
      source, approvedDigest: replaced.approvedDigest, createdAt: clock(),
    });
    versions.purgeOldestBeyond(replaced.id, MAX_PLAYBOOK_VERSIONS);
  }

  /** Adds a cell after the cell named by `after`, or at the end; the id is given or the first free `cN`. */
  addCell(id: string, input: { cell: Record<string, unknown>; after?: string }, options: WriteOptions): PlaybookRecord {
    return this.edit(id, (current) => {
      const cells = current.flow.cells;
      const isOverTheCap = cells.length >= MAX_PLAYBOOK_CELLS;
      if (isOverTheCap) throw new OpenFleetError('playbook_limit_exceeded', `a playbook holds at most ${MAX_PLAYBOOK_CELLS} cells.`);
      const added = parsePlaybookCell({ id: freshCellId(cells), ...input.cell });
      const afterPosition = input.after === undefined ? cells.length - 1 : cells.findIndex((cell) => cell.id === input.after);
      if (input.after !== undefined && afterPosition < 0) throw cellNotFound();
      return { flow: { cells: [...cells.slice(0, afterPosition + 1), added, ...cells.slice(afterPosition + 1)] } };
    }, options);
  }

  /** Merges the fields given into the cell; its id and kind do not change. */
  updateCell(id: string, input: { cellId: string; changes: Record<string, unknown> }, options: WriteOptions): PlaybookRecord {
    return this.edit(id, (current) => {
      const position = current.flow.cells.findIndex((cell) => cell.id === input.cellId);
      if (position < 0) throw cellNotFound();
      const existing = current.flow.cells[position]!;
      const changesIdentity = (input.changes.kind !== undefined && input.changes.kind !== existing.kind) || (input.changes.id !== undefined && input.changes.id !== existing.id);
      if (changesIdentity) throw new OpenFleetError('invalid_body', 'the id and the kind of a cell do not change: delete the cell and add another.');
      const updated = parsePlaybookCell({ ...existing, ...input.changes });
      return { flow: { cells: current.flow.cells.map((cell, index) => (index === position ? updated : cell)) } };
    }, options);
  }

  deleteCell(id: string, input: { cellId: string }, options: WriteOptions): PlaybookRecord {
    return this.edit(id, (current) => {
      const exists = current.flow.cells.some((cell) => cell.id === input.cellId);
      if (!exists) throw cellNotFound();
      return { flow: { cells: current.flow.cells.filter((cell) => cell.id !== input.cellId) } };
    }, options);
  }

  /** Puts the cells in the order given; the order names every cell once. */
  reorderCells(id: string, input: { order: string[] }, options: WriteOptions): PlaybookRecord {
    return this.edit(id, (current) => {
      const cellById = new Map(current.flow.cells.map((cell) => [cell.id, cell]));
      const namesEveryCellOnce = input.order.length === cellById.size && new Set(input.order).size === cellById.size && input.order.every((cellId) => cellById.has(cellId));
      if (!namesEveryCellOnce) throw new OpenFleetError('invalid_body', 'the order names every cell of the playbook exactly once.');
      return { flow: { cells: input.order.map((cellId) => cellById.get(cellId)!) } };
    }, options);
  }

  setInputs(id: string, input: { inputs: unknown }, options: WriteOptions): PlaybookRecord {
    const inputs: PlaybookInputDeclaration[] = PlaybookInputsSchema.parse(input.inputs);
    return this.edit(id, () => ({ inputs }), options);
  }

  private assertWriterMayWrite(playbook: PlaybookRecord, writer: PlaybookWriter): void {
    const isAgentOnLockedPlaybook = writer === 'agent' && playbook.agentLocked;
    if (isAgentOnLockedPlaybook) throw locked();
  }

  /** Declares each referenced name as missing, and drops the declarations that hold no value and are no longer referenced. */
  private declareReferencedSecrets(playbookId: string, referencedNames: readonly string[]): void {
    const { secretRefs } = this.deps;
    const scope = scopeOf(playbookId);
    for (const name of referencedNames) secretRefs.declare(scope, name);
    const noLongerReferenced = secretRefs.listOf(scope).filter((ref) => !referencedNames.includes(ref.name));
    for (const ref of noLongerReferenced) secretRefs.undeclareWhenMissing(scope, ref.name);
  }
}
