import { afterEach } from 'vitest';

/**
 * A real timer a test leaves pending fires inside whichever test runs next (a leaked socket reconnect once re-pointed
 * another spec's fake socket, so an event never reached the store under test). Every real timer set through the global
 * timers is tracked and cleared when its test ends, so no test starts with a timer of an earlier one still ticking.
 */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;

globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
  const id = realSetTimeout(
    (...callbackArgs: unknown[]) => {
      pendingTimers.delete(id);
      return typeof handler === 'function' ? handler(...callbackArgs) : undefined;
    },
    delay,
    ...args,
  );
  pendingTimers.add(id);
  return id;
}) as typeof setTimeout;

globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
  const id = realSetInterval(handler as () => void, delay, ...args);
  pendingTimers.add(id);
  return id;
}) as typeof setInterval;

globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
  pendingTimers.delete(id as ReturnType<typeof setTimeout>);
  realClearTimeout(id);
}) as typeof clearTimeout;

globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
  pendingTimers.delete(id as ReturnType<typeof setTimeout>);
  realClearInterval(id);
}) as typeof clearInterval;

export const pendingRealTimerCount = () => pendingTimers.size;

afterEach(() => {
  pendingTimers.forEach((id) => realClearTimeout(id));
  pendingTimers.clear();
});
