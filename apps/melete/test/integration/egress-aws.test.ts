/**
 * A connected AWS account end to end, against Postgres: requests signed with
 * the placeholder key, as the aws command line signs them, go through the
 * real relay with the AWS adapter; the relay signs them again with a session
 * of the role it assumed for the command, and every change is brought to the
 * real broker, which asks the person with the exact change, admits it once,
 * and keeps a receipt.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { type AddressInfo, connect } from 'node:net';
import { egressAdmission } from '../../src/broker/egress-admission.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService, EGRESS_RERUN } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import {
  AWS_KEY_PLACEHOLDER,
  AWS_SECRET_PLACEHOLDER,
  createAwsAdapter,
} from '../../src/egress/adapters/aws.ts';
import type { CredentialAdapter, CredentialAdapterId } from '../../src/egress/adapters/types.ts';
import { awsSecret } from '../../src/egress/aws-session.ts';
import { EgressCertificateAuthority, postgresEgressCaStore } from '../../src/egress/ca.ts';
import { createCommandLineConnector } from '../../src/egress/connector.ts';
import { postgresEgressCredentials } from '../../src/egress/credentials.ts';
import { fixtureUpstream, rawRequest, throughRelay } from '../../src/egress/fixtures.ts';
import { signRequest } from '../../src/egress/sigv4.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { resolveExperienceGrant } from '../../src/experience/rules.ts';
import { selfSignedPair } from '../../src/gateway/fixtures/self-signed.ts';
import { SandboxEgressGuard } from '../../src/sandbox/adapters/docker-egress.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const withDb = db ? describe : describe.skip;
const REGION = 'eu-west-1';
const HOST = `reports.s3.${REGION}.amazonaws.com`;
const KEY = {
  access_key_id: 'AKIAINTEGRATION00001',
  secret_access_key: `int/${randomBytes(18)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, 'x')}`,
};
const ROLE = 'arn:aws:iam::123456789012:role/agent';

const s3 = await fixtureUpstream(
  HOST,
  (request): { status?: number; body: string; headers: Record<string, string> } =>
    request.method === 'DELETE'
      ? {
          status: 204,
          body: '',
          headers: { 'x-amz-request-id': 'REQ123', 'x-amz-delete-marker': 'true' },
        }
      : {
          body: '<ListBucketResult><Contents><Key>2026.csv</Key></Contents></ListBucketResult>',
          headers: { 'content-type': 'application/xml' },
        },
);
/** STS: the role session it hands out names the session it was asked for. */
const sessions: string[] = [];
const stsPair = selfSignedPair(`sts.${REGION}.amazonaws.com`);
const sts = createServer({ key: stsPair.key, cert: stsPair.cert }, (request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    sessions.push(form.get('RoleSessionName') ?? '');
    response.writeHead(200, { 'content-type': 'text/xml' });
    response.end(
      `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIASESSION${sessions.length.toString().padStart(9, '0')}</AccessKeyId><SecretAccessKey>sessionSecret${sessions.length}xxxxxxxxxxxx</SecretAccessKey><SessionToken>sessionToken${sessions.length}</SessionToken><Expiration>${new Date(Date.now() + 900_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
    );
  });
});
await new Promise<void>((resolve) => sts.listen(0, '127.0.0.1', resolve));
afterAll(async () => {
  await s3.close();
  sts.close();
  await db?.close();
}, 15_000);
const guards: SandboxEgressGuard[] = [];
afterAll(async () => {
  for (const guard of guards) await guard.close();
});

/** A request as the aws command line sends it: signed with the placeholder, with its own request id. */
async function cliRequest(method: string, path: string, query = '') {
  const headers = await signRequest({
    method,
    host: HOST,
    path,
    query,
    headers: {
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'amz-sdk-invocation-id': randomUUID(),
      'amz-sdk-request': 'attempt=1; max=3',
      'user-agent': 'aws-cli/2.31.0',
    },
    body: Buffer.alloc(0),
    region: REGION,
    service: 's3',
    credentials: { accessKeyId: AWS_KEY_PLACEHOLDER, secretAccessKey: AWS_SECRET_PLACEHOLDER },
  });
  const { host: _host, ...rest } = headers;
  return rawRequest(method, HOST, `${path}${query ? `?${query}` : ''}`, { headers: rest });
}

async function setup() {
  if (!db) throw new Error('Postgres is unavailable');
  const { sql } = db;
  const { claims, connectionId } = await seedJob(sql, {
    provider: 'command_line',
    scopes: ['egress.aws_read', 'egress.aws_write'],
  });
  const masterKey = randomBytes(32).toString('hex');
  const secrets = new SealedSecretStore(new PostgresSecretRepository(sql), () => masterKey);
  const secretId = await secrets.put(claims.space_id, awsSecret(KEY));
  await sql`update connection set secret_ref = ${secretId},
    configuration = ${JSON.stringify({
      kind: 'command_line',
      adapter: 'aws',
      config: { region: REGION, role_arn: ROLE },
      account: 'arn:aws:sts::123456789012:assumed-role/agent/melete-check',
    })}::jsonb
    where id = ${connectionId}`;
  const registry = new ConnectorRegistry().register(
    connectionId,
    createCommandLineConnector('aws'),
  );
  const broker = new BrokerService({
    sql,
    connectors: registry,
    resolveStandingGrant: resolveExperienceGrant,
  });
  const permissions = new ExperiencePermissions(
    sql,
    broker,
    new ExperienceEffects(sql, broker, registry),
  );
  const adapter = createAwsAdapter({
    sts: {
      ca: stsPair.cert.toString(),
      route: () => ({
        address: { address: '127.0.0.1', family: 4 },
        port: (sts.address() as AddressInfo).port,
      }),
    },
  }) as CredentialAdapter;
  const ca = new EgressCertificateAuthority({
    store: postgresEgressCaStore(sql),
    sealer: secrets,
    constraints: adapter.constraints,
  });
  const credentials = postgresEgressCredentials({
    sql,
    secrets,
    adapters: new Map<CredentialAdapterId, CredentialAdapter>([['aws', adapter]]),
    ca,
    admission: egressAdmission(broker, { pollMs: 50 }),
  });
  const guard = new SandboxEgressGuard({
    resolve: async () => [{ address: '52.92.0.10', family: 4 }],
    dial: () => connect(s3.port, '127.0.0.1'),
    credentials,
    intercept: {
      upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: s3.port }),
      upstreamCa: s3.ca,
      approvalHoldSeconds: 0,
    },
  });
  guards.push(guard);
  const relayPort = await guard.listen(0, '127.0.0.1');
  const sandbox = `melete-sbx-${recordId('sbx').toLowerCase()}`;
  guard.allow('127.0.0.1', sandbox, { mode: 'open', session: 'sbx_one', space: claims.space_id });
  const caPem = (await ca.certificate()).pem;
  const send = async (requests: string[], command: string, attemptId = claims.attempt_id) =>
    throughRelay({
      relayPort,
      host: HOST,
      ca: caPem,
      token: guard.mint(sandbox, {
        kind: 'command',
        sessionId: 'sbx_one',
        jobId: claims.job_id,
        attemptId,
        actionId: command,
        deadlineAt: Date.now() + 120_000,
      }),
      requests,
    });
  const actions = async () =>
    sql`select * from action where job_id = ${claims.job_id}
      and kind = 'egress.aws_write' order by created_at`;
  const card = async () => (await permissions.list(claims.space_id)).permissions.at(-1);
  return { sql, claims, broker, send, actions, card };
}

withDb('AWS from the agent’s computer', () => {
  test('an S3 delete asks with its bucket and key, and a re-run after approval deletes once', async () => {
    const s = await setup();
    // A listing is a read: signed with the command's role session, nothing asks.
    const [listed] = await s.send([await cliRequest('GET', '/', 'list-type=2')], 'act_cmd_one');
    expect(listed?.status).toBe(200);
    expect(sessions).toEqual(['melete-act_cmd_one']);
    expect(String(s3.seen[0]?.headers.authorization)).toContain('Credential=ASIASESSION000000001/');
    expect(s3.seen[0]?.headers['x-amz-security-token']).toBe('sessionToken1');

    const first = await s.send([await cliRequest('DELETE', '/2026.csv')], 'act_cmd_one');
    // aws is told in its own error shape, and nothing was deleted.
    expect(first[0]?.status).toBe(403);
    expect(first[0]?.body).toContain('<Code>ApprovalRequired</Code>');
    expect(first[0]?.body).toContain(
      'Waiting for your approval in Melete: s3:DeleteObject on reports/2026.csv',
    );
    expect(s3.seen.filter((request) => request.method === 'DELETE')).toEqual([]);
    const [row] = await s.actions();
    if (!row) throw new Error('no action');
    expect(row.status).toBe('needs_approval');
    expect(row.canonical_payload).toMatchObject({
      operation: 'DeleteObject',
      resource: 'reports/2026.csv',
      service: 's3',
      region: REGION,
      destructive: true,
      summary: { title: 's3:DeleteObject on reports/2026.csv' },
    });
    const card = await s.card();
    expect(card?.what).toBe('s3:DeleteObject on reports/2026.csv');
    // No standing rule covers an AWS change: every one asks.
    expect(card?.options).not.toContain('always');
    await s.broker.decide(row.id, { decision: 'approved', payload_hash: row.payload_hash });
    const next = recordId('att');
    await s.sql`update attempt set outcome = 'completed', ended_at = now() where id = ${s.claims.attempt_id}`;
    await s.sql`update job set lease_epoch = 2, state = 'running' where id = ${s.claims.job_id}`;
    await s.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${next}, ${s.claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
    const resumed = await s.broker.resume({ ...s.claims, attempt_id: next, epoch: 2 }, row.id);
    expect(resumed.message).toBe(EGRESS_RERUN);
    // The command runs again: a new signing date and request id, the same change.
    const second = await s.send([await cliRequest('DELETE', '/2026.csv')], 'act_cmd_two', next);
    expect(second[0]?.status).toBe(204);
    const deleted = s3.seen.filter((request) => request.method === 'DELETE');
    expect(deleted).toHaveLength(1);
    // Signed with the session of the command that ran it.
    expect(sessions).toEqual(['melete-act_cmd_one', 'melete-act_cmd_two']);
    expect(deleted[0]?.headers['x-amz-security-token']).toBe('sessionToken2');
    const [done] = await s.actions();
    expect(done?.id).toBe(row.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.receipt?.detail).toMatchObject({
      service: 's3',
      resource: 'reports/2026.csv',
      request_id: 'REQ123',
      status: 204,
    });
    // A third run is answered from the record and deletes nothing more.
    const third = await s.send([await cliRequest('DELETE', '/2026.csv')], 'act_cmd_three', next);
    expect(third[0]?.status).not.toBe(204);
    expect(s3.seen.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    const stored = JSON.stringify(await s.actions());
    expect(stored).not.toContain(KEY.secret_access_key);
    expect(stored).not.toContain('sessionSecret');
  }, 30_000);
});
