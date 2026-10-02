/**
 * Fixtures for the egress relay's tests: an upstream that tells what it was
 * sent (and can echo the account back), a credential port held in memory, and
 * a client that speaks to a host through the relay the way a command in the
 * computer does. Test code only.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { type AddressInfo, connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { EgressAdmission } from '../broker/egress-admission.ts';
import { SealedSecretStore } from '../connectors/secrets.ts';
import { selfSignedPair } from '../gateway/fixtures/self-signed.ts';
import { testAdapter } from './adapters/test.ts';
import { EgressCertificateAuthority, memoryEgressCaStore } from './ca.ts';
import type { EgressCredentialPort } from './credentials.ts';

export type SeenRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** An HTTPS service for `host` that records each request and answers with what it saw. */
export async function fixtureUpstream(
  host: string,
  answer?: (
    request: SeenRequest,
  ) => { status?: number; body?: string; headers?: Record<string, string> } | undefined,
) {
  const pair = selfSignedPair(host);
  const seen: SeenRequest[] = [];
  const server: Server = createServer({ key: pair.key, cert: pair.cert }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: SeenRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      const custom = answer?.(entry);
      const body =
        custom?.body ??
        JSON.stringify({
          method: entry.method,
          path: entry.path,
          authorization: entry.headers.authorization ?? null,
          cookie: entry.headers.cookie ?? null,
          body: entry.body,
        });
      response.writeHead(custom?.status ?? 200, {
        'content-type': 'application/json',
        'alt-svc': 'h3=":443"',
        'set-cookie': 'session=upstream',
        ...custom?.headers,
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: pair.cert.toString(),
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A sealer whose master key lives only as long as the test. */
export function testSealer() {
  const key = randomBytes(32).toString('hex');
  return new SealedSecretStore({ put: async () => {}, get: async () => null }, () => key);
}

/** A credential port over one test-adapter account, held in memory. */
export function memoryCredentialPort(input: {
  secret: string;
  hosts: string[];
  readOnlyHosts?: string[];
  connectionId?: string;
  admitWrite?: EgressAdmission;
  /** Answers no account at all: the tunnel stays blind. */
  none?: () => boolean;
}): EgressCredentialPort & { ca: EgressCertificateAuthority; lookups: number } {
  const ca = new EgressCertificateAuthority({
    store: memoryEgressCaStore(),
    sealer: testSealer(),
    constraints: testAdapter.constraints,
  });
  const config = testAdapter.parseConfig({
    hosts: input.hosts,
    read_only_hosts: input.readOnlyHosts ?? [],
  });
  const port = {
    ca,
    lookups: 0,
    async find({ host }: { host: string }) {
      port.lookups += 1;
      if (input.none?.() || !config.hosts.includes(host)) return null;
      return {
        connectionId: input.connectionId ?? 'conn_TEST',
        adapter: testAdapter,
        config,
        withSecret: <T>(use: (secret: string) => Promise<T>) => use(input.secret),
      };
    },
    async computer() {
      const certificate = await ca.certificate();
      return { caId: certificate.id, caPem: certificate.pem, placeholders: {} };
    },
    async hosts() {
      return config.hosts;
    },
    admitWrite:
      input.admitWrite ??
      (async () => ({
        kind: 'refused' as const,
        status: 403 as const,
        message: 'No writes here.',
        actionId: null,
      })),
  };
  return port as EgressCredentialPort & { ca: EgressCertificateAuthority; lookups: number };
}

export type RelayAnswer = {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The certificate the client was shown for the host, by issuer common name. */
  issuer: string;
};

/**
 * A client in the computer: CONNECT through the relay with a command's token,
 * TLS to `host` trusting `ca`, then each raw HTTP/1.1 request in turn on the
 * same tunnel. Answers each response.
 */
export async function throughRelay(input: {
  relayPort: number;
  host: string;
  ca: string | string[];
  token?: string;
  requests: string[];
  /** Runs before each request after the first. */
  between?: (index: number) => Promise<void>;
}): Promise<RelayAnswer[]> {
  const socket = connectTcp(input.relayPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const auth = input.token
    ? `Proxy-Authorization: Basic ${Buffer.from(`cmd:${input.token}`).toString('base64')}\r\n`
    : '';
  socket.write(`CONNECT ${input.host}:443 HTTP/1.1\r\nHost: ${input.host}:443\r\n${auth}\r\n`);
  const established = await new Promise<string>((resolve, reject) => {
    let text = '';
    const onData = (chunk: Buffer) => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve(text);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => resolve(text));
  });
  if (!established.startsWith('HTTP/1.1 200'))
    return [
      { status: Number(established.slice(9, 12)) || 0, headers: {}, body: established, issuer: '' },
    ];
  const tls = connectTls({ socket, servername: input.host, ca: input.ca });
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', () => resolve());
    tls.once('error', reject);
  });
  const issuer = String(tls.getPeerCertificate()?.issuer?.CN ?? '');
  const answers: RelayAnswer[] = [];
  let buffer = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | null = null;
  tls.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  tls.on('close', () => {
    closed = true;
    wake?.();
  });
  tls.on('error', () => {
    closed = true;
    wake?.();
  });
  const more = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  for (const [index, request] of input.requests.entries()) {
    if (index > 0) await input.between?.(index);
    if (closed) {
      answers.push({ status: 0, headers: {}, body: '', issuer });
      break;
    }
    tls.write(request);
    // One response: headers, then a content-length or chunked body.
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end >= 0) {
        const head = buffer.subarray(0, end).toString('latin1').split('\r\n');
        const status = Number(head[0]?.slice(9, 12));
        const headers: Record<string, string> = {};
        for (const line of head.slice(1)) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        const rest = buffer.subarray(end + 4);
        const length = headers['content-length'];
        if (length !== undefined && rest.length >= Number(length)) {
          answers.push({
            status,
            headers,
            body: rest.subarray(0, Number(length)).toString('utf8'),
            issuer,
          });
          buffer = rest.subarray(Number(length));
          break;
        }
        if (headers['transfer-encoding'] === 'chunked') {
          const decoded = dechunk(rest);
          if (decoded) {
            answers.push({ status, headers, body: decoded.body.toString('utf8'), issuer });
            buffer = rest.subarray(decoded.used);
            break;
          }
        }
        if (length === undefined && headers['transfer-encoding'] !== 'chunked' && closed) {
          answers.push({ status, headers, body: rest.toString('utf8'), issuer });
          break;
        }
      }
      if (closed) {
        answers.push({ status: 0, headers: {}, body: buffer.toString('utf8'), issuer });
        tls.destroy();
        return answers;
      }
      await more();
    }
  }
  tls.destroy();
  return answers;
}

function dechunk(input: Buffer): { body: Buffer; used: number } | null {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const line = input.indexOf('\r\n', offset);
    if (line < 0) return null;
    const size = Number.parseInt(input.subarray(offset, line).toString('latin1'), 16);
    if (Number.isNaN(size)) return null;
    const start = line + 2;
    if (size === 0)
      return input.length >= start + 2 ? { body: Buffer.concat(parts), used: start + 2 } : null;
    if (input.length < start + size + 2) return null;
    parts.push(input.subarray(start, start + size));
    offset = start + size + 2;
  }
}

/** A raw HTTP/1.1 request for the client above. */
export function rawRequest(
  method: string,
  host: string,
  target: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): string {
  const body = options.body ?? '';
  const headers = {
    host,
    ...(body || method !== 'GET' ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
    ...options.headers,
  };
  return `${method} ${target} HTTP/1.1\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')}\r\n\r\n${body}`;
}
