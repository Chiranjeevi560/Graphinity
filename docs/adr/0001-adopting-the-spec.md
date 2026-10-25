# ADR 0001: Adopting the Engineering Spec into the existing app

Date: 2026-10-19. Status: accepted by the owner.

## Context

The owner supplied `docs/SPEC.md` (the specification) and `docs/BUILD_PLAYBOOK.md` (ten
prompts written for an empty folder). Graphinity already exists: npm workspaces, Node 24, Fastify 5,
Supabase Postgres with forced row-level security, tested and pushed.

## Decisions (the owner's)

1. **Evolve, don't rewrite.** The spec decides *what* Graphinity does; the existing, tested stack
   decides *how*. No pnpm, Docker, Redis/BullMQ, Kysely, Drizzle or Node 22 migration.
2. **Embeddings: Graphinity's own model** (ADR 0010, 2026-10-25). Cloudflare Workers AI was used
   first and has been removed: the owner decided Graphinity uses no outside or pretrained AI. Its
   own PPMI-SVD-SIF model is trained daily on consented posts and serves only after beating word
   matching on held-out questions; until then search works by words.
3. **Sign-in stays as built** (access token in memory, refresh token in this tab's storage) until a
   custom domain exists; then `__Host-` HttpOnly cookies per spec §16.1. Cookies can't work while
   the site (`pages.dev`) and API (`onrender.com`) are different sites.
4. **Routing pace from the spec:** at most 3 questions a day per person; waves of 5, 5 and 5 at 0, 20
   and 60 minutes.

## What each part of the spec becomes

Status: ✅ built and tested · ◐ in progress · ○ planned · ⤳ bent (reason given)

| Spec | Here | Status |
|---|---|---|
| §1.3 Anti-goals (no feed, no follows, no global score, no threads, no ad-tech) | Already true; kept as hard rules in CLAUDE.md | ✅ |
| §3.1 Hick/Fitts/Miller | 44px targets enforced by the browser audit; answer header ≤ 6 tokens when the consensus screen lands | ✅ / ○ |
| §4.1 "Living Nexus" logo geometry | ⤳ The owner kept the current mark (three connected people); it keeps its own indigo (`--brand`) while the interface uses the spec's blue | ⤳ |
| §5 Typography tokens, tracking formula | Built: every size tracks at −0.032 + 0.42/size em (`test/type.test.ts`); fonts: system stack first (see bends) | ✅ |
| §6 OKLCH colour tokens, elevation, focus ring | Built: §6.1 tokens in `tokens.css`, double focus ring. Where the spec's colour fails 4.5:1 as text (accent on grey fills, amber, green on the picked card), a deeper text-only variant; fills keep the spec's value. The contrast test checks every pair | ✅ |
| §7.1 Two layers (graph behind, sheets above) | Home graph built (docs/GRAPH.md); full-screen Layer 0 to follow | ◐ |
| §7.2 Screen 1 onboarding | Built (name, country, fields); "tether to cluster" animation | ✅ / ○ |
| §7.2 Screen 2 composer + semantic intercept | Built: precheck at a 250 ms pause; "asked and answered recently" card first, "Mine is different" to ask anyway | ✅ |
| §7.2 Screen 3 live routing view | Built: the asker watches it travel, counts in words, "a few" under 5 | ✅ |
| §7.2 Screen 4 answers + consensus bar + 5-star | Built: consensus bar and words, "Different outcome · kept visible" pins, credibility row (medal, reputation, picks in field), 5-star radio group after picking | ✅ |
| §8.1 Springs as m·x″ + c·x′ + k·x | Built: `spring.ts` holds the table as written and converts it exactly (ω = √(k/m), ζ = c/2√(mk)). Snappy: presses, toggles. Fluid: dialogs, screens, the live banner. Spatial: a question travelling on the graph. Pulse: a person swelling as it reaches them | ✅ |
| §8.3 WebGPU/WebGL2 in a worker | ⤳ Canvas 2D on the main thread: at our node counts it draws in well under a millisecond, and a GPU path is a large dependency-free rewrite to justify later with measurements | ⤳ |
| §9.2 Canonical `/q/{field}/{country}/{slug}-{id}` with 301 | Today `/q/{id}/{slug}` with the address fixed in place; move with redirects | ○ |
| §11.1 Semantic dedup (≥ 0.88 intercept, 0.72 related) | Graphinity's own model (ADR 0010): PPMI-SVD-SIF trained on consented posts, zero-padded into pgvector `halfvec(768)` with HNSW, fused with word results by RRF. It serves only after winning its held-out gate, so in production search works by words until then. Word search also tries spelling corrections learned from the same posts (ADR 0011), once that model wins its own gate. Meaning applies to everyone, no longer behind the AI choice (ADR 0015). Bent: no cross-encoder rerank; the 0.88 / 0.72 thresholds were set for a different model and must be recalibrated on the own model's similarities once it serves | ◐ |
| §11.2 Staged waves 5-5-5 at 0/20/60 min, 3 a day | Built and tested (wave 3's "consensus below 0.70" is "fewer than 3 answers" until consensus is stored) | ✅ |
| §11.2 11-factor routing + greedy diversity + UCB1 + load dampener | Built: Ψ with φ1–φ8, UCB1 and the load dampener, each from real data (`routing-score.ts`, docs/GRAPH.md). Bent: φ4 is TrustRank from moderators (plain PageRank lets a ring pump itself); UCB1 counts only in the explore place (in the main ones it outranks proven people once a field is busy). Left out until there is data: φ3's city match, φ8's time of day (no timezones), φ9 diversity (no person-to-person weights). **Bent (ADR 0013): the α weights may be replaced by a learned model** of P(helps) from recorded factors and outcomes, only after it beats Ψ on held-out questions (asker-weighted, 99% interval, gain ≥ 0.02) and only while the owner has `learned_routing` on; the explore place stays Ψ + UCB1. **Bent (ADR 0014): with the owner's `routing_exploration` on and a model serving, the newcomer place is replaced by gated Thompson sampling** (explores only when the posterior gives ≥ 25% chance of beating exploitation's choice, at ≥ half its expected value, at most 3 times a person a week); measured in simulation (12 seeds, two worlds), the newcomer place was the costliest policy in both | ◐ |
| §11.3 TrueSkill per field, medals | Built: replayed per field from every judgement on the server, spec tiers replace the old points medals; the opponent gap (8) was calibrated so every bar is reachable (see reputation.ts); next: shown on profiles and answers | ◐ |
| §7.2 Screen 4 five-star rating | Built: `PUT /answers/:id/rating` (database-enforced asker-only) and the stars on the picked answer | ✅ |
| §11.4 Consensus (1D DBSCAN, entropy, minority pinning) | Built: computed on each question page from visible answers (deterministic amount reading); routing's wave 3 still uses "3 answers" until it is stored | ✅ |
| §11.5 Answer rank Ω with Wilson | Built: answers are ordered by Ω; the asker's pick and helpful mark are the only votes, so Wilson is of one vote | ✅ |
| §10.2 Edge weight evolution | Equation built and tested (clip [0.01, 0.999]). Not stored: none of §11.2's factors reads w(u, f, c); routing learns from the same events directly (reputation, helpful and pick rates, responsiveness). Stored when something reads it | ◐ |
| §12.2 AI only as plumbing, never authoring | Already a rule; kept | ✅ |
| §13/§14 FSD folders, hexagonal modules, CQRS outbox, BullMQ | ⤳ Kept the current structure (decision 1); new domain maths goes in pure, tested modules | ⤳ |
| §15 Postgres schema, HNSW, RLS, fillfactor | RLS forced everywhere; pgvector HNSW on question embeddings. Fillfactor: no table is updated often (routes get `seen_at` once; profiles and picks rarely), so it would only waste space; it comes with the first table that is (§10.2's weights, if stored) | ✅ / ○ |
| §15 UUIDv7 keys | ⤳ Bigint ids stay: changing every key breaks every link and test for no user benefit today | ⤳ |
| §16 Threat model | Built and documented in SECURITY.md; cookie sign-in waits for a domain (decision 3) | ✅ / ⤳ |
| §17 Cloudflare + Render + Supabase | Same providers, free tiers (PLAN.md cost rule) | ✅ |
| §18 Web vitals budgets | Lighthouse 95+/100/100/100 and size ratchet enforced; initial JS < 65 KB holds | ✅ |
| §19 `QAPage` JSON-LD, noindex until answered, sitemaps | Built: QAPage (accepted + suggested answers, each linked), `noindex, follow` until a visible answer exists (server head and app), sitemap lists answered questions dated by their latest answer. Each question page also carries its question, agreement summary and visible answers as plain HTML before any script runs (most AI crawlers run none), and the agreement sentence becomes its description. `robots.txt` lets search and citing AI assistants in (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Applebot) and refuses training-only crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, Applebot-Extended); `/llms.txt` explains how to read and cite the site. Not built: per-field sitemap shards and `/fields` hub pages (Field Atlas) | ✅ / ○ |
| §20 Accessible graph (shadow DOM nav, keyboard traversal, live region) | Built: `<nav aria-label="Fields in the graph">` over the canvas, a button per field on its cluster, one Tab stop, arrows by size, Enter opens the field's neighbourhood in words from exact pair counts (`/graph` `links`); routing milestones in a polite live region. Bent: nodes are fields, not individual experts, since who was asked is never shown. RTL (logical properties everywhere) still to do | ◐ |
| §21.2 Anti-abuse: scam filter, vote dampening | Built: answers with phone numbers, emails or messaging invitations are refused (API and database). Bent: refused with a reason rather than silently stripped, so nobody's words change without them knowing. Shared-network flags exist; vote dampening by /24 not built | ✅ / ○ |
| §22.1 Delete means delete | Built and tested | ✅ |
| §22.3 #12 offline drafts, #13 7-second undo, #14 optimistic versions | #12 built, bent: questions and answers in progress survive a reload, a crash, going offline and a failed post, in the tab's sessionStorage rather than IndexedDB, because the privacy page promises closing the tab forgets you (a draft about someone's health or visa must not stay on a shared computer); no mutation queue, since posting needs the server and the draft waits for it. #13 undo and #14 `version` checks still to do | ◐ |
| §2.3 Bounties via Stripe (months 18–36) | Not now: needs money and legal decisions | ⤳ |
| §17.2 SLOs, PagerDuty, k6, Toxiproxy, chaos, GameDays | ⤳ Out of scope on free tiers with one server; revisit with real traffic | ⤳ |

## Bends, in one place

- **Fonts**: the spec lists Inter first. On Apple devices the system font *is* SF Pro, which the
  spec names as the model; Inter would replace it there and add a download. Kept the system stack
  first, Inter not loaded. Revisit if the owner wants one face on every platform.
- **GPU graph**: see §8.3 row. Canvas 2D at 30 fps, paused when hidden, still for reduced motion.
- **Keys and folders**: see §13–§15 rows.
