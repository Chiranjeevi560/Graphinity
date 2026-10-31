# ADR 0026: Step-up sign-in, transport headers and the DNS zone

- **Status:** Accepted 2026-11-01. Migration 0046. `step_up_auth` stays off until checked (below).

## Step-up

Deleting an account, exporting everything and moderators' decisions need a sign-in from the last
300 seconds, so an unlocked laptop can't be used for them.

An access token's `iat` can't prove this, because refreshing issues new tokens. `amr` is the claim that
records authentication methods. Supabase's documentation lists `token_refresh` among its methods but doesn't say
what its timestamp means, so the server ignores `token_refresh` entries and takes the newest other one. No usable
entry means not fresh.

**Not verified against real Supabase.** A wrong assumption would stop people deleting their accounts, which is
their legal right, so the switch ships off. `docs/RUNBOOK.md` has the one check needed before turning it on.
Passkeys need a domain and Supabase's support; not built.

## Headers

Website: `preload`, `Cross-Origin-Resource-Policy: same-origin` (except `/ads/*`, which partners' pages load),
and `serial=(), bluetooth=()` added. `Referrer-Policy` stays `same-origin`, stricter than the brief's
`strict-origin-when-cross-origin`: question URLs must not reach other sites at all.
`preload` has no effect until there's a domain of our own: `pages.dev` is Cloudflare's.

## DNS

`infra/dns/graphinity.zone` is the records for when a domain is bought. It needs an owner's decision and an account,
so nothing applies it. DNSSEC is switched on at the registrar and the HTTPS record is provided by Cloudflare.
