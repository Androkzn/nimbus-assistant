# NimbusStack Product Knowledge Assistant

[![CI](https://github.com/Androkzn/nimbus-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/Androkzn/nimbus-assistant/actions/workflows/ci.yml)

NimbusStack Product Knowledge Assistant answers questions about Relay, Vault, Pulse, and Ledger using only the approved NimbusStack knowledge base. Every grounded answer shows its source passages, the model that answered, token usage, and estimated cost.

## Deployments

- [Production assistant](https://nimbus-assistant-production.vercel.app) — customer-facing assistant
- [Developer portal](https://nimbus-assistant-dev.vercel.app) — assistant, Knowledge base portal, and Readiness report

The production deployment does not expose internal developer tooling. The developer deployment provides `/knowledge-base` and `/readiness`.

## Local development

Requirements: Node.js 22.12+ and npm.

```bash
git clone https://github.com/Androkzn/nimbus-assistant.git
cd nimbus-assistant
npm ci
cp .env.example .env.local
npm run dev
```

Add at least one server-side provider key to `.env.local`:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

The application runs at `http://localhost:3000`. To run without provider keys:

```bash
LLM_MODE=mock npm run dev
```

## Quick links

- 🧩 [Spec-driven approach](#spec-driven-approach)
- ⚙️ [CI/CD](#cicd)
- 🧪 [Readiness](#readiness)
- 🗂️ [Knowledge base portal](#knowledge-base-portal)
- ✅ [Verification](#verification)
- 🧭 [Product behavior](#product-behavior)
- 🔒 [Monitoring and security](#monitoring-and-security)
- 📋 [Requirements and design documents](#requirements-and-design-documents)
- 🧱 [Project layout](#project-layout)

## Spec-driven approach

The product is built and verified from one traceable delivery flow:

1. **Knowledge-base discovery** defines the approved source material, terminology, conflicts, and deliberate gaps.
2. **Business requirements (BRD)** define the user outcomes and product behavior.
3. **Technical requirements (TRD)** turn those outcomes into implementation, security, and operational contracts.
4. **Implementation planning** sequences the work and names the verification for each phase.
5. **Acceptance rows** convert the requirements into concrete checks.
6. **Code and tests** implement and verify those checks.
7. **Readiness** connects each requirement to its BRD item, acceptance row, automated check, and test evidence.

Every requirement must have an acceptance row, every acceptance row must have a check, and every check must claim a real test. This keeps the assistant, the knowledge-base portal, and the deployment gates aligned with the specification.

## CI/CD

The pipeline is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

- Pull requests run the offline quality gates.
- Pushes to `main` run the quality gates and deploy the tested commit to production.
- Production smoke checks verify `/api/health`, `/api/models`, and that production `/readiness` is unavailable.
- Manual workflow dispatch can run the live answer evaluation against a supplied URL.

Production deployment requires these GitHub environment secrets:

- `VERCEL_TOKEN`
- `EVAL_BYPASS_TOKEN` for manual live evaluation

`VERCEL_ORG_ID` is used only by optional production incident-log collection.

## Readiness

Readiness is the developer verification feature for checking the application against its quality gates and requirement traceability. On the developer deployment, the assistant header includes a Readiness button that opens `/readiness?autostart=1` in a separate window. It is also available during local development and on preview deployments; the production deployment hides the Readiness page and runner endpoint.

### Features

- **Live quality gates (local run):** runs typecheck, lint, unit/integration/retrieval tests, production build, client-bundle scanning, and browser E2E tests.
- **Live checks (developer deployment):** a deployment has no local runner, so the report runs the live probes against itself and, when **Include live answers** is ticked, the live answer eval. Production hides the Readiness page and both developer buttons; dev and prod run the same code.
- **Recorded evidence:** with `mode=replay`, replays the latest published local run with a `recorded` label, including its build and date.
- **Live deployment probes:** checks the running server for health, model availability, chat behavior, bundle exposure, and other public-route guarantees.
- **Traceability:** maps requirements to BRD items, acceptance rows, automated checks, and individual test results.
- **Failure-focused review:** shows All requirements by default and also supports Needs improvement, Failed, Live, Recorded, and text search filters.
- **No portal side effects:** readiness failures stay in the Readiness report and never create Knowledge base issues in developer or production deployments.
- **Grounded live evidence:** every readiness assessment sends one real grounded answer probe (one question, about 3k tokens), so a green report includes live answer evidence, not only health and contract checks.
- **Include live answers (off by default):** ticking it adds the live answer eval to the run, locally or on the developer deployment: every golden question on every available model, about 170 real answers and about $0.50. Unticked (or without `answer=1` in the URL), the eval card shows Skipped and no tokens are spent on it. On the developer deployment the eval draws on its own rate-limit allowance (about one eval per 10 minutes per client); production keeps the public limit.
- **Safe local execution:** readiness builds use `.next-readiness` and port `3199` (or the next free port when another checkout holds it), leaving the normal `.next/` build untouched; emitted evidence redacts secrets and message content.

### How to use it

Use the **Readiness test** button in the developer assistant header. It opens the report and starts automatically: a local run of every gate where the runner is available, and on a deployment the live checks (live probes, plus the live answer eval when **Include live answers** is ticked). The button is the supported user entry point; the runner behind it is internal developer tooling.

For local development, open the browser report directly when needed:

```text
http://localhost:3000/readiness?autostart=1
```

On a deployment the report runs the live probes against the current browser origin; the latest published evidence stays available with `mode=replay`. Maintainers publish the recorded artifact through the internal readiness runner; end users do not need a separate readiness command.

For example, a live health probe can return HTTP `200` but still fail if the JSON says `ok: false` or no model providers are available. The report keeps that distinction visible instead of treating the HTTP status alone as success.

### Readiness overview

A READY report: all 32 brief requirements verified, every gate green, with the recorded run's date and build and the live probes run against this server.

![Readiness overview](docs/screenshots/readiness-overview.png)

### Example: failed readiness check

This example shows how Readiness helps developers separate an HTTP transport success from an application readiness failure. The health probe returned HTTP `200` and loaded 10 knowledge-base files, but `providers: none` made `ok: false`; the report connects that evidence to the failed D1 deployment requirement. Developers can see the affected requirement, live probe, and redacted cause together, making the missing provider configuration actionable without searching through logs.

![Failed readiness check](docs/screenshots/readiness-failure-example.png)

### How readiness is decided

Readiness is decided from requirements evidence, not from the number of green tests or the fact that the application builds. The report is the visible result of a requirements-driven, risk-based delivery system designed for an AI product whose behavior depends on data, retrieval, models, infrastructure, and user-facing safeguards.

#### 1. Start with the required outcome

Each requirement describes a user or operational outcome: for example, an answer must be grounded in approved material, a provider failure must not crash the application, or a public deployment must keep credentials out of the browser. The requirement is the source of truth. Tests, prompts, models, and implementation details are means of proving it—not substitutes for it.

#### 2. Turn every requirement into observable evidence

The delivery chain is deliberately traceable:

`requirement → BRD outcome → TRD contract → acceptance row → automated check → test result → evidence`

This prevents two common failures in AI projects: implementing impressive behavior that was never required, and having a large test suite that does not prove the important outcomes. A requirement is not considered covered until it has a concrete acceptance statement, a check that claims it, and a real test result.

#### 3. Use the lowest reliable verification layer first

The gates run from the cheapest and most deterministic evidence to the most realistic and variable evidence:

- static contracts catch invalid types, routes, and build assumptions;
- unit and integration tests verify deterministic product rules, retrieval, persistence, fallback, limits, and event contracts;
- retrieval evaluations verify that the assistant finds the right approved passages and does not invent unsupported facts;
- browser tests verify the actual user journey and streamed state transitions;
- security checks verify that server-only credentials and sensitive content do not cross the browser boundary;
- live evaluations and deployment probes verify real provider quality and the behavior of the deployed system.

This ordering is an architectural decision. It gives fast feedback on local defects, reserves expensive model and deployment checks for the end, and makes a failure easier to attribute to the correct boundary.

#### 4. Separate deterministic correctness from model quality

The assistant is not judged by model confidence alone. Deterministic controls decide whether an answer is allowed to proceed: the question must match the approved knowledge base, retrieved passages must support the response, citations must be valid, unsupported questions must be bounded, and provider failures must follow the fallback contract.

Real-provider evaluation is a separate evidence lane because model output, latency, and cost can vary. It measures grounded answer quality on representative questions without allowing a variable model response to redefine the product contract. Recorded results preserve what was evaluated; live probes confirm what is running now.

#### 5. Treat safety and operations as product requirements

Prompt-injection resistance, unknown-product handling, rate limits, secret protection, safe logs, database behavior, and deployment health are not secondary infrastructure checks. They are derived controls that protect the user outcome. An assistant that answers a question correctly but leaks a key, invents a product, or loses its grounding under an adversarial prompt is not ready.

#### 6. Keep evidence provenance explicit

The report distinguishes local, recorded, and live evidence. Recorded evidence is useful for repeatable review and cost control; live evidence proves the current browser origin and deployment. The system never relabels an old result as live, and automated readiness traffic is isolated from the Knowledge base issue workflow so verification cannot pollute operational data.

#### 7. Use failures to drive the next engineering action

When a gate fails, the developer follows the traceability chain back to the requirement, then inspects the acceptance row, check, test result, command, and redacted failure evidence. This turns a red dashboard into a diagnosis path: identify the violated contract, decide whether the defect is in code, data, configuration, deployment, or evaluation, make the smallest justified change, and rerun the affected gates.

The delivery principle is that every green result must answer “what requirement did this prove?” and every red result must answer “what decision should the team make next?” Readiness is complete only when every in-scope requirement has passing evidence—for this project, `39 / 39` verified—not merely when the code compiles.

## Knowledge base portal

The developer portal manages the shared knowledge base and issue reports.

Documents can be created, edited, published, drafted, and deleted. Published documents are retrieved by both deployments after the retrieval cache refreshes.

Deterministic knowledge-base findings are saved with:

- issue type;
- priority;
- status;
- product scope;
- triggering question;
- deterministic analysis;
- proposed action;
- occurrence count for the day.

Repeated observations remain one issue record and increment that issue's occurrence count. Portal counters refresh from the shared API every five seconds and on window focus. Issue records can be filtered by type, priority, status, product, and date range.

### Portal examples

![Knowledge base portal issues view](docs/screenshots/knowledge-base-issues.png)

![Knowledge base portal documents view](docs/screenshots/knowledge-base-documents.png)

## Verification

Run the complete local quality suite:

```bash
npm run ci
```

The suite runs typechecking, linting, unit and integration tests, retrieval tests, a production build, client-bundle secret scanning, and Playwright tests with the deterministic mock model.

Individual checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run scan:bundle
npx playwright install chromium
npm run e2e
```

The optional live answer evaluation uses real provider tokens:

```bash
npm run build
npx next start -p 3300
npm run eval:live -- --base-url http://localhost:3300
```

## Product behavior

- Retrieval runs before every model call.
- Answers cite the passages used to produce them.
- Questions without reliable knowledge-base evidence receive a clear not-found response instead of an invented answer. The deterministic guard makes no model call and reports zero tokens and zero cost.
- Unknown products, unsupported pricing tiers, incomplete release versions, undocumented HTTP statuses, and unsupported priorities are guarded instead of being mapped to nearby documented values.
- Follow-up questions retain the relevant product and topic from the conversation.
- Conflicting source documents are identified and both sources are shown.
- Provider failures use a labelled fallback when another configured provider is available.
- User-facing errors use plain recovery guidance; provider and implementation details remain server-side.
- Questions are limited to 2,000 characters and requests contain at most 40 messages. Long browser sessions keep the most recent allowed history.

## Monitoring and security

The production monitor checks the homepage, health endpoint, model catalog, and production route boundaries. It can collect redacted Sentry and Vercel evidence for a failed deployment check.

Provider keys are read only on the server. Client bundles are scanned for key-shaped values. Logs contain structured request outcomes, retrieval and usage metadata, and grounding-warning counts without storing the full user question or answer. Saved conversations are stored separately in the shared conversations table and are scoped to the anonymous browser owner.

## Requirements and design documents

The requirements package defines the product baseline and its evidence:

- [Knowledge-base discovery](docs/requirements/00_KB_Discovery.md)
- [Business requirements](docs/requirements/01_BRD.md)
- [Technical requirements](docs/requirements/02_TRD.md)
- [Implementation plan](docs/requirements/03_Implementation_Plan.md)
- [Acceptance matrix](docs/requirements/04_Acceptance_Matrix.md)
- [Readiness report](docs/requirements/06_Readiness_Report.md)

## Project layout

```text
config/models.json       model catalog, prices, context windows, fallback order
knowledge-base/          approved NimbusStack Markdown documents
src/app/                 Next.js pages and API routes
src/server/              retrieval, prompting, providers, fallback, storage, and chat
src/shared/              contracts, answer state, cost, context, history, and portal types
src/components/          chat, history, knowledge-base portal, and readiness UI
src/client/              browser streaming, usage, session, and suggestion helpers
e2e/                     Playwright browser tests
evals/                   deterministic golden questions and live evaluation runner
scripts/                 CI, readiness, incident evidence, and bundle scanning tools
.github/workflows/       GitHub Actions workflows
```
