import type { Action, ConnectorManifest, JsonValue, Receipt } from '@melete/contracts';
import type { Sql } from 'postgres';
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

export function createTestConnector(
  destination: Sql | TestDestinationLedger,
  options: { verify?: boolean } = {},
): Connector {
  const ledger = typeof destination === 'function' ? postgresTestLedger(destination) : destination;
  const canVerify = options.verify !== false;
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
      if (action.canonical_payload.drop_ack === true) throw new TestAcknowledgementDropped();
      return { outcome: 'succeeded', receipt: receiptFor(accepted) };
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      if (!canVerify)
        return { decision: 'unsupported', reason: 'destination verification is disabled' };
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
