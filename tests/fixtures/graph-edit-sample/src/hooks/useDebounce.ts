/**
 * @public
 * Debounce hook: schedules a delayed invocation of the callback.
 */
export function useDebounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number,
): T {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const wrapped = ((...args: Parameters<T>) => {
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), delayMs);
  }) as T;
  return wrapped;
}
