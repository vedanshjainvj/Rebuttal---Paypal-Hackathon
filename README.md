<div align="center">

# Rebuttal

**An evidence desk for PayPal disputes.**

Most merchants lose chargebacks by default, not on merit.
Rebuttal finds the proof, cites it line by line, and files it before the clock runs out.

*Built for the PayPal AI Hackathon 2026.*

</div>

---

## The problem

A buyer files a dispute. PayPal freezes the money and starts a clock.

Somewhere in the merchant's systems the answer already exists — a carrier scan with a signature, an order record showing the address never changed, a support thread where the buyer wrote *"found it, my neighbour took it in."* Assembling that takes an hour across four tools.

So it doesn't happen. The deadline passes, and PayPal decides on the evidence on file — which is nothing.

**The merchant didn't lose the argument. They never made one.**

---

## What Rebuttal does

```
dispute filed  →  webhook  →  search the merchant's records  →  draft with citations
                                                                        ↓
                        filed with PayPal  ←  one human click  ←  grounding check
```

1. **PayPal fires a webhook.** Signature verified against PayPal's own endpoint. Unverifiable deliveries are rejected, never stored.
2. **The dispute is pulled and projected** into a schema that mirrors the Disputes API, full payload retained.
3. **Hybrid retrieval** searches the merchant's corpus — pgvector semantic search fused with Postgres full-text, Reciprocal Rank Fusion.
4. **Gemini drafts a response** under a structured schema: claims, each with a verbatim quote and the record it came from.
5. **The grounding check runs.** Any claim that cannot be mechanically verified is discarded before it touches the database.
6. **A human reviews** one screen: the claims, their sources, a win read, and the deadline.
7. **One click files it** through `POST /v1/customer/disputes/{id}/provide-evidence`.

---

## The hard part

Asking a model to cite its sources is easy. It will comply — confidently, and sometimes incorrectly.

Submitting a fabricated quote to PayPal as evidence is worse than filing nothing at all. So the grounding rule is not a prompt instruction. It is **two mechanical checks between the model and the database**, and a `NOT NULL` constraint that makes an uncited claim physically unstorable.

### Check one — provenance

Every claim carries a quote. That quote must appear **character for character** in the record it cites, after normalising only case, whitespace, and the typographic punctuation models substitute (curly quotes, en dashes, ellipsis). Words are never altered, so a paraphrase fails.

### Check two — relevance

This one came from a real failure.

Retrieval is similarity-based. A dispute with *no* matching records still returns the eight most **similar** ones — and another customer's delivery scan looks extremely relevant to any not-received dispute.

> A real `$1.00` dispute over transaction `5NA45408PT718622X` drafted at **95% confidence** citing order 4471 — a different buyer, a different transaction. Every quote was verbatim. Provenance passed it.

Filing that would have been a disaster. The fix is **transitive identifier linkage**: start from the disputed transaction id, extract identifiers from every record, and expand to a fixed point.

```
8KJ21094TR884120N  →  order 4471  →  tracking 122533485  →  support thread #9120
   (the dispute)       (order rec)     (carrier scan)        (buyer's admission)
```

The chain reaches records that never mention the transaction at all. Records that never link are rejected as `WRONG_CASE`. Records carrying **no** identifiers — policies, terms — are admissible as context but can never constitute a case on their own.

That same dispute now refuses to draft, and says why.

### See it yourself

```bash
npm run grounding:probe
```

Five hand-written claims against real retrieved records:

| Claim | Verdict |
| --- | --- |
| Quote copied verbatim | ✅ accepted |
| Paraphrase, identical meaning | ❌ `QUOTE_NOT_FOUND` |
| Plausible fabricated detail | ❌ `QUOTE_NOT_FOUND` |
| Invented chunk id | ❌ `UNKNOWN_CHUNK` |
| **Real quote, wrong record cited** | ❌ `QUOTE_NOT_FOUND` |

That last row matters most: a *true* quote attributed to the wrong source still fails.

