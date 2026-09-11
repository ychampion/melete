# W6 deployment evidence

Campaign started 2026-09-11 at 20:50 UTC on Linux amd64. Base:
`9484023cabd32b786cb4d336dec818f441cd0cc1` (`origin/integration`).
Branch: `lane/w6-deploy`. This report is updated as each deployment check runs.

## Assumptions

- Use the supplied clean `/root/melete-oss-w6` worktree, already branched from
  `origin/integration`, rather than replace the existing checkout.
- Run with the explicit fake provider and test connector; no provider credentials
  are needed for the deterministic deployment proof.
- The five-hour campaign ends at 01:50 UTC on 2026-09-12. Each failing check gets
  at most two fix cycles. Unverified checks are reported as such.
- Reclaim only this lane's identified build cache. The initial builder cache was
  empty; pre-existing images, containers and volumes are outside this lane.

## Host preflight

The first command, `df -h /`, reported 14 GB available (14,112,153,600 bytes).
Docker Engine 29.1.3, API 1.52; Compose 2.40.3; Bun 1.3.13. Ports 3100 and 3101
were unused. Postgres has no published host port.

## Image build

Commands use the repository root as the context for the two Bun images and
`packages/runtime-hermes` as the runtime context.

| Image | Successful build seconds | Compressed content bytes | Docker displayed disk usage |
| --- | ---: | ---: | ---: |
| Runtime | 53.52 | 287,454,086 | 1.00 GB |
| Melete | 19.72 | 96,084,643 | 477 MB |
| Web | 11.35 | 70,179,404 | 260 MB |

These are initial successful builds, with some base/layer cache left by the
failed attempts. They are not clean-host installation timings. Docker's
containerd image store reports compressed content via image inspect and combined
content/snapshot disk usage in image ls; the columns measure different things.

The runtime asserts Hermes tag `v2026.9.7` resolves to
`2237be355906fbe6065ce1815711eee52b2d646e`. Its labels also identify plugin content
SHA-256 `181a9f349c5b3dbbc42d70d446a0f89124b8151cec5ab776f2bdd2992e9d9e3b`.
Base images are pinned by digest; Bun and Python dependencies use frozen locks.
`/opt/melete-runtime/sbom.cdx.json` inventories 200 Python/system/plugin components;
`build-info.json` records both asserted hashes. The image smoke check ran as UID
10001 with a read-only root and no network, imported YAML, and confirmed Python
3.12.14 and the inventory. A no-cache rebuild took 57.58 seconds and produced
the same pins and inventory SHA-256
`79b483e3b6ac766bccec94eec52ddf078b83fb94935b3cff7e6178b3aaee337f`.
This establishes repeatable source/dependency content, not identical image
bytes: image timestamps, upstream apt repositories and attestations remain variable.

Failures fixed: the runtime PATH omitted `/usr/sbin`; the Bun Dockerfiles omitted
workspace manifests required by the frozen lockfile; upstream's Python version
file made uv install its interpreter beneath root's private home. The runtime
now uses the base image's Python explicitly and disallows interpreter downloads.
Live startup also required installing the Hermes entrypoint into its venv and
including its locked messaging extra for the API server's aiohttp dependency.

## Per-attempt isolation

The trusted service now supervises one Hermes container per claimed attempt.
Only that service receives the Docker socket. Each child mounts the named work
volume's `job_<id>` subpath at `/work`, an independent named Hermes home, and
an internal bridge with isolated gateway mode and exactly the broker peer.
Startup reconciles only strictly labelled resources belonging to this project.

The deployed proof stopped only a real claimed cell's engine process, then ran
Python probes in that container. A sibling canary existed in the shared volume
as a positive control, but three traversal forms returned ENOENT from the cell;
its own workspace remained writable. Internet, Postgres DNS and actual IP,
metadata, web DNS, and a proven live host listener were unreachable. Broker
and model routes returned HTTP 401 without authentication. UID 10001, read-only
root, zero effective capabilities, no-new-privileges and absence of the Docker
socket were checked from inside. The warm probe cell passed the same checks.
Scenario 6: 9 tests, 52 assertions, 47.82 seconds, zero failures.

