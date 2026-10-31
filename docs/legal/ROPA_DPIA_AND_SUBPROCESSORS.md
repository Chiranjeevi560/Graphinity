# Record of processing, impact assessment and subprocessors

**Draft for a lawyer to review.** Nothing here is legal advice, and the deadlines in the code haven't been confirmed.

## Record of processing (GDPR Art. 30)

`apps/api/src/governance/ropa.ts` has the purpose, lawful basis and retention of every table, served at
`GET /privacy/ropa`. A test fails if a table has no entry.

## Impact assessment (GDPR Art. 35): personalization and advertising

| Question | Answer |
|---|---|
| What is processed | Reading and search history, personal graph items, interest topics, only under separate choices, each off by default |
| Who it could harm | Someone whose interests reveal something sensitive |
| What limits that | Ad audiences need 100 people; reports need 25 and carry noise; advertisers get no individual data; Sec-GPC stops personalization and sharing; forgetting a category or withdrawing removes the data |
| What's still open | Which ad parts are lawful per country. All are off until a lawyer says otherwise |

## Subprocessors

| Who | What for | Data |
|---|---|---|
| Supabase | Database and sign-in | All of it; Singapore |
| Render | API server | Passes through; no logs of content |
| Cloudflare | Website | Addresses, briefly, as any web host |
| Google | Sign-in | That a person signed in |
| Browser push services | Notifications | Encrypted payloads |
