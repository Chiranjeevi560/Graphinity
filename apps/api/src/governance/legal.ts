// Deadlines the law sets for complaints (for a lawyer to confirm before launch):
// India IT Rules 2021 r.3(2): acknowledge in 24 hours, resolve in 15 days, remove
// certain unlawful content within 72 hours of a complaint; EU DSA Art. 17: a statement of
// reasons for every restriction; US DMCA §512: keep what a takedown concerns (legal hold).

export const GRIEVANCE_KINDS = ['general', 'unlawful_content', 'personal_data', 'copyright'] as const;
export type GrievanceKind = (typeof GRIEVANCE_KINDS)[number];

const HOUR = 3_600_000;
export const ACK_MS = 24 * HOUR;
export const URGENT_MS = 72 * HOUR;
export const RESOLVE_MS = 15 * 24 * HOUR;

export function grievanceDeadlines(kind: GrievanceKind, receivedAt: number) {
  return {
    acknowledgeBy: receivedAt + ACK_MS,
    resolveBy: receivedAt + (kind === 'unlawful_content' ? URGENT_MS : RESOLVE_MS),
  };
}

export interface StatementOfReasons {
  restriction: 'removal' | 'visibility' | 'account' | 'demotion';
  facts: string;
  legalGround: string | null;
  termsGround: string | null;
  automated: boolean;
  redress: string;
}

/** DSA Art. 17(3): every element present, with a ground in law or the terms. */
export const validStatement = (s: StatementOfReasons) =>
  s.facts.trim().length >= 10 && s.redress.trim().length >= 10 && (s.legalGround !== null || s.termsGround !== null);
