# Implement an approved plan

Implement the plan at `$ARGUMENTS` only after checking that it is approved and matches the current repository.

## Workflow

1. Read the complete plan and verify its referenced paths and current branch.
2. Translate tasks into a checklist; preserve unrelated user changes.
3. Implement the smallest coherent change. Follow the repository's language, framework, security, and formatting conventions discovered from source and tooling.
4. Add or update unit, integration, contract, and end-to-end tests appropriate to the changed behavior.
5. Run the documented quality gates, inspect the diff, and report any unmet acceptance criteria.
6. Stop before deployment, production mutation, issue closure, or destructive cleanup unless the user explicitly requested that action.

Do not silently change requirements, invent missing dependencies, edit generated output, or mark the plan complete without evidence. Report changed files, commands run, results, and remaining risks.
