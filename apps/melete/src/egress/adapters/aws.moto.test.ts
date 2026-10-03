/**
 * The AWS adapter through the real relay against moto, a local AWS stand-in
 * that checks every signature: S3, STS and IAM. Skipped unless
 * `MELETE_EGRESS_MOTO` names a moto server started with
 * `INITIAL_NO_AUTH_ACTION_COUNT` equal to `MOTO_BOOTSTRAP_CALLS`; with
 * `MELETE_EGRESS_AWS_CLI` naming an `aws` binary, the real command line runs
 * through the relay as a command in the computer would.
 *
 *   moto_server -p 5055   (with INITIAL_NO_AUTH_ACTION_COUNT=6)
 *   MELETE_EGRESS_MOTO=http://127.0.0.1:5055 MELETE_EGRESS_AWS_CLI=aws bun test aws.moto
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { SandboxEgressGuard } from '../../sandbox/adapters/docker-egress.ts';
import { awsFronts, bootstrapMoto, MOTO_BUCKET, MOTO_REGION, motoCall } from '../aws-fixture.ts';
import { awsSecret } from '../aws-session.ts';
import { memoryCredentialPort } from '../fixtures.ts';
import { AWS_KEY_PLACEHOLDER, AWS_SECRET_PLACEHOLDER, createAwsAdapter } from './aws.ts';
import type { CredentialAdapter } from './types.ts';

const motoUrl = process.env.MELETE_EGRESS_MOTO;
const cli = process.env.MELETE_EGRESS_AWS_CLI;

describe.skipIf(!motoUrl)('the AWS adapter against a local stand-in that checks signatures', () => {
  const moto = new URL(motoUrl ?? 'http://127.0.0.1:1');
  const HOSTS = [
    `sts.${MOTO_REGION}.amazonaws.com`,
    `s3.${MOTO_REGION}.amazonaws.com`,
    `${MOTO_BUCKET}.s3.${MOTO_REGION}.amazonaws.com`,
  ];
  let fronts: Awaited<ReturnType<typeof awsFronts>>;
  let guard: SandboxEgressGuard;
  let relayPort = 0;
  let token = '';
  let dir = '';
  let caFile = '';
  let secretKey = '';
  const writes: EgressWriteInput[] = [];

  beforeAll(async () => {
    const { key, roleArn } = await bootstrapMoto(moto);
    secretKey = key.secret_access_key;
    fronts = await awsFronts(moto, HOSTS);
    const sts = { ca: fronts.ca, route: fronts.route };
    const adapter = createAwsAdapter({ sts }) as CredentialAdapter;
    const port = memoryCredentialPort({
      secret: awsSecret(key),
      account: { adapter, config: { region: MOTO_REGION, role_arn: roleArn } },
      admitWrite: async (input) => {
        writes.push(input);
        const same = writes.filter(
          (each) => JSON.stringify(each.write.payload) === JSON.stringify(input.write.payload),
        );
        // A change waits for the person the first time; run again, it is approved.
        if (same.length === 1)
          return {
            kind: 'waiting',
            actionId: `act_held_${writes.length}`,
            message: `Waiting for your approval in Melete: ${input.write.summary.title}. Run the same command again once it is approved.`,
          };
        return {
          kind: 'sent',
          actionId: `act_sent_${writes.length}`,
          result: await input.forward(),
        };
      },
    });
    guard = new SandboxEgressGuard({
      resolve: async () => [{ address: '52.94.0.10', family: 4 }],
      credentials: port,
      intercept: {
        upstream: (host) => {
          const route = fronts.route(host);
          if (!route) throw new Error(`no stand-in for ${host}`);
          return route;
        },
        upstreamCa: fronts.ca,
      },
    });
    relayPort = await guard.listen(0, '127.0.0.1');
    guard.allow('127.0.0.1', 'melete-sbx-aws', {
      mode: 'open',
      session: 'sbx_aws',
      space: 'sp_aws',
    });
    token = guard.mint('melete-sbx-aws', {
      kind: 'command',
      sessionId: 'sbx_aws',
      jobId: 'job_aws',
      attemptId: 'att_aws',
      actionId: 'act_aws',
      deadlineAt: Date.now() + 600_000,
    });
    dir = await mkdtemp(path.join(tmpdir(), 'melete-aws-'));
    caFile = path.join(dir, 'egress-ca.pem');
    await writeFile(caFile, (await port.ca.certificate()).pem);
  }, 60_000);

  afterAll(async () => {
    await guard?.close();
    await fronts?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the stand-in refuses a request signed with a key it did not issue', async () => {
    const answer = await motoCall(moto, {
      host: `s3.${MOTO_REGION}.amazonaws.com`,
      service: 's3',
      method: 'GET',
      path: `/${MOTO_BUCKET}`,
      key: { access_key_id: 'AKIANOTISSUED0000000', secret_access_key: 'not-a-real-secret-000' },
    });
    expect(answer.status).toBe(403);
  });

  describe.skipIf(!cli)('the aws command line through the relay', () => {
    const run = (args: string[], body?: string) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          cli ?? 'aws',
          args,
          {
            env: {
              PATH: process.env.PATH ?? '',
              SYSTEMROOT: process.env.SYSTEMROOT ?? '',
              HOME: dir,
              USERPROFILE: dir,
              AWS_CONFIG_FILE: path.join(dir, 'none'),
              AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'none'),
              HTTPS_PROXY: `http://cmd:${token}@127.0.0.1:${relayPort}`,
              AWS_CA_BUNDLE: caFile,
              AWS_ACCESS_KEY_ID: AWS_KEY_PLACEHOLDER,
              AWS_SECRET_ACCESS_KEY: AWS_SECRET_PLACEHOLDER,
              AWS_REGION: MOTO_REGION,
              AWS_DEFAULT_REGION: MOTO_REGION,
              AWS_EC2_METADATA_DISABLED: 'true',
              AWS_PAGER: '',
            },
            timeout: 120_000,
          },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number((error as { code?: number }).code ?? 1) : 0,
              out: `${stdout}${stderr}`,
            }),
        );
        void body;
      });

    test('reads pass, a change is held and lands once after approval, and the secret never comes back', async () => {
      const file = path.join(dir, 'report.csv');
      await writeFile(file, 'month,total\n2026-09,42\n');
      const who = await run(['sts', 'get-caller-identity', '--output', 'text', '--query', 'Arn']);
      expect(who.out).toContain('assumed-role/deploy/melete-act_aws');
      const put = [
        's3api',
        'put-object',
        '--bucket',
        MOTO_BUCKET,
        '--key',
        'reports/2026.csv',
        '--body',
        file,
      ];
      const first = await run(put);
      expect(first.code).not.toBe(0);
      expect(first.out).toContain('ApprovalRequired');
      expect(first.out).toContain(
        'Waiting for your approval in Melete: s3:PutObject on melete-reports/reports/2026.csv',
      );
      const second = await run(put);
      expect(second.out).toContain('ETag');
      expect(second.code).toBe(0);
      const listed = await run([
        's3api',
        'list-objects-v2',
        '--bucket',
        MOTO_BUCKET,
        '--query',
        'Contents[].Key',
        '--output',
        'text',
      ]);
      expect(listed.out.trim()).toBe('reports/2026.csv');
      const minted = await run([
        'sts',
        'assume-role',
        '--role-arn',
        'arn:aws:iam::123456789012:role/deploy',
        '--role-session-name',
        'try-it',
      ]);
      expect(minted.code).not.toBe(0);
      expect(minted.out).toContain('hands out credentials');
      const [held, sent] = writes;
      expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
      for (const each of [who, first, second, listed, minted])
        expect(each.out).not.toContain(secretKey);
    }, 180_000);
  });
});
