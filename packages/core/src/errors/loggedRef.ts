// A failure logged once under a ref keeps that ref, so the next place that describes the same thrown error reuses it instead of logging a second record.
const refByError = new WeakMap<object, string>();

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

export function rememberLoggedRef(error: unknown, ref: string): void {
  if (isObject(error)) refByError.set(error, ref);
}

export function carryLoggedRef(from: unknown, to: unknown): void {
  const ref = loggedRefOf(from);
  if (ref) rememberLoggedRef(to, ref);
}

export function loggedRefOf(error: unknown): string | undefined {
  return isObject(error) ? refByError.get(error) : undefined;
}
