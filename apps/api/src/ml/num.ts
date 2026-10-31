// Reading a number from an array when the compiler can't know the index is in range.

export const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
