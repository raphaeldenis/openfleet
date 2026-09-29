import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteEditorComponent } from './note-editor.component';
import { aNoteView } from './notes.fixtures';
import type { NoteView } from '@openfleet/shared';

interface EditorOptions {
  note?: NoteView;
  historyOpen?: boolean;
}

async function renderEditor(options: EditorOptions = {}) {
  const historyToggle = vi.fn<() => void>();
  await render(NoteEditorComponent, {
    bindings: [
      inputBinding('note', () => options.note ?? aNoteView()),
      inputBinding('historyOpen', () => options.historyOpen ?? false),
      outputBinding<void>('historyToggle', historyToggle),
    ],
  });
  return { historyToggle };
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

  // Rendering ~2000 blocks in jsdom is slow when the machine is loaded; the default 5 s timeout flakes.
  describe('a note with thousands of blocks', { timeout: 30_000 }, () => {
    const bodyOfParagraphs = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join('\n\n');

    it('user sees the first blocks and can ask for the rest', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: bodyOfParagraphs(2100) }) });

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(2000);
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(2100);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('a single huge bullet list shows its first items and can be expanded', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '- x\n'.repeat(2500) }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(1999);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (501 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(2500);
    });

    it('a single paragraph made of thousands of inline code spans shows the first spans and can be expanded', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'a`b`'.repeat(2500) }) });

      expect(screen.getAllByTestId('note-editor-inline-code')).toHaveLength(1999);
      expect(screen.getByTestId('note-editor-show-rest')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-inline-code')).toHaveLength(2500);
    });

    it('a paragraph of thousands of empty code spans between plain words reads as one run of text', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'a``'.repeat(2500) }) });

      expect(screen.getByTestId('note-editor-paragraph')).toHaveTextContent(new RegExp(`^${'a'.repeat(2500)}$`));
      expect(screen.queryByTestId('note-editor-inline-code')).not.toBeInTheDocument();
    });

    it('a list item holding only a code chip is not shown as an empty bullet when the limit cuts it', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: `${bodyOfParagraphs(1998)}\n\n- \`x\`\n- y` }) });

      expect(screen.queryAllByTestId('note-editor-list-item')).toHaveLength(0);
      expect(screen.getByTestId('note-editor-show-rest')).toBeInTheDocument();
    });

    it('list items and paragraphs share one budget', async () => {
      const bodyMd = `${'- x\n'.repeat(1500)}\n${bodyOfParagraphs(1000)}`;

      await renderEditor({ note: aNoteView({ bodyMd }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(1500);
      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(499);
    });

    it('user reveals a very long list a chunk at a time, the button counting what remains', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '- x\n'.repeat(4500) }) });

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(1999);
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(3999);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (501 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(4500);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('user reveals the lines of a very long code fence a chunk at a time', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: `\`\`\`\n${'x\n'.repeat(2500)}\`\`\`` }) });

      const linesShown = () => screen.getByTestId('note-editor-code-block').textContent!.split('\n').length;
      expect(linesShown()).toBe(1999);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the rest (501 more items)');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(linesShown()).toBe(2500);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('a note within the limit offers nothing to expand', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: bodyOfParagraphs(2000) }) });

      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });
  });
});
