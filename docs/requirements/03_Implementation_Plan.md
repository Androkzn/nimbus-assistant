# NimbusStack Product Knowledge Assistant — Implementation Plan

> Execution handoff from the approved [TRD](02_TRD.md) to code. It does not redefine scope or contracts; conflicts are logged as gaps (§8).

| Field | Value |
|-------|-------|
| **Doc type** | Feature implementation plan |
| **Feature id** | `product-knowledge-chat` |
| **Status** | executed — production candidate |
| **Version** | `v1.1` |
| **Created** | 2026-10-07 |
| **BRD / TRD** | [01_BRD.md](01_BRD.md) v1.3 · [02_TRD.md](02_TRD.md) v1.4 |

---

## Delivery control

Each phase was treated as a controlled handoff: define the scope, implement against the TRD, run the phase gate, and record exceptions in the acceptance or retrospective documents. The client corpus was never edited during implementation. A phase is complete only when its verification command or a dated evidence record passes.

---

## 0. Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.0 | 2026-10-07 | Initial plan from TRD v1.0 |
| v1.1 | 2026-10-07 | Updated after implementation: aligned BRD/TRD versions and added the readiness/reporting handoff |

---

## 1. Readiness Gate

| Gate | Status | Notes |
|------|--------|-------|
| BRD accepted for build | ✅ | Assumptions A1–A13 are visible for client confirmation |
| TRD complete enough to implement | ✅ | 27/27 requirement checksum |
| Open HIGH blockers resolved | ✅ | T1 and T2 resolved; the remaining production QA item is recorded in the scored results |
| Data/privacy reviewed | ✅ | No chat persistence, no message text in logs |
| Rollout path known | ✅ | Vercel |

---

## 2. Non-Goals

Login, persisted chats, KB editor, admin analytics, prompt caching, embeddings/vector DB, non-English.

---

## 3. File Plan

