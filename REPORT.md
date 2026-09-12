# W6 deployment evidence

Campaign started 2026-09-11 at 20:50 UTC on Linux amd64. Base:
`9484023cabd32b786cb4d336dec818f441cd0cc1` (`origin/integration`).
Branch: `lane/w6-deploy`. Both Linux stacks reached four healthy services;
the restart, isolation and restore proofs passed. The clean-host installation
took 64.93 seconds. The explicit provider skip and deferred memory scenario are
listed below rather than counted as passing checks.

## Assumptions

- Use the supplied clean `/root/melete-oss-w6` worktree, already branched from
  `origin/integration`, rather than replace the existing checkout.
- Run with the explicit fake provider and test connector; no provider credentials
  are needed for the deterministic deployment proof.
- The five-hour campaign ends at 01:50 UTC on 2026-09-12. Each failing check gets
  at most two fix cycles. Unverified checks are reported as such.
- Reclaim only this lane's identified build cache. The initial builder cache was
  empty; pre-existing images, containers and volumes are outside this lane.
- Use a fresh container host for the second install, as permitted by the brief.
  Its independent Docker daemon has no imported images or build cache; tmpfs
  storage avoids exhausting the first host's disk during the extra builds.
- Use the README's source-bundle path because the source host requires
  authentication. Keep the existing credential off the second host.

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
`2237be355906fbe6065ce1815711eee52b2d646e`. Its final labels identify plugin content
SHA-256 `742ebece0315ab89309b92ab75cd449d572556fda1771a135742095db609f7c9`.
Base images are pinned by digest; Bun and Python dependencies use frozen locks.
`/opt/melete-runtime/sbom.cdx.json` inventories 200 Python/system/plugin components;
`build-info.json` records both asserted hashes. The image smoke check ran as UID
10001 with a read-only root and no network, imported YAML, and confirmed Python
3.12.14 and the inventory. Before the tool-payload correction below, a no-cache
rebuild took 57.58 seconds and produced the same initial plugin pin
`181a9f349c5b3dbbc42d70d446a0f89124b8151cec5ab776f2bdd2992e9d9e3b`
and inventory SHA-256
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
The proxy tests, browser hook tests and global typecheck pass. Final repository
results are recorded with the conformance table below. No interactive browser
walkthrough was performed; the deployed web page and proxy were checked over HTTP.

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
The final runtime's first-host compressed content size is 296,757,737 bytes.

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
From creation of the host container through install completion, including
daemon startup and source transfer, the elapsed interval was 87.19 seconds
(21:51:18.945–21:52:46.133 UTC). The Docker host image was already available.

The README needed two fixes found by literal execution: minimal Alpine lacked
the C++ runtime required by Bun, and unauthenticated source cloning was not
available. It now lists Alpine prerequisites and a source-bundle alternative
that transfers no credential or local configuration. Both failed hosts were
replaced with empty daemons before retrying; the second fix passed. The final
run used the documented PR branch and bundle substitutions.
The two failed install attempts stopped after 3.58 and 3.55 seconds, respectively.

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

## Backup and restore

`MELETE_CONFORMANCE_COMPOSE=1 bun run deploy/scripts/compose-restore.ts` passed
on the deployed stack in **74,315 ms**. It parked a real Hermes job for approval,
seeded two memory facts, and took a custom-format `pg_dump`. It then forgot one
fact after that snapshot so the independent journal was newer than the dump.

The script stopped the stack and destroyed only the positively identified
`melete_pgdata` volume. All five other named volumes and the original `.env`
were retained and verified unchanged. It restored into an empty database.
The dump was 191,325 bytes, SHA-256
`02b5a00ed65321f7ffd65f78e57095d3efb6225899140e47cc63fe9d101c2d06`.

| Restore phase | Milliseconds |
| --- | ---: |
| Verify stack and volume ownership | 501 |
| Park a real job and seed memory | 15,845 |
| Stop Melete and dump Postgres | 884 |
| Forget one fact after the snapshot | 6,716 |
| Replace the exact Postgres volume | 14,386 |
| Restore the empty database | 688 |
| Reject stale state before replay | 1,161 |
| Normal startup, health and replay verification | 18,618 |
| Approve the restored job and verify one receipt | 15,512 |

