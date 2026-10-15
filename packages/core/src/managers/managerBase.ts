import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ManagerBaseView } from '@openfleet/shared';

export type ManagerBaseSectionType = 'invariant' | 'default';

export interface ManagerBaseSection {
  id: string;
  title: string;
  type: ManagerBaseSectionType;
  bytes: number;
}

export interface ManagerBase {
  version: number;
  /** sha256 hex of the normalized body. */
  sha: string;
  /** UTF-8 size of the normalized body. */
  bytes: number;
  body: string;
  sections: ManagerBaseSection[];
}

const BASE_FILE_NAME = 'base.md';

// The source tree keeps the template beside src/; the daemon bundle keeps it beside daemon.bundle.mjs.
const CANDIDATE_DIRECTORIES = [new URL('./templates/manager/', import.meta.url), new URL('../../templates/manager/', import.meta.url)];

const FRONTMATTER = /^---\nversion: (\d+)\n---\n+/;
const SECTION_HEADING = /^## (§\d+) (.+) \[(invariant|default)\]$/;
const ANY_SECTION_HEADING = /^## /;

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

function normalized(source: string): string {
  const unixLines = source.replaceAll('\r\n', '\n').split('\n').map((line) => line.trimEnd());
  return unixLines.join('\n');
}

function sectionsOf(body: string): ManagerBaseSection[] {
  const lines = body.split('\n');
  const firstHeadingIndex = lines.findIndex((line) => ANY_SECTION_HEADING.test(line));
  const hasTextBeforeFirstSection = firstHeadingIndex !== 0;
  if (hasTextBeforeFirstSection) throw new Error('the manager base has text before the first section');

  const headingIndexes = lines.flatMap((line, index) => (ANY_SECTION_HEADING.test(line) ? [index] : []));
  return headingIndexes.map((start, position) => {
    const end = headingIndexes[position + 1] ?? lines.length;
    const heading = lines[start]!;
    const match = SECTION_HEADING.exec(heading);
    if (!match) throw new Error(`the manager base heading "${heading}" is not "## §<n> <title> [invariant|default]"`);
    const text = lines.slice(start, end).join('\n').trim();
    return { id: match[1]!, title: match[2]!, type: match[3] as ManagerBaseSectionType, bytes: utf8Bytes(text) };
  });
}

/** Reads the version, the normalized body, its sha and its sections out of the text of base.md. */
export function parseManagerBase(source: string): ManagerBase {
  const text = normalized(source);
  const frontmatter = FRONTMATTER.exec(text);
  if (!frontmatter) throw new Error('the manager base has no "version: <n>" frontmatter');
  const body = text.slice(frontmatter[0].length).trimEnd();
  return {
    version: Number(frontmatter[1]),
    sha: createHash('sha256').update(body, 'utf8').digest('hex'),
    bytes: utf8Bytes(body),
    body,
    sections: sectionsOf(body),
  };
}

function shippedBasePath(): string {
  const found = CANDIDATE_DIRECTORIES.map((directory) => new URL(BASE_FILE_NAME, directory)).find((file) => existsSync(file));
  if (!found) throw new Error(`the shipped manager base templates/manager/${BASE_FILE_NAME} is missing from this build`);
  return fileURLToPath(found);
}

/** Loads the base this build ships. Throws when the file is missing or malformed, so a daemon never boots without it. */
export function loadManagerBase(): ManagerBase {
  return parseManagerBase(readFileSync(shippedBasePath(), 'utf8'));
}

/** The identity and outline of a base, without its text. */
export function managerBaseView({ version, sha, bytes, sections }: ManagerBase): ManagerBaseView {
  return { version, sha, bytes, sections: sections.map(({ id, title, bytes: sectionBytes }) => ({ id, title, bytes: sectionBytes })) };
}
