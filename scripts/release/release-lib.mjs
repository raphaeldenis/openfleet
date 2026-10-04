// Pure helpers of scripts/release/prepare.mjs: SemVer parsing and precedence, conventional-commit grouping, release notes rendering.

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

/** Returns `{ major, minor, patch, prerelease }` for a strict SemVer string, `null` otherwise. Build metadata is dropped: it has no precedence. */
export function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return { major: BigInt(major), minor: BigInt(minor), patch: BigInt(patch), prerelease: prerelease ? prerelease.split('.') : [] };
}

function compareValues(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrereleaseIdentifiers(left, right) {
  const isLeftNumeric = NUMERIC_IDENTIFIER.test(left);
  const isRightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (isLeftNumeric && isRightNumeric) return compareValues(BigInt(left), BigInt(right));
  if (isLeftNumeric) return -1;
  if (isRightNumeric) return 1;
  return compareValues(left, right);
}

function comparePrereleases(left, right) {
  const isLeftRelease = left.length === 0;
  const isRightRelease = right.length === 0;
  if (isLeftRelease && isRightRelease) return 0;
  if (isLeftRelease) return 1;
  if (isRightRelease) return -1;
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    const identifierOrder = comparePrereleaseIdentifiers(left[index], right[index]);
    if (identifierOrder !== 0) return identifierOrder;
  }
  return compareValues(left.length, right.length);
}

/** SemVer 2.0.0 precedence: -1 when `left` is lower than `right`, 0 when equal, 1 when higher. Both must be valid SemVer. */
export function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  return compareValues(a.major, b.major) || compareValues(a.minor, b.minor) || compareValues(a.patch, b.patch) || comparePrereleases(a.prerelease, b.prerelease);
}

const CONVENTIONAL_SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<description>.+)$/;
const RELEASE_COMMIT_SCOPE = 'release';

/** Splits a conventional commit subject into its parts; `null` when the subject is not conventional. */
export function parseConventionalSubject(subject) {
  const groups = CONVENTIONAL_SUBJECT.exec(subject)?.groups;
  if (!groups) return null;
  return { type: groups.type, scope: groups.scope ?? null, isBreaking: groups.breaking === '!', description: groups.description };
}

const BREAKING_HEADING = 'Breaking changes';
const OTHER_HEADING = 'Other changes';
const HEADING_BY_TYPE = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactoring',
  docs: 'Documentation',
};
const HEADING_ORDER = [BREAKING_HEADING, ...Object.values(HEADING_BY_TYPE), OTHER_HEADING];

function isReleaseBookkeeping(subject) {
  return parseConventionalSubject(subject)?.scope === RELEASE_COMMIT_SCOPE;
}

function headingOf(parsedSubject) {
  if (!parsedSubject) return OTHER_HEADING;
  if (parsedSubject.isBreaking) return BREAKING_HEADING;
  return HEADING_BY_TYPE[parsedSubject.type] ?? OTHER_HEADING;
}

function entryOf({ hash, subject }, parsedSubject) {
  const text = parsedSubject ? `${parsedSubject.scope ? `**${parsedSubject.scope}:** ` : ''}${parsedSubject.description}` : subject;
  return { hash, text };
}

/** Groups `{ hash, subject }` commits under ordered headings; empty groups are left out and `chore(release)` commits are skipped. */
export function groupCommits(commits) {
  const entriesByHeading = new Map();
  for (const commit of commits.filter(({ subject }) => !isReleaseBookkeeping(subject))) {
    const parsedSubject = parseConventionalSubject(commit.subject);
    const heading = headingOf(parsedSubject);
    entriesByHeading.set(heading, [...(entriesByHeading.get(heading) ?? []), entryOf(commit, parsedSubject)]);
  }
  return HEADING_ORDER.filter((heading) => entriesByHeading.has(heading)).map((heading) => ({ heading, entries: entriesByHeading.get(heading) }));
}

/** Renders the release notes stub: a title, a summary to write by hand, then the grouped commits. */
export function renderReleaseNotes({ version, date, previousTag, groups }) {
  const commitCount = groups.reduce((total, { entries }) => total + entries.length, 0);
  const range = previousTag ? `since ${previousTag}` : 'since the first commit (no previous tag)';
  const sections = groups.map(({ heading, entries }) => [`## ${heading}`, ...entries.map(({ hash, text }) => `- ${text} (${hash})`)].join('\n'));
  return [`# OpenFleet v${version} (${date})`, 'Summary: TODO write two lines for the people who install this build.', `${commitCount} commits ${range}.`, ...sections].join('\n\n') + '\n';
}
