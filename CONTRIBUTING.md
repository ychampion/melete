# Contributing

For substantial changes, describe the problem and the intended behaviour in an
issue or pull request. Keep claims tied to code and to executable evidence.

Report a security problem privately, as described in [SECURITY](SECURITY.md),
rather than in an issue.

## Set up and verify

Use the commands in [README](README.md#develop-and-verify), from the repository
root. Bun 1.3 or newer is required by `package.json`.

Run `bun run doctor` first: it names each missing test prerequisite. Database
tests use disposable Postgres, including embedded Postgres 17 when
`DATABASE_URL` is unset. The test `pg-boss uses the embedded database` covers
queue and database integration.

On Linux, set `DATABASE_URL` to a Postgres 17 you control, and the helpers will
create disposable databases on it: the embedded Postgres build needs `libpq5`
and an ICU 60 runtime that current Debian and Ubuntu ship without. Tests run as
a non-root user with a writable `TMPDIR`; embedded Postgres refuses to start as
root. `bun run test:plugin` needs `uv` on `PATH`. The two integration tests that
start an interpreter use `MELETE_PYTHON`, then `python3`, then `python`.

OpenAPI and client declarations are generated. The tests `is byte-identical to a
fresh run of client:generate` and the OpenAPI generation tests check drift.
Inspect and commit generated changes when you change a contract.

## Change guidelines

- Keep public claims tied to named tests and to the actual scope of their
  fixtures.
- Test behaviour at boundaries. The conformance examples include stale epochs,
  payload-bound approvals and unknown sends that are never repeated.
- Explain changes to tool surface, prompts and budgets with measured evidence.
- Record architectural decisions under `.agents/notes`, and preserve the
  historical record there rather than editing it.
- Separate static configuration checks from inside-container probes. The
  scenario 6 container tests run against a Compose stack with the opt-in set; a
  YAML check cannot stand in for them, and a run on one host establishes that
  host.

Use plain prose commit messages. Explain what changed and its tested behaviour
in the pull request. Run the suites sequentially on small machines, and say
which ones you ran.

## Licence

Contributions are licensed under Apache-2.0, as described in [LICENSE](LICENSE).
