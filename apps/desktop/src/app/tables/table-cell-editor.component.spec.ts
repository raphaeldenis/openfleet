import { inputBinding, outputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { ColumnFormat, DsColumn } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { TableCellEditorComponent } from './table-cell-editor.component';

const column = (format: ColumnFormat): DsColumn => ({ id: 'field', storeId: 'store', displayName: 'Value', columnType: format === 'rank' ? 'number' : format === 'datetime' ? 'date' : 'text', format, sortOrder: 0, options: null });
async function openEditor(format: ColumnFormat, value: unknown = '') {
  const submitted = vi.fn();
  const cancelled = vi.fn();
  await render(TableCellEditorComponent, { bindings: [
    inputBinding('column', () => column(format)), inputBinding('initialValue', () => value), inputBinding('rowTitle', () => 'Task'),
    outputBinding('submitted', submitted), outputBinding('cancelled', cancelled),
  ] });
  const input = screen.getByLabelText('Value');
  await vi.waitFor(() => expect(input).toHaveFocus());
  return { input, submitted, cancelled };
}

describe('rich cell editor', () => {
  it('names the dialog, contains focus, cancels with Escape and preserves multiline input', async () => {
    const { input, submitted, cancelled } = await openEditor('longText', 'Original');
    expect(screen.getByRole('dialog', { name: 'Edit Value — Task' })).toBeVisible();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await userEvent.tab();
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, 'First{Enter}Second');
    expect(input).toHaveValue('First\nSecond');
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('saves textarea with Command+Enter and does not save during IME composition', async () => {
    const { input, submitted } = await openEditor('longText', 'Text');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(submitted).toHaveBeenCalledWith('Text');
  });

  it.each(['2026-10-06T03:09:10.123-05:00', '2026-10-06T08:09:10Z'])('keeps datetime precision and offset for %s', async (value) => {
    const { input, submitted } = await openEditor('datetime', value);
    expect(input).toHaveValue(value);
    expect(screen.getByText(/^Local time:/)).toBeVisible();
    await userEvent.keyboard('{Enter}');
    expect(submitted).toHaveBeenCalledWith(value);
  });

  it.each(['', '2026-02-30T08:00:00Z', '2026-13-06T08:00:00Z', '2026-10-06T08:00:00', '2026-10-06T25:00:00Z'])('refuses invalid datetime %s without losing input', async (value) => {
    const { input, submitted } = await openEditor('datetime', value);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(input).toHaveValue(value);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('ISO');
    expect(submitted).not.toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', 'file:///tmp/test', '/relative', 'no-url'])('refuses unsafe URL %s', async (value) => {
    const { input, submitted } = await openEditor('url', value);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP');
    expect(input).toHaveValue(value);
    expect(submitted).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/a', 'http://example.com', ''])('accepts web URL or empty text %s', async (value) => {
    const { submitted } = await openEditor('url', value);
    await userEvent.keyboard('{Enter}');
    expect(submitted).toHaveBeenCalledWith(value);
  });

  it.each([0, -2, 1.5])('saves finite rank %s as a number', async (value) => {
    const { submitted } = await openEditor('rank', value);
    await userEvent.keyboard('{Enter}');
    expect(submitted).toHaveBeenCalledWith(value);
  });

  it('refuses empty rank and clears explicitly to null', async () => {
    const { submitted } = await openEditor('rank');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('finite number');
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Clear value' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submitted).toHaveBeenCalledWith(null);
  });

  it('counts raw Unicode text in UTF-8 bytes', async () => {
    const { input, submitted } = await openEditor('longText', 'é'.repeat(32769));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('64 KiB');
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '  raw <script>{Enter}text  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submitted).toHaveBeenCalledWith('  raw <script>\ntext  ');
  });

  it('accepts Unicode text at the byte limit and empty long text', async () => {
    const value = 'é'.repeat(32768);
    const { input, submitted } = await openEditor('longText', value);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submitted).toHaveBeenLastCalledWith(value);
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submitted).toHaveBeenLastCalledWith('');
  });
});
