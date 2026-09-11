import { expect, test } from 'bun:test';
import { connectorManifest, dispatchResult, verifyResult } from '@melete/contracts';
import { createTestConnector, memoryTestLedger, TestAcknowledgementDropped } from './test.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

test('test destination accepts once and retry identity returns the same receipt', async () => {
  const ledger = memoryTestLedger();
  const connector = createTestConnector(ledger);
  connectorManifest.parse(connector.manifest);
  const action = connectorAction('test.send', { message: 'hello' });
  const ctx = connectorContext(action);
  const first = dispatchResult.parse(await connector.execute(action, ctx));
  const second = await connector.execute(action, ctx);
  expect(first.outcome).toBe('succeeded');
  if (first.outcome !== 'succeeded' || second.outcome !== 'succeeded')
    throw new Error('expected success');
  expect(first.receipt.external_ref).toBe(action.id);
  expect(first.receipt.detail).toEqual(second.receipt.detail);
  expect((await ledger.find(action.id))?.payload).toEqual({ message: 'hello' });
});

test('destination drops its acknowledgement only after acceptance and verify resolves it', async () => {
  const ledger = memoryTestLedger();
  const connector = createTestConnector(ledger);
  const action = connectorAction('test.send', { message: 'hello', drop_ack: true });
  const ctx = connectorContext(action);
  await expect(connector.execute(action, ctx)).rejects.toBeInstanceOf(TestAcknowledgementDropped);
  expect((await ledger.find(action.id))?.payload_hash).toBe(action.payload_hash);
  const verified = verifyResult.parse(await connector.verify(action, ctx));
  expect(verified.decision).toBe('succeeded');
});

test('verification disabled or missing acceptance never claims the send failed', async () => {
  const ledger = memoryTestLedger();
  const action = connectorAction('test.send', { drop_ack: true });
  const ctx = connectorContext(action);
  const disabled = createTestConnector(ledger, { verify: false });
  expect(disabled.manifest.tools[0]?.verify).toBe(false);
  expect((await disabled.verify(action, ctx)).decision).toBe('unsupported');
  expect((await createTestConnector(ledger).verify(action, ctx)).decision).toBe('undecided');
});

test('idempotency key cannot be reused for another payload or trusted job', async () => {
  const connector = createTestConnector(memoryTestLedger());
  const action = connectorAction('test.send', { message: 'first' });
  const ctx = connectorContext(action);
  await connector.execute(action, ctx);
  const changed = connectorAction('test.send', { message: 'second' });
  expect((await connector.execute(changed, ctx)).outcome).toBe('failed');
  expect((await connector.verify(changed, ctx)).decision).toBe('undecided');
  await expect(connector.execute(action, { ...ctx, job_id: 'job_other' })).rejects.toThrow(
    'identity mismatch',
  );
});
