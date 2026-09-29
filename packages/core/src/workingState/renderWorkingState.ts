import { WORKING_STATE_SECTIONS, type WorkingStateSectionKey, type WorkingStateSections } from '@openfleet/shared';

const HEADING_OF_SECTION: Record<WorkingStateSectionKey, string> = {
  plan: 'Plan',
  todo: 'Todo',
  remaining: 'Reste à faire',
  questionsForHuman: "Questions pour l'humain",
  internalQuestions: 'Questions internes',
  blockers: 'Blocages',
};

const NOTHING_LINE = '(rien)';

/** Renders the six sections as the mirror file's text; its UTF-8 byte length is the size of the state. */
export function renderWorkingState(sections: WorkingStateSections): string {
  const renderedSections = WORKING_STATE_SECTIONS.map((key) => {
    const items = sections[key];
    const lines = items.length === 0 ? [NOTHING_LINE] : items.map((item) => `- ${item}`);
    return `## ${HEADING_OF_SECTION[key]}\n${lines.join('\n')}\n`;
  });
  return renderedSections.join('\n');
}
