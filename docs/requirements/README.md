# NimbusStack Product Knowledge Assistant — Requirements & Delivery Pack

This folder is the client-facing requirements and production handoff for the NimbusStack Product Knowledge Assistant. It is written against the supplied NimbusStack product documentation and the implementation that was built from it.

## Document control

| Field | Value |
|---|---|
| Client | NimbusStack |
| Product | NimbusStack Product Knowledge Assistant |
| Feature id | `product-knowledge-chat` |
| Delivery owner | Andrei Tekhtelev |
| Baseline date | 2026-10-07 |
| Delivery status | Production candidate; client review and QA hardening open |
| Primary source of truth | `knowledge-base/` (10 client Markdown documents, read-only) |
| Production URL | https://nimbus-assistant-coral.vercel.app |

## What this package demonstrates

The project is treated as a production delivery, not as a prompt demo:

- the client corpus is audited before requirements are written;
- business requirements are traced to technical contracts, code, and acceptance evidence;
- retrieval is designed around the client’s real tables, release notes, terminology, conflicts, and known gaps;
- provider failure, rate limiting, secret handling, cost visibility, and observability are part of the product contract;
- offline tests, browser tests, live model evaluation, bundle scanning, deployment smoke tests, and a readiness report form one release gate;
- unresolved decisions and production follow-ups are recorded instead of hidden.

## Read order

| Order | Document | Purpose | Primary audience |
|---:|---|---|---|
| 00 | [KB Discovery](00_KB_Discovery.md) | Establishes the client-data baseline, conflicts, gaps, and answer key | Product, Support, Engineering |
| 01 | [BRD](01_BRD.md) | Defines the business problem, users, scope, requirements, and acceptance intent | Client stakeholders, Product |
| 02 | [TRD](02_TRD.md) | Defines architecture, interfaces, grounding, security, operations, and test contracts | Engineering, QA, Security |
| 03 | [Implementation Plan](03_Implementation_Plan.md) | Shows how the build was sequenced from specification to deployment | Delivery, Engineering |
| 04 | [Acceptance Matrix](04_Acceptance_Matrix.md) | Lists every checkable release criterion and its evidence layer | QA, Client reviewers |
| 05 | [Retrospective](05_Retrospective.md) | Records defects found, model selection evidence, decisions, and next steps | Delivery, Engineering |
| 06 | [Readiness Report](06_Readiness_Report.md) | Specifies the in-product release-readiness and traceability showcase | Client reviewers, QA |
| Results | [Scored Results](RESULTS_2026-10-07.md) | Records the dated verification outcome, including the open production item | QA, Client reviewers |

## Client data baseline

The assistant answers from four NimbusStack products and two company-wide documents:

| Product | Domain represented in the supplied data | Latest product document |
|---|---|---|
| Nimbus Relay | API gateway, rate limits, authentication, event routing, webhooks | 2026-06-12 |
| Nimbus Vault | Secrets, credentials, certificates, dynamic database credentials | 2026-07-03 |
| Nimbus Pulse | Product analytics, funnels, retention, session replay | 2026-08-22 |
| Nimbus Ledger | Usage metering, rating rules, invoicing, dunning | 2026-06-30 |

The corpus contains pricing, integrations, support SLAs, release notes, identity guidance, and support-policy definitions. The implementation preserves table headers, carries source dates into retrieval, recognizes the terminology used by the documents, and surfaces the two known conflicts instead of silently resolving them.

## Release posture

The local implementation passed the offline gates and the final local live evaluation (90/90 cases across three configured models). The deployed URL passed health, bundle, and off-topic smoke checks; the production default-model run scored 29/30 because one false-disagreement response remains intermittent. That item is explicitly tracked in the scored results and is the first QA-hardening action before declaring the release fully accepted.
