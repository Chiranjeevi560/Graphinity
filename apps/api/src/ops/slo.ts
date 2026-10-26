// Service level objectives and their error budgets (docs/adr/0020-observability.md).
// Two SLOs over 30 days, on requests to every route but the live stream
// (which stays open by design):
// - availability: 99.5% of requests don't fail on our side (no 5xx);
// - latency: 95% of requests finish within LATENCY_SLO_MS.
// The free tier can't promise more: one instance that sleeps when idle and
// takes tens of seconds to wake.
//
// Alerting is by error-budget burn rate over two windows at once (Google SRE
// workbook, ch. 5, "multiwindow, multi-burn-rate"): the long window shows
// the budget is really burning, the short one that it still is. Burn rate 1
// spends the 30-day budget in exactly 30 days.

export interface Window {
  requests: number;
  /** Requests that count against the SLO. */
  bad: number;
}

export interface Objective {
  name: 'availability' | 'latency';
  /** Share of requests that must be good. */
  target: number;
}

export const OBJECTIVES: readonly Objective[] = [
  { name: 'availability', target: 0.995 },
  { name: 'latency', target: 0.95 },
];

/** Routes left out of every SLO: long-lived by design. */
export const EXCLUDED_ROUTES: ReadonlySet<string> = new Set(['/events']);

export interface BurnRule {
  severity: 'page' | 'ticket';
  /** Minutes. */
  long: number;
  short: number;
  burn: number;
}

/** The workbook's recommended thresholds for a 30-day budget. */
export const BURN_RULES: readonly BurnRule[] = [
  { severity: 'page', long: 60, short: 5, burn: 14.4 },
  { severity: 'page', long: 360, short: 30, burn: 6 },
  { severity: 'ticket', long: 1440, short: 120, burn: 3 },
  { severity: 'ticket', long: 4320, short: 360, burn: 1 },
];

/**
 * Fewer requests than this in the long window and no alert fires: one failed
 * request of three is a 33% error rate, not an outage. A known limit of burn
 * rates at low traffic (workbook, "low-traffic services").
 */
export const MIN_REQUESTS = 50;

/** How fast the window spends the budget; 0 with no requests. */
export function burnRate(w: Window, target: number): number {
  if (w.requests === 0) return 0;
  return w.bad / w.requests / (1 - target);
}

export interface Alert {
  objective: Objective['name'];
  severity: BurnRule['severity'];
  long: number;
  short: number;
  burnLong: number;
  burnShort: number;
}

/**
 * The alerts firing now, most severe first. `windowOf(minutes)` totals the
 * last that-many minutes for an objective.
 */
export function firingAlerts(windowOf: (objective: Objective['name'], minutes: number) => Window): Alert[] {
  const out: Alert[] = [];
  for (const o of OBJECTIVES)
    for (const rule of BURN_RULES) {
      const long = windowOf(o.name, rule.long);
      if (long.requests < MIN_REQUESTS) continue;
      const short = windowOf(o.name, rule.short);
      const burnLong = burnRate(long, o.target);
      const burnShort = burnRate(short, o.target);
      if (burnLong >= rule.burn && burnShort >= rule.burn)
        out.push({
          objective: o.name,
          severity: rule.severity,
          long: rule.long,
          short: rule.short,
          burnLong,
          burnShort,
        });
    }
  const rank = (a: Alert) => (a.severity === 'page' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.burnLong - a.burnLong);
}

/** The share of the 30-day budget left (can go below 0). */
export function budgetRemaining(month: Window, target: number): number {
  if (month.requests === 0) return 1;
  return 1 - month.bad / ((1 - target) * month.requests);
}
