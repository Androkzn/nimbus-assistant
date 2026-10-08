# Safely land a completed change

Prepare the current branch for merge to the repository's primary branch.

1. Inspect branch, remotes, status, diff, and recent history.
2. Confirm the change maps to the approved plan and does not include unrelated files or secrets.
3. Run the repository's required checks and record their results.
4. Confirm CI, branch protection, required reviews, deployment gates, and rollback expectations from repository configuration.
5. Present the proposed commit/PR summary and any blockers.

Do not rewrite history, force-push, bypass required checks, deploy, or merge without explicit authorization. If the user authorizes a commit or push, use a descriptive message and report the exact commit, branch, and verification evidence.
