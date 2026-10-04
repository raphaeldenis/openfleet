export interface HandoffFileReader {
  safePath(input: { docsFolder: string; filePath: string }): string | undefined;
  read(input: { filePath: string; maxBytes: number }): { text: string; totalBytes: number };
}
