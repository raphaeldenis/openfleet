declare const __OPENFLEET_VERSION__: string | undefined;

const isVersionInjectedAtBuild = typeof __OPENFLEET_VERSION__ === 'string';

/** The daemon's version: injected by the bundler as `__OPENFLEET_VERSION__`, "dev" when run from source. */
export const DAEMON_VERSION: string = isVersionInjectedAtBuild ? __OPENFLEET_VERSION__ : 'dev';
