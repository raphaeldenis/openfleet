import { ERROR_CODES, HANDOFF_SECTION_KEYS, HandoffContentSchema } from '@openfleet/shared';
import type { CloseHandoffResult, ErrorCode, HandoffPreview, HandoffSectionKey, HandoffSkipReason, HandoffSectionSource, HandoffTarget, HandoffTargetUnavailableReason } from '@openfleet/shared';

const SECTION_SOURCES: readonly HandoffSectionSource[] = ['working_state', 'git', 'session', 'manager', 'none'];
const UNAVAILABLE_REASONS: readonly HandoffTargetUnavailableReason[] = ['no_project', 'no_docs_folder', 'docs_folder_unusable'];
const PREVIEW_KINDS: readonly HandoffPreview['kind'][] = ['session', 'manager'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isOneOf = <Option extends string>(options: readonly Option[], value: unknown): value is Option => options.some((option) => option === value);

/** Reads a handoff target from a daemon payload; returns undefined when the payload is not one. */
export function parseHandoffTarget(payload: unknown): HandoffTarget | undefined {
  if (!isRecord(payload)) return undefined;
  const { available, reason, relativePath, writeOnCloseDefault } = payload;
  if (typeof available !== 'boolean' || typeof writeOnCloseDefault !== 'boolean') return undefined;
  const target: HandoffTarget = { available, writeOnCloseDefault };
  if (reason !== undefined) {
    if (!isOneOf(UNAVAILABLE_REASONS, reason)) return undefined;
    target.reason = reason;
  }
  if (relativePath !== undefined) {
    if (typeof relativePath !== 'string') return undefined;
    target.relativePath = relativePath;
  }
  return target;
}

const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);

const SKIP_REASONS: readonly HandoffSkipReason[] = ['recent_manual_handoff', 'target_unavailable', 'already_written'];

/** Reads what the daemon did with the handoff a close asked for; returns undefined when the payload is not a known result. */
export function parseCloseHandoffResult(payload: unknown): CloseHandoffResult | undefined {
  if (!isRecord(payload)) return undefined;
  const { status, relativePath, reason, error, message } = payload;
  if (status === 'written' && typeof relativePath === 'string') return { status, relativePath };
  if (status === 'skipped' && isOneOf(SKIP_REASONS, reason)) return { status, reason };
  if (status === 'failed' && isErrorCode(error) && typeof message === 'string') return { status, error, message };
  return undefined;
}

function parseSources(candidate: unknown): HandoffPreview['sources'] | undefined {
  if (!isRecord(candidate)) return undefined;
  const hasEverySourceKnown = HANDOFF_SECTION_KEYS.every((key) => isOneOf(SECTION_SOURCES, candidate[key]));
  return hasEverySourceKnown ? (candidate as HandoffPreview['sources']) : undefined;
}

function parseTruncated(candidate: unknown): HandoffSectionKey[] | undefined {
  const isKnownSectionList = Array.isArray(candidate) && candidate.every((key) => isOneOf(HANDOFF_SECTION_KEYS, key));
  return isKnownSectionList ? (candidate as HandoffSectionKey[]) : undefined;
}

/** Reads a handoff preview from a daemon payload; returns undefined when the payload is not one. */
export function parseHandoffPreview(payload: unknown): HandoffPreview | undefined {
  if (!isRecord(payload)) return undefined;
  const { sessionId, kind, generatedAt } = payload;
  const sections = HandoffContentSchema.safeParse(payload['sections']);
  const sources = parseSources(payload['sources']);
  const truncated = parseTruncated(payload['truncated']);
  const target = parseHandoffTarget(payload['target']);
  const isWellFormed =
    sections.success && sources && truncated && target && typeof sessionId === 'string' && typeof generatedAt === 'string' && isOneOf(PREVIEW_KINDS, kind);
  return isWellFormed ? { sessionId, kind, sections: sections.data, sources, truncated, target, generatedAt } : undefined;
}
