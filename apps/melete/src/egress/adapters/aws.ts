/**
 * AWS for the agent's computer: the `aws` command line and the SDKs, which
 * sign every request with Signature Version 4.
 *
 * Commands in the computer hold a placeholder key and sign with it. The relay
 * reads that signature only to learn the service and region it was made for,
 * drops it, and signs the same request again with the account: the stored
 * access key, or a session of the role the service assumes for each command
 * (named after that command, so CloudTrail shows it). The real key and the
 * session's keys stay in the service.
 *
 * Reads go out signed. Everything else is a write that asks first, bound to
 * the exact request:
 *
 * - query, JSON and CBOR services by their operation (`Action`,
 *   `X-Amz-Target`, or the operation in the path): names that begin with
 *   Get, List, Describe, Head, Query, Scan, BatchGet, Select, Lookup or
 *   Search read, everything else asks;
 * - S3 by method, bucket, key and subresource: GET and HEAD read, and every
 *   other request asks, except the parts of a multipart upload, which change
 *   nothing until the upload is completed, and that completion asks;
 * - other REST services read with GET and HEAD only where listed.
 *
 * Unknown means write: a request whose operation cannot be read, or that
 * names one twice, asks. Operations that hand out credentials (assuming a
 * role, minting a session or an access key, a registry token) are refused,
 * because their answer would put a secret in the computer; reading a stored
 * secret asks. A request signed with anything but the placeholder (a real
 * key in a file, a session token, a presigned URL) is refused and never
 * sent; a request with no signature at all goes out as it is, without the
 * account, as it would to any other host. Chunk-signed uploads are refused
 * with a plain message.
 */
import { createHash } from 'node:crypto';
import type { JsonObject } from '@melete/contracts';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import {
  AWS_REGION,
  AwsSessions,
  type AwsAccessKey,
  callerIdentity,
  parseAwsSecret,
  ROLE_ARN,
  StsError,
  type StsOptions,
} from '../aws-session.ts';
import {
  hasQuerySignature,
  parseSigV4Authorization,
  queryParameters,
  type SigV4Authorization,
  signRequest,
} from '../sigv4.ts';
import { canonicalBody, shownBody, shownText } from './generic.ts';
import {
  AccountUnusable,
  type CardSummary,
  type Classification,
  type ClassifiedWrite,
  type CredentialAdapter,
  type InterceptedRequest,
  type OutboundRequest,
  type UpstreamResponse,
  withinConstraint,
} from './types.ts';

/** What the computer's commands sign with in place of the account. */
export const AWS_KEY_PLACEHOLDER = 'AKIAMELETEPLACEHOLDER0';
export const AWS_SECRET_PLACEHOLDER = 'melete-proxy-signs-this';
export const AWS_SUFFIX = 'amazonaws.com';

export const awsAdapterConfig = z.strictObject({
  /** The region commands use unless they name another, and where a role is assumed. */
  region: z.string().regex(AWS_REGION),
  /** A role the service assumes for each command, with the stored key. */
  role_arn: z.string().max(2048).regex(ROLE_ARN).optional(),
  external_id: z
    .string()
    .regex(/^[\w+=,.@:/-]{2,1224}$/)
    .optional(),
});
export type AwsAdapterConfig = z.infer<typeof awsAdapterConfig>;

/**
 * Headers AWS clients change on every run of the same command: the signing
 * date, the SDK's own request ids and retry count, and trace ids. Forwarded,
 * signed again where they are signed, and never bound.
 */
export const AWS_VOLATILE_HEADERS = [
  'x-amz-date',
  'amz-sdk-invocation-id',
  'amz-sdk-request',
  'x-amz-user-agent',
  'x-amzn-trace-id',
] as const;

const READ_OPERATION =
  /^(?:Get|List|Describe|Head|Query|Scan|BatchGet|Select|Lookup|Search|Filter)(?:[A-Z0-9]|$)/;
