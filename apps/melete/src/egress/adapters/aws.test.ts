/**
 * AWS for the agent's computer: what the classifier makes of every request
 * the AWS SDK builds, the signature the relay makes in its place, the
 * refusals, and the role session the service assumes for each command.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { selfSignedPair } from '../../gateway/fixtures/self-signed.ts';
import { SandboxEgressGuard } from '../../sandbox/adapters/docker-egress.ts';
import { awsSecret, sessionNameFor } from '../aws-session.ts';
import { fixtureUpstream, memoryCredentialPort, rawRequest, throughRelay } from '../fixtures.ts';
import { requestBinding, upstreamHeaders, VOLATILE_HEADERS } from '../intercept.ts';
import { parseSigV4Authorization, signRequest } from '../sigv4.ts';
import {
  AWS_KEY_PLACEHOLDER,
  AWS_SECRET_PLACEHOLDER,
  AWS_VOLATILE_HEADERS,
  awsAdapter,
  createAwsAdapter,
  MAX_UPLOAD_PARTS,
  Uploads,
} from './aws.ts';
import type { ClassifiedWrite, CredentialAdapter, InterceptedRequest } from './types.ts';

type Recorded = {
  name: string;
  expect: string;
  method: string;
  host: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  fixed: { authorization: string; 'x-amz-date': string; body?: string };
};
const corpus = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'fixtures', 'aws', 'sdk-requests.json'), 'utf8'),
) as { requests: Recorded[] };

const REGION = 'eu-west-1';
const config = awsAdapter.parseConfig({ region: REGION });
const KEY = {
  access_key_id: 'AKIAREALACCOUNTKEY01',
  secret_access_key: 'real/Secret+Key0123456789abcdefABCDEF',
};
const SECRET = awsSecret(KEY);

/** A recorded request as the relay hands it to the adapter. */
function intercepted(recorded: Recorded): InterceptedRequest {
  const { authorization, ...rest } = recorded.headers;
  return {
    host: recorded.host,
    method: recorded.method,
    path: recorded.path,
    query: recorded.query,
    headers: upstreamHeaders(rest, [AWS_KEY_PLACEHOLDER, AWS_SECRET_PLACEHOLDER]),
    body: Buffer.from(recorded.body, 'utf8'),
    ...(authorization ? { authorization } : {}),
  };
}

/** A request signed the way a command in the computer signs it: with the placeholder. */
async function placeholderSigned(input: {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string;
  service: string;
  key?: string;
  token?: string;
  now?: Date;
}) {
  const headers = await signRequest({
    method: input.method,
    host: input.host,
    path: input.path,
    query: input.query ?? '',
    headers: input.headers ?? {},
    body: Buffer.from(input.body ?? ''),
    region: REGION,
    service: input.service,
    credentials: {
      accessKeyId: input.key ?? AWS_KEY_PLACEHOLDER,
      secretAccessKey: AWS_SECRET_PLACEHOLDER,
      ...(input.token ? { sessionToken: input.token } : {}),
    },
    ...(input.now ? { now: input.now } : {}),
  });
  const { host: _host, ...rest } = headers;
  return rest;
}

