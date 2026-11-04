# ADR 0027: The legal workflow

- **Status:** Accepted 2026-11-01. Migration 0047. Wording and deadlines for a lawyer to confirm.

## Decision

- **Complaints**: signed-in form at `/legal/complaint`, reference `GRV-YYYYMMDD-XXXXXXXX` (random), 24-hour
  acknowledgement, 72 hours for unlawful content and impersonation, 15 days otherwise, from the database's clock.
  A copyright notice needs a sworn statement. Moderators work them on `/ops`.
- **Statement of reasons**: every moderator removal writes one, readable by the author on their account page.
- **Appeal**: 14 days, once, decided by a different moderator. Overturning records a `keep` decision, which restores the post.
- **Record of processing**: `GET /privacy/ropa`, one entry per table; a test fails on a table with none.

## A conflict in the brief, and how it's resolved

The brief wants `legal_hold` to stop an author destroying evidence. The project's hard rule is "deleting an account
deletes everything". Blocking deletion would break a legal right of its own, so deletion still works, and the hold
keeps **a copy of the words with no author**, released when the window closes or the appeal is decided. Whether
that satisfies a real legal demand is for a lawyer.

## Limits

The automatic hide after 3 reports writes no statement until a moderator decides; a lawyer should say if that's
enough under DSA Art. 17. The Grievance Officer, whom IT Rules 2021 require on the site, is named on the Terms and Privacy
pages (owner, 2026-11-04). Statements cover questions and answers only.
