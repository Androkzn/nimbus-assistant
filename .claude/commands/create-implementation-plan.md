# Create an implementation plan

Create an implementation plan for `$ARGUMENTS` using the repository's actual code and the applicable BRD/TRD.

## Workflow

1. Determine whether this is a fix, feature, migration, or improvement and identify the affected domains.
2. Inspect every proposed file, symbol, route, schema, configuration value, and test location. Do not invent paths or line references.
3. Map dependencies and order the work into small, reversible phases.
4. For each task, include exact files/symbols, the change, rationale, acceptance criteria, tests, and rollback considerations.
5. Include operational verification and a Definition of Done. Call out decisions that require user approval.

Prefer the repository's existing planning template and destination. Otherwise write to `docs/plans/`. Never modify generated files or vendor output unless the repository explicitly treats them as source files. Do not deploy or mutate external systems while authoring the plan.

## Quality gates

- Every claim is marked confirmed, inferred, or unknown.
- Every task has a concrete verification step.
- Tests cover the changed behavior and relevant failure paths.
- Security, privacy, compatibility, observability, rollout, and rollback are addressed when applicable.
- The plan is executable by another engineer without relying on hidden context.
