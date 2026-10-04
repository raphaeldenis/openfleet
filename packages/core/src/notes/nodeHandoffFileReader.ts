import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { HandoffFileSchema } from '@openfleet/shared';
import type { HandoffFileReader } from './handoffFileReader.js';

function safePath({ docsFolder, filePath }: { docsFolder: string; filePath: string }): string | undefined {
  try {
    const docsRoot = realpathSync(docsFolder);
    const handoffFolder = join(docsRoot, 'handoffs');
    const recordedFolder = dirname(resolve(filePath));
    const configuredHandoffFolder = join(resolve(docsFolder), 'handoffs');
    const isHandoffFolder = recordedFolder === handoffFolder || recordedFolder === configuredHandoffFolder;
    if (!isHandoffFolder || !HandoffFileSchema.safeParse(basename(filePath)).success) return undefined;
    const isLinkedFolder = lstatSync(handoffFolder).isSymbolicLink();
    const fileStat = lstatSync(filePath);
    const isHardlinkedFile = fileStat.nlink > 1;
    if (isLinkedFolder || fileStat.isSymbolicLink() || !fileStat.isFile() || isHardlinkedFile) return undefined;
    const actualPath = realpathSync(filePath);
    const relativePath = relative(handoffFolder, actualPath);
    const isOutsideHandoffs = relativePath.startsWith(`..${sep}`) || relativePath === '..' || dirname(actualPath) !== handoffFolder;
    return isOutsideHandoffs ? undefined : actualPath;
  } catch {
    return undefined;
  }
}

function read({ filePath, maxBytes }: { filePath: string; maxBytes: number }): { text: string; totalBytes: number } {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('handoff is not a regular file');
    const isHardlinkedFile = stat.nlink > 1;
    if (isHardlinkedFile) throw new Error('handoff has multiple links');
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const nextBytes = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (nextBytes === 0) break;
      bytesRead += nextBytes;
    }
    const text = new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead), { stream: bytesRead < stat.size });
    return { text, totalBytes: stat.size };
  } finally {
    closeSync(descriptor);
  }
}

export const nodeHandoffFileReader: HandoffFileReader = { safePath, read };
