import type {
  Action,
  ConnectorFaultKind,
  ConnectorManifest,
  JsonValue,
  Receipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { type ConnectorDescription, ConnectorFaultError } from './faults.ts';
import type { Connector, ConnectorContext } from './types.ts';

export type TestDelivery = {
  action_id: string;
  connection_id: string;
  payload_hash: string;
  payload: Record<string, JsonValue>;
  accepted_at: string;
};

export interface TestDestinationLedger {
  accept(delivery: TestDelivery): Promise<TestDelivery>;
  find(actionId: string): Promise<TestDelivery | undefined>;
  health(): Promise<void>;
}

/** Separate destination state survives a broker restart and an acknowledgement loss. */
export async function initializeTestLedger(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS test_destination_ledger (
      action_id text PRIMARY KEY,
      connection_id text NOT NULL,
      payload_hash text NOT NULL,
      payload jsonb NOT NULL,
      accepted_at timestamptz NOT NULL
    )
  `;
}

export function postgresTestLedger(sql: Sql): TestDestinationLedger {
  const find = async (actionId: string): Promise<TestDelivery | undefined> => {
    const [row] = await sql`
      SELECT action_id, connection_id, payload_hash, payload, accepted_at
      FROM test_destination_ledger WHERE action_id = ${actionId}
    `;
    if (!row) return undefined;
    return {
      action_id: row.action_id,
      connection_id: row.connection_id,
      payload_hash: row.payload_hash,
      payload: row.payload,
      accepted_at: new Date(row.accepted_at).toISOString(),
    };
  };
  return {
    async accept(delivery) {
      // Drizzle installs an identity JSON serializer on a shared postgres client.
      // Bind bytes explicitly so a raw object cannot reach postgres's wire encoder.
      await sql`
        INSERT INTO test_destination_ledger
          (action_id, connection_id, payload_hash, payload, accepted_at)
        VALUES (${delivery.action_id}, ${delivery.connection_id}, ${delivery.payload_hash},
          ${JSON.stringify(delivery.payload)}::jsonb, ${delivery.accepted_at})
        ON CONFLICT (action_id) DO NOTHING
      `;
      const accepted = await find(delivery.action_id);
      if (!accepted) throw new Error('destination acceptance could not be read');
      return accepted;
    },
    find,
    async health() {
      await sql`SELECT 1 FROM test_destination_ledger LIMIT 1`;
    },
  };
}

/** Unit-test destination only. Production and conformance pass postgresTestLedger. */
export function memoryTestLedger(): TestDestinationLedger {
  const deliveries = new Map<string, TestDelivery>();
  return {
    async accept(delivery) {
      if (!deliveries.has(delivery.action_id)) {
        deliveries.set(delivery.action_id, structuredClone(delivery));
      }
      return structuredClone(deliveries.get(delivery.action_id) as TestDelivery);
    },
    async find(actionId) {
      const found = deliveries.get(actionId);
      return found ? structuredClone(found) : undefined;
    },
    async health() {},
  };
}

export class TestAcknowledgementDropped extends Error {
  constructor() {
    super('destination accepted the action but dropped its acknowledgement');
    this.name = 'TestAcknowledgementDropped';
  }
}

const receiptFor = (delivery: TestDelivery): Receipt => ({
  action_id: delivery.action_id,
  connection_id: delivery.connection_id,
  external_ref: delivery.action_id,
  detail: { payload_hash: delivery.payload_hash, accepted_at: delivery.accepted_at },
  received_at: new Date().toISOString(),
  late: false,
});

function checkIdentity(action: Action, ctx: ConnectorContext): void {
  if (
    ctx.job_id !== action.job_id ||
    ctx.idempotency_key !== action.id ||
    action.idempotency_key !== action.id
  ) {
    throw new Error('connector action identity mismatch');
  }
}

/**
 * One fault case per class in the taxonomy, so the repair policy can be run
 * against a destination that fails on purpose and always the same way.
 *
 * A case is chosen per action with a `fault` field in the payload, or for the
 * whole connector with `MELETE_TEST_CONNECTOR_FAULT`. The payload field wins,
 * so one fixture can hold a healthy send and a drifting one at once.
 */
export const TEST_FAULT_CASES = [
  'healthy',
  'transient_before_dispatch',
  'persistent_transient',
  'rate_limited',
  'expired_credential',
  'revoked_credential',
  'schema_drift',
  'unsupported_route',
  'bad_output',
  'lost_ack_verifiable',
  'lost_ack_unverifiable',
  'unclassified',
] as const;
export type TestFaultCase = (typeof TEST_FAULT_CASES)[number];

const isFaultCase = (value: unknown): value is TestFaultCase =>
  typeof value === 'string' && (TEST_FAULT_CASES as readonly string[]).includes(value);

/** The route the destination accepts once the first one has refused the call. */
export const TEST_FALLBACK_ROUTE = 'test.send/authorized-fallback';

/** Fields the drifted destination accepts without requiring them. */
const DRIFT_OPTIONAL = ['fault', 'drop_ack', 'retry_after'];

export function createTestConnector(
  destination: Sql | TestDestinationLedger,
  options: { verify?: boolean; fault?: TestFaultCase } = {},
): Connector {
  const ledger = typeof destination === 'function' ? postgresTestLedger(destination) : destination;
  const canVerify = options.verify !== false;
  const configured = options.fault ?? process.env.MELETE_TEST_CONNECTOR_FAULT;
  const fallbackCase: TestFaultCase = isFaultCase(configured) ? configured : 'healthy';
  // Per-action, so a repaired re-execution meets the same destination it met before.
  const executions = new Map<string, number>();
  const refreshed = new Set<string>();
  const caseFor = (action: Action): TestFaultCase => {
    const declared = action.canonical_payload.fault;
    return isFaultCase(declared) ? declared : fallbackCase;
  };
  const raise = (
    kind: ConnectorFaultKind,
    detail: string,
    extra: { may_have_committed?: boolean; retry_after?: number | null } = {},
  ): never => {
    throw new ConnectorFaultError({ kind, detail, ...extra });
  };
  /**
   * Fail the way the named case says to. Returns when the case is satisfied and
   * the send should go through; throws the typed fault otherwise.
   */
  const injectFault = (action: Action, ctx: ConnectorContext): void => {
    const attempts = (executions.get(action.id) ?? 0) + 1;
    executions.set(action.id, attempts);
    const payload = action.canonical_payload;
    switch (caseFor(action)) {
      case 'healthy':
        return;
      case 'transient_before_dispatch':
        if (attempts === 1) raise('transient_before_dispatch', 'the socket closed before the send');
        return;
      case 'persistent_transient':
        raise('transient_before_dispatch', 'the socket closed before the send, again');
        return;
      case 'rate_limited': {
        // The parked job comes back on a new dispatch, so the counter, not the
        // clock, is what says the destination is willing again.
        if (attempts === 1) {
          const asked = payload.retry_after;
          raise('rate_limited', 'the destination asked to be left alone for a while', {
            retry_after: typeof asked === 'number' ? asked : 60,
          });
        }
        return;
      }
      case 'expired_credential':
        if (!refreshed.has(action.id)) raise('expired_credential', 'the access token has expired');
        return;
      case 'revoked_credential':
        raise('revoked_credential', 'the owner revoked this connection');
        return;
      case 'schema_drift':
        // The destination renamed `body` to `content` under a working call.
        if (!('content' in payload)) {
          raise('schema_drift', 'the destination no longer accepts a field named body');
        }
        return;
      case 'unsupported_route':
        if (ctx.repair?.route !== TEST_FALLBACK_ROUTE) {
          raise('unsupported_route', 'this route cannot carry the send and did not try');
        }
        return;
      case 'bad_output':
        raise('bad_output', 'the destination wrote a file that does not pass its own validation');
        return;
      case 'unclassified':
        throw new Error('the destination failed in a way it does not describe');
      default:
        return;
    }
  };
  const manifest: ConnectorManifest = {
    name: 'test',
    version: '0.1.0',
    provider: 'test',
    description: 'A durable test destination with controllable acknowledgement loss.',
    credentials: [],
    health: true,
    tools: [
      {
        name: 'test.send',
        description:
          'Accept a payload once under the action id, optionally dropping the acknowledgement.',
        input_schema: {
          type: 'object',
          properties: { drop_ack: { type: 'boolean' } },
          additionalProperties: true,
        },
        effect_class: 'write_external',
        required_scopes: ['test.send'],
        verify: canVerify,
        requires_approval: true,
      },
    ],
  };
  return {
    manifest,
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      if (action.kind !== 'test.send') throw new Error('unknown test tool');
      if (
        'drop_ack' in action.canonical_payload &&
        typeof action.canonical_payload.drop_ack !== 'boolean'
      ) {
        return { outcome: 'failed', reason: 'drop_ack must be a boolean', retryable: false };
      }
      ctx.signal?.throwIfAborted();
      // Every case that did not commit raises before the ledger is touched, so
      // a repaired retry of one of them cannot leave a second delivery behind.
      injectFault(action, ctx);
      const accepted = await ledger.accept({
        action_id: action.id,
        connection_id: action.connection_id,
        payload_hash: action.payload_hash,
        payload: action.canonical_payload,
        accepted_at: new Date().toISOString(),
      });
      if (
        accepted.payload_hash !== action.payload_hash ||
        accepted.connection_id !== action.connection_id
      ) {
        return {
          outcome: 'failed',
          reason: 'idempotency key was used for different content',
          retryable: false,
        };
      }
      // Throw only after the durable acceptance: the broker must retain unknown.
      const lostCase = caseFor(action);
      if (lostCase === 'lost_ack_verifiable' || lostCase === 'lost_ack_unverifiable') {
        throw new ConnectorFaultError({
          kind: 'uncertain_outcome',
          detail: 'the destination accepted the send and the acknowledgement was lost',
          may_have_committed: true,
        });
      }
      if (action.canonical_payload.drop_ack === true) throw new TestAcknowledgementDropped();
      return { outcome: 'succeeded', receipt: receiptFor(accepted) };
    },
    async describe(action): Promise<ConnectorDescription> {
      // The drifted destination wants `content`; every other case is unchanged.
      const drifted = caseFor(action) === 'schema_drift';
      return {
        required: [drifted ? 'content' : 'body'],
        optional: DRIFT_OPTIONAL,
        // The destination vouches for this one rename and nothing else.
        ...(drifted ? { equivalent_fields: { body: 'content' } } : {}),
        schema: { type: 'object', required: [drifted ? 'content' : 'body'] },
      };
    },
    async refreshCredential(action) {
      if (caseFor(action) === 'revoked_credential') return false;
      refreshed.add(action.id);
      return true;
    },
    async routes(action) {
      return caseFor(action) === 'unsupported_route' ? [TEST_FALLBACK_ROUTE] : [];
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      if (!canVerify)
        return { decision: 'unsupported', reason: 'destination verification is disabled' };
      // The unverifiable case is the honest one: the destination kept the send
      // and cannot say so, and no amount of asking turns that into evidence.
      if (caseFor(action) === 'lost_ack_unverifiable')
        return { decision: 'undecided', reason: 'the destination cannot confirm this send' };
      const accepted = await ledger.find(action.id);
      if (!accepted)
        return { decision: 'undecided', reason: 'destination has no acceptance record yet' };
      if (
        accepted.payload_hash !== action.payload_hash ||
        accepted.connection_id !== action.connection_id
      ) {
        return { decision: 'undecided', reason: 'destination identity does not match this action' };
      }
      return {
        decision: 'succeeded',
        evidence: { action_id: accepted.action_id, payload_hash: accepted.payload_hash },
        receipt: receiptFor(accepted),
      };
    },
    async health() {
      try {
        await ledger.health();
        return {
          status: 'ok',
          detail: 'test destination ledger is readable',
          checked_at: new Date().toISOString(),
        };
      } catch {
        return {
          status: 'failing',
          detail: 'test destination ledger is unavailable',
          checked_at: new Date().toISOString(),
        };
      }
    },
  };
}
