import {
  DEFAULT_MAX_RUNS_TO_KEEP, HTTP_AUTH_TYPES, HTTP_METHODS, MAX_BODY_CHARS, MAX_EDGES_PER_CELL, MAX_PLAYBOOK_CELLS, MAX_PLAYBOOK_INPUTS, MAX_PROMPT_CHARS, MAX_SCRIPT_ARGUMENTS,
  MAX_SCRIPT_ENV_ENTRIES, MAX_TEMPLATE_CHARS, OpenFleetError, PLAYBOOK_CELL_COMMON_FIELDS, PLAYBOOK_CELL_FIELDS, PLAYBOOK_CELL_KINDS, PLAYBOOK_VALUE_TYPES,
  RESERVED_PLAYBOOK_CELL_KINDS, type Session,
} from '@openfleet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaybookRecord } from '../playbooks/playbookRepository.js';
import type { PlaybookService } from '../playbooks/playbookService.js';
import { ok } from './toolResults.js';

/** A playbook as an agent reads it. Secrets appear by name only: no value exists in the daemon to show. */
export const playbookView = (playbook: PlaybookRecord, secrets: { referenced: string[]; unreferenced: string[] }) => ({
  id: playbook.id, name: playbook.name, project_id: playbook.projectId, content_rev: playbook.contentRev, agent_locked: playbook.agentLocked, origin: playbook.origin,
  approved: playbook.approvedDigest !== null, inputs: playbook.inputs, cells: playbook.flow.cells, policy: playbook.policy,
  secrets: secrets.referenced, unreferencedSecrets: secrets.unreferenced,
});

const playbookSchemaView = () => ({
  notes: 'A playbook is a list of cells in document order, with typed inputs. A cell with no `next` advances to the next cell; only a branch or a fan-out needs an explicit `next`. A secret is written as the bare string {{secret:NAME}}; only its name is stored, a human sets the value in the desktop app. Nothing here runs a playbook.',
  kinds: PLAYBOOK_CELL_KINDS.map((kind) => ({ kind, ...PLAYBOOK_CELL_FIELDS[kind] })),
  commonFields: [...PLAYBOOK_CELL_COMMON_FIELDS],
  reservedKinds: [...RESERVED_PLAYBOOK_CELL_KINDS],
  refusedKinds: { bash: 'there is no shell cell: use a script cell with program and args' },
  flow: {
    entry: 'the first cell; every other cell must be reachable from it',
    next: { fields: ['to', 'when', 'forEach', 'label'], max: MAX_EDGES_PER_CELL, notes: 'when is a list of conditions (lhs, op, rhs, join, caseInsensitive) on inputs.x or steps.<id>.<field>; forEach is inputs.<path> or steps.<id>.<path>.' },
    retry: { fields: ['maxAttempts', 'until', 'backoffMs'] },
    loops: 'a loop is refused unless one of its cells has retry or is a waitFor, or one of its edges has forEach',
    outputs: { types: [...PLAYBOOK_VALUE_TYPES] },
  },
  tokens: {
    forms: ['{{inputs.<name>}}', '{{steps.<cellId>.<field>}}', '{{item}}', '{{index}}', '{{secret:NAME}}'],
    secretsAllowedIn: ['script env values', 'http headers', 'http auth'],
    untrustedReferences: 'a field of any step output (and {{item}} over one) is refused in script args and env, the url authority, headers and auth; only {{inputs.x}} and literals go there',
    url: 'an http url starts with scheme://host or with a token standing for the base url',
  },
  http: { methods: [...HTTP_METHODS], authTypes: [...HTTP_AUTH_TYPES] },
  limits: {
    cells: MAX_PLAYBOOK_CELLS, inputs: MAX_PLAYBOOK_INPUTS, scriptArguments: MAX_SCRIPT_ARGUMENTS, scriptEnvEntries: MAX_SCRIPT_ENV_ENTRIES,
    templateChars: MAX_TEMPLATE_CHARS, promptChars: MAX_PROMPT_CHARS, bodyChars: MAX_BODY_CHARS, edgesPerCell: MAX_EDGES_PER_CELL,
  },
  inputs: { fields: ['name', 'type', 'required', 'description', 'default'], types: [...PLAYBOOK_VALUE_TYPES] },
  policy: { fields: ['browserAutoGrant', 'autoDistill', 'maxRunsToKeep'], defaults: { browserAutoGrant: false, autoDistill: false, maxRunsToKeep: DEFAULT_MAX_RUNS_TO_KEEP } },
});

const cellSummaryOf = (cell: PlaybookRecord['flow']['cells'][number], position: number) => ({
  position, id: cell.id, kind: cell.kind, ...(cell.label !== undefined && { label: cell.label }), has_explicit_next: cell.next !== undefined,
});

const playbookParameter = z.string().describe('Playbook id (from list_playbooks) or its exact name');
const expectedRevParameter = z.int().min(1).describe('The content_rev you read (get_playbook or list_playbook_cells); the write is refused when the playbook has moved since');
const cellIdParameter = z.string().describe('Cell id (from list_playbook_cells)');
const argsParameter = z.record(z.string(), z.unknown()).describe('The fields of the cell for its kind (get_playbook_schema)');

export interface PlaybookToolDeps {
  playbooks: PlaybookService;
  caller: Session;
}

