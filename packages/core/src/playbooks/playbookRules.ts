import {
  ERROR_CODES, MAX_FLOW_BYTES, MAX_PLAYBOOK_CELLS, OpenFleetError, type ErrorCode, type PlaybookCell, type PlaybookFlow, type PlaybookInputDeclaration,
} from '@openfleet/shared';
import { KernelError } from './kernel/kernelError.js';
import { findTemplateViolations, type TemplateSlot, type UntrustedSources } from './kernel/tokenResolver.js';

type PathStep = string | number;
type Leaf = { text: string; path: readonly PathStep[]; isObjectKey: boolean };
type Edge = { from: string; to: string; isForEach: boolean };
type SoundDocument = { inputs: readonly PlaybookInputDeclaration[]; flow: PlaybookFlow };

const SECRET_TOKEN = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const INPUTS_OWNER = 'inputs';

/** The wire error of a refusal of the kernel: its own code when the registry knows it, invalid_body otherwise. */
export const wireErrorOf = (error: KernelError): OpenFleetError => {
  const isOnTheWire = error.code in ERROR_CODES;
  return new OpenFleetError(isOnTheWire ? (error.code as ErrorCode) : 'invalid_body', error.message);
};

function* leavesOf(value: unknown, path: readonly PathStep[] = []): Generator<Leaf> {
  if (typeof value === 'string') yield { text: value, path, isObjectKey: false };
  if (Array.isArray(value)) {
    for (const [position, member] of value.entries()) yield* leavesOf(member, [...path, position]);
  }
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject) return;
  for (const [key, member] of Object.entries(value)) {
    yield { text: key, path: [...path, key], isObjectKey: true };
    yield* leavesOf(member, [...path, key]);
  }
}

const SLOT_BY_FIELD: Readonly<Record<string, Readonly<Record<string, TemplateSlot>>>> = {
  script: { program: 'script_args', args: 'script_args', env: 'script_env' },
  http: { url: 'http_url', headers: 'http_headers', auth: 'http_auth', body: 'http_body' },
};

const slotOf = (kind: string, leaf: Leaf): TemplateSlot => {
  if (leaf.isObjectKey) return 'text';
  const [field] = leaf.path;
  return SLOT_BY_FIELD[kind]?.[String(field)] ?? 'text';
};

const forEachRootStepOf = (forEach: string): string | undefined => {
  const [namespace, stepId] = forEach.split('.');
  return namespace === 'steps' ? stepId : undefined;
};

/** Only the declared inputs and the literals are trusted: the output of every cell can carry what another actor wrote (a response, a table row, a tool result, what a script printed). */
const untrustedStepIdsOf = (cells: readonly PlaybookCell[]): ReadonlySet<string> => new Set(cells.map((cell) => cell.id));

const iteratesUntrustedData = (cell: PlaybookCell, cells: readonly PlaybookCell[], untrustedStepIds: ReadonlySet<string>): boolean => {
  const edgesIntoCell = cells.flatMap((other) => other.next ?? []).filter((edge) => edge.to === cell.id);
  const iteratedSteps = edgesIntoCell.flatMap((edge) => (edge.forEach === undefined ? [] : [forEachRootStepOf(edge.forEach)]));
  return iteratedSteps.some((stepId) => stepId !== undefined && untrustedStepIds.has(stepId));
};

const violationMessage = (owner: string, code: string, token: string, slot: TemplateSlot): string => {
  if (code === 'non_canonical_url') return `${owner}: the url does not start with scheme://host (no extra slash, backslash or control character).`;
  return `${owner}: ${token} is not allowed in ${slot}.`;
};

function assertLeafIsAllowed(owner: string, leaf: Leaf, slot: TemplateSlot, untrusted: UntrustedSources | undefined): void {
  try {
    const [firstViolation] = findTemplateViolations({ template: leaf.text, slot, untrusted });
    if (firstViolation === undefined) return;
    throw new OpenFleetError(firstViolation.code, violationMessage(owner, firstViolation.code, firstViolation.token, slot));
  } catch (error) {
    if (error instanceof KernelError) throw new OpenFleetError(wireErrorOf(error).code, `${owner}: ${error.message}`);
    throw error;
  }
}

function assertTemplatesAreAllowed({ inputs, flow }: SoundDocument): void {
  const untrustedStepIds = untrustedStepIdsOf(flow.cells);
  for (const leaf of leavesOf(inputs)) assertLeafIsAllowed(INPUTS_OWNER, leaf, 'text', undefined);
  for (const cell of flow.cells) {
    const untrusted: UntrustedSources = { stepIds: untrustedStepIds, isItemUntrusted: iteratesUntrustedData(cell, flow.cells, untrustedStepIds) };
    for (const leaf of leavesOf(cell)) assertLeafIsAllowed(`cell ${cell.id}`, leaf, slotOf(cell.kind, leaf), untrusted);
  }
}

/** The names of the secrets the playbook references, sorted; a name is referenced when a token `{{secret:NAME}}` stands in a value. */
export function secretNamesReferencedBy({ inputs, flow }: SoundDocument): string[] {
  const valueLeaves = [...leavesOf(inputs), ...flow.cells.flatMap((cell) => [...leavesOf(cell)])].filter((leaf) => !leaf.isObjectKey);
  const names = valueLeaves.flatMap((leaf) => Array.from(leaf.text.matchAll(SECRET_TOKEN), (match) => match[1]!));
  return [...new Set(names)].sort();
}

const graphInvalid = (message: string) => new OpenFleetError('playbook_graph_invalid', message);

