# GrupChat's AI layer: guardrails in code

An excerpt from GrupChat's backend (Node, Firebase). GrupChat helps groups in Kenya plan things and pool money by M-Pesa. Two AI jobs run on a schedule inside the payments reconciliation loop:

- **Pool insights** (Claude Haiku): a two-line insight on a Quick Pool's page, written from the pool's totals only.
- **Admin review** (Claude Opus): every Monday, a review of 30 days of operating totals for the founder.

This is an excerpt, not a runnable app: imports of the Firestore client and Quick Pool metrics are left out.

## How it is built

1. **One gateway for every model call** (`services/ai/client.js`). No route calls a provider directly. A call is reserved against the job's limits first, priced and logged after, and it never throws: the caller gets `{ ok: false, reason }` and falls back to fixed wording.
2. **Limits live in code** (`limits.js`). Each job has ceilings for output tokens, runs per day, runs per subject per day, US dollars per day and a timeout. Configuration can lower a ceiling but never raise it, so a typo in an environment variable can't run up a bill. `AI_DISABLED=1` turns every job off.
3. **A ledger, reserved in a transaction** (`ledger.js`). A daily counter per job is checked and incremented before the call; tokens and cost are added after. A model with no known price is recorded as unpriced, never as zero, so a gap shows up instead of hiding (`prices.js`).
4. **Numbers are code; words are the model's** (`poolInsights.js`). The model sees only the facts it may use. Every answer is checked before anyone sees it: length, no links or @, nothing that looks like a phone number, no pressure or shaming words, and no number that isn't in the facts. A failed answer is retried once with the list of problems; a second failure falls back to a template that says the same facts in fixed words.
5. **Privacy by construction.** The models never see a member's name, phone number, email or anything a member typed, not even the pool's name.
6. **An evaluation set gates changes** (`scripts/eval-pool-insights.js`). About 30 fixtures across pool states and kinds, including quiet ones such as a pool for a funeral. A dry run checks the harness with a mock model; `--live` runs the real model for well under a cent. Changing a job's model (`models.js`) or prompt has to pass it first.
7. **Idempotent schedules** (`adminReview.js`). The weekly review is keyed by ISO week and an on-demand refresh by day, so a retry or a double click can't run it twice.

## Files

| File | What it does |
|---|---|
| `services/ai/client.js` | The gateway: reserve, call, price, log, never throw |
| `services/ai/limits.js` | Per-job ceilings that config can only lower |
| `services/ai/models.js` | Which model does which job |
| `services/ai/prices.js` | Cost per call from per-million-token prices |
| `services/ai/ledger.js` | Transactional reservation and the usage log |
| `services/ai/poolInsights.js` | Facts, prompt, checks, retry, template |
| `services/ai/adminReview.js` | The Monday review, keyed by week |
| `scripts/eval-pool-insights.js` | The evaluation set |

Rawlins Hamisi · Nairobi · grupchat.net
