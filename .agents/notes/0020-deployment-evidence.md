# 0020 - Deployment claims require a running Linux stack

Status: accepted
Date: 2026-09-11

## Problem

The Compose configuration did not prove the runtime boundary. Its shared work
mount exposed sibling jobs, its internal bridge could reach the host, and the
runtime adapter, knowledge context and restriction replay were not wired into
normal deployment startup. Scenarios 6–8 were placeholders. Image builds and a
README installation needed measured execution.

## Decision

The trusted Melete service supervises a container per attempt through the local
Docker socket. Each child mounts only its job's volume subpath at `/work`, has a
separate named Hermes home, and joins a private internal bridge in isolated
gateway mode. Melete is its only peer. The runtime has no Docker socket or
standing provider/database credential. The supervisor resolves a labelled image
to its immutable image ID and reconciles only resources it owns.

Normal startup provisions the database-backed knowledge spaces and replays the
independent restriction journal before opening memory or starting job workers.
Actual attempts receive bounded eligible context, with durable context evidence.
The web image proxies `/api` to a fixed upstream on the browser's own origin.

The runtime build asserts the pinned Hermes commit and plugin content hash,
uses frozen dependencies, and writes a CycloneDX inventory. Deployment
conformance runs real Hermes containers with the explicit scripted provider.
The restore exercise replaces only the verified Postgres volume, retains the
newest removal journal, and checks a parked job through one destination effect.

## Alternatives

- A whole-volume workspace mount with tool-level path checks leaves direct
  Python reads outside that boundary; use the OS mount boundary instead.
- An internal Docker bridge alone retains a host bridge address; use isolated
  gateway mode and a positive-control host listener in the probe.
- Checking only the warm runtime misses dynamically supervised cells; probe
  both the warm cell and a real claimed attempt.
- A second VM is permitted but unnecessary for this check; an empty independent
  Docker daemon in a fresh Linux container host exercises the documented install.
- A missing provider credential cannot establish real-provider behavior; report
  that comparison as skipped.

## Evidence

The campaign used `lane/w6-deploy` from integration revision
`9484023cabd32b786cb4d336dec818f441cd0cc1`. Initial free space was
14,112,153,600 bytes. The first host ran Linux 6.8.0-138-generic, Docker 29.1.3,
Compose 2.40.3 and Bun 1.3.13. Only this lane's identified build cache and
explicitly owned fixtures were eligible for cleanup.

### Images

| Measurement | Runtime | Melete | Web |
| --- | ---: | ---: | ---: |
| Initial successful build seconds | 53.52 | 19.72 | 11.35 |
| Initial compressed content bytes | 287,454,086 | 96,084,643 | 70,179,404 |
| Initial Docker displayed disk usage | 1.00 GB | 477 MB | 260 MB |
| Final first-host compressed bytes | 296,757,737 | 122,029,764 | 70,180,910 |
| Final second-host uncompressed bytes | 681,097,087 | 352,241,107 | 181,052,159 |

The final runtime rebuild took 51.41 seconds; the final pair of application
images rebuilt in 26.99 seconds. An earlier no-cache runtime rebuild took
57.58 seconds and reproduced its then-current inventory. Initial timings had
some base/layer cache from failed attempts. The two hosts use different image
stores, so compressed content and uncompressed layer sizes are distinct metrics.

- Hermes tag: `v2026.9.7`.
- Asserted Hermes commit: `2237be355906fbe6065ce1815711eee52b2d646e`.
- Final plugin SHA-256: `742ebece0315ab89309b92ab75cd449d572556fda1771a135742095db609f7c9`.
- Final 200-component SBOM SHA-256: `4424628aac0b3f9a5bd5d05461fd7ca19fdd4ab1e0f4a2b5e9aac0ebd6ce522a`.
- First-host final runtime image: `sha256:c13bdb2a14d384b556f59932cdd679e90b647f64f1e0713a6345f0a2b3fd96cf`.
- Second-host final runtime image: `sha256:05b1564cbc82a3b0030f2e947a7f1ea605a474af4b61c855207a521a0c6ab576`.

