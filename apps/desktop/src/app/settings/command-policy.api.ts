import { inject, Injectable } from '@angular/core';
import type { CommandPolicyEvaluateRequest, CommandPolicyEvaluateResult, CommandPolicyOverride, CommandPolicyView, DeniedCommandPage } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';

const COMMAND_POLICY_PATH = '/api/command-policy';

/** The admin routes of the command policy; lives in the lazy chunk of the Command policy section so the initial bundle does not carry it. */
@Injectable({ providedIn: 'root' })
export class CommandPolicyApi {
  private readonly api = inject(FleetApiService);

  view() { return this.api.call<CommandPolicyView>(COMMAND_POLICY_PATH); }
  save(override: CommandPolicyOverride) { return this.api.call<CommandPolicyView>(COMMAND_POLICY_PATH, { method: 'PUT', body: JSON.stringify(override) }); }
  tryCommand(request: CommandPolicyEvaluateRequest) { return this.api.call<CommandPolicyEvaluateResult>(`${COMMAND_POLICY_PATH}/evaluate`, { method: 'POST', body: JSON.stringify(request) }); }
  denials({ cursor }: { cursor?: string } = {}) {
    const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor })}`;
    return this.api.call<DeniedCommandPage>(`${COMMAND_POLICY_PATH}/denials${query}`);
  }
}
