import { describe, expect, it } from 'vitest';
import { appendSection, getSection, listSections, replaceSection } from './noteSections.js';

describe('listSections', () => {
  it('lists each ## heading with its 0-based first and last line', () => {
    const body = '# Title\n\n## Transport\nold\n\n## Events\nkeep this';

    const sections = listSections(body);

    expect(sections).toEqual([
      { heading: 'Transport', level: 2, startLine: 2, endLine: 4 },
      { heading: 'Events', level: 2, startLine: 5, endLine: 6 },
    ]);
  });

  it('keeps a ### subsection inside its parent section', () => {
    const body = '## Parent\nintro\n### Child\ndetail\n## Next\nx';

    const sections = listSections(body);

    expect(sections.map((section) => section.heading)).toEqual(['Parent', 'Next']);
    expect(sections[0]).toMatchObject({ startLine: 0, endLine: 3 });
  });

  it('ends a section at the next # heading', () => {
    const body = '## Notes\nline\n# Appendix\nother';

    const sections = listSections(body);

    expect(sections).toEqual([{ heading: 'Notes', level: 2, startLine: 0, endLine: 1 }]);
  });

  it('ignores headings inside ``` and ~~~ fenced code blocks', () => {
    const body = '## Real\n```md\n## fake\n```\n~~~\n## also fake\n~~~\n## After';

    const headings = listSections(body).map((section) => section.heading);

    expect(headings).toEqual(['Real', 'After']);
  });

  it('lists every section when a heading appears twice', () => {
    const body = '## Log\nfirst\n## Log\nsecond';

    const sections = listSections(body);

    expect(sections.map((section) => section.startLine)).toEqual([0, 2]);
  });

  it('does not treat a hash without a following space as a heading', () => {
    const body = '#hashtag\n##Squashed\n## Real\nx';

    const headings = listSections(body).map((section) => section.heading);

    expect(headings).toEqual(['Real']);
  });

  it('returns no sections for a body without ## headings', () => {
    expect(listSections('# Title\njust text')).toEqual([]);
  });
});

describe('getSection', () => {
  it('returns the content under a heading without the heading or trailing blank lines', () => {
    const body = '# Title\n\n## Transport\nold\nmore\n\n## Events\nkeep this';

    expect(getSection(body, 'Transport')).toBe('old\nmore');
  });

  it('includes ### subsections in the parent content', () => {
    const body = '## Parent\nintro\n### Child\ndetail\n## Next\nx';

    expect(getSection(body, 'Parent')).toBe('intro\n### Child\ndetail');
  });

  it('includes fenced lines that look like headings', () => {
    const body = '## Code\n```\n## fake\n```\nafter\n## Next\nx';

    expect(getSection(body, 'Code')).toBe('```\n## fake\n```\nafter');
  });

  it('returns undefined when the heading does not exist', () => {
    expect(getSection('## A\nx', 'Missing')).toBeUndefined();
  });

  it('returns an empty string for a heading without content', () => {
    expect(getSection('## Empty\n\n## Next\nx', 'Empty')).toBe('');
  });

  it('matches the heading exactly once surrounding whitespace is trimmed', () => {
    const body = '##   Transport  \nold';

    expect(getSection(body, '  Transport ')).toBe('old');
    expect(getSection(body, 'transport')).toBeUndefined();
    expect(getSection(body, 'Trans')).toBeUndefined();
  });

  it('targets the first section when a heading appears twice', () => {
    const body = '## Log\nfirst\n## Log\nsecond';

    expect(getSection(body, 'Log')).toBe('first');
  });

  it('keeps CRLF line breaks inside multi-line content', () => {
    const body = '## A\r\none\r\ntwo\r\n## B\r\nx';

    expect(getSection(body, 'A')).toBe('one\r\ntwo');
  });
});