Before startup, the read-only verification command failed with exit 1 because
the retained restriction had not been replayed. The API was stopped during this
check; this is not an HTTP denial measurement. Normal startup then replayed one
journal restriction into SQL before opening memory and job workers. The
forgotten fact returned zero items; the unrelated fact returned one.

The restored job was still `waiting_for_approval` with the same approval ID and
payload hash and no destination effect. Approval completed it with exactly one
succeeded action, one receipt, and one destination row. All four services were
healthy afterward. The script requires explicit Compose opt-in, fake-provider
and test-connector flags, checkout/project/volume ownership checks, a verified
backup, and no other consumers before replacing that one volume. A partial
restore leaves Melete stopped. Backup bytes and detailed evidence stay in a
private directory outside the checkout.

## Scope and limits

- Image source pins, dependency locks and the final SBOM reproduced on two
  independent daemons. Byte-identical image digests are not claimed.
- The deployment ran real Hermes containers with a scripted provider and test
  destination. Real-provider comparison remains explicitly skipped without
  credentials; memory procedure transfer remains the pre-existing deferred case.
- Restart recovery preserves effect identity. Superseded attempt rows can still
  lack an end timestamp; nine such historical rows were observed after the
  combined runs. Their epochs were fenced and no supervised containers remained.
- The Linux network and mount checks establish the named boundaries on the
  tested rootful Docker hosts. They do not establish VM isolation or other
  operating systems. The trusted supervisor's Docker socket is inside the host
  trust boundary.

The reproducible commands and Linux boundary evidence are also recorded in
[note 0020](.agents/notes/0020-deployment-evidence.md) and the
[threat model](docs/THREAT-MODEL.md). Raw logs, timing files, event traces and the
private restore archive are retained outside the checkout; no local credential
or database dump is included in the PR.

The measurement campaign finished at 22:03 UTC, about 73 minutes after starting
and within its five-hour cap. The two owned auxiliary fixture containers were
removed after evidence capture. The primary four-service stack remains available;
no pre-existing image, container or volume was pruned.

## 2026-09-12 PR review results

Database-dependent checks use disposable databases on the existing Compose
Postgres server, with `DATABASE_URL` passed privately. Deployment checks use the
scripted provider and test destination. No resources were pruned.

### HIGH: runtime access to the owner control plane

The owner API binds only to the edge interface resolved by the edge-only
`melete-api` alias. A separate socket-source guard rejects other subnets before
any account lookup, with the same 403 before and after owner creation. Login
reserves five attempts per socket source before asynchronous work, then applies
1/2/4/.../60-second backoff and `Retry-After`. Forwarded headers cannot change
the source, and the source map is bounded.

| Command / check | Exit | Result |
| --- | ---: | --- |
| `MELETE_CONFORMANCE_COMPOSE=1 bun test conformance/scenarios/06-no-route-out.test.ts` against the reviewed image | 1 | Expected reproduction: 8 passed, 2 failed, 57 assertions; both cells reached setup/login validation (400) and health (200) |
| `bun test apps/melete/src/api/listener.test.ts apps/melete/src/api/login-throttle.test.ts apps/melete/test/integration/auth.test.ts deploy/scripts/compose-check.test.ts` | 0 | 35 passed, 143 assertions, 6.11 s |
| `bun run typecheck` | 0 | TypeScript checks passed |
| `docker compose --progress plain -f deploy/docker-compose.yml build melete` | 0 | 26.736 s |
| `docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 180` | 0 | All four services healthy, 7.935 s |
| `MELETE_CONFORMANCE_COMPOSE=1 bun test conformance/scenarios/06-no-route-out.test.ts` against the rebuilt image | 0 | 10 passed, 60 assertions, 47.70 s |
| Live `/login` burst with six different forged forwarding headers | 0 | Five 401 responses, then 429 with `Retry-After: 1`; no session cookies |

All six owner-route probes returned ECONNREFUSED (111). Broker and gateway
routes remained reachable and returned 401 without capabilities. `/proc/net/tcp`
showed `172.20.0.2:8787` for the API and `0.0.0.0:8788` for the broker;
the host's `http://127.0.0.1:3100/health` returned 200 with database `ok`.

### MEDIUM: OAuth credential consequence

The threat model again states that runtime compromise exposes a locally stored
OAuth token while a gateway-held API key remains outside the cell, and recommends
API keys through the gateway. The existing scope sentence remains: runtime OAuth
was not configured or tested. Documentation check: `git diff --check`, exit 0.
