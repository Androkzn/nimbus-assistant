# NimbusStack Product Knowledge Assistant

An internal chatbot that answers questions about NimbusStack's four products — **only** from the supplied knowledge base, with the source passages shown under every answer. Users pick Claude, OpenAI or Gemini; a backup provider takes over automatically; every answer shows tokens and estimated cost.

**Live:** https://nimbus-assistant-coral.vercel.app · **Specs:** [`docs/requirements/`](docs/requirements/) · **Latest eval report:** [`evals/reports/`](evals/reports/)

---

## Run it locally

Requirements: **Node.js 20.9+** (22 recommended) and npm.

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
npm test                         # 66 unit + integration tests, incl. the offline retrieval eval
npx playwright install chromium  # once
npm run build && npm run e2e     # 10 browser tests against the production build (mock LLM)
npm run scan:bundle              # fails if any API key material is in the browser bundle
npm run ci                       # all of the above + typecheck + lint
```

Live answer quality (real providers, needs keys and a running app):

```bash
npm run build && npx next start -p 3300 &
npm run eval:live -- --base-url http://localhost:3300 --models gemini-flash-lite,claude-haiku,openai-luna --open
```

It grades 18 golden questions (the brief's Q1–Q6, edge cases, conflicts, out-of-KB probes) with deterministic checks and writes a live-updating HTML report to `evals/reports/<timestamp>/`.

### Demo the fallback (brief E8/E9)

Start with `ALLOW_FAULT_INJECTION=1` (or `LLM_MODE=mock`) and append a marker to a question:

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

1. **Retrieval first (R2).** The 10 documents are split by `##` section with tables kept whole and every chunk prefixed with document title and date. BM25 ranking plus a synonym map (SSO ≈ SAML ≈ federated login ≈ OIDC, 403 ≈ forbidden, SLA ≈ response time…). Cross-product questions take the best passage **per product** (so "which products support SAML?" never misses Ledger, whose doc only says "federated login"). Topics with known document drift (sign-on, pricing) also pull the product's release notes and the company-wide section, so **both sides of a conflict** reach the model. Follow-ups without a product inherit the last product named (E1).
2. **Answer contract.** The system prompt allows only the numbered passages, requires `[n]` citations, a fixed "I couldn't find this in the NimbusStack knowledge base." for gaps, partial answers that name what's missing, and a `⚠️ Documents disagree:` line for conflicts (E2–E4). User text is never treated as instructions.
3. **Fallback state machine (R3/R5).** Selected model first, then `fallbackOrder` from config, alternating vendors. Error before the first word → next model. Error mid-answer → a `reset` event clears the partial text before the backup streams, so output from two models is never mixed (E8). Rate limits, bad keys/billing and outages are classified and turned into plain-language messages (E9). SDK retries are off so failover is fast and observable.
4. **Usage & cost (R4).** Token counts come from the provider; cost uses the **answering** model's list prices from config. Session totals, a context-window meter (amber 75 %, red 90 %, re-rated instantly on model switch) and CSV/JSON export run in the browser.
5. **Security (R5).** Keys are read only in `src/server/llm/providers.ts`; vendor error bodies never reach the browser; logs carry no message text; per-IP rate limit and message size cap protect the public URL. A CI gate scans the built client bundle for key patterns and for the literal key values.

## Key decisions

| Decision | Why | Trade-off / next step |
|---|---|---|
| Lexical retrieval (BM25 + synonyms), no vector DB | Corpus is ~3k tokens: deterministic, offline-testable, zero extra vendor | Add embeddings + reranker when the corpus grows (PDFs, wikis, email) |
| Own NDJSON event protocol | First-class `sources`, `fallback`, `reset`, `usage` events, validated by one zod schema on both sides | Slightly more client code than an SDK UI hook |
| Default model **Gemini 3.1 Flash-Lite**, fallback → GPT-5.6 Luna → Claude Haiku 5.5 → … | Measured: 18/18 on the golden set, ~1 s to first word, lowest cost; fallback alternates vendors so one outage can't take the app down | Re-run `eval:live` before changing models; numbers in `docs/requirements/05_Retrospective.md` |
| Everything model-related in `config/models.json` | Brief R3; prices carry a `pricingVersion` and vendor sources | Startup + test invariants reject a broken config |
| In-memory rate limiter | Enough for a demo URL with no login | Per instance only; production → Redis/Upstash |
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
