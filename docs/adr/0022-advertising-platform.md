# ADR 0022: The advertising platform, consent-gated and off by default

- **Status:** Accepted 2026-10-26. Part 1 (the privacy foundation) built; parts 2–9 follow in order,
  each in its own change.
- **Owner decision (2026-10-26):** engineer a complete Google/Meta-class advertising platform.
  Implement only what is legal with the consent each jurisdiction requires. Build everything that
  needs legal approval, partners or infrastructure, but keep it switched off.
- **Rules carried over:**
  - consent is granular and purpose-bound, never bundled (ADR 0003);
  - commercial value never touches knowledge, trust or consensus ranking (ADRs 0003, 0004);
  - no AI-written answers.

## Why the design starts from privacy

What the owner first described was telling companies what each person searched, and showing ads
from their Google searches, under one consent tick. That is impossible: nobody can see another
service's searches. It is also unlawful as bundled consent: DPDP Act 2023 §6 and GDPR Arts. 4(11)
and 7 require consent to be specific to each purpose and freely given.

The platforms the owner named don't work that way either:

- **Google** never tells an advertiser who searched; it shows the ad and reports totals.
- **Apple** requires every app to ask before tracking a person across others' apps.

So this platform matches ads to people inside Graphinity and gives advertisers only aggregates,
unless a jurisdiction-specific consent and a lawyer's approval allow more.

## The parts (bounded contexts)

| # | Part | What it does | State |
|---|---|---|---|
| 1 | **Privacy foundation** | Ad consent purposes; the law per country; pseudonymous ad identities; switches; one permission function | **Built (this change)** |
| 2 | Interest graph | Interest categories per ad identity from consented searches and reading, decaying; taxonomy from fields and commercial intent (ADR 0004) | Next |
| 3 | Campaigns | Advertisers and their members, campaigns, ad groups, plain-text creatives, contextual and interest targeting, budgets, schedules, frequency caps | Planned |
| 4 | Serving and auction | Candidate selection by targeting; eCPM = bid × predicted click rate × quality; generalized second-price auction with reserve; budget pacing; frequency capping; sponsored units returned apart from results and labelled | Planned |
| 5 | Click prediction | Logistic regression on hashed features, learned online (FTRL-Proximal, McMahan et al. 2013), calibrated, benchmarked against simpler baselines; through the model registry with gates and drift monitoring | Planned |
| 6 | Measurement and attribution | Impressions, clicks, conversions under `ads_measurement`; last-click, linear, time-decay, position-based and data-driven (Shapley) attribution, benchmarked | Planned |
| 7 | Audiences | Segments from interest rules, retargeting lists, lookalikes (nearest neighbours of a seed audience's interest vectors), every audience above a minimum size | Planned |
| 8 | Reporting | Advertiser reports from aggregates only: suppressed small groups, differential-privacy noise, a privacy budget per advertiser | Planned |
| 9 | Partner interfaces | OpenRTB 2.6 bid request/response adapters (DSPs, SSPs, exchanges), a partner tag (pixel) and SDK, a server-to-server conversion API; all behind their own switches | Planned |

Fraud (invalid clicks and impressions) reuses the rate limits, the shared-network marks and
collusion review (ADR 0017), and adds click-pattern checks with part 6.

## Part 1, as built (migration 0029)

**Consent purposes** (each its own choice, off by default):

| Purpose | What it allows |
|---|---|
| `ads_personalization` | Ads chosen from what the person searches for and reads in Graphinity |
| `ads_measurement` | Counting whether an ad led to a visit or purchase with that advertiser |
| `ads_cross_device` | One advertising profile on every signed-in device |
| `ads_partner_sites` | Partner sites' activity, through Graphinity's tag, for related ads (retargeting) |

**The law per country** (`app.ad_jurisdiction_rules`):

- For each purpose, a basis: `opt_in`, `opt_out` (where a law such as some US states' allows it) or
  `prohibited`.
- Each rule has a `legal_approved` mark, and only the owner can change rules (in the SQL editor).
- The default everywhere is opt-in and not approved. A country's own rule overrides the default.

**Pseudonymous identities** (`app.ad_identities`):

- Ad systems know a person only by a random `ad_id`, which only the server's own jobs can map back.
- Turning `ads_personalization` off gives the person a new `ad_id` in the same transaction, so
  nothing held under the old one can be joined to them.
- Deleting the account deletes the mapping.
- A test checks that no `app.ad_*` table refers to a person, except this map. Every future ad table
  is held to it.

**Switches:** `ads` (the master), `ads_behavioral`, `ads_measurement`, `ads_cross_device`,
`ads_partner_sites`, `ads_rtb`. All off.

**One permission, in the database:** `app.ads_permitted(person, purpose)` is true only when all of
these hold:

- the master switch and the purpose's switch are on;
- the rule for the person's country (or the default) is approved and not prohibited;
- the person chose the purpose (opt-in), or didn't refuse it (opt-out).

**Offered only while it runs:**

- While `ads` is off, the ad purposes aren't shown, and the database refuses turning one on.
- Turning one off is always allowed, and someone who said yes keeps seeing the choice until they
  withdraw it.

## Scale (100 million people)

- **Identity and interests** are keyed by `ad_id` and partition by its hash, so no ad workload ever
  joins personal tables.
- **Serving** reads a small online store per request:
  - the identity's top interest categories;
  - the campaign index by targeting key;
  - pacing state.
  It writes impressions to an append-only log.
- **Auction latency budget:** under 10 ms inside the request. Candidates come from an inverted
  index over targeting keys, then a bounded top-k scored by the click model.
- **Pacing and frequency caps:**
  - counters that tolerate being slightly stale;
  - token buckets per campaign and per identity;
  - reconciled from the log, so a lost counter undercounts spend rather than overspending.
- **Events:**
  - impressions and clicks are appended and partitioned by day;
  - attribution and reporting run as batch jobs over them;
  - retention follows each purpose (13 months; 180 days for partner sites).
- **Learning:** click prediction learns online from the event stream (FTRL keeps per-feature state
  that is cheap to update), and is gated by the model registry's offline and drift checks.

## Consequences

- No ad is selected, shown, measured or learned from until the owner turns `ads` on, and a lawyer
  approves the rules for each country where it runs.
- Advertisers never receive identities, searches or interests; reports are aggregates (part 8).
- Sponsored units are separate from knowledge results everywhere: never merged into one ranking,
  always labelled. Part 4 proves it with tests, as ADR 0003 requires.
- **Federated learning and on-device inference:** considered for click prediction, where devices
  would train on their own events. Graphinity's clients are web pages without durable on-device
  storage for model state (local storage is excluded by design), so server-side learning on
  pseudonymous events is the design. Revisit with a native app.
