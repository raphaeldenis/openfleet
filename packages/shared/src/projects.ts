import * as z from 'zod';

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
  /** Present and true when the project's rows keep their journal append-only and need a pr_url to be done; absent means off. */
  rowGuardEnabled?: true;
}

const ProjectNameSchema = z.string().trim().min(1).max(MAX_PROJECT_NAME_CHARS);
// Whether the path is absolute and exists is the daemon's call: shared stays free of Node's path module.
const DocsFolderPathSchema = z.string().min(1).max(MAX_DOCS_FOLDER_PATH_CHARS);

export const CreateProjectRequestSchema = z.strictObject({
  name: ProjectNameSchema,
  docsFolderPath: DocsFolderPathSchema.optional(),
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