---

## Proof it works

Real output from the pipeline, not a mockup.

**Strong evidence** — `LOCAL-DEMO-4471`, not received, $248.00

```
state    DRAFTED        98% win read        3 cited claims, 0 rejected, 11.7s

1. The order was delivered to the customer's address and signed for by the recipient.
   └ FedEx delivery scan — tracking 122533485
     "Status: DELIVERED. Delivered 14 September 2026 at 09:12 local time.
      Location: front door. Signature obtained: R OKONJO."

2. The customer confirmed receipt in a support thread after claiming it was missing.
   └ Support thread #9120 — R. Okonjo
     "found it, my neighbour took it in — sorry for the trouble."
```

**Weak evidence** — `LOCAL-DEMO-4788`, credit not processed, $415.00

```
state    DRAFTED        10% win read        1 cited claim

"While this refund authorisation was entered on that date, we recognise that
 authorisation alone does not provide proof of completed settlement."
```

It scored itself at 10 and said why. A system that only ever returns 95% is worthless — the honest low score is the feature.

**No linkable evidence** — refuses outright

```
state    FAILED         no score

No record could be linked to this transaction — only general policy documents
matched, which prove nothing about this specific case
```

One attempt, non-retryable, **zero model calls**. Linkage is checked before Gemini is ever invoked, because the answer was knowable without it.

---

## Architecture

```
┌─────────────┐   webhook    ┌──────────────────────────────────────┐
│   PayPal    │─────────────▶│  verify signature  (fails closed)    │
│  Disputes   │              │  record event      (unique id =      │
│     API     │◀─────────────│                     idempotency)     │
└─────────────┘ provide-     └──────────────┬───────────────────────┘
                 evidence                   │ enqueue
                                            ▼
                               ┌────────────────────────────┐
                               │  jobs  (Postgres table)    │
                               │  FOR UPDATE SKIP LOCKED    │
                               └────────────┬───────────────┘
                                            │ claim
                       ┌────────────────────┴────────────────────┐
                       ▼                                         ▼
          ┌─────────────────────────┐              ┌──────────────────────┐
          │   hybrid retrieval      │              │   Gemini drafting    │
          │  pgvector  +  full-text │─────────────▶│  structured output   │
          │      fused by RRF       │   records    │  claims + quotes     │
          └─────────────────────────┘              └──────────┬───────────┘
                                                              │
                                              ┌───────────────▼──────────────┐
                                              │    GROUNDING CHECK           │
                                              │  provenance  +  relevance    │
                                              │  ungrounded claims discarded │
                                              └───────────────┬──────────────┘
                                                              ▼
                                                   packet + cited claims
                                                              │
                                      LISTEN/NOTIFY ──▶ SSE ──▶ operator console
```

The worker and web server are separate processes. Events cross that boundary through Postgres `LISTEN/NOTIFY`, bridged to the browser over Server-Sent Events — no broker, nothing extra to keep alive.

**8 tables · 65 TypeScript files · ~8,200 lines · 9 production dependencies.**

---

## Quickstart

Requires **Node 20+**. Every service below has a free tier; total cost to run this is **$0**.

```bash
git clone <this-repo> && cd rebuttal
npm install
cp .env.example .env     # fill in the four marked values
npm run db:setup         # extensions, migrations, merchant row
npm run evidence:seed    # indexes 14 records with real embeddings
```

Then, in two terminals:

```bash
npm run dev       # web, port 3000
npm run worker    # drafting worker
```

Open **http://localhost:3000**.

### Four values you need

