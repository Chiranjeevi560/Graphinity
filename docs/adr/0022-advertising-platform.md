# ADR 0022: The advertising platform, consent-gated and off by default

- **Status:** Accepted 2026-10-26. Parts 1–5 built (privacy foundation, interest graph,
  campaigns, serving and auction, click prediction), part 6 (conversion measurement and
  attribution), part 7 (audiences) and part 8 (private reporting); 9 follows, in its own changes.
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
| 6 | Measurement and attribution | Click ids only under `ads_measurement`, API keys, conversions reported server to server (6a); multi-touch attribution models, benchmarked, and a report per campaign (6b) | **Built** |
| 7 | Audiences | Segments from interest rules, ad reminders (retargeting) capped 3 a day and 7 a week and cooling with time, look-alikes (spherical k-means over a seed's interests with a popularity correction, benchmarked), every audience at least 100 people, behind `ads_audiences` | **Built** |
| 8 | Reporting | Advertiser reports by day, country, placement or audience over complete days: per-person clipping, fixed Laplace noise per cell (HMAC-seeded), cells under 25 people or 50 impressions suppressed, 2.0 ε per business per day; the 30-day report shows nothing under 25 people | **Built** |
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

## Part 6a, as built (migration 0034)

**Click ids:**

- Issued only at click time, only when the clicker permits `ads_measurement` (and the switch is on).
- Added to the destination as `gr_click`, the way search engines tag clicks.
- The id says nothing about the person. Everyone else's clicks carry none, so they can never be
  linked to a conversion.

**API keys:**

- A business's owner makes up to 10 working keys: `grk_` plus 32 random bytes.
- Each is shown once and stored only as its SHA-256. A key that random has nothing to guess, so no
  slow hash is needed.
- A revoked key stays revoked.

**Conversions:**

- The advertiser's server sends `POST /ads/conversions` with its key, a click id, its own order id,
  and an optional value and time.
- `app.record_ad_conversion` counts it only when measurement is on, the key works, and the click is
  on one of that business's own campaigns within 30 days.
- The conversion must come after the click, allowing five minutes of clock difference either way.
  Without that allowance, a sale reported in whole seconds the moment after its click looked earlier
  than the click and was refused: a test found it.
- It counts once per order id, and every refusal answers the same "not counted", so keys and click
  ids can't be probed.
- A business reads only its own conversions.

## Part 6b, as built (no migration)

**The question:** when a sale follows several ads, which ad earned it? Every model answers
differently, and an advertiser who believes the wrong one moves money to ads that change nothing.

**Models** (`src/ads/attribution.ts`, pure and deterministic):

- **Rule-based:** last click, first touch, linear, time decay (a touch's weight halves every week
  before the sale), and position (40% first, 40% last, 20% shared by the middle).
- **Data-driven:** learns from every path, bought or not, the conversion rate of each exact set of
  campaigns seen, then splits each sale by Shapley value (each campaign's average gain over every
  order its campaigns could have joined in; Shapley 1953, Dalessandro et al. 2012).
  - A set seen fewer than 5 times borrows the best rate among its one-smaller subsets, so one lucky
    path can't invent credit.
  - Exact for up to 12 campaigns on a path (2^12 subsets); beyond that, linear.
  - Negative credit is clipped to 0; each sale's credit sums to 1.
- **Lift** (`src/ads/lift.ts`): the difference in conversion rate between people shown a campaign
  and a randomly held-out group, with a 95% interval, and whether it is real (at least 100 people a
  side). Holdout membership is a stable hash.

**Benchmark** (`node scripts/benchmark-attribution.mjs`, 50,000 simulated people, 8 campaigns whose
true effect is known; two "retargeting" campaigns are shown late to people already likely to buy and
add almost nothing). Error is total distance from each campaign's true share (0 perfect, 2 worst):

| Model | Error | Credit to retargeting (truth 2.2%) |
|---|---|---|
| Last click | 1.149 | 59.7% |
| Time decay | 0.669 | 32.0% |
| Position | 0.608 | 28.0% |
| Linear | 0.540 | 23.5% |
| Data-driven (Shapley) | 0.475 | 26.0% |
| First touch | 0.299 | 2.9% |
| **Holdout experiment** | **0.110** | **2.0%** (found not significant) |

**What it showed:**

- Every model that only watches paths over-credits retargeting, because the people it reaches were
  going to buy anyway. Last click, the industry default, gives it 27 times its true share.
- The data-driven model beats the other observational models except first touch, which wins here
  only because the simulation puts retargeting last; it isn't right in general.
- Only a holdout experiment measures what an ad adds, and it correctly finds retargeting's effect
  indistinguishable from nothing.

**Decision:**

- The models ship as descriptive reports, labelled as such. Holdout experiments are the measure of
  incrementality.
- Holdout serving needs conversions matched to people who never clicked (a held-out person has no
  click). That comes with the partner tag in part 9, so holdout serving is built and tested there,
  end to end; `lift()` and `heldOut()` are ready for it.

**The report:** `GET /ads/campaigns/:id/report`, for the business's members only (moderators, who
review every campaign, are refused too):