| File / module | Change | Phase |
|---------------|--------|-------|
| `AGENTS.md`, `CLAUDE.md` | Agent rules for this repo | 0 |
| `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `.env.example` | Tooling | 0 |
| `src/server/kb/{load,chunk}.ts` | Corpus loader + chunker | 1 |
| `src/server/retrieval/{products,synonyms,bm25,retrieve}.ts` | Retrieval | 1 |
| `config/models.json`, `src/server/config/models.ts` | Catalog + zod + invariants | 2 |
| `src/server/llm/{providers,fallback,errors,cost}.ts` | Adapters, runner, classifier, cost | 2 |
| `src/server/prompt/build.ts` | Answer contract + message assembly | 2 |
| `src/shared/{contracts,context}.ts` | zod request/event schemas; context level | 3 |
| `src/app/api/{chat,models,health}/route.ts`, `src/server/http/{rateLimit,log}.ts` | API | 3 |
| `src/app/page.tsx`, `src/components/*`, `src/client/{stream,usage}.ts` | UI | 4 |
| `scripts/scan-client-bundle.mjs`, `.github/workflows/ci.yml` | Quality gates | 5 |
| `evals/golden-set.json`, `scripts/eval-live.mjs` | Live answer eval + report | 5 |
| `README.md`, `docs/requirements/05_Retrospective.md` | Docs | 5–6 |

---

## 4. Phases

### Phase 0 — Scaffold and guardrails
Scope: Next.js + TS strict, lint, Vitest, Playwright, CI skeleton, `.env.example`, AGENTS.md.
Produces: `npm run {typecheck,lint,test,build,e2e}` scripts.
Acceptance: [ ] all scripts run green on an empty app.
Verification: `npm run typecheck && npm run lint && npm test && npm run build`

### Phase 1 — Knowledge and retrieval (pure, offline, test-first)
Scope: TRD §4.1.
Produces: `loadCorpus(): Chunk[]`, `retrieve(query: string, history: Msg[]): RetrievalResult`.
Consumes: `knowledge-base/*.md`.
Acceptance (retrieval eval = offline CI gate):
- [ ] Q5 "SSO via SAML 2.0" → passages include all four products' sign-on facts, incl. Ledger "Federated login".
- [ ] E5 "does Ledger do single sign-on" → Ledger features/pricing chunk retrieved.
- [ ] Q6 "P1 SLA" (no product) → all four Support SLA tables.
- [ ] Q3 "v4.2 of Relay" → Relay 4.2 release-notes chunk ranked first.
- [ ] E1 history "Pulse … Salesforce" + "what about its SLA?" → Pulse Support SLA.
- [ ] C1 "Vault SAML tiers" → `vault.md` pricing + Vault 3.1 notes + security overview Identity.
- [ ] C2 "Relay Pro price" → `relay.md` pricing + Relay 4.2 notes.
- [ ] Every table chunk contains its header row.
Verification: `npx vitest run src/server`

### Phase 2 — Config, providers, fallback, cost
Scope: TRD §3, §4.2–4.4. Resolve T1 (model IDs/prices from vendor docs; record date).
Produces: `getCatalog()`, `runWithFallback(opts): AsyncIterable<StreamEvent>`, `classifyError(e)`, `costUSD(usage, model)`, `buildMessages(...)`.
Consumes: `retrieve` (Phase 1).
Acceptance:
- [ ] Config invariants test fails on: duplicate id, missing price, unknown fallback id, provider missing.
- [ ] Cost example $0.0035 pinned.
- [ ] Mock: primary throws before first token → backup answers; events `fallback` then `done.answeredBy = backup`.
- [ ] Mock: primary throws after 2 deltas → `reset` emitted before any backup delta; reconstructed client text == backup text only.
- [ ] 429 → `rate_limited` with `retryAfterSec`; 401 → `auth`; 503/network → `unavailable`.
Verification: `npx vitest run src/server`

### Phase 3 — API
Scope: TRD §5, §7 (validation, rate limit, logging).
Produces: `POST /api/chat`, `GET /api/models`, `GET /api/health`; shared zod contracts.
Consumes: Phases 1–2.
Acceptance:
- [ ] Blank / whitespace message → 400; provider spy called 0 times.
- [ ] Event order `meta → sources → delta* → done`; every line parses with the shared schema.
- [ ] `modelId` switch mid-history → `done.answeredBy` = new model; history forwarded.
- [ ] Logs contain no message text (assert on captured log line).
Verification: `npx vitest run`

### Phase 4 — UI
Scope: TRD §6; BRD §5 copy.
Consumes: API contracts, `contextLevel`.
Acceptance (Playwright, `LLM_MODE=mock`):
- [ ] Streamed answer renders; Sources panel lists passages; usage line + "Answered by" badge.
- [ ] Session totals = sum of rows after 2 answers.
- [ ] Model switch keeps history; meter recolours on switch.
- [ ] New Conversation clears messages and totals.
- [ ] Blank → Send disabled. Simulated rate limit → BRD copy shown, no stack trace.
- [ ] Export CSV/JSON downloads with one row per answer.
Verification: `npm run build && npm run e2e`

### Phase 5 — Quality gates, live eval, deploy
Scope: bundle scan, CI workflow, live eval runner + HTML report, Vercel deploy, README.
Acceptance:
- [ ] CI green on a clean checkout (proves README commands).
- [ ] Bundle scan fails on a planted fake key (tested), passes on real build.
- [ ] Live eval report: Q1–Q6 + gap probes + C1/C2 per available model, results committed under `evals/reports/`.
- [ ] `/api/health` on prod lists ≥ 2 providers; fallback verified by disabling the primary key.
Verification: `npm run ci && npm run eval:live && curl $URL/api/health`

Production evidence is retained in `evals/reports/`, `readiness/reports/`, and [RESULTS_2026-10-07.md](RESULTS_2026-10-07.md). The deployed run is allowed to retain an open QA item; it is not silently converted into a full pass.

### Phase 6 — Retrospective
Scope: `05_Retrospective.md` — shipped vs cut, defects found by which gate, assumptions to confirm, next steps.

---

## 5. Data and migration plan

No database; no migrations. Corpus is static and versioned in git. Rollback = Vercel previous deployment.

---

## 6. QA Plan

| Layer | Command |
|-------|---------|
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit + integration + retrieval eval | `npm test` |
| E2E (mock LLM) | `npm run e2e` |
| Bundle secret scan | `npm run scan:bundle` (after build) |
| Live answer eval | `npm run eval:live` (needs keys) |
| All CI gates | `npm run ci` |

---

## 7. Deployment Plan

| Step | Action |
|------|--------|
| 1 | Push to public GitHub repo; CI must be green |
| 2 | Vercel project from repo; set provider keys as env vars |
| 3 | Smoke `/api/health` + one question per provider |
| 4 | Run live eval against prod; commit report |

---

## 8. Open Gaps

| # | Gap | Severity | Owner | Status |
|---|-----|----------|-------|--------|
| G1 | Provider keys for the live link (T2) | high | Andrei | ✅ resolved |
| G2 | Hosting for the live link (T3) | medium | Andrei | ✅ resolved — Vercel |

---

## 9. Completion Checklist

| Item | Evidence | Status |
|---|---|---|
| Phase acceptance | `npm run ci`, live eval reports, and deployment smoke evidence | ✅ |
| Acceptance matrix | [RESULTS_2026-10-07.md](RESULTS_2026-10-07.md) | ✅ scored; one production QA item open |
| Secret handling | Bundle scan and redaction tests | ✅ |
| Retrospective | [05_Retrospective.md](05_Retrospective.md) | ✅ |