export function registerPlaybookTools(server: McpServer, { playbooks, caller }: PlaybookToolDeps): void {
  const projectIdOfCaller = (): string => {
    if (caller.projectId === undefined) throw new OpenFleetError('project_not_found', 'your session belongs to no project.');
    return caller.projectId;
  };
  const playbookOf = (reference: string): PlaybookRecord => playbooks.getInProject(projectIdOfCaller(), reference);
  const viewOf = (playbook: PlaybookRecord) => playbookView(playbook, playbooks.secretNamesOf(playbook));
  const asAgent = (expectedRev: number) => ({ writer: 'agent' as const, expectedRev });

  server.registerTool('get_playbook_schema', {
    description: 'The shapes the playbook tools validate against: cell kinds and their fields, the flow rules, tokens and the places each may stand, limits, inputs and policy. Read it before authoring a playbook.',
    inputSchema: {},
  }, async () => ok(playbookSchemaView()));

  server.registerTool('list_playbooks', { description: 'The playbooks of your project: id, name, content_rev, number of cells and whether it is locked to agents', inputSchema: {} }, async () =>
    ok({ playbooks: playbooks.list(projectIdOfCaller()).map((playbook) => ({ id: playbook.id, name: playbook.name, content_rev: playbook.contentRev, cell_count: playbook.flow.cells.length, agent_locked: playbook.agentLocked })) }),
  );

  server.registerTool('get_playbook', { description: 'One playbook: inputs, cells, policy, content_rev, the secret names it references and the declared secret names no cell references any more (a human clears those)', inputSchema: { playbook: playbookParameter } }, async ({ playbook }) =>
    ok(viewOf(playbookOf(playbook))),
  );

  server.registerTool('create_playbook', {
    description: 'Create an empty playbook in your project, then add cells with add_playbook_cell. It is inert: nothing runs it, and a human approves what runs.',
    inputSchema: { name: z.string().optional().describe("Display name (default 'Untitled Playbook')") },
  }, async ({ name }) => ok(viewOf(playbooks.create({ projectId: projectIdOfCaller(), writer: 'agent', name }))));

  server.registerTool('delete_playbook', {
    description: 'Delete a playbook. Irreversible; refused when expected_rev is not the current content_rev.',
    inputSchema: { playbook: playbookParameter, expected_rev: expectedRevParameter },
  }, async ({ playbook, expected_rev }) => {
    const target = playbookOf(playbook);
    playbooks.delete(target.id, asAgent(expected_rev));
    return ok({ deleted: target.id });
  });

  server.registerTool('list_playbook_cells', { description: 'The cells of a playbook in document order: position, id, kind and label', inputSchema: { playbook: playbookParameter } }, async ({ playbook }) => {
    const target = playbookOf(playbook);
    return ok({ content_rev: target.contentRev, cells: target.flow.cells.map(cellSummaryOf) });
  });

  server.registerTool('add_playbook_cell', {
    description: `Add a cell of kind ${PLAYBOOK_CELL_KINDS.join(', ')} (get_playbook_schema) after the cell \`after\`, or at the end. The id is yours or the first free cN. The whole playbook is checked on every save: templates in their places, the graph, the caps.`,
    inputSchema: {
      playbook: playbookParameter, kind: z.string(), args: argsParameter.optional(), id: z.string().optional().describe('Cell id (default: the first free cN)'),
      after: z.string().optional().describe('Insert after this cell id (default: at the end)'), expected_rev: expectedRevParameter,
    },
  }, async ({ playbook, kind, args, id, after, expected_rev }) => {
    const cell = { ...args, kind, ...(id !== undefined && { id }) };
    return ok(viewOf(playbooks.addCell(playbookOf(playbook).id, { cell, after }, asAgent(expected_rev))));
  });

  server.registerTool('update_playbook_cell', {
    description: 'Replace the fields given of a cell by id; the other fields keep their value. The id and the kind do not change. The whole playbook is checked on every save.',
    inputSchema: { playbook: playbookParameter, cell_id: cellIdParameter, args: argsParameter, expected_rev: expectedRevParameter },
  }, async ({ playbook, cell_id, args, expected_rev }) =>
    ok(viewOf(playbooks.updateCell(playbookOf(playbook).id, { cellId: cell_id, changes: args }, asAgent(expected_rev)))),
  );

  server.registerTool('delete_playbook_cell', {
    description: 'Delete a cell by id. A cell that another cell leads to through `next` cannot be deleted before that edge changes.',
    inputSchema: { playbook: playbookParameter, cell_id: cellIdParameter, expected_rev: expectedRevParameter },
  }, async ({ playbook, cell_id, expected_rev }) =>
    ok(viewOf(playbooks.deleteCell(playbookOf(playbook).id, { cellId: cell_id }, asAgent(expected_rev)))),
  );

  server.registerTool('reorder_playbook_cells', {
    description: 'Put the cells in a new document order: `order` names every cell id once. Cells with no `next` advance to the cell that follows them.',
    inputSchema: { playbook: playbookParameter, order: z.array(z.string()), expected_rev: expectedRevParameter },
  }, async ({ playbook, order, expected_rev }) =>
    ok(viewOf(playbooks.reorderCells(playbookOf(playbook).id, { order }, asAgent(expected_rev)))),
  );

  server.registerTool('set_playbook_inputs', {
    description: `Replace the declared inputs of a playbook (at most ${MAX_PLAYBOOK_INPUTS}): each has name, type (${PLAYBOOK_VALUE_TYPES.join(', ')}), required, description and default.`,
    inputSchema: { playbook: playbookParameter, inputs: z.array(z.record(z.string(), z.unknown())), expected_rev: expectedRevParameter },
  }, async ({ playbook, inputs, expected_rev }) =>
    ok(viewOf(playbooks.setInputs(playbookOf(playbook).id, { inputs }, asAgent(expected_rev)))),
  );
}