The startup wiring also provisions database-backed knowledge spaces and opens
memory only after replaying its independent restriction journal. Per-attempt
context uses the existing memory eligibility/invalidation path and bounded
Markdown retrieval; context records use separate durable audit identities.

## Healthy stack

Compose separates Postgres from the runtime bridge. The default stack now
starts all four services, including the web client with a fixed same-origin
API proxy. Configuration is generated at `deploy/.env` with mode 0600; provider
keys stay in the trusted service. The configuration checker passes all 16 checks.

A cold-container start with existing images and volumes took 20.287 seconds.
Docker events measured each process from start to first healthy event:

| Service | Process to healthy milliseconds | Healthy after compose up milliseconds |
| --- | ---: | ---: |
| Postgres | 2,078 | 2,684 |
| Melete | 5,083 | 8,452 |
| Web | 2,079 | 11,166 |
| Runtime | 10,794 | 19,841 |

The final Bun image rebuild completed both images in 26.99 seconds. Melete
compressed content is 122,029,764 bytes; web is 70,180,910 bytes. Melete's restore
proof module was imported successfully inside its deployed non-root container.
The proxy tests, browser hook tests and global typecheck pass. The full repository
suite passed 937 tests and 3,914 assertions in 80.48 seconds; 24 deployment-only
or opt-in cases were explicitly skipped in that separate fixture-database run.

## Compose restart vertical slice

`MELETE_CONFORMANCE_COMPOSE=1 bun run deploy/scripts/compose-vertical.ts` submitted
through the deployed web/API, stopped a claimed cell's engine, and restarted
all four services. After lease expiry the job obtained a fresh attempt. A second
restart during `waiting_for_approval` preserved the action, approval ID and
payload hash. Owner approval then completed the job with one succeeded action,
one receipt and one row at the test destination.

The active restart took 12,977 ms, the parked restart 13,023 ms, and the entire
flow 119,732 ms including lease recovery. It recorded three distinct attempts
and 44 durable events. The first attempt was fenced/lost and never resumed.
The parked restart left the prior epoch's attempt row without an end timestamp;
the current job epoch fenced it, its container was removed, and the replacement
completed. This is a historical attempt-status limitation, not a duplicate effect.

The first standalone flow initially exceeded its 5,000-token test budget because
the gateway reserves serialized input bytes plus completion allowance. Its
explicit fixture budget is now 250,000; the enforcement limit was not relaxed.

## Full conformance

`MELETE_CONFORMANCE_COMPOSE=1 bun run conformance`: 43 passed, 1 explicitly
skipped, 0 failed; 266 assertions in 126.61 seconds. Scenarios 1–5 use isolated
databases on the Compose Postgres host and in-process services/scripted runtimes.
Scenarios 6–8 use the deployed web, API, broker and real Hermes containers.

| Scenario | Passed | Skipped | What ran |
| --- | ---: | ---: | --- |
| 1 durable wakes | 4 | 0 | Lost/duplicate wake recovery |
| 2 lease fencing | 4 | 0 | Expired attempt admission and late receipts |
| 3 unknown outcomes | 6 | 0 | One destination acceptance, verify and unresolved states |
| 4 approval binding | 8 | 0 | Changed hash/revision, cancellation and truthful dispositions |
| 5 runtime death | 4 | 0 | Replacement attempt and no duplicate completed action |
| 6 no route out | 9 | 0 | Warm cell and actual claimed-cell Linux probes |
| 7 retraction | 4 | 0 | Real context before/after removal, FTS rows, Git and restart |
| 8 provider policy | 4 | 1 | Fake model, approval hash, actual model metadata and cell denial |

Scenario 7's final restart took 12,807 ms. Its first attempt actually received
the record; the later attempt omitted it. Both attempts emitted runtime events.
Scenario 8's running-cell capability could read the tool catalog (200), but
could not approve an action (401). Altering the owner approval hash returned 409;
the valid decision yielded exactly one destination effect. No real-provider
credential was configured, so the second-provider comparison is unverified.

