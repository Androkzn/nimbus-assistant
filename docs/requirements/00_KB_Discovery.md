# NimbusStack Knowledge Base — Discovery Audit

> Phase 0 of the delivery pipeline: **understand the client's source of truth before writing requirements.**
> Discovery → BRD → TRD → Implementation Plan → Build → Verify → Retrospective.

| Field | Value |
|-------|-------|
| **Doc type** | Discovery / source audit |
| **Feature id** | `product-knowledge-chat` |
| **Status** | approved |
| **Version** | `v1.0` |
| **Created** | 2026-10-07 |
| **Author** | Andrei Tekhtelev |
| **Consumers** | [01_BRD.md](01_BRD.md) (requirements), [04_Acceptance_Matrix.md](04_Acceptance_Matrix.md) and `evals/golden-set.json` (answer key) |

---

## 1. Inventory

The corpus is **10 markdown files, 10,112 bytes (≈ 3k tokens)**, plain ASCII, identical to the client-supplied zip. It is vendored read-only in `knowledge-base/` (file mode `0444`) — the brief forbids edits.

| File | Kind | Product | "Updated" / latest release |
|------|------|---------|----------------------------|
| `relay.md` | Product doc | Nimbus Relay (API gateway) | 2026-06-12 |
| `relay-release-notes.md` | Release notes | Relay | 4.2 — 2026-06-10 |
| `vault.md` | Product doc | Nimbus Vault (secrets) | 2026-07-03 |
| `vault-release-notes.md` | Release notes | Vault | 3.2 — 2026-07-01 |
| `pulse.md` | Product doc | Nimbus Pulse (analytics) | 2026-08-22 |
| `pulse-release-notes.md` | Release notes | Pulse | 4.3 — 2026-08-20 |
| `ledger.md` | Product doc | Nimbus Ledger (usage billing) | 2026-06-30 |
| `ledger-release-notes.md` | Release notes | Ledger | 2.6 — 2026-06-25 |
| `security-overview.md` | Company-wide | all | 2026-01-15 |
| `support-policy.md` | Company-wide | all | 2026-04-01 |

Every product doc has the same shape: Features → Pricing table → Integrations table → Support SLA table (→ Troubleshooting for Relay and Pulse only). **Most answers live in tables**, so retrieval must never split a table from its header row.

---

## 2. Conflicts between documents (brief E4)

The bot must **surface both sides with citations and dates** — never silently pick one.

| ID | Topic | Source A | Source B | Resolution guidance for the answer |
|----|-------|----------|----------|------------------------------------|
| **C1** | Vault SAML 2.0 tiers | `security-overview.md` (2026-01-15): *"SAML 2.0 on Enterprise"* | `vault.md` pricing (2026-07-03): Pro = SAML 2.0, Enterprise = SAML 2.0; `vault-release-notes.md` 3.1 (2026-04-14): *"SAML 2.0 federated sign-in extended to the Pro tier (previously Enterprise only)"* | State the disagreement; note the security overview predates the 3.1 change. |
| **C2** | Relay Pro price | `relay.md` pricing (2026-06-12): **$49** per seat/month | `relay-release-notes.md` 4.2 (2026-06-10): **$59** per seat/month for new contracts signed on/after **2026-08-01**; existing contracts keep price until renewal | Both are true for different customers. The product doc was updated *after* the note yet still shows $49 — flag it. |

Non-conflicts checked and cleared: Ledger Salesforce ("coming soon" in `ledger.md` vs "planned for a later release" in 2.6 notes — consistent); Pulse SSO (OIDC in both `pulse.md` and the security overview); Relay rate-limit headers (4.1 in both).

---

## 3. Representative questions — pitfalls and answer key

### Q1 — "Key differences between Pro and Enterprise?"
No product named → answer **per product** (or ask which). Pricing units differ: per seat (Relay, Vault), per workspace (Pulse), flat + 0.5% of invoiced volume (Ledger). Enterprise is always "Custom". Pitfall: **C2**.

### Q2 — "Does [product] integrate with Salesforce? What version?"
Two version numbers per answer (product minimum + Salesforce API).

| Product | Answer | Source |
|---------|--------|--------|
| Vault | Yes — Vault **3.1+**, Salesforce API **v58+**, Connected App with `api` scope | `vault.md` Integrations; 3.1 notes |
| Pulse | Yes — Pulse **4.3+**, Salesforce API **v59+**, read-only sync of Accounts & Opportunities | `pulse.md` Integrations; 4.3 notes |
| Relay | **Not supported** — a community Zapier bridge exists; NimbusStack does not support it | `relay.md` Integrations |
| Ledger | **Not yet** — "coming soon" on the 2.6 roadmap; requirement not published | `ledger.md`; 2.6 notes |

