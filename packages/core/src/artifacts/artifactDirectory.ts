import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { log } from '../logger.js';

const ARTIFACTS_FOLDER = 'artifacts';
const FALLBACK_DIRECTORY_NAME = 'manager';
const MAX_DIRECTORY_NAME_LENGTH = 64;
const NUL = '\0';

export interface ArtifactSettings {
  maxFileBytes: number;
  maxProjectBytes: number;
}

export interface ArtifactActor {
  sessionId: string;
  role: 'manager' | 'child';
  agentId?: string;
}

export interface ArtifactJournalEntry {
  outcome: 'granted' | 'refused';
  sessionId: string;
  actor: ArtifactActor['role'];
  agentId?: string;
  projectId: string;
  managerName: string;
  path: string;
  bytes?: number;
  reason?: string;
}

export interface ArtifactJournal {
  record(entry: ArtifactJournalEntry): void;
}

export type ArtifactWriteJudgement = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'not_in_artifacts' };

export interface ArtifactDirectoryDeps {
  docsFolderPathOf(projectId: string): string | undefined;
  settings: ArtifactSettings;
  journal: ArtifactJournal;
}

interface WriteRequest {
  projectId: string;
  managerName: string;
  actor: ArtifactActor;
  filePath: unknown;
  content: unknown;
}

interface RefusalRequest {
  filePath: string;
  content: unknown;
  managerDirectory: string;
  projectId: string;
}

const NOT_IN_ARTIFACTS: ArtifactWriteJudgement = { kind: 'not_in_artifacts' };
const UNREADABLE = Symbol('unreadable');

/** Turns a manager name into one safe path segment: ASCII letters, digits, dot, dash and underscore only, no leading dot or dash. */
export function managerDirectoryNameOf(managerName: string): string {
  const asciiOnly = managerName.replace(/[^A-Za-z0-9._-]+/g, '-');
  const withoutLeadingPunctuation = asciiOnly.replace(/^[.-]+/, '');
  const capped = withoutLeadingPunctuation.slice(0, MAX_DIRECTORY_NAME_LENGTH);
  const withoutTrailingDash = capped.replace(/-+$/, '');
  return withoutTrailingDash === '' ? FALLBACK_DIRECTORY_NAME : withoutTrailingDash;
}

const isStrictlyInside = (path: string, directory: string): boolean => path.startsWith(directory + sep);
const isInsideOrEqual = (path: string, directory: string): boolean => path === directory || isStrictlyInside(path, directory);

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function realpathOfNearestExistingAncestor(path: string): string | undefined {
  let candidate = path;
  while (lstatOrUndefined(candidate) === undefined) {
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
  return realpathSync.native(candidate);
}

function bytesUnder(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) total += bytesUnder(entryPath);
    if (entry.isFile()) total += lstatSync(entryPath).size;
  }
  return total;
}

/**
 * The per-project folder `<docs folder>/artifacts/<manager>/` where a manager and its children write
 * without a prompt. It resolves and creates the folder, judges each write against it (canonical path,
 * no symlink out, size, project quota) and journals every judgement.
 */
export class ArtifactDirectory {
  constructor(private readonly deps: ArtifactDirectoryDeps) {}

  /** Creates the manager's folder and returns its canonical path; absent when the project has no usable docs folder. */
  ensureFor({ projectId, managerName }: { projectId: string; managerName: string }): string | undefined {
    const artifactsRoot = this.ensureArtifactsRoot(projectId);
    if (artifactsRoot === undefined) return undefined;
    const managerDirectory = join(artifactsRoot, managerDirectoryNameOf(managerName));
    mkdirSync(managerDirectory, { recursive: true });
    const canonicalManagerDirectory = realpathSync.native(managerDirectory);
    const staysInsideArtifactsRoot = isStrictlyInside(canonicalManagerDirectory, artifactsRoot);
    return staysInsideArtifactsRoot ? canonicalManagerDirectory : undefined;
  }

  judgeWrite(request: WriteRequest): ArtifactWriteJudgement {
    const { filePath } = request;
    if (typeof filePath !== 'string' || !this.isUnderArtifactsFolder(request.projectId, filePath)) return NOT_IN_ARTIFACTS;
    const managerDirectory = this.ensureFor(request);
    if (managerDirectory === undefined) return NOT_IN_ARTIFACTS;
    const targetsManagerDirectory = isStrictlyInside(filePath, managerDirectory);
    if (!targetsManagerDirectory) return NOT_IN_ARTIFACTS;

    const refusal = this.refusalOrUnreadable({ ...request, filePath, managerDirectory });
    if (refusal === UNREADABLE) return NOT_IN_ARTIFACTS;
    if (refusal !== undefined) return this.refuse(request, filePath, refusal);
    return this.grant(request, filePath);
  }

