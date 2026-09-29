import { z } from 'zod';

export const WORKING_STATE_SECTIONS = ['plan', 'todo', 'remaining', 'questionsForHuman', 'internalQuestions', 'blockers'] as const;
export type WorkingStateSectionKey = (typeof WORKING_STATE_SECTIONS)[number];

export const WORKING_STATE_MAX_ITEMS_PER_SECTION = 20;
export const WORKING_STATE_MAX_ITEM_CHARACTERS = 300;

export const WORKING_STATE_TOOL_NAMES = ['mcp__openfleet__update_working_state', 'mcp__openfleet__get_working_state'] as const;

const isSingleLine = (item: string) => !/[\r\n]/.test(item);
const isNotHeading = (item: string) => !item.startsWith('#');

const SectionSchema = z
  .array(
    z.string().trim().min(1).max(WORKING_STATE_MAX_ITEM_CHARACTERS)
      .refine(isSingleLine, { message: 'an item is one line: no line break' })
      .refine(isNotHeading, { message: 'an item never starts with #' }),
  )
  .max(WORKING_STATE_MAX_ITEMS_PER_SECTION);

export const WorkingStateSectionsSchema = z.object({
  plan: SectionSchema,
  todo: SectionSchema,
  remaining: SectionSchema,
  questionsForHuman: SectionSchema,
  internalQuestions: SectionSchema,
  blockers: SectionSchema,
});
export type WorkingStateSections = z.infer<typeof WorkingStateSectionsSchema>;

export interface WorkingState extends WorkingStateSections {
  sessionId: string;
  updatedAt: string;
  fleetChangedAt?: string;
}
