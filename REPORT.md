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
`/opt/melete-runtime/sbom.cdx.json` inventories 181 Python/system/plugin components;
`build-info.json` records both asserted hashes. The image smoke check ran as UID
10001 with a read-only root and no network, imported YAML, and confirmed Python
3.12.14 and the inventory. A clean rebuild comparison remains pending.

Failures fixed: the runtime PATH omitted `/usr/sbin`; the Bun Dockerfiles omitted
workspace manifests required by the frozen lockfile; upstream's Python version
file made uv install its interpreter beneath root's private home. The runtime
now uses the base image's Python explicitly and disallows interpreter downloads.

## Remaining checks

Per-attempt isolation, healthy stack startup, scenarios 1–8, memory conformance,
compose restart, clean-host installation, and actual backup/restore are pending.
No deployment completion or isolation claim is made by the build result alone.