function assertWithinLimits(flow: PlaybookFlow): void {
  const isOverTheCellCap = flow.cells.length > MAX_PLAYBOOK_CELLS;
  if (isOverTheCellCap) throw new OpenFleetError('playbook_limit_exceeded', `a playbook holds at most ${MAX_PLAYBOOK_CELLS} cells.`);
  const isOverTheSizeCap = Buffer.byteLength(JSON.stringify(flow), 'utf8') > MAX_FLOW_BYTES;
  if (isOverTheSizeCap) throw new OpenFleetError('playbook_limit_exceeded', `the flow of a playbook is at most ${MAX_FLOW_BYTES} bytes.`);
}

function assertCellIdsAreUnique(cells: readonly PlaybookCell[]): void {
  const ids = cells.map((cell) => cell.id);
  const repeatedId = ids.find((id, position) => ids.indexOf(id) !== position);
  if (repeatedId !== undefined) throw graphInvalid(`two cells carry the id ${repeatedId}.`);
}

/** The edges a cell leaves: its `next` when it has one, else the cell that follows it in document order. */
const edgesOf = (cells: readonly PlaybookCell[]): Edge[] =>
  cells.flatMap((cell, position): Edge[] => {
    if (cell.next !== undefined) return cell.next.map((edge) => ({ from: cell.id, to: edge.to, isForEach: edge.forEach !== undefined }));
    const following = cells[position + 1];
    return following === undefined ? [] : [{ from: cell.id, to: following.id, isForEach: false }];
  });

function assertEveryTargetExists(cells: readonly PlaybookCell[], edges: readonly Edge[]): void {
  const ids = new Set(cells.map((cell) => cell.id));
  const dangling = edges.find((edge) => !ids.has(edge.to));
  if (dangling !== undefined) throw graphInvalid(`cell ${dangling.from} leads to ${dangling.to}, which is not a cell of this playbook.`);
}

/** The first cell is the one entry; a cell that cannot be reached from it is dead and is refused. */
function assertEveryCellIsReachableFromTheEntry(cells: readonly PlaybookCell[], edges: readonly Edge[]): void {
  const [entry] = cells;
  if (entry === undefined) return;
  const reached = new Set<string>([entry.id]);
  const toVisit = [entry.id];
  for (let current = toVisit.pop(); current !== undefined; current = toVisit.pop()) {
    for (const edge of edges.filter((candidate) => candidate.from === current && !reached.has(candidate.to))) {
      reached.add(edge.to);
      toVisit.push(edge.to);
    }
  }
  const unreachable = cells.filter((cell) => !reached.has(cell.id));
  if (unreachable.length > 0) throw graphInvalid(`no path leads from the entry cell ${entry.id} to ${unreachable.map((cell) => cell.id).join(', ')}.`);
}

function stronglyConnectedComponents(ids: readonly string[], edges: readonly Edge[]): string[][] {
  const indexOf = new Map<string, number>();
  const lowLinkOf = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const visit = (id: string): void => {
    indexOf.set(id, indexOf.size);
    lowLinkOf.set(id, indexOf.get(id)!);
    stack.push(id);
    onStack.add(id);
    for (const edge of edges.filter((candidate) => candidate.from === id)) {
      if (!indexOf.has(edge.to)) {
        visit(edge.to);
        lowLinkOf.set(id, Math.min(lowLinkOf.get(id)!, lowLinkOf.get(edge.to)!));
      } else if (onStack.has(edge.to)) {
        lowLinkOf.set(id, Math.min(lowLinkOf.get(id)!, indexOf.get(edge.to)!));
      }
    }
    const isRootOfComponent = lowLinkOf.get(id) === indexOf.get(id);
    if (!isRootOfComponent) return;
    const component: string[] = [];
    for (let member = stack.pop()!; ; member = stack.pop()!) {
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };

  for (const id of ids) if (!indexOf.has(id)) visit(id);
  return components;
}

/** A loop is documented when one of its cells retries or waits, or one of its edges iterates with forEach. */
function assertEveryLoopIsDocumented(cells: readonly PlaybookCell[], edges: readonly Edge[]): void {
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  for (const component of stronglyConnectedComponents(cells.map((cell) => cell.id), edges)) {
    const edgesInside = edges.filter((edge) => component.includes(edge.from) && component.includes(edge.to));
    const isLoop = edgesInside.length > 0;
    if (!isLoop) continue;
    const hasRetryOrWait = component.some((id) => cellById.get(id)?.retry !== undefined || cellById.get(id)?.kind === 'waitFor');
    const hasForEach = edgesInside.some((edge) => edge.isForEach);
    if (!hasRetryOrWait && !hasForEach) throw graphInvalid(`cells ${component.sort().join(', ')} loop without a retry, a forEach or a waitFor.`);
  }
}

function assertGraphIsSound(cells: readonly PlaybookCell[]): void {
  assertCellIdsAreUnique(cells);
  const edges = edgesOf(cells);
  assertEveryTargetExists(cells, edges);
  assertEveryCellIsReachableFromTheEntry(cells, edges);
  assertEveryLoopIsDocumented(cells, edges);
}

/**
 * Checks a playbook the way every save does: the caps, the graph, and every template in the slot it stands in.
 * Returns the names of the secrets it references. Throws OpenFleetError with the code of the first refusal.
 */
export function assertPlaybookIsSound(document: SoundDocument): { secretNames: string[] } {
  assertWithinLimits(document.flow);
  assertGraphIsSound(document.flow.cells);
  assertTemplatesAreAllowed(document);
  return { secretNames: secretNamesReferencedBy(document) };
}
