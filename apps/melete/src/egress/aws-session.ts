/**
 * The AWS credentials a connected account signs with, kept in the service.
 *
 * A connection holds a long-term access key, sealed like any other secret.
 * With a role named, the service assumes it itself (STS `AssumeRole`) for
 * each command that reaches AWS, naming the session after that command so
 * CloudTrail shows which command made each call; the session's keys stay in
 * this process and are kept only until shortly before they expire. Nothing
 * here ever reaches the computer: its commands hold a placeholder key, and
 * the relay signs each request again with what this module gives it.
 */
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { ResolvedAddress } from '../connectors/web.ts';
import { type AwsCredentials, signRequest } from './sigv4.ts';

/** A long-term access key as the connection's sealed secret holds it. */
export type AwsAccessKey = { access_key_id: string; secret_access_key: string };

export const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
export const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{16,128}$/;
export const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
export const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** The sealed secret's text: the key pair as JSON. */
export function awsSecret(key: AwsAccessKey): string {
  return JSON.stringify({
    access_key_id: key.access_key_id,
    secret_access_key: key.secret_access_key,
  });
}

/** The key pair in a sealed secret, or a refusal. */
export function parseAwsSecret(secret: string): AwsAccessKey {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new Error('the stored AWS key cannot be read');
  }
  const key = value as Partial<AwsAccessKey> | null;
  if (
    !key ||
    typeof key.access_key_id !== 'string' ||
    typeof key.secret_access_key !== 'string' ||
    !ACCESS_KEY_ID.test(key.access_key_id) ||
    !SECRET_ACCESS_KEY.test(key.secret_access_key)
  )
    throw new Error('the stored AWS key cannot be read');
  return { access_key_id: key.access_key_id, secret_access_key: key.secret_access_key };
}

/** Where a call to an AWS host really goes. Only a test changes it. */
export type AwsRoute = (host: string) => { address: ResolvedAddress; port: number } | null;

export type StsOptions = {
  /** Extra trust for the endpoint's certificate; only a test passes one. */
  ca?: string | string[];
  route?: AwsRoute;
  /** Seconds a role session lasts; AWS allows 900 to the role's maximum. */
  durationSeconds?: number;
  now?: () => number;
};

/** Why STS refused, in its own code, or that it could not be reached. */
export class StsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(
      status === 0
        ? 'AWS STS could not be reached'
        : `AWS STS refused the request (${code || `status ${status}`})`,
    );
  }
}

const stsHost = (region: string) => `sts.${region}.amazonaws.com`;

/** One signed STS query call from the service, answered as its XML text. */
async function stsCall(
  region: string,
  credentials: AwsCredentials,
  parameters: Record<string, string>,
  options: StsOptions,
): Promise<string> {
  if (!AWS_REGION.test(region)) throw new StsError('InvalidRegion', 400);
  const host = stsHost(region);
  const body = Buffer.from(new URLSearchParams(parameters).toString());
  const headers = await signRequest({
    method: 'POST',
    host,
    path: '/',
    query: '',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    region,
    service: 'sts',
    credentials,
    ...(options.now ? { now: new Date(options.now()) } : {}),
  });
  const route = options.route?.(host) ?? null;
  return new Promise<string>((resolve, reject) => {
    const call = httpsRequest(
      {
        host,
        port: route?.port ?? 443,
        method: 'POST',
        path: '/',
        servername: host,
        agent: false,
        ...(options.ca ? { ca: options.ca } : {}),
        ...(route
          ? {
              lookup: ((_name, lookupOptions, callback) =>
                (lookupOptions as { all?: boolean }).all
                  ? (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, [
                      route.address,
                    ])
                  : (callback as (error: null, address: string, family: number) => void)(
                      null,
                      route.address.address,
                      route.address.family,
                    )) as LookupFunction,
            }
          : {}),
        headers: { ...headers, 'content-length': String(body.length) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) response.destroy(new Error('the answer is too large'));
          else chunks.push(chunk);
        });
        response.once('error', () => reject(new StsError('', 0)));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(text);
          reject(new StsError(xmlText(text, 'Code') ?? '', status));
        });
      },
    );
    call.once('error', () => reject(new StsError('', 0)));
    call.setTimeout(20_000, () => call.destroy(new Error('timed out')));
    call.end(body);
  });
}

