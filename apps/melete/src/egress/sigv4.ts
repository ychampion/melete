/**
 * AWS Signature Version 4, as the egress relay needs it: reading the
 * signature a command in the computer made with the placeholder key, and
 * signing the same request again with the account's real credentials.
 *
 * The signing itself is `@smithy/signature-v4` (Apache-2.0), the signer the
 * AWS SDK for JavaScript uses. This module only adapts a request as the relay
 * holds it (raw path and query, lower-case headers, whole body) to it, and
 * reads the `Authorization` header a client sent.
 */
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** What a client's SigV4 `Authorization` header says about who signed it, and for what. */
export type SigV4Authorization = {
  accessKeyId: string;
  /** `YYYYMMDD` */
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
};

/** The parts of a SigV4 credential scope: letters, digits and dashes only. */
const SCOPE_PART = /^[a-z0-9-]{1,64}$/;
const DATE = /^\d{8}$/;

/**
 * Reads `AWS4-HMAC-SHA256 Credential=KEY/DATE/REGION/SERVICE/aws4_request,
 * SignedHeaders=a;b, Signature=hex`. Null for anything else, including a
 * header that names a part twice.
 */
export function parseSigV4Authorization(header: string | undefined): SigV4Authorization | null {
  if (!header) return null;
  const value = header.trim();
  if (!value.startsWith(`${SIGV4_ALGORITHM} `)) return null;
  const parts = new Map<string, string>();
  for (const piece of value.slice(SIGV4_ALGORITHM.length + 1).split(',')) {
    const item = piece.trim();
    const equals = item.indexOf('=');
    if (equals <= 0) return null;
    const name = item.slice(0, equals);
    if (parts.has(name)) return null;
    parts.set(name, item.slice(equals + 1));
  }
  const credential = parts.get('Credential');
  const signedHeaders = parts.get('SignedHeaders');
  const signature = parts.get('Signature');
  if (!credential || !signedHeaders || !signature || parts.size !== 3) return null;
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const scope = credential.split('/');
  if (scope.length !== 5 || scope[4] !== 'aws4_request') return null;
  const [accessKeyId, date, region, service] = scope as [string, string, string, string];
  if (!accessKeyId || !DATE.test(date) || !SCOPE_PART.test(region) || !SCOPE_PART.test(service))
    return null;
  return {
    accessKeyId,
    date,
    region,
    service,
    signedHeaders: signedHeaders.split(';'),
  };
}

/** Whether a query carries a presigned URL's signature. */
export function hasQuerySignature(query: string): boolean {
  return /(?:^|&)x-amz-(?:signature|credential|algorithm|security-token)=/i.test(query);
}

/** A query string's parameters, decoded, as the signer canonicalizes them. */
export function queryParameters(query: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!query) return out;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const key = decodeURIComponent(equals < 0 ? pair : pair.slice(0, equals));
    const value = equals < 0 ? '' : decodeURIComponent(pair.slice(equals + 1));
    const seen = out[key];
    if (seen === undefined) out[key] = value;
    else out[key] = Array.isArray(seen) ? [...seen, value] : [seen, value];
  }
  return out;
}

/** SHA-256 and HMAC-SHA256 from the runtime, in the shape the signer takes. */
class RuntimeSha256 {
  private readonly hash: Hash | Hmac;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash =
      secret === undefined
        ? createHash('sha256')
        : createHmac(
            'sha256',
            typeof secret === 'string'
              ? secret
              : Buffer.from(
                  ArrayBuffer.isView(secret)
                    ? new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength)
                    : new Uint8Array(secret),
                ),
          );
  }
  update(data: string | ArrayBuffer | ArrayBufferView) {
    this.hash.update(
      typeof data === 'string'
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data),
    );
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
  reset() {
    throw new Error('not used');
  }
}

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

/** Headers a signature never covers: they say nothing about the request, or change on the way. */
const UNSIGNED = new Set(['user-agent', 'x-amzn-trace-id', 'expect', 'content-length']);

/**
 * The request signed with `credentials` for `service` in `region`: every
 * header it carries (but the few above) and the host, its exact path and
 * query, and its body (or the payload hash the client named in
 * `x-amz-content-sha256`, such as `UNSIGNED-PAYLOAD`). Any earlier
 * signature, date or session token is replaced.
 */
export async function signRequest(input: {
  method: string;
  host: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Buffer;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now?: Date;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'x-amz-date' || lower === 'x-amz-security-token')
      continue;
    headers[lower] = value;
  }
  headers.host = input.host;
  const signer = new SignatureV4({
    credentials: input.credentials,
    region: input.region,
    service: input.service,
    sha256: RuntimeSha256,
    // S3 signs the path exactly as sent; every other service escapes it again.
    uriEscapePath: input.service !== 's3',
    applyChecksum: false,
  });
  const signed = await signer.sign(
    {
      method: input.method,
      protocol: 'https:',
      hostname: input.host,
      path: input.path,
      query: queryParameters(input.query),
      headers,
      body: input.body,
    },
    { signingDate: input.now ?? new Date(), unsignableHeaders: UNSIGNED },
  );
  return signed.headers as Record<string, string>;
}
