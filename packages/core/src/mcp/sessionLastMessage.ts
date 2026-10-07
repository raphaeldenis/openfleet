import { maskedSecrets } from '../redact.js';
import { readTranscriptTail } from '../sessions/resolvedModel.js';

const MAX_LAST_MESSAGE_BYTES = 8192;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_PREFIX = 0x80;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function assistantText(line: string): string | undefined {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(entry)) return undefined;
  const isMainAssistant = entry.type === 'assistant' && entry.isSidechain !== true;
  if (!isMainAssistant || !isRecord(entry.message)) return undefined;
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const isTextBlock = (block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string';
  const textBlocks = content.filter(isRecord).filter(isTextBlock);
  return textBlocks.map((block) => block.text).join('\n');
}

function boundedUtf8Message(text: string): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, MAX_LAST_MESSAGE_BYTES);
  const isInsideMultibyteCharacter = () => end < bytes.length && (bytes[end]! & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX;
  while (isInsideMultibyteCharacter()) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function lastAssistantMessage(tail: string): string | null {
  const linesNewestFirst = tail.split('\n').reverse();
  for (const line of linesNewestFirst) {
    const text = assistantText(line);
    if (!text) continue;
    const safeText = maskedSecrets(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
    return boundedUtf8Message(safeText);
  }
  return null;
}

export function sessionLastMessage(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  try { return lastAssistantMessage(readTranscriptTail(transcriptPath)); } catch { return null; }
}
