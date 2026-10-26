# ADR 0022: The advertising platform, consent-gated and off by default

- **Status:** Accepted 2026-10-26. Parts 1–5 built (privacy foundation, interest graph,
  campaigns, serving and auction, click prediction); parts 6–9 follow in order, each in its own
  change.
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
| 2 | **Interest graph** | Topic scores per ad identity from searches and reads while `ads_personalization` is permitted; halve every 30 days; never the words | **Built** |
| 3 | **Campaigns** | Advertisers and their staff, campaigns with budgets in micro-units and frequency caps, plain-text ads reviewed by moderators outside the business, contextual and interest targeting | **Built** |
| 4 | **Serving and auction** | Candidates by targeting from an in-memory index; generalized second-price auction on bid × predicted click rate with a reserve; pacing; frequency caps only for people tracked by their choice; clicks charged once, only when valid; ads asked for apart from knowledge results | **Built** |
| 5 | **Click prediction** | FTRL-Proximal on hashed impression features, gated against what serves on the newest impressions, promoted through the registry | **Built** |
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

## Part 2, as built (migration 0030)

**Collection:**

- A read of a question (weight 1), or a search (weight 2, for its topic filter or the topic most of
  its top three results share), calls `app.record_ad_interest`.
- That function records only if `ads_permitted(person, 'ads_personalization')`, and only for the
  signed-in person, with a bounded weight.
- Purpose limitation: data collected for other purposes (search logs, reading history) is never
  reused. The signal is taken at the moment, and only as a topic, never the query's words.

**Storage:**

- One row per (ad identity, topic): a score decayed to its last update, so each signal is O(1),
  computed as decayed score + weight, halving every 30 days.
- No event history is kept.
- Rows go after 13 months without a signal, or once faded under 0.01 (an hourly job).
- The taxonomy is Graphinity's fields; product-level categories join with commerce data.

**Withdrawal:** turning `ads_personalization` off replaces the identity row (migration 0030
redefines the rotation). Every ad table hanging off `ad_id` is then deleted by cascade, in the same
transaction.

**Transparency:** `GET /me/ad-interests` shows the person's topics as strengths relative to their
strongest; `DELETE /me/ad-interests/:field` removes one; the data export includes them.

**Scale:** about 20 topics per person is about 2 billion rows at 100 million people (about 200 GB).
The primary key leads with `ad_id`, so the table partitions by its hash. Serving reads one
identity's handful of rows.

## Part 3, as built (migration 0031)

**Advertisers:**

- A signed-in person who can post creates one with `app.create_advertiser`, which makes them its
  owner in the same step, at most 3 per person.
- It stays pending until a moderator approves it.
- Owners add managers; nobody adds themselves.
- The business's members are the one more table allowed to name a person, and they are staff, not
  people ads are shown to (the invariant test names it).

**Campaigns:**

- An objective (awareness, clicks, conversions).
- Money in micro-units of their currency: a daily budget of at least 1 unit, an optional total, and
  a maximum price per click no higher than the day's budget.
- A daily frequency cap per ad identity (1–20), and start and end times.
- They only move forward: draft, then active or paused, then ended for good.

**Ads:**

- Plain text: a 5–60 character headline and a 10–150 character body, with no control or
  direction-changing characters.
- An `https` destination with no credentials in it.
- Only an approved one can serve. A moderator approves or rejects with a reason, and the reviewer
  and time come from the session and the clock.
- Nobody reviews their own business's ads or approves their own business. A trigger enforces it;
  the review policy and a table constraint are proven separately as further layers.

**Targeting:**

- Each campaign holds a set of (kind, value), replaced as a whole.
- Contextual kinds: `field` (topic), `keyword` (a lowercase word in the query) and `country`.
- `interest` is behavioural, matched only under `ads_behavioral` and the person's permission
  (part 4).

**Switch:** nothing can be created while `ads` is off, in the API (404 `ads_off`) and the database.

## Part 4, as built (migration 0032)

**Where ads come from:**

- Ads come only from `POST /ads/select` (a placement: search or question). No search, question or
  recommendation response carries one.
