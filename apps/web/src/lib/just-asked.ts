// Questions asked from this tab moments ago, so their page plays the
// journey out once. Kept in memory only: a reload or a later visit shows
// the settled picture, never a replay pretending to be live.
const fresh = new Set<string>();

export function markJustAsked(questionId: string): void {
  fresh.add(questionId);
}

/** True once for a question just asked here. */
export function takeJustAsked(questionId: string): boolean {
  return fresh.delete(questionId);
}
