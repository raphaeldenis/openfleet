import * as z from 'zod';

export const TOOL_CATEGORIES = ['read_only', 'additive', 'destructive', 'execution_external'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** One MCP tool of the server: its name, the domain it belongs to and what a call can do. */
export const ToolSummarySchema = z.strictObject({
  name: z.string().min(1),
  domain: z.string().min(1),
  category: z.enum(TOOL_CATEGORIES),
});
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

/** The answer of `GET /api/tools`, sorted by name. */
export const ToolListSchema = z.strictObject({ items: z.array(ToolSummarySchema) });
export type ToolList = z.infer<typeof ToolListSchema>;