The first whole conformance run found Hermes execution-context keywords merged
into tool arguments. The plugin now forwards the authoritative positional model
payload; session metadata cannot alter approval hashes or proposal identity.
Three regression cases reproduced that defect; the complete Python plugin suite
passed 23 tests in 9.16 seconds. The runtime was repinned to plugin SHA-256
`742ebece0315ab89309b92ab75cd449d572556fda1771a135742095db609f7c9` and rebuilt in
51.41 seconds. Its 200-component SBOM hash is now
`4424628aac0b3f9a5bd5d05461fd7ca19fdd4ab1e0f4a2b5e9aac0ebd6ce522a`.

Memory conformance used disposable databases on the Compose Postgres host and
real memory routes with scripted extraction/answering. Ten active scenarios and
all ten withheld-memory counterfactuals passed their intended checks; their
combined scenario time was 4,182 ms. `procedure-transfer` remains the existing
explicit todo because candidate-procedure promotion is not enabled in v0.1.

| Memory family | Active passed | Recall p50/p95 ms | Correction to serving ms |
| --- | ---: | ---: | ---: |
| Stable personalization | 1/1 | 3.64 / 4.98 | — |
| Corrections and time | 2/2 | 8.23 / 18.36 | 44 |
| Continuing work | 1/1 | 8.78 / 15.74 | — |
| Relationships | 1/1 | 3.16 / 4.31 | — |
| Source authority | 2/2 | 3.56 / 4.65 | — |
| Forgetting and access | 2/2 | 5.08 / 7.37 | — |
| Low-value memory | 1/1 | 3.09 / 3.09 | — |
| Procedure transfer | deferred | — | — |

Obsolete facts, unsupported claims and needless questions were all zero in the
active scenarios. The runner now prints the deferred count instead of claiming
every family passed. Final repository verification: 937 passed, 24 explicit
skips, 0 failures, 3,914 assertions in 77.37 seconds; typecheck and lint passed.
A separate review of supervisor ownership, context, startup gates and restore
guards found no concrete defects.

## Clean-host install

The final README procedure completed in **64.93 seconds** on a fresh Linux
container host, including prerequisite packages, Bun installation, source clone,
frozen dependency installation, all image pulls/builds, four healthy services,
and HTTP checks of the API, web API proxy, and web page. It installed source
revision `209acd32aaa32814c4b12c8d8710a4ea07710a91`.

The host used the official Docker 29.1.3 DinD image, Alpine 3.23, Compose 5.0.0,
and Bun 1.4.2. Its independent daemon began with **zero images and zero
containers**. Docker storage was a new 16 GiB tmpfs using overlay2; it shared
the first host's Linux 6.8.0-138-generic kernel and 8 CPUs. This is the brief's
fresh-container-host option, not a second VM. The timed interval excludes
provisioning the Docker host and transferring the source bundle, both prepared
before the install. No Docker image or build cache was transferred. The tmpfs
and local source transfer make this timing specific to this fixture.

The README needed two fixes found by literal execution: minimal Alpine lacked
the C++ runtime required by Bun, and unauthenticated source cloning was not
available. It now lists Alpine prerequisites and a source-bundle alternative
that transfers no credential or local configuration. Both failed hosts were
replaced with empty daemons before retrying; the second fix passed. The final
run used the documented PR branch and bundle substitutions.

Docker events measured these clean-host process-to-healthy times:

| Service | Milliseconds |
| --- | ---: |
| Postgres | 2,065 |
| Melete | 5,074 |
| Web | 2,077 |
| Runtime | 10,756 |

The clean-host runtime independently reproduced the final Hermes/plugin labels
and the exact 200-component SBOM hash
`4424628aac0b3f9a5bd5d05461fd7ca19fdd4ab1e0f4a2b5e9aac0ebd6ce522a`.
With the classic overlay2 store, image inspect reports uncompressed layer sizes:
runtime 681,097,087 bytes, Melete 352,241,107 bytes, and web 181,052,159 bytes.
These sizes are not directly comparable with the first host's compressed
containerd content sizes. All four services remained healthy after the install.
