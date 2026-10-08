# Readiness Report — live verification showcase

> A page that runs the project’s quality gates live and shows, requirement by requirement, what was verified and how.
> Showcase tooling: it reads the product; the product never imports it.

| Field | Value |
|-------|-------|
| **Doc type** | Feature spec (BRD + TRD, short form) |
| **Feature id** | `readiness-report` |
| **Client** | NimbusStack |
| **Status** | implemented — production verification surface |
| **Version** | `v1.0` |
| **Created** | 2026-10-07 |
| **Author** | Andrei Tekhtelev |
| **Shared contract** | `src/readiness/schema.ts` (zod; producers and the page import it) |

---

## 1. Purpose

Reviewers should be able to see, not take on trust, that every requirement in the brief was delivered and how each one is checked. One click on **Readiness** (app header) opens `/readiness` in a new window. The page streams every gate as it runs and maps each result to the brief item and acceptance row it proves (`04_Acceptance_Matrix.md`).

## 2. Non-goals and isolation guarantees (hard rules)

| # | Rule | How it is verified |
|---|------|--------------------|
| I1 | Nothing under `src/server`, `src/shared`, `src/client` or `src/components` (except one header button) imports from `src/readiness`, `src/components/readiness` or `src/app/readiness` | grep check in `src/readiness/isolation.test.ts` |
| I2 | The chat API, retrieval, prompt and model config are not changed | git diff review; main E2E suite unchanged and green |
| I3 | The process-spawning endpoint `/api/readiness/run` exists only locally: available iff `NODE_ENV=development` or `READINESS_RUNNER=1`, and never when `VERCEL` is set. Otherwise it returns 404 | unit test on the gate |
| I4 | A local run never touches `.next/` (another server may be serving it): build and E2E use `NEXT_DIST_DIR=.next-readiness` and port `3199`. Files that Next rewrites for a custom dist dir (`tsconfig.json`, `next-env.d.ts`) are restored byte-for-byte after the run | runner self-check; `git status` before/after |
| I5 | One run at a time (shared ports and dist dir) | lock in the route + runner |
| I6 | No secrets and no app message text in any event: error strings are redacted (same patterns as `redactSecrets`) and capped at 500 chars | runner test |
| I7 | Recorded results are never presented as live: every result carries `source: "live" \| "recorded"` and the page labels recorded runs with their date and build | schema + page |
| I8 | `npm run scan:bundle` stays green with the readiness page in the bundle (key-pattern literals in probe code are built so their source text cannot match a key pattern) | bundle scan |

## 3. Modes

| Mode | Where | What runs |
|------|-------|-----------|
| **Local run** | `npm run dev`, button → `/readiness?autostart=1` | `scripts/readiness/run.mjs` streams the CI gates live (typecheck → lint → unit/integration/retrieval eval → build → bundle scan → E2E), adds the latest committed live-eval report as **recorded** evidence, then the page runs the **live probes** against the local server |
| **Production** | deployed URL, same button | The page replays the last published local run (`public/readiness/latest.ndjson`, labelled *recorded*), then runs the **live probes** against production for real |
| **CLI** | `npm run readiness` | Same runner, human-readable output; `--stream` prints NDJSON; `--publish` refreshes `public/readiness/latest.ndjson` |

## 4. Event protocol

NDJSON, one `ReadinessEvent` per line, validated by `ReadinessEventSchema` (`src/readiness/schema.ts`):
`run-start{meta, stages}` → (`stage-start` → `test-result`… → `stage-end`)… → `run-end`. `log` events are optional, sparse, redacted.

Result ids (stable keys the traceability manifest matches on):

| Producer | `id` | `file` | `fullName` |
|----------|------|--------|------------|
| Vitest | `<file>::<fullName>` | repo-relative test file | describe chain + test title, joined with ` › ` |
| Playwright | `<file>::<fullName>` | `e2e/<spec>.ts` | describe chain + test title (no project / file), joined with ` › ` |
| Gate (typecheck, lint, build, bundle-scan) | `gate::<stage>` | the command | stage title |
| Recorded live eval | `eval::<caseId>::<modelId>` | `evals/reports/<stamp>/results.json` | `<caseId> — <question>` |
| Live probe | `probe::<probeId>` | the origin probed | probe title |

Probe ids: `health`, `models`, `blank`, `oversize`, `unknown-model`, `offtopic-guard`, `stream-headers`, `bundle-keys`, `grounded-answer` (opt-in: one real model call, ~1.5k tokens).

## 5. Traceability

`src/readiness/manifest.ts` holds:
- **requirements**: every brief item (the one rule, R1–R5, E1–E10, Q1–Q6, deliverables) with its BRD ids and acceptance ids;
- **checks**: every automated check with a matcher (`file`, `name` regex on the test title, or `id` regex), its layer, the requirement / acceptance ids it covers, and one plain-English sentence on **what it verifies**.

Invariants, enforced by `src/readiness/manifest.test.ts`: every acceptance row in `04_Acceptance_Matrix.md` is attached to a brief item; every brief item has at least one check; every check matches at least one real test; every test in the repo is claimed by at least one check (no orphan tests, no evidence-free requirements).

A requirement is **Verified** when at least one of its checks passed and none failed; **Failed** if any failed; **Running** / **Pending** otherwise.

## 6. Acceptance

| ID | Criterion |
|----|-----------|
| RDY-001 | Header button opens `/readiness?autostart=1` in a new window; the chat page is otherwise unchanged |
| RDY-002 | Local mode: gates stream live; each test appears as it finishes, with what it verifies and the requirement it covers |
| RDY-003 | Production mode: the recorded run replays labelled *recorded · date · build*; live probes run for real against the deployed app |
| RDY-004 | Every brief item shows its status and evidence; failures show the redacted reason |
| RDY-005 | `/api/readiness/run` returns 404 in production |
| RDY-006 | A run leaves the working tree and `.next/` unchanged (apart from `readiness/reports/` and, with `--publish`, `public/readiness/`) |
| RDY-007 | All existing gates stay green: typecheck, lint, unit, build, bundle scan, chat E2E |
