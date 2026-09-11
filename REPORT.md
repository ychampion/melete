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

## Remaining checks

The four-service stack is healthy; remaining suite, clean-host and restore
measurements are recorded in subsequent slices. No overall completion is claimed yet.
