/**
 * A local stand-in for AWS, for the relay's tests: a moto server (S3, STS
 * and IAM, checking every signature once its first few calls are spent),
 * behind TLS for the real AWS host names with certificates from a test
 * authority. Test code only.
 *
 * moto lets the first `INITIAL_NO_AUTH_ACTION_COUNT` calls through without a
 * signature; `bootstrapMoto` spends exactly `MOTO_BOOTSTRAP_CALLS` of them
 * creating a user with a key, a role it may assume, and a bucket. Every call
 * after that must be signed by a key moto issued.
 */
import { request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { createServer as createTlsServer, type Server } from 'node:tls';
import type { ResolvedAddress } from '../connectors/web.ts';
import type { AwsAccessKey } from './aws-session.ts';
import { signRequest } from './sigv4.ts';
import { certificateAuthority, leafCertificate, newKeyPair, pem } from './x509.ts';

export const MOTO_BOOTSTRAP_CALLS = 6;
export const MOTO_REGION = 'eu-west-1';
export const MOTO_BUCKET = 'melete-reports';
export const MOTO_ACCOUNT = '123456789012';

/** TLS for each AWS host name, passed byte for byte to moto, which reads the Host header. */
export async function awsFronts(moto: URL, hosts: string[]) {
  const authority = newKeyPair();
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 24 * 60 * 60_000);
  const caName = 'Melete test AWS authority';
  const ca = certificateAuthority({
    keys: authority,
    commonName: caName,
    permitted: ['amazonaws.com'],
    notBefore,
    notAfter,
  });
  const servers: Server[] = [];
  const ports = new Map<string, number>();
  for (const host of hosts) {
    const keys = newKeyPair();
    const cert = leafCertificate({
      host,
      keys,
      caCert: ca,
      caKey: authority.privateKey,
      caCommonName: caName,
      notBefore,
      notAfter,
    });
    const server = createTlsServer(
      {
        key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        cert: pem('CERTIFICATE', cert),
      },
      (socket) => {
        const upstream = connectTcp(Number(moto.port || 80), moto.hostname);
        socket.pipe(upstream).pipe(socket);
        const close = () => {
          socket.destroy();
          upstream.destroy();
        };
        socket.once('error', close);
        upstream.once('error', close);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    ports.set(host, (server.address() as { port: number }).port);
  }
  const loopback: ResolvedAddress = { address: '127.0.0.1', family: 4 };
  return {
    ca: pem('CERTIFICATE', ca),
    route: (host: string) => {
      const port = ports.get(host);
      return port ? { address: loopback, port } : null;
    },
    close: () => Promise.all(servers.map((server) => new Promise((done) => server.close(done)))),
  };
}

/** One call straight to moto, signed with `key` (any key while moto is not checking yet). */
export async function motoCall(
  moto: URL,
  input: {
    host: string;
    service: string;
    method: string;
    path: string;
    query?: string;
    headers?: Record<string, string>;
    body?: string;
    key?: AwsAccessKey;
  },
): Promise<{ status: number; body: string }> {
  const body = Buffer.from(input.body ?? '');
  const key = input.key ?? {
    access_key_id: 'AKIABOOTSTRAP0000000',
    secret_access_key: 'bootstrap-secret-0000',
  };
  const headers = await signRequest({
    method: input.method,
    host: input.host,
    path: input.path,
    query: input.query ?? '',
    headers: {
      ...(input.service === 's3' ? { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } : {}),
      ...input.headers,
    },
    body,
    region: MOTO_REGION,
    service: input.service,
    credentials: { accessKeyId: key.access_key_id, secretAccessKey: key.secret_access_key },
  });
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: moto.hostname,
        port: Number(moto.port || 80),
        method: input.method,
        path: `${input.path}${input.query ? `?${input.query}` : ''}`,
        headers: { ...headers, 'content-length': String(body.length) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    call.once('error', reject);
    call.end(body);
  });
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
const ALLOW_ALL = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
});

/**
 * A user `alice` with a key and every permission, a role `deploy` she may
 * assume, and a bucket: exactly `MOTO_BOOTSTRAP_CALLS` unsigned calls.
 */
export async function bootstrapMoto(moto: URL): Promise<{ key: AwsAccessKey; roleArn: string }> {
  const iam = (values: Record<string, string>) =>
    motoCall(moto, {
      host: 'iam.amazonaws.com',
      service: 'iam',
      method: 'POST',
      path: '/',
      headers: FORM,
      body: form({ ...values, Version: '2010-05-08' }),
    });
  const ok = (answer: { status: number; body: string }, what: string) => {
    if (answer.status >= 300)
      throw new Error(`moto refused ${what}: ${answer.status} ${answer.body.slice(0, 300)}`);
    return answer.body;
  };
  ok(await iam({ Action: 'CreateUser', UserName: 'alice' }), 'CreateUser');
  const created = ok(
    await iam({ Action: 'CreateAccessKey', UserName: 'alice' }),
    'CreateAccessKey',
  );
  const keyId = /<AccessKeyId>([^<]+)<\/AccessKeyId>/.exec(created)?.[1];
  const secret = /<SecretAccessKey>([^<]+)<\/SecretAccessKey>/.exec(created)?.[1];
  if (!keyId || !secret) throw new Error('moto issued no key');
  ok(
    await iam({
      Action: 'PutUserPolicy',
      UserName: 'alice',
      PolicyName: 'all',
      PolicyDocument: ALLOW_ALL,
    }),
    'PutUserPolicy',
  );
  const role = ok(
    await iam({
      Action: 'CreateRole',
      RoleName: 'deploy',
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }],
      }),
    }),
    'CreateRole',
  );
  const roleArn = /<Arn>([^<]+)<\/Arn>/.exec(role)?.[1];
  if (!roleArn) throw new Error('moto made no role');
  ok(
    await iam({
      Action: 'PutRolePolicy',
      RoleName: 'deploy',
      PolicyName: 'all',
      PolicyDocument: ALLOW_ALL,
    }),
    'PutRolePolicy',
  );
  ok(
    await motoCall(moto, {
      host: `s3.${MOTO_REGION}.amazonaws.com`,
      service: 's3',
      method: 'PUT',
      path: `/${MOTO_BUCKET}`,
      body: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${MOTO_REGION}</LocationConstraint></CreateBucketConfiguration>`,
    }),
    'CreateBucket',
  );
  return { key: { access_key_id: keyId, secret_access_key: secret }, roleArn };
}
