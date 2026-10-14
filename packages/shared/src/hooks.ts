import * as z from 'zod';

const base = {
  session_id: z.string(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
};

// Who is calling: present on tool hooks only, and agent_id/agent_type only when a sub-agent makes the call.
const toolCaller = {
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  prompt_id: z.string().optional(),
  permission_mode: z.string().optional(),
  effort: z.object({ level: z.string().optional() }).optional(),
};

export const ClaudeHookEventSchema = z.discriminatedUnion('hook_event_name', [
  // source is 'startup' | 'resume' | 'clear' | 'compact' today; a string keeps a future value from failing the hook.
  z.object({ ...base, hook_event_name: z.literal('SessionStart'), source: z.string().optional() }),
  // reason is 'clear' | 'logout' | 'prompt_input_exit' | 'other' today; a string keeps a future value from failing the hook.
  z.object({ ...base, hook_event_name: z.literal('SessionEnd'), reason: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('UserPromptSubmit'), user_prompt: z.string().optional(), prompt: z.string().optional() }),
  z.object({ ...base, ...toolCaller, hook_event_name: z.literal('PreToolUse'), tool_name: z.string(), tool_input: z.unknown(), tool_use_id: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('PostToolUse'), tool_name: z.string(), tool_use_id: z.string().optional(), tool_input: z.unknown().optional(), tool_response: z.unknown().optional() }),
  z.object({ ...base, ...toolCaller, hook_event_name: z.literal('PermissionRequest'), tool_name: z.string(), tool_input: z.unknown(), permission_suggestions: z.array(z.unknown()).optional() }),
  z.object({ ...base, hook_event_name: z.literal('Notification'), notification_type: z.string(), message: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('Stop'), last_assistant_message: z.string().optional(), stop_hook_active: z.boolean().optional() }),
]);
export type ClaudeHookEvent = z.infer<typeof ClaudeHookEventSchema>;
export type ClaudeHookEventName = ClaudeHookEvent['hook_event_name'];

export interface StopHookOutput { decision: 'block'; reason: string }

export const HOOK_EVENT_NAMES: ClaudeHookEventName[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop',
];

export interface PermissionRequestHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' | 'deny'; message?: string };
  };
}

export interface PreToolUseHookOutput {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow' | 'deny'; permissionDecisionReason: string };
}

export interface ContextHookOutput {
  hookSpecificOutput: { hookEventName: 'SessionStart' | 'UserPromptSubmit'; additionalContext: string };
}
