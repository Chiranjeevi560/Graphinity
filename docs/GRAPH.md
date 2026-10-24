# The living graph

Graphinity's identity, interface and routing are one thing: people are nodes, the fields they
know are clusters, and a question visibly travels to the people most likely to have done it.
This records what we build, and where the original vision bends for honesty, privacy and cost.

## Rules that shape everything

- **Only real data is drawn.** Every node is a real member, every routed node a real person who
  was asked, every returning pulse a real answer. With few members the graph is small, and that
  is shown honestly: no invented nodes, no fake "loading" travel.
- **Nobody is identifiable in the graph.** The privacy policy promises that who was asked is never
  shown. Nodes carry no names or ids; the asker sees how many people were asked and where (field,
  country), never who. "Why you got this" is shown only to the person who got it.
- **Free.** Drawn with the browser's own canvas, no graph library. Routing runs in Postgres.

## What people see

| Where | Mode | What it shows |
|---|---|---|
| Home | Ambient | Every field as a cluster, members as slowly drifting nodes, links between people who share a field fading in and out. Signed in: your own node, brighter, joined to your clusters. |
| Question (asker) | Live routing | Your node, the question leaving it, travelling along edges to the people it was sent to, who light up. Each real answer returns as a pulse. Later waves add nodes. A line in words says the same: "Sent to 10 people who know Imports & Customs · 6 in India". Under 5 it says "a few" and draws the field lighting up, not single people: an exact small number, set against public profiles, could point at who. |
| Question (someone it was sent to) | Explained | "Why you got this: you know Imports & Customs · you're in India · 37 picked answers." |

Reduced motion: the same graph, still. A text summary is always there for screen readers.

