import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { OpenFleetError, type DocsRootView } from '@openfleet/shared';
import * as z from 'zod';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';
import { updateConfigFile } from '../models.js';
import { DocsFolderNotWritableError, InvalidDocsFolderError } from './docsFolderService.js';

const DEFAULT_ROOT_UNDER_HOME = join('Documents', 'OpenFleet');
const RESERVED_FOLDERS_UNDER_HOME = ['.claude', '.scape', '.openfleet'];
const MAX_ROOT_LENGTH = 1024;
const MAX_FOLDER_NAME_LENGTH = 100;
const UNSAFE_FOLDER_NAME_CHARACTERS = /[\\/:\u0000-\u001f]+/g;

const StoredDocsRootSchema = z.object({ root: z.string() });

export interface DocsRootSettingsDeps {
  configPath: string;
  homeDir: string;
  /** The daemon's own state folder, which a docs root may never contain or sit in. */
  openfleetHome: string;
}

const invalid = () => new OpenFleetError('docs_root_invalid', 'the docs root must be an absolute path to a folder inside your home folder.', { hint: 'give an absolute path inside your home folder.' });
const forbidden = () => new OpenFleetError('docs_root_forbidden', 'the docs root cannot be a folder that OpenFleet or its tools keep for themselves.', { hint: 'pick another folder.' });
const notWritable = () => new OpenFleetError('docs_root_not_writable', 'the docs root is not writable.', { hint: 'fix the folder permissions, then try again.' });

const FILESYSTEMS_IGNORE_LETTER_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** The form two paths are compared in: Unicode-normalized, and lower-cased where the filesystem ignores letter case. */
const comparableForm = (path: string) => {
  const normalizedPath = path.normalize('NFC');
  return FILESYSTEMS_IGNORE_LETTER_CASE ? normalizedPath.toLowerCase() : normalizedPath;
};

const isInside = (parentPath: string, candidatePath: string) => {
  const parentForm = comparableForm(parentPath);
  const candidateForm = comparableForm(candidatePath);
  return candidateForm === parentForm || candidateForm.startsWith(`${parentForm}${sep}`);
};

const isSamePath = (firstPath: string, secondPath: string) => comparableForm(firstPath) === comparableForm(secondPath);

const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** Whether the path exists; only a missing entry means absent, any other filesystem refusal (name too long, file as folder, loop, permission) is an invalid docs folder. */
function existsOrRefuse(path: string): boolean {
  try {
    return exists(path);
  } catch {
    throw new InvalidDocsFolderError();
  }
}

/** The native real path of the deepest existing ancestor, followed by the parts that do not exist yet. */
function resolveThroughExistingAncestor(absolutePath: string): string {
  const missingParts: string[] = [];
  let existingPath = absolutePath;
  while (!exists(existingPath)) {
    missingParts.unshift(basename(existingPath));
    existingPath = dirname(existingPath);
  }
  return join(realpathSync.native(existingPath), ...missingParts);
}