type Probe = {
  method: string;
  host: string;
  service: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** A request signed with the placeholder, as the relay hands it to the adapter. */
async function probe(input: Probe): Promise<InterceptedRequest> {
  const signed = await placeholderSigned({
    method: input.method,
    host: input.host,
    path: input.path,
    query: input.query ?? '',
    service: input.service,
    headers: input.headers ?? {},
    body: input.body ?? '',
  });
  const { authorization, ...headers } = signed;
  return {
    host: input.host,
    method: input.method,
    path: input.path,
    query: input.query ?? '',
    headers,
    body: Buffer.from(input.body ?? ''),
    ...(authorization ? { authorization } : {}),
  };
}

describe('what each request the AWS SDK builds does', () => {
  test('list and describe calls are reads, and delete and run calls ask', () => {
    const seen: string[] = [];
    for (const recorded of corpus.requests) {
      const verdict = awsAdapter.classify(intercepted(recorded), config);
      const [kind, operation, destructive] = recorded.expect.split(' ');
      const got =
        verdict.kind === 'write'
          ? [
              'write',
              operation?.startsWith('POST') || operation?.startsWith('DELETE')
                ? verdict.operation.split(' ')[0]
                : verdict.operation,
              verdict.destructive ? 'destructive' : undefined,
            ]
          : [verdict.kind];
      const want = kind === 'write' ? ['write', operation, destructive] : [kind];
      if (JSON.stringify(got) !== JSON.stringify(want))
        seen.push(`${recorded.name}: ${JSON.stringify(got)} expected ${JSON.stringify(want)}`);
    }
    expect(seen).toEqual([]);
    expect(corpus.requests.length).toBeGreaterThanOrEqual(60);
  });

  test('a card names the operation and what it touches', () => {
    const find = (name: string) => {
      const recorded = corpus.requests.find((each) => each.name === name);
      if (!recorded) throw new Error(name);
      const verdict = awsAdapter.classify(intercepted(recorded), config);
      if (verdict.kind !== 'write') throw new Error(`${name} is not a write`);
      return verdict;
    };
    expect(find('s3 delete object').summary.title).toBe(
      's3:DeleteObject on reports/reports/2026.csv',
    );
    expect(find('s3 delete a version').summary.facts).toContainEqual({
      label: 'Version',
      value: 'v2',
    });
    expect(find('s3 delete objects').summary.facts).toContainEqual({
      label: 'Objects',
      value: '2 objects:\na.csv\nb.csv',
    });
    expect(find('s3 copy object').summary.facts).toContainEqual({
      label: 'Copied from',
      value: 'reports/2026.csv',
    });
    const run = find('ec2 run instances');
    expect(run.summary.title).toBe('ec2:RunInstances in eu-west-1');
    expect(run.summary.facts).toContainEqual({ label: 'Cost', value: 'This may cost money.' });
    expect(run.summary.facts.find((fact) => fact.label === 'Details')?.value).toContain(
      'InstanceType=t3.micro',
    );
    // An upload's chunked framing is taken off for showing; the approval binds the bytes as sent.
    const put = find('s3 put object');
    expect(put.summary.facts.find((fact) => fact.label === 'Details')?.value).toBe('month,total\n');
    expect(find('secretsmanager get secret value').summary.facts).toContainEqual({
      label: 'Reads a secret',
      value: 'The answer holds a stored secret.',
    });
  });

  test('an operation name a service does not read is never believed', async () => {
    const verdict = async (input: Probe) => awsAdapter.classify(await probe(input), config);
    // REST services route by method and path; an Action or a target they ignore is refused.
    for (const named of [
      {
        method: 'DELETE',
        host: 'lambda.eu-west-1.amazonaws.com',
        service: 'lambda',
        path: '/2015-03-31/functions/prod',
        query: 'Action=GetFunction',
      },
      {
        method: 'POST',
        host: 'lambda.eu-west-1.amazonaws.com',
        service: 'lambda',
        path: '/2015-03-31/functions/prod/invocations',
        headers: { 'x-amz-target': 'X.GetFunction' },
      },
      {
        method: 'POST',
        host: 'route53.amazonaws.com',
        service: 'route53',
        path: '/2013-04-01/hostedzone/Z1/rrset/',
        query: 'Action=ListHostedZones',
      },
      {
        method: 'DELETE',
        host: 'eks.eu-west-1.amazonaws.com',
        service: 'eks',
        path: '/clusters/prod',
        query: 'Action=DescribeCluster',
      },
      // Two targets joined into one header, or a target of another service.
      {
        method: 'POST',
        host: 'dynamodb.eu-west-1.amazonaws.com',
        service: 'dynamodb',
        path: '/',
        headers: {
          'x-amz-target': 'DynamoDB_20120810.DeleteTable, DynamoDB_20120810.GetItem',
          'content-type': 'application/x-amz-json-1.0',
        },
        body: '{}',
      },
      {
        method: 'POST',
        host: 'dynamodb.eu-west-1.amazonaws.com',
        service: 'dynamodb',
        path: '/',
        headers: { 'x-amz-target': 'Logs_20140328.DescribeLogGroups' },
        body: '{}',
      },
      // A query service reads its body as a form whatever it is labelled.
      {
        method: 'POST',
        host: 'iam.amazonaws.com',
        service: 'iam',
        path: '/',
        query: 'Action=ListUsers&Version=2010-05-08',
        headers: { 'content-type': 'text/plain' },
        body: 'Action=DeleteUser&UserName=alice',
      },
    ] as Probe[])
      expect([named.method, named.path, (await verdict(named)).kind]).toEqual([
        named.method,
        named.path,
        'refuse',
      ]);
    // REST writes are changes by their method, whatever their path says.
    expect(
      await verdict({
        method: 'POST',
        host: 'lambda.eu-west-1.amazonaws.com',
        service: 'lambda',
        path: '/2015-03-31/functions/prod/invocations',
        body: '{}',
      }),
    ).toMatchObject({ kind: 'write', operation: 'POST /2015-03-31/functions/prod/invocations' });
    // A service the SDK's definitions do not know asks for everything, even a GET.
    expect(
      await verdict({
        method: 'GET',
        host: 'madeup.eu-west-1.amazonaws.com',
        service: 'madeup',
        path: '/',
      }),
    ).toMatchObject({ kind: 'write' });
    // Where one host serves two APIs, the request is read by the one its shape names.
    expect(
      await verdict({
        method: 'POST',
        host: 'email.eu-west-1.amazonaws.com',
        service: 'ses',
        path: '/',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'Action=GetSendQuota&Version=2010-12-01',
      }),
    ).toEqual({ kind: 'read' });
  });

  test('an operation that hands out credentials is refused, and one that may hand one back asks', async () => {
    const verdict = async (input: Probe) => awsAdapter.classify(await probe(input), config);
    const json = (host: string, service: string, target: string): Probe => ({
      method: 'POST',
      host,
      service,
      path: '/',
      headers: { 'x-amz-target': target, 'content-type': 'application/x-amz-json-1.1' },
      body: '{}',
    });
    for (const minted of [
      json(
        'elasticmapreduce.eu-west-1.amazonaws.com',
        'elasticmapreduce',
        'ElasticMapReduce.GetClusterSessionCredentials',
      ),
      json(
        'api.sagemaker.eu-west-1.amazonaws.com',
        'sagemaker',
        'SageMaker.CreatePresignedDomainUrl',
      ),
      json('gamelift.eu-west-1.amazonaws.com', 'gamelift', 'GameLift.GetComputeAccess'),
      json('gamelift.eu-west-1.amazonaws.com', 'gamelift', 'GameLift.GetInstanceAccess'),
      {
        method: 'POST',
        host: 'lakeformation.eu-west-1.amazonaws.com',
        service: 'lakeformation',
        path: '/GetTemporaryGlueTableCredentials',
        body: '{}',
      },
      {
        method: 'POST',
        host: 'oidc.eu-west-1.amazonaws.com',
        service: 'sso-oauth',
        path: '/token',
        body: '{}',
      },
      {
        method: 'GET',
        host: 'deadline.eu-west-1.amazonaws.com',
        service: 'deadline',
        path: '/2023-10-12/farms/f1/queues/q1/user-roles',
      },
      {
        method: 'GET',
        host: 'portal.sso.eu-west-1.amazonaws.com',
        service: 'awsssoportal',
        path: '/federation/credentials',
        query: 'account_id=1&role_name=r',
      },
    ] as Probe[])
      expect([minted.path, minted.headers?.['x-amz-target'], await verdict(minted)]).toEqual([
        minted.path,
        minted.headers?.['x-amz-target'],
        { kind: 'refuse', reason: expect.stringContaining('hands out credentials') },
      ]);
    // Ones whose answer may carry a credential ask, with a warning, and their answer is checked.
    for (const asks of [
      json('gamelift.eu-west-1.amazonaws.com', 'gamelift', 'GameLift.RequestUploadCredentials'),
      {
        method: 'POST',
        host: 'oidc.eu-west-1.amazonaws.com',
        service: 'sso-oauth',
        path: '/token',
        query: 'aws_iam=t',
        body: '{}',
      },
      {
        method: 'POST',
        host: 'ec2.eu-west-1.amazonaws.com',
        service: 'ec2',
        path: '/',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'Action=CreateKeyPair&KeyName=k&Version=2016-11-15',
      },
      {
        method: 'POST',
        host: 'iam.amazonaws.com',
        service: 'iam',
        path: '/',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'Action=GetAccountPasswordPolicy&Version=2010-05-08',
      },
    ] as Probe[]) {
      const got = await verdict(asks);
      expect(got.kind).toBe('write');
      expect(got.kind === 'write' && got.summary.facts.map((fact) => fact.label)).toContain(
        'Credentials',
      );
    }
    // Even a read by name that only mentions credentials asks; an ordinary read does not.
    const report = {
      method: 'POST',
      host: 'iam.amazonaws.com',
      service: 'iam',
      path: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Action=GetCredentialReport&Version=2010-05-08',
    };
    expect(await verdict(report)).toMatchObject({ kind: 'write', destructive: false });
    expect(await verdict({ ...report, body: 'Action=ListUsers&Version=2010-05-08' })).toEqual({
      kind: 'read',
    });
  });

  test('an answer holding a credential is kept from the computer, whatever asked for it', async () => {
    const request = await probe({
      method: 'POST',
      host: 'gamelift.eu-west-1.amazonaws.com',
      service: 'gamelift',
      path: '/',
      headers: { 'x-amz-target': 'GameLift.DescribeFleetAttributes' },
      body: '{}',
    });
    const check = awsAdapter.answerCheck?.(request, config);
    if (!check) throw new Error('no check');
    const answer = (body: string) => check({ status: 200, headers: {}, body: Buffer.from(body) });
    expect(
      answer('{"Credentials":{"AccessKeyId":"ASIA1","SecretAccessKey":"x","SessionToken":"y"}}'),
    ).toBe('an AWS secret access key');
    expect(answer('<Credentials><SessionToken>y</SessionToken></Credentials>')).toBe(
      'a session token',
    );
    expect(answer('{"KeyMaterial":"-----BEGIN RSA PRIVATE KEY-----\\nMIIE"}')).toBe(
      'a private key',
    );
    expect(answer('{"Credentials":{"UserName":"gl-user","Secret":"s3cr3t"}}')).toBe('a secret');
    expect(answer('{"FleetAttributes":[]}')).toBeNull();
    // A started Systems Manager session answers with a token that opens it.
    expect(
      answer(
        '{"SessionId":"s-1","StreamUrl":"wss://ssmmessages.eu-west-1.amazonaws.com/v1/data-channel/s-1","TokenValue":"AAEAAx"}',
      ),
    ).toBe('a session token');
    // The person's own S3 objects, and an unsigned request that carried no account, are not checked.
    const object = await probe({
      method: 'GET',
      host: 'reports.s3.eu-west-1.amazonaws.com',
      service: 's3',
      path: '/aws-credentials.txt',
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    });
    expect(awsAdapter.answerCheck?.(object, config)).toBeNull();
  });

  test('reads that return stored secrets ask', async () => {
    const verdict = async (input: Probe) => awsAdapter.classify(await probe(input), config);
    const json = (host: string, service: string, target: string, body = '{}'): Probe => ({
      method: 'POST',
      host,
      service,
      path: '/',
      headers: { 'x-amz-target': target, 'content-type': 'application/x-amz-json-1.1' },
      body,
    });
    expect(
      await verdict(
        json(
          'ssm.eu-west-1.amazonaws.com',
          'ssm',
          'AmazonSSM.GetParameterHistory',
          '{"Name":"/db","WithDecryption":true}',
        ),
      ),
    ).toMatchObject({ kind: 'write' });
    expect(
      await verdict(
        json(
          'ssm.eu-west-1.amazonaws.com',
          'ssm',
          'AmazonSSM.GetParameterHistory',
          '{"Name":"/db"}',
        ),
      ),
    ).toEqual({ kind: 'read' });
    expect(
      await verdict(
        json(
          'cognito-idp.eu-west-1.amazonaws.com',
          'cognito-idp',
          'AWSCognitoIdentityProviderService.DescribeUserPoolClient',
        ),
      ),
    ).toMatchObject({ kind: 'write' });
    const keys = {
      method: 'GET',
      host: 'apigateway.eu-west-1.amazonaws.com',
      service: 'apigateway',
      path: '/apikeys',
    };
    expect(await verdict(keys)).toEqual({ kind: 'read' });
    expect(await verdict({ ...keys, query: 'includeValues=true' })).toMatchObject({
      kind: 'write',
    });
  });

  test('S3 names the bucket from the host the way S3 does, and a select with anything else asks', async () => {
    const verdict = async (input: Probe) => awsAdapter.classify(await probe(input), config);
    const s3 = (host: string, method: string, path: string, query = ''): Probe => ({
      method,
      host,
      service: 's3',
      path,
      query,
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    });
    expect(await verdict(s3('s3-x.s3.amazonaws.com', 'DELETE', '/important'))).toMatchObject({
      operation: 'DeleteObject',
      destructive: true,
      summary: { title: 's3:DeleteObject on s3-x/important' },
    });
    expect(await verdict(s3('s3-x.s3.amazonaws.com', 'PUT', '/foo'))).toMatchObject({
      operation: 'PutObject',
      destructive: true,
    });
    expect(
      await verdict(s3('my.s3.bucket.s3.eu-west-1.amazonaws.com', 'DELETE', '/k')),
    ).toMatchObject({
      summary: { title: 's3:DeleteObject on my.s3.bucket/k' },
    });
    expect(
      await verdict(s3('reports.s3.eu-west-1.amazonaws.com', 'POST', '/k', 'select&select-type=2')),
    ).toEqual({
      kind: 'read',
    });
    expect(
      await verdict(
        s3('reports.s3.eu-west-1.amazonaws.com', 'POST', '/k', 'select&select-type=2&restore'),
      ),
    ).toMatchObject({ kind: 'write' });
  });

  test('the parts of an upload pass only into one this job started with an approval, within its limits', async () => {
    const uploads = new Uploads();
    const adapter = createAwsAdapter({ uploads });
    const part = async (uploadId: string, job: string, key = 'big.bin') => ({
      ...(await probe({
        method: 'PUT',
        host: 'reports.s3.eu-west-1.amazonaws.com',
        service: 's3',
        path: `/${key}`,
        query: `partNumber=1&uploadId=${uploadId}`,
        headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
        body: 'part bytes',
      })),
      job,
    });
    // Before any approved start, and for anyone else's upload, a part asks.
    expect(adapter.classify(await part('SOMEONE_ELSES', 'job_one'), config)).toMatchObject({
      kind: 'write',
      operation: 'UploadPart',
    });
    // The approved start's answer names the upload; its parts then pass for that job only.
    const create = adapter.classify(
      {
        ...(await probe({
          method: 'POST',
          host: 'reports.s3.eu-west-1.amazonaws.com',
          service: 's3',
          path: '/big.bin',
          query: 'uploads',
          headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
        })),
        job: 'job_one',
      },
      config,
    ) as ClassifiedWrite;
    expect(create.operation).toBe('CreateMultipartUpload');
    const detail = adapter.receipt(create, {
      status: 200,
      headers: {},
      body: Buffer.from(
        '<InitiateMultipartUploadResult><UploadId>UP1</UploadId></InitiateMultipartUploadResult>',
      ),
    });
    expect(detail.upload_id).toBe('UP1');
    expect(adapter.classify(await part('UP1', 'job_one'), config)).toEqual({ kind: 'read' });
    expect(adapter.classify(await part('UP1', 'job_two'), config).kind).toBe('write');
    expect(adapter.classify(await part('UP1', 'job_one', 'other.bin'), config).kind).toBe('write');
    // Past the part limit, a part asks.
    for (let index = 1; index < MAX_UPLOAD_PARTS; index += 1)
      uploads.takePart('job_one', 'reports/big.bin', 'UP1', 1);
    expect(adapter.classify(await part('UP1', 'job_one'), config).kind).toBe('write');
  });
});

describe('the signature the relay makes', () => {
  test('it is the signature the AWS SDK makes for the same request, key and time', async () => {
    const differ: string[] = [];
    for (const recorded of corpus.requests) {
      const sdk = parseSigV4Authorization(recorded.fixed.authorization);
      if (!sdk) throw new Error(recorded.name);
      // The headers the SDK signed, from the request as it was built.
      const headers: Record<string, string> = {};
      for (const name of sdk.signedHeaders)
        if (name !== 'host' && name !== 'x-amz-date' && name !== 'x-amz-security-token') {
          const value = recorded.headers[name];
          if (value !== undefined) headers[name] = value;
        }
      const signed = await signRequest({
        method: recorded.method,
        host: recorded.host,
        path: recorded.path,
        query: recorded.query,
        headers,
        body: Buffer.from(recorded.fixed.body ?? recorded.body, 'utf8'),
        region: sdk.region,
        service: sdk.service,
        credentials: {
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
          sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLETOKEN',
        },
        now: new Date('2026-10-01T12:00:00Z'),
      });
      if (signed.authorization !== recorded.fixed.authorization)
        differ.push(`${recorded.name}: ${signed.authorization} vs ${recorded.fixed.authorization}`);
    }
    expect(differ).toEqual([]);
  });

  test('two runs of run-instances are one change, though the SDK makes up a new client token each time', () => {
    const recorded = corpus.requests.find((each) => each.name === 'ec2 run instances');
    if (!recorded?.fixed.body) throw new Error('missing');
    const bound = (body: string) => {
      const verdict = awsAdapter.classify(intercepted({ ...recorded, body }), config);
      return verdict.kind === 'write' ? verdict.boundBody : undefined;
    };
    expect(recorded.fixed.body).not.toBe(recorded.body);
    expect(bound(recorded.body)).toMatchObject({ generated_token_blanked: true });
    expect(bound(recorded.fixed.body)).toEqual(bound(recorded.body));
    // Anything else in the body is still bound, and so is a second token.
    expect(bound(recorded.body.replace('t3.micro', 't3.large'))).not.toEqual(bound(recorded.body));
    expect(
      bound(`${recorded.body}&ClientToken=${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`),
    ).toBeUndefined();
  });

  test('two runs of one command bind the same change, whatever their signing dates and request ids', async () => {
    const one = await placeholderSigned({
      method: 'DELETE',
      host: 'reports.s3.eu-west-1.amazonaws.com',
      path: '/a.csv',
      service: 's3',
      headers: {
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'amz-sdk-invocation-id': 'aaaaaaaa-0000-4000-8000-000000000001',
        'amz-sdk-request': 'attempt=1; max=3',
      },
      now: new Date('2026-10-01T12:00:00Z'),
    });
    const two = await placeholderSigned({
      method: 'DELETE',
      host: 'reports.s3.eu-west-1.amazonaws.com',
      path: '/a.csv',
      service: 's3',
      headers: {
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'amz-sdk-invocation-id': 'bbbbbbbb-0000-4000-8000-000000000002',
        'amz-sdk-request': 'attempt=2; max=3',
      },
      now: new Date('2026-10-01T12:05:00Z'),
    });
    const volatile = new Set([...VOLATILE_HEADERS, ...AWS_VOLATILE_HEADERS]);
    const bind = (headers: Record<string, string>) => {
      const { authorization: _a, ...rest } = headers;
      return JSON.stringify(requestBinding(rest, Buffer.alloc(0), undefined, volatile));
    };
    expect(bind(one)).toBe(bind(two));
    // Anything else that changes what lands is a different approval.
    expect(bind({ ...one, 'x-amz-mfa': '123456 000000' })).not.toBe(bind(two));
  });
});

describe('the relay with a connected AWS account', () => {
  const HOST = 'reports.s3.eu-west-1.amazonaws.com';
  let upstream: Awaited<ReturnType<typeof fixtureUpstream>> | null = null;
  let guard: SandboxEgressGuard | null = null;
  afterAll(async () => {
    await guard?.close();
    await upstream?.close();
  });

  async function relay(admitWrite?: (input: EgressWriteInput) => Promise<never>) {
    upstream ??= await fixtureUpstream(HOST, (request) =>
      request.path === '/echo'
        ? { body: `you signed with ${request.headers.authorization} and ${KEY.secret_access_key}` }
        : { body: '<ListBucketResult/>', headers: { 'content-type': 'application/xml' } },
    );
    await guard?.close();
    const port = memoryCredentialPort({
      secret: SECRET,
      account: { adapter: awsAdapter as CredentialAdapter, config },
      ...(admitWrite ? { admitWrite } : {}),
    });
    const fixture = upstream;
    guard = new SandboxEgressGuard({
      resolve: async () => [{ address: '52.94.0.10', family: 4 }],
      credentials: port,
      intercept: {
        upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: fixture.port }),
        upstreamCa: fixture.ca,
      },
    });
    const relayPort = await guard.listen(0, '127.0.0.1');
    guard.allow('127.0.0.1', 'melete-sbx-aws', {
      mode: 'open',
      session: 'sbx_aws',
      space: 'sp_aws',
    });
    const token = guard.mint('melete-sbx-aws', {
      kind: 'command',
      sessionId: 'sbx_aws',
      jobId: 'job_aws',
      attemptId: 'att_aws',
      actionId: 'act_aws',
      deadlineAt: Date.now() + 120_000,
    });
    return { relayPort, token, ca: (await port.ca.certificate()).pem };
  }
  const get = async (pathname: string, key?: string, token?: string) =>
    rawRequest('GET', HOST, pathname, {
      headers: {
        ...(await placeholderSigned({
          method: 'GET',
          host: HOST,
          path: pathname,
          service: 's3',
          headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
          ...(key ? { key } : {}),
          ...(token ? { token } : {}),
        })),
      },
    });

  test('a request signed with the placeholder is re-signed and a stray real key is refused', async () => {
    const { relayPort, token, ca } = await relay();
    upstream?.seen.splice(0);
    const [read, stray, session, presigned, unsigned] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [
        await get('/'),
        await get('/', 'AKIAREALKEYINAFILE01'),
        await get('/', undefined, 'FwoGZXIvYXdzEXAMPLE'),
        rawRequest(
          'GET',
          HOST,
          `/a.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${AWS_KEY_PLACEHOLDER}%2F20261001%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Signature=${'0'.repeat(64)}`,
        ),
        rawRequest('GET', HOST, '/public.txt'),
      ],
    });
    expect(read?.status).toBe(200);
    // Upstream saw the account's key and a signature over the request it got.
    const sent = upstream?.seen[0];
    const authorization = String(sent?.headers.authorization ?? '');
    const scope = parseSigV4Authorization(authorization);
    expect(scope).toMatchObject({ accessKeyId: KEY.access_key_id, region: REGION, service: 's3' });
    const again = await signRequest({
      method: 'GET',
      host: HOST,
      path: '/',
      query: '',
      headers: Object.fromEntries(
        (scope?.signedHeaders ?? [])
          .filter((name) => name !== 'host')
          .map((name) => [name, String(sent?.headers[name] ?? '')]),
      ),
      body: Buffer.alloc(0),
      region: REGION,
      service: 's3',
      credentials: { accessKeyId: KEY.access_key_id, secretAccessKey: KEY.secret_access_key },
      now: new Date(
        String(sent?.headers['x-amz-date']).replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          '$1-$2-$3T$4:$5:$6Z',
        ),
      ),
    });
    expect(authorization).toBe(again.authorization ?? 'missing');
    // A real key, a session token or a presigned URL never leaves; an unsigned request goes as it is.
    for (const refused of [stray, session])
      expect(refused).toMatchObject({
        status: 403,
        body: expect.stringContaining('other than the placeholder'),
      });
    expect(presigned).toMatchObject({
      status: 403,
      body: expect.stringContaining('presigned URL'),
    });
    expect(unsigned?.status).toBe(200);
    expect(upstream?.seen.map((each) => [each.path, each.headers.authorization ?? null])).toEqual([
      ['/', authorization],
      ['/public.txt', null],
    ]);
  });

  test('the account secret never comes back, even when the service echoes it', async () => {
    const { relayPort, token, ca } = await relay();
    const [echo] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [await get('/echo')],
    });
    expect(echo?.body).toContain('[redacted]');
    expect(echo?.body).not.toContain(KEY.secret_access_key);
  });

  test('chunk-signed uploads are refused with a plain message', async () => {
    const admitted: EgressWriteInput[] = [];
    const { relayPort, token, ca } = await relay(async (input) => {
      admitted.push(input);
      throw new Error('never admitted');
    });
    upstream?.seen.splice(0);
    const body = '5;chunk-signature=00\r\nhello\r\n0;chunk-signature=00\r\n\r\n';
    const headers = await placeholderSigned({
      method: 'PUT',
      host: HOST,
      path: '/big.bin',
      service: 's3',
      headers: {
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
        'content-encoding': 'aws-chunked',
        'x-amz-decoded-content-length': '5',
      },
      body,
    });
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [rawRequest('PUT', HOST, '/big.bin', { headers, body })],
    });
    expect(answer?.status).toBe(403);
    expect(answer?.body).toContain('Chunk-signed uploads');
    expect(admitted).toEqual([]);
    expect(upstream?.seen).toEqual([]);
  });

  test('a held change is answered the way aws prints an error', () => {
    const recorded = corpus.requests.find((each) => each.name === 's3 delete object');
    const json = corpus.requests.find((each) => each.name === 'logs delete log group');
    const query = corpus.requests.find((each) => each.name === 'ec2 terminate instances');
    if (!recorded || !json || !query) throw new Error('missing');
    const answer = (each: typeof recorded) => {
      const request = intercepted(each);
      const verdict = awsAdapter.classify(request, config) as ClassifiedWrite;
      return awsAdapter.heldAnswer?.(
        request,
        verdict,
        'Waiting for your approval in Melete: x & y.',
        403,
      );
    };
    expect(answer(recorded)?.body.toString()).toContain(
      '<Error><Code>ApprovalRequired</Code><Message>Waiting for your approval in Melete: x &amp; y.</Message>',
    );
    expect(JSON.parse(answer(json)?.body.toString() ?? '{}')).toEqual({
      __type: 'ApprovalRequired',
      message: 'Waiting for your approval in Melete: x & y.',
    });
    expect(answer(query)?.body.toString()).toContain(
      '<ErrorResponse><Error><Type>Sender</Type><Code>ApprovalRequired</Code>',
    );
  });

  test('S3 answering a copy with an error in a 200 may have taken effect', () => {
    const recorded = corpus.requests.find((each) => each.name === 's3 copy object');
    if (!recorded) throw new Error('missing');
    const verdict = awsAdapter.classify(intercepted(recorded), config) as ClassifiedWrite;
    const failed = {
      status: 200,
      headers: {},
      body: Buffer.from('<Error><Code>InternalError</Code><Message>x</Message></Error>'),
    };
    expect(awsAdapter.uncertain?.(verdict, failed)).toContain('may still have taken effect');
    expect(
      awsAdapter.uncertain?.(verdict, { ...failed, body: Buffer.from('<CopyObjectResult/>') }),
    ).toBeNull();
  });
});

