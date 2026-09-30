export interface BoundedClose { timeoutMs: number; close: () => Promise<void> }

// Waits for a close, but never longer than timeoutMs and never rethrowing its failure: the caller is already
// on its way out and keeps its own error.
export async function closeWithin({ timeoutMs, close }: BoundedClose): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([close(), timedOut]);
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
}
