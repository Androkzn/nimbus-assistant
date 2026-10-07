# AGENTS.md — NimbusStack Product Knowledge Assistant

Rules for any AI agent (Claude Code, Cursor, Codex, Kiro) or human working in this repo.

## Delivery pipeline — specs before code

`docs/requirements/`: **00 Discovery → 01 BRD → 02 TRD → 03 Implementation Plan → 04 Acceptance Matrix → 05 Retrospective**.

- A change in behaviour starts in the BRD/TRD, not in code. Keep requirement ids (BR-xx, NKA-xxx) in tests and commits.
- External facts (model IDs, prices, SDK APIs) are unverified until checked against vendor docs or installed package types; record the source (`config/models.json` → `pricingSources`, `pricingVersion`).
- Never mark an acceptance row Pass from code reading — only from a test run or a recorded live run.

## Hard rules

1. `knowledge-base/` is client data: **read-only**. Never edit, never "fix" a conflict in it — the bot surfaces conflicts.
2. Answers come **only** from retrieved passages. Any change to retrieval or the prompt (`src/server/prompt/build.ts`) must be followed by `npm test` (retrieval eval) **and** `npm run eval:live`, with the report committed under `evals/reports/`.
3. API keys live only in server env vars. Never `NEXT_PUBLIC_*`, never in logs, never in the browser. `npm run scan:bundle` must stay green. (The one allowed `NEXT_PUBLIC_` value is the Sentry DSN — a public, send-only ingest key; see TRD §7. Sentry follows rule 5 too: `src/shared/sentry.ts` turns off every channel that could carry message text.)
4. Model IDs, prices, context windows and fallback order live in `config/models.json` only. Tests read expectations from the config instead of hard-coding them.
5. Logs carry ids, models, tokens, latency and error classes — never message text.
6. Do not weaken a failing test or eval check to make it pass. If the check is wrong, say why in the golden set (`note`) or the test, and keep the evidence.

## Map

| Concern | Path |
|---|---|
| Corpus loading + chunking | `src/server/kb/corpus.ts` |
| Retrieval (BM25 + synonyms + nicknames + per-product coverage + conflict companions + topic carry-over) | `src/server/retrieval/` |
| Answer contract (system prompt) + comparison hints | `src/server/prompt/build.ts` |
| Deterministic grounding: figure check, SLA qualifier | `src/server/verify/` |
| Error monitoring (Sentry, no message text) | `src/shared/sentry.ts`, `src/server/observability/`, `src/instrumentation*.ts` |
| Providers, fallback state machine, error classes, fault injection | `src/server/llm/` |
| Model catalog + invariants | `config/models.json`, `src/server/config/models.ts` |
| HTTP: chat handler (incl. off-topic guard), rate limit | `src/server/chat/handleChat.ts`, `src/server/http/` |
| Wire contract shared by server and browser | `src/shared/contracts.ts`, `src/shared/answer.ts` |
| UI (incl. suggestion bubbles — each tied to a brief item and a golden case) | `src/components/`, `src/client/` |
| Tests: unit/integration (Vitest) · E2E (Playwright, mock LLM) · live eval | `src/**/*.test.ts` · `e2e/` · `scripts/eval-live.mjs` + `evals/golden-set.json` |

## Commands

`npm run ci` runs every offline gate (typecheck, lint, unit + integration + retrieval eval, build, bundle scan, E2E).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
