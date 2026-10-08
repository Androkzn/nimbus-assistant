# NimbusStack Product Knowledge Assistant

[![CI](https://github.com/Androkzn/nimbus-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/Androkzn/nimbus-assistant/actions/workflows/ci.yml)

NimbusStack Product Knowledge Assistant answers questions about Relay, Vault, Pulse, and Ledger using only the approved NimbusStack knowledge base. Every grounded answer shows its source passages, the model that answered, token usage, and estimated cost.

## Deployments

- [Production assistant](https://nimbus-assistant-production.vercel.app) — customer-facing assistant
- [Developer portal](https://nimbus-assistant-dev.vercel.app) — assistant, Knowledge base portal, and Readiness report

The production deployment does not expose internal developer tooling. The developer deployment provides `/knowledge-base` and `/readiness`.

## Quick links

- 🚀 [Deployments](#deployments)
- 🗂️ [Knowledge base portal](#knowledge-base-portal)
- 💻 [Local development](#local-development)
- ✅ [Verification](#verification)
- 🧭 [Product behavior](#product-behavior)
- 🗄️ [Shared data storage](#shared-data-storage)
- ⚙️ [CI/CD](#cicd)
- 🔒 [Monitoring and security](#monitoring-and-security)
- 📋 [Requirements and design documents](#requirements-and-design-documents)
- 🖼️ [Screenshots](#screenshots)
- 🧱 [Project layout](#project-layout)

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

## Shared data storage

Production and developer deployments use the same Postgres database for:

- published knowledge-base documents;
- issue reports and occurrence counts; and
- browser-owned saved chat conversations.

The database creates its tables on first use and seeds the knowledge base from the checked-in Markdown files when the document table is empty. Conversations are scoped by an anonymous browser owner cookie; they are not public or shared between users.

Local development uses SQLite fallbacks:

- `.data/nimbus-kb.sqlite` for documents and reports;
- `.data/nimbus-chat.sqlite` for saved conversations.

Set `DATABASE_URL` or `POSTGRES_URL` for the shared Postgres database. Optional local paths are `NIMBUS_KB_DB_PATH` and `NIMBUS_CHAT_DB_PATH`. Database credentials must not be committed.

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

## CI/CD

The pipeline is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

- Pull requests run the offline quality gates.
- Pushes to `main` run the quality gates and deploy the tested commit to production.
- Production smoke checks verify `/api/health`, `/api/models`, and that production `/readiness` is unavailable.
- Manual workflow dispatch can run the live answer evaluation against a supplied URL.

Production deployment requires these GitHub environment secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `EVAL_BYPASS_TOKEN` for manual live evaluation

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

## Screenshots

### Readiness overview

![Readiness overview](docs/screenshots/readiness-overview.png)

### Live deployment probes

![Live deployment probes](docs/screenshots/readiness-live-probes.png)

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
