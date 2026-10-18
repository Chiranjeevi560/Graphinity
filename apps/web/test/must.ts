/** A value the test expects to exist; fails with a readable message instead of reading undefined. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`test expected ${what} to exist`);
  return value;
}
