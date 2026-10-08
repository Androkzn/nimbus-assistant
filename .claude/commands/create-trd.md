# Create a technical requirements document

Create a technical requirements document for `$ARGUMENTS`, grounded in the actual repository.

## Workflow

1. Read the relevant BRD or request, then inspect the live code paths, configuration, package manifests, schemas, integrations, tests, and deployment files.
2. Identify the application surfaces involved: client, server, data, jobs, infrastructure, observability, and security. Omit areas that do not apply.
3. Convert the business requirements into technical requirements (`TR-01`, `TR-02`, ...).
4. Record API/data contracts, failure behavior, privacy boundaries, compatibility, performance, security, testing, rollout, and rollback requirements.
5. Distinguish current state from proposed state and cite file paths and symbols rather than guessing.

Use existing repository templates and conventions. If none exist, write to `docs/requirements/`. Do not prescribe a framework, database, cloud provider, or deployment model unless evidence or the user explicitly requires it.

## Required output

- Scope and current-state evidence
- Technical requirements with IDs
- Architecture and integration constraints
- Contract and data changes
- Security/privacy and operational requirements
- Test and acceptance strategy
- Rollout, observability, rollback, risks, and open decisions
- Traceability from `BR-*` to `TR-*` to checks