function isWritableDirectory(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The docs root the Project step proposes folders under; a saved value in config.json wins over `<home>/Documents/OpenFleet`. */
export class DocsRootSettings {
  constructor(private readonly deps: DocsRootSettingsDeps) {}

  view(options: { projectName?: string } = {}): DocsRootView {
    const savedRoot = this.readSavedRoot();
    const root = savedRoot ?? join(this.deps.homeDir, DEFAULT_ROOT_UNDER_HOME);
    const view: DocsRootView = { root, isDefault: savedRoot === undefined };
    const folderName = options.projectName === undefined ? undefined : folderNameOf(options.projectName);
    return folderName ? { ...view, proposedPath: join(root, folderName) } : view;
  }

  /** Validates `typedRoot`, creates it when it does not exist, and saves its real path. Nothing is saved or created on a refusal. */
  save(typedRoot: string): DocsRootView {
    const realRoot = this.acceptRoot(typedRoot);
    updateConfigFile(this.deps.configPath, (existingConfig) => ({ ...existingConfig, docs: { ...(existingConfig.docs as object | undefined), root: realRoot } }));
    return this.view();
  }

  /**
   * Creates the folder of a new project when it is missing and lies under the docs root; an existing folder is left as it is.
   * A path outside the root is not this method's business: the docs folder checks refuse it afterwards.
   */
  ensureProjectFolder(typedDocsFolderPath: string): void {
    const isUsablePath = isAbsolute(typedDocsFolderPath) && !typedDocsFolderPath.includes('\u0000');
    if (!isUsablePath) return;
    const docsFolderPath = withoutRedundantSlashes(typedDocsFolderPath);
    const lexicalFolder = resolve(docsFolderPath);
    const isFreeOfDotSegments = lexicalFolder === docsFolderPath;
    if (!isFreeOfDotSegments) throw new InvalidDocsFolderError();
    const lexicalRoot = resolve(this.view().root);
    const isMissingUnderRoot = !existsOrRefuse(lexicalFolder) && isInside(lexicalRoot, lexicalFolder);
    if (!isMissingUnderRoot) return;

    const resolvedFolder = this.resolveOrRefuse(lexicalFolder);
    const resolvedRoot = this.resolveOrRefuse(lexicalRoot);
    this.refuseReservedFolders({ lexicalRoot: lexicalFolder, resolvedRoot: resolvedFolder });
    this.refuseOutsideHome(resolvedFolder);
    if (!isInside(resolvedRoot, resolvedFolder)) throw invalid();
    this.createFolder(resolvedFolder, docsFolderPath);
  }

  private createFolder(resolvedFolder: string, docsFolderPath: string): void {
    try {
      mkdirSync(resolvedFolder, { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isPermissionRefusal = code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
      throw isPermissionRefusal ? new DocsFolderNotWritableError(docsFolderPath, error) : new InvalidDocsFolderError();
    }
  }

  /** The saved root when it still passes every refusal (checked without creating anything); undefined otherwise, so the default applies. */
  private readSavedRoot(): string | undefined {
    const { configPath } = this.deps;
    if (!existsSync(configPath)) return undefined;
    try {
      const rawDocs = JSON.parse(readFileSync(configPath, 'utf8'))?.docs;
      if (rawDocs === undefined) return undefined;
      const parsed = StoredDocsRootSchema.safeParse(rawDocs);
      if (parsed.success) return this.revalidatedSavedRoot(parsed.data.root);
      log('warn', `docs config at ${configPath} is ignored, the default applies: ${readableConfigReason(parsed.error)}`);
    } catch (error) {
      log('warn', `docs config at ${configPath} is ignored, the default applies: ${readableConfigReason(error)}`);
    }
    return undefined;
  }

  private revalidatedSavedRoot(savedRoot: string): string | undefined {
    try {
      this.resolveAfterRefusals(savedRoot);
      return savedRoot;
    } catch (error) {
      if (!(error instanceof OpenFleetError)) throw error;
      log('warn', `the saved docs root is refused (${error.code}), the default applies`);
      return undefined;
    }
  }

  private acceptRoot(typedRoot: string): string {
    const resolvedRoot = this.resolveAfterRefusals(typedRoot);
    const realRoot = this.ensureWritableDirectory(resolvedRoot);
    this.refuseReservedFolders({ lexicalRoot: realRoot, resolvedRoot: realRoot });
    this.refuseOutsideHome(realRoot);
    return realRoot;
  }

  /** Returns the resolved path of `typedRoot` once every refusal has passed; touches nothing on disk. */
  private resolveAfterRefusals(typedRoot: string): string {
    const trimmedRoot = typedRoot.trim();
    const isUsableText = trimmedRoot.length > 0 && trimmedRoot.length <= MAX_ROOT_LENGTH && !trimmedRoot.includes('\u0000');
    if (!isUsableText || !isAbsolute(trimmedRoot)) throw invalid();

    const lexicalRoot = resolve(trimmedRoot);
    const resolvedRoot = this.resolveOrRefuse(lexicalRoot);
    this.refuseReservedFolders({ lexicalRoot, resolvedRoot });
    this.refuseOutsideHome(resolvedRoot);
    return resolvedRoot;
  }

  private resolveOrRefuse(lexicalRoot: string): string {
    try {
      return resolveThroughExistingAncestor(lexicalRoot);
    } catch {
      throw invalid();
    }
  }

  private reservedFolders(): string[] {
    const { homeDir, openfleetHome } = this.deps;
    const reservedUnderHome = RESERVED_FOLDERS_UNDER_HOME.map((folder) => join(homeDir, folder));
    const reserved = [...reservedUnderHome, openfleetHome];
    const resolvedReserved = reserved.flatMap((folder) => {
      try {
        return [resolveThroughExistingAncestor(folder)];
      } catch {
        return [];
      }
    });
    return [...reserved, ...resolvedReserved];
  }

  private refuseReservedFolders({ lexicalRoot, resolvedRoot }: { lexicalRoot: string; resolvedRoot: string }): void {
    const isReserved = this.reservedFolders().some((reserved) => isInside(reserved, lexicalRoot) || isInside(reserved, resolvedRoot));
    if (isReserved) throw forbidden();
  }

  private refuseOutsideHome(resolvedRoot: string): void {
    const realHome = realpathSync.native(this.deps.homeDir);
    if (!isInside(realHome, resolvedRoot)) throw invalid();
    if (isSamePath(realHome, resolvedRoot)) throw forbidden();
  }

  /** Returns the real path of the existing, writable directory; creates the missing folders only now that every refusal has been checked. */
  private ensureWritableDirectory(resolvedRoot: string): string {
    if (exists(resolvedRoot)) {
      if (!lstatSync(resolvedRoot).isDirectory()) throw invalid();
      if (!isWritableDirectory(resolvedRoot)) throw notWritable();
      return realpathSync.native(resolvedRoot);
    }
    try {
      mkdirSync(resolvedRoot, { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isPermissionRefusal = code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
      throw isPermissionRefusal ? notWritable() : invalid();
    }
    return realpathSync.native(resolvedRoot);
  }
}

/** The path without doubled slashes and without trailing slashes (the root `/` stays), as a terminal tab completion leaves it. Dot segments are kept. */
export function withoutRedundantSlashes(path: string): string {
  const withSingleSlashes = path.replace(/\/{2,}/g, '/');
  const isRootPath = withSingleSlashes === '/';
  return isRootPath ? withSingleSlashes : withSingleSlashes.replace(/\/+$/, '');
}

/** One folder name for a project: separators and control characters become dashes and a leading dot is dropped. Empty when nothing usable remains. */
export function folderNameOf(projectName: string): string {
  const withoutUnsafeCharacters = projectName.trim().replace(UNSAFE_FOLDER_NAME_CHARACTERS, '-');
  const withoutLeadingDots = withoutUnsafeCharacters.replace(/^\.+/, '');
  return withoutLeadingDots.slice(0, MAX_FOLDER_NAME_LENGTH).trim();
}