describe('replaceSection', () => {
  it('replaces only the content between one ## heading and the next', () => {
    const body = '# Title\n\n## Transport\nold\n\n## Events\nkeep this';
    expect(replaceSection(body, 'Transport', 'new')).toBe('# Title\n\n## Transport\nnew\n\n## Events\nkeep this');
  });

  it('throws a clear error when the heading does not exist', () => {
    expect(() => replaceSection('# T\n## A\nx', 'Missing', 'y')).toThrow(/section "Missing" not found/);
  });

  it('replaces a ### subsection together with the rest of its parent section', () => {
    const body = '## Parent\nintro\n### Child\ndetail\n## Next\nx';

    expect(replaceSection(body, 'Parent', 'fresh')).toBe('## Parent\nfresh\n## Next\nx');
  });

  it('is not fooled by a fenced ## heading inside the section', () => {
    const body = '## Code\n```\n## fake\n```\n## Next\nx';

    expect(replaceSection(body, 'Code', 'plain')).toBe('## Code\nplain\n## Next\nx');
  });

  it('replaces the first section when a heading appears twice', () => {
    const body = '## Log\nfirst\n## Log\nsecond';

    expect(replaceSection(body, 'Log', 'changed')).toBe('## Log\nchanged\n## Log\nsecond');
  });

  it('keeps the CRLF line breaks of a CRLF body', () => {
    const body = '# T\r\n\r\n## A\r\nold\r\n\r\n## B\r\nkeep';

    const replaced = replaceSection(body, 'A', 'new');

    expect(replaced).toBe('# T\r\n\r\n## A\r\nnew\r\n\r\n## B\r\nkeep');
  });

  it('writes multi-line new content with the line breaks of a CRLF body', () => {
    const body = '## A\r\nold\r\n## B\r\nkeep';

    const replaced = replaceSection(body, 'A', 'one\ntwo');

    expect(replaced).toBe('## A\r\none\r\ntwo\r\n## B\r\nkeep');
  });

  it('gives an unchanged body back when replacing a section with its own content', () => {
    const body = '# T\n\n## A\nx\n\n## B\ny\n';

    expect(replaceSection(body, 'A', getSection(body, 'A')!)).toBe(body);
  });

  it('fills a section that has a heading but no content', () => {
    expect(replaceSection('## A\n\n## B\nx', 'A', 'filled')).toBe('## A\nfilled\n\n## B\nx');
  });

  it('fills a last section that is only a heading line', () => {
    expect(replaceSection('## A\nx\n## B', 'B', 'filled')).toBe('## A\nx\n## B\nfilled');
  });

  it('clears a section when the new content is empty', () => {
    expect(replaceSection('## A\nx\n\n## B\ny', 'A', '')).toBe('## A\n\n## B\ny');
  });
});

describe('appendSection', () => {
  it('creates the heading at the end when it does not exist yet', () => {
    expect(appendSection('# T\n## A\nx', 'Log', 'entry 1')).toBe('# T\n## A\nx\n\n## Log\nentry 1');
  });

  it('appends under an existing heading, after its current content', () => {
    expect(appendSection('# T\n## Log\nentry 1', 'Log', 'entry 2')).toBe('# T\n## Log\nentry 1\nentry 2');
  });

  it('appends before the blank line that separates the next section', () => {
    const body = '## Log\nentry 1\n\n## Next\nx';

    expect(appendSection(body, 'Log', 'entry 2')).toBe('## Log\nentry 1\nentry 2\n\n## Next\nx');
  });

  it('starts the content directly under a heading that is still empty', () => {
    expect(appendSection('## Log\n\n## Next\nx', 'Log', 'entry 1')).toBe('## Log\nentry 1\n\n## Next\nx');
  });

  it('appends to the first section when a heading appears twice', () => {
    const body = '## Log\nfirst\n## Log\nsecond';

    expect(appendSection(body, 'Log', 'more')).toBe('## Log\nfirst\nmore\n## Log\nsecond');
  });

  it('creates a missing section after a body that already ends with a blank line', () => {
    expect(appendSection('## A\nx\n\n', 'Log', 'entry')).toBe('## A\nx\n\n## Log\nentry');
  });

  it('creates a missing section in an empty body', () => {
    expect(appendSection('', 'Log', 'entry')).toBe('## Log\nentry');
  });

  it('keeps the CRLF line breaks of a CRLF body when creating and extending a section', () => {
    const created = appendSection('## A\r\nx', 'Log', 'one');
    const extended = appendSection(created, 'Log', 'two');

    expect(created).toBe('## A\r\nx\r\n\r\n## Log\r\none');
    expect(extended).toBe('## A\r\nx\r\n\r\n## Log\r\none\r\ntwo');
  });
});
