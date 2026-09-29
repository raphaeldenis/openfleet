import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteEditorComponent, type NoteMentioner } from './note-editor.component';
import { aNoteView } from './notes.fixtures';
import type { NoteView } from '@openfleet/shared';

interface EditorOptions {
  note?: NoteView;
  expandedBody?: string;
  mentionedBy?: NoteMentioner[];
  historyOpen?: boolean;
}

async function renderEditor(options: EditorOptions = {}) {
  const historyToggle = vi.fn<() => void>();
  await render(NoteEditorComponent, {
    bindings: [
      inputBinding('note', () => options.note ?? aNoteView()),
      inputBinding('expandedBody', () => options.expandedBody),
      inputBinding('mentionedBy', () => options.mentionedBy ?? []),
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

  describe('mentions', () => {
    const expandedBody = [
      'See @note:other for details.',
      '--- from note @note:other (Other note, project-1) ---\nThe other note says hello.\n--- end @note:other ---',
      '--- @table:tasks → table "Tasks" — query_data_store ---',
      '--- @note:gone → not resolved (not available yet) ---',
    ].join('\n\n');

    it('user reads a mentioned note as its own block inside the document', async () => {
      await renderEditor({ expandedBody });

      const block = screen.getByTestId('note-editor-mention-note-other');
      expect(block).toHaveTextContent('Other note');
      expect(block).toHaveTextContent('The other note says hello.');
    });

    it('user sees a mentioned table or repo as a pointer line', async () => {
      await renderEditor({ expandedBody });

      expect(screen.getByTestId('note-editor-mention-table-tasks')).toHaveTextContent('Tasks');
    });

    it('user is told when a mention could not be resolved', async () => {
      await renderEditor({ expandedBody });

      expect(screen.getByTestId('note-editor-mention-note-gone')).toHaveTextContent('not resolved');
    });

    it('the note body is shown when no expanded body is supplied', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: 'Plain body text.' }), expandedBody: undefined });

      expect(screen.getByTestId('note-editor-body')).toHaveTextContent('Plain body text.');
    });
  });

  describe('"Mentioned by" footer', () => {
    it('user sees who mentions the note when that data is supplied', async () => {
      await renderEditor({ mentionedBy: [{ emoji: '🦉', name: 'Argus' }, { emoji: '🪵', name: 'Nori' }] });

      const footer = screen.getByTestId('note-editor-mentioned-by');
      expect(footer).toHaveTextContent('Mentioned by');
      expect(footer).toHaveTextContent('🦉 Argus');
      expect(footer).toHaveTextContent('🪵 Nori');
    });

    it('nothing is invented when no backlink data is supplied', async () => {
      await renderEditor({ mentionedBy: [] });

      expect(screen.queryByTestId('note-editor-mentioned-by')).not.toBeInTheDocument();
    });
  });

  it('the note title is a heading of the page', async () => {
    await renderEditor({ note: aNoteView({ title: 'daemon-protocol' }) });

    expect(screen.getByRole('heading', { level: 2, name: 'daemon-protocol' })).toBe(screen.getByTestId('note-editor-title'));
  });

  describe('a note with thousands of blocks', () => {
    const bodyOfParagraphs = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join('\n\n');

    it('user sees the first blocks and can ask for the rest', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: bodyOfParagraphs(2500) }) });

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(2000);
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(2500);
      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });

    it('an unclosed mention marker never lets its content escape the limit', async () => {
      const bodyMd = `--- from note @note:x (t, y) ---\n${bodyOfParagraphs(2500)}`;

      await renderEditor({ note: aNoteView({ bodyMd }) });

      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(1999);
      expect(screen.getByTestId('note-editor-show-rest')).toHaveTextContent('Show the remaining 501 blocks');
      await userEvent.click(screen.getByTestId('note-editor-show-rest'));
      expect(screen.getAllByTestId('note-editor-paragraph')).toHaveLength(2500);
    });

    it('a marker naming something that is not a mentionable kind stays plain text', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: '--- from note @evil:x (t, y) ---\nbody' }) });

      expect(screen.queryByTestId('note-editor-mention-evil-x')).not.toBeInTheDocument();
      expect(screen.getByTestId('note-editor-body')).toHaveTextContent('--- from note @evil:x (t, y) --- body');
    });

    it('a note within the limit offers nothing to expand', async () => {
      await renderEditor({ note: aNoteView({ bodyMd: bodyOfParagraphs(2000) }) });

      expect(screen.queryByTestId('note-editor-show-rest')).not.toBeInTheDocument();
    });
  });
});
