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

  it('accepts up to three leading spaces before the hashes and rejects four', () => {
    const body = '   ## Indented\nx\n    ## Code\ny';

    const headings = listSections(body).map((section) => section.heading);

    expect(headings).toEqual(['Indented']);
  });

  it('drops closing hashes from the title but keeps a hash glued to the text', () => {
    const body = '## A ##\nx\n## C#\ny\n## D   #  \nz';

    const headings = listSections(body).map((section) => section.heading);

    expect(headings).toEqual(['A', 'C#', 'D']);
  });

  it('ignores a leading byte order mark when matching the first heading', () => {
    const sections = listSections('\uFEFF## First\nx');

    expect(sections).toEqual([{ heading: 'First', level: 2, startLine: 0, endLine: 1 }]);
  });

  it('parses a 40 KB heading line with a long whitespace run in linear time', () => {
    const body = `## a${' '.repeat(40_000)}b`;

    const elapsed = millisecondsToRun(() => listSections(body));

    expect(elapsed).toBeLessThan(50);
  });

  it('parses 100 000 sections in linear time', () => {
    const sectionCount = 100_000;
    const body = Array.from({ length: sectionCount }, (_, index) => `## S${index}\ntext`).join('\n');

    let sections: unknown[] = [];
    const elapsed = millisecondsToRun(() => { sections = listSections(body); });

    expect(sections).toHaveLength(sectionCount);
    expect(elapsed).toBeLessThan(1000);
  });

  it('parses 100 000 lines of unclosed backtick and tilde fences in linear time', () => {
    const lineCount = 100_000;
    const repeatedLines = ['```js', '~~~js', 'text'];
    const body = ['## A', ...Array.from({ length: lineCount }, (_, index) => repeatedLines[index % repeatedLines.length])].join('\n');

    let sections: unknown[] = [];
    const elapsed = millisecondsToRun(() => { sections = listSections(body); });

    expect(sections).toHaveLength(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it('sees a heading that sits between two fenced blocks using the same fence character', () => {
    const body = '## A\n```\nx\n```\n## R\n```\ny\n```';

    const headings = listSections(body).map((section) => section.heading);

    expect(headings).toEqual(['A', 'R']);
  });

  it('treats a bare "##" line as a heading with an empty title', () => {
    const body = '##\nx\n## Next\ny';

    const headings = listSections(body).map((section) => section.heading);

    expect(headings).toEqual(['', 'Next']);
  });

  it('accepts a tab between the hashes and the title', () => {
    const sections = listSections('##\tTitle\nx');

    expect(sections).toEqual([{ heading: 'Title', level: 2, startLine: 0, endLine: 1 }]);
  });
});

function millisecondsToRun(work: () => void): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

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

  it('drops a whitespace-only line before the next heading', () => {
    const body = '## A\nx\n   \n## B\ny';

    expect(getSection(body, 'A')).toBe('x');
  });

  it('finds a heading whatever the Unicode normalization form on either side', () => {
    const decomposed = '## Café\nx';
    const composed = '## Café\ny';

    expect(getSection(decomposed, 'Café')).toBe('x');
    expect(getSection(composed, 'Café')).toBe('y');
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

  it('keeps a whitespace-only line that precedes the next heading', () => {
    expect(replaceSection('## A\nx\n   \n## B\ny', 'A', 'z')).toBe('## A\nz\n   \n## B\ny');
  });

  it('gives a mixed CRLF/LF body back unchanged when replacing a section with its own content', () => {
    const body = '## A\r\none\ntwo\r\n\r\n## B\r\nx\ny\n';

    expect(replaceSection(body, 'A', getSection(body, 'A')!)).toBe(body);
    expect(replaceSection(body, 'B', getSection(body, 'B')!)).toBe(body);
  });

  it('keeps the byte order mark in front of the first heading', () => {
    expect(replaceSection('\uFEFF## A\nold\n## B\nkeep', 'A', 'new')).toBe('\uFEFF## A\nnew\n## B\nkeep');
  });

  describe('fences that only look like fences', () => {
    const sectionB = '## B\nkeep me';

    it.each([
      ['a list-prefixed fence with an indented closer', `## A\n- \`\`\`\n  ## fake\n  \`\`\`\n${sectionB}`],
      ['an ordered-list fence with an info string', `## A\n1. \`\`\`js\n  ## fake\n  \`\`\`\n${sectionB}`],
      ['a fence that never closes', `## A\n\`\`\`\ntext\n${sectionB}`],
      ['a tilde fence that never closes', `## A\n~~~\ntext\n${sectionB}`],
      ['a closer with trailing spaces', `## A\n\`\`\`\ntext\n\`\`\`   \n${sectionB}`],
    ])('keeps the next section intact with %s', (_name, body) => {
      const replaced = replaceSection(body, 'A', 'replacement');

      expect(replaced.endsWith(sectionB)).toBe(true);
      expect(getSection(replaced, 'B')).toBe('keep me');
    });

    it.each([
      ['a tilde line inside a backtick fence', `## A\n\`\`\`\n~~~\n## fake\n\`\`\`\n${sectionB}`],
      ['a triple-backtick line inside a four-backtick fence', `## A\n\`\`\`\`\n\`\`\`\n## fake\n\`\`\`\n\`\`\`\`\n${sectionB}`],
      ['an info-string line that cannot close a fence', `## A\n\`\`\`\n## fake\n\`\`\`js\n## fake too\n\`\`\`\n${sectionB}`],
    ])('keeps a real fence open across %s', (_name, body) => {
      const replaced = replaceSection(body, 'A', 'replacement');

      expect(replaced).toBe(`## A\nreplacement\n${sectionB}`);
    });

    // A four-space indent (past the 0-3 allowed by FENCE_PATTERN) and a backtick-in-info span
    // (which canOpen must reject) never open a fence, so on their own they don't prove anything:
    // with no later closer downstream, an implementation that wrongly treated them as openers
    // would behave identically to a correct one (nothing to pair with either way). Each case
    // below adds a real downstream closer and a heading in between, so a wrongly-permissive
    // opener would swallow that heading and the assertion would fail.
    it('does not let a four-space-indented line open a fence, even with a later real closer', () => {
      const body = '## A\n    ```\n## R\nkept\n```\n## B\nkeep me';

      const replaced = replaceSection(body, 'A', 'replacement');

      expect(replaced).toBe('## A\nreplacement\n## R\nkept\n```\n## B\nkeep me');
    });

    it('does not let an inline triple-backtick span open a fence, even with a later real closer', () => {
      const body = '## A\n```x``` is inline\n## R\nkept\n```\n## B\nkeep me';

      const replaced = replaceSection(body, 'A', 'replacement');

      expect(replaced).toBe('## A\nreplacement\n## R\nkept\n```\n## B\nkeep me');
    });
  });

  describe('structure invariant', () => {
    const body = '## A\nold\n## B\n```\ncode\n```';

    it.each([
      ['content that repeats the heading', 'text\n## A\nmore'],
      ['content that contains another heading', 'text\n## B\nmore'],
      ['content that opens a fence swallowing the next heading', '```js\ntext'],
    ])('refuses %s', (_name, content) => {
      const replaceWithContent = () => replaceSection(body, 'A', content);

      expect(replaceWithContent).toThrow('content would change the section structure');
    });

    it.each(['', '   ', 'New\n## Injected'])('refuses the heading %j', (heading) => {
      const replaceUnderHeading = () => replaceSection(body, heading, 'x');

      expect(replaceUnderHeading).toThrow();
    });

    it('rejects a heading argument ending in closing #s with a clear message', () => {
      const replaceUnderClosedHeading = () => replaceSection(body, 'Log ##', 'x');

      expect(replaceUnderClosedHeading).toThrow(/closing #s/);
    });

    it('rejects a heading argument made only of #s with a clear message', () => {
      const replaceUnderHashOnlyHeading = () => replaceSection(body, '###', 'x');

      expect(replaceUnderHashOnlyHeading).toThrow(/closing #s/);
    });

    it('refuses content that introduces a level-1 heading', () => {
      const introducesLevelOneHeading = () => replaceSection(body, 'A', 'text\n# top\nmore');

      expect(introducesLevelOneHeading).toThrow('content would change the section structure');
    });

    it('refuses content that restates a following heading hidden inside a fence, leaving the body unchanged', () => {
      const bodyWithFencedSibling = '## A\nold\n## B\n```\nvaluable\n```';

      const replaceWithHiddenHeading = () => replaceSection(bodyWithFencedSibling, 'A', '## B\nimpostor\n```');

      expect(replaceWithHiddenHeading).toThrow('content would change the section structure');
      expect(getSection(bodyWithFencedSibling, 'B')).toBe('```\nvaluable\n```');
    });

    it('refuses content that shifts a fence boundary and swaps a real heading for one nested inside a former fence', () => {
      const bodyWithNestedHeading = '## A\nx\n## B\ny\n```\n## B\n```\n## C\nz';

      const replaceThatShiftsFenceBoundary = () => replaceSection(bodyWithNestedHeading, 'A', '```');

      expect(replaceThatShiftsFenceBoundary).toThrow('content would change the section structure');
    });
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

  it('leaves every existing byte of a mixed CRLF/LF body untouched and writes the new line with the first line break', () => {
    const body = '## A\r\none\ntwo\r\n## B\r\nx\ny';

    const appended = appendSection(body, 'A', 'three');

    expect(appended).toBe('## A\r\none\ntwo\r\nthree\r\n## B\r\nx\ny');
  });

  it('trims the heading of the section it creates', () => {
    expect(appendSection('## A\nx', '  Log ', 'entry')).toBe('## A\nx\n\n## Log\nentry');
  });

  it('keeps the final line break of a body that ends with one', () => {
    expect(appendSection('## Log\nentry 1\n', 'Log', 'entry 2')).toBe('## Log\nentry 1\nentry 2\n');
  });

  it('returns the body unchanged when appended content is empty', () => {
    const body = '## A\nx\n## B\ny';

    expect(appendSection(body, 'A', '')).toBe(body);
  });

  it('writes multi-line appended content with the line breaks of a CRLF body', () => {
    const body = '## A\r\nold\r\n## B\r\nkeep';

    const appended = appendSection(body, 'A', 'one\ntwo');

    expect(appended).toBe('## A\r\nold\r\none\r\ntwo\r\n## B\r\nkeep');
  });

  describe('structure invariant', () => {
    const body = '## A\nold\n## B\n```\ncode\n```';

    it.each([
      ['content that repeats the heading', 'A', 'text\n## A\nmore'],
      ['content that contains another heading', 'A', 'text\n## B\nmore'],
      ['content that opens a fence swallowing the next heading', 'A', '```js\ntext'],
      ['content that adds a heading to a new section', 'Log', 'entry\n## Extra'],
    ])('refuses %s', (_name, heading, content) => {
      const appendContent = () => appendSection(body, heading, content);

      expect(appendContent).toThrow('content would change the section structure');
    });

    it.each(['', '   ', 'New\n## Injected'])('refuses the heading %j', (heading) => {
      const appendUnderHeading = () => appendSection(body, heading, 'x');

      expect(appendUnderHeading).toThrow();
    });

    it('rejects a heading argument ending in closing #s with a clear message', () => {
      const appendUnderClosedHeading = () => appendSection(body, 'Log ##', 'x');

      expect(appendUnderClosedHeading).toThrow(/closing #s/);
    });

    it('rejects a heading argument made only of #s with a clear message', () => {
      const appendUnderHashOnlyHeading = () => appendSection(body, '###', 'x');

      expect(appendUnderHashOnlyHeading).toThrow(/closing #s/);
    });

    it('refuses content that restates a following heading hidden inside a fence, leaving the body unchanged', () => {
      const bodyWithFencedSibling = '## A\nold\n## B\n```\nvaluable\n```';

      const appendWithHiddenHeading = () => appendSection(bodyWithFencedSibling, 'A', '## B\nimpostor\n```');

      expect(appendWithHiddenHeading).toThrow('content would change the section structure');
      expect(getSection(bodyWithFencedSibling, 'B')).toBe('```\nvaluable\n```');
    });

    it('refuses new-section content that hides a fake heading and heading inside a fence that swallows the real ones', () => {
      const bodyWithUnclosedFence = '## A\n```\n## B\nkeep';

      const appendThatHidesRealHeadings = () => appendSection(bodyWithUnclosedFence, 'Log', '```\n## B\nfake\n## Log\nentry');

      expect(appendThatHidesRealHeadings).toThrow('content would change the section structure');
    });
  });
});