- 30 days of impressions, clicks and spend for the campaign; the business's conversions; and the
  campaign's share of them, and of their value, under every model.
- A sale joins into a path only when the person allows measurement *now*: their impressions of the
  business's campaigns in the 30 days before it. Every other sale credits its one click.
  `joinedPaths` says how many did.
- People seen in the last 30 days who didn't buy are what the data-driven model compares against.
- Only aggregates leave: no identity, impression or time of any person. (Small-number protection,
  k-anonymity and noise come in part 8.)
- **Cost:** two indexed range reads (bounded at 10,000 conversions and the newest 200,000
  impressions), then O(impressions + conversions × path length + distinct sets × 2^k) in memory.
  At scale this is the batch job described below, not a request.

## Part 7, as built (migration 0036)

**What an audience is:** a business describes it; only the server's hourly build job decides who
is in it, from people who allow personalized ads at that moment. Members are ad identities only
(`app.ad_audience_members`, readable by the system alone). Three kinds:

- **Segment:** a rule, every condition in `all` and one of `any`: an interest at a minimum decayed
  score, a country, or a topic set on the profile. A stored rule is checked again on use; a
  malformed one matches nobody.
- **Ad reminder (retargeting):** people who tapped one of the business's own campaigns in the last
  30 days, each with their latest tap. A campaign targeting a reminder audience shows it at most 3
  times a day and 7 a week to one person (or its own cap, if lower), and its click estimate is
  multiplied by e^(−Δt/7 days) since the tap, so reminders fade rather than follow someone.
- **Look-alike:** people like a ready seed audience of the same business (never another
  look-alike). K = min(8, ⌊seed/25⌋) spherical k-means centres over the seed's L2-normalized
  interest vectors (k-means++ seeding, fixed per audience so a rebuild is reproducible); each other
  person scores max_k⟨u, μ_k⟩ − 0.5⟨u, μ_global⟩; the top 1%, 2% or 5% with a positive score.

**The floor, k ≥ 100:** an audience under 100 people is `insufficient`: it stores no members, has
no size, and can't be matched. `CHECK (status <> 'ready' OR size >= 100)` holds it in the
database. Sizes are shown rounded down to a hundred. Turning personalized ads off rotates the ad
identity, which removes the person from every audience in the same transaction; a trigger refuses
adding anyone who doesn't allow personalized ads. A campaign can target only its own business's
audiences (trigger), and an audience it targets that isn't ready matches nobody.

**Benchmark** (`node scripts/benchmark-lookalike.mjs`: 50,000 simulated people over the 20
topics in 12 hidden kinds plus 20% generalists who like popular topics; a 400-person seed from two
kinds; 5% picked; 5 worlds; base rate 12.5%):

| Method | Precision (mean ± sd) | Time |
|---|---|---|
| One centroid of the seed | 0.629 ± 0.016 | 66 ms |
| Nearest seed member (brute force, O(seed × people)) | 0.718 ± 0.026 | 849 ms per 10,000 people; ~2.4 hours at 100 million |
| k-means centres, no popularity correction | 0.890 ± 0.032 | 290 ms |
| **k-means centres with popularity correction (shipped)** | **0.949 ± 0.012** | 74 ms |