Keyboard and screen readers (spec §20.1): the picture is hidden from them, and over it sits a list of
the fields, one button on each cluster, unseen until focused. Tab reaches the biggest field; the arrow
keys move between fields from biggest to smallest (Home and End jump to the ends); Enter opens one and
says in words who knows it and where else they reach ("40 people know Imports & Customs. 12 also know
Travel, and a few also know Fitness."), from exact counts the server sends, "a few" under 5. The
asker's routing line is a polite live region, so each wave and answer is read out as it happens.

## Routing that learns

A question goes only to people who list its field, in waves of 5, 5 and 5 at 0, 20 and 60 minutes
(spec §11.2: wave 2 only if fewer than 3 have opened it or answered, wave 3 only while it has fewer
than 3 answers), at most 3 a day per person, with one place in each wave kept for a newcomer (the
spec's "4 exploit + 1 explore"). Within the field, each person gets the spec's score Ψ
(`apps/api/src/routing-score.ts`):

| Part | Weight | Learns from |
|---|---|---|
| φ1 Close in meaning | 24% | The closest, by meaning, of the questions they answered before (removed answers don't count) |
| φ2 Field reputation | 18% | 0.8 × sigmoid((μ − 3σ − 25) / 8.33) + 0.2 × field/country expertise weight learned from evaluated answers |
| φ3 Country | 15% | 0.8 if they live there; 0.5 if one of their answers was picked on a question about there. No city data, so no 1.0 |
| φ4 Graph trust | 12% | PageRank along who picked whose answers in this field, starting only from moderators (TrustRank), so a ring picking each other gains nothing. Zero for everyone until a moderator has picked someone; moderators themselves get none |
| φ5 Helpful rate | 10% | Wilson lower bound of their answers here marked helpful or picked |
| φ6 Pick rate | 8% | (picks + 1) / (answers + 4) |
| φ7 Responsiveness | 6% | e^(−median reply / 4 h) × answered / asked (both smoothed; they get a day before one counts as ignored) |
| φ8 Activity and local timing | 4% | Recent activity halves every two weeks, multiplied by daytime suitability centered at 14:00 using the profile country’s central IANA timezone. Unknown countries use neutral 0.5; no precise location or timezone is collected. |

Then: the newcomer bonus, β 0.12 × √(2 ln N / (n + 1)) while someone has had fewer than 5 questions
in the field, counted only in the newcomer place (it grows with the field and, in the main places,
would outrank proven people); and the load dampener ((3 − used today) / 3)^1.5, so a person nearing
the day's limit is asked less. φ9 (diversity) is one minus the maximum learned field-local co-answer
affinity to an already selected recipient. Selection is greedy: each next candidate maximizes base Ψ
plus α9 × φ9 × the load dampener. The affinity prior is 1 − exp(−0.08 × co-answer count), then
answer outcomes reinforce or decay the edge. No chance term: the same facts give the same wave.
Reputation is per field: points in customs say nothing about programming. Picks, helpful marks,
ratings, verdicts, removals, and co-answers update learned values without retraining.

Each new route stores the algorithm version, final score, field/country expertise weight, local-time
fit, and diversity fit alongside the original reason fields. `/questions/:id` returns these only to
the recipient. These are decision snapshots, not calibrated probabilities. The nine weights
(24%, 18%, 15%, 12%, 10%, 8%, 6%, 4%, 3%) sum to 1.0. Candidate evidence gathering scales with
the candidate set and per-person history queries; greedy diversity selection is O(K²C) for C
candidates and K selected people. The indexed affinity lookup is field-local. Database evidence
counts may dominate in large fields, so measure before increasing candidate pools.

## How it's built

The consented personal graph also has an asynchronous database projection path (ADR 0008):
`personal_signal_events` acts as a bounded `SKIP LOCKED` queue, and each supported event produces
an owner-scoped topic node, question node, and temporal evidence edge. Consent is rechecked at
processing time; event deletion or expiry cascades to its edge. This path currently projects
question interaction events only. It is not a general-purpose graph analytics engine.

Personal graph nodes are typed and partitioned by their independently consented purpose: learning
and expertise (`learning_expertise`), trust and interactions (`interaction_history`), ownership
(`ownership`), purchase (`purchase_history`), experience (`travel_preferences` and
`learning_expertise`), commercial preferences (`commercial_personalization`), notifications
(`notification_preferences`), relationships (`relationship_graph`), and privacy controls (`identity`).
The API refuses entity types under unrelated consent categories. Owners can add directed weighted
edges with confidence and inspect/delete/export them.

`POST /me/graph/insights` runs global weighted PageRank, seed-personalized PageRank (random walk with
restart), deterministic weighted label propagation, and bounded random-walk co-occurrence embeddings
on the owner's currently consented graph. Recommendations fuse personalized rank and embedding
similarity; this graph-only score never enters commercial ranking. All code runs in-process without
an inference API. The graph is capped at 1,000 nodes and 5,000 edges per analysis. This is not
Leiden/Louvain, Node2Vec training, GraphSAGE, a global knowledge graph, or a learned recommendation
model. `scripts/benchmark-personal-graph.mjs` measures the in-process algorithms at the maximum
supported graph size; it does not measure PostgreSQL, HTTP, multi-user contention, or production load.

- `apps/web/src/lib/graph-layout.ts` and `routing-layout.ts`: where everything sits and moves, pure
  maths with tests. `lib/canvas-loop.ts`: what every graph's canvas needs, once (sharp on any screen,
  theme colours, 30 frames a second at most, none when hidden or scrolled away, still for reduced
  motion). `components/LivingGraph.tsx` and `RoutingGraph.tsx` only draw.
- The home graph's code downloads after the page's text, and the page works without it.
- Only what really happens while a page is open is animated: a question asked from this tab, a wave
  going out (`sent` event), an answer arriving (`answered` event). A later visit shows the settled
  picture, not a replay.
- Motion uses the spec's springs (§8.1): a question glides along its path on the spatial spring and
  stops there for good on arrival; the person it reaches swells and settles on the pulse spring.

## Bent or left for later, and why

- **Thousands of nodes per cluster**: only with thousands of members. The graph scales to that.
- **Star ratings after picking**: picking, "This helped more" and "Did it turn out right?" are
  already one tap each and already feed routing. A second rating form adds a step and little signal.
- **Consensus on answers**: needs reading what answers say (numbers, claims). Reliable only with
  a language model; left until semantic search exists.
- **Semantic search (embeddings)**: free options exist (a small model run on our own server, with
  Postgres `pgvector`), but they add a large dependency and memory on Render's free plan. Owner's
  call; matching stays full-text until then.
