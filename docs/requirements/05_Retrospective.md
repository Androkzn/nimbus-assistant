# Retrospective — NimbusStack Product Knowledge Assistant

| Field | Value |
|-------|-------|
| **Doc type** | Delivery retrospective |
| **Client** | NimbusStack |
| **Date** | 2026-10-07 |
| **Author** | Andrei Tekhtelev |
| **Scored results** | [RESULTS_2026-10-07.md](RESULTS_2026-10-07.md) |

## Executive outcome

The project is a production candidate with a complete local verification story and a deployed URL. The local final live evaluation scored 90/90 across three configured models, while the production default-model run scored 29/30 because one false-disagreement response remains intermittent. The correct release posture is therefore “ready for targeted QA hardening,” not “all production checks green.”

## 1. How the work was run

| Phase | Output | Gate |
|-------|--------|------|
| 0 Discovery | [00_KB_Discovery.md](00_KB_Discovery.md): inventory, 2 conflicts, pitfalls per question, gap probes, answer key | — |
| 1 BRD | [01_BRD.md](01_BRD.md): 27 requirements traced to client goals, user stories with Given/When/Then, assumptions A1–A13 | self-review cycle and client-review queue |
| 2 TRD | [02_TRD.md](02_TRD.md): contracts for 27/27 requirements, ADRs, fallback state machine, production controls, and test strategy | coverage checksum |
| 3 Plan | [03_Implementation_Plan.md](03_Implementation_Plan.md): phases with acceptance + verification commands | readiness gate |
| 4 Build | Phase-by-phase, tests first | each phase's verification command |
| 5 Verify | 129 unit/integration · 12 E2E · bundle scan · live eval on 3 vendors · deployment smoke | CI + committed eval reports |

The answer key in the discovery doc became three test layers: the offline **retrieval eval** (CI gate), the **mock-LLM E2E** suite, and the **live answer eval** against real providers.

## 2. What each gate caught (defects found before the client saw them)

| # | Gate | Defect | Fix |
|---|------|--------|-----|
| 1 | Retrieval eval | Off-topic question ("weather in Paris") not flagged — stray token `s` from "what's" matched every document | Drop 1-letter tokens |
| 2 | Retrieval eval | "How much is Relay Pro?" missed the $59 conflict — "how much" wasn't a pricing synonym | Extended pricing synonyms |
| 3 | Typecheck | Next's `ProcessEnv` requires `NODE_ENV`; env injection in tests didn't typecheck | Narrow `Env` type at the config boundary |
| 4 | Build | Dynamic `fs` path made the bundler trace the whole project | Statically scoped path to `knowledge-base/` |
| 5 | Scanner self-test | Anthropic key also matched the OpenAI pattern (mislabelled finding) | Negative look-ahead; self-test plants one key per vendor + a literal value |
| 6 | E2E | Mock model read the text *before* passage [1] and answered "not in KB" | Fixed mock parsing (test infrastructure bug, not product) |
| 7 | Live smoke | Anthropic key without credit was classified `bad_request` | Billing/credit errors → `auth` class with "API key or billing" copy |
| 8 | Live eval r1 | Claude answer cut off: reasoning tokens consumed the 1,200-token output budget | Cap → 4,000; `finishReason=length` now appends a visible "cut off" note (+ regression test) |
| 9 | Live eval r1 | Cross-product SAML answer didn't flag the Vault conflict (2 of 3 models) | Prompt: company-wide docs may be stale — compare value by value |
| 10 | Live eval r1 | Integration answer dropped "read-only" from the partner requirement | Prompt: include every relevant column of the row |
| 11 | Live eval r2 | Grader too strict: correct "not in KB" paraphrases and uncited refusals marked as failures | Grader accepts clear paraphrases; no citation required on a refusal (documented in golden-set notes) |
| 12 | CI on clean checkout | `tsc` failed on a fresh clone: `LayoutProps` is generated into `.next/types`, which only existed locally — anyone following the README on a fresh machine would have hit it | `typecheck` = `next typegen && tsc --noEmit`; verified by running `npm run ci` in a fresh clone |
| 13 | Independent review | v1.1 relaxed the 403-checklist and release-notes checks after seeing model output — fitting the requirement to the results | Reversed (BRD A9 v1.2); checks required again; prompt rules G10–G11 name and forbid the literal-answer shortcut |
| 14 | Review of the Sentry integration | Provider error summaries sent to Sentry can echo a partly masked key (OpenAI 401 "Incorrect API key provided: sk-proj-…"); the bundle scan only knew the 3 provider keys | `redactSecrets()` before any Sentry context (+ test); scanner also checks `SENTRY_AUTH_TOKEN` and `AI_GATEWAY_API_KEY` values |
| 15 | Process | Two tools wrote to the same working tree; a `git add -A` swept a half-finished dependency (`@sentry/nextjs`) into commit `012ebd3`, whose message only mentions the CI fix | One writer at a time; stage explicit paths; every file read before it is published |
| 16 | Independent review (external) | Integration answers announced a disagreement that does not exist (Pulse + Salesforce "OIDC vs OIDC"): the synonym "connect" matched "OpenID **Connect**". The eval passed because it only checked that real conflicts are flagged, never that agreements are *not* | Removed "connect"; disagreement only on different values; 15 non-conflict cases now fail on "disagree" |
| 17 | Independent review | Grounding was prompt-only — no deterministic guard against an off-topic or invented answer | Off-topic guard (no model call) + figure check on every answer (TRD §4.6–4.7) |
| 18 | Independent review | "API gateway"/"secrets manager" not recognised; "And for Vault?" lost the topic; "SAML 2.0" parsed as a release version | Product nicknames, topic carry-over, protocol versions excluded (+ tests) |
| 19 | Live eval r5 (stricter set) | A blanket "compare documents" hint fixed one model's missed conflict but made two others raise false ones; a "changed workspace" bug-fix line was read as a changed fact | Hints only for release notes whose *New* section announces a change, quoting that line |
| 20 | Live eval r6 | Gemini Flash-Lite read Vault/Pulse/Ledger **Pro** prices as "Custom" — a table misread no figure check can catch, intermittent across runs | Default switched to Claude Haiku 5.5 (no table misreads across runs); Flash-Lite thinking `minimal` → `low` |
| 21 | User review of live answers | SLA answers dropped "response time to first human reply" — a misquote risk on a customer call; conflict answers didn't say what applies today | Deterministic SLA qualifier from the cited table; rule 4 adds "what applies today and to whom" |
| 22 | Concurrent writers | Another session started features and doc passes in the same tree four times; it also reused acceptance id NKA-CHAT-007 | Watched for quiet before every write, edits that refuse to apply to changed text, explicit-path commits, ids checked unique |

