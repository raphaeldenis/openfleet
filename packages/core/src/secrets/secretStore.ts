import { OpenFleetError, type SecretScope, type SecretStatus } from '@openfleet/shared';

/**
 * Where secret values live. A value is held by an adapter (the macOS keychain through the desktop app) and by no table, log or backup of the daemon.
 * Every method throws an OpenFleetError `secret_store_unavailable` when the holder cannot be reached, and `read` throws `secret_not_connected_on_this_device` when it holds no value.
 */
export interface SecretStore {
  set: (scope: SecretScope, name: string, value: string) => Promise<void>;
  /** Removes the value; clearing a value that is not there succeeds. */
  clear: (scope: SecretScope, name: string) => Promise<void>;
  status: (scope: SecretScope, name: string) => Promise<SecretStatus>;
  /** Returns the value for the caller that resolves it, which keeps it only as long as it uses it. */
  read: (scope: SecretScope, name: string) => Promise<string>;
}

export const secretStoreUnavailable = (reason: string): OpenFleetError =>
  new OpenFleetError('secret_store_unavailable', reason, { hint: 'start the OpenFleet desktop app and unlock the keychain, then try again.' });

export const secretNotConnectedOnThisDevice = (name: string): OpenFleetError =>
  new OpenFleetError('secret_not_connected_on_this_device', `the secret ${name} is not connected on this device.`, { hint: 'connect it from the OpenFleet desktop app on this device.' });

/** The store of a daemon that runs without the desktop app: nothing can be set, cleared or read. */
export const createUnavailableSecretStore = (): SecretStore => {
  const refuse = (): Promise<never> => Promise.reject(secretStoreUnavailable('the desktop app that holds the keychain is not connected to the daemon.'));
  return { set: refuse, clear: refuse, status: refuse, read: refuse };
};
