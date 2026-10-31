// A tamper-evident log (master charter §1 of the brief): each entry's hash covers the
// previous entry's hash and its own canonical content, so changing or removing any
// entry breaks every later link. The database appends under a lock and forbids
// updates (migration 0046); verify recomputes the chain from the rows.
import { createHash } from 'node:crypto';

export interface AuditEntry {
  seq: number;
  action: string;
  actor: string;
  subject: string;
  detail: Record<string, unknown>;
  at: string;
  prevHash: string;
  hash: string;
}

export const GENESIS = '0'.repeat(64);

/** JSON with sorted keys at every depth: the same content always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

export const entryHash = (e: Omit<AuditEntry, 'hash'>) =>
  createHash('sha256')
    .update(e.prevHash)
    .update(canonical({ seq: e.seq, action: e.action, actor: e.actor, subject: e.subject, detail: e.detail, at: e.at }))
    .digest('hex');

export function appendEntry(
  previous: Pick<AuditEntry, 'seq' | 'hash'> | null,
  entry: Pick<AuditEntry, 'action' | 'actor' | 'subject' | 'detail' | 'at'>,
): AuditEntry {
  const base = { ...entry, seq: (previous?.seq ?? 0) + 1, prevHash: previous?.hash ?? GENESIS };
  return { ...base, hash: entryHash(base) };
}

/** The first broken sequence number, or null when the whole chain holds. */
export function verifyChain(entries: readonly AuditEntry[]): number | null {
  let previous: AuditEntry | null = null;
  for (const e of entries) {
    if (e.seq !== (previous?.seq ?? 0) + 1) return e.seq;
    if (e.prevHash !== (previous?.hash ?? GENESIS)) return e.seq;
    if (entryHash(e) !== e.hash) return e.seq;
    previous = e;
  }
  return null;
}
