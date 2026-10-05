import { screen, within } from '@testing-library/angular/zoneless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Markdown shaped like the importer's output for Scape notes: GFM pipe tables, padded rows, escaped pipes and `<br>` line breaks. */
export const IMPORTED_NOTE_MARKDOWN = [
  'Intro line right above a table',
  '| Name | Role |',
  '| --- | --- |',
  '| Ada | **Dev** |',
  '',
  '| Item | Qty | Price |',
  '| :--- | :---: | ---: |',
  '| Pen | 2 | 1.50 |',
  '',
  '| Expression | Details |',
  '| --- | --- |',
  '| a \\| b | first<br>second |',
  '',
  '| One | Two | Three |',
  '| --- | --- | --- |',
  '| lonely |',
  '',
  '```',
  '| Fenced | Stays |',
  '| --- | --- |',
  '| plain | code |',
  '```',
  '',
  '| Hostile |',
  '| --- |',
  '| <script>window.__pwned=1</script><br><img src=x onerror="window.__pwned=1"> |',
].join('\n');

const tableWithHeader = (name: string): HTMLElement => {
  const table = screen.getAllByRole('table').find((candidate) => within(candidate).queryByRole('columnheader', { name }));
  if (!table) throw new Error(`No rendered table has a column header named "${name}"`);
  return table;
};

const pwned = () => (window as unknown as { __pwned?: number }).__pwned;

/** Registers the table-rendering behaviours every Markdown surface must show; `renderMarkdown` mounts the surface with the body. */
export function itRendersImportedMarkdownTables(renderMarkdown: (markdown: string) => Promise<void>): void {
  describe('GFM tables of imported Markdown', () => {
    beforeEach(async () => {
      await renderMarkdown(IMPORTED_NOTE_MARKDOWN);
    });
    afterEach(() => {
      delete (window as unknown as { __pwned?: number }).__pwned;
    });

    it('shows each pipe table as a table and keeps the fenced one as code', () => {
      expect(screen.getAllByRole('table')).toHaveLength(5);
      expect(screen.queryByRole('columnheader', { name: 'Fenced' })).not.toBeInTheDocument();
      expect(screen.getByText(/\| Fenced \| Stays \|/)).toBeInTheDocument();
    });

    it('shows a table that directly follows a paragraph', () => {
      expect(screen.getByText('Intro line right above a table')).toBeInTheDocument();
      expect(within(tableWithHeader('Name')).getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    });

    it('marks header cells as column headers and formats the inline bold of a cell', () => {
      const table = tableWithHeader('Name');

      expect(within(table).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual(['Name', 'Role']);
      expect(within(table).getAllByRole('columnheader')[0]).toHaveAttribute('scope', 'col');
      expect(within(within(table).getByRole('cell', { name: 'Dev' })).getByText('Dev').tagName).toBe('STRONG');
    });

    it('aligns the columns as the delimiter row says', () => {
      const table = tableWithHeader('Item');
      const [item, quantity, price] = within(table).getAllByRole('cell');

      expect(item).toHaveStyle({ textAlign: 'left' });
      expect(quantity).toHaveStyle({ textAlign: 'center' });
      expect(price).toHaveStyle({ textAlign: 'right' });
    });

    it('shows an escaped pipe as a pipe and a <br> as a line break', () => {
      const [escapedPipeCell, lineBreakCell] = within(tableWithHeader('Expression')).getAllByRole('cell');

      expect(escapedPipeCell).toHaveTextContent('a | b');
      expect(lineBreakCell!.querySelectorAll('br')).toHaveLength(1);
      expect(lineBreakCell).toHaveTextContent('first second');
    });

    it('pads a short row to the header width', () => {
      const table = tableWithHeader('One');

      expect(within(table).getAllByRole('cell')).toHaveLength(3);
      expect(within(table).getByRole('cell', { name: 'lonely' })).toBeInTheDocument();
    });

    it('lets a wide table scroll inside a keyboard-reachable region', () => {
      const region = screen.getByRole('region', { name: 'Table: Name, Role' });

      expect(region).toHaveAttribute('tabindex', '0');
      expect(within(region).getByRole('table')).toBe(tableWithHeader('Name'));
    });

    it('keeps hostile HTML in a cell inert and shows it as text', () => {
      const cell = within(tableWithHeader('Hostile')).getByRole('cell');

      expect(cell).toHaveTextContent('<script>window.__pwned=1</script>');
      expect(cell).toHaveTextContent('<img src=x onerror="window.__pwned=1">');
      expect(cell.querySelectorAll('img, script')).toHaveLength(0);
      expect(cell.querySelectorAll('br')).toHaveLength(1);
      expect(pwned()).toBeUndefined();
    });
  });
}
