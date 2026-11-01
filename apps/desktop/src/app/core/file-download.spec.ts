import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from './file-download';

describe('downloadTextFile', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake');
  const revokeObjectURL = vi.fn();
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    clicked = [];
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  it('hands the browser a file of the given name and type to save', () => {
    downloadTextFile({ filename: 'log.csv', mimeType: 'text/csv', content: 'a,b' });

    const [link] = clicked;
    expect(link!.download).toBe('log.csv');
    expect(link!.href).toBe('blob:fake');
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(blob.size).toBe(3);
  });

  it('releases the temporary address and leaves no link behind', () => {
    downloadTextFile({ filename: 'log.json', mimeType: 'application/json', content: '[]' });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
