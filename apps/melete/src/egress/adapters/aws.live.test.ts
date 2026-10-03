/**
 * AWS for real, through the relay. Skipped unless `MELETE_EGRESS_LIVE=aws`;
 * never part of an ordinary run or of CI.
 *
 *   MELETE_EGRESS_LIVE_AWS_KEY_ID      an access key of an IAM user in a sandbox account
 *   MELETE_EGRESS_LIVE_AWS_SECRET      its secret
 *   MELETE_EGRESS_LIVE_AWS_REGION      the region of the bucket below
 *   MELETE_EGRESS_LIVE_AWS_BUCKET      a throwaway bucket the key (or role) may read and write
 *   MELETE_EGRESS_LIVE_AWS_ROLE_ARN    optional: a role the key may assume, used for every call
 *   MELETE_EGRESS_AWS_CLI              the aws binary (default `aws`)
 *
 * The machine's own `aws` plays the computer: it holds only the placeholder
 * key and the egress CA, and reaches AWS through a relay in this process,
 * which signs each request again and brings every change here, where each one
 * is approved the second time it is asked. The run reads who it is, uploads
 * an object, reads it back, deletes it, and is refused a role session.
 */
import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { SandboxEgressGuard } from '../../sandbox/adapters/docker-egress.ts';
import { awsSecret } from '../aws-session.ts';
import { memoryCredentialPort } from '../fixtures.ts';
import { AWS_KEY_PLACEHOLDER, AWS_SECRET_PLACEHOLDER, awsAdapter } from './aws.ts';
import type { CredentialAdapter } from './types.ts';

const live = process.env.MELETE_EGRESS_LIVE === 'aws';
const env = (name: string) => process.env[`MELETE_EGRESS_LIVE_AWS_${name}`] ?? '';

describe.skipIf(!live)('AWS live, through the relay', () => {
  test('read who it is, upload, read back and delete an object, each change approved', async () => {
    const key = { access_key_id: env('KEY_ID'), secret_access_key: env('SECRET') };
    const region = env('REGION');
    const bucket = env('BUCKET');
    const role = env('ROLE_ARN');
    expect(key.access_key_id).not.toBe('');
    expect(bucket).not.toBe('');
    const writes: EgressWriteInput[] = [];
    const port = memoryCredentialPort({
      secret: awsSecret(key),
      account: {
        adapter: awsAdapter as CredentialAdapter,
        config: awsAdapter.parseConfig({ region, ...(role ? { role_arn: role } : {}) }),
      },
      admitWrite: async (input) => {
        writes.push(input);
        const same = writes.filter(
          (each) => JSON.stringify(each.write.payload) === JSON.stringify(input.write.payload),
        );
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
    const guard = new SandboxEgressGuard({ credentials: port });
    const relayPort = await guard.listen(0, '127.0.0.1');
    guard.allow('127.0.0.1', 'melete-sbx-live', {
      mode: 'open',
      session: 'sbx_live',
      space: 'sp_live',
    });
    const token = guard.mint('melete-sbx-live', {
      kind: 'command',
      sessionId: 'sbx_live',
      jobId: 'job_live',
      attemptId: 'att_live',
      actionId: 'act_live',
      deadlineAt: Date.now() + 600_000,
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'melete-aws-live-'));
    try {
      const bundle = path.join(dir, 'bundle.pem');
      await writeFile(bundle, [...rootCertificates, (await port.ca.certificate()).pem].join('\n'));
      const run = (args: string[]) =>
        new Promise<{ code: number; out: string }>((resolve) =>
          execFile(
            process.env.MELETE_EGRESS_AWS_CLI ?? 'aws',
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
                AWS_CA_BUNDLE: bundle,
                AWS_ACCESS_KEY_ID: AWS_KEY_PLACEHOLDER,
                AWS_SECRET_ACCESS_KEY: AWS_SECRET_PLACEHOLDER,
                AWS_REGION: region,
                AWS_DEFAULT_REGION: region,
                AWS_PAGER: '',
              },
              timeout: 120_000,
            },
            (error, stdout, stderr) =>
              resolve({
                code: error ? Number((error as { code?: number }).code ?? 1) : 0,
                out: `${stdout}${stderr}`,
              }),
          ),
        );
      const object = `melete-live/${randomBytes(6).toString('hex')}.txt`;
      const file = path.join(dir, 'object.txt');
      await writeFile(file, 'written through the relay\n');
      const who = await run(['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text']);
      expect(who.code).toBe(0);
      if (role) expect(who.out).toContain('/melete-act_live');
      const put = ['s3api', 'put-object', '--bucket', bucket, '--key', object, '--body', file];
      expect((await run(put)).out).toContain('ApprovalRequired');
      expect((await run(put)).code).toBe(0);
      const got = await run(['s3', 'cp', `s3://${bucket}/${object}`, '-']);
      expect(got.out).toContain('written through the relay');
      const remove = ['s3api', 'delete-object', '--bucket', bucket, '--key', object];
      expect((await run(remove)).out).toContain('ApprovalRequired');
      expect((await run(remove)).code).toBe(0);
      const minted = await run(['sts', 'get-session-token']);
      expect(minted.out).toContain('hands out credentials');
      for (const each of [who, got, minted]) expect(each.out).not.toContain(key.secret_access_key);
      expect(writes.map((each) => each.write.summary.title)).toEqual([
        `s3:PutObject on ${bucket}/${object}`,
        `s3:PutObject on ${bucket}/${object}`,
        `s3:DeleteObject on ${bucket}/${object}`,
        `s3:DeleteObject on ${bucket}/${object}`,
      ]);
    } finally {
      await guard.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