The independent second build produced the same build-info and SBOM. Its offline,
read-only image smoke check ran as UID 10001. Source and dependency inventory
repeatability is established; byte-identical image digests are not claimed.

### Startup and clean install

| Service | First-host process to healthy ms | Healthy after first-host compose up ms | Clean-host process to healthy ms |
| --- | ---: | ---: | ---: |
| Postgres | 2,078 | 2,684 | 2,065 |
| Melete | 5,083 | 8,452 | 5,074 |
| Web | 2,079 | 11,166 | 2,077 |
| Runtime | 10,794 | 19,841 | 10,756 |

The first cold-container start took 20,287 ms with existing images and volumes.
All 16 Compose configuration checks passed.

The second host's daemon started with zero images and zero containers. It used
the official Docker 29.1.3 DinD image, Alpine 3.23, Compose 5.0.0, and a fresh
16 GiB tmpfs Docker store with overlay2. It shared the first host's kernel and
8 CPUs. The README installer selected Bun 1.4.2.

The README installation took **64.93 seconds**, including prerequisite packages,
Bun, source clone, frozen dependencies, all image pulls/builds, four healthy
services, and API/web HTTP checks. From creation of the host container through
completion, including daemon startup and source transfer, the interval was
**87.19 seconds**. The Docker host image was already available. No Docker images
or cache were transferred; source arrived as the README's credential-free Git
bundle at revision `209acd32aaa32814c4b12c8d8710a4ea07710a91`.

Literal execution found two README gaps: Alpine needed `libstdc++`/`libgcc`,
and source access needed a documented authenticated-host alternative. The two
failed attempts stopped at 3.58 and 3.55 seconds. Each retry used a new empty
daemon; the second fix passed. Tmpfs and local source transfer limit how broadly
the timing can be generalized. This is a fresh container host, not a second VM.

### Runtime boundaries and restart

Scenario 6's standalone live run passed 9 tests and 52 assertions in 47.82
seconds. From both cells, public IP, Postgres DNS and actual IP, metadata address,
web DNS and a proven live host listener were unreachable. A sibling canary
existed in the full work volume, but three cell read paths returned ENOENT;
the job workspace remained writable. Broker and model routes answered 401
without authentication. The cell had UID 10001, a read-only root, zero effective
capabilities, no-new-privileges and no Docker socket. Network inspection found
only Melete and the cell.

`MELETE_CONFORMANCE_COMPOSE=1 bun run deploy/scripts/compose-vertical.ts` passed
in 119,732 ms. The active-job restart took 12,977 ms and the parked-approval
restart 13,023 ms. Lease recovery produced three attempts and 44 durable events.
The approval identity and payload hash survived. The result was one succeeded
action, one receipt and one destination row.

### Whole conformance and repository checks

`MELETE_CONFORMANCE_COMPOSE=1 bun run conformance` passed 43 tests, skipped one
explicit real-provider comparison, and failed none: 266 assertions, 126.61
seconds. Scenarios 1–5 used disposable databases on Compose Postgres with
in-process services/scripted runtimes; 6–8 used deployed services and Hermes.

| Scenario | Passed | Skipped |
| --- | ---: | ---: |
| 1 durable wakes | 4 | 0 |
| 2 lease fencing | 4 | 0 |
| 3 unknown outcomes | 6 | 0 |
| 4 approval binding | 8 | 0 |
| 5 runtime death | 4 | 0 |
| 6 no route out | 9 | 0 |
| 7 retraction | 4 | 0 |
| 8 provider policy | 4 | 1 |

Scenario 7's restart took 12,807 ms. Actual context contained the record before
removal and omitted it afterward; FTS contained zero matching rows and Git kept
the retraction reason. In scenario 8 a valid cell capability read the catalog
(200) but could not approve (401); a changed owner approval hash returned 409.

The suite exposed Hermes context metadata being merged into the model's tool
payload. Positional arguments are now authoritative, including an empty object.
Three regression cases reproduced the defect before the fix. The Python plugin
suite passed 23 tests in 9.16 seconds.

`bun run conformance:memory` used disposable databases on Compose Postgres and
real memory routes with scripted extraction/answering. Ten active scenarios
passed; all ten withheld-memory arms failed as expected, proving those checks
needed memory. Combined scenario time was 4,182 ms.

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

