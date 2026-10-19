// Display names ("handles"). The same rule lives in the database as
// app.is_valid_handle(); a test runs examples through both so they can't drift.

const RESERVED = new Set([
  'about',
  'admin',
  'administrator',
  'anonymous',
  'api',
  'deleted',
  'everyone',
  'help',
  'here',
  'me',
  'mod',
  'moderator',
  'null',
  'official',
  'privacy',
  'root',
  'security',
  'settings',
  'staff',
  'support',
  'system',
  'team',
  'terms',
  'undefined',
  'www',
]);

export type HandleProblem = 'length' | 'characters' | 'edges' | 'dots' | 'digits' | 'reserved';

/** People type names with capitals and stray spaces; store one canonical form. */
export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase();
}

/** Why a (normalized) handle is not allowed, or null if it is fine. */
export function handleProblem(h: string): HandleProblem | null {
  if (h.length < 3 || h.length > 24) return 'length';
  if (!/^[a-z0-9._]+$/.test(h)) return 'characters';
  if (!/^[a-z0-9].*[a-z0-9]$/.test(h)) return 'edges';
  if (h.includes('..')) return 'dots';
  if (/^[0-9]+$/.test(h)) return 'digits';
  if (h.startsWith('graphinity') || RESERVED.has(h)) return 'reserved';
  return null;
}

export const handleProblemMessages: Record<HandleProblem, string> = {
  length: 'Use 3 to 24 characters.',
  characters: 'Use only letters, numbers, dots and underscores.',
  edges: 'Start and end with a letter or number.',
  dots: 'Don’t use two dots in a row.',
  digits: 'Include at least one letter.',
  reserved: 'That name is reserved. Try another.',
};
