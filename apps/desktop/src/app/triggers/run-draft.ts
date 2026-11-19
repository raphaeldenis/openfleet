import { TriggerRunSchema, type TriggerRun } from '@openfleet/shared';

export type RunKind = TriggerRun['kind'];

export const RUN_KINDS: readonly RunKind[] = ['prompt_manager', 'notify', 'prompt_session', 'close_session', 'run_playbook'];

/** The fields of each RUN kind this screen can rebuild; a stored RUN with any other field (the inputs of a playbook, a field a newer daemon adds) is shown, never rebuilt. */
const RUN_FIELDS: Readonly<Record<RunKind, readonly string[]>> = {
  prompt_manager: ['kind', 'managerId', 'prompt'],
  notify: ['kind', 'title', 'message'],
  prompt_session: ['kind', 'sessionId', 'prompt'],
  close_session: ['kind', 'sessionId'],
  run_playbook: ['kind', 'playbookId'],
};

/** Every parameter of every kind as the form holds it. */
export interface RunDraft {
  kind: RunKind;
  managerId: string;
  prompt: string;
  title: string;
  message: string;
  sessionId: string;
  playbookId: string;
}

const EMPTY_RUN_DRAFT: RunDraft = { kind: 'notify', managerId: '', prompt: '', title: '', message: '', sessionId: '', playbookId: '' };

const fieldsOfKind = (kind: unknown): readonly string[] | undefined =>
  (typeof kind === 'string' && Object.hasOwn(RUN_FIELDS, kind) ? RUN_FIELDS[kind as RunKind] : undefined);

/** The form of a stored RUN, or nothing when this screen cannot rebuild it without losing a field. */
export function runDraftOf(run: TriggerRun): RunDraft | undefined {
  const knownFields = fieldsOfKind(run.kind);
  const hasOnlyKnownFields = knownFields !== undefined && Object.keys(run).every((name) => knownFields.includes(name));
  if (!hasOnlyKnownFields) return undefined;
  const stored = run as Record<string, unknown>;
  const textOf = (name: string) => (typeof stored[name] === 'string' ? (stored[name] as string) : '');
  return { ...EMPTY_RUN_DRAFT, kind: run.kind, managerId: textOf('managerId'), prompt: textOf('prompt'), title: textOf('title'), message: textOf('message'), sessionId: textOf('sessionId'), playbookId: textOf('playbookId') };
}

export const isSameRunDraft = (left: RunDraft, right: RunDraft) => (Object.keys(left) as (keyof RunDraft)[]).every((name) => left[name] === right[name]);

/** The RUN the form describes, with only the parameters of the chosen kind: what the shared schema then accepts or refuses. */
function candidateOf(draft: RunDraft): unknown {
  switch (draft.kind) {
    case 'prompt_manager': return { kind: 'prompt_manager', ...(draft.managerId !== '' && { managerId: draft.managerId }), prompt: draft.prompt };
    case 'notify': return { kind: 'notify', title: draft.title, message: draft.message };
    case 'prompt_session': return { kind: 'prompt_session', sessionId: draft.sessionId, prompt: draft.prompt };
    case 'close_session': return { kind: 'close_session', sessionId: draft.sessionId };
    case 'run_playbook': return { kind: 'run_playbook', playbookId: draft.playbookId };
  }
}

/** The RUN as the shared schema reads the form, or the first thing it refuses. */
export function runOrProblemOf(draft: RunDraft): { run: TriggerRun } | { problem: string } {
  const parsed = TriggerRunSchema.safeParse(candidateOf(draft));
  if (parsed.success) return { run: parsed.data };
  const issue = parsed.error.issues[0]!;
  const place = issue.path.length === 0 ? '' : ` · ${issue.path.join('.')}`;
  return { problem: `Alors${place} : ${issue.message}` };
}
