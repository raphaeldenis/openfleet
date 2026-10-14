export type AskResolution = 'ask' | 'deny';

/** Decides what a question to a human becomes. It reads two booleans and nothing else: no parser, no rule, no document. */
export function resolveAsk({ isUnwatched, askBecomesDeny }: { isUnwatched: boolean; askBecomesDeny: boolean }): AskResolution {
  return isUnwatched && askBecomesDeny ? 'deny' : 'ask';
}
