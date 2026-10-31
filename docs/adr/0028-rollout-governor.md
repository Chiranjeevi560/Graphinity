# ADR 0028: Rollout rings and the governor

- **Status:** Accepted 2026-11-01. Migration 0048.

## Decision

- **Rings** 1%, 5%, 25%, 100%, hashed per person and per switch (MurmurHash3), so growing a ring keeps everyone in it and switches
  don't move together. `flags.enabledFor(name, unit)` reads it. No ring means everyone.
- **Trip rule**: over five minutes, errors with one-sided z ≥ 3.3 above 1%, or p95 over 500 ms with at least 30 requests. A plain
  rate would trip on 1 error in 50 requests at night.
- **Attribution**: requests aren't attributed to a switch, so a bad five minutes turns off every switch still in a ring. A false
  alarm costs a restarted rollout; a miss costs a broken site. Attributing them would need the flag on every metric, which the
  per-minute store has no room for at this scale.
- **Advancing is manual.** An automatic advance would spread a change while its owner is asleep. The governor only turns things off.

This replaces the earlier rule against a baseline, which nothing ran.

## Limits

Render has one instance, so this rings features, not deploys. Only `step_up_auth` reads per person today. Switches read once at
startup or globally stay all-or-nothing; moving one to `enabledFor` is a one-line change when it has a per-person meaning.
