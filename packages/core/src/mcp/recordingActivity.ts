import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import type { ActivityRecorder } from '../activity/activityRecorder.js';
import { failureDetailOf, outcomeOfErrorCode } from '../activity/refusalOutcome.js';
import { isMutatingTool } from './toolCatalog.js';

const ERROR_TEXT_CODE = /^error ([a-z_]+):/;

/** Arguments whose values never reach the log, whatever their key: the values of the inputs of a run are typed by the caller and may hold anything, even under a key other tools share. */
const ARGUMENTS_WITHHELD_FROM_THE_LOG: Readonly<Record<string, readonly string[]>> = { run_playbook: ['inputs'], run_playbook_cell: ['inputs'] };
const WITHHELD_MARK = '[withheld]';

const withoutWithheldArguments = (toolName: string, args: unknown): unknown => {
  const withheldNames = ARGUMENTS_WITHHELD_FROM_THE_LOG[toolName];
  const hasNothingToWithhold = withheldNames === undefined || typeof args !== 'object' || args === null;
  if (hasNothingToWithhold) return args;
  return Object.fromEntries(Object.entries(args).map(([name, value]) => [name, withheldNames.includes(name) ? WITHHELD_MARK : value]));
};

type ToolHandler = (...args: unknown[]) => unknown;
type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

const firstTextOf = (result: ToolResult | undefined): string | undefined => result?.content?.find((part) => part.type === 'text')?.text;

const errorCodeOf = (result: ToolResult | undefined): string | undefined =>
  (result?.isError === true ? ERROR_TEXT_CODE.exec(firstTextOf(result) ?? '')?.[1] : undefined);

const outcomeOf = (result: ToolResult | undefined): 'ok' | 'denied' | 'error' => (result?.isError === true ? outcomeOfErrorCode(errorCodeOf(result)) : 'ok');

/** A view of the server whose mutating tools leave a row in the activity log, keyed by the parameter names their schemas declare; a read, an error and a throw all pass through unchanged. */
export function recordingActivity(server: McpServer, { caller, recorder, managerId }: { caller: Session; recorder: ActivityRecorder; managerId: string }): McpServer {
  const registerRecording = (name: string, config: { inputSchema?: unknown }, handler: ToolHandler) => {
    const register = server.registerTool as (...args: unknown[]) => unknown;
    if (!isMutatingTool(name)) return register.call(server, name, config, handler);
    recorder.learnToolParameters(name, config.inputSchema);
    const takesArguments = config.inputSchema !== undefined;
    const recordedHandler: ToolHandler = async (...handlerArguments) => {
      const startedAt = performance.now();
      const record = (outcome: 'ok' | 'denied' | 'error', extra: { resultText?: string; detail?: string }) => recorder.record({
        actorKind: 'agent', actorLabel: caller.name, sessionId: caller.id, managerId, source: 'mcp', action: name, outcome,
        durationMs: Math.round(performance.now() - startedAt),
        ...(takesArguments ? { args: withoutWithheldArguments(name, handlerArguments[0]) } : {}),
        ...extra,
      });
      try {
        const result = await handler(...handlerArguments) as ToolResult | undefined;
        const resultText = firstTextOf(result);
        const errorCode = errorCodeOf(result);
        record(outcomeOf(result), { ...(resultText === undefined ? {} : { resultText }), ...(errorCode === undefined ? {} : { detail: errorCode }) });
        return result;
      } catch (error) {
        record('error', { detail: failureDetailOf(error) });
        throw error;
      }
    };
    return register.call(server, name, config, recordedHandler);
  };
  return new Proxy(server, {
    get: (target, property) => (property === 'registerTool' ? registerRecording : Reflect.get(target, property, target)),
  });
}
