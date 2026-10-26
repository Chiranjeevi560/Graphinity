# ADR 0017: Collusion review, chosen by measurement

- **Status:** Accepted and built 2026-10-26.
- **Rules it keeps:**
  - nothing happens to anyone automatically: a moderator decides;
  - moderators and the background job are the only readers;
  - deleting an account deletes every group the account was in.

## Problem

Points drive routing and medals. The pair cap (3 awards per asker per person per 30 days) stops one
person farming another. It doesn't stop a **ring**: several accounts that pick each other's answers,
each pair staying under the cap. A ring can also hide:

- **camouflage:** picking popular honest answers too;
- **rotation:** A picks B, B picks C, C picks A, so no one ever picks back directly.

## Measurement

`scripts/benchmark-fraud.mjs` plants rings in a pick graph shaped like Graphinity's. Honest askers
pick experts, popular ones far more often. The planted attacks:

- 10 dense rings of 3–12 accounts;
- 5 rotation rings of 6–12 accounts;
- 5 sockpuppet stars of 5–14 new accounts picking one beneficiary.

It varies camouflage (0–50 picks of popular accounts per fake account) and genuine picks (honest
people also picking each ring member 3 times). Precision and recall count ring members.

At 5,000 accounts:

| Camouflage, genuine picks | Mutual picks ≥ 2 | Fraudar + lift | **Closure (built)** |
|---|---|---|---|
| 0, 0 | P 1 / R 0.32 | P 1 / R 0.92 | **P 1 / R 0.96** |
| 5, 0 | 1 / 0.36 | 1 / 0.42 | **1 / 0.96** |
| 20, 0 | 1 / 0.47 | 1 / 0.18 | **1 / 0.99** |
| 50, 0 | 1 / 0.52 | 1 / 0.10 | **1 / 0.98** |
| 0, 3 | 1 / 0.38 | 1 / 0.34 | **1 / 0.58** |
| 50, 3 | 1 / 0.40 | 1 / 0 | **1 / 0.47** |

At 50,000 accounts (230,000 picks), no method flags a single honest account.

- **Closure:** recall 0.96–1.0 without genuine picks and 0.48–0.69 with them, in **150 ms**.
- **Fraudar:** about 1.8 s. It beats closure in one case only (camouflage 50 with genuine picks:
  0.66 against 0.50).

What the runs taught, in order:

- **Fraudar with a density cut-off** missed most rings at camouflage 0. Peeling keeps every node it
  doesn't remove, so a block is often a whole honest crowd plus unrelated rings.
- **Significance tests can't separate.** Every candidate block was *chosen* for being dense, so
  even honest blocks look astronomically unlikely under a null that ignores the choosing.
  **Lift** separates cleanly. It is picks among the members ÷ (picks they gave × picks they received
  ÷ all picks). Honest parts stay under 7; rings sit in the hundreds.
- **Stars can't be told apart by picks alone.** Splitting blocks into connected parts made
  honest *niche-expert stars* (a few askers picking one specialist) indistinguishable from sockpuppet
  stars (lift 1,700). Only side signals separate them.
- **What a ring cannot fake** is honest people picking its members. Camouflage only adds a ring's
  outgoing picks.

## Decision

`src/ml/collusion.ts`, deterministic, in three steps:

1. **Closure:** the largest set of accounts each receiving at least half of their picks (and at
   least 2) from inside the set. Peeling finds it exactly, because removing anyone only lowers
   everyone else's share.
2. **Strongly connected parts** of that set. A ring's camouflage props up popular accounts, but they
   never pick back, so they fall into parts of their own.
3. A part is a ring when it has **≥ 3 accounts, ≥ 6 picks among them, and lift ≥ 20**.

It runs daily as the system (`src/collusion.ts`) over 180 days of picks and helpful marks, and keeps
at most 200 groups a run (migration 0025).

**What a moderator sees and decides** (Review page):

- **Genuine:** nothing changes for the group.
- **Collusion:** every award the members gave each other is taken back, with a `collusion` ledger
  row naming each award. From then on, picks between them still count but move no points, the same
  as the pair cap. Done in the database (`app.take_back_collusion`, the points guard).
- A group's decision is final, and nobody decides about a group they are in.

**Learning:** members of open or confirmed groups don't teach the search ranking (training and the
online judge) or routing (training and each person's record).

## Not built, and why

- **Sockpuppet stars:** they look exactly like a niche expert's askers in the pick graph. Shared
  networks (Review page) and new-account limits remain the defence.
- **Click fraud on search opens:** the learned search ranking reads only query–question features
  (word rank, meaning rank, answer count, age), never which question it is. So opening friends'
  questions can't lift them through learning. Training and the judge also average per person, which
  bounds any one account's influence. Accounts under review are left out anyway.
- **Rings whose members also earn many genuine picks:** they are caught about half the time. Such a
  ring is half genuine by construction, and the pair cap still bounds what each pair gains.
- **Fraudar:** kept as the measured baseline (`src/ml/fraudar.ts`), not served.
