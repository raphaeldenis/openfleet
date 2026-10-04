import * as z from 'zod';

export const WORKING_STATE_SECTIONS = ['plan', 'todo', 'remaining', 'questionsForHuman', 'internalQuestions', 'blockers'] as const;
export type WorkingStateSectionKey = (typeof WORKING_STATE_SECTIONS)[number];

export const WORKING_STATE_MAX_ITEMS_PER_SECTION = 20;
export const WORKING_STATE_MAX_ITEM_CHARACTERS = 300;

export const WORKING_STATE_TOOL_NAMES = ['mcp__openfleet__update_working_state', 'mcp__openfleet__get_working_state'] as const;

// C0 controls except tab, DEL, next line, line and paragraph separators, bidirectional embeddings, overrides and isolates.
const REFUSED_CODE_POINT_RANGES: readonly (readonly [first: number, last: number])[] = [
  [0x00, 0x08], [0x0a, 0x1f], [0x7f, 0x7f], [0x85, 0x85], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];
const isRefusedCodePoint = (codePoint: number) => REFUSED_CODE_POINT_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
const isPrintableSingleLine = (item: string) => ![...item].some((character) => isRefusedCodePoint(character.codePointAt(0)!));
const isNotHeading = (item: string) => !item.startsWith('#');

const SectionSchema = z
  .array(
    z.string().trim().min(1).max(WORKING_STATE_MAX_ITEM_CHARACTERS)
      .refine(isPrintableSingleLine, { message: 'an item is one printable line: no line break, control or direction character' })
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