- Tests prove both responses identical with advertising on or off, and that no search, ranking,
  routing, consensus or reputation module imports ad code.
- Each ad is labelled Sponsored and shows only the destination's domain; the address is given on
  tap.

**Choosing (`src/ads/serve.ts`):**

- Campaigns that may serve now are held in memory: active, inside their dates, their business
  approved, an approved ad, total budget left. They are refreshed every 30 seconds, indexed by
  targeted topic.
- Every targeting kind a campaign uses must match:
  - topic;
  - a query word;
  - the reader's country (unknown when signed out, so country-targeted ads don't serve then);
  - interest, only when `ads_personalization` is permitted for the reader.
- **Pacing:** a campaign sits out while it spends ahead of the day's elapsed share plus 10%.
- **Frequency caps** apply only to readers who allow personalized ads. Their impressions name their
  `ad_id`; everyone else's impressions name nobody, so they have no cap.

**The auction (`src/ads/auction.ts`):**

- Ranked by bid × predicted click rate. The click rate is the campaign's 30 days shrunk toward a 2%
  prior worth 200 impressions (empirical Bayes); part 5 learns it.
- The winner of each slot pays the generalized second price: the least that keeps its place, never
  above its bid nor below the 0.01 reserve.
- One ad per campaign; ties break by bid, then id.
- Property tests check every winner keeps its place at its price, and that one unit less would not.

**Clicks (`app.record_ad_click`):**

- Counted once, within an hour of showing.
- Charged the impression's price only if the click isn't by the business's own staff and the day's
  budget can take it.
- One campaign at a time (an advisory lock): a two-connection race test proves two concurrent
  clicks can't both squeeze under the budget.
- Requests and clicks have their own rate limit, since each writes a row.

**Measured (`scripts/benchmark-ad-serving.mjs`):** choosing ads in process costs 0.01, 0.08 and
2.0 ms p50 at 1,000, 10,000 and 100,000 active campaigns. Scanning every campaign took 6.0 ms at
100,000; the topic index made it 3× faster. Beyond that, precomputed click rates and per-topic
shards keep each request bounded.

## Part 5, as built (migration 0033)

**Features (`src/ads/ctr-features.ts`, one function for training and serving):**

- the impression's campaign, ad, placement, page topic (recorded with each impression from now on)
  and UTC hour;
- crosses of campaign by topic and campaign by placement, which a per-campaign average can't see.

Nothing about the person.

**Model:** FTRL-Proximal logistic regression (`src/ml/ftrl.ts`), learned one example at a time:

- 2^20 hashed weights, with L1 keeping most at exactly 0;
- defaults α 0.2, β 1, L1 1, L2 1;
- a test checks the per-coordinate update against a hand-worked two-step calculation.

**Daily, while `ads` is on (`src/ads/ctr.ts`):**

- The last 30 days of impressions, in time order. It waits for 20,000 impressions and 200 clicks.
- 70% to learn, the next 10% to choose α from {0.05, 0.2, 0.5}, and the newest 20% to judge.
- It is promoted only if the 95% paired bootstrap of per-impression log loss lies below what serves:
  shrunk per-campaign averages until a model serves, then that model.
- The registry keeps every version, and the ad server reloads after a promotion, checking the stored
  weights' hash.

**Measured (`scripts/benchmark-ad-ctr.mjs`):** simulated logs with known true click rates,
1,000,000 impressions, the newest 20% judged:

| Estimate | Log loss | AUC | Picks the truly best of 4 ads |
|---|---|---|---|
| The truth | 0.1549 | 0.735 | 100% |
| Shrunk per campaign (part 4) | 0.1614 | 0.678 | 60.6% |
| **FTRL (built)** | **0.1568** | **0.717** | **79.9%** |

- **The gain:** −0.0045 log loss per impression, with a 95% interval of [−0.0049, −0.0042]. It
  closes about 70% of the gap to the truth.
- **The learning rate matters:** at 200,000 impressions, α 0.05 gave AUC 0.68 and α 0.2 gave 0.70.
  Hence α is chosen per run.
- **Cost:** about 7 µs per training example.

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