describe('answers and hosts the account is kept from', () => {
  test('a signed request to a server running on AWS is refused, and an unsigned one goes as it is', async () => {
    for (const host of [
      'ec2-203-0-113-5.eu-west-1.compute.amazonaws.com',
      'ec2-203-0-113-5.compute-1.amazonaws.com',
      'shop-123.eu-west-1.elb.amazonaws.com',
    ]) {
      const signed = await probe({ method: 'GET', host, service: 'ec2', path: '/' });
      expect(awsAdapter.classify(signed, config)).toMatchObject({
        kind: 'refuse',
        reason: expect.stringContaining('not one of AWS'),
      });
      const { authorization: _signature, ...unsigned } = signed;
      expect(awsAdapter.classify(unsigned, config)).toEqual({ kind: 'read' });
    }
  });

  test('the relay keeps an answer holding a credential from the computer, and records it', async () => {
    const READ_HOST = 'gamelift.eu-west-1.amazonaws.com';
    const WRITE_HOST = 'ec2.eu-west-1.amazonaws.com';
    const SESSION_SECRET = 'leakedSessionSecret0123456789';
    const PRIVATE = '-----BEGIN RSA PRIVATE KEY-----\nMIIEleaked\n-----END RSA PRIVATE KEY-----';
    const gamelift = await fixtureUpstream(READ_HOST, () => ({
      body: JSON.stringify({
        Credentials: { AccessKeyId: 'ASIA1', SecretAccessKey: SESSION_SECRET },
      }),
    }));
    const ec2 = await fixtureUpstream(WRITE_HOST, () => ({
      body: `<CreateKeyPairResponse><keyName>k</keyName><keyMaterial>${PRIVATE}</keyMaterial></CreateKeyPairResponse>`,
      headers: { 'content-type': 'text/xml' },
    }));
    const results: unknown[] = [];
    const port = memoryCredentialPort({
      secret: SECRET,
      account: { adapter: awsAdapter as CredentialAdapter, config },
      admitWrite: async (input) => {
        const result = await input.forward();
        results.push(result);
        return { kind: 'sent', actionId: 'act_key', result };
      },
    });
    const withheld: string[] = [];
    const ports: Record<string, number> = { [READ_HOST]: gamelift.port, [WRITE_HOST]: ec2.port };
    const guard = new SandboxEgressGuard({
      resolve: async () => [{ address: '52.94.0.10', family: 4 }],
      credentials: port,
      records: {
        opened: (record) => {
          if (record.reason) withheld.push(`${record.host} ${record.reason}`);
        },
        closed: () => {},
        counted: () => {},
      },
      intercept: {
        upstream: (host) => ({
          address: { address: '127.0.0.1', family: 4 },
          port: ports[host] ?? 0,
        }),
        upstreamCa: [gamelift.ca, ec2.ca],
      },
    });
    try {
      const relayPort = await guard.listen(0, '127.0.0.1');
      guard.allow('127.0.0.1', 'melete-sbx-held', {
        mode: 'open',
        session: 'sbx_held',
        space: 'sp_held',
      });
      const token = guard.mint('melete-sbx-held', {
        kind: 'command',
        sessionId: 'sbx_held',
        jobId: 'job_held',
        attemptId: 'att_held',
        actionId: 'act_held',
        deadlineAt: Date.now() + 120_000,
      });
      const ca = (await port.ca.certificate()).pem;
      const signedRequest = async (
        host: string,
        service: string,
        headers: Record<string, string>,
        body: string,
      ) =>
        rawRequest('POST', host, '/', {
          headers: await placeholderSigned({
            method: 'POST',
            host,
            path: '/',
            service,
            headers,
            body,
          }),
          body,
        });
      const [read] = await throughRelay({
        relayPort,
        host: READ_HOST,
        ca,
        token,
        requests: [
          await signedRequest(
            READ_HOST,
            'gamelift',
            {
              'x-amz-target': 'GameLift.DescribeFleetAttributes',
              'content-type': 'application/x-amz-json-1.1',
            },
            '{}',
          ),
        ],
      });
      expect(read?.status).toBe(502);
      expect(read?.headers['x-melete-egress']).toBe('answer_withheld');
      expect(read?.body).toContain('an AWS secret access key');
      expect(read?.body).not.toContain(SESSION_SECRET);
      const [made] = await throughRelay({
        relayPort,
        host: WRITE_HOST,
        ca,
        token,
        requests: [
          await signedRequest(
            WRITE_HOST,
            'ec2',
            { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
            'Action=CreateKeyPair&KeyName=k&Version=2016-11-15',
          ),
        ],
      });
      expect(made?.status).toBe(502);
      expect(made?.body).toContain('This change was made');
      expect(made?.body).not.toContain('MIIEleaked');
      // The change is recorded as made, with why its answer was kept back.
      expect(results).toEqual([
        expect.objectContaining({ outcome: 'answered', withheld: 'a private key' }),
      ]);
      expect((results[0] as { detail: Record<string, unknown> }).detail.answer_withheld).toBe(
        'a private key',
      );
      expect(withheld).toEqual([`${READ_HOST} answer_withheld`, `${WRITE_HOST} answer_withheld`]);
    } finally {
      await guard.close();
      await gamelift.close();
      await ec2.close();
    }
  });
});

describe('a role the service assumes', () => {
  test('an assumed-role session names the command in its session name', async () => {
    const pair = selfSignedPair('sts.eu-west-1.amazonaws.com');
    const calls: Array<{ form: URLSearchParams; authorization: string }> = [];
    let issued = 0;
    const sts = createServer({ key: pair.key, cert: pair.cert }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        calls.push({
          form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
          authorization: String(request.headers.authorization ?? ''),
        });
        issued += 1;
        response.writeHead(200, { 'content-type': 'text/xml' });
        response.end(
          `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIASESSION0000000${issued}</AccessKeyId><SecretAccessKey>sessionSecret${issued}abcdefghijklmnop</SecretAccessKey><SessionToken>sessionToken${issued}</SessionToken><Expiration>${new Date(Date.now() + 900_000).toISOString()}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/deploy/x</Arn></AssumedRoleUser></AssumeRoleResult></AssumeRoleResponse>`,
        );
      });
    });
    await new Promise<void>((resolve) => sts.listen(0, '127.0.0.1', resolve));
    try {
      const adapter = createAwsAdapter({
        sts: {
          ca: pair.cert.toString(),
          route: () => ({
            address: { address: '127.0.0.1', family: 4 },
            port: (sts.address() as AddressInfo).port,
          }),
        },
      });
      const roleConfig = adapter.parseConfig({
        region: REGION,
        role_arn: 'arn:aws:iam::123456789012:role/deploy',
        external_id: 'melete-ext-1',
      });
      const authorization = (
        await placeholderSigned({
          method: 'GET',
          host: 'reports.s3.eu-west-1.amazonaws.com',
          path: '/',
          service: 's3',
          headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
        })
      ).authorization;
      const sign = (command: string) =>
        adapter.authorize(
          {
            host: 'reports.s3.eu-west-1.amazonaws.com',
            method: 'GET',
            target: '/',
            headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
            body: Buffer.alloc(0),
          },
          SECRET,
          roleConfig,
          { command, authorization },
        );
      const first = await sign('act_01JCOMMAND');
      const again = await sign('act_01JCOMMAND');
      const other = await sign('act_01JOTHER');
      expect(calls.map((call) => call.form.get('RoleSessionName'))).toEqual([
        'melete-act_01JCOMMAND',
        'melete-act_01JOTHER',
      ]);
      expect(calls[0]?.form.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/deploy');
      expect(calls[0]?.form.get('ExternalId')).toBe('melete-ext-1');
      // STS was asked with the stored key; the request with the command's session.
      expect(parseSigV4Authorization(calls[0]?.authorization)?.accessKeyId).toBe(KEY.access_key_id);
      expect(first.headers['x-amz-security-token']).toBe('sessionToken1');
      expect(parseSigV4Authorization(first.headers.authorization)?.accessKeyId).toBe(
        'ASIASESSION00000001',
      );
      expect(again.headers['x-amz-security-token']).toBe('sessionToken1');
      expect(other.headers['x-amz-security-token']).toBe('sessionToken2');
      // The session's own keys are redacted from whatever comes back.
      expect(first.redactions).toEqual(['sessionSecret1abcdefghijklmnop', 'sessionToken1']);
    } finally {
      sts.close();
    }
  });

  test('a session name keeps to what STS allows', () => {
    expect(sessionNameFor('act_01J9Z')).toBe('melete-act_01J9Z');
    expect(sessionNameFor('a b/c')).toBe('melete-a-b-c');
    expect(sessionNameFor('x'.repeat(100))).toHaveLength(64);
    expect(sessionNameFor(null)).toBe('melete-melete');
  });
});
