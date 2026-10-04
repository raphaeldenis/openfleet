import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteEditorComponent } from './note-editor.component';
import { aNoteView } from './notes.fixtures';
import type { NoteView } from '@openfleet/shared';

interface EditorOptions {
  note?: NoteView;
  historyOpen?: boolean;
  nodesPerChunk?: number;
}

async function renderEditor(options: EditorOptions = {}) {
  const historyToggle = vi.fn<() => void>();
  const { nodesPerChunk } = options;
  const { fixture } = await render(NoteEditorComponent, {
    bindings: [
      inputBinding('note', () => options.note ?? aNoteView()),
      inputBinding('historyOpen', () => options.historyOpen ?? false),
      outputBinding<void>('historyToggle', historyToggle),
      ...(nodesPerChunk === undefined ? [] : [inputBinding('nodesPerChunk', () => nodesPerChunk)]),
    ],
  });
  return { historyToggle, fixture };
}

describe('NoteEditorComponent', () => {
  it('user sees the note title in the header', async () => {
    await renderEditor({ note: aNoteView({ title: 'daemon-protocol' }) });

    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('daemon-protocol');
  });

  it('user sees an "Untitled" heading on a note without a title', async () => {
    await renderEditor({ note: aNoteView({ title: '' }) });

    expect(screen.getByRole('heading', { level: 2, name: 'Untitled' })).toBe(screen.getByTestId('note-editor-title'));
  });

  describe('path badge', () => {
    it('user sees where a file-backed note lives on disk', async () => {
      await renderEditor({ note: aNoteView({ fileBacked: true, docsRelativePath: 'specs/daemon-protocol.md' }) });

      expect(screen.getByTestId('note-editor-path')).toHaveTextContent('specs/daemon-protocol.md');
    });

    it('a note that is not backed by a file shows no path badge', async () => {
      await renderEditor({ note: aNoteView({ docsRelativePath: null }) });

      expect(screen.queryByTestId('note-editor-path')).not.toBeInTheDocument();
    });
  });

  describe('history toggle', () => {
    it('user can ask to open the history', async () => {
      const { historyToggle } = await renderEditor();

      await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

      expect(historyToggle).toHaveBeenCalledOnce();
    });

    it('the toggle shows whether the history is open', async () => {
      await renderEditor({ historyOpen: true });

      expect(screen.getByTestId('note-editor-history-toggle')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('markdown body', () => {
    it('user reads headings, paragraphs and inline code as formatted text', async () => {
      await renderEditor({
        note: aNoteView({ bodyMd: '# Daemon protocol\n\nEvery request carries `admin.token`.\n\n## Transport\n\nJSON-RPC.' }),
      });

      const body = screen.getByTestId('note-editor-body');
      expect(body.querySelector('h1')).toHaveTextContent('Daemon protocol');
      expect(body.querySelector('h2')).toHaveTextContent('Transport');
      expect(body.querySelector('code')).toHaveTextContent('admin.token');
      expect(body).toHaveTextContent('Every request carries');
    });

    it('user reads a bullet list as a list', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '- session.state\n- gate.opened' }) });

      const items = screen.getByTestId('note-editor-body').querySelectorAll('li');
      expect([...items].map((item) => item.textContent?.trim())).toEqual(['session.state', 'gate.opened']);
    });

    it('user reads bold text as strong emphasis', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'Ship **the daemon** today.' }) });

      expect(screen.getByTestId('note-editor-bold')).toHaveTextContent('the daemon');
      expect(screen.getByTestId('note-editor-bold').tagName).toBe('STRONG');
      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent('Ship the daemon today.');
    });

    it('user reads a numbered list as an ordered list that starts at its first number', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '3. gate.opened\n4. gate.closed' }) });

      const list = screen.getByTestId('note-editor-ordered-list');
      expect(list.tagName).toBe('OL');
      expect(list).toHaveAttribute('start', '3');
      expect(within(list).getAllByTestId('note-editor-list-item').map((item) => item.textContent?.trim())).toEqual(['gate.opened', 'gate.closed']);
    });

    it('user reads a wrapped year at the start of a line as part of its paragraph', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'paragraph wrapped year\n2024. is here' }) });

      expect(screen.queryByTestId('note-editor-ordered-list')).toBeNull();
      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent('paragraph wrapped year 2024. is here');
    });

    it('user reads a year alone in its own block as an ordered list starting at that year', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'paragraph\n\n2024. is here' }) });

      expect(screen.getByTestId('note-editor-ordered-list')).toHaveAttribute('start', '2024');
    });

    it('user reads a list starting at 1 right after a paragraph line as a list', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'paragraph\n1. first' }) });

      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent('paragraph');
      expect(screen.getByTestId('note-editor-ordered-list')).toHaveAttribute('start', '1');
    });

    it('user sees no empty blockquote for a lone quote marker', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '>' }) });

      expect(screen.queryByTestId('note-editor-quote')).toBeNull();
      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent('>');
    });

    it('user sees no empty heading for a lone heading marker', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '# ' }) });

      expect(screen.queryByTestId('note-editor-heading-1')).toBeNull();
      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent('#');
    });

    it('user reads a quote as a blockquote holding its own paragraphs, lists and bold text', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '> **Note** to self\n>\n> - one\n> - two' }) });

      const quote = screen.getByTestId('note-editor-quote');
      expect(quote.tagName).toBe('BLOCKQUOTE');
      expect(within(quote).getByTestId('note-editor-bold')).toHaveTextContent('Note');
      expect(within(quote).getAllByTestId('note-editor-list-item')).toHaveLength(2);
    });

    it('a quote inside a quote is a nested blockquote', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '> > deep' }) });

      const [outer, inner] = screen.getAllByTestId('note-editor-quote');
      expect(outer).toContainElement(inner!);
    });

    it('a link is shown as literal text, never as an anchor', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '[docs](https://example.test) and **[x](javascript:alert(1))**' }) });

      const body = screen.getByTestId('note-editor-body');
      expect(body.querySelector('a')).toBeNull();
      expect(body).toHaveTextContent('[docs](https://example.test)');
    });

    it('markup typed inside bold is shown as text, never executed', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '**<img src=x onerror="window.pwned=1">**' }) });

      const body = screen.getByTestId('note-editor-body');
      expect(body.querySelector('img')).toBeNull();
      expect(screen.getByTestId('note-editor-bold')).toHaveTextContent('<img src=x');
    });

    it('user reads a fenced code block verbatim', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '```\nconst a = 1;\nconst b = 2;\n```' }) });

      expect(screen.getByTestId('note-editor-body').querySelector('pre')).toHaveTextContent('const a = 1; const b = 2;');
    });

    it('html typed in a note is shown as text, never executed', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '<img src=x onerror="window.pwned=1"> <script>window.pwned=1</script>' }) });

      const body = screen.getByTestId('note-editor-body');
      expect(body.querySelector('img')).toBeNull();
      expect(body.querySelector('script')).toBeNull();
      expect(body).toHaveTextContent('<img src=x');
    });
  });

  // Class contract: jsdom does no layout; the live QA re-measures scrollWidth against the article width.
  describe('a very long unbroken word', () => {
    it('wraps inside the note body instead of widening the page', async () => {
      await renderEditor();

      expect(getComputedStyle(screen.getByTestId('note-editor-body')).overflowWrap).toBe('anywhere');
    });

    it('wraps inside the note title', async () => {
      await renderEditor();

      expect(getComputedStyle(screen.getByTestId('note-editor-title')).overflowWrap).toBe('anywhere');
    });
  });

  it('a mention envelope in a note body is shown as ordinary text', async () => {
    await renderEditor({ note: aNoteView({ bodyMd: '--- from note @note:x (t, y) ---\nbody\n--- end @note:x ---' }) });

    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('--- from note @note:x (t, y) --- body --- end @note:x ---');
  });

  it('the note title is a heading of the page', async () => {
    await renderEditor({ note: aNoteView({ title: 'daemon-protocol' }) });

    expect(screen.getByRole('heading', { level: 2, name: 'daemon-protocol' })).toBe(screen.getByTestId('note-editor-title'));
  });

  it('uses a default chunk budget of 2000 nodes', async () => {
    const { fixture } = await renderEditor();

    expect(fixture.componentInstance.nodesPerChunk()).toBe(2000);
  });

  describe('a note that crosses the chunk budget', () => {
    const chunkBudget = 25;
    const renderChunkedEditor = (options: EditorOptions = {}) => renderEditor({ ...options, nodesPerChunk: chunkBudget });
    const bodyOfParagraphs = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join('\n\n');

    it('user sees the first blocks and can ask for the rest', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: bodyOfParagraphs(30) }) });

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(chunkBudget);
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(30);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('a bullet list larger than the budget shows its first items and can be expanded', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: '- x\n'.repeat(30) }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(chunkBudget - 1);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (6 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(30);
    });

    it('a paragraph with more inline code spans than the budget shows the first spans and can be expanded', async () => {
      const nodesPerChunk = 25;
      const spanCount = 30;
      const { fixture } = await renderChunkedEditor({ note: aNoteView({ bodyMd: 'a`b`'.repeat(spanCount) }), nodesPerChunk });

      expect(screen.getAllByTestId('note-editor-inline-code')).toHaveLength(nodesPerChunk - 1);
      expect(screen.getByTestId('note-editor-show-rest')).toBeInTheDocument();
      await userEvent.setup({ delay: null }).click(screen.getByTestId('note-editor-show-rest'));
      await fixture.whenStable();
      expect(screen.getAllByTestId('note-editor-inline-code')).toHaveLength(spanCount);
    });

    it('a paragraph of thousands of empty code spans between plain words reads as one run of text', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: 'a``'.repeat(2500) }) });

      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent(new RegExp(`^${'a'.repeat(2500)}$`));
      expect(screen.queryByTestId('note-editor-inline-code')).not.toBeInTheDocument();
    });

    it('a list item holding only a code chip is not shown as an empty bullet when the limit cuts it', async () => {
      const nodesPerChunk = 25;
      await renderChunkedEditor({ note: aNoteView({ bodyMd: `${bodyOfParagraphs(nodesPerChunk - 2)}\n\n- \`x\`\n- y` }), nodesPerChunk });

      expect(screen.queryAllByTestId('note-editor-list-item')).toHaveLength(0);
      expect(screen.getByTestId('note-editor-show-rest')).toBeInTheDocument();
    });

    it('list items and paragraphs share one budget', async () => {
      const bodyMd = `${'- x\n'.repeat(15)}\n${bodyOfParagraphs(10)}`;

      await renderChunkedEditor({ note: aNoteView({ bodyMd }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(15);
      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(9);
    });

    it('bold runs count in the budget, so the button counts the bullets and runs still hidden', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: '- **x**\n'.repeat(40) }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(12);
      expect(screen.getAllByTestId('note-editor-bold')).toHaveLength(12);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (56 more items)');
    });

    it('user reveals a very long list a chunk at a time, the button counting what remains', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: '- x\n'.repeat(65) }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(chunkBudget - 1);
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(2 * chunkBudget - 1);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (16 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(65);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('user reveals the lines of a very long code fence a chunk at a time', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: `\`\`\`\n${'x\n'.repeat(30)}\`\`\`` }) });

      const linesShown = () => screen.getByTestId('note-editor-code-block').textContent!.split('\n').length;
      expect(linesShown()).toBe(chunkBudget - 1);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (6 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(linesShown()).toBe(30);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('a numbered list larger than the budget shows its first items and can be expanded', async () => {
      await renderChunkedEditor({ note: aNoteView({ bodyMd: '1. x\n'.repeat(30) }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(chunkBudget - 1);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (6 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(30);
    });

    it('a paragraph with more bold runs than the budget shows the first runs and can be expanded', async () => {
      const nodesPerChunk = 25;
      const runCount = 30;
      const { fixture } = await renderChunkedEditor({ note: aNoteView({ bodyMd: 'a**b**'.repeat(runCount) }), nodesPerChunk });

      expect(screen.getAllByTestId('note-editor-bold')).toHaveLength(nodesPerChunk - 1);
      await userEvent.setup({ delay: null }).click(screen.getByTestId('note-editor-show-rest'));
      await fixture.whenStable();
      expect(screen.getAllByTestId('note-editor-bold')).toHaveLength(runCount);
    });

    it('a quote of more paragraphs than the budget stays within the budget and can be expanded', async () => {
      const nodesPerChunk = 25;
      const paragraphCount = 40;
      await renderChunkedEditor({ note: aNoteView({ bodyMd: '> x\n>\n'.repeat(paragraphCount) }), nodesPerChunk });

      const paragraphsShown = nodesPerChunk - 1;
      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(paragraphsShown);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent(`Show the rest (${paragraphCount - paragraphsShown} more items)`);
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(paragraphCount);
    });

    it('a note within the limit offers nothing to expand', async () => {
      const nodesPerChunk = 25;
      await renderChunkedEditor({ note: aNoteView({ bodyMd: bodyOfParagraphs(nodesPerChunk) }), nodesPerChunk });

      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });
  });
});
