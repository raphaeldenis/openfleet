import type { SecretScope } from '@openfleet/shared';

/**
 * What the daemon prints for the desktop app that spawned it (a request to act on the keychain). It names the operation, the scope, the secret name and two nonces; it never holds a value.
 * The app does the work on the keychain and answers over the daemon's loopback routes: `POST /internal/secrets/take` (set only: returns the value once, to the take nonce)
 * and `POST /internal/secrets/deliver` (the outcome, once, to the deliver nonce).
 */
export type DaemonToParentMessage = {
  type: 'secret_request';
  requestId: string;
  op: 'set' | 'clear' | 'status' | 'read';
  scope: SecretScope;
  name: string;
  deliverNonce: string;
  /** Present for a set only. */
  takeNonce?: string;
};

/** What the desktop app writes to the daemon: the operator nonce its Tauri command minted, which authorises one REST set or clear. */
export type ParentToDaemonMessage = { type: 'operator_nonce'; nonce: string };

/** The line between the daemon and the app that spawned it: the sidecar's stdout towards the app, its stdin from the app. An agent cannot write to either pipe. */
export interface SecretParentLink {
  send: (message: DaemonToParentMessage) => void;
  onMessage: (listener: (message: ParentToDaemonMessage) => void) => void;
}
