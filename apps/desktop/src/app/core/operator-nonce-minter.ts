import { Injectable } from '@angular/core';

/** The desktop shell mints the single-use proof of a human gesture; the webview only relays it to the daemon. */
@Injectable({ providedIn: 'root', useFactory: () => new TauriOperatorNonceMinter() })
export abstract class OperatorNonceMinter {
  /** Returns a nonce the daemon accepts once, for arming this trigger and no other; rejects when the desktop shell is not there to mint it. */
  abstract mintTriggerArmingNonce(triggerId: string): Promise<string>;
}

class TauriOperatorNonceMinter extends OperatorNonceMinter {
  async mintTriggerArmingNonce(triggerId: string): Promise<string> {
    const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
    if (!isTauriWebview) throw new Error('arming a trigger needs the desktop app');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('mint_operator_nonce', { action: 'trigger.arm', scopeKind: 'trigger', scopeId: triggerId, name: triggerId });
  }
}
