# ADR 0036: Affiliate referrals, labelled, apart from answers, off by default

Date: 2026-11-04. Status: accepted at the owner's request to build the affiliate engine; off by default.

## Context

The report lists the affiliate engine as not built; only its consent wording existed (`affiliate_optimization`,
migration 0003). Referrals are income that needs no advertiser, but they must never bend what people are told:
answers are people's experience (ADR 0003: no paid influence on knowledge).

## Decision

- **The owner adds programs and links.** A program is a shop or network: the host its links may go to, the query
  parameter and value that earn commission, and optionally the parameter it echoes back with a sale. A link is a label
  and a destination on that host, attached to a question. Only the owner, only while `affiliates` is on, in the API
  and the database; every change audited.
- **No open redirect:** a destination's host may hold only lowercase letters, digits, dots and hyphens (no `user@`,
  port, backslash or `%`-escape that a browser would read differently), and must be the program's host or a subdomain,
  in the API schema and a database trigger that fails closed; the redirect also re-reads the address as a browser does
  and refuses anything off the site. The first version's check was bypassable three ways (found by the independent
  review, with a working attack); each is now a test.
- **Shown apart and labelled:** `GET /questions/:id/affiliate-links` returns at most five, with a disclosure that
  Graphinity may earn a commission and that it never changes which answers are shown. Links never enter any ranking.
- **Following a link** (`POST /affiliates/go/:token`): counted per link per day, with no person, address or time of
  day; the reply is the shop's address with the tag. Only for a signed-in reader who said yes to
  `affiliate_optimization` and sent no `Sec-GPC` does the address also carry a random click token, which names the
  link, never the reader, and is deleted after 90 days.
- **Sales:** a network's server reports `POST /affiliates/postback`, signed with that program's own key (an HMAC
  derived from the server's key, given to the network once and never stored); each order counted once.

## Not done

- **No screen:** the question page doesn't show the links yet (script budget is full).
- **No payout reconciliation:** commission reported is recorded; money arrives from the network, outside the code.

## Before turning it on

1. An affiliate agreement with each shop or network, and the tag they assign.
2. The privacy page and terms say Graphinity shows labelled affiliate links and what a click shares (the tag; with
   the reader's yes, a random click token).
3. `UPDATE app.feature_flags SET enabled = true WHERE name = 'affiliates';` then add programs and links.
