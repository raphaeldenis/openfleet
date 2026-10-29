import * as z from 'zod';
import { hasNoteTitleText } from './projectNote.js';

export const MAX_PROJECT_NAME_CHARS = 80;
const MAX_DOCS_FOLDER_PATH_CHARS = 4096;

export const DEFAULT_POST_CREATE_HOOK_TIMEOUT_SECONDS = 60;
export const MAX_POST_CREATE_HOOK_TIMEOUT_SECONDS = 600;

export interface Project {
  id: string;
  name: string;
  docsFolderPath: string | null;
  /** Absolute path of the executable that runs in each new worktree; absent when none is configured. */
  postCreateHookScript?: string;
  /** How long that script may run; absent means the default. */
  postCreateHookTimeoutSeconds?: number;
  /** Names of the other projects that use the same docs folder; absent when the folder is the project's own. */
  docsFolderSharedWith?: string[];
  /** Present and true when the project's rows keep their journal append-only and need a pr_url to be done; absent means off. */
  rowGuardEnabled?: true;
  /** Present when the guard is on and a `status` or `step` column of the project is not a select column, so the done rule never fires on it. */
  rowGuardWarning?: string;
}

const ProjectNameSchema = z.string().trim().min(1).max(MAX_PROJECT_NAME_CHARS).refine(hasNoteTitleText, { message: 'name must keep some text once template braces are removed' });
// Whether the path is absolute and exists is the daemon's call: shared stays free of Node's path module.
const DocsFolderPathSchema = z.string().min(1).max(MAX_DOCS_FOLDER_PATH_CHARS);

const MAX_GOAL_CHARS = 2000;
const MAX_STACK_BULLETS = 20;
const MAX_STACK_BULLET_CHARS = 80;
const MAX_COMMAND_CHARS = 300;
const MAX_REPOSITORIES = 10;

const ProjectCommandSchema = z.string().trim().max(MAX_COMMAND_CHARS);

/** What the onboarding Project step writes into the body of the "Project: <name>" note. */
export const ProjectProfileSchema = z.strictObject({
  goal: z.string().trim().max(MAX_GOAL_CHARS).optional(),
  stack: z.array(z.string().trim().max(MAX_STACK_BULLET_CHARS)).max(MAX_STACK_BULLETS).optional(),
  commands: z
    .strictObject({ install: ProjectCommandSchema.optional(), build: ProjectCommandSchema.optional(), test: ProjectCommandSchema.optional(), dev: ProjectCommandSchema.optional() })
    .optional(),
  repositories: z.array(DocsFolderPathSchema).max(MAX_REPOSITORIES).optional(),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export const CreateProjectRequestSchema = z
  .strictObject({
    name: ProjectNameSchema,
    docsFolderPath: DocsFolderPathSchema.optional(),
    profile: ProjectProfileSchema.optional(),
  })
  .refine((request) => request.profile === undefined || request.docsFolderPath !== undefined, {
    message: 'profile needs a docsFolderPath: the project note is written into the docs folder',
    path: ['profile'],
  });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const DetectRepositoryRequestSchema = z.strictObject({ repositoryPath: DocsFolderPathSchema });
export type DetectRepositoryRequest = z.infer<typeof DetectRepositoryRequestSchema>;

export const DETECTED_COMMAND_KINDS = ['install', 'build', 'test', 'lint', 'typecheck', 'dev'] as const;
export type DetectedCommandKind = (typeof DETECTED_COMMAND_KINDS)[number];

/** `command` is built by the daemon from a validated script or target name; a script body is never returned. */
export interface DetectedCommand {
  command: string;
  source: 'package.json' | 'Makefile' | 'pyproject.toml' | 'Cargo.toml';
}

export interface DetectedRepository {
  isGitRepository: boolean;
  defaultBranch?: string;
  stack: string[];
  commands: Partial<Record<DetectedCommandKind, DetectedCommand>>;
}

/** `null` clears the setting. Whether the script is absolute, executable and safe is the daemon's call. */
const PostCreateHookScriptSchema = DocsFolderPathSchema.nullable();
const PostCreateHookTimeoutSchema = z.number().int().min(1).max(MAX_POST_CREATE_HOOK_TIMEOUT_SECONDS).nullable();

export const UpdateProjectRequestSchema = z
  .strictObject({
    name: ProjectNameSchema.optional(),
    docsFolderPath: DocsFolderPathSchema.optional(),
    postCreateHookScript: PostCreateHookScriptSchema.optional(),
    postCreateHookTimeoutSeconds: PostCreateHookTimeoutSchema.optional(),
    rowGuardEnabled: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'name, docsFolderPath, postCreateHookScript, postCreateHookTimeoutSeconds or rowGuardEnabled is required' });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
