import { BACKTICKED_TOOL_NAME, CHILDREN_COUNT_PHRASES, EXACT_MODEL_ID, HUMAN_QA_PHRASES } from './managerContentPatterns.js';

const MAX_BASE_BYTES = 8192;

export interface ManagerBaseLintInput {
  /** The whole delivered file. */
  source: string;
  /** The normalized body size the loader reports. */
  bodyBytes: number;
  /** Every tool the daemon registers. */
  registeredToolNames: ReadonlySet<string>;
}

/** Returns one sentence per rule the delivered base breaks; an empty list means it may ship. */
export function lintManagerBase({ source, bodyBytes, registeredToolNames }: ManagerBaseLintInput): string[] {
  const lines = source.split('\n');
  const lineViolations = lines.flatMap((line, index) => {
    const lineNumber = index + 1;
    const found: string[] = [];
    if (HUMAN_QA_PHRASES.test(line)) found.push(`line ${lineNumber} says QA belongs to the human`);
    if (CHILDREN_COUNT_PHRASES.some((phrase) => phrase.test(line))) found.push(`line ${lineNumber} writes a number of children`);
    if (EXACT_MODEL_ID.test(line)) found.push(`line ${lineNumber} names an exact model id`);
    for (const [, toolName] of line.matchAll(BACKTICKED_TOOL_NAME)) {
      if (!registeredToolNames.has(toolName!)) found.push(`line ${lineNumber} cites the tool ${toolName}, which the daemon does not register`);
    }
    return found;
  });
  const sizeViolations = bodyBytes > MAX_BASE_BYTES ? [`the body is ${bodyBytes} bytes, over ${MAX_BASE_BYTES}`] : [];
  return [...lineViolations, ...sizeViolations];
}
