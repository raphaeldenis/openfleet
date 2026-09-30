import { readableConfigReason } from './configReason.js';

export class ConfigFileError extends Error {
  constructor(cause: unknown) {
    super(readableConfigReason(cause));
  }
}

export function readingConfigFile<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new ConfigFileError(error);
  }
}