Obsolete facts, unsupported claims and needless questions were zero. Procedure
promotion is the existing v0.1 deferred case, now printed truthfully in the
runner footer. The final repository suite passed 937 tests with 24 opt-in skips,
zero failures and 3,914 assertions in 77.37 seconds. Typecheck and lint passed.

### Backup and restore

`MELETE_CONFORMANCE_COMPOSE=1 bun run deploy/scripts/compose-restore.ts` passed
in 74,315 ms. It dumped a waiting job and two memory facts, forgot one fact after
the snapshot, destroyed only the verified Postgres volume, and restored the
dump while retaining five other volumes and the original environment file.

| Phase | Milliseconds |
| --- | ---: |
| Verify stack and volume ownership | 501 |
| Park the job and seed memory | 15,845 |
| Stop Melete and dump Postgres | 884 |
| Forget one fact after the dump | 6,716 |
| Replace the Postgres volume | 14,386 |
| Restore the empty database | 688 |
| Reject stale state before replay | 1,161 |
| Normal startup and replay verification | 18,618 |
| Approve the job and verify one receipt | 15,512 |

The dump was 191,325 bytes, SHA-256
`02b5a00ed65321f7ffd65f78e57095d3efb6225899140e47cc63fe9d101c2d06`.
Before startup the verification command exited 1 because the retained
restriction was absent from SQL. The API was stopped; this was not an HTTP
denial check. Normal startup replayed one journal restriction before opening
memory and workers. The forgotten fact yielded zero items and the unrelated
fact one. The restored job retained its approval ID/hash and completed with
one succeeded action, one receipt and one destination effect.

## Limits and falsifiers

Successful access to a blocked network target or the sibling canary falsifies
the tested cell boundary. An approval made with a cell capability falsifies
owner-only approval. Serving the forgotten fact after restore, losing the
waiting approval, or duplicating its destination effect falsifies recovery.

The provider comparison remains unverified without credentials. The web page
and same-origin proxy were checked over HTTP; no interactive browser walkthrough
was performed. Kernel isolation, other operating systems and rootless Docker
were not tested. The supervisor's Docker socket belongs to the trusted host
boundary.

Superseded attempt rows can retain a missing end timestamp after restart. Nine
such historical rows existed after the combined checks; their epochs were
fenced and no supervised cells remained. This is a recorded status limitation.
Detailed procedures and measured results are in [REPORT.md](../../REPORT.md)
and [deployment operations](../../docs/DEPLOYMENT.md).

## 2026-09-12 control-plane boundary correction

The original scenario 6 proved the attached peer set but did not prove that
only its broker port was reachable. The review's missing-port reproduction
failed as expected: 8 tests passed and 2 failed, with both the warm cell and a
claimed attempt receiving setup/login validation (400) and health state (200)
from `melete:8787`.

The API now binds only to the edge-network address resolved by the edge-only
`melete-api` alias. Its transport guard separately rejects source addresses
outside that interface's subnet, before any routing or account lookup. The
fixed 403 has no account state. The guard and login throttle use the real socket
source rather than forwarded headers. Login allows five attempts per source,
then exponential backoff from one to sixty seconds; the source map is bounded.

The new scenario 6 names are:

- `the warm cell cannot reach owner setup, login or health`
- `a claimed attempt cannot reach the owner control plane and retains its job boundary`

Against the rebuilt stack, scenario 6 passed 10 tests and 60 assertions in
47.70 seconds. All three owner routes returned ECONNREFUSED (111) from each
cell. Broker and gateway probes remained reachable with 401 without authority.
The API socket was bound to `172.20.0.2:8787`; only the broker used
`0.0.0.0:8788`. The host API health check returned 200.

The listener/authentication/Compose tests passed 35 tests and 143 assertions.
They verify the account-state denial before and after owner creation, socket
source handling, bounded throttle storage, and backoff. A live six-request
login burst with forged forwarding headers returned five 401 responses and
then 429 with `Retry-After: 1`, without issuing any session cookie. A cell
receiving owner account state, a wildcard owner API socket, or forwarding
headers bypassing this throttle would falsify the corrected claim.
