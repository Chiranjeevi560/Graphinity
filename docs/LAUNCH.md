# Launch checklist

What stands between today and opening Graphinity to everyone. Done items were built and tested
locally; the rest need the owner's accounts, devices or a lawyer.

## Built and tested locally

- Steps 1–6 of PLAN.md: sign-in, profiles, questions and answers, picks and points, routing,
  live updates, web push, reporting and moderation.
- Draft privacy and terms pages (`/privacy`, `/terms`), written from what the code stores. Marked
  "Draft" on the page until reviewed.
- Deploy configuration: `render.yaml` (API), Cloudflare Pages settings (RUNBOOK.md), keep-awake
  Worker (`workers/keep-awake.js`).

## Needs the owner

- [ ] Google Cloud: add our callback address and remove the profile scope (SETUP-ACCOUNTS.md Part F).
- [ ] Supabase: check the `postgres` role and make yourself a moderator (Part G).
- [ ] Render and Cloudflare accounts, and the deploy (RUNBOOK.md "Deploy").
- [ ] A contact address for the privacy and terms pages.
- [ ] Real phones: an iPhone (Safari, added to the Home Screen for notifications) and an Android
      phone. Sign in, ask, answer, notifications, at the phone's own width and text size.
- [ ] Decisions still open: medal thresholds (now bronze 10, silver 50, gold 200 points); whether
      public profiles should appear in search (now: not); holding a freed name for some days
      before someone else can take it (now: not held).

## Needs a lawyer (before launch)

- [ ] Minimum age 18, and the age confirmation as built (a tick box).
- [ ] The privacy page against the laws that apply where people will use it (India's DPDP Act,
      GDPR for people in Europe, and others), including the transfers to Singapore and the US
      (Google, Cloudflare).
- [ ] Whether answers about health, law or money need more than the "not professional advice"
      paragraph in the terms.
- [ ] Ownership of posts and the licence we take to show them.
- [ ] The governing law and where disputes go (not in the terms yet).
- [ ] Retention: what Supabase, Render and Cloudflare keep in their own logs and backups.

## Known limits, accepted for now

- See SECURITY.md "Known gaps" for the security ones.
