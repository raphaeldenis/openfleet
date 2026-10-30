const USAGE_INGESTION_ENV = 'OPENFLEET_USAGE_INGESTION';
const USAGE_INGESTION_ON = '1';

/** The usage ingestion is off unless the variable holds exactly "1". */
export const usageIngestionEnabledBy = (env: NodeJS.ProcessEnv): boolean => env[USAGE_INGESTION_ENV] === USAGE_INGESTION_ON;
