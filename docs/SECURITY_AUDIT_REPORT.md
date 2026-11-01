# Security audit report

Covers the charter run on branch `change/20261025-own-learning-platform`. **Passing these reviews doesn't make Graphinity unhackable.** Each round found real problems in code that had already passed tests, so more may exist.

## How it was done

| Round | Who | Scope | Outcome |
|---|---|---|---|
| First review | Six independent reviewers | The whole charter build | Findings fixed with attack tests, in commits recorded in `project report.md` |
| Three re-audits | Independent reviewers | Each round's fixes | Each smaller than the last |
| Fourth review | One independent reviewer | Everything from `f965e92`, including the second pass | 14 findings: 2 high, 5 medium, 7 low |
| Fifth review | One independent reviewer, across the 12 roles in the checklist | The fourth review's fixes | No critical or high. 10 of the 14 closed, 4 partly, and 8 new low or informational points, one of which is medium once the push is on |

The later reviews were one reviewer working through several roles, not 12 separate people. Reviews read the code and ran what they could locally. None touched production.

## Fourth review: findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| High | The partner push would send health, immigration and legal topics | Those topics are excluded, with a test |
| High | The push relied on a consent that described something else | Its own consent, `ads_partner_cohorts` (migration 0065), also requiring personalized ads |
| Medium | One id per month let a partner join lists into a profile | Ids differ per partner, topic and day |
| Medium | One search met "high intent" | A decayed score of 5 |
| Medium | Experiments enrolled people without consent, in everything, on a GET | Read-only GET, enrolment by name, deletion on withdrawal (0066) |
| Medium | Cost per person summed mismatched periods | One finished month on both sides |
| Medium | Lifetime value counted cohorts wrongly | Weeks with nobody active count. The figure is still labelled rough |
| Low | Memory preference could outlive withdrawal | Takes the consent lock |
| Low | New search route used rare journeys another route hides | The same floor of 5 steps |
| Low | Experiment covariate and outcome were invalid | Fixed window, refreshed hourly |
| Low | Diversified searches logged as the plain ranker | Logged with their arm |
| Low | A vector failure broke search | Falls back to plain order |
| Low | The moderator queue could wrongly say "None waiting" | Steps back a page |
| Low | Failed pushes were invisible to the owner | Shown on the owner page |

## Fifth review: findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| Medium once on | List order linked ids across days | Ids are sorted before sending |
| Low to medium | An experiment row could outlive a withdrawal in a race | Enrolling holds the consent row (0068) |
| Low | `created_at` stood in for an experiment's start | `started_at`, stamped on running (0068) |
| Low | Cost per person could still read high | Finished months only, and every cohort's size |
| Low | Silent vector failure dulled the experiment | Logged |
| Low | The purity rule skipped one file | That file gets both rule sets |
| Low | Wording cut from the owner form without saying so | Restored |
| Information | The forecast route lacked 90 days, and `port` was dropped from claims | Both returned |

## Scanners

CodeQL reports three alerts I judge false positives, on the sign-in hook and the local sign-in stand-in, with reasons in the pull request. They need the owner's dismissal. Semgrep's one finding was a real, if unexploitable, gap, and is fixed. Dependency scanning skips one medium advisory until 2026-11-15, as exception E2.

## Still open

- The partner push can't see a browser's GPC signal. It's off, and that must be solved before it's on.
- Its consent wording promises partners delete within 30 days, which needs a real contract and a lawyer.
- Partners get no removal signal: this relies on ids being useless the next day.
- A schema owner could rewrite the audit log: it's unkeyed. See `SECURITY.md`.
- Step-up sign-in is off until the owner turns it on. Passkeys aren't built.
- The fifth review's fixes haven't been reviewed independently.
- Nothing has been tested against production.
