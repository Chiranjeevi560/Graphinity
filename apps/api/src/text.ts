// What people type, made tidy without changing what they said, and the
// rules it must meet. The database repeats every rule (db/schema.sql).

/** Control characters other than the line break: invisible, and used to spoof text. */
function isControl(codePoint: number): boolean {
  return (codePoint < 0x20 && codePoint !== 0x0a) || codePoint === 0x7f;
}

/** Characters as people count them (code points), like the database's char_length. */
function codePoints(text: string): number[] {
  const points: number[] = [];
  for (const ch of text) points.push(ch.codePointAt(0) ?? 0);
  return points;
}

/** One line: runs of spaces, tabs and line breaks become one space. */
export function cleanLine(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Paragraphs: Windows line breaks become \n, tabs become spaces, ends trimmed. */
export function cleanBody(raw: string): string {
  return raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').trim();
}

export type TextProblem = 'too_short' | 'too_long' | 'invalid_characters';

export function textProblem(text: string, min: number, max: number): TextProblem | null {
  const points = codePoints(text);
  if (points.some(isControl)) return 'invalid_characters';
  const length = points.length;
  if (length < min) return 'too_short';
  if (length > max) return 'too_long';
  return null;
}

/**
 * A full-text query matching any word, including words still being typed
 * ("impor" finds "import"). Only letters and digits get through, so nothing
 * typed can change the query's meaning. Null when there is nothing to match.
 */
export function prefixQuery(raw: string): string | null {
  const words = [...new Set(raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(w => codePoints(w).length >= 2).slice(0, 12);
  return words.length ? words.map(w => `${w}:*`).join(' | ') : null;
}
