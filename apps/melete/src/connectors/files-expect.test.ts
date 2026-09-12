/**
 * What `expect` does to a write.
 *
 * Two properties, and the second is the one that is easy to get wrong: a
 * declaration the service cannot read is a bad request, and a bad request must
 * not leave a file on disk. If the expectation were parsed after the write, a
 * malformed check would produce bytes nobody promised anything about and an
 * action whose disposition nobody can decide.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFilesConnector } from './files.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-expect-'));
  await Promise.all([
    mkdir(path.join(root, 'work', 'job_01'), { recursive: true }),
    mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true }),
  ]);
}, 15_000);
afterEach(async () => {
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`) ||
    !path.basename(root).startsWith('melete-expect-')
  ) {
    throw new Error('refusing fixture cleanup outside the temp root');
  }
  await rm(resolved, { recursive: true, force: true });
}, 15_000);

const connector = () =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
  });
const write = async (payload: Record<string, unknown>) => {
  const action = connectorAction('files.write', payload);
  return connector().execute(action, connectorContext(action));
};
const exists = async (relative: string) => {
  try {
    await access(path.join(root, 'work', 'job_01', relative));
    return true;
  } catch {
    return false;
  }
};

test('a declared write carries its checks and its artifact on the receipt', async () => {
  const result = await write({
    path: 'report.csv',
    content: 'item,amount\nDesk,60\nChair,40\nTotal,100\n',
    expect: {
      kind: 'csv',
      checks: [{ kind: 'totals', column: 'amount', total_label: 'Total' }],
    },
    evidence: ['act_01J00000000000000000000000'],
  });
  if (result.outcome !== 'succeeded') throw new Error(`expected a receipt, got ${result.outcome}`);
  const detail = result.receipt.detail as Record<string, unknown>;
  expect(detail.artifact).toMatchObject({ kind: 'csv', area: 'work', path: 'report.csv' });
  expect((detail.artifact as Record<string, unknown>).evidence).toEqual([
    'act_01J00000000000000000000000',
  ]);
  const validations = detail.validations as Array<{ name: string; status: string }>;
  expect(validations.map((v) => v.name).sort()).toEqual([
    'csv.parses',
    'render:csv',
    'totals:amount',
  ]);
  expect(validations.every((v) => v.status === 'passed')).toBe(true);
});

test('an undeclared write is a scratch file with no artifact on the receipt', async () => {
  const result = await write({ path: 'scratch.txt', content: 'notes' });
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  expect((result.receipt.detail as Record<string, unknown>).artifact).toBeUndefined();
  expect((result.receipt.detail as Record<string, unknown>).validations).toBeUndefined();
});

test('a declaration the service cannot read leaves no file behind', async () => {
  // `totals` without a column, which the JSON Schema layer lets through because
  // it only says a check is an object, and the expectation parser refuses.
  await expect(
    write({
      path: 'broken.csv',
      content: 'item,amount\nDesk,60\n',
      expect: { kind: 'csv', checks: [{ kind: 'totals' }] },
    }),
  ).rejects.toThrow();
  expect(await exists('broken.csv')).toBe(false);

  await expect(
    write({ path: 'unknown-kind.csv', content: 'a,b\n1,2\n', expect: { kind: 'spreadsheet' } }),
  ).rejects.toThrow();
  expect(await exists('unknown-kind.csv')).toBe(false);
});

test('a failing check still writes the file and records the failure', async () => {
  // The write is not the thing that failed; the promise about it is. The bytes
  // stay so the next attempt can fix them, and the gate is what refuses to
  // call the job done.
  const result = await write({
    path: 'wrong.csv',
    content: 'item,amount\nDesk,60\nChair,31.5\nTotal,100\n',
    expect: {
      kind: 'csv',
      checks: [{ kind: 'totals', column: 'amount', total_label: 'Total' }],
    },
  });
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  expect(await exists('wrong.csv')).toBe(true);
  const validations = (result.receipt.detail as Record<string, unknown>).validations as Array<{
    name: string;
    status: string;
    detail: string;
  }>;
  const totals = validations.find((v) => v.name === 'totals:amount');
  expect(totals?.status).toBe('failed');
  expect(totals?.detail).toContain('91.5');
});