Pitfall: v58 vs v59 are adjacent rows of different docs.

### Q3 — "What's new in v4.2 of [product]?"
Only **Relay** has a 4.2 (2026-06-10): request replay (last 7 days, against staging, Enterprise); EU regional endpoint `eu.relay.nimbusstack.com`, Frankfurt residency (Enterprise); Pro price change to $59 for new contracts from 2026-08-01; fix — webhook retry storm on >10 min of downstream 5xx.
Pitfall: **Pulse jumps 4.1 → 4.3** — "Pulse 4.2" must be answered as *not in the knowledge base*. Vault (latest 3.2) and Ledger (2.6) never reached 4.x.

### Q4 — "A client gets a 403 on the API. What to check first?"
Only Relay and Pulse document it (ordered checklists):
- **Relay:** (1) token scope includes the route — per-route since 4.0; (2) caller IP on workspace allowlist, if configured; (3) owning seat not suspended.
- **Pulse:** (1) API-key owner is a member of the project's workspace; (2) key is bound to the queried project — per-project since 4.0.
Pitfall: no product named → answer both / ask; Vault and Ledger have no 403 guidance (brief E3).

### Q5 — "Which products support SSO via SAML 2.0?"
| Product | SAML 2.0 | Source |
|---------|----------|--------|
| Relay | Enterprise only | `relay.md`, security overview |
| Vault | Pro + Enterprise (**C1**: overview says Enterprise only) | `vault.md`, 3.1 notes vs security overview |
| Ledger | **Every tier** | `ledger.md` ("Federated login (SAML 2.0)"), security overview |
| Pulse | **No** — OIDC on Pro/Enterprise; SAML is roadmap only | `pulse.md`, security overview |

Pitfall (brief E5): **Ledger never uses the words "SSO" or "single sign-on"** — only "Federated login". Pure keyword retrieval on "SSO" drops Ledger and produces an incomplete answer.

### Q6 — "SLA for Priority 1 tickets?"
Response time to **first human reply** (not resolution). Values differ by product — `support-policy.md` says so explicitly.

| P1 | Starter / *Growth* | Pro | Enterprise |
|----|--------------------|-----|------------|
| Relay | 8 business hours | 2 hours | **15 minutes, 24x7** |
| Vault | 4 business hours | 1 hour | 30 minutes, 24x7 |
| Pulse | Next business day | 4 hours | 1 hour, 24x7 |
| Ledger | 8 business hours | 2 hours | 30 minutes, 24x7 |

Pitfalls (brief E6): Pulse's entry tier is **Growth**, not Starter; Relay and Ledger rows are identical except Enterprise; "business hours" = 08:00–18:00 customer time zone, Mon–Fri (`support-policy.md`).

---

## 4. Known gaps — questions the KB cannot answer (brief E2 / E3)

The bot must say "not in the knowledge base" for these. Users will ask them, and any confident answer would be invented.

| Probe | Why it is a gap |
|-------|-----------------|
| Pulse 4.2 features | No 4.2 release exists |
| Enterprise price for any product | Only "Custom" |
| Uptime / availability SLA | Only response-time SLAs exist |
| Audit-log retention for Pulse / Ledger | Security overview says "where listed" — it isn't |
| BigQuery export version requirement (Pulse) | In pricing table, absent from integrations table |
| 403 troubleshooting for Vault / Ledger | Not documented |
| Resolution-time SLA | Only first-reply times |
| SLA by support-plan name ("Standard plan P1?") | Plans map to different SLAs per product |
| Any product other than the four (e.g. "Nimbus Edge") | Not in corpus |

---

## 5. Implications carried into the BRD / TRD

1. **Retrieval unit = H2 section, tables kept whole**, each chunk prefixed with document title + updated date (E6, E4 dating).
2. **Synonym-aware retrieval**: SSO ≈ single sign-on ≈ SAML ≈ federated login/sign-in ≈ OIDC; 403 ≈ forbidden; SLA ≈ response time ≈ priority (E5).
3. **Per-product coverage** for cross-product questions — best chunk per product, not global top-k (Q5 completeness).
4. **Conflict companions**: retrieving a product section also pulls that product's release notes + the matching company-wide section, so both sides of C1/C2 reach the model.
5. **Follow-up resolution**: if a turn names no product, carry the last named product into retrieval (E1).
6. **Today's date in the prompt** so effective dates (C2: 2026-08-01) are interpreted correctly.
7. **Grounding is enforced twice**: prompt contract + an automated eval set built from §3–§4 of this document.
