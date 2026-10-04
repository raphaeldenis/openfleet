import {
  accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, watch, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DocsFolderFs } from './docsFolderFs.js';

const NEW_FILE_MODE = 0o644;

/** The real `node:fs` adapter for {@link DocsFolderFs} — not wired into main.ts by this task. */
export const nodeDocsFolderFs: DocsFolderFs = {
  readFileSync: (path) => readFileSync(path, 'utf8'),
  writeFileExclusiveSync: (path, contents) => writeFileDurably(path, contents),
  renameSync: (fromPath, toPath) => {
    renameSync(fromPath, toPath);
    flushDirectorySync(dirname(toPath));
  },
  unlinkSync: (path) => unlinkSync(path),
  existsSync: (path) => existsSync(path),
  mkdirSync: (path) => mkdirSync(path, { recursive: true }),
  realpathSync: (path) => realpathSync(path),
  isDirectorySync: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isWritableSync: (dirPath) => {
    try {
      accessSync(dirPath, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  listFilesSync: (dirPath) => {
    try {
      return readdirSync(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
  watch: (dirPath, onEvent) => {
    const watcher = watch(dirPath, { recursive: true }, (eventType, filename) => onEvent(eventType, filename));
    return () => watcher.close();
  },
};

/** Creates the file exclusively ('wx' — a planted symlink or existing file makes it fail) and fsyncs before returning. */
function writeFileDurably(path: string, contents: string): void {
  const descriptor = openSync(path, 'wx', NEW_FILE_MODE);
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDirectorySync(directoryPath: string): void {
  const descriptor = openSync(directoryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