const DESTRUCTIVE_OPERATION =
  /^(?:Delete|Terminate|Remove|Destroy|Purge|Deregister|Disassociate|Detach|Revoke|Cancel|Stop|Reset|Put|Replace|Overwrite)(?:[A-Z0-9]|$)/;
/** Operations named on the card as ones that may cost money. */
const SPEND_OPERATION =
  /^(?:RunInstances|RequestSpotInstances|RequestSpotFleet|CreateFleet|CreateDBInstance|CreateDBCluster|CreateCluster|CreateNatGateway|PurchaseReserved\w*|PurchaseHostReservation|PurchaseOffering|RestoreObject|StartQueryExecution)$/;

/**
 * Operations whose answer is a credential: a role or federation session, a
 * new access key, a registry or database token, an S3 Express session. Sent
 * with the account, they would put a secret in the computer.
 */
const MINTS: Record<string, readonly string[]> = {
  sts: [
    'AssumeRole',
    'AssumeRoleWithSAML',
    'AssumeRoleWithWebIdentity',
    'AssumeRoot',
    'GetSessionToken',
    'GetFederationToken',
    'GetWebIdentityToken',
  ],
  iam: ['CreateAccessKey', 'CreateServiceSpecificCredential', 'ResetServiceSpecificCredential'],
  sso: ['GetRoleCredentials'],
  'cognito-identity': [
    'GetCredentialsForIdentity',
    'GetOpenIdToken',
    'GetOpenIdTokenForDeveloperIdentity',
  ],
  ecr: ['GetAuthorizationToken'],
  'ecr-public': ['GetAuthorizationToken'],
  codeartifact: ['GetAuthorizationToken'],
  redshift: ['GetClusterCredentials', 'GetClusterCredentialsWithIAM'],
  'redshift-serverless': ['GetCredentials'],
  lightsail: ['GetInstanceAccessDetails', 'GetRelationalDatabaseMasterUserPassword'],
  s3express: ['CreateSession'],
};

/** Reads by name whose answer is a stored secret: they ask like a change. */
const SECRET_READS: Record<string, readonly string[]> = {
  secretsmanager: ['GetSecretValue', 'BatchGetSecretValue'],
  ec2: ['GetPasswordData'],
};
/** Parameter reads ask when they decrypt. */
const PARAMETER_READS = new Set(['GetParameter', 'GetParameters', 'GetParametersByPath']);

/** REST services whose GET and HEAD only read. Any other REST service asks for everything. */
const REST_READ_SERVICES = new Set([
  'lambda',
  'eks',
  'route53',
  'cloudfront',
  'apigateway',
  'elasticfilesystem',
  'appsync',
  'glacier',
]);

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: () => false });

// ---------------------------------------------------------------- reading the request

const PRESIGNED =
  'A presigned URL made in the agent’s computer is signed with the placeholder key and is not sent. Run the `aws` command itself; Melete signs it with the connected account.';
const NOT_PLACEHOLDER =
  'This request is signed with credentials other than the placeholder Melete set, so it was not sent. Remove other AWS keys, profiles and session tokens from the command so the connected account is used.';
const CHUNK_SIGNED =
  'Chunk-signed uploads (STREAMING-AWS4-HMAC-SHA256-PAYLOAD) are not supported through Melete yet, so nothing was sent. Upload with the aws command line, which signs uploads whole or unsigned.';
const S3_EXPRESS =
  'S3 directory buckets (S3 Express One Zone) hand their own session keys to the client, which would put a secret in the computer, so this was not sent.';

/** The S3 endpoint a host names: a bucket in the host, path-style, the control API or an access point. */
type S3Host = { kind: 'data' | 'control' | 'access_point'; bucket: string | null };

