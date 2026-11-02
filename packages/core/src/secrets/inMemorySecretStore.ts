import type { SecretScope } from '@openfleet/shared';
import { secretNotConnectedOnThisDevice, type SecretStore } from './secretStore.js';

export interface InMemorySecretStore extends SecretStore {
  /** The held value, for a test to look at what the store was given. */
  valueOf: (scope: SecretScope, name: string) => string | undefined;
}

const keyOf = (scope: SecretScope, name: string): string => `${scope.kind}/${scope.id}/${name}`;

/** A store that keeps values in the memory of the process, for tests. */
export const createInMemorySecretStore = (): InMemorySecretStore => {
  const values = new Map<string, string>();
  return {
    set: async (scope, name, value) => void values.set(keyOf(scope, name), value),
    clear: async (scope, name) => void values.delete(keyOf(scope, name)),
    status: async (scope, name) => (values.has(keyOf(scope, name)) ? 'stored' : 'missing'),
    read: async (scope, name) => {
      const value = values.get(keyOf(scope, name));
      if (value === undefined) throw secretNotConnectedOnThisDevice(name);
      return value;
    },
    valueOf: (scope, name) => values.get(keyOf(scope, name)),
  };
};
