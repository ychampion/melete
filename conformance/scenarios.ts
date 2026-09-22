/**
 * The conformance suite. Ten scenarios that prove the properties this release
 * claims, run against a compose stack with the `test` connector and a scripted
 * model, so the suite is deterministic and costs nothing.
 *
 * These are the differentiator: anyone can run them and see for themselves.
 * The deployment scenarios require an explicitly opted-in disposable stack;
 * a skipped optional provider comparison is never reported as proof.
 */

export type Scenario = {
  id: number;
  slug: string;
  title: string;
  /** What is done to the system. */
  text: string;
  /** The observable assertions each scenario checks. */
  assertions: string[];
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 1,
    slug: 'durable-wakes',
    title: 'Due work survives a kill between the transition and the enqueue',
    text:
      'Kill the service in the window between committing a job transition and enqueuing its next wake, ' +
      'then deliver the timer twice.',
    assertions: [
      'exactly one attempt is admitted for the duplicated timer',
      'the job whose wake was lost is re-enqueued by the recovery scan within 60 seconds',
      'next_wake_at on the job row, not queue retention, is what makes the work recoverable',
      'the event stream shows one attempt_started, not two',
    ],
  },
  {
    id: 2,
    slug: 'lease-fencing',
    title: 'A stalled attempt cannot act after its lease expires',
    text: 'Stall attempt A mid-run, let its lease expire, start attempt B, then let A resume and try to work.',
    assertions: [
      'A cannot admit an action: the broker refuses it with stale_epoch',
      'B runs with the incremented lease_epoch and admits normally',
      "A's late receipt for an action it had already dispatched is recorded and marked late",
      'the late receipt does not restart work or change the job state',
    ],
  },
  {
    id: 3,
    slug: 'unknown-outcomes',
    title: 'An unacknowledged send stays unknown and is never re-sent',
    text:
      'Tell the test destination to accept a send and drop the acknowledgement, then run verify. ' +
      'Repeat against a destination that has no verify capability.',
    assertions: [
      'the action rests at unknown and the job moves to needs_reconciliation',
      'the action is never dispatched a second time',
      'verify resolves the action to succeeded and the job continues',
      'against a destination with no verify, the action rests at unresolved and the owner is asked',
      'the UI text names the doubt: Melete cannot confirm whether this was sent',
    ],
  },
  {
    id: 4,
    slug: 'approval-binding',
    title: 'An approval cannot be spent on different content',
    text:
      'Approve a draft, tamper with the payload, and try to admit. Separately, cancel a job while a ' +
      'dispatch is in flight.',
    assertions: [
      'admission is rejected when the payload hash no longer matches the approval',
      'admission is rejected when the job revision has moved since the approval',
      'editing the draft produces a new action with a new hash, not an amended one',
      'after a cancel, nothing new is admitted past the fence',
      'an action admitted before the cancel gets a truthful disposition, not a hidden one',
    ],
  },
  {
    id: 5,
    slug: 'runtime-death',
    title: 'A job survives the death of the process running it',
    text:
      'Kill the runtime mid-stream, and again immediately after a tool call completes but before the ' +
      'outcome is committed.',
    assertions: [
      'the job resumes from durable state on the next wake',
      'no action is duplicated: the completed tool call is not run twice',
      'the interrupted run is a dead attempt and is never resumed',
      'the gap in the event stream is recorded, and history is never shown as missing',
    ],
  },
  {
    id: 6,
    slug: 'no-route-out',
    title: 'The runtime container has no route to anything but the broker',
    text:
      'From inside the runtime container, try the internet, the Postgres port, the host metadata ' +
      'address, a live host listener, and a sibling job path in both the warm cell and a claimed attempt.',
    assertions: [
      'Python TCP to a public address fails and the routing table has no default route',
      'Postgres is unreachable by DNS and its actual container IP',
      'a connection to 169.254.169.254 fails',
      'a connection to a sibling service on the edge network fails',
      'a sibling job canary is absent while the current workspace is writable',
      'a positively verified host listener is unreachable',
      'the broker and model gateway answer and are the only attached peer',
      'owner setup, login and health refuse connections from both runtime cells without account state',
      'the container runs as a non-root user with a read-only root filesystem',
    ],
  },
  {
    id: 7,
    slug: 'retraction',
    title: 'A retracted record leaves retrieval at once and stays gone',
    text: 'Retract a knowledge record while a job is running, then restart the whole stack.',
    assertions: [
      "the next attempt's retrieval does not return the retracted record",
      'the record is absent from the FTS index, not merely filtered out of results',
      'after a restart, retrieval still does not return it',
      'the retraction and its reason remain readable in git',
    ],
  },
  {
    id: 8,
    slug: 'model-agnostic',
    title: 'The same job produces the same policy outcomes on two providers',
    text: 'Run one scripted job against the fake provider and, when a key is present, against a real one.',
    assertions: [
      'the sequence of action statuses is identical on both providers',
      'the same approvals are requested for the same payload hashes',
      'the attempt row records the provider, the model requested, and the model actually served',
      'enforcement never depends on the model agreeing to be enforced',
    ],
  },
  {
    id: 9,
    slug: 'space-removal',
    title: 'Deleting a space leaves nothing of it, and a restore does not bring it back',
    text:
      'Seed a shared space with a memory claim and its source, a knowledge file, a job with a receipt, ' +
      'an artifact with a validation row, a connection with a sealed secret, a browser profile signed in ' +
      'to one site, a learning episode and an accepted procedure, and a sandbox session at a fake ' +
      'provider. Take a database backup. Delete the space. Restore the backup.',
    assertions: [
      'no row keyed to the space is left in any table, walked from the live catalog rather than a written list',
      'the four tables whose job_id is merely nulled are gone, receipts and notification content with them',
      'the space directory is gone, its git history and its browser profile with it',
      'no job workspace is left under the work root for any job the space had',
      'the fake provider lists no session and no snapshot for the space',
      'one remove_space record is in the retained journal and its hash chain still verifies',
      'after restoring the backup, memory is not restore_ready and a fresh removal is queued',
      'the resumed removal clears the restored space again, and every assertion above holds',
      'with the provider refusing, the removal ends blocked, the space remains, and nothing says it was deleted',
      'a personal space keeps its id, its account stays signed in, and every content table for it is empty',
      'a member is refused, and the granted tool catalog contains no tool that reaches removal',
    ],
  },
  {
    id: 10,
    slug: 'stdio-mcp',
    title:
      'A stdio MCP server runs in a container of its own and reaches only what its owner named',
    text:
      'Start stdio MCP servers through the Docker launcher on a real engine: a probe image with no ' +
      'destinations, the same probe with one named destination, a server that exits on its own, and ' +
      'a real npm package fetched by npx.',
    assertions: [
      'the server runs as uid 10001 with no capabilities, no new privileges, a seccomp filter and a read-only root',
      'its only writable place is its own volume, and the Docker socket is absent',
      'with no destination named it has only a loopback interface and reaches nothing',
      'its environment holds its sealed variable and nothing of the service',
      'with one destination named it reaches that destination through the proxy and nothing else',
      'a server that exits on its own leaves no container behind, and removal takes its volume',
      'an npm package is fetched once through the registry grant and then runs with no network',
    ],
  },
];

export const scenario = (id: number): Scenario => {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no conformance scenario ${id}`);
  return found;
};
