/**
 * A second instance of the service on the same database and the same spaces
 * volume, as a process of its own: its own pool and its own in-process queues.
 * It opens its files connector, says `ready`, and on a line `go` on stdin runs
 * one files step for the job it was given, then prints how it ended and exits.
 */
import { canonicalizePayload, jobConstraints } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { openDatabase } from '../../src/db/client.ts';

const input = JSON.parse(process.argv[2] ?? '{}') as {
  url: string;
  workRoot: string;
  spacesRoot: string;
  spaceId: string;
  jobId: string;
  kind: string;
  payload: Record<string, unknown>;
};
const handle = openDatabase(input.url, 2);
const connector = createFilesConnector({
  workRoot: input.workRoot,
  spacesRoot: input.spacesRoot,
  sql: handle.sql,
});
const id = recordId('act');
const canonical = canonicalizePayload(input.payload);
const now = new Date().toISOString();

process.stdout.write('ready\n');
const decoder = new TextDecoder();
let heard = '';
for await (const chunk of Bun.stdin.stream()) {
  heard += decoder.decode(chunk);
  if (heard.includes('go\n')) break;
}
let outcome: string;
try {
  const result = await connector.execute(
    {
      id,
      job_id: input.jobId,
      attempt_id: recordId('att'),
      connection_id: recordId('conn'),
      kind: input.kind,
      effect_class: 'write_reversible',
      canonical_payload: canonical.canonical,
      payload_hash: canonical.hash,
      intent_key: null,
      status: 'dispatched',
      authorization_ref: null,
      budget_reservation: null,
      idempotency_key: id,
      dispatched_at: now,
      receipt: null,
      resolved_at: null,
      reconciliation: null,
      repair_trace: [],
      repair_counters: {},
      repair_disposition: null,
      retry_after_at: null,
      created_at: now,
    },
    {
      job_id: input.jobId,
      space_id: input.spaceId,
      idempotency_key: id,
      constraints: jobConstraints.parse({}),
    },
  );
  outcome = result.outcome;
} catch (error) {
  outcome = `error: ${(error as Error).message}`;
}
process.stdout.write(`${JSON.stringify({ outcome })}\n`);
await handle.close();
process.exit(0);