function s3Host(host: string): S3Host | null {
  if (!withinConstraint(host, AWS_SUFFIX)) return null;
  const labels = host.slice(0, -AWS_SUFFIX.length - 1).split('.');
  const at = labels.findIndex(
    (label) => label === 's3' || (label.startsWith('s3-') && !label.startsWith('s3express')),
  );
  if (at < 0) return null;
  const label = labels[at] ?? '';
  const before = labels.slice(0, at).join('.') || null;
  if (label === 's3-control') return { kind: 'control', bucket: null };
  if (label === 's3-accesspoint') return { kind: 'access_point', bucket: before };
  return { kind: 'data', bucket: before };
}

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** Query parameters that pick which version or part a request is about, not a subresource. */
const NOT_SUBRESOURCES = new Set([
  'x-id',
  'versionId',
  'partNumber',
  'uploadId',
  'list-type',
  'prefix',
  'delimiter',
  'encoding-type',
  'max-keys',
  'continuation-token',
  'start-after',
  'fetch-owner',
  'key-marker',
  'version-id-marker',
  'marker',
  'max-uploads',
  'upload-id-marker',
  'max-parts',
  'part-number-marker',
  'select-type',
]);
const SUBRESOURCE_NAMES: Record<string, string> = {
  acl: 'Acl',
  policy: 'Policy',
  tagging: 'Tagging',
  lifecycle: 'LifecycleConfiguration',
  cors: 'Cors',
  website: 'Website',
  versioning: 'Versioning',
  encryption: 'Encryption',
  replication: 'Replication',
  notification: 'NotificationConfiguration',
  logging: 'Logging',
  publicAccessBlock: 'PublicAccessBlock',
  ownershipControls: 'OwnershipControls',
  retention: 'Retention',
  'legal-hold': 'LegalHold',
  'object-lock': 'ObjectLockConfiguration',
  accelerate: 'AccelerateConfiguration',
  requestPayment: 'RequestPayment',
  inventory: 'InventoryConfiguration',
  metrics: 'MetricsConfiguration',
  analytics: 'AnalyticsConfiguration',
  'intelligent-tiering': 'IntelligentTieringConfiguration',
};

type S3Operation = {
  name: string;
  /** A read, or a part of a multipart upload: nothing anyone sees changes. */
  passes: boolean;
  destructive: boolean;
};

function s3Operation(
  method: string,
  key: string,
  parameters: Record<string, string | string[]>,
  headers: Record<string, string>,
): S3Operation | 'credential' {
  const has = (name: string) => name in parameters;
  if (has('session')) return 'credential';
  const subresources = Object.keys(parameters).filter((name) => !NOT_SUBRESOURCES.has(name));
  if (method === 'GET' || method === 'HEAD')
    return { name: method === 'HEAD' ? 'Head' : 'Get', passes: true, destructive: false };
  const level = key ? 'Object' : 'Bucket';
  const sub = subresources.length === 1 ? subresources[0] : undefined;
  const named = sub ? SUBRESOURCE_NAMES[sub] : undefined;
  if (method === 'POST') {
    if (has('select') && key)
      return { name: 'SelectObjectContent', passes: true, destructive: false };
    if (has('delete') && !key) return { name: 'DeleteObjects', passes: false, destructive: true };
    if (has('uploads') && key)
      return { name: 'CreateMultipartUpload', passes: false, destructive: false };
    if (has('uploadId') && key && !subresources.length)
      return { name: 'CompleteMultipartUpload', passes: false, destructive: true };
    if (has('restore') && key) return { name: 'RestoreObject', passes: false, destructive: false };
    return { name: `Post${level}`, passes: false, destructive: false };
  }
  if (method === 'PUT') {
    // A part changes nothing anyone sees until the upload is completed, which asks.
    if (has('partNumber') && has('uploadId') && key && !subresources.length)
      return {
        name: headers['x-amz-copy-source'] ? 'UploadPartCopy' : 'UploadPart',
        passes: true,
        destructive: false,
      };
    if (!subresources.length) {
      if (!key) return { name: 'CreateBucket', passes: false, destructive: false };
      return {
        name: headers['x-amz-copy-source'] ? 'CopyObject' : 'PutObject',
        passes: false,
        destructive: true,
      };
    }
    return { name: `Put${level}${named ?? ''}`, passes: false, destructive: true };
  }
  if (method === 'DELETE') {
    if (has('uploadId') && key && !subresources.length)
      return { name: 'AbortMultipartUpload', passes: false, destructive: false };
    return { name: `Delete${level}${named ?? ''}`, passes: false, destructive: true };
  }
  return { name: method, passes: false, destructive: true };
}

