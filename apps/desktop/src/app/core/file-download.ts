import { InjectionToken } from '@angular/core';

export interface TextFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
}

/** Makes the browser save the text as a file, through a temporary link that is removed right after the click. */
export function downloadTextFile({ filename, mimeType, content }: TextFile): void {
  const address = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = address;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(address);
}

/** The way a screen saves a file; tests swap it for a recorder. */
export const FILE_DOWNLOAD = new InjectionToken<(file: TextFile) => void>('FILE_DOWNLOAD', { providedIn: 'root', factory: () => downloadTextFile });
