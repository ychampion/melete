# Contributing

For substantial changes, describe the problem and intended behavior in an issue
or pull request. Keep claims tied to code and executable evidence.

## Set up and verify

Use the commands in [README](README.md#verify-from-the-repository-root), from
the repository root. Bun 1.3 or newer is required by `package.json`.

Database tests use disposable Postgres, including embedded Postgres 17 when
`DATABASE_URL` is unset. The test `pg-boss uses the embedded database` checks
queue/database integration. A missing binary may produce a skip; it does not
establish a pass.

OpenAPI and client declarations are generated. The tests `is byte-identical to
a fresh run of client:generate` and the OpenAPI generation tests check drift.
Inspect and commit generated changes when changing contracts.

## Change guidelines

- Keep public claims tied to named tests and their actual fixture scope.
  Label unexecuted scenarios **written, not run**, and unsupported properties
  **not claimed**.
- Test behavior at boundaries. The conformance examples include stale epochs,
  payload-bound approvals and unknown sends that are not repeated.
- Explain changes to tool surface, prompts and budgets with measured evidence.
- Record architectural decisions under `.agents/notes`; preserve the historical
  record. Current documentation must distinguish that history from current code.
- Separate static configuration checks from inside-container probes. The
  scenario 6 container tests are **written, not run**; a YAML check cannot make
  them pass.

Use plain prose commit messages. Explain what changed, its tested behavior and
remaining limits in the pull request. Avoid claiming full-suite success from
skipped database tests.

## Licence

Contributions are licensed under Apache-2.0, as described in [LICENSE](LICENSE).