  private isUnderArtifactsFolder(projectId: string, filePath: string): boolean {
    const docsFolderPath = this.deps.docsFolderPathOf(projectId);
    if (docsFolderPath === undefined) return false;
    return isStrictlyInside(filePath, join(realpathSync.native(docsFolderPath), ARTIFACTS_FOLDER));
  }

  /** A folder the quota walk cannot read gives no opinion: the write is left to the approval flow, never allowed. */
  private refusalOrUnreadable(request: RefusalRequest): string | undefined | typeof UNREADABLE {
    try {
      return this.refusalOf(request);
    } catch (error) {
      log('warn', `artifact write could not be judged, left to the approval flow: ${error instanceof Error ? error.message : String(error)}`);
      return UNREADABLE;
    }
  }

  private ensureArtifactsRoot(projectId: string): string | undefined {
    const docsFolderPath = this.deps.docsFolderPathOf(projectId);
    if (docsFolderPath === undefined) return undefined;
    const canonicalDocsFolder = realpathSync.native(docsFolderPath);
    const artifactsRoot = join(canonicalDocsFolder, ARTIFACTS_FOLDER);
    mkdirSync(artifactsRoot, { recursive: true });
    const canonicalArtifactsRoot = realpathSync.native(artifactsRoot);
    const staysInsideDocsFolder = canonicalArtifactsRoot === artifactsRoot;
    return staysInsideDocsFolder ? canonicalArtifactsRoot : undefined;
  }

  private refusalOf({ filePath, content, managerDirectory, projectId }: RefusalRequest): string | undefined {
    const isNotCanonical = filePath.includes(NUL) || resolve(filePath) !== filePath;
    if (isNotCanonical) return 'the path must be absolute and canonical (no "..", ".", "//" or NUL)';

    const target = lstatOrUndefined(filePath);
    if (target?.isSymbolicLink()) return 'the target is a symbolic link';
    if (target?.isDirectory()) return 'the target is a directory';
    const hasSeveralHardLinks = target?.isFile() === true && target.nlink > 1;
    if (hasSeveralHardLinks) return 'the target is a hard link shared with another path';

    const existingAncestor = realpathOfNearestExistingAncestor(dirname(filePath));
    const escapesThroughALink = existingAncestor === undefined || !isInsideOrEqual(existingAncestor, managerDirectory);
    if (escapesThroughALink) return 'the path leaves the artifact directory through a symbolic link';

    if (typeof content !== 'string') return 'the content must be a string';
    const bytes = Buffer.byteLength(content, 'utf8');
    const { maxFileBytes, maxProjectBytes } = this.deps.settings;
    if (bytes > maxFileBytes) return `the file is ${bytes} bytes, above the ${maxFileBytes} byte maximum per file`;

    const replacedBytes = target?.isFile() ? target.size : 0;
    const bytesAfterWrite = this.bytesOfProject(projectId) - replacedBytes + bytes;
    if (bytesAfterWrite > maxProjectBytes) return `the project would hold ${bytesAfterWrite} bytes of artifacts, above the ${maxProjectBytes} byte quota`;
    return undefined;
  }

  private bytesOfProject(projectId: string): number {
    const artifactsRoot = this.ensureArtifactsRoot(projectId);
    return artifactsRoot === undefined ? 0 : bytesUnder(artifactsRoot);
  }

  private grant(request: WriteRequest, filePath: string): ArtifactWriteJudgement {
    const bytes = Buffer.byteLength(request.content as string, 'utf8');
    this.deps.journal.record({ ...this.entryBase(request, filePath), outcome: 'granted', bytes });
    return { kind: 'allow' };
  }

  private refuse(request: WriteRequest, filePath: string, reason: string): ArtifactWriteJudgement {
    this.deps.journal.record({ ...this.entryBase(request, filePath), outcome: 'refused', reason });
    return { kind: 'deny', reason };
  }

  private entryBase({ actor, projectId, managerName }: WriteRequest, path: string) {
    return {
      sessionId: actor.sessionId, actor: actor.role, ...(actor.agentId === undefined ? {} : { agentId: actor.agentId }),
      projectId, managerName, path,
    };
  }
}
