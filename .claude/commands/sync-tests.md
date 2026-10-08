# Synchronize tests with behavior

Use `$ARGUMENTS` to identify the feature, bug, or changed behavior whose tests need review.

Inspect the implementation and existing tests, then build a behavior-to-test matrix covering the happy path, validation, permissions, failure/fallback behavior, boundary cases, privacy/security, and user-visible outcomes that apply.

Add only the smallest missing tests in the repository's established test layers. Prefer deterministic fixtures and mocks; do not call production services or expose credentials. Run the narrow tests first, then the documented quality gates. Report uncovered behavior and limitations rather than claiming complete coverage without evidence.
