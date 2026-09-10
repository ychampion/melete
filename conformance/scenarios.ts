/**
 * The conformance suite. Eight scenarios that prove the properties this release
 * claims, run against a compose stack with the `test` connector and a scripted
 * model, so the suite is deterministic and costs nothing.
 *
 * These are the differentiator: anyone can run them and see for themselves.
 * Until the service exists they are `test.todo` with the exact assertion each
 * one will make, so the shape of the proof is reviewable now.
 */

export type Scenario = {
  id: number;
  slug: string;
  title: string;
  /** What is done to the system. */
  text: string;
  /** Each becomes one `test.todo`. Written as the assertion, not as a hope. */
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
    text:
      'Stall attempt A mid-run, let its lease expire, start attempt B, then let A resume and try to work.',
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
      'address, and a sibling container path.',
    assertions: [
      'curl to a public address fails: there is no default route, not a blocked request',
      'a connection to postgres:5432 fails',
      'a connection to 169.254.169.254 fails',
      'a connection to a sibling service on the edge network fails',
      'a connection to the broker on the internal network succeeds',
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
    text:
      'Run one scripted job against the fake provider and, when a key is present, against a real one.',
    assertions: [
      'the sequence of action statuses is identical on both providers',
      'the same approvals are requested for the same payload hashes',
      'the attempt row records the provider, the model requested, and the model actually served',
      'enforcement never depends on the model agreeing to be enforced',
    ],
  },
];

export const scenario = (id: number): Scenario => {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no conformance scenario ${id}`);
  return found;
};
