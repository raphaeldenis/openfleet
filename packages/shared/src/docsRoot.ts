import * as z from 'zod';

export const DOCS_ROOT_PATH = '/api/settings/docs-root';

export const UpdateDocsRootRequestSchema = z.strictObject({ root: z.string() });
export type UpdateDocsRootRequest = z.infer<typeof UpdateDocsRootRequestSchema>;

export interface DocsRootView {
  /** Absolute path projects' docs folders are proposed under. */
  root: string;
  /** True when no root is saved and `root` is the built-in default. */
  isDefault: boolean;
  /** `<root>/<project name>`; present only when a project name was asked for. */
  proposedPath?: string;
}
