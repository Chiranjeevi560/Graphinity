# ADR 0034: Payments through Razorpay payment links, off by default

Date: 2026-11-04. Status: accepted at the owner's request ("build the payments system now, but keep it OFF by
default"). Turning it on stays the owner's decision.

## Context

Graphinity had no way to take money: advertisers' budgets and enterprise plans were numbers with nothing behind them.
Every payment processor keeps a fee per payment, which the zero-cost rule doesn't allow without the owner's choice, so
this is built and left off.

## Decision

- **Provider: Razorpay.** For an individual in India it has no setup or annual fee; it keeps 2% of each successful
  domestic payment, plus 18% GST on that fee (razorpay.com/pricing, checked 2026-11-04). Its test mode is free. It's
  called over HTTPS with no SDK (`apps/api/src/payments/razorpay.ts`), so another provider replaces one file.
- **Payment links, not an embedded checkout.** The payer opens Razorpay's own page from a link. No Razorpay script runs
  on Graphinity's pages, so the no-third-party-scripts rule and the Content-Security-Policy are unchanged, and
  Graphinity never sees a card number, UPI id or bank detail.
- **Nothing about the payer is sent.** No name, email or phone; Razorpay asks for what it needs on its own page.
- **Only Razorpay's signed webhook marks a payment paid.** HMAC-SHA256 of the raw body with the webhook secret,
  compared in constant time; each event id acted on once (against Razorpay's repeats, not replays: every effect is
  forward-only, so a replay changes nothing); events may arrive out of order, so a payment only moves forward (a
  database trigger refuses un-paying, shrinking what was received, or changing the link). "Paid" means the whole amount.
  If our call to Razorpay timed out after it made the link, the signed event's link is adopted, so money is never lost.
- **Two purposes:** an advertiser's owner buys prepaid ad credit (`POST /ads/advertisers/:id/payments`), and the
  platform's owner asks an organization to pay for its enterprise analytics plan (`POST /owner/enterprise/orgs/:id/payments`).
  ₹100 to ₹1,00,000 a payment.
- **Off twice:** the `payments` switch (API and database), and no keys means no payments whatever the switch says.
  Live keys are refused anywhere but the production server.
- **Kept for tax law, unlinked on deletion:** deleting an account or business leaves the payment's amount and dates
  with no link to whoever it was. The person who asked gets their payments in their data export.

## Not done, on purpose

- **Ad credit isn't yet spent against.** A paid payment is credit the advertiser can see; campaigns still run on their
  daily budgets, as before. Charging clicks against credit changes billing and needs its own decision and tests.
- **No screen.** The API returns the link; a "Pay" button costs script budget, which is full.
- **No refunds or invoices** (GST invoices need the owner's GSTIN, if any).

## Before turning it on

1. A Razorpay account in the owner's name, KYC done, and its test keys tried first (SETUP-ACCOUNTS.md, Part L).
2. The privacy page names Razorpay as the processor of payments; the terms say what credit buys and the refund rule.
3. The owner's view on GST registration and invoices (an accountant's question).
4. Then the keys on Render, the webhook in Razorpay, and `UPDATE app.feature_flags SET enabled = true WHERE name = 'payments';`.