With a 200-person seed (K = 8 still) the shipped method scores 0.936 against 0.642 for one
centroid. One centroid averages two kinds of buyer into a direction neither has; nearest
neighbours chase each seed member's noise; the popularity correction stops generalists who like
everything from looking like everyone.

**Why not an ANN index (HNSW):** choosing "the top 5%" needs every candidate's score, which an
approximate nearest-neighbour query can't give. Scoring is O(people × K × topics), 74 ms at
50,000; at 100 million it is a sharded batch job with a top-k heap per shard and a merge, which
is also how the build would run there (`loadPeople` reads everyone into memory today).

## Part 8, as built (migration 0037)

**The threat:** a business that knows some of its customers compares reports (two date ranges, two
breakdowns, the same query asked twice) to learn whether one particular person saw, tapped or
bought. Every report goes through `POST /ads/reports/private`; the 30-day campaign report (part
6b) shows nothing at all below 25 people.

**How a report is made** (`src/ads/privacy.ts`, `src/routes/ad-reports.ts`):

- **Cells:** one campaign, one complete UTC day, one breakdown value (the day itself, the reader's
  country, the placement, or the audience that matched, recorded with each impression). Days still
  under way are never released: the same fixed noise on a growing count would give away each
  change exactly. Conversions count on the day they were *received*, which can't change once it's
  over; the day of the sale can (a business may report it late).
- **Clipping:** one person counts for at most 20 impressions, 3 clicks and 1 conversion in a cell.
  An untracked viewer has no identity to clip by: each impression counts as its own person.
- **Noise:** Laplace with scale Δ/ε, ε = 0.2 per metric, drawn from 53 bits of
  HMAC-SHA256(secret, cell key and metric). Asking again returns the same number, so averaging
  repeated answers removes nothing. The secret is 32 random bytes the server makes on first use,
  readable by the system only.
- **Suppression:** a cell is shown only with at least 25 people behind it (exact, a hard floor
  the charter asks for) and at least 50 impressions after noise.
- **Budget:** releasing a breakdown of a campaign's days costs 3 metrics × 0.2 × the cells one
  person can be in (1 for day or country, 2 for placement, one per targeted audience); the days
  are disjoint, so they compose in parallel and the release costs that once. A business has 2.0
  per UTC day (`app.ad_privacy_budget_ledger`, `CHECK ≤ 2.0`); a breakdown already released costs
  nothing again (`app.ad_report_releases`); `app.release_ad_report` does the accounting under an
  advisory lock, as the system only. Laplace noise is pure ε-DP: δ stays 0. A breakdown finer than
  one day's budget can hide (more than 3 audiences) is refused.

**Benchmark** (`node scripts/benchmark-private-reports.mjs`, 2,000 cells per size, 4 impressions
a person, 3% tapped, 10% of taps bought):

| People in the cell | Suppressed | Median error: impressions | clicks | conversions |
|---|---|---|---|---|
| 25 | 31.6% | 43% | 100% | — |
| 100 | 1.5% | 17.7% | 91.7% | 100% |
| 1,000 | 0% | 1.8% | 9.2% | 25% |
| 10,000 | 0% | 0.2% | 0.9% | 2.5% |
| 100,000 | 0% | 0.0% | 0.1% | 0.3% |

**Protection, measured:** an attacker who knows every click but one person's 3, and guesses from
the noisy count, is right 54.88% of the time over 50,000 trials; the theoretical best for ε = 0.2
is e^ε / (1 + e^ε) = 54.98%. With exact counts it would be right every time.

**What this means for businesses:** small campaigns see little until they reach a few thousand
people a day, as with the large platforms' own privacy-safe reporting; totals over many days are
the sum of fixed per-day cells, so their noise grows only as the square root of the days.

**Known limits:** the exact 25-person floor is not itself differentially private (whether a cell
is shown depends on the true count); deleting an account turns its impressions untracked, which
can change an already-released cell's clipping; both are small next to the noise and are kept
for the charter's hard floor.

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
