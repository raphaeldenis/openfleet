import { z } from 'zod';

const base = {
  session_id: z.string(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
};

export const ClaudeHookEventSchema = z.discriminatedUnion('hook_event_name', [
  z.object({ ...base, hook_event_name: z.literal('SessionStart') }),
  z.object({ ...base, hook_event_name: z.literal('SessionEnd') }),
  z.object({ ...base, hook_event_name: z.literal('UserPromptSubmit'), user_prompt: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('PreToolUse'), tool_name: z.string(), tool_input: z.unknown(), tool_use_id: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('PostToolUse'), tool_name: z.string(), tool_use_id: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('PermissionRequest'), tool_name: z.string(), tool_input: z.unknown() }),
  z.object({ ...base, hook_event_name: z.literal('Notification'), notification_type: z.string(), message: z.string().optional() }),
  z.object({ ...base, hook_event_name: z.literal('Stop'), last_assistant_message: z.string().optional(), stop_hook_active: z.boolean().optional() }),
]);
export type ClaudeHookEvent = z.infer<typeof ClaudeHookEventSchema>;
export type ClaudeHookEventName = ClaudeHookEvent['hook_event_name'];

export const HOOK_EVENT_NAMES: ClaudeHookEventName[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop',
];

export interface PermissionRequestHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: 'allow' | 'deny' | 'ask';
    decisionReason?: string;
  };
}
