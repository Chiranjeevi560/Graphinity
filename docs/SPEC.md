# Graphinity: The Complete Design, Architecture, and Engineering Specification

## 1\. Product Philosophy, Mission, and Behavioral Foundations

### 1.1 Mission and Strategic Positioning

Graphinity exists to organize human lived experience into a living, self-evolving knowledge graph. Its foundational premise is encapsulated in a single operational mandate: **Ask once. Reach people who have actually done it.**

Modern information retrieval systems occupy two extremes. Traditional web search engines index static documents, regulatory texts, and SEO-optimized articles that describe theoretical rules rather than lived reality. Large language models synthesize probabilistic averages across those same documents, smoothing over edge cases, local friction, and recent procedural shifts. Neither paradigm answers empirical, high-stakes human questions—such as the exact customs duty assessed on a ₹3,00,000 mechanical watch imported through Chennai Air Cargo last month, the specific documentation bottlenecks encountered at the clearance desk, or the informal verification steps required by local customs officers.

That empirical knowledge exists, but it is fragmented across ephemeral WhatsApp groups, Discord servers, Reddit threads, Telegram channels, and private forums. Graphinity replaces document indexing with human node routing. Every person in the system represents a persistent, multi-dimensional node whose edges are weighted by verified domain experience, geographic relevance, historical helpfulness, and peer consensus.

| Retrieval Paradigm | Primary Unit of Indexing | Core Mechanism | Fundamental Limitation | Graphinity Structural Advantage |
| :---- | :---- | :---- | :---- | :---- |
| Traditional Search Engines | Static Web Documents | Lexical & Semantic Document Matching | Surfaces generalized rules, outdated blogs, and SEO spam rather than recent lived experience | Routes directly to human practitioners with verified recent execution in the exact jurisdiction |
| Generative AI Chatbots | Pre-trained Token Distributions | Probabilistic Next-Token Synthesis | Hallucinates edge-case specifics and cannot verify real-world bureaucratic or physical outcomes | Captures ground-truth human outcomes bounded by explicit confidence and consensus distributions |
| Legacy Forums & Q\&A Sites | Static Thread Pages | Passive Broadcast (Wait-and-Hope) | High noise-to-signal ratio; questions sit unanswered unless discovered via feed scrolling | Active precision routing delivers the question strictly to the top \$K\$ qualified nodes |
| Social Networks | Follower Graphs | Engagement-Maximizing Feed Ranking | Optimizes for outrage, entertainment, and status rather than empirical accuracy | Zero social feed; edges form invisibly through verified problem-solving utility |

### 1.2 Core Principles Alignment

Graphinity's product architecture synthesizes the [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/design-principles) with the operational rigor of [Google Site Reliability Engineering](https://sre.google/books/):

1. **Purpose**: Every screen, pixel, and background worker exists strictly to reduce the latency between a human question and a verified lived-experience answer.  
2. **Agency**: Users retain complete control over their notification budgets, expertise declarations, and data footprint without algorithmic manipulation.  
3. **Responsibility**: Routing algorithms strictly enforce notification caps and cognitive load limits, treating expert attention as a scarce, non-renewable resource.  
4. **Familiarity**: Interactions rely on intuitive spatial physics and standard platform conventions rather than obscure control schemes.  
5. **Flexibility**: The interface adapts seamlessly from a 120Hz WebGPU desktop knowledge graph canvas to a screen-reader-optimized semantic tree or low-power mobile viewport.  
6. **Simplicity**: Public follower counts, karma leaderboards, decorative badges, and comment chains remain omitted. The owner's 2026-10-22 master prompt supersedes this specification's earlier prohibition on personalized feeds: finite, useful knowledge discovery and recommendations are allowed only with separate opt-in consent, visible explanations, user controls, and no engagement-maximizing objective.
7. **Craft**: Subpixel typography, optical alignment, spring physics, and deterministic database transactions receive equal engineering discipline.  
8. **Delight**: Watching a question pulse propagate across real human nodes and return structured, high-trust answers transforms information retrieval into a visceral, living experience.

### 1.3 Anti-Goals: What Graphinity Never Builds

Institutional discipline requires explicit architectural prohibitions. Graphinity enforces the following non-negotiable anti-goals:

* **No Infinite Social Feeds**: Users never scroll an engagement-maximizing endless timeline. The later 2026-10-22 owner requirement permits finite, consented, explainable knowledge recommendations and personalized discovery. The implemented finite recommendation baseline uses versioned reciprocal-rank fusion; adaptive learned recommendations remain unimplemented.
* **No Public Follower Graphs**: Users cannot manually follow, friend, or subscribe to other users. Graph edges are computed exclusively by the backend topology engine based on domain overlap, co-answering similarity, and verified helpfulness.  
* **No Global Reputation Score**: A user's credibility in `Imports -> India` transfers zero weight to `Programming` or `Watches`. Reputation is strictly partitioned by `(field_id, country_code)` tuples.  
* **No Nested Argument Threads**: Answers are structured, standalone empirical reports. Disagreements are resolved mathematically through the Consensus Engine and structured confidence distributions rather than adversarial reply chains.  
* **No Ad-Tech Surveillance**: Graphinity prohibits third-party tracking pixels, behavioral ad profiling, and data brokerage.

### 1.4 Network Effects and Behavioral Economics

Graphinity engineers a **Double-Sided Epistemic Network Effect**. Every question asked refines the semantic duplicate index; every answer submitted updates edge weights, Bayesian trust priors, and consensus distributions. Unlike social networks that suffer from eternal September degradation (where scale dilutes quality), Graphinity increases in precision as node density grows because higher node density permits narrower multi-variable routing constraints.

---

## 2\. Business Architecture, Market Dynamics, and Monetization

### 2.1 Market Sizing (TAM / SAM / SOM)

Graphinity operates at the intersection of the global knowledge management market, expert networks, and specialized consumer/professional search:

| Market Tier | Scope Definition | Annual Valuation Estimate | Primary Demand Drivers |
| :---- | :---- | :---- | :---- |
| **TAM** (Total Addressable Market) | Global information retrieval, expert consultation networks, and specialized Q\&A platforms | \$142.0 Billion | 5.4B internet users seeking high-stakes empirical guidance across cross-border commerce, legal/customs, relocation, healthcare navigation, and engineering |
| **SAM** (Serviceable Available Market) | High-intent empirical queries across cross-border trade, immigration/study abroad, specialized hardware/luxury goods, and technical operations in Tier-1/Tier-2 digital economies | \$18.4 Billion | 420M professionals, expats, importers, and technical specialists facing opaque regulatory or operational processes |
| **SOM** (Serviceable Obtainable Market \- Years 1–3) | English-first high-friction verticals (India/US/UK/EU/UAE cross-border imports, study abroad, specialized engineering, luxury horology/electronics) | \$460.0 Million | Early-adopter cohorts migrating from fragmented Reddit/Discord/WhatsApp communities |

### 2.2 Competitor Teardown

| Platform | Core Mechanism | Fatal Flaw for Lived Experience | Graphinity Structural Counter-Measure |
| :---- | :---- | :---- | :---- |
| **Reddit** | Subreddit broadcast \+ upvote sorting | Early jokes and generic opinions dominate via velocity; domain experts rarely monitor `new` queues | Precision push routing to verified practitioners; structured empirical fields instead of free-text threads |
| **Quora** | Broad topic feeds \+ LLM synthesis | Overrun by AI-generated boilerplate and self-promotional essays | Strict field-specific empirical verification and Bayesian trust weighting |
| **StackOverflow** | Strict canonical Q\&A wiki | Hostile closure culture toward subjective or jurisdiction-specific lived experiences | Embraces variance via the Consensus Engine (surfacing both majority and minority empirical outcomes) |
| **GLG / AlphaSights** | Manual human brokered phone calls (\$1,000+/hr) | Prohibitive cost and multi-day scheduling latency | Sub-minute algorithmic routing with asynchronous structured micro-reports |

### 2.3 Unit Economics, Pricing Psychology, and Monetization Roadmap

Graphinity preserves free core access to maximize node density while monetizing high-stakes commercial velocity and enterprise intelligence:

1. **Phase 1 (Months 1–18): Pure Network Density & Liquidity**: 100% free usage to seed dense node clusters across 50 core fields and 30 countries. Target North Star metric: **Verified Resolution Rate within 4 Hours (\$VRR\_4\$)**.  
2. **Phase 2 (Months 18–36): Priority Routing & Verified Bounties (Graphinity Pro)**: Users facing urgent, high-value decisions (e.g., clearing a commercial shipment or verifying a cross-border tax filing) can attach an optional escrow bounty (\$10–\$250) via Stripe Connect, with a 15% platform take rate.  
3. **Phase 3 (Months 36–60): Enterprise Epistemic API**: anonymized, aggregated consensus distributions exposed via API to logistics providers, relocation firms, and compliance teams.

| Metric | Target Benchmark (Month 24\) | Mathematical Definition / Notes |
| :---- | :---- | :---- |
| **CAC** (Customer Acquisition Cost) | \$1.85 (Organic SEO \+ Referral Loop) | Driven by Schema.org `QAPage` long-tail indexing and answered-question sharing |
| **LTV** (Lifetime Value \- Blended) | \$24.60 | Computed across Pro subscriptions (\$9/mo) and bounty take-rates over 36-month cohort |
| **LTV : CAC Ratio** | \$13.3 : 1\$ | Exceeds SaaS benchmark (\$3:1\$) due to zero-cost user-generated semantic index |
| **Viral Coefficient (\$K\$-factor)** | \$1.18\$ | Triggered when experts share verified field medals and askers share consensus cards |
| **Gross Margin** | \$84.2%\$ | Low compute overhead via hybrid PostgreSQL `pgvector` \+ Cloudflare Edge caching |

---

## 3\. Human Psychology, Cognitive Ergonomics, and UX Research

### 3.1 Cognitive Laws Governing the Interface

Every layout and interaction flow in Graphinity is governed by quantitative human factors engineering:

* **Hick's Law** (\$RT \= a \+ b \\log\_2(n)\$): Decision reaction time increases logarithmically with the number of choices. During question creation, Graphinity restricts top-level inputs to exactly three sequential controls: **Field**, **Country**, and **Natural Language Inquiry**. During answer evaluation, the asker selects a single **Best Answer** toggle and a 5-point rating scale.  
* **Fitts' Law** (\$MT \= a \+ b \\log\_2(\\frac{2D}{W})\$): Movement time to a target depends on distance \$D\$ and target width \$W\$. All primary interactive nodes and action buttons maintain a minimum hit target of \$44 \\times 44\\text{ CSS px}\$ on touch devices and \$36 \\times 36\\text{ CSS px}\$ on pointer devices, positioned within natural thumb arcs on mobile viewports.  
* **Miller's Law (\$7 \\pm 2\$ Working Memory Limit)**: An answer card displays at most 6 distinct metadata tokens in the peripheral header (`Username`, `Country`, `Field Medal`, `Trust Score`, `Experience Count`, `Confidence Badge`), grouped into two visual chunks of 3 tokens so the user parses credibility in under \$350\\text{ ms}\$.  
* **Progressive Disclosure**: Advanced mathematical provenance (exact routing path, consensus variance histograms, raw trust score breakdown) remains hidden behind a subtle secondary inspect gesture, preserving large whitespace on the primary canvas.

### 3.2 User Personas and Journey Maps

| Persona | Primary Goal | Cognitive Friction Point | Architectural Solution |
| :---- | :---- | :---- | :---- |
| **The High-Stakes Asker** (e.g., importing a ₹3L watch via Chennai) | Needs exact empirical numbers, hidden pitfalls, and real customs outcomes | Fear of outdated regulatory articles or generic forum speculation | Pre-submission semantic deduplication \+ live visual routing pulse \+ consensus distribution bar |
| **The Domain Practitioner** (e.g., seasoned watch collector in India) | Wants to help peers with genuine problems without wading through repetitive newbie spam | Notification fatigue and lack of recognition for specialized local knowledge | Strict daily notification budget (\$N \\le 3\$/day) \+ duplicate suppression \+ persistent field-specific medal progression |

