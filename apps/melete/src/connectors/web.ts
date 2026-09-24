import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ConnectorManifest } from '@melete/contracts';
import type { Connector } from './types.ts';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type WebResponse = { status: number; headers: Record<string, string>; body: string };
export type WebTransport = (
  url: URL,
  address: ResolvedAddress,
  options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number; accept?: string },
) => Promise<WebResponse>;

function ipv6Number(address: string): bigint | undefined {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const octets = value
      .slice(separator + 1)
      .split('.')
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    )
      return undefined;
    value = `${value.slice(0, separator)}:${((octets[0] as number) * 256 + (octets[1] as number)).toString(16)}:${((octets[2] as number) * 256 + (octets[3] as number)).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.reduce((sum, part) => (sum << 16n) | BigInt(`0x${part}`), 0n);
}

/** Only globally routable unicast is usable, including for literal and mapped IPs. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0] as number;
    const b = octets[1] as number;
    const c = octets[2] as number;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes('%')) return false;
  const value = ipv6Number(address);
  if (value === undefined) return false;
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return isPublicAddress(`${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
  }
  // Deny local, multicast, translation, transition, documentation, and reserved ranges.
  return (
    value >> 125n === 1n &&
    value >> 96n !== 0x20010db8n &&
    value >> 112n !== 0x2002n &&
    value >> 105n !== 0x20010000000000000000000000000000n >> 105n
  );
}

/** Every answer a name gives, so one private answer among public ones is still seen. */
export const resolveHost = async (hostname: string): Promise<ResolvedAddress[]> =>
  (await lookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

/**
 * The address a request is sent to: the first answer, and only when every
 * answer is globally routable. Shared by everything that reads an address a
 * person or a model supplied.
 */
export function publicPin(addresses: readonly ResolvedAddress[]): ResolvedAddress | undefined {
  if (
    addresses.some(
      (address) => !isPublicAddress(address.address) || isIP(address.address) !== address.family,
    )
  )
    return undefined;
  return addresses[0];
}

/** The transport never resolves again: Host/SNI use the URL while lookup returns the checked IP. */
export const pinnedWebRequest: WebTransport = (url, address, options) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = request(
      url,
      {
        agent: false,
        signal: options.signal,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_name, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          accept: options.accept ?? 'text/plain, text/html, application/json',
          'user-agent': 'Melete/0.1',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy(new Error('web response exceeds the size limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('error', reject);
        response.once('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              headers[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({
            status: response.statusCode ?? 502,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('web request timed out')),
      options.timeoutMs,
    );
    req.once('close', () => clearTimeout(timer));
    // A refused certificate or a reset is reported by the request and again by
    // its socket; the second must land on a listener, not end the process.
    req.on('error', reject);
    req.end();
  });

export const webManifest: ConnectorManifest = {
  name: 'web',
  version: '0.1.0',
  provider: 'web',
  description: 'Fetch public web addresses within the trusted job compartment.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'web.fetch',
      description: 'Fetch an HTTP(S) URL. Its full query string is recorded with the action.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri' } },
        required: ['url'],
        additionalProperties: false,
      },
      effect_class: 'read',
      required_scopes: ['web.fetch'],
      verify: false,
      requires_approval: false,
    },
  ],
};

export function createWebConnector(
  options: {
    resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
    transport?: WebTransport;
    maxRedirects?: number;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Connector {
  const resolve = options.resolve ?? resolveHost;
  const transport = options.transport ?? pinnedWebRequest;
  return {
    manifest: webManifest,
    async execute(action, ctx) {
      if (action.kind !== 'web.fetch') throw new Error('unknown web tool');
      if (
        action.job_id !== ctx.job_id ||
        action.id !== ctx.idempotency_key ||
        action.idempotency_key !== action.id
      )
        throw new Error('connector action identity mismatch');
      const originalUrl = action.canonical_payload.url;
      if (typeof originalUrl !== 'string') throw new Error('url must be a string');
      let url = new URL(originalUrl);
      const visited: string[] = [];
      for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop += 1) {
        ctx.signal?.throwIfAborted();
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('only HTTP(S) URLs without credentials are allowed');
        }
        const hostname = url.hostname
          .replace(/^\[|\]$/g, '')
          .replace(/\.$/, '')
          .toLowerCase();
        if (
          !ctx.constraints.public_compartment &&
          !ctx.constraints.allowed_domains.some(
            (domain) => domain.toLowerCase().replace(/\.$/, '') === hostname,
          )
        ) {
          throw new Error('private-context job cannot fetch this domain');
        }
        const family = isIP(hostname);
        const addresses: ResolvedAddress[] = family
          ? [{ address: hostname, family: family as 4 | 6 }]
          : await resolve(hostname);
        const pinned = publicPin(addresses);
        if (!pinned) throw new Error('URL resolves to a non-public address');
        visited.push(url.href);
        const response = await transport(url, pinned, {
          signal: ctx.signal,
          maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
          timeoutMs: options.timeoutMs ?? 15_000,
        });
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          url = new URL(response.headers.location, url);
          continue;
        }
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: url.href,
            received_at: new Date().toISOString(),
            late: false,
            detail: {
              url: originalUrl,
              final_url: url.href,
              visited_urls: visited,
              status: response.status,
              content_type: response.headers['content-type'] ?? '',
              body: response.body,
            },
          },
        };
      }
      throw new Error('web redirect limit exceeded');
    },
    async verify() {
      return { decision: 'unsupported', reason: 'web reads have no durable effect to verify' };
    },
    async health() {
      return {
        status: 'ok',
        detail: 'web address and compartment guards are configured',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