**Eval trend (54 graded answers per run):** 12 failures → 6 → 3 → 1 → 0. The 3 → 1 step was partly false progress: the full-checklist and retry-fix checks had been demoted to nice-to-have. They were restored as required (answer key Q3/Q4), which exposed 6 failures. Explicit prompt rules G10–G11 brought it to 0. Lesson: low-effort models (Gemini thinking `minimal`, GPT effort `low`) answer the literal question ("what to check *first*", "new *features*") unless the prompt names the shortcut they take and forbids it.

**After the independent review (stricter golden set × 3 models, from the committed reports):** 61/75 → 72/75 → 73/75 → 75/75 on the 25-case set (9 of the first 14 "failures" were the grader not yet knowing the off-topic guard); 76/81 when the SLA-definition and what-applies-today checks and two bubble cases were added (27 cases); **90/90** on the final 30-case set ([`2026-10-07-21-03-28`](../../evals/reports/2026-10-07-21-03-28/index.html)).

## 3. Model selection — by measurement, not preference

| Model | Golden set | p50 first word | Cost / 18 answers |
|-------|-----------|----------------|-------------------|
| **Claude Haiku 5.5** (default) | **30/30** | ~1.5 s | $0.011 |
| Gemini 3.1 Flash-Lite (thinking low) | 30/30 (one intermittent Pro-price misread at thinking `minimal`) | ~1.3 s | $0.021 |
| GPT-5.6 Luna (reasoning medium) | 30/30 | ~2.6 s | $0.013 |
| Gemini 3.5 Flash (thinking low) | spot-checked: most thorough | ~3.6–4.9 s | ~$0.012 / answer |

Fallback order alternates vendors (Google → OpenAI → Anthropic → …) so a single vendor outage never takes the assistant down.

## 4. Judgment calls to confirm with the client

- **A1** Unnamed product → answer per product (not a clarifying question) — optimised for Sarah on a live call.
- **A2** Conflicts are shown, never auto-resolved; the newer document is noted.
- **A9** "What should they check first?" → the full ordered checklist per product, step 1 marked "check first". "What's new in vX" → every release-note item, New and Fixed. This matches the answer key; confirm the preferred depth with Support.
- Public URL has no login (brief): mitigated by per-IP rate limit, message cap and output cap.

## 5. Not done / next steps

| Item | Why it matters | Next step |
|------|----------------|-----------|
| Semantic grading | Regex graders mis-scored correct paraphrases twice | Add an LLM-as-judge for "declined clearly / disagreement stated", keep regex for facts |
| Distributed rate limit | In-memory limiter is per instance | Upstash/Redis |
| Ingestion at real scale | Client's real sources are PDFs, wikis, email | Ingestion pipeline + embeddings/hybrid retrieval + reranker, keeping the retrieval eval as the gate |
| Accessibility + load testing | Not automated yet | axe in Playwright; k6 against `/api/chat` with the mock LLM |
| Prompt caching | Not required; would cut cost on long sessions | Cache the instructions prefix per provider |