/** The text of the first `<name>` element: STS answers are small and flat. */
function xmlText(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]{0,4096})</${name}>`).exec(xml);
  if (!match?.[1]) return null;
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export type AssumedRole = AwsCredentials & { sessionToken: string; expiresAt: number; arn: string };

/** STS `AssumeRole` from the service, with the long-term key. */
export async function assumeRole(input: {
  key: AwsAccessKey;
  roleArn: string;
  externalId?: string;
  sessionName: string;
  region: string;
  options?: StsOptions;
}): Promise<AssumedRole> {
  const options = input.options ?? {};
  const xml = await stsCall(
    input.region,
    { accessKeyId: input.key.access_key_id, secretAccessKey: input.key.secret_access_key },
    {
      Action: 'AssumeRole',
      Version: '2011-06-15',
      RoleArn: input.roleArn,
      RoleSessionName: input.sessionName,
      DurationSeconds: String(options.durationSeconds ?? 900),
      ...(input.externalId ? { ExternalId: input.externalId } : {}),
    },
    options,
  );
  const accessKeyId = xmlText(xml, 'AccessKeyId');
  const secretAccessKey = xmlText(xml, 'SecretAccessKey');
  const sessionToken = xmlText(xml, 'SessionToken');
  const expiration = Date.parse(xmlText(xml, 'Expiration') ?? '');
  if (!accessKeyId || !secretAccessKey || !sessionToken || Number.isNaN(expiration))
    throw new StsError('MalformedAnswer', 502);
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAt: expiration,
    arn: xmlText(xml, 'Arn') ?? input.roleArn,
  };
}

/** STS `GetCallerIdentity`: whose credentials these are. */
export async function callerIdentity(
  credentials: AwsCredentials,
  region: string,
  options: StsOptions = {},
): Promise<{ account: string; arn: string }> {
  const xml = await stsCall(
    region,
    credentials,
    { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    options,
  );
  const account = xmlText(xml, 'Account');
  const arn = xmlText(xml, 'Arn');
  if (!account || !arn) throw new StsError('MalformedAnswer', 502);
  return { account, arn };
}

/** A role session's name: the command's id, in the characters STS allows. */
export function sessionNameFor(command: string | null): string {
  const id = (command ?? 'melete').replace(/[^\w+=,.@-]/g, '-');
  return `melete-${id}`.slice(0, 64);
}

/** Sessions are used until this long before they expire, then assumed again. */
const SESSION_MARGIN_MS = 2 * 60_000;
const MAX_SESSIONS = 256;

/**
 * Role sessions the service has assumed, one per account, role and command,
 * held in memory until shortly before they expire.
 */
export class AwsSessions {
  private readonly held = new Map<string, Promise<AssumedRole>>();
  constructor(private readonly options: StsOptions = {}) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** The credentials to sign with: the key itself, or the command's role session. */
  async credentials(input: {
    key: AwsAccessKey;
    roleArn?: string | undefined;
    externalId?: string | undefined;
    region: string;
    command: string | null;
  }): Promise<AwsCredentials> {
    if (!input.roleArn)
      return {
        accessKeyId: input.key.access_key_id,
        secretAccessKey: input.key.secret_access_key,
      };
    const sessionName = sessionNameFor(input.command);
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          input.key.access_key_id,
          input.key.secret_access_key,
          input.roleArn,
          input.externalId ?? '',
          sessionName,
        ]),
      )
      .digest('hex');
    const cached = this.held.get(id);
    if (cached) {
      const session = await cached.catch(() => null);
      if (session && session.expiresAt - SESSION_MARGIN_MS > this.now()) return session;
      if (this.held.get(id) === cached) this.held.delete(id);
    }
    const pending = assumeRole({
      key: input.key,
      roleArn: input.roleArn,
      ...(input.externalId ? { externalId: input.externalId } : {}),
      sessionName,
      region: input.region,
      options: this.options,
    });
    // A refusal is not kept: the next request asks again.
    pending.catch(() => {
      if (this.held.get(id) === pending) this.held.delete(id);
    });
    this.held.set(id, pending);
    while (this.held.size > MAX_SESSIONS) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
    return pending;
  }
}
