import { z } from 'zod';

export const SESSION_STATES = ['starting', 'generating', 'waiting_permission', 'waiting_input', 'idle', 'closed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const HARNESSES = ['claude-cli', 'fake'] as const;
export type HarnessId = (typeof HARNESSES)[number];

export const SessionSpecSchema = z.object({
  directory: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().default('🤖'),
  model: z.string().optional(),
  seededPrompt: z.string().optional(),
  parentId: z.string().optional(),
  role: z.string().optional(),
  harness: z.enum(HARNESSES).default('claude-cli'),
});
export type SessionSpec = z.infer<typeof SessionSpecSchema>;

export interface Session {
  id: string;
  name: string;
  emoji: string;
  directory: string;
  worktree?: string;
  model?: string;
  parentId?: string;
  role?: string;
  harness: HarnessId;
  state: SessionState;
  stateSince: string;
  exitCode?: number;
  createdAt: string;
  closedAt?: string;
}

export interface QueuedMessage {
  id: string;
  sessionId: string;
  fromSessionId?: string;
  body: string;
  status: 'queued' | 'delivered';
  createdAt: string;
  deliveredAt?: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  reason?: string;
  createdAt: string;
  resolvedAt?: string;
}
