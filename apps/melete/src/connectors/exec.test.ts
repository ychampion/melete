import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ConnectorTool, connectorManifest } from '@melete/contracts';
import { createExecConnector, execManifest } from './exec.ts';
import { ConnectorRegistry } from './registry.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';
import type { Connector } from './types.ts';

let root: string;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-exec-'));
  await Promise.all([
    mkdir(path.join(root, 'work', 'job_01', '.melete', 'exec'), { recursive: true }),
    mkdir(path.join(root, 'work', 'job_other'), { recursive: true }),
    mkdir(path.join(root, 'outside'), { recursive: true }),
  ]);
}, 15_000);
afterEach(async () => {
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`) ||
    !path.basename(root).startsWith('melete-exec-')
  ) {
    throw new Error('refusing fixture cleanup outside the temp root');
  }
  await rm(resolved, { recursive: true, force: true });
}, 15_000);

const connector = () => createExecConnector({ workRoot: path.join(root, 'work') });
const record = (over: Record<string, unknown> = {}) => ({
  language: 'python',
  command: 'print(1)',
  cwd: '.',
  exit_code: 0,
  signal: null,
  timed_out: false,
  duration_ms: 12,
  output_digest: digest(''),
  output_bytes: 0,
  truncated: false,
  output_path: null,
  ...over,
});
const run = async (payload: Record<string, unknown>) => {
  const action = connectorAction('exec.run', payload);
  return connector().execute(action, connectorContext(action));
};

test('the exec manifest parses and declares in-cell execution with a record schema', () => {
  connectorManifest.parse(execManifest);
  for (const tool of execManifest.tools) {
    expect(tool.execution).toBe('in_cell');
    expect(tool.record_schema).toBeTruthy();
    expect(tool.effect_class).toBe('write_reversible');
    expect(tool.requires_approval).toBe(false);
  }
});

test('an ordinary execution is recorded, and says the digest was not re-read', async () => {
  const result = await run(record({ output_bytes: 3, output_digest: digest('ok\n') }));
  if (result.outcome !== 'succeeded') throw new Error(`expected a receipt, got ${result.outcome}`);
  expect(result.receipt.detail).toMatchObject({
    cwd: '.',
    exit_code: 0,
    digest_verified: false,
  });
  expect(result.receipt.external_ref).toBe(digest('ok\n'));
});

test('a stored output is re-hashed, and a mismatch is refused', async () => {
  const content = 'a lot of output\n';
  await writeFile(path.join(root, 'work', 'job_01', '.melete', 'exec', 'out.log'), content);
  const good = await run(
    record({
      truncated: true,
      output_path: '.melete/exec/out.log',
      output_bytes: content.length,
      output_digest: digest(content),
    }),
  );
  if (good.outcome !== 'succeeded') throw new Error('expected the stored output to verify');
  expect(good.receipt.detail.digest_verified).toBe(true);

  const bad = await run(
    record({
      truncated: true,
      output_path: '.melete/exec/out.log',
      output_bytes: content.length,
      output_digest: digest('something else'),
    }),
  );
  expect(bad.outcome).toBe('failed');
  if (bad.outcome !== 'failed') throw new Error('unreachable');
  expect(bad.reason).toContain('does not hash to the recorded digest');
});

test('a stored output is declared as an artifact of this job', async () => {
  const content = `line after line of output${String.fromCharCode(10)}`.repeat(40);
  await writeFile(path.join(root, 'work', 'job_01', '.melete', 'exec', 'big.log'), content);
  const result = await run(
    record({
      truncated: true,
      output_path: '.melete/exec/big.log',
      output_bytes: content.length,
      output_digest: digest(content),
    }),
  );
  if (result.outcome !== 'succeeded') throw new Error('expected the stored output to verify');
  const detail = result.receipt.detail as Record<string, unknown>;
  // The handle a later attempt cites and a person can publish, made from the
  // bytes on disk rather than from anything the cell claimed about them.
  expect(detail.artifact).toMatchObject({
    area: 'work',
    path: '.melete/exec/big.log',
    kind: 'text',
    size: content.length,
    content_hash: digest(content),
  });
  expect(detail.expectation).toMatchObject({ kind: 'text', render: false, human: false });
  const validations = detail.validations as Array<{ name: string; status: string }>;
  expect(validations.map((v) => v.name)).toEqual(['text.parses']);
  expect(validations[0]?.status).toBe('passed');
});

test('an execution that stored nothing declares no artifact', async () => {
  const result = await run(
    record({ output_bytes: 3, output_digest: digest(`ok${String.fromCharCode(10)}`) }),
  );
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  expect((result.receipt.detail as Record<string, unknown>).artifact).toBeUndefined();
});

test('a working directory outside this job is refused at the ledger', async () => {
  for (const cwd of ['../job_other', '../../outside', '/etc', 'C:\\Windows', 'a/../../job_other']) {
    const refused = await run(record({ cwd }));
    expect(refused.outcome).toBe('failed');
    if (refused.outcome !== 'failed') throw new Error('unreachable');
    expect(refused.reason).toContain('outside this job workspace');
  }
});

test('a stored output path outside this job is refused', async () => {
  await writeFile(path.join(root, 'work', 'job_other', 'stolen.log'), 'x');
  const refused = await run(
    record({ truncated: true, output_path: '../job_other/stolen.log', output_digest: digest('x') }),
  );
  expect(refused.outcome).toBe('failed');
  if (refused.outcome !== 'failed') throw new Error('unreachable');
  expect(refused.reason).toContain('outside this job workspace');
});

test('a symbolic link planted in the workspace does not widen the next execution', async () => {
  const link = path.join(root, 'work', 'job_01', 'escape');
  try {
    await symlink(path.join(root, 'outside'), link, 'junction');
  } catch {
    return; // unprivileged Windows cannot create links; the guard is tested above
  }
  await writeFile(path.join(root, 'outside', 'note.log'), 'x');
  const refused = await run(
    record({ truncated: true, output_path: 'escape/note.log', output_digest: digest('x') }),
  );
  expect(refused.outcome).toBe('failed');
});

test('a duration past the cell time cap is not a credible record', async () => {
  const refused = await run(record({ duration_ms: 600_000 }));
  expect(refused.outcome).toBe('failed');
  if (refused.outcome !== 'failed') throw new Error('unreachable');
  expect(refused.reason).toContain('time cap');
});

test('an execution that stored nothing cannot be verified after an unknown dispatch', async () => {
  const action = connectorAction('exec.run', record());
  const decision = await connector().verify(action, connectorContext(action));
  expect(decision.decision).toBe('undecided');
});

test('a record the schema does not allow never reaches a receipt', async () => {
  const refused = await run(record({ output_digest: 'not-a-digest' }));
  expect(refused.outcome).toBe('failed');
});

test('an in-cell tool that requires approval is refused at registration', () => {
  const registry = () => new ConnectorRegistry();
  const withTool = (over: Partial<ConnectorTool>): Connector => ({
    ...createExecConnector({ workRoot: path.join(root, 'work') }),
    manifest: {
      ...execManifest,
      tools: [{ ...(execManifest.tools[0] as ConnectorTool), ...over }],
    },
  });
  // Approval is a gate in front of an effect, and there is no gate in front of
  // something that is over by the time the broker reads the record.
  expect(() => registry().register('conn_01', withTool({ requires_approval: true }))).toThrow(
    'cannot also require approval',
  );
  expect(() =>
    registry().register('conn_01', withTool({ effect_class: 'write_external' })),
  ).toThrow('cannot also require approval');
  // And a record the broker has no schema for cannot be validated at all.
  expect(() => registry().register('conn_01', withTool({ record_schema: null }))).toThrow(
    'declares no record schema',
  );
  // The shipped manifest registers, which is what makes the three above a
  // statement about the rule and not about the fixture.
  expect(() =>
    registry().register('conn_01', createExecConnector({ workRoot: path.join(root, 'work') })),
  ).not.toThrow();
});