/** The keys a DeleteObjects body names, or null when it cannot be read. */
function deletedKeys(body: Buffer): string[] | null {
  try {
    const parsed = xml.parse(body.toString('utf8')) as {
      Delete?: { Object?: unknown };
    };
    const objects = parsed.Delete?.Object;
    const list = Array.isArray(objects) ? objects : objects ? [objects] : [];
    const keys = list.map((each) => (each as { Key?: unknown })?.Key);
    return keys.every((key) => typeof key === 'string') ? (keys as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * An `aws-chunked` body as the bytes it carries, for showing only: the
 * approval is bound to the bytes as sent.
 */
function unchunked(request: InterceptedRequest): InterceptedRequest {
  if (!/\baws-chunked\b/i.test(request.headers['content-encoding'] ?? '')) return request;
  const parts: Buffer[] = [];
  let offset = 0;
  const body = request.body;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const line = body.indexOf('\r\n', offset);
    if (line < 0) return request;
    const size = Number.parseInt(
      body.subarray(offset, line).toString('latin1').split(';')[0] ?? '',
      16,
    );
    if (Number.isNaN(size)) return request;
    if (size === 0) return { ...request, body: Buffer.concat(parts) };
    parts.push(body.subarray(line + 2, line + 2 + size));
    offset = line + 2 + size + 2;
  }
  return request;
}

function card(
  request: InterceptedRequest,
  title: string,
  facts: CardSummary['facts'],
  spend: boolean,
): CardSummary {
  const target = `${request.path}${request.query ? `?${request.query}` : ''}`;
  const shown = unchunked(request);
  return {
    title,
    facts: [
      { label: 'Request', value: `${request.method} https://${request.host}${target}` },
      ...facts,
      ...(spend ? [{ label: 'Cost', value: 'This may cost money.' }] : []),
      { label: 'Details', value: shownBody(shown, canonicalBody(shown)) },
    ],
  };
}

/**
 * An idempotency token the SDK makes up for each call (`ClientToken` on
 * `RunInstances`, `clientRequestToken` and the like): a fresh UUID on every
 * run of the same command, which only lets AWS spot a retry. The approval
 * binds the body with that one value blanked, and the field's name kept, so
 * running the command again after approval is the same change. A body with
 * no such token, or more than one, is bound byte for byte.
 */
const GENERATED_TOKEN =
  '(?:ClientToken|ClientRequestToken|clientToken|clientRequestToken|IdempotencyToken|idempotencyToken)';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const FORM_TOKEN = new RegExp(`((?:^|&)${GENERATED_TOKEN}=)${UUID}(?=&|$)`, 'g');
const JSON_TOKEN = new RegExp(String.raw`("${GENERATED_TOKEN}"\s*:\s*")${UUID}(")`, 'g');

function withoutGeneratedToken(request: InterceptedRequest): JsonObject | undefined {
  const text = request.body.toString('utf8');
  if (Buffer.byteLength(text) !== request.body.length) return undefined;
  for (const pattern of [FORM_TOKEN, JSON_TOKEN]) {
    const found = text.match(pattern);
    if (found?.length !== 1) continue;
    const blanked = text.replace(
      pattern,
      (_match, before: string, after?: string) => `${before}<generated>${after ?? ''}`,
    );
    return {
      body_sha256: createHash('sha256').update(blanked).digest('hex'),
      body_bytes: request.body.length,
      generated_token_blanked: true,
    };
  }
  return undefined;
}

function write(
  request: InterceptedRequest,
  signed: SigV4Authorization,
  operation: string,
  resource: string | null,
  destructive: boolean,
  facts: CardSummary['facts'] = [],
): Classification {
  const spend = SPEND_OPERATION.test(operation);
  const generated = signed.service === 's3' ? undefined : withoutGeneratedToken(request);
  const where = resource ? ` on ${resource}` : ` in ${signed.region}`;
  return {
    kind: 'write',
    operation,
    payload: {
      host: request.host,
      method: request.method,
      url_path: request.path,
      query: request.query,
      service: signed.service,
      region: signed.region,
      action: operation,
      ...(resource ? { resource } : {}),
    },
    summary: card(
      request,
      `${signed.service}:${operation}${where}`,
      [
        { label: 'Operation', value: `${signed.service}:${operation}` },
        { label: 'Region', value: signed.region },
        ...facts,
      ],
      spend,
    ),
    destructive,
    ...(generated ? { boundBody: generated } : {}),
  };
}

function classifyS3(
  request: InterceptedRequest,
  signed: SigV4Authorization,
  endpoint: S3Host,
): Classification {
  if (endpoint.kind === 'control') {
    // The S3 control API (access points, batch jobs, account settings): REST.
    if (request.method === 'GET' || request.method === 'HEAD') return { kind: 'read' };
    return write(
      request,
      signed,
      `${request.method} ${request.path}`,
      null,
      request.method !== 'POST',
    );
  }
  const segments = request.path.split('/').slice(1);
  let bucket = endpoint.bucket;
  if (!bucket) {
    bucket = decode(segments.shift() ?? '') || null;
  }
  const key = segments.length ? decode(segments.join('/')) : '';
  if (key === null) return write(request, signed, `${request.method} ${request.path}`, null, true);
  const parameters = queryParameters(request.query);
  const operation = s3Operation(request.method, key, parameters, request.headers);
  if (operation === 'credential') return { kind: 'refuse', reason: S3_EXPRESS };
  if (operation.passes) return { kind: 'read' };
  const version = typeof parameters.versionId === 'string' ? parameters.versionId : null;
  const resource = bucket ? `${bucket}${key ? `/${key}` : ''}` : null;
  const facts: CardSummary['facts'] = [];
  if (version) facts.push({ label: 'Version', value: version });
  const source = request.headers['x-amz-copy-source'];
  if (source) facts.push({ label: 'Copied from', value: source });
  if (operation.name === 'DeleteObjects') {
    const keys = deletedKeys(request.body);
    facts.push({
      label: 'Objects',
      value: keys
        ? shownText(`${keys.length} object${keys.length === 1 ? '' : 's'}:\n${keys.join('\n')}`)
        : 'The list of objects could not be read; it is under Details.',
    });
  }
  return write(request, signed, operation.name, resource, operation.destructive, facts);
}

/** The operation a query, JSON or CBOR request names, or null when it names none or two. */
function operationOf(request: InterceptedRequest): string | null | 'ambiguous' {
  const found: string[] = [];
  const target = request.headers['x-amz-target'];
  if (target !== undefined) {
    const name = target.slice(target.lastIndexOf('.') + 1);
    found.push(name);
  }
  const cbor = /^\/service\/[^/]+\/operation\/([^/]+)$/.exec(request.path);
  if (cbor?.[1]) found.push(decode(cbor[1]) ?? '');
  const fromQuery = queryParameters(request.query).Action;
  if (fromQuery !== undefined) found.push(...(Array.isArray(fromQuery) ? fromQuery : [fromQuery]));
  if (/^application\/x-www-form-urlencoded\b/i.test(request.headers['content-type'] ?? '')) {
    const form = new URLSearchParams(request.body.toString('utf8')).getAll('Action');
    found.push(...form);
  }
  if (found.length > 1) return 'ambiguous';
  const [name] = found;
  if (name === undefined) return null;
  return /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(name) ? name : 'ambiguous';
}

/** Whether a parameter read asks for decrypted values (or cannot be read to say). */
function decrypts(request: InterceptedRequest): boolean {
  try {
    const value = JSON.parse(request.body.toString('utf8')) as { WithDecryption?: unknown };
    return value?.WithDecryption !== false && value?.WithDecryption !== undefined;
  } catch {
    return true;
  }
}

function classifyService(request: InterceptedRequest, signed: SigV4Authorization): Classification {
  const { service } = signed;
  const operation = operationOf(request);
  if (operation === 'ambiguous')
    return write(request, signed, `${request.method} ${request.path}`, null, true);
  if (operation === null) {
    if (REST_READ_SERVICES.has(service) && (request.method === 'GET' || request.method === 'HEAD'))
      return { kind: 'read' };
    return write(
      request,
      signed,
      `${request.method} ${request.path}`,
      null,
      request.method === 'DELETE' || request.method === 'PUT',
    );
  }
  if (MINTS[service]?.includes(operation))
    return {
      kind: 'refuse',
      reason: `${service}:${operation} hands out credentials, which would put a secret in the agent’s computer, so it was not sent.`,
    };
  const secretRead =
    SECRET_READS[service]?.includes(operation) ||
    (service === 'ssm' && PARAMETER_READS.has(operation) && decrypts(request));
  if (!secretRead && READ_OPERATION.test(operation)) return { kind: 'read' };
  return write(
    request,
    signed,
    operation,
    null,
    !secretRead && DESTRUCTIVE_OPERATION.test(operation),
    secretRead ? [{ label: 'Reads a secret', value: 'The answer holds a stored secret.' }] : [],
  );
}

function classify(request: InterceptedRequest): Classification {
  if (hasQuerySignature(request.query)) return { kind: 'refuse', reason: PRESIGNED };
  // No signature at all: it carries nothing of the account, and goes out as it is.
  if (request.authorization === undefined) return { kind: 'read' };
  const signed = parseSigV4Authorization(request.authorization);
  if (
    !signed ||
    signed.accessKeyId !== AWS_KEY_PLACEHOLDER ||
    request.headers['x-amz-security-token'] !== undefined
  )
    return { kind: 'refuse', reason: NOT_PLACEHOLDER };
  const payload = request.headers['x-amz-content-sha256'] ?? '';
  if (/^STREAMING-(?!UNSIGNED-PAYLOAD-TRAILER$)/.test(payload))
    return { kind: 'refuse', reason: CHUNK_SIGNED };
  if (signed.service === 's3express') return { kind: 'refuse', reason: S3_EXPRESS };
  const endpoint = s3Host(request.host);
  // S3 is classified by its own rules; a request signed for one and sent to the other is refused.
  if ((signed.service === 's3') !== (endpoint !== null))
    return {
      kind: 'refuse',
      reason: `This request is signed for ${signed.service} but sent to ${request.host}, so it was not sent.`,
    };
  return endpoint ? classifyS3(request, signed, endpoint) : classifyService(request, signed);
}

// ---------------------------------------------------------------- answers

const s3Error = (body: Buffer): { code: string | null; message: string | null } | null => {
  const text = body.toString('utf8');
  if (!/<Error>/.test(text)) return null;
  try {
    const parsed = xml.parse(text) as { Error?: { Code?: unknown; Message?: unknown } };
    const code = parsed.Error?.Code;
    const message = parsed.Error?.Message;
    return {
      code: typeof code === 'string' ? code.slice(0, 100) : null,
      message: typeof message === 'string' ? message.slice(0, 300) : null,
    };
  } catch {
    return { code: null, message: null };
  }
};

function receipt(write: ClassifiedWrite, upstream: UpstreamResponse): JsonObject {
  const header = (name: string) => upstream.headers[name]?.slice(0, 200) ?? null;
  const detail: JsonObject = {
    service: String(write.payload.service ?? ''),
    region: String(write.payload.region ?? ''),
    resource: typeof write.payload.resource === 'string' ? write.payload.resource : null,
    request_id: header('x-amz-request-id') ?? header('x-amzn-requestid'),
  };
  if (write.payload.service === 's3') {
    const etag = header('etag');
    const version = header('x-amz-version-id');
    if (etag) detail.etag = etag;
    if (version) detail.version_id = version;
    if (write.operation === 'DeleteObjects') {
      const text = upstream.body.toString('utf8');
      detail.deleted = (text.match(/<Deleted>/g) ?? []).length;
      detail.errors = (text.match(/<Error>/g) ?? []).length;
    }
  }
  return detail;
}

/** A 2xx answer that still says the change did not happen. */
function rejected(write: ClassifiedWrite, upstream: UpstreamResponse): string | null {
  if (upstream.status >= 300 || write.operation !== 'DeleteObjects') return null;
  const text = upstream.body.toString('utf8');
  if (/<Error>/.test(text) && !/<Deleted>/.test(text))
    return 'AWS deleted none of the objects; each one answered with an error.';
  return null;
}

/**
 * S3 can answer a copy or the completion of an upload with 200 and an error
 * in the body, after the work may have begun.
 */
function uncertain(write: ClassifiedWrite, upstream: UpstreamResponse): string | null {
  if (upstream.status >= 300) return null;
  if (write.operation !== 'CopyObject' && write.operation !== 'CompleteMultipartUpload')
    return null;
  const error = s3Error(upstream.body);
  if (!error) return null;
  return `AWS answered with an error (${error.code ?? 'no code'}) after starting this change, so it may still have taken effect. Check before asking for it again.`;
}

const escapeXml = (text: string) =>
  text.replace(/[<>&'"]/g, (char) =>
    char === '<'
      ? '&lt;'
      : char === '>'
        ? '&gt;'
        : char === '&'
          ? '&amp;'
          : char === "'"
            ? '&apos;'
            : '&quot;',
  );

/** A held or refused write, answered as AWS errors are, so `aws` prints the message. */
function heldAnswer(
  request: InterceptedRequest,
  write: ClassifiedWrite,
  message: string,
  status: number,
): UpstreamResponse | null {
  const code = 'ApprovalRequired';
  const text = escapeXml(message);
  const answer = (contentType: string, body: string, errorType = false): UpstreamResponse => ({
    status,
    headers: { 'content-type': contentType, ...(errorType ? { 'x-amzn-errortype': code } : {}) },
    body: Buffer.from(body),
  });
  if (write.payload.service === 's3')
    return answer(
      'application/xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>${text}</Message><RequestId>melete</RequestId></Error>`,
    );
  if (request.headers['x-amz-target'] !== undefined)
    return answer('application/x-amz-json-1.1', JSON.stringify({ __type: code, message }), true);
  // A CBOR client reads only CBOR: it gets the relay's plain answer and status.
  if (request.headers['smithy-protocol'] !== undefined) return null;
  const contentType = request.headers['content-type'] ?? '';
  if (
    /^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType.trim()) ||
    'Action' in queryParameters(request.query)
  )
    return answer(
      'text/xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${text}</Message></Error><RequestId>melete</RequestId></ErrorResponse>`,
    );
  return answer('application/json', JSON.stringify({ message }), true);
}

// ---------------------------------------------------------------- the adapter

function keyOf(secret: string): AwsAccessKey {
  try {
    return parseAwsSecret(secret);
  } catch {
    throw new AccountUnusable('the stored AWS key cannot be read');
  }
}

/** The AWS adapter, assuming roles through `sts` (a test points it at a stand-in). */
export function createAwsAdapter(
  options: { sts?: StsOptions } = {},
): CredentialAdapter<AwsAdapterConfig> {
  const sessions = new AwsSessions(options.sts ?? {});
  return {
    id: 'aws',
    constraints: [AWS_SUFFIX],
    parseConfig: (value) => awsAdapterConfig.parse(value),
    hosts: () => [`.${AWS_SUFFIX}`],
    placeholders: (config) => ({
      AWS_ACCESS_KEY_ID: AWS_KEY_PLACEHOLDER,
      AWS_SECRET_ACCESS_KEY: AWS_SECRET_PLACEHOLDER,
      AWS_REGION: config.region,
    }),
    // The region is a plain value that appears in ordinary headers; only the key stands in.
    standIns: () => [AWS_KEY_PLACEHOLDER, AWS_SECRET_PLACEHOLDER],
    volatileHeaders: AWS_VOLATILE_HEADERS,
    classify,
    async authorize(request: OutboundRequest, secret, config, context) {
      const signed = parseSigV4Authorization(context.authorization);
      // Unsigned: it goes out as it is, without the account.
      if (!signed) return request;
      if (signed.accessKeyId !== AWS_KEY_PLACEHOLDER)
        throw new AccountUnusable('the request is not signed with the placeholder key');
      const key = keyOf(secret);
      let credentials: Awaited<ReturnType<AwsSessions['credentials']>>;
      try {
        credentials = await sessions.credentials({
          key,
          roleArn: config.role_arn,
          externalId: config.external_id,
          region: config.region,
          command: context.command,
        });
      } catch (error) {
        throw new AccountUnusable(
          error instanceof StsError && error.status !== 0
            ? `AWS did not let the account assume its role (${error.code.replace(/[^\w]/g, '').slice(0, 60) || error.status})`
            : 'AWS could not be reached to assume the account’s role',
        );
      }
      const mark = request.target.indexOf('?');
      const headers = await signRequest({
        method: request.method,
        host: request.host,
        path: mark < 0 ? request.target : request.target.slice(0, mark),
        query: mark < 0 ? '' : request.target.slice(mark + 1),
        headers: request.headers,
        body: request.body,
        region: signed.region,
        service: signed.service,
        credentials,
      });
      return {
        ...request,
        headers,
        redactions: credentials.sessionToken
          ? [credentials.secretAccessKey, credentials.sessionToken]
          : [],
      };
    },
    redactions(secret) {
      try {
        return [secret, parseAwsSecret(secret).secret_access_key];
      } catch {
        return [secret];
      }
    },
    receipt,
    rejected,
    uncertain,
    heldAnswer,
  };
}

export const awsAdapter = createAwsAdapter();

/** What AWS says about a key: the identity it acts as, or why it was refused. */
export type AwsAccountCheck =
  | { ok: true; arn: string }
  | { ok: false; code: 'credential_refused' | 'unavailable' };

const REFUSALS = new Set([
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'ExpiredToken',
  'UnrecognizedClientException',
  'AuthFailure',
]);

/**
 * Asks AWS, from the service, whose key this is: `GetCallerIdentity`, after
 * assuming the role when one is named. Answers the identity's ARN.
 */
export async function awsAccount(
  key: AwsAccessKey,
  config: AwsAdapterConfig,
  options: StsOptions = {},
): Promise<AwsAccountCheck> {
  try {
    const credentials = await new AwsSessions(options).credentials({
      key,
      roleArn: config.role_arn,
      externalId: config.external_id,
      region: config.region,
      command: 'check',
    });
    const identity = await callerIdentity(credentials, config.region, options);
    return { ok: true, arn: identity.arn.slice(0, 200) };
  } catch (error) {
    if (
      error instanceof StsError &&
      error.status !== 0 &&
      (REFUSALS.has(error.code) || error.status === 403)
    )
      return { ok: false, code: 'credential_refused' };
    return { ok: false, code: 'unavailable' };
  }
}
