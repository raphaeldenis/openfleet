import { WORKING_STATE_MAX_ITEM_CHARACTERS, WORKING_STATE_MAX_ITEMS_PER_SECTION, WorkingStateSectionsSchema } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_STATE_MAX_BYTES } from '../../workingState/workingStateSettings.js';
import { renderWorkingState } from '../../workingState/renderWorkingState.js';
import { parseWorkingStateFile } from './scapeWorkingStateFile.js';

const fileOf = (...lines: string[]) => lines.join('\n');

describe('parseWorkingStateFile', () => {
  it('maps the six working state headings to their sections, bullet by bullet', () => {
    const text = fileOf(
      '# Title of the file', '',
      '## Plan', '- first plan item', '- second plan item', '',
      '## Todo', '- a todo', '',
      '## Reste à faire', '- something remains', '',
      '## Questions pour Raphaël', '- a question', '',
      '## Questions internes', '- an inner question', '',
      '## Blocages', '- a blocker',
    );

    const parsed = parseWorkingStateFile(text);

    expect(parsed.sections).toEqual({
      plan: ['first plan item', 'second plan item'], todo: ['a todo'], remaining: ['something remains'],
      questionsForHuman: ['a question'], internalQuestions: ['an inner question'], blockers: ['a blocker'],
    });
    expect(parsed.mergedSectionCount).toBe(0);
    expect(parsed.isNotFullyConverted).toBe(false);
  });

  it("accepts the heading 'Questions pour l'humain' and ignores the case and a trailing parenthesis of a heading", () => {
    const parsed = parseWorkingStateFile(fileOf("## questions pour l'humain (2, 10:00Z)", '- a question'));

    expect(parsed.sections.questionsForHuman).toEqual(['a question']);
  });

  it('keeps numbered items and nested bullets as items of their own, and drops the empty-section placeholder and blank lines', () => {
    const parsed = parseWorkingStateFile(fileOf('## Todo', '1. numbered', '  - nested', '', '* starred', '(rien)'));

    expect(parsed.sections.todo).toEqual(['numbered', 'nested', 'starred']);
  });

  it.each([
    ['Ordres permanents', 'plan'],
    ['Décisions Raphaël', 'plan'],
    ['Main et PR', 'remaining'],
    ['Enfants vivants (4, 15:33Z)', 'remaining'],
    ['A heading nobody planned', 'plan'],
  ] as const)('folds the unknown heading "%s" into the section %s under a line that carries the original heading', (heading, sectionKey) => {
    const parsed = parseWorkingStateFile(fileOf(`## ${heading}`, '- first', '- second'));

    const bareHeading = heading.replace(/\s*\(.*\)$/, '');
    expect(parsed.sections[sectionKey]).toEqual([`[${bareHeading}]`, 'first', 'second']);
    expect(parsed.mergedSectionCount).toBe(1);
  });

  it('keeps file order inside a section that receives its own items and a folded section', () => {
    const parsed = parseWorkingStateFile(fileOf('## Plan', '- own item', '## Ordres permanents', '- standing order'));

    expect(parsed.sections.plan).toEqual(['own item', '[Ordres permanents]', 'standing order']);
  });

  it('cuts an item longer than the item limit with an ellipsis and says the file was not fully converted', () => {
    const parsed = parseWorkingStateFile(fileOf('## Plan', `- ${'x'.repeat(WORKING_STATE_MAX_ITEM_CHARACTERS + 50)}`));

    const [item] = parsed.sections.plan;
    expect([...item!]).toHaveLength(WORKING_STATE_MAX_ITEM_CHARACTERS);
    expect(item!.endsWith('…')).toBe(true);
    expect(parsed.isNotFullyConverted).toBe(true);
  });

  it('keeps the first items of a section that has more than the limit and says the file was not fully converted', () => {
    const lines = Array.from({ length: WORKING_STATE_MAX_ITEMS_PER_SECTION + 3 }, (_, index) => `- item ${index}`);

    const parsed = parseWorkingStateFile(fileOf('## Todo', ...lines));

    expect(parsed.sections.todo).toHaveLength(WORKING_STATE_MAX_ITEMS_PER_SECTION);
    expect(parsed.sections.todo[0]).toBe('item 0');
    expect(parsed.isNotFullyConverted).toBe(true);
  });

  it('drops items from the largest section until the state fits the size cap, and says the file was not fully converted', () => {
    const bulky = (name: string) => Array.from({ length: 20 }, (_, index) => `- ${name} ${index} ${'w'.repeat(280)}`);

    const parsed = parseWorkingStateFile(fileOf('## Plan', ...bulky('plan'), '## Todo', ...bulky('todo')));

    expect(Buffer.byteLength(renderWorkingState(parsed.sections), 'utf8')).toBeLessThanOrEqual(DEFAULT_WORKING_STATE_MAX_BYTES);
    expect(parsed.isNotFullyConverted).toBe(true);
    expect(parsed.sections.plan.length).toBeGreaterThan(0);
    expect(parsed.sections.todo.length).toBeGreaterThan(0);
  });

  it('replaces control and direction characters with a space so that every item is a printable line', () => {
    const parsed = parseWorkingStateFile(fileOf('## Plan', '- a\u0007b‮c'));

    expect(WorkingStateSectionsSchema.safeParse(parsed.sections).success).toBe(true);
    expect(parsed.sections.plan).toEqual(['a b c']);
  });

  it('never lets an item start with a hash, which the working state refuses', () => {
    const parsed = parseWorkingStateFile(fileOf('## Plan', '- #1 priority', '#### deep heading'));

    expect(WorkingStateSectionsSchema.safeParse(parsed.sections).success).toBe(true);
  });

  it('gives six empty sections for a file without any heading', () => {
    expect(parseWorkingStateFile('just words\nno heading').sections).toEqual({ plan: [], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] });
  });
});
