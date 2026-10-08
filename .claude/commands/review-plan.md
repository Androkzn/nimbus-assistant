# Review a plan against the repository

Review the plan at `$ARGUMENTS` against the current repository. Do not rewrite it until the review is complete.

Check:

- referenced files, symbols, routes, schemas, commands, and line numbers exist;
- the current-state evidence supports the proposed root cause;
- requirements, acceptance criteria, tests, observability, privacy, compatibility, rollout, and rollback are complete;
- every task is implementable and has a verification step;
- generated/vendor files and external systems are handled according to repository conventions;
- the plan contains no framework, provider, or infrastructure assumptions unsupported by the repository.

Report findings as `CRITICAL`, `WARNING`, or `SUGGESTION`, with evidence and exact locations. A plan is ready only when no critical factual or safety issues remain and all warnings are either fixed or explicitly accepted by the user.