| Variable | Where | Free? |
| --- | --- | --- |
| `DATABASE_URL` | [neon.tech](https://neon.tech) — needs `vector`, created by `db:migrate` | yes, no card |
| `PAYPAL_CLIENT_ID` / `_SECRET` | [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → **Sandbox** | yes |
| `PAYPAL_MERCHANT_ID` | the sandbox **business** account your REST app belongs to | yes |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | yes, no card |

### No PayPal dispute? Start here.

Sandbox disputes cannot be created through the API — a buyer must file one by hand. So the repo ships practice cases that exercise the **real** retrieval, drafting and grounding pipeline:

```bash
npm run packet:draft -- --demo    # six cases, varied evidence strength
```

Then press **Draft response** in the UI, or:

```bash
npm run packet:draft LOCAL-DEMO-4471   # strong   → ~98%
npm run packet:draft LOCAL-DEMO-4788   # weak     → ~10%
npm run packet:draft LOCAL-DEMO-0000   # unlinked → refuses
npm run packet:draft -- --reset        # run them all again
```

Practice cases are prefixed `LOCAL-`, labelled in the interface, and filing is disabled for them. **Nothing in this repo presents fixture data as a real result.**

### Connecting real PayPal

```bash
ngrok http 3000                    # PayPal must reach you from the internet
# set APP_BASE_URL to the https URL, then:
npm run paypal:webhook register    # prints PAYPAL_WEBHOOK_ID for .env
npm run paypal:doctor              # credentials, webhooks, disputes by state
```

A sandbox buyer files a dispute at [sandbox.paypal.com](https://www.sandbox.paypal.com) against a **Goods and Services** payment. Friends-and-Family payments cannot be disputed.

---

## Tools used

| Tool | How it is used |
| --- | --- |
| **PayPal Disputes API v1** | The core. Nine endpoints: `list`, `show`, `provide-evidence` (multipart), `send-message`, `make-offer`, `accept-claim`, `escalate`, `provide-supporting-info`, `acknowledge-return-item`. Actions are offered only when PayPal's own HATEOAS links permit them. `appeal` is not implemented. |
| **PayPal Webhooks** | `CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED`, registered programmatically. Signatures verified via PayPal's `verify-webhook-signature` endpoint. |
| **PayPal OAuth 2.0** | Client-credentials tokens, cached with early refresh and single-flight so a cold start can't stampede. |
| **Google Gemini** | `gemini-3.1-flash-lite` for drafting under a JSON schema; `gemini-embedding-001` at 768 dimensions for retrieval. OpenAI wired as an automatic fallback on rate limits. |
| **Neon Postgres + pgvector** | Database, vector index (HNSW, cosine), full-text index, job queue, and the event bus. |
| **Render** | Deployment target. [`render.yaml`](render.yaml) is committed and deploys on the free plan. |

**Not used, and deliberately not claimed:** AG Grid, Bryntum, APIMatic, Elastic, Channel3. The docket is a hand-built grid and the deadline view is a placeholder. Adding a sponsor dependency to tick a box would have meant less time on the grounding guard, which is the part of this that matters.

---

## Engineering decisions

Each of these was a real fork in the road.

**Reciprocal Rank Fusion, not weighted scores.** Cosine similarity and `ts_rank` are on incomparable scales, and `ts_rank` is unbounded and corpus-dependent. Blending them needs a constant that must be retuned whenever the corpus changes. RRF reads only the *ordering* of each list, so it needs no tuning.

Both halves earn their place. Querying `122533485` ranks the FedEx scan first by exact match — embeddings are notoriously weak on identifiers. Querying *"the customer later admitted the parcel turned up"* finds a thread reading *"found it, my neighbour took it in"* — **zero** shared keywords.

**The job queue is a Postgres table.** `FOR UPDATE SKIP LOCKED` lets any number of workers share it with no broker, no Redis, nothing extra to fail during judging. It also made the free-tier deploy possible: the worker runs embedded in the web process, and promoting it to a dedicated service is a config flip.

**Webhook verification fails closed**, and uses PayPal's verify endpoint rather than local RSA. Local verification needs cert-chain validation, CRC32 of exact raw bytes, and precise signature assembly — each easy to get subtly wrong in a way that *silently accepts forged events*. One round trip buys an authoritative answer. The `cert_url` host is pinned to `paypal.com` regardless.

**PayPal vocabularies are `text`, not Postgres enums.** PayPal adds reason codes over time. An unrecognised value must land in the database for a human to read, not abort the webhook with a type error. Enums are used only for states this system owns.

**Filing runs inline; drafting is queued.** Drafting takes ten seconds and belongs in a worker. Filing is irreversible and a human just pressed the button — they must see PayPal's real answer, not an optimistic "queued" that dead-letters minutes later.

---

## Bugs found by running it

Every one of these was invisible until the system was exercised end to end. They are listed because the fixes are the engineering.

| Bug | Why it mattered |
| --- | --- |
| **Borrowed evidence** | A dispute with no records drafted at 95% citing another customer's delivery proof. Every quote verbatim. Caused the relevance check to exist. |
| **Pooled `LISTEN/NOTIFY` silently fails** | Neon's pooler is PgBouncer in transaction mode; `LISTEN` binds to a session it immediately reassigns. The call *succeeds* and events vanish. The bus now holds its own direct connection. `npm run db:notify-check` proves it either way. |
| **One Postgres connection per browser tab** | Each SSE client called `sql.listen()`. With a pool of five, a few tabs starved it and every query failed with `CONNECT_TIMEOUT` while the database was healthy. Now one listener per process, fanned out in memory. |
| **UI stuck on "Drafting" forever** | `router.refresh()` updates server data but preserves client state, so the phase survived the very update saying the draft finished. Now reconciled against server state, with a poll fallback that engages only while work is in flight. |
| **Refusals burned 5 model calls** | "No claims survived" took the retryable path. Linkage is now checked before the model is called — deterministic, non-retryable, one attempt. |
| **404s returned 200** | A root `loading.tsx` made every route stream, committing the header before `notFound()` could run. Removed. |
| **`gemini-2.5-flash` is closed to new keys** | Returns 404 — and `ListModels` still advertises it. `npm run ai:doctor` shows what a key can *actually* call. |
| **pgvector HNSW caps at 2000 dimensions** | `gemini-embedding-001` returns 3072 by default. 768 via `outputDimensionality` is a hard requirement, not a preference. |

---

## Operator tooling

Built while debugging, kept because they earn their place.

| Command | What it tells you |
| --- | --- |
| `npm run paypal:doctor [id]` | Credentials, token, webhooks, disputes **by state** — the unfiltered list hides inquiry-stage cases |
| `npm run ai:doctor` | Which models this key can actually reach |
| `npm run db:notify-check` | Whether `LISTEN/NOTIFY` works on your endpoint |
| `npm run db:status` | Tables, row counts, queue depth by status |
| `npm run evidence:search "..."` | Retrieval probe — shows whether vector or keyword matched each hit |
| `npm run grounding:probe` | The guard, run against adversarial claims |
| `npm run job list` | Queue inspection, with the last error per job |
| `npm run dispute:sync` | Rebuild from PayPal after a missed webhook |

---

## What is real, and what is not

Judges should not have to guess.

**Real and running:** PayPal OAuth, webhook ingestion with signature verification, the Disputes API client with retry and idempotency keys, dispute sync, hybrid retrieval over live Gemini embeddings, drafting under a structured schema, both grounding checks, the job queue with retries and dead-lettering, cross-process events, and filing through `provide-evidence`. The full chain has run autonomously on a genuine PayPal sandbox dispute.

**Seeded, not connected:** the evidence corpus. A production deployment would sync from the merchant's order system, carrier webhooks and helpdesk. Here it is 14 fixture records so retrieval and grounding can be exercised without onboarding a real merchant.

**Not built:** the Deadlines screen is a placeholder. There is no authentication — the schema is multi-tenant but one merchant is seeded. No test suite; correctness is enforced by the grounding checks and verified by the probe scripts.

---

## Licence

MIT — see [LICENSE](LICENSE).

<div align="center">

---

*Every claim this system files quotes a record the merchant actually holds.*
*When it can't find one, it says so.*

</div>
