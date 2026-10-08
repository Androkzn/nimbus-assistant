# Create a business requirements document

Create a concise, evidence-backed business requirements document for `$ARGUMENTS`.

## Workflow

1. Inspect the repository's README, existing requirements, product docs, source structure, tests, and package manifests.
2. Separate confirmed facts, user goals, assumptions, constraints, non-goals, and open questions.
3. Translate the request into uniquely identified business requirements (`BR-01`, `BR-02`, ...).
4. Add acceptance criteria, edge cases, risks, success measures, and traceability to evidence.
5. Reconcile the document with existing project terminology and avoid inventing capabilities.

Use the repository's existing template and destination when they exist. Otherwise write to `docs/requirements/` using a clear filename. Do not change application code or deploy anything while creating the document.

## Required output

- Problem and users
- Goals and non-goals
- Business requirements
- Acceptance criteria
- Risks, dependencies, and unresolved decisions
- Traceability matrix: requirement → implementation area → verification evidence
- Assumptions clearly marked

Before finishing, verify every referenced file and link exists.
