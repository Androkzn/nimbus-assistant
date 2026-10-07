# NimbusStack Product Knowledge Assistant

An internal chatbot that answers questions about NimbusStack's four products — **only** from the supplied knowledge base, with the source passages shown under every answer. Users pick Claude, OpenAI or Gemini; a backup provider takes over automatically; every answer shows tokens and estimated cost.

**Live:** https://nimbus-assistant-coral.vercel.app · **Specs:** [`docs/requirements/`](docs/requirements/) · **Latest eval report:** [`evals/reports/`](evals/reports/)

---

## Run it locally

Requirements: **Node.js 22.12+** (`.nvmrc` pins 22 — Vitest 5 needs it) and npm.

```bash
git clone https://github.com/Androkzn/nimbus-assistant.git
cd nimbus-assistant
npm ci
cp .env.example .env.local      # add at least one key: GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY
npm run dev                     # http://localhost:3000
```

No keys at hand? `LLM_MODE=mock npm run dev` runs the whole app with a deterministic offline model (same UI, retrieval, streaming and fallback code paths).

## Verify it

```bash
npm test                         # unit + integration tests, incl. the offline retrieval eval
npx playwright install chromium  # once
npm run build && npm run e2e     # browser tests against the production build (mock LLM)
npm run scan:bundle              # fails if any API key material is in the browser bundle
npm run ci                       # all of the above + typecheck + lint
```

Live answer quality (real providers, needs keys and a running app):

```bash
npm run build && npx next start -p 3300 &
npm run eval:live -- --base-url http://localhost:3300 --models gemini-flash-lite,claude-haiku,openai-luna --open
```

It grades the golden questions in `evals/golden-set.json` (the brief's Q1–Q6, follow-ups, conflicts, false-conflict checks, out-of-KB questions) with deterministic checks — including the figure check on every answer — and writes a live-updating HTML report to `evals/reports/<timestamp>/`.

### Simulate provider failures (brief E8/E9)

Run locally with `ALLOW_FAULT_INJECTION=1 npm run dev` (or `LLM_MODE=mock`) and append a marker to a question. It is deliberately **off** in production.

| Marker | What happens |
|---|---|
| `#fail-primary` | selected model fails before answering → backup answers, labelled |
| `#fail-midstream` | selected model fails after a few words → partial text discarded, backup's full answer shown |
| `#rate-limit-all` | every provider returns 429 → clear "wait N seconds or choose another model" message |
| `#auth-primary` | selected model's key rejected → backup answers |

---

## How it works

```
Browser ──POST /api/chat──▶ validate (zod) · rate-limit ─▶ retrieve passages ─▶ build answer contract
   ▲                                                                                │
   └──────── NDJSON stream: meta → sources → delta… → done{answeredBy, usage, cost} ◀── fallback runner
                                                    (fallback / reset / error events)   │
                                         Gemini ◀──────────────┬──────────────▶ OpenAI ─┴─▶ Claude
```

1. **Retrieval first (R2).** The 10 documents are split by `##` section with tables kept whole and every chunk prefixed with document title and date. BM25 ranking plus a synonym map (SSO ≈ SAML ≈ federated login ≈ OIDC, 403 ≈ forbidden, SLA ≈ response time…). Cross-product questions take the best passage **per product** (so "which products support SAML?" never misses Ledger, whose doc only says "federated login"). Topics with known document drift (sign-on, pricing) also pull the product's release notes and the company-wide section, so **both sides of a conflict** reach the model. Follow-ups without a product inherit the last product named, and "And for Vault?" keeps the previous question's topic (E1). Nicknames from the docs' own descriptions resolve to products ("API gateway" → Relay).
2. **Answer contract.** The system prompt allows only the numbered passages, requires `[n]` citations, a fixed "I couldn't find this in the NimbusStack knowledge base." for gaps, partial answers that name what's missing, and a `⚠️ Documents disagree:` line — plus what applies today — only when documents state different values (E2–E4). When a release note announces a change ("changes to $59", "extended to the Pro tier"), retrieval points the model at it and every other passage on that product. User text is never treated as instructions.
3. **Deterministic grounding layers (beyond the prompt).** *Off-topic guard*: if nothing in the knowledge base matches and no product is in scope, the answer is "not in the knowledge base" with **no model call**. *Figure check*: every number in an answer must appear in its passages or the conversation; otherwise the answer shows "Not found in sources: … — verify before quoting", the event goes to Sentry, and the live eval fails the case.
4. **Fallback state machine (R3/R5).** Selected model first, then `fallbackOrder` from config, alternating vendors. Error before the first word → next model. Error mid-answer → a `reset` event clears the partial text before the backup streams, so output from two models is never mixed (E8). Rate limits, bad keys/billing and outages are classified and turned into plain-language messages (E9). SDK retries are off so failover is fast and observable.
5. **Usage & cost (R4).** Token counts come from the provider; cost uses the **answering** model's list prices from config. Session totals, a context-window meter (amber 75 %, red 90 %, re-rated instantly on model switch) and CSV/JSON export run in the browser.
6. **Security & observability (R5).** Keys are read only in `src/server/llm/providers.ts`; vendor error bodies never reach the browser; logs carry no message text; per-IP rate limit and message size cap protect the public URL. A CI gate scans the built client bundle for key patterns and for the literal key values. Sentry records errors and handled provider failures with no message text (`src/shared/sentry.ts`).

## Key decisions

| Decision | Why | Trade-off / next step |
|---|---|---|
| Lexical retrieval (BM25 + synonyms), no vector DB | Corpus is ~3k tokens: deterministic, offline-testable, zero extra vendor | Add embeddings + reranker when the corpus grows (PDFs, wikis, email) |
| Own NDJSON event protocol | First-class `sources`, `fallback`, `reset`, `usage` events, validated by one zod schema on both sides | Slightly more client code than an SDK UI hook |
| Default model **Claude Haiku 5.5**, fallback → Gemini 3.1 Flash-Lite → GPT-5.6 Luna → … | Measured on the 30-case golden set: all three pass 30/30; Flash-Lite once misread Pro prices as "Custom" (intermittent), Claude never misread a table across runs, at ~1.5 s to first word and the lowest token price; fallback alternates vendors so one outage can't take the app down | Re-run `eval:live` before changing models; numbers in `docs/requirements/05_Retrospective.md` |
| Everything model-related in `config/models.json` | Brief R3; prices carry a `pricingVersion` and vendor sources | Startup + test invariants reject a broken config |
| Deterministic grounding layers (off-topic guard, figure check) on top of the prompt contract | The worst failure — an answer not from the documents — should not rest on a prompt alone | The figure check catches invented numbers, not a correct number from the wrong row; the eval covers that |
| In-memory rate limiter | Enough for a single-instance public URL with no login | Per instance only, so not a budget cap: set monthly spend limits in the provider consoles; production → Redis/Upstash |
| No chat persistence or login | Out of scope per brief | Conversation lives in the tab |

## Project layout

```
config/models.json         model catalog, prices, context windows, fallback order
knowledge-base/            client documents (read-only, as delivered)
docs/requirements/         discovery → BRD → TRD → implementation plan → acceptance matrix → retrospective
src/server/                kb · retrieval · prompt · llm (providers, fallback, errors, faults) · chat · http
src/shared/                wire contracts, answer reducer, cost, context meter (used by server and browser)
src/components, src/client UI
e2e/                       Playwright specs (mock LLM)
evals/                     golden set + committed live-eval reports
scripts/                   bundle secret scan, live eval runner
```
