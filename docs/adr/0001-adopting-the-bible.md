# ADR 0001: Adopting the Engineering Bible into the existing app

Date: 2026-10-19. Status: accepted by the owner.

## Context

The owner supplied `docs/GRAPHINITY_BIBLE.md` (the specification) and `docs/BUILD_PLAYBOOK.md` (ten
prompts written for an empty folder). Graphinity already exists: npm workspaces, Node 24, Fastify 5,
Supabase Postgres with forced row-level security, tested and pushed.

## Decisions (the owner's)

1. **Evolve, don't rewrite.** The Bible decides *what* Graphinity does; the existing, tested stack
   decides *how*. No pnpm, Docker, Redis/BullMQ, Kysely, Drizzle or Node 22 migration.
2. **Embeddings: Cloudflare Workers AI's free allowance**, once Cloudflare's own pages confirm it
   refuses rather than bills past the limit. Not OpenAI (paid).
3. **Sign-in stays as built** (access token in memory, refresh token in this tab's storage) until a
   custom domain exists; then `__Host-` HttpOnly cookies per Bible §16.1. Cookies can't work while
   the site (`pages.dev`) and API (`onrender.com`) are different sites.
4. **Routing pace from the Bible:** at most 3 questions a day per person; waves of 5, 5 and 5 at 0, 20
   and 60 minutes.

## What each part of the Bible becomes

Status: ✅ built and tested · ◐ in progress · ○ planned · ⤳ bent (reason given)

| Bible | Here | Status |
|---|---|---|
| §1.3 Anti-goals (no feed, no follows, no global score, no threads, no ad-tech) | Already true; kept as hard rules in CLAUDE.md | ✅ |
| §3.1 Hick/Fitts/Miller | 44px targets enforced by the browser audit; answer header ≤ 6 tokens when the consensus screen lands | ✅ / ○ |
| §4.1 "Living Nexus" logo geometry | Redraw the mark from the golden-ratio spec | ○ |
| §5 Typography tokens, tracking formula | Tokens from §5.1 with the formula; fonts: system stack first (see bends) | ○ |
| §6 OKLCH colour tokens, elevation, focus ring | Replace `tokens.css` values with §6.1; the contrast test re-checks every pair | ○ |
| §7.1 Two layers (graph behind, sheets above) | Home graph built (docs/GRAPH.md); full-screen Layer 0 to follow | ◐ |
| §7.2 Screen 1 onboarding | Built (name, country, fields); "tether to cluster" animation | ✅ / ○ |
| §7.2 Screen 2 composer + semantic intercept | Similar questions while typing (word matching) built; semantic intercept with Workers AI | ✅ / ○ |
| §7.2 Screen 3 live routing view | Built: the asker watches it travel, counts in words, "a few" under 5 | ✅ |
| §7.2 Screen 4 answers + consensus bar + 5-star | Built: consensus bar and words, "Different outcome · kept visible" pins, credibility row (medal, reputation, picks in field), 5-star radio group after picking | ✅ |
| §8.1 Springs as m·x″ + c·x′ + k·x | `spring.ts` gains the §8.1 tokens (mass, stiffness, damping) | ○ |
| §8.3 WebGPU/WebGL2 in a worker | ⤳ Canvas 2D on the main thread: at our node counts it draws in well under a millisecond, and a GPU path is a large dependency-free rewrite to justify later with measurements | ⤳ |
| §9.2 Canonical `/q/{field}/{country}/{slug}-{id}` with 301 | Today `/q/{id}/{slug}` with the address fixed in place; move with redirects | ○ |
| §11.1 Semantic dedup (≥ 0.88 intercept, 0.72 related) | Workers AI embeddings + pgvector, thresholds as written; cross-encoder rerank if the free tier allows | ○ |
| §11.2 Staged waves 5-5-5 at 0/20/60 min, 3 a day | Built and tested (wave 3's "consensus below 0.70" is "fewer than 3 answers" until consensus is stored) | ✅ |
| §11.2 11-factor routing + greedy diversity + UCB1 + load dampener | A 5-factor learning score is live (docs/GRAPH.md); replace with the 11 factors, each fed by real data as it exists | ◐ |
| §11.3 TrueSkill per field, medals | Built: replayed per field from every judgement on the server, Bible tiers replace the old points medals; the opponent gap (8) was calibrated so every bar is reachable (see reputation.ts); next: shown on profiles and answers | ◐ |
| §7.2 Screen 4 five-star rating | Built: `PUT /answers/:id/rating` (database-enforced asker-only) and the stars on the picked answer | ✅ |
| §11.4 Consensus (1D DBSCAN, entropy, minority pinning) | Built: computed on each question page from visible answers (deterministic amount reading); routing's wave 3 still uses "3 answers" until it is stored | ✅ |
| §11.5 Answer rank Ω with Wilson | Built: answers are ordered by Ω; the asker's pick and helpful mark are the only votes, so Wilson is of one vote | ✅ |
| §10.2 Edge weight evolution | Equation built and tested (clip [0.01, 0.999]); next: stored per person and field | ◐ |
| §12.2 AI only as plumbing, never authoring | Already a rule; kept | ✅ |
| §13/§14 FSD folders, hexagonal modules, CQRS outbox, BullMQ | ⤳ Kept the current structure (decision 1); new domain maths goes in pure, tested modules | ⤳ |
| §15 Postgres schema, HNSW, RLS, fillfactor | RLS forced everywhere ✅; pgvector + HNSW with embeddings; fillfactor on hot tables | ✅ / ○ |
| §15 UUIDv7 keys | ⤳ Bigint ids stay: changing every key breaks every link and test for no user benefit today | ⤳ |
| §16 Threat model | Built and documented in SECURITY.md; cookie sign-in waits for a domain (decision 3) | ✅ / ⤳ |
| §17 Cloudflare + Render + Supabase | Same providers, free tiers (PLAN.md cost rule) | ✅ |
| §18 Web vitals budgets | Lighthouse 95+/100/100/100 and size ratchet enforced; initial JS < 65 KB holds | ✅ |
| §19 `QAPage` JSON-LD, noindex until answered, sitemaps | Server-side heads exist (share.ts); add QAPage and answered-only indexing | ○ |
| §20 Accessible graph (shadow DOM nav, keyboard traversal, live region) | Captions in words today; add the keyboard-navigable `<nav>` | ○ |
| §21.2 Anti-abuse: scam filter, vote dampening | Strip phone numbers, Telegram/WhatsApp solicitation from answers; shared-network flags exist | ○ / ✅ |
| §22.1 Delete means delete | Built and tested | ✅ |
| §22.3 #12 offline drafts, #13 7-second undo, #14 optimistic versions | Drafts in IndexedDB, undo on pass/revoke, `version` checks where edits exist | ○ |
| §2.3 Bounties via Stripe (months 18–36) | Not now: needs money and legal decisions | ⤳ |
| §17.2 SLOs, PagerDuty, k6, Toxiproxy, chaos, GameDays | ⤳ Out of scope on free tiers with one server; revisit with real traffic | ⤳ |

## Bends, in one place

- **Fonts**: the Bible lists Inter first. On Apple devices the system font *is* SF Pro, which the
  Bible names as the model; Inter would replace it there and add a download. Kept the system stack
  first, Inter not loaded. Revisit if the owner wants one face on every platform.
- **GPU graph**: see §8.3 row. Canvas 2D at 30 fps, paused when hidden, still for reduced motion.
- **Keys and folders**: see §13–§15 rows.
