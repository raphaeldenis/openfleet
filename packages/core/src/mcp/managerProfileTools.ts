import { ManagerExpertiseSchema, ManagerPulseActionsSchema, OpenFleetError, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeError } from '../errors/describeError.js';
import type { ManagerService } from '../managers/managerService.js';
import { fail, ok, refuse } from './toolResults.js';

export interface RegisterManagerProfileToolsDeps {
  managers: ManagerService;
  caller: Session;
}

/** The manager is always the caller: no field names a target, and any field outside this list is refused, the mission included. */
const SetManagerProfileInput = z.strictObject({
  expertise: ManagerExpertiseSchema.optional(),
  pulse_actions: ManagerPulseActionsSchema.optional(),
  expected_profile_rev: z.number().int().positive().optional(),
});

const MANAGER_PROFILE_RESOURCE = 'manager_profile';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isStaleProfile(error: unknown): error is OpenFleetError {
  const isStaleRevision = error instanceof OpenFleetError && error.code === 'stale_revision';
  return isStaleRevision && isRecord(error.options.detail) && error.options.detail.resource === MANAGER_PROFILE_RESOURCE;
}

/** The refusal of a stale profile write; the current revision is part of the text, because the tool text does not carry the error detail. */
function staleProfileRefusal(error: OpenFleetError) {
  const { currentRev } = error.options.detail as { currentRev: number };
  const message = `${error.message} currentRev: ${currentRev}.`;
  return fail(describeError(new OpenFleetError('stale_revision', message, { hint: error.options.hint, detail: error.options.detail })));
}

export function registerManagerProfileTools(server: McpServer, deps: RegisterManagerProfileToolsDeps): void {
  const { managers, caller } = deps;

  server.registerTool('set_manager_profile', {
    description: 'Set your own manager card (managers only): expertise (up to 500 characters) and pulse_actions (up to 12 distinct actions of up to 280 characters). Only the fields you give are replaced; "" or [] clears one. Give at least one of them. The mission stays with your human or your parent. expected_profile_rev is optional: when it is not the current revision, the write is refused with stale_revision and the text tells the currentRev. Answers with your expertise, pulseActions and profileRev',
    inputSchema: SetManagerProfileInput,
  }, async ({ expertise, pulse_actions, expected_profile_rev }) => {
    const isManager = managers.get(caller.id) !== undefined;
    if (!isManager) return refuse('not_a_manager', 'only a manager can set its own profile');
    const givesContent = expertise !== undefined || pulse_actions !== undefined;
    if (!givesContent) return refuse('invalid_body', 'give expertise, pulse_actions or both');
    try {
      const updatedManager = managers.update(caller.id, { expertise, pulseActions: pulse_actions, expectedProfileRev: expected_profile_rev });
      if (!updatedManager) return refuse('not_a_manager', 'only a manager can set its own profile');
      return ok({ expertise: updatedManager.expertise ?? '', pulseActions: updatedManager.pulseActions ?? [], profileRev: updatedManager.profileRev });
    } catch (error) {
      if (isStaleProfile(error)) return staleProfileRefusal(error);
      throw error;
    }
  });
}