### 3.3 Trust Building Architecture

Users trust Graphinity because the interface exposes **epistemic provenance**:

1. Every answer displays how many times the responder has previously been selected as the Best Answer in that exact `(Field, Country)` pair.  
2. When multiple answers arrive, the Consensus Engine visually groups numerical or categorical claims (e.g., `70% report ₹95,000 customs duty | 20% report ₹80,000 | 10% report ₹1,40,000`), preventing a single outlier from misleading the asker while keeping minority edge cases fully visible.

---

## 4\. Visual Design Mathematics, Brand Identity, and Logo Geometry

### 4.1 Brand Philosophy and Logo Analysis

A comparative study of iconic technology marks reveals distinct geometric archetypes:

* **Apple**: Uses cross-platform continuity and non-Euclidean G2 continuous curvature (squircle superellipses) so hardware and software silhouettes share identical tangent transitions.  
* **OpenAI / Claude / Perplexity / Gemini**: Employ radial symmetry (rotational floral knots, asterisks, starbursts, and four-point spark curves) symbolizing centralized synthesis radiating outward.  
* **Stripe / GitHub / Meta**: Use structural parallelism, approachable character silhouettes, or continuous topological loops (Möbius/infinity curves) representing flow and connection.

**Graphinity's Logo Geometry ("The Living Nexus")**: Unlike AI brands that radiate from a single central brain, Graphinity represents **peer-to-peer human topology**. The mark is constructed on a \$24 \\times 24\$ mathematical grid using the golden ratio (\$\\phi \= \\frac{1 \+ \\sqrt{5}}{2} \\approx 1.6180339887\$):

* **Structure**: Two interlocking, asymmetric orbital loops forming a continuous lemniscate (infinity path) intersected by three circular human nodes positioned at golden-ratio phase angles (\$\\theta\_1 \= 0^\\circ, \\theta\_2 \= 137.5^\\circ, \\theta\_3 \= 275^\\circ\$).  
* **Node Radii**: Primary origin node radius \$R\_1 \= 2.0\\text{ units}\$; expert target node radius \$R\_2 \= R\_1 / \\sqrt{\\phi} \= 1.572\\text{ units}\$; tertiary consensus node radius \$R\_3 \= R\_1 / \\phi \= 1.236\\text{ units}\$.  
* **Bezier Continuity**: All connecting edges use cubic Bézier curves \$B(t) \= (1-t)^3 P\_0 \+ 3(1-t)^2 t P\_1 \+ 3(1-t) t^2 P\_2 \+ t^3 P\_3\$ with matched second derivatives (\$G^2\$ curvature continuity) at node entry gates, eliminating abrupt visual kinks.  
* **Optical Center Correction**: Because the left orbital loop carries the larger origin node (\$R\_1\$), the geometric bounding-box center is shifted \$+0.42\\text{ units}\$ right on the horizontal axis so the visual center of mass aligns with the container midpoint.

### 4.2 Grid Mathematics, Squircles, and Optical Alignment

* **Base Spatial Grid**: \$8\\text{ px}\$ structural grid with a \$4\\text{ px}\$ sub-grid for micro-typography and icon padding.  
* **Corner Radius System (Continuous Curvature)**: Standard CSS `border-radius` creates a harsh \$G^1\$ discontinuity where the straight edge meets the circular arc. Graphinity uses superellipse masks (\$|x/a|^n \+ |y/b|^n \= 1\$ with \$n \= 4.5\$) and nested radius math where outer container radius \$R\_{\\text{outer}}\$ and padding \$P\$ dictate inner radius \$R\_{\\text{inner}} \= \\max(R\_{\\text{outer}} \- P, 4\\text{px})\$.  
* **Pixel Snapping**: All vector coordinates on the HTML5/WebGPU canvas snap to device physical pixels via `Math.round(coord * window.devicePixelRatio) / window.devicePixelRatio` when stationary, preventing subpixel blur on 1x and 2x displays.

---

## 5\. Typography Engineering and Multilingual Rendering

### 5.1 Typeface Architecture and Optical Metrics

Graphinity uses a dual-axis variable font stack engineered for zero layout shift and extreme legibility across dense numerical customs data and long-form narrative experience reports:

* **Primary UI & Prose Stack**: `'Inter Variable', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`  
* **Monospace & Telemetry Stack** (used for currency figures, trust coefficients, node IDs, and timestamps): `'JetBrains Mono Variable', 'SF Mono', ui-monospace, monospace` with `font-variant-numeric: tabular-nums slashed-zero`.

| Typographic Token | Font Size (`rem` / `px`) | Line Height (`leading`) | Tracking (`letter-spacing`) | Optical Size (`opsz`) | Font Weight (`wght`) | Primary Usage |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| `--font-display-xl` | `2.5rem` (`40px`) | `1.12` (`44.8px`) | `-0.028em` | `32` | `620` | Inquiry Hero Canvas Prompt |
| `--font-heading-lg` | `1.75rem` (`28px`) | `1.20` (`33.6px`) | `-0.021em` | `28` | `600` | Question Node Primary Title |
| `--font-heading-md` | `1.25rem` (`20px`) | `1.30` (`26.0px`) | `-0.014em` | `20` | `580` | Consensus Summary & Section Headers |
| `--font-body-lg` | `1.0625rem` (`17px`) | `1.55` (`26.35px`) | `-0.006em` | `17` | `400` | Empirical Answer Body Copy (Apple HIG 17pt standard) |
| `--font-body-sm` | `0.875rem` (`14px`) | `1.45` (`20.3px`) | `+0.002em` | `14` | `450` | Secondary Metadata, Routing Telemetry |
| `--font-micro-mono` | `0.75rem` (`12px`) | `1.35` (`16.2px`) | `+0.025em` | `12` | `520` | Trust Badges, Field Medals, Confidence Intervals |

### 5.2 Dynamic Tracking Formula and Rendering Optimization

Following Apple's SF Pro optical sizing curve, tracking adjusts dynamically inversely to point size \$S\$: \$\$\\text{Tracking}(S) \= \-0.032 \+ \\frac{0.42}{S} \\text{ em}\$\$ This tightens display headlines for cohesive word shapes while opening micro-labels (`12px`) so ascenders, descenders, and high x-height (\$0.53\\text{ em}\$) counters remain open under grayscale anti-aliasing (`-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility`).

### 5.3 Font Loading and Multilingual Support

Self-hosted WOFF2 variable subsets (`latin`, `latin-ext`, `devanagari`, `tamil`, `arabic`, `cjk`) are preloaded in `<head>` with `rel="preload" as="font" type="font/woff2" crossorigin`. Metric-compatible fallback overrides (`size-adjust: 100.06%`, `ascent-override: 90.2%`, `descent-override: 22.4%`) guarantee `CLS = 0.000` during initial hydration. Currency symbols (`₹`, `$`, `€`, `£`, `¥`) and localized scripts render with automatic vertical metric expansion (`line-height: 1.65` for Indic and Arabic scripts) so diacritics and matras never clip.

---

## 6\. Design System, Color Science, and Design Tokens

### 6.1 Perceptual Color Science (OKLCH)

