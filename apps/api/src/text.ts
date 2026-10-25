// What people type, made tidy without changing what they said, and the
// rules it must meet. The database repeats every rule (db/migrations).

/**
 * Invisible characters that can disguise text: controls other than the line
 * break (C0, DEL, C1), and the direction overrides and isolates that make
 * text display in a different order than it's stored ("Trojan Source").
 * The marks real right-to-left writing needs (U+200E, U+200F, U+061C) stay.
 */
function isControl(codePoint: number): boolean {
  return (
    (codePoint < 0x20 && codePoint !== 0x0a) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
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
 * A full-text query matching any word (or, with 'all', every word). Which
 * words also match as beginnings ("impor" finds "import"): every one (the
 * default), only the last while it is still being typed ('last': the text
 * ends in a letter or digit), or none, for text submitted whole. Only letters
 * and digits get through, so nothing typed can change the query's meaning.
 * `also` adds words to match (spelling corrections), beyond the 12 typed.
 * Null when there is nothing to match.
 */
export function prefixQuery(
  raw: string,
  match: 'any' | 'all' = 'any',
  also: readonly string[] = [],
  prefix: 'every' | 'last' | 'none' = 'every',
): string | null {
  // The first 12 different words of each.
  const wordsOf = (text: string) =>
    [...new Set(text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])]
      .filter(w => codePoints(w).length >= 2)
      .slice(0, 12);
  const words = [...new Set([...wordsOf(raw), ...wordsOf(also.join(' '))])];
  const typing = /[\p{L}\p{M}\p{N}]$/u.test(raw) ? raw.toLowerCase().match(/[\p{L}\p{M}\p{N}]+$/u)?.[0] : undefined;
  const asBeginning = (w: string) => prefix === 'every' || (prefix === 'last' && w === typing);
  return words.length ? words.map(w => (asBeginning(w) ? `${w}:*` : w)).join(match === 'all' ? ' & ' : ' | ') : null;
}
