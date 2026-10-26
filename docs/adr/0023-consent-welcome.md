# ADR 0023: The welcome consent screen, three equal answers

- **Status:** Accepted 2026-10-27.
- **Owner decision (2026-10-26):** one screen at the start with "Accept all" and an equally easy
  way to choose, instead of one bundled tick (bundled consent isn't valid under DPDP 2023 §6 or
  GDPR Arts. 4(11) and 7). The master charter (§3.1) adds "Essential only" as a third answer of
  equal weight.

## Decision

- **When it's shown:** to a signed-in person while any optional purpose put to them is unanswered
  (`GET /me/consents` → `unanswered`). A purpose added later brings it back for that purpose only.
  It replaces the one-time "Two privacy updates" sheet, whose one question it now covers.
- **The answers:** "Essential only", "Choose", "Accept all", in one row, all the same button style,
  so none is visually preferred. Each is one tap. "Choose" opens the list in place, nothing ticked,
  each purpose with its own plain description; "Save choices" then takes the middle place.
  Escape is "Essential only": dismissing must never mean yes.
- **What "Accept all" can turn on:** only purposes put to that person. `app.consent_offered_for`
  (migration 0035) checks the purpose's switch and, for advertising purposes, that the rule for
  their country is approved by a lawyer and not prohibited. The API and the database trigger on
  `user_consent_settings` both refuse anything else, so no client can accept more.
- **The record:** every answer is written to the consent history with source `onboarding`.

## Verified

- `e2e/consent-welcome.spec.ts`, in Chromium and WebKit: equal height (exactly), width (within a
  pixel), font weight and size, and fill, plus text contrast ≥ 4.5:1 composited over the dialog,
  at 320, 375, 430 and 1280 wide in light and dark; ≥ 44 px tall; nothing pre-ticked; "Essential
  only", "Accept all" and Escape each recorded in one action and not asked again. Making "Accept
  all" the primary style fails the test.
- API: `unanswered` follows answers from either source; ad purposes aren't put to anyone until a
  lawyer approves the rule, and not where their country prohibits it, in the API and in the
  database. Each of these rules was broken on purpose and a test failed.

## Consequences

- Existing accounts see the screen once, for the purposes they never answered.
- Twenty purposes is a long list to read. They stay separate because each is a separate use the
  law asks to be chosen separately; grouping them under fewer headings is a wording change to
  make with a lawyer.