Instead of sRGB or HSL—where a `50%` lightness blue appears drastically darker to the human eye than a `50%` lightness yellow—Graphinity defines its entire palette in the **OKLCH perceptual color space** (`oklch(Lightness Chroma Hue)`). Equal lightness values \$L\$ guarantee identical perceived luminance and deterministic [WCAG 2.2](https://www.w3.org/TR/WCAG22/) contrast ratios across light and dark modes.

| Token Name | Light Mode (`oklch`) | Dark Mode (`oklch`) | Contrast Ratio vs Surface | Semantic Role |
| :---- | :---- | :---- | :---- | :---- |
| `--surface-canvas` | `oklch(0.985 0.003 250)` | `oklch(0.135 0.008 255)` | Base Surface | Primary Living Graph & Page Background |
| `--surface-card` | `oklch(1.000 0.000 0)` | `oklch(0.178 0.010 255)` | `1.08 : 1` (Subtle Elevation) | Question & Answer Container Surface |
| `--surface-glass` | `oklch(0.990 0.004 250 / 0.78)` | `oklch(0.195 0.012 255 / 0.75)` | Backdrop `blur(20px)` | Floating HUD & Graph Inspector Overlay |
| `--text-primary` | `oklch(0.165 0.012 255)` | `oklch(0.955 0.005 250)` | `15.8 : 1` (AAA) | Primary Questions, Answers, Node Titles |
| `--text-secondary` | `oklch(0.445 0.018 255)` | `oklch(0.720 0.015 250)` | `6.4 : 1` (AA+) | Metadata, Timestamps, Field Subtitles |
| `--accent-pulse` | `oklch(0.550 0.195 252)` | `oklch(0.680 0.180 252)` | `4.9 : 1` (AA) | Active Question Routing Pulse & Primary Focus |
| `--status-consensus` | `oklch(0.520 0.145 158)` | `oklch(0.710 0.140 158)` | `5.1 : 1` (AA) | High-Agreement Consensus & Best Answer Node |
| `--status-variance` | `oklch(0.580 0.160 68)` | `oklch(0.760 0.155 68)` | `5.4 : 1` (AA) | Minority Empirical Outcome / Edge Case |
| `--status-danger` | `oklch(0.510 0.190 25)` | `oklch(0.690 0.185 25)` | `5.0 : 1` (AA) | Flagged Discrepancy / Destructive Action |

### 6.2 Spacing, Elevation, and Focus Rings

* **Spacing Scale**: Pure geometric progression anchored on \$4\\text{ px}\$: `4px` (`--space-1`), `8px` (`--space-2`), `12px` (`--space-3`), `16px` (`--space-4`), `24px` (`--space-6`), `32px` (`--space-8`), `48px` (`--space-12`), `64px` (`--space-16`), `96px` (`--space-24`). Minimum `38%` of every viewport must remain unencumbered whitespace (`--surface-canvas`) so the ambient knowledge graph breathes.  
* **Elevation**: Zero heavy drop shadows. In Light Mode, cards use a `1px` solid border (`oklch(0.91 0.008 250)`) paired with a dual-layer ambient shadow (`0 1px 2px oklch(0.15 0.01 255 / 0.04), 0 8px 24px oklch(0.15 0.01 255 / 0.04)`). In Dark Mode, elevation is communicated via lighter surface luminance (`--surface-card` vs `--surface-canvas`) and a top-edge specular hairline (`inset 0 1px 0 oklch(1 0 0 / 0.07)`).  
* **Focus Ring**: Keyboard navigation renders a high-visibility double ring: `outline: 2px solid var(--accent-pulse); outline-offset: 2px; box-shadow: 0 0 0 4px var(--surface-canvas)`.

---

## 7\. Interface Architecture and Screen-by-Screen Specifications

### 7.1 The Dual-Layer Spatial Architecture

Graphinity rejects the traditional top-navbar-plus-three-column-feed layout. Instead, the application consists of two synchronized spatial planes:

1. **Layer 0 (The Living Graph Canvas)**: A hardware-accelerated WebGPU/WebGL2 force-directed topological canvas spanning `100vw x 100vh`. In passive states, it renders at `18%` opacity in the peripheral background, gently drifting at `0.04 rad/s` to show real-time global knowledge pulses within the user's selected fields. When a user asks a question or inspects routing, Layer 0 smoothly transitions to `100%` opacity and centers on the active subgraph.  
2. **Layer 1 (The Epistemic Workplane)**: Translucent, high-craft typographic sheets centered on a `720px` single-column reading axis (`max-width: 720px`, `margin: 0 auto`, `padding: 48px 24px`) that float above the graph canvas.

### 7.2 Screen-by-Screen Pixel Specifications

#### Screen 1: Onboarding & Node Genesis

* **Step 1**: Single centered glass card (`420px` width, `24px` squircle radius, `32px` internal padding). Button: "Continue with Google" (OAuth 2.0 \+ PKCE).  
* **Step 2**: Upon token exchange, the user's node materializes at the center of Layer 0 (`(0.5vw, 0.5vh)`).  
* **Step 3**: Three minimal inputs:  
  * `@username` (debounced `150ms` uniqueness check against PostgreSQL `citext` index).  
  * `Country` (auto-detected via Cloudflare `CF-IPCountry` header with instant searchable selector).  
  * `Expertise Fields` (pill selector from canonical taxonomy; selecting a pill physically spawns a weighted tether from the user's center node to that field cluster in the background canvas).

#### Screen 2: The Inquiry Composer & Semantic Intercept

* **Header**: Compact pill bar (`height: 36px`, `gap: 8px`) where the user selects `Field` (e.g., `Imports`) and `Country` (e.g., `India`).  
* **Input**: Auto-expanding borderless textarea set in `--font-display-xl` (`40px`, smoothly scaling down to `24px` past 120 characters). Placeholder: *"Ask people who've actually done it..."*  
* **Real-Time Semantic Intercept**: As the user pauses typing for `250ms` (or clicks Continue), the frontend dispatches the text to `/api/v1/questions/precheck`.  
  * If cosine similarity \$\\ge 0.88\$ and cross-encoder probability \$\\ge 0.85\$ against an existing resolved question in the same `(Field, Country)`, a translucent **Semantic Match Sheet** slides up (`spring(mass: 1, stiffness: 280, damping: 28)`) stating: *"This exact experience was documented recently."* It previews the top consensus summary and verified answers immediately, preventing duplicate creation while offering a secondary *"My situation differs — route a new question"* override.

#### Screen 3: Live Routing Telemetry View

* When a new question node is committed, the composer sheet collapses into a top HUD pill (`height: 48px`), and Layer 0 takes center stage.  
* The user's node illuminates (`--accent-pulse`). A glowing photon wave travels along the highest-weighted edges to the top \$K\$ (default \$K \= 15\$) selected expert nodes.  
* An understated telemetry caption at the bottom reads: *"Routing to 14 verified Imports practitioners in India (92% historical response rate · est. first empirical report in 18 mins)."*  
* No fake animations: Every node shown on the canvas corresponds 1:1 to an anonymized subgraph descriptor streamed via Server-Sent Events (SSE) from the routing worker.

#### Screen 4: The Empirical Answer Workspace & Consensus Bar

* **Consensus Header Card**: Once \$\\ge 3\$ answers arrive containing structured quantities (e.g., customs duty paid, processing days), a horizontal stacked bar (`height: 12px`, `border-radius: 6px`) renders at the top of the thread showing the empirical distribution:  
  * Majority Cluster (`--status-consensus`): `70% (7 nodes) · ₹92,000 – ₹98,000`  
  * Secondary Cluster (`--accent-pulse`): `20% (2 nodes) · ₹80,000`  
  * Outlier Cluster (`--status-variance`): `10% (1 node) · ₹1,40,000 (Included penalty assessment)`  
* **Answer Cards**: Stacked vertically with `24px` gap. Each card displays:  
  * **Top Credibility Row**: `@username` · `Country Flag/ISO` · `Field Medal (Gold/Silver/Bronze/Verified)` · `Field Reputation Score (e.g., 94.2)` · `Experience Count (19 verified answers in Imports · India)` · `Confidence Indicator (High · Direct first-hand within 30 days)`.  
  * **Body**: Clean Markdown prose (`17px`, `65ch` max measure) structured into *What Actually Happened*, *Exact Cost / Timeline*, and *Mistakes to Avoid*.  
  * **Footer**: `Helpful (Count)` button and (for the asker) a single `Select Best Answer` action that opens a 1-click 5-star empirical accuracy confirmation.

### 7.3 Exhaustive State Matrix

| Component | Loading State | Empty State | Error State | Hover / Focus / Gesture |
| :---- | :---- | :---- | :---- | :---- |
| **Graph Canvas** | Skeleton constellation with subtle `0.6Hz` luminance breathing | Single user node anchored to selected field centroids; prompt to ask or verify first question | Graceful fallback to static SVG topology with automatic WebGL context restore listener | Pinch-to-zoom (`0.25x`–`4.0x`), two-finger pan, hover node highlights 1-hop neighborhood within `16ms` |
| **Semantic Precheck** | Subtle `2px` indeterminate progress hairline beneath composer | N/A (Proceeds directly to routing preview) | Non-blocking toast; allows direct question submission with async background deduplication | `Cmd/Ctrl + Enter` submits; `Esc` dismisses match sheet |
| **Answer Stream** | Shimmering skeleton card matching exact typography line heights | Live routing pulse indicator showing active expert nodes reviewing the inquiry | Inline retry banner with cached IndexedDB snapshot preserved | Swipe-right on mobile marks Helpful with medium haptic impact (`navigator.vibrate(10)`) |

---

## 8\. Physics-Based Animation, 120Hz Pacing, and GPU Rendering

### 8.1 Spring Physics Mathematics

Graphinity bans linear and arbitrary cubic-bezier duration timers (`ease-in-out`, `300ms`) for interactive UI transitions. Every sheet, modal, node expansion, and layout transition is driven by a damped harmonic oscillator differential equation: \$\$m \\frac{d^2x}{dt^2} \+ c \\frac{dx}{dt} \+ k x \= 0\$\$ where \$m\$ is mass, \$k\$ is spring stiffness, \$c\$ is the damping coefficient, and the damping ratio is \$\\zeta \= \\frac{c}{2\\sqrt{mk}}\$.

| Motion Token | Mass (\$m\$) | Stiffness (\$k\$) | Damping (\$c\$) | Damping Ratio (\$\\zeta\$) | Perceptual Behavior & Application |
| :---- | :---- | :---- | :---- | :---- | :---- |
| `--spring-snappy` | `1.0` | `380` | `34` | `0.872` (Critically damped approach) | Micro-interactions, button presses, pill toggles, tooltips |
| `--spring-fluid` | `1.0` | `260` | `28` | `0.868` (Zero harsh overshoot) | Semantic match sheets, answer card insertions, panel morphs |
| `--spring-spatial` | `1.2` | `140` | `24` | `0.925` (Overdamped silk glide) | Camera pan/zoom across the Living Knowledge Graph canvas |
| `--spring-pulse` | `0.8` | `180` | `16` | `0.667` (Gentle organic resonance) | Node arrival glow when a question pulse reaches an expert |

### 8.2 Interruptibility and Velocity Preservation

When a user interrupts an in-flight transition (e.g., dragging a sheet down while it is still springing upward), the animation engine never snaps or resets velocity to zero. It samples the instantaneous velocity \$v(t) \= \\frac{dx}{dt}\$ from the current frame and injects \$v(t)\$ as the initial velocity \$v\_0\$ of the new target spring solver, maintaining physical momentum continuity.

### 8.3 120Hz ProMotion Frame Pacing and GPU Instanced Rendering

* **Delta-Time Integration**: The graph physics loop integrates using Semi-Implicit Euler / Runge-Kutta (RK4) parameterized by actual frame delta \$\\Delta t \= \\min(t\_{\\text{now}} \- t\_{\\text{prev}}, 33.3\\text{ms})\$, running natively at `120Hz` (`8.33ms` frame budget) on ProMotion displays and `60Hz` (`16.67ms` budget) on standard monitors.  
* **Instanced WebGPU / WebGL2 Shaders**: To render up to 10,000 visible nodes and 25,000 edges at `120fps` with \$\< 4%\$ CPU utilization, nodes are drawn in a single `drawArraysInstanced` call using a Signed Distance Field (SDF) circle fragment shader with analytical anti-aliasing (`fwidth`). Question pulses traveling along edges are computed entirely in the vertex/fragment shader by passing a `vec4(start_time, duration, source_pos, target_pos)` attribute buffer—zero JavaScript object allocations occur during animation frames.

---

## 9\. Information Architecture and URL Canonicalization

### 9.1 Navigation Topology

Graphinity eliminates deep hierarchical menus. The entire application consists of four top-level spatial contexts accessible via a unified floating command bar (`Cmd+K` or top-center Segmented Control):

1. **Ask & Explore (`/`)**: The primary inquiry composer overlaid on the user's personalized knowledge graph neighborhood.  
2. **Routing Inbox (`/inbox`)**: Questions specifically routed to the user based on their verified expertise, paired with their active asked questions awaiting resolution.  
3. **Field Atlas (`/fields/:fieldSlug/:countryIso?`)**: The canonical index of resolved empirical questions, consensus benchmarks, and top practitioners within a specific field and country.  
4. **Node Identity (`/u/:username`)**: The user's topological profile showing independent field rings, verified resolution metrics, and notification budget controls.

### 9.2 Deterministic URL Canonicalization

Every question node has a permanent, human-readable, SEO-canonical URL: `https://graphinity.com/q/{field-slug}/{country-iso}/{semantic-slug}-{short-ulid}` Example: `https://graphinity.com/q/imports/in/rolex-watch-customs-duty-chennai-01j9x8k2m4`

If a user visits an older or duplicate URL, a `301 Moved Permanently` edge redirect routes immediately to the canonical question node.

---

## 10\. Living Knowledge Graph Architecture

### 10.1 Mathematical Definition of the Graph

Graphinity models the global network as a **Heterogeneous Directed Temporal Attributed Multigraph**: \$\$\\mathcal{G}(t) \= (\\mathcal{V}, \\mathcal{E}(t), \\mathcal{T}\_V, \\mathcal{T}\_E, \\mathbf{W}(t))\$\$

#### Node Types (\$\\mathcal{T}\_V\$):

1. **Person Node (\$u \\in \\mathcal{V}\_U\$)**: Attributes include `user_id`, `country_iso`, `activity_decay_factor`, `notification_budget_remaining`, `global_sybil_resistance_score`, and a sparse map of Field State Vectors \$\\mathbf{F}\_{u, f, c}\$.  
2. **Question Node (\$q \\in \\mathcal{V}\_Q\$)**: Attributes include `question_id`, `author_id`, `field_id`, `country_iso`, `embedding` (\$\\mathbb{R}^{1536}\$), `intent_vector`, `status` (`ROUTING | ANSWERED | CONSENSUS_LOCKED`), `created_at`, and `consensus_summary`.  
3. **Field Node (\$f \\in \\mathcal{V}\_F\$)**: Canonical hierarchical domain taxonomy node (e.g., `Logistics & Customs -> Personal Imports -> Horology & Luxury Goods`).  
4. **Location Node (\$c \\in \\mathcal{V}\_C\$)**: ISO-3166-1 alpha-2 country and ISO-3166-2 sub-region (e.g., `IN`, `IN-TN` for Tamil Nadu / Chennai).

#### Edge Types (\$\\mathcal{T}\_E\$) and Dynamic Weights (\$\\mathbf{W}(t)\$):

1. **Expertise Edge (\$e\_{u \\to (f, c)}\$)**: Connects a user \$u\$ to a `(Field, Country)` tuple. Weight \$w\_{u,f,c}(t) \\in \[0, 1\]\$ represents verified competence.  
2. **Epistemic Affinity Edge (\$e\_{u\_i \\leftrightarrow u\_j}^{(f)}\$)**: An invisible, automatically learned weighted edge between two users \$u\_i\$ and \$u\_j\$ who consistently provide high-rated answers to semantically proximate questions within field \$f\$.  
3. **Routing & Resolution Edge (\$e\_{q \\to u}\$ and \$e\_{u \\to q}\$)**: Records when question \$q\$ was routed to expert \$u\$, response latency \$\\Delta \\tau\$, helpfulness votes, and whether \$u\$'s answer was crowned Best Answer.

### 10.2 Dynamic Edge Weight Evolution Equation

When expert \$u\$ submits an answer \$a\$ to question \$q\$ asked by user \$u\_{\\text{ask}}\$ in field \$f\$ and country \$c\$, the expertise weight \$w\_{u,f,c}\$ and the inter-person epistemic edge \$w\_{u\_{\\text{ask}}, u}^{(f)}\$ update atomically upon rating or consensus confirmation:

\$\$w\_{u, f, c}(t^+) \= \\text{clip}\\left( w\_{u, f, c}(t) \\cdot e^{-\\lambda \\Delta t} \+ \\eta \\cdot \\mathcal{R}(a, q) \\cdot \\left(1 \- w\_{u, f, c}(t)\\right), ; 0.01, ; 0.999 \\right)\$\$

where:

* \$\\lambda \= \\frac{\\ln(2)}{T\_{1/2}}\$ is the temporal decay constant (with field-specific half-life \$T\_{1/2} \= 180\\text{ days}\$ for rapidly changing regulatory fields like `Imports`, and \$T\_{1/2} \= 730\\text{ days}\$ for stable fields like `Mathematics`).  
* \$\\eta \= 0.08\$ is the learning rate.  
* \$\\mathcal{R}(a, q) \\in \[-1.0, \+1.5\]\$ is the composite reinforcement signal:  
  * \$+1.50\$ if selected as Best Answer with rating \$\\ge 4\$ stars and aligned with or validated by subsequent peer consensus.  
  * \$+0.65\$ if not selected as Best Answer (since only one can be chosen) but rated Helpful by the asker or aligned within \$1\\sigma\$ of the consensus distribution.  
  * \$-0.05\$ if routed and read by the expert but ignored without clicking "Pass / Outside my exact experience" (soft responsiveness decay).  
  * \$-0.80\$ if verified as factually false or spam by moderator/peer review.

---

## 11\. Core Mathematical Algorithms

### 11.1 Pre-Ask Semantic Deduplication Pipeline

Before creating a new question node, Graphinity executes a 3-stage hybrid semantic verification pipeline in \$\< 95\\text{ ms}\$:

1. **Stage 1: Structured Entity & Intent Extraction**: Fast regex \+ lightweight ONNX token classifier extracts hard constraints: `Field`, `Country`, `Sub-Location` (e.g., `Chennai`), `Object/Category` (`Watch / Rolex`), and `Metric Sought` (`Customs Duty`).  
2. **Stage 2: Hybrid Dense \+ Sparse Retrieval**: Queries PostgreSQL combining `pgvector` HNSW cosine similarity (\$S\_{\\text{dense}}\$) and BM25 tsvector lexical score (\$S\_{\\text{lexical}}\$) restricted to `field_id = $1 AND country_iso = $2`.  
3. **Stage 3: Cross-Encoder Equivalence Scoring**: The top 10 candidates are passed through a quantized cross-encoder (`bge-reranker-v2-m3`) that scores exact semantic equivalence \$P\_{\\text{dup}}(q\_{\\text{new}}, q\_i) \\in \[0, 1\]\$:  
   * If \$P\_{\\text{dup}} \\ge 0.88\$ and the existing question has \$\\ge 1\$ verified answer within the field's freshness window (\$180\\text{ days}\$), Graphinity intercepts creation and presents the existing resolution immediately.  
   * If \$0.72 \\le P\_{\\text{dup}} \< 0.88\$, Graphinity shows related questions in a side-by-side preview while permitting the user to spawn a new question node linked via a `SIMILAR_TO` graph edge.

### 11.2 The 11-Factor Intelligent Routing Algorithm

Questions are **never** broadcast to everyone. Given a new question \$q\$ with embedding \$\\mathbf{v}*q \\in \\mathbb{R}^{1536}\$ in field \$f\$ and country \$c\$, the Routing Engine filters candidate nodes \$u \\in \\mathcal{C}*{f,c}\$ (where `notification_budget_remaining > 0` and `u != author`) and ranks them using the multi-factor routing score \$\\Psi(u, q)\$:

\$\$\\Psi(u, q) \= \\mathbb{I}*{\\text{budget}}(u) \\cdot \\left\[ \\sum*{k=1}^{9} \\alpha\_k \\cdot \\phi\_k(u, q) \+ \\beta\_{\\text{cold}} \\cdot \\Omega\_{\\text{cold}}(u, f) \\right\] \\cdot \\Gamma\_{\\text{load}}(u)\$\$

The exact normalized factors \$\\phi\_k(u, q) \\in \[0, 1\]\$ and production weights \$\\alpha\_k\$ are specified below:

| Factor Symbol | Factor Name | Weight (\$\\alpha\_k\$) | Mathematical Formulation | Why It Exists |
| :---- | :---- | :---- | :---- | :---- |
| \$\\phi\_1(u, q)\$ | **Semantic Experience Proximity** | `0.24` | \$\\max\_{q' \\in \\mathcal{H}\_u} \\cos(\\mathbf{v}*q, \\mathbf{v}*{q'})\$ over user \$u\$'s historical answered questions \$\\mathcal{H}\_u\$ | Routes "Chennai watch customs" specifically to someone who answered about Chennai air cargo or luxury imports, not just general imports |
| \$\\phi\_2(u, q)\$ | **Field Reputation (TrueSkill \$\\mu \- 3\\sigma\$)** | `0.18` | \$\\text{sigmoid}\\left(\\frac{\\mu\_{u,f} \- 3\\sigma\_{u,f} \- 25}{8.33}\\right)\$ | Prioritizes proven, low-uncertainty domain experts in field \$f\$ |
| \$\\phi\_3(u, q)\$ | **Country & Sub-Region Match** | `0.15` | \$1.0\$ if exact city/port match; \$0.8\$ if resident of country \$c\$; \$0.5\$ if verified past experience in \$c\$ | Customs, laws, and logistics are strictly jurisdiction-bound |
| \$\\phi\_4(u, q)\$ | **Graph Trust (Personalized PageRank)** | `0.12` | \$\\text{PPR}(u \\mid f)\$ computed over the verified Best-Answer endorsement graph | Resists Sybil rings; rewards experts endorsed by other high-trust nodes |
| \$\\phi\_5(u, q)\$ | **Historical Helpful Conversion** | `0.10` | \$\\text{WilsonLowerBound}(h\_{u,f}, n\_{u,f}, z=1.96)\$ | Measures the proportion of \$u\$'s answers that askers actually found useful |
| \$\\phi\_6(u, q)\$ | **Best Answer Selection Rate** | `0.08` | \$\\frac{b\_{u,f} \+ 1}{n\_{u,f} \+ 4}\$ (Laplace-smoothed selection ratio) | Rewards clarity, completeness, and actionable empirical detail |
| \$\\phi\_7(u, q)\$ | **Responsiveness & Latency Score** | `0.06` | \$\\exp\\left(-\\frac{\\tilde{\\tau}*u}{14400}\\right) \\cdot p*{\\text{reply}}(u)\$ where \$\\tilde{\\tau}\_u\$ is median reply time in seconds | Ensures the asker gets answers within minutes/hours rather than days |
| \$\\phi\_8(u, q)\$ | **Temporal Activity & Circadian Fit** | `0.04` | \$\\exp(-\\lambda\_{\\text{act}} \\Delta t\_{\\text{last\_seen}}) \\cdot \\mathcal{C}*{\\text{hour}}(u, t*{\\text{now}})\$ | Avoids routing urgent questions at 3:00 AM in the expert's local timezone |
| \$\\phi\_9(u, q)\$ | **Topological Diversity Bonus** | `0.03` | \$1 \- \\max\_{u' \\in S\_{\\text{selected}}} w\_{u, u'}^{(f)}\$ (greedy submodular penalty) | Ensures the 15 selected experts aren't from the exact same micro-clique, enabling independent consensus verification |
| \$\\Omega\_{\\text{cold}}(u, f)\$ | **Cold-Start Exploration Bonus (UCB1)** | \$\\beta \= 0.12\$ | \$\\sqrt{\\frac{2 \\ln N\_f}{n\_{u,f} \+ 1}}\$ for new users with \$n\_{u,f} \< 5\$ | Guarantees new signups receive 2–3 initial routing slots so the graph discovers new talent |
| \$\\Gamma\_{\\text{load}}(u)\$ | **Notification Budget Dampener** | Multiplier | \$\\left(\\frac{B\_{\\max} \- B\_{\\text{used today}}}{B\_{\\max}}\\right)^{1.5}\$ | Smoothly throttles routing as an expert approaches their daily notification cap |

**Staged Wave Routing Execution**: Instead of notifying all \$K=15\$ experts simultaneously and risking 15 redundant answers, the Routing Worker uses **Staged Wave Propagation**:

* **Wave 1 (\$t \= 0\\text{ min}\$)**: Dispatches to top \$5\$ experts (\$4\$ exploit \+ \$1\$ cold-start explore).  
* **Wave 2 (\$t \= 20\\text{ min}\$)**: If \$\< 3\$ experts have opened or begun drafting an answer, dispatches to the next \$5\$ experts.  
* **Wave 3 (\$t \= 60\\text{ min}\$)**: If consensus confidence remains below threshold, dispatches to the final \$5\$ experts.

### 11.3 Field-Specific Reputation (Bayesian TrueSkill Adaptation)

Reputation is maintained independently per `(user_id, field_id)` using a Gaussian belief distribution \$\\mathcal{N}(\\mu, \\sigma^2)\$ initialized at \$\\mu\_0 \= 25.0, \\sigma\_0 \= \\frac{25}{3} \\approx 8.333\$. Conservative displayed reputation is: \$\$R\_{u,f} \= \\max\\left(0, ; (\\mu\_{u,f} \- 3\\sigma\_{u,f}) \\times 2\\right) \\in \[0, 100\]\$\$ When a user signs up, \$\\mu\_0 \- 3\\sigma\_0 \= 0\$. As they deliver verified answers, \$\\sigma\_{u,f}\$ shrinks and \$\\mu\_{u,f}\$ rises. **Field Medal Tiers** (strictly per-field, never global):

* **Verified Practitioner**: \$\\ge 3\$ accepted empirical answers in field \$f\$, \$R\_{u,f} \\ge 25\$.  
* **Bronze Node**: \$\\ge 10\$ accepted answers, \$R\_{u,f} \\ge 45\$, Helpful Wilson score \$\\ge 0.65\$.  
* **Silver Node**: \$\\ge 30\$ accepted answers, \$R\_{u,f} \\ge 68\$, Helpful Wilson score \$\\ge 0.78\$.  
* **Gold Nexus**: Top \$1%\$ of active nodes in `(field_id, country_iso)`, \$\\ge 75\$ accepted answers, \$R\_{u,f} \\ge 85\$.

### 11.4 Consensus Detection and Minority Preservation Algorithm

Suppose 10 answers arrive for *"How much customs did you pay importing a ₹3L watch through Chennai?"*: 7 report \~₹95,000, 2 report \~₹80,000, and 1 reports ₹1,40,000.

Graphinity executes **Trust-Weighted Density Clustering (1D/Multi-D DBSCAN \+ Gaussian Mixture Modeling)**:

1. **Structured Claim Extraction**: An extraction worker parses numerical figures (currencies, percentages, durations) and categorical outcomes (`Cleared Smoothly`, `Held for Valuation`, `Penalty Assessed`) from each answer \$a\_i\$.  
2. **Cluster Formation**: Numerical claims \$x\_i\$ are clustered using relative epsilon neighborhood \$\\epsilon\_{\\text{rel}} \= 0.08\$ (\$8%\$ tolerance band, grouping ₹92,000–₹98,000 into the ₹95,000 cluster \$C\_1\$, ₹80,000 into \$C\_2\$, and ₹1,40,000 into \$C\_3\$).  
3. **Trust-Weighted Cluster Mass**: Rather than naive headcount (which is vulnerable to brigading), the mass \$M(C\_m)\$ of cluster \$C\_m\$ is weighted by the responders' field reputation and trust scores: \$\$M(C\_m) \= \\frac{\\sum\_{a\_i \\in C\_m} \\left(0.5 \+ 0.5 \\cdot \\tilde{R}*{u\_i, f}\\right) \\cdot \\text{Trust}(u\_i)}{\\sum*{j=1}^{N} \\left(0.5 \+ 0.5 \\cdot \\tilde{R}\_{u\_j, f}\\right) \\cdot \\text{Trust}(u\_j)}\$\$  
4. **Epistemic Entropy & Confidence Score**: The consensus certainty of the question is measured via normalized Shannon entropy across clusters: \$\$H\_{\\text{norm}}(q) \= \-\\frac{\\sum\_{m=1}^{M} M(C\_m) \\ln M(C\_m)}{\\ln(\\max(M, 2))}, \\quad \\text{ConsensusConfidence}(q) \= 1 \- H\_{\\text{norm}}(q)\$\$  
5. **Minority Preservation Mandate**:  
   * Answers in the dominant cluster \$C\_1\$ receive a consensus boost in ranking.  
   * However, the highest-trust answer from every minority cluster (\$C\_2, C\_3\$) is **pinned with an explicit `[Minority Outcome / Edge Case]` badge** directly beneath the primary consensus answers and visually represented in the top Consensus Distribution Bar so edge cases (e.g., why 1 person paid ₹1,40,000 due to missing an invoice declaration) are never buried.

### 11.5 Answer Ranking Formula (Bayesian Wilson \+ Consensus \+ Trust)

Answers on a question page are ordered by the composite ranking score \$\\Omega(a\_i, q)\$:

\$\$\\Omega(a\_i, q) \= 0.30 \\cdot \\mathbb{I}*{\\text{Best}}(a\_i) \+ 0.22 \\cdot W*{\\text{Wilson}}(h\_i, n\_i) \+ 0.18 \\cdot \\tilde{R}*{u\_i, f} \+ 0.12 \\cdot M(C(a\_i)) \+ 0.10 \\cdot \\text{Trust}(u\_i) \+ 0.08 \\cdot Q*{\\text{specificity}}(a\_i)\$\$

where \$W\_{\\text{Wilson}}(h, n)\$ is the lower bound of the Wilson score confidence interval for helpful votes \$h\$ out of \$n\$ evaluations at \$95%\$ confidence (\$z \= 1.96\$): \$\$W\_{\\text{Wilson}}(h, n) \= \\frac{\\hat{p} \+ \\frac{z^2}{2n} \- z \\sqrt{\\frac{\\hat{p}(1-\\hat{p}) \+ \\frac{z^2}{4n}}{n}}}{1 \+ \\frac{z^2}{n}}, \\quad \\hat{p} \= \\frac{h}{n}\$\$ and \$Q\_{\\text{specificity}}(a\_i)\$ rewards concrete empirical anchors (dates, specific port names, exact receipts/steps) over vague generalizations.

---

## 12\. Search, Machine Learning, and AI Safety Roadmap

### 12.1 Hybrid Retrieval Architecture (BM25 \+ HNSW \+ RRF)

Pure vector search struggles with exact alphanumeric codes (e.g., HS tariff code `9101.21.00`, form `BOE-II`, or watch reference `126610LN`), while pure keyword search fails on conceptual synonyms ("customs duty" vs "import tax clearance"). Graphinity combines both using **Reciprocal Rank Fusion (RRF)** with constant \$k \= 60\$:

\$\$\\text{RRF}(q, d) \= \\frac{w\_{\\text{sem}}}{60 \+ \\text{rank}*{\\text{HNSW}}(q, d)} \+ \\frac{w*{\\text{lex}}}{60 \+ \\text{rank}\_{\\text{BM25}}(q, d)}\$\$

with \$w\_{\\text{sem}} \= 0.65\$ and \$w\_{\\text{lex}} \= 0.35\$, followed by a top-25 cross-encoder rerank step.

### 12.2 Strict Epistemic Guardrails for AI inside Graphinity

Graphinity is **never** an AI chatbot. Machine learning models operate strictly as **infrastructure plumbers, never as synthetic authors**:

* **Allowed AI Roles**: Embedding generation (`text-embedding-3-large` truncated via Matryoshka Representation Learning to `1536` or `768` dimensions), intent/field classification, structured claim extraction (identifying that "95k INR" and "₹95,000" represent the same numerical quantity for the Consensus Engine), and spam/abuse filtering.  
* **Prohibited AI Roles**: AI is strictly forbidden from generating synthetic answers to user questions. Every word in an answer card must originate from a verified human node, and our automated classifier (`AI-Prose-Detector`) blocks users from pasting copy-pasted ChatGPT responses as answers.

---

## 13\. Frontend Engineering Architecture

### 13.1 Stack and Directory Structure

Built with [React 19](https://react.dev/), TypeScript 5.x (strict mode with `noUncheckedIndexedAccess: true`), and [Vite](https://vite.dev/) using Feature-Sliced Design (FSD):

apps/web/

├── index.html

├── vite.config.ts

└── src/

    ├── app/                    \# Providers, Router, Global Error Boundaries, CSP Nonce hydration

    ├── pages/                  \# Route entry points (AskPage, QuestionPage, InboxPage, FieldAtlasPage)

    ├── widgets/

    │   ├── living-graph/       \# WebGPU / WebGL2 Instanced Graph Engine \+ Physics Worker

    │   ├── inquiry-composer/   \# Natural language input \+ real-time semantic precheck

    │   └── consensus-bar/      \# Multi-modal empirical distribution visualizer

    ├── features/

    │   ├── route-question/     \# Optimistic question creation \+ SSE live pulse subscription

    │   ├── submit-answer/      \# Structured empirical report editor

    │   └── rate-answer/        \# Best Answer selection & Wilson vote mutation

    ├── entities/

    │   ├── node/               \# Person, Question, and Field domain models

    │   └── reputation/         \# Field Medal & TrueSkill badge presenters

    └── shared/

        ├── ui/                 \# Apple-grade primitive components (SquircleCard, SpringSheet)

        ├── lib/                \# Spring physics solver, OKLCH math, Unicode normalizer

        └── api/                \# Type-safe Fetch client \+ TanStack Query v5 cache policies

### 13.2 State Management, OffscreenCanvas Worker, and Optimistic UI

* **Zero Main-Thread Graph Jank**: The force-directed layout simulation (`d3-force-3d` compiled to Rust/WebAssembly) and WebGPU/WebGL2 rendering loop run inside a dedicated **Web Worker** bound to an `OffscreenCanvas`. The main React thread only handles DOM accessibility overlays, pointer gesture forwarding, and typographic sheet transitions.  
* **Bundle Budgets**: Initial critical-path JS bundle is strictly capped at `< 65 KB` (Brotli-compressed). The WebGL/WASM graph engine (`~42 KB` Brotli) streams asynchronously in parallel with initial HTML hydration.

---

## 14\. Backend Engineering Architecture

### 14.1 Hexagonal Architecture, DDD, CQRS, and Event Sourcing

The backend is built on Node.js 22 LTS with [Fastify](https://fastify.dev/) (selected for its zero-overhead schema-compiled JSON serialization via `fast-json-stringify` and strict plugin encapsulation) organized around **Domain-Driven Design (DDD)** and **Hexagonal (Ports & Adapters) Architecture**:

apps/api/

└── src/

    ├── modules/

    │   ├── identity/           \# Google OAuth, Sybil scoring, Node profile domain

    │   ├── graph-topology/     \# Node/Edge aggregates, TrueSkill & PPR calculators

    │   ├── inquiry/            \# Question lifecycle, Semantic Precheck, Consensus Engine

    │   └── routing/            \# 11-Factor Ranker, Wave Scheduler, Notification Budgeter

    ├── shared/

    │   ├── domain/             \# AggregateRoot, DomainEvent, Result\<T, E\> monad

    │   ├── infra/

    │   │   ├── db/             \# Drizzle/Kysely type-safe SQL \+ pgvector adapters

    │   │   ├── queue/          \# BullMQ / Redis Streams workers \+ Circuit Breakers

    │   │   └── cache/          \# Multi-tier L1 (In-memory LRU) \+ L2 (Redis) cache

    │   └── http/               \# Fastify plugins, rate-limiters, OpenTelemetry tracing

### 14.2 CQRS and Event-Sourced Graph Mutations

Every interaction that alters graph topology is recorded as an immutable **Domain Event** in the `graph_events` append-only log (`QuestionAsked`, `QuestionRouted`, `AnswerSubmitted`, `AnswerMarkedHelpful`, `BestAnswerSelected`, `ConsensusRecomputed`):

* **Write Path (Command Side)**: Validates invariants inside a serializable/repeatable-read transaction, writes the entity state, and appends the domain event to the transactional outbox table (`outbox_events`).  
* **Read Path (Query Side)**: Asynchronous BullMQ workers consume `outbox_events` with idempotent handlers (`event_id` deduplication key), recalculate TrueSkill \$(\\mu, \\sigma)\$, update `user_affinity_edges`, refresh materialized consensus views, and push live pulse frames over Redis Pub/Sub to active SSE clients.

### 14.3 Production Implementation: The 11-Factor Routing Service (TypeScript)

// apps/api/src/modules/routing/application/QuestionRoutingService.ts

import { sql } from 'kysely';

import type { Database } from '../../../shared/infra/db/schema.js';

export interface RouteCandidate {

  userId: string;

  semanticProximity: number;      // phi\_1

  trueSkillConservative: number;  // phi\_2

  locationMatchScore: number;     // phi\_3

  personalizedPageRank: number;   // phi\_4

  helpfulWilsonScore: number;     // phi\_5

  bestAnswerRatio: number;        // phi\_6

  medianReplySeconds: number;     // phi\_7

  replyProbability: number;       // phi\_7

  hoursSinceLastSeen: number;     // phi\_8

  circadianMultiplier: number;    // phi\_8

  answeredCountInField: number;   // cold start n\_{u,f}

  dailyNotificationsSent: number;

  dailyNotificationMax: number;

}

export class QuestionRoutingService {

  private static readonly WEIGHTS \= {

    semantic: 0.24,

    reputation: 0.18,

    location: 0.15,

    pprTrust: 0.12,

    wilsonHelpful: 0.10,

    bestSelection: 0.08,

    responsiveness: 0.06,

    activityCircadian: 0.04,

    diversity: 0.03,

    coldStartBeta: 0.12,

  } as const;

  public rankCandidates(

    candidates: RouteCandidate\[\],

    totalFieldQuestions: number,

    affinityMatrix: Map\<string, number\>, // key: \`\${u1}:\${u2}\` \-\> weight \[0,1\]

    targetWaveSize \= 5

  ): string\[\] {

    const scored \= candidates

      .filter((c) \=\> c.dailyNotificationsSent \< c.dailyNotificationMax)

      .map((c) \=\> {

        const phi1 \= Math.max(0, Math.min(1, c.semanticProximity));

        const phi2 \= 1 / (1 \+ Math.exp(-(c.trueSkillConservative \- 25\) / 8.33));

        const phi3 \= c.locationMatchScore;

        const phi4 \= Math.max(0, Math.min(1, c.personalizedPageRank));

        const phi5 \= c.helpfulWilsonScore;

        const phi6 \= c.bestAnswerRatio;

        const phi7 \= Math.exp(-c.medianReplySeconds / 14400\) \* c.replyProbability;

        const phi8 \= Math.exp(-0.03 \* c.hoursSinceLastSeen) \* c.circadianMultiplier;

        const ucbColdStart \=

          c.answeredCountInField \< 5

            ? Math.sqrt((2 \* Math.log(Math.max(totalFieldQuestions, 2))) / (c.answeredCountInField \+ 1))

            : 0;

        const budgetRatio \=

          (c.dailyNotificationMax \- c.dailyNotificationsSent) / c.dailyNotificationMax;

        const loadMultiplier \= Math.pow(Math.max(0, budgetRatio), 1.5);

        const baseScore \=

          QuestionRoutingService.WEIGHTS.semantic \* phi1 \+

          QuestionRoutingService.WEIGHTS.reputation \* phi2 \+

          QuestionRoutingService.WEIGHTS.location \* phi3 \+

          QuestionRoutingService.WEIGHTS.pprTrust \* phi4 \+

          QuestionRoutingService.WEIGHTS.wilsonHelpful \* phi5 \+

          QuestionRoutingService.WEIGHTS.bestSelection \* phi6 \+

          QuestionRoutingService.WEIGHTS.responsiveness \* phi7 \+

          QuestionRoutingService.WEIGHTS.activityCircadian \* phi8 \+

          QuestionRoutingService.WEIGHTS.coldStartBeta \* ucbColdStart;

        return {

          userId: c.userId,

          baseUtility: baseScore \* loadMultiplier,

        };

      });

    // Greedy Submodular Selection to enforce Topological Diversity (phi\_9)

    const selected: string\[\] \= \[\];

    const remaining \= new Set(scored);

    while (selected.length \< targetWaveSize && remaining.size \> 0\) {

      let bestCandidate: { userId: string; baseUtility: number } | null \= null;

      let bestMarginalGain \= \-Infinity;

      for (const item of remaining) {

        let maxAffinityWithSelected \= 0;

        for (const selId of selected) {

          const key \= item.userId \< selId ? \`\${item.userId}:\${selId}\` : \`\${selId}:\${item.userId}\`;

          const affinity \= affinityMatrix.get(key) ?? 0;

          if (affinity \> maxAffinityWithSelected) {

            maxAffinityWithSelected \= affinity;

          }

        }

        const diversityBonus \= QuestionRoutingService.WEIGHTS.diversity \* (1 \- maxAffinityWithSelected);

        const totalScore \= item.baseUtility \+ diversityBonus;

        if (totalScore \> bestMarginalGain) {

          bestMarginalGain \= totalScore;

          bestCandidate \= item;

        }

      }

      if (bestCandidate) {

        selected.push(bestCandidate.userId);

        remaining.delete(bestCandidate);

      }

    }

    return selected;

  }

}

---

## 15\. Database Architecture (PostgreSQL 17 \+ pgvector)

### 15.1 Why PostgreSQL \+ pgvector Over Standalone Graph Databases

Standalone graph databases (e.g., Neo4j) often suffer from operational split-brain when paired with relational transactional stores and vector databases. Because Graphinity's routing queries require **simultaneous filtering by relational attributes (`country_iso`, `field_id`, `notification_budget`), HNSW vector similarity ([pgvector](https://github.com/pgvector/pgvector)), and 1-to-2 hop weighted adjacency joins**, PostgreSQL 17 with `pgvector 0.8+` executes the entire hybrid candidate retrieval in a single ACID-compliant memory space without network serialization hops.

### 15.2 Complete Production DDL Schema

\-- Enable required PostgreSQL extensions

CREATE EXTENSION IF NOT EXISTS "citext";

CREATE EXTENSION IF NOT EXISTS "pg\_trgm";

CREATE EXTENSION IF NOT EXISTS "vector";

\-- 1\. Users (Person Nodes)

CREATE TABLE users (

    id UUID PRIMARY KEY, \-- UUIDv7 (time-ordered for B-tree locality)

    google\_sub TEXT UNIQUE NOT NULL,

    username CITEXT UNIQUE NOT NULL CHECK (char\_length(username) BETWEEN 3 AND 30 AND username \~ '^\[a-zA-Z0-9\_\]+\$'),

    country\_iso CHAR(2) NOT NULL,

    sub\_region\_code VARCHAR(10),

    timezone\_iana VARCHAR(64) NOT NULL DEFAULT 'UTC',

    daily\_notification\_budget SMALLINT NOT NULL DEFAULT 3 CHECK (daily\_notification\_budget BETWEEN 0 AND 15),

    notifications\_sent\_today SMALLINT NOT NULL DEFAULT 0,

    ppr\_global\_sybil\_score REAL NOT NULL DEFAULT 0.500,

    last\_active\_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created\_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    deleted\_at TIMESTAMPTZ

);

\-- 2\. Canonical Expertise Fields

CREATE TABLE fields (

    id SMALLSERIAL PRIMARY KEY,

    slug CITEXT UNIQUE NOT NULL,

    display\_name TEXT NOT NULL,

    parent\_field\_id SMALLINT REFERENCES fields(id),

    decay\_half\_life\_days SMALLINT NOT NULL DEFAULT 180,

    total\_questions\_count INTEGER NOT NULL DEFAULT 0

);

\-- 3\. User Field Expertise Edges (Independent per Field \+ Country)

CREATE TABLE user\_field\_expertise (

    user\_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    field\_id SMALLINT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,

    country\_iso CHAR(2) NOT NULL,

    trueskill\_mu REAL NOT NULL DEFAULT 25.000,

    trueskill\_sigma REAL NOT NULL DEFAULT 8.333,

    conservative\_reputation REAL GENERATED ALWAYS AS (GREATEST(0.0, (trueskill\_mu \- 3.0 \* trueskill\_sigma) \* 2.0)) STORED,

    ppr\_field\_trust REAL NOT NULL DEFAULT 0.100,

    answers\_submitted INTEGER NOT NULL DEFAULT 0,

    best\_answers\_selected INTEGER NOT NULL DEFAULT 0,

    helpful\_votes\_received INTEGER NOT NULL DEFAULT 0,

    total\_evaluations INTEGER NOT NULL DEFAULT 0,

    wilson\_helpful\_score REAL NOT NULL DEFAULT 0.000,

    median\_reply\_seconds INTEGER NOT NULL DEFAULT 3600,

    reply\_probability REAL NOT NULL DEFAULT 0.750,

    medal\_tier VARCHAR(16) NOT NULL DEFAULT 'NONE' CHECK (medal\_tier IN ('NONE', 'VERIFIED', 'BRONZE', 'SILVER', 'GOLD')),

    experience\_centroid halfvec(1536), \-- Quantized FP16 vector of all questions answered by this user in this field

    last\_answered\_at TIMESTAMPTZ,

    PRIMARY KEY (user\_id, field\_id, country\_iso)

);

\-- 4\. Invisible User-to-User Epistemic Affinity Graph Edges

CREATE TABLE user\_affinity\_edges (

    user\_a\_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    user\_b\_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    field\_id SMALLINT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,

    edge\_weight REAL NOT NULL DEFAULT 0.050 CHECK (edge\_weight BETWEEN 0.0 AND 1.0),

    shared\_questions\_count INTEGER NOT NULL DEFAULT 1,

    updated\_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user\_a\_id, user\_b\_id, field\_id),

    CONSTRAINT ordered\_user\_pair CHECK (user\_a\_id \< user\_b\_id)

);

\-- 5\. Question Nodes

CREATE TABLE questions (

    id UUID PRIMARY KEY, \-- UUIDv7

    author\_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,

    field\_id SMALLINT NOT NULL REFERENCES fields(id),

    country\_iso CHAR(2) NOT NULL,

    sub\_region\_code VARCHAR(10),

    slug TEXT UNIQUE NOT NULL,

    title TEXT NOT NULL CHECK (char\_length(title) BETWEEN 15 AND 280),

    body\_context TEXT,

    embedding halfvec(1536) NOT NULL,

    search\_tsv TSVECTOR GENERATED ALWAYS AS (

        setweight(to\_tsvector('english', coalesce(title, '')), 'A') ||

        setweight(to\_tsvector('english', coalesce(body\_context, '')), 'B')

    ) STORED,

    status VARCHAR(24) NOT NULL DEFAULT 'ROUTING' CHECK (status IN ('ROUTING', 'ANSWERED', 'CONSENSUS\_LOCKED', 'ARCHIVED')),

    best\_answer\_id UUID,

    consensus\_confidence REAL NOT NULL DEFAULT 0.000,

    consensus\_distribution JSONB NOT NULL DEFAULT '\[\]'::jsonb,

    created\_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    resolved\_at TIMESTAMPTZ

);

\-- 6\. Question Routing Ledger

CREATE TABLE question\_routings (

    question\_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,

    expert\_user\_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    wave\_number SMALLINT NOT NULL DEFAULT 1,

    routing\_score REAL NOT NULL,

    state VARCHAR(20) NOT NULL DEFAULT 'DISPATCHED' CHECK (state IN ('DISPATCHED', 'VIEWED', 'ANSWERED', 'PASSED', 'EXPIRED')),

    dispatched\_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    responded\_at TIMESTAMPTZ,

    PRIMARY KEY (question\_id, expert\_user\_id)

);

\-- 7\. Empirical Answers

CREATE TABLE answers (

    id UUID PRIMARY KEY, \-- UUIDv7

    question\_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,

    author\_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    what\_happened TEXT NOT NULL CHECK (char\_length(what\_happened) BETWEEN 40 AND 8000),

    extracted\_numeric\_value NUMERIC(18, 2),

    extracted\_currency CHAR(3),

    mistakes\_to\_avoid TEXT,

    occurred\_month DATE NOT NULL, \-- Verifies recency of lived experience

    confidence\_level VARCHAR(16) NOT NULL CHECK (confidence\_level IN ('FIRST\_HAND\_RECENT', 'FIRST\_HAND\_PAST', 'REPEATED\_PRACTICE')),

    cluster\_id SMALLINT,

    is\_minority\_pinned BOOLEAN NOT NULL DEFAULT FALSE,

    is\_best\_answer BOOLEAN NOT NULL DEFAULT FALSE,

    asker\_rating SMALLINT CHECK (asker\_rating BETWEEN 1 AND 5),

    helpful\_count INTEGER NOT NULL DEFAULT 0,

    not\_helpful\_count INTEGER NOT NULL DEFAULT 0,

    wilson\_score REAL NOT NULL DEFAULT 0.000,

    composite\_rank\_score REAL NOT NULL DEFAULT 0.000,

    created\_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (question\_id, author\_id)

);

### 15.3 Precision Indexing Strategy

\-- 1\. HNSW Vector Index on Question Embeddings using FP16 halfvec (cuts RAM by 50% with \>99.2% recall)

CREATE INDEX idx\_questions\_embedding\_hnsw ON questions

USING hnsw (embedding halfvec\_cosine\_ops)

WITH (m \= 24, ef\_construction \= 200);

\-- 2\. Partial Composite Index for Partitioned Precheck & Routing Lookups

CREATE INDEX idx\_questions\_field\_country\_active ON questions (field\_id, country\_iso, created\_at DESC)

WHERE status IN ('ANSWERED', 'CONSENSUS\_LOCKED');

\-- 3\. GIN Full-Text & Trigram Indexes for Hybrid BM25 \+ Typo-Tolerant Search

CREATE INDEX idx\_questions\_search\_tsv ON questions USING gin (search\_tsv);

CREATE INDEX idx\_questions\_title\_trgm ON questions USING gin (title gin\_trgm\_ops);

\-- 4\. Covering Index for Fast Candidate Routing Selection

CREATE INDEX idx\_expertise\_routing\_lookup ON user\_field\_expertise (field\_id, country\_iso, conservative\_reputation DESC)

INCLUDE (user\_id, ppr\_field\_trust, wilson\_helpful\_score, median\_reply\_seconds, reply\_probability, answers\_submitted);

\-- 5\. HNSW Index on Expert Experience Centroids for Semantic Routing

CREATE INDEX idx\_expertise\_centroid\_hnsw ON user\_field\_expertise

USING hnsw (experience\_centroid halfvec\_cosine\_ops)

WITH (m \= 16, ef\_construction \= 128);

### 15.4 Row Level Security (RLS), MVCC, and Autovacuum Tuning

Following [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) best practices, RLS is enabled on all tables:

* Public readers can `SELECT` resolved `questions` and `answers`, but `question_routings` is strictly restricted to `expert_user_id = (SELECT auth.uid())` (wrapping `auth.uid()` in a scalar subquery so PostgreSQL caches the InitPlan once per query rather than evaluating per row).  
* Because `user_field_expertise` and `user_affinity_edges` experience high `UPDATE` frequency as the graph learns, PostgreSQL's MVCC generates dead tuples rapidly. We configure table-level storage parameters (`fillfactor = 80`) to enable **HOT (Heap-Only Tuple) updates** whenever indexed columns do not change, and aggressive per-table autovacuum thresholds:  
    
  ALTER TABLE user\_field\_expertise SET (  
    
      fillfactor \= 80,  
    
      autovacuum\_vacuum\_scale\_factor \= 0.02,  
    
      autovacuum\_vacuum\_cost\_limit \= 2000  
    
  );

---

## 16\. Security Engineering and Zero-Trust Architecture

### 16.1 Threat Model and OWASP Top 10 Mitigations

Graphinity implements defense-in-depth aligned with the [OWASP Top 10](https://owasp.org/projects/top-ten):

| Vulnerability Vector | Graphinity Specific Threat | Architectural Control & Mitigation |
| :---- | :---- | :---- |
| **Broken Access Control / IDOR** | Attacker attempts to mark Best Answer on someone else's question or read private routing queues | Parameterized ownership check in SQL (`WHERE question_id = $1 AND author_id = $2`) backed by PostgreSQL RLS policies |
| **Authentication & Session Hijacking** | Stolen session tokens or OAuth CSRF attacks | Google OAuth 2.0 with PKCE \+ `state` nonce; short-lived (`15m`) EdDSA JWT access tokens paired with Rotating Refresh Tokens in `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax` cookies with automatic reuse family revocation |
| **XSS (Cross-Site Scripting)** | Malicious script injected into an empirical answer body | Strict nonce-based Content Security Policy (`script-src 'self' 'nonce-{random}' 'strict-dynamic'; object-src 'none'; base-uri 'none'`) \+ server-side AST sanitization of Markdown |
| **SQL Injection** | Malicious string in search or filter parameters | 100% compiled parameterized queries via Kysely/Drizzle; zero string concatenation in SQL |
| **SSRF (Server-Side Request Forgery)** | Attacker triggers outbound fetches from backend | Outbound egress proxy blocks all RFC 1918 private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`) |
| **Sybil & Reputation Manipulation** | Colluding accounts asking fake questions and selecting each other as Best Answer | Personalized PageRank anchored on trusted seed nodes \+ cycle detection in `question_routings` (mutual selection pairs discount reputation gain by \$95%\$) |

---

## 17\. Infrastructure, Cloud Topology, and Google SRE Operations

### 17.1 Edge-to-Core Infrastructure Stack

1. **Edge Network ([Cloudflare Workers](https://developers.cloudflare.com/workers/) \+ CDN)**: Terminates TLS 1.3 \+ HTTP/3 (QUIC), enforces Cloudflare Turnstile bot mitigation, caches canonical resolved question pages at 300+ global edge PoPs (`Cache-Control: public, s-maxage=60, stale-while-revalidate=86400`), and injects `CF-IPCountry` for zero-latency country pre-selection.  
2. **Application Compute (Render Private Services \+ Autoscaling)**: Runs stateless Fastify API containers and dedicated BullMQ background routing/consensus workers across multi-AZ instances with horizontal pod autoscaling triggered at `65%` CPU or `p95 > 120ms` event-loop lag.  
3. **Data Layer (Supabase Dedicated PostgreSQL \+ PgBouncer)**: Connection pooling via PgBouncer in transaction mode (`default_pool_size = 40`), Point-in-Time Recovery (PITR) via continuous WAL archiving to S3/R2 (`RPO < 60 seconds`, `RTO < 10 minutes`), and regional read replicas for Field Atlas queries.

### 17.2 Service Level Objectives (SLOs) and Error Budgets

Following [Google SRE](https://sre.google/) methodology, reliability is governed by quantitative error budgets:

| Service Path | SLI Metric Definition | Target SLO (28-Day Window) | Monthly Error Budget | Automated Action on Budget Exhaustion |
| :---- | :---- | :---- | :---- | :---- |
| **Semantic Precheck API** | Latency (`p95`) & Availability | `99.95%` success in `< 120ms` | `21.6 minutes` | Feature flag freeze; fallback to lexical \+ cached HNSW search |
| **Live Graph Routing Dispatch** | End-to-end time from `QuestionAsked` to Wave 1 notification | `99.90%` dispatched in `< 2,500ms` | `43.2 minutes` | PagerDuty P1 alert; autoscale BullMQ routing workers 2x |
| **Canonical Question Read** | Edge \+ Origin HTTP `200` availability | `99.99%` availability in `< 80ms` | `4.32 minutes` | Serve stale edge cache (`stale-if-error=604800`) automatically |

---

## 18\. Performance Engineering and Core Web Vitals

Graphinity enforces strict [Core Web Vitals](https://web.dev/articles/vitals) budgets verified in CI on every pull request:

* **Largest Contentful Paint (LCP)**: Target `< 1.1 seconds` (Google Good threshold: `2.5s`). Achieved via SSR/Edge streaming of the Question & Consensus HTML shell before the WebGL graph canvas initializes.  
* **Interaction to Next Paint (INP)**: Target `< 48 milliseconds` (Google Good threshold: `200ms`). All heavy computation (graph layout forces, Markdown parsing, fuzzy filtering) executes off the main UI thread in Web Workers or inside `React.startTransition`.  
* **Cumulative Layout Shift (CLS)**: Target `0.000` (Google Good threshold: `0.1`). Every answer card, consensus bar, and font face declares explicit intrinsic dimensions (`aspect-ratio`, `min-height`, and metric-matched `@font-face` descriptors).  
* **Battery & Thermal Governance**: On mobile devices (`navigator.getBattery()`) or when the tab loses focus (`document.visibilityState === 'hidden'`), the Living Graph canvas automatically drops from `120Hz` active simulation to `0Hz` suspended state, consuming `0.0%` background CPU/GPU.

---

## 19\. Technical SEO and Knowledge Graph Indexing

### 19.1 Entity SEO and Schema.org `QAPage` Structured Data

Why does Graphinity dominate organic search without creating content spam? Because every resolved question node represents verified, structured human data that search engines cannot synthesize on their own. Every public question page embeds valid [Schema.org QAPage](https://developers.google.com/search/docs/appearance/structured-data/qapage) JSON-LD in the SSR `<head>`:

{

  "@context": "https\://schema.org",

  "@type": "QAPage",

  "mainEntity": {

    "@type": "Question",

    "name": "How much customs duty did you actually pay importing a ₹3 lakh watch into India through Chennai?",

    "text": "Looking for recent lived experience importing a luxury mechanical watch (\~₹3,00,000 value) through Chennai Air Cargo. What was the exact customs duty assessed and what documentation issues occurred?",

    "answerCount": 10,

    "upvoteCount": 42,

    "dateCreated": "2026-10-19T04:00:00+05:30",

    "author": {

      "@type": "Person",

      "name": "arjun\_m"

    },

    "about": \[

      { "@type": "Thing", "name": "Customs Duty" },

      { "@type": "Place", "name": "Chennai, India" }

    \],

    "acceptedAnswer": {

      "@type": "Answer",

      "text": "Imported a Tudor Black Bay valued at ₹2,95,000 via DHL through Chennai last month. Paid ₹94,800 total (effective \~43.96% combined BCD \+ SWS \+ IGST plus courier clearance fee). Ensure your bank remittance receipt matches the commercial invoice to the exact rupee.",

      "dateCreated": "2026-10-19T04:18:00+05:30",

      "upvoteCount": 31,

      "url": "https\://graphinity.com/q/imports/in/rolex-watch-customs-duty-chennai-01j9x8k2m4\#answer-01j9x9a1",

      "author": {

        "@type": "Person",

        "name": "vikram\_customs",

        "knowsAbout": \["Imports", "Watches", "India Customs"\]

      }

    },

    "suggestedAnswer": \[

      {

        "@type": "Answer",

        "text": "Paid ₹1,38,000 on a ₹3.1L watch at Chennai because the seller declared a lower insured value on the airway bill than my credit card statement, triggering a 45% valuation uplift penalty.",

        "dateCreated": "2026-10-19T04:42:00+05:30",

        "upvoteCount": 19,

        "url": "https\://graphinity.com/q/imports/in/rolex-watch-customs-duty-chennai-01j9x8k2m4\#answer-01j9x9z8"

      }

    \]

  }

}

### 19.2 Crawl Budget, Topic Clusters, and Indexation Hygiene

* **Zero Unanswered Thin Pages in Search Index**: Questions still in `ROUTING` state with `0` answers automatically emit `<meta name="robots" content="noindex, follow" />`. Only when a question transitions to `ANSWERED` (or `CONSENSUS_LOCKED`) does the tag flip to `index, follow` and ping Google's Sitemap shard (`/sitemaps/questions-in-imports.xml`). This guarantees `100%` of indexed Graphinity URLs contain high-signal human answers.  
* **Internal Topological Linking**: Every question page links semantically to its top 5 nearest neighbor question nodes (computed via `pgvector` HNSW cosine similarity) and its parent `/fields/{field}/{country}` hub page, transferring internal PageRank across dense topical clusters.

---

## 20\. Accessibility (WCAG 2.2 AA/AAA) and Inclusive Engineering

### 20.1 Making a Living Visual Graph Fully Accessible to Screen Readers

A common failure of canvas/WebGL applications is treating the `<canvas>` as an inaccessible black box. Graphinity implements a **Synchronized Shadow Accessibility Tree** adhering to [WCAG 2.2](https://www.w3.org/TR/WCAG22/):

* Beneath the WebGPU/WebGL `<canvas aria-hidden="true">`, Graphinity renders a structured semantic DOM overlay (`<nav aria-label="Knowledge Graph Topology">`) containing focusable `<button>` and `<article>` nodes synced to the active subgraph.  
* **Keyboard Graph Traversal**: Pressing `Tab` focuses the active central node; `ArrowRight` / `ArrowLeft` traverses connected expert edges in descending weight order; `Enter` expands the selected node's neighborhood; and an `aria-live="polite"` status region narrates routing milestones cleanly (*"Question routed to 5 verified experts in India Imports. 2 experts are currently composing answers."*).  
* **Reduced Motion (`prefers-reduced-motion: reduce`)**: Automatically disables particle movement and camera panning across the graph canvas, replacing traveling pulses with calm, instantaneous opacity cross-fades (`150ms`) while preserving full topological clarity.  
* **RTL and Logical CSS**: 100% of layout stylesheets use CSS Logical Properties (`margin-inline-start`, `padding-block-end`, `inset-inline`) so Arabic, Hebrew, and Urdu interfaces mirror automatically without layout breakage.

---

## 21\. Quality Assurance, Testing Pyramid, and Trust & Safety Moderation

### 21.1 The 7-Layer Testing Strategy

1. **Deterministic Unit Tests (`Vitest`)**: `100%` branch coverage on mathematical algorithms (TrueSkill updates, Wilson score lower bounds, DBSCAN consensus clustering, 11-factor routing score).  
2. **Property-Based & Mutation Testing (`fast-check` \+ `Stryker`)**: Generates 10,000 random answer/vote permutations to prove that edge weights \$w\_{u,f,c}\$ never escape \$\[0.01, 0.999\]\$ and that Sybil vote rings cannot inflate `conservative_reputation`.  
3. **Database Integration Tests (`Testcontainers PostgreSQL 17`)**: Verifies RLS policies, HNSW index recall, and transactional outbox idempotency against real Postgres instances.  
4. **Visual Regression & Pixel Snap Tests (`Playwright`)**: Compares light/dark/RTL snapshots with a `0.01%` pixel diff threshold.  
5. **Automated Accessibility Audits (`axe-core` \+ `Pa11y`)**: Zero tolerance for WCAG 2.2 AA violations in CI.  
6. **Load & Stress Testing (`k6`)**: Simulates 50,000 concurrent SSE graph listeners and 2,500 questions/sec semantic prechecks.  
7. **Chaos Engineering (`Toxiproxy`)**: Injects artificial `400ms` Redis latency and drops PostgreSQL read replicas during staging runs to verify graceful circuit-breaker degradation.

### 21.2 Multi-Layered Moderation and Anti-Abuse Engine

* **Sockpuppet & Brigading Detection**: Tracks device attestation hashes, ASN/subnet clustering, and temporal vote velocity. If 5 accounts from the same `/24` subnet or newly created nodes upvote a single answer within 120 seconds, the **Graph Anomaly Detector** dampens their vote weight to `0.00` without alerting the attacker (shadow dampening).  
* **Commercial Scam Filtering**: Because high-intent empirical questions (like customs clearance or visa processing) attract unlicensed middlemen ("DM me on WhatsApp \+91... for guaranteed clearance"), an inline regex \+ ML classifier strips phone numbers, Telegram handles, and solicitation links before an answer can be committed.

---

## 22\. Legal, Privacy, Product Management, and the 29 Edge-Case Engineering Imperatives

### 22.1 Privacy-by-Design and Global Regulatory Compliance (GDPR, CCPA, India DPDP Act)

* **Data Minimization**: Graphinity stores only Google `sub` identifier, chosen `@username`, country code, declared fields, and public questions/answers. IP addresses are never stored in PostgreSQL; geo-routing uses the ephemeral edge country header and discards the raw IP at request termination.  
* **"Delete Means Delete" (Cryptographic Erasure \+ Cascade)**: When a user triggers account deletion, a single transactional command purges their `users` row, cascades deletion across `user_field_expertise` and `question_routings`, and anonymizes their historical helpful answers (`author_id = NULL`, displayed as `@deleted_node`)—or hard-deletes them upon request—within `< 500ms`, with cryptographic key shredding for encrypted audit logs.

### 22.2 Product Management, Analytics, and Engineering Culture

* **North Star Metric**: **Verified Empirical Resolution Rate within 4 Hours (\$VRR\_4\$)** — the percentage of newly asked questions that receive at least one answer rated \$\\ge 4\$ stars (or achieve consensus confidence \$\\ge 0.70\$) within 240 minutes.  
* **Privacy-Preserving First-Party Telemetry**: Zero Google Analytics or third-party scripts. Funnel and retention metrics are computed purely from server-side domain events (`QuestionAsked -> PrecheckMatched | Routed -> FirstAnswerReceived -> BestAnswerSelected`).  
* **Engineering Culture Standards**: Trunk-based development on `main`, mandatory Architecture Decision Records (`docs/adr/0001-hybrid-pgvector-routing.md`), Conventional Commits (`feat(routing): ...`), and blameless SRE postmortems for any incident consuming \$\> 20%\$ of monthly error budget.

### 22.3 The 29 Edge-Case Engineering Imperatives ("Things Almost Nobody Asks")

The table below codifies the exact architectural implementation for the 29 hidden engineering failure modes that separate world-class engineering organizations from fragile startups:

| \# | Engineering Domain | Exact Graphinity Production Implementation |
| :---- | :---- | :---- |
| 1 | **Cache Invalidation Strategy** | Event-driven surrogate-key purge: when `AnswerSubmitted` or `BestAnswerSelected` fires, the outbox worker issues a Cloudflare Cache Tag purge (`Cache-Tag: q-{question_id}`) and increments a Redis version key (`v:q:{id}`) using Stale-While-Revalidate (`SWR`). |
| 2 | **Unicode Normalization** | Every text input (`username`, `title`, `what_happened`) passes through `.normalize('NFC')` at the Fastify preValidation hook, plus homoglyph skeleton checking (UTR \#39) on usernames to prevent Cyrillic `а` impersonating Latin `a`. |
| 3 | **Time Zones & DST Handling** | All database timestamps use `TIMESTAMPTZ` stored in UTC. Expert circadian routing windows use IANA timezone names (`Asia/Kolkata`, `America/New_York`) resolved via `Intl.DateTimeFormat`—never static UTC offsets—so Daylight Saving Time transitions never shift notification hours. |
| 4 | **Floating-Point Precision** | Currency amounts in empirical answers use exact base-10 `NUMERIC(18, 2)` in PostgreSQL and integer minor units (`paise`/`cents`) in TypeScript. Graph weights use IEEE-754 `REAL` with explicit clamping (`GREATEST(0.01, LEAST(0.999, val))`) to prevent NaN/Infinity drift. |
| 5 | **UUID Strategy** | All primary keys (`users.id`, `questions.id`, `answers.id`) use **UUIDv7** (RFC 9562), embedding a 48-bit Unix millisecond timestamp prefix followed by 74 bits of CSPRNG entropy. This eliminates B-tree page fragmentation and random I/O amplification caused by UUIDv4. |
| 6 | **Database Migration Rollback** | Strictly enforces the **Expand-and-Contract (Parallel Change)** pattern: migrations never rename or drop columns in-place. Phase 1 adds nullable column \+ dual-write trigger; Phase 2 backfills in batches of 5,000; Phase 3 switches reads; Phase 4 drops legacy column in the next release. |
| 7 | **API Deprecation Policy** | URI path major versioning (`/api/v1/...`) \+ RFC 8594 `Deprecation` and `Sunset` HTTP headers emitted 90 days prior to removal, with automated telemetry alerts if deprecated endpoint traffic exceeds `0.05%`. |
| 8 | **Browser Compatibility Matrix** | Targets Baseline Widely Available (`Chrome >= 115`, `Safari >= 17`, `Firefox >= 119`). The Living Graph Engine implements a 3-tier progressive renderer: **WebGPU** (Tier 1\) \$\\to\$ **WebGL2 Instanced** (Tier 2\) \$\\to\$ **SVG / Accessible Semantic DOM** (Tier 3 fallback). |
| 9 | **Memory Profiling** | Zero object allocation inside the `requestAnimationFrame` loop; pre-allocated `Float32Array` typed buffers for node coordinates `(x, y, vx, vy, radius, colorIndex)`. Automated Playwright heap-snapshot tests fail CI if detached DOM nodes or heap growth exceed `2 MB` after 50 route navigations. |
| 10 | **CPU Profiling** | Continuous production profiling via V8 `CpuProfiler` sampled at `99Hz` on 1% of API instances, alerting if any synchronous function blocks the Node.js event loop for `> 12ms`. |
| 11 | **Battery Consumption** | Adaptive frame-rate governor throttles graph canvas physics from `120fps` to `30fps` when `BatteryManager.charging === false && level < 0.25`, and pauses physics (`0fps`) after `8 seconds` of pointer inactivity after pulses settle. |
| 12 | **Offline Conflict Resolution** | Draft questions and in-progress empirical answers persist locally in `IndexedDB` via an append-only local mutation queue; upon reconnection, client state reconciles using vector clocks and idempotency keys without losing typed text. |
| 13 | **Undo Architecture** | Destructive or state-changing actions (e.g., passing on a routed question or revoking a helpful vote) use the Command pattern with a `7-second` optimistic client-side grace buffer and a reversible soft-state database transition before hard commit. |
| 14 | **Optimistic Concurrency Control** | Every mutable entity row carries an integer `version` column. Updates execute `UPDATE questions SET ..., version = version + 1 WHERE id = $1 AND version = $2`; if `rowCount === 0`, the service raises a `409 Conflict` and merges state safely. |
| 15 | **Event Versioning** | Domain events in `outbox_events` carry a `schema_version` integer (`v1`, `v2`). Event consumers run an **Upcaster Chain** that transforms legacy `v1` payloads into the latest `v2` TypeScript interface in memory before handler execution. |
| 16 | **Data Archival** | Resolved routing logs (`question_routings`) older than 90 days are declaratively partitioned by month (`PARTITION BY RANGE (dispatched_at)`) and detached/compressed into Parquet files on Cloudflare R2 object storage while keeping aggregated weights hot in Postgres. |
| 17 | **Disaster Recovery Drills** | Automated monthly "GameDay" script restores a fresh PostgreSQL cluster from WAL archives, verifies cryptographic row checksums, switches staging traffic over within the `10-minute` RTO target, and posts a signed verification report. |
| 18 | **Secret Rotation Drills** | Dual-key active/next envelope rotation: JWT signing keys (`kid`), Redis passwords, and OAuth secrets support two simultaneous active secrets during a 24-hour rollover window, rotated automatically every 30 days with zero dropped sessions. |
| 19 | **Incident Runbooks** | Every Prometheus/Grafana alert annotation embeds a direct link to a deterministic Markdown runbook (`docs/runbooks/pgvector-latency-spike.md`) containing exact diagnostic SQL queries and 1-command mitigation steps. |
| 20 | **Feature Kill Switches** | Sub-second dynamic configuration pushed via Cloudflare KV / Edge Config allows disabling live graph WebGL rendering, cross-encoder reranking, or Wave 2 notifications globally within `500ms` without redeploying code. |
| 21 | **Chaos Engineering** | Scheduled staging chaos experiments randomly terminate BullMQ worker processes mid-job to verify that stalled jobs recover cleanly via Redis lock expiration and idempotent retry handlers. |
| 22 | **Threat Simulations** | Quarterly automated red-team scripts simulate coordinated 50-node Sybil rings attempting to hijack reputation in a low-density field, verifying that Personalized PageRank damping isolates the ring. |
| 23 | **Supply-Chain Dependency Audits** | Strict `pnpm-lock.yaml` with `--frozen-lockfile`, npm provenance attestation verification, Socket.dev behavioral blocking for install scripts (`ignore-scripts=true`), and automated CycloneDX SBOM generation on every build. |
| 24 | **Build Reproducibility** | Multi-stage Dockerfiles pin base images by immutable SHA-256 digest (`node:22-alpine@sha256:...`) and set `SOURCE_DATE_EPOCH` so identical git commits produce byte-for-byte identical container layers. |
| 25 | **Performance Budgets** | Enforced in CI via `size-limit` and Lighthouse CI: initial JS `< 65 KB`, CSS `< 14 KB`, WOFF2 font subset `< 28 KB`, API `p95 < 100ms`, failing the build automatically if any threshold regresses. |
| 26 | **Accessibility Audits** | Automated Playwright tests traverse the entire ask-route-answer flow using **only keyboard events (`Tab`, `ArrowKeys`, `Enter`, `Escape`)** with pointers disabled, asserting focus ring visibility and `aria-live` announcements at every step. |
| 27 | **Design Review Checklists** | Every UI pull request requires passing a 12-point craft gate: squircle curvature continuity, OKLCH token usage (zero raw hex codes), tabular numerals on numbers, `44px` hit targets, and `CLS = 0.000`. |
| 28 | **Privacy Impact Assessments** | Any schema change touching `users` or `question_routings` triggers a mandatory automated PIA check in CI verifying that no new PII column is introduced without an explicit retention TTL and RLS policy. |
| 29 | **Operational Playbooks** | Pre-scripted operational procedures for database connection storms, HNSW index rebuilds (`CREATE INDEX CONCURRENTLY`), spam wave containment, and cold-start field seeding. |

---

## 23\. References

1. [Apple Human Interface Guidelines — Design Principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)  
2. [Google Site Reliability Engineering (SRE) Books & Workbook](https://sre.google/books/)  
3. [pgvector — Open-Source Vector Similarity Search for Postgres (HNSW & halfvec)](https://github.com/pgvector/pgvector)  
4. [Google Search Central — Schema.org Structured Data for Q\&A Pages (QAPage)](https://developers.google.com/search/docs/appearance/structured-data/qapage)  
5. [Schema.org — QAPage Specification](https://schema.org/QAPage)  
6. [W3C — Web Content Accessibility Guidelines (WCAG) 2.2 Official Recommendation](https://www.w3.org/TR/WCAG22/)  
7. [OWASP Top 10 Web Application Security Risks](https://owasp.org/projects/top-ten)  
8. [Fastify — Low-Overhead Web Framework for Node.js](https://fastify.dev/docs/latest/)  
9. [Cloudflare Workers — Serverless Edge Execution Documentation](https://developers.cloudflare.com/workers/)  
10. [React — Official Documentation & Concurrent Rendering Reference](https://react.dev/reference/react)  
11. [Vite — Next Generation Frontend Tooling](https://vite.dev/guide/)  
12. [Supabase — PostgreSQL Row Level Security (RLS) Guide](https://supabase.com/docs/guides/database/postgres/row-level-security)  
13. [Google web.dev — Core Web Vitals (LCP, INP, CLS) Specification](https://web.dev/articles/vitals)
