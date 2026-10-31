# ADR 0025: The personal graph's signals, explanations, forgetting, and the ranking firewall

- **Status:** Accepted 2026-11-01. No migration.

## Decision

- **31 signals, read rather than collected** (`personalization/signals.ts`). The charter asks for 31 signal
  types. Logging 31 new event kinds would double-store what the database already holds and break "collect the
  minimum", so each signal is a query over the record the person's own action left, under their row-level
  security. Rows never leave the database: one query returns count, last time and decayed evidence per signal.
- **Decay and confidence.** Evidence `e = Σ 2^(-age/h)` with a half-life per signal. Confidence is the mean of
  Beta(e, κ), `e / (e + κ)`. Compared with a plain count it forgets, and with a fixed cap it never claims certainty.
- **`ExplanationTrace` on every recommendation**: source, tier, signals, consent category, score, algorithm,
  `commercialInputs: 0`. "Why this?" on each row shows it in words.
- **Category purge**: `DELETE /me/graph/categories/:category`. It leaves the consent setting alone: forgetting the
  past and stopping the future are different choices with different histories.
- **The firewall is enforced at build time**: `no-restricted-imports` stops knowledge, trust, reputation and
  personalization code importing advertising or commerce. Invariant 3 in `test/invariants` covers the numbers.

## Limits

The signals describe a person to themselves; only `search`, `question_precheck`, `question_viewed` and
`field_selected` feed the recommendation list today (see the trace). The others wait for a ranking that can be
compared on real traffic. Confidence numbers are not calibrated against outcomes; there are none yet.
