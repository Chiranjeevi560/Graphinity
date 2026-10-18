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

## Routing that learns

A question goes only to people who list its field, in waves (10, then 30 after 15 minutes, then
100 after an hour, while unanswered), within a daily limit per person, with 20% of each wave kept
for newcomers. Within the field, each person gets a score:

| Part | Weight | Learns from |
|---|---|---|
| Expertise in this field | 35% | Points earned in this field (picked +5, helpful +2), on a log scale against the best candidate |
| Same country as the question | 20% | Their profile |
| Responsiveness | 20% | Of the questions put to them in the last 60 days, how many they answered (ignoring lowers it; they get a day before one counts; a removed answer doesn't count) |
| Trust in this field | 15% | Askers saying a picked answer in this field turned out right (each asker once) |
| Chance | 10% | So the same people aren't always first, and new strengths are found |

New people start in the middle (no data means 50%, not 0), so they aren't buried. Reputation is
per field: points in customs say nothing about programming. Every pick, helpful mark, verdict
and ignored question changes the next routing; nothing needs retraining.

Each route stores why it was made, at that moment, for "Why you got this".

## Bent or left for later, and why

- **Thousands of nodes per cluster**: only with thousands of members. The graph scales to that.
- **Star ratings after picking**: picking, "This helped more" and "Did it turn out right?" are
  already one tap each and already feed routing. A second rating form adds a step and little signal.
- **Consensus on answers**: needs reading what answers say (numbers, claims). Reliable only with
  a language model; left until semantic search exists.
- **Semantic search (embeddings)**: free options exist (a small model run on our own server, with
  Postgres `pgvector`), but they add a large dependency and memory on Render's free plan. Owner's
  call; matching stays full-text until then.
