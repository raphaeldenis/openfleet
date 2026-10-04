import * as z from 'zod';

export const MAX_PROJECT_NAME_CHARS = 80;
const MAX_DOCS_FOLDER_PATH_CHARS = 4096;

export interface Project {
  id: string;
  name: string;
  docsFolderPath: string | null;
}

const ProjectNameSchema = z.string().trim().min(1).max(MAX_PROJECT_NAME_CHARS);
// Whether the path is absolute and exists is the daemon's call: shared stays free of Node's path module.
const DocsFolderPathSchema = z.string().min(1).max(MAX_DOCS_FOLDER_PATH_CHARS);

export const CreateProjectRequestSchema = z.strictObject({
  name: ProjectNameSchema,
  docsFolderPath: DocsFolderPathSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .strictObject({ name: ProjectNameSchema.optional(), docsFolderPath: DocsFolderPathSchema.optional() })
  .refine((patch) => patch.name !== undefined || patch.docsFolderPath !== undefined, { message: 'name or docsFolderPath is required' });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
