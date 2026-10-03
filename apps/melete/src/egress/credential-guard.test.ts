/**
 * A new credential in an answer never reaches the computer: the guard on its
 * own, and the relay with an account whose service can hand one out.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { selfSignedPair } from '../gateway/fixtures/self-signed.ts';
import { SandboxEgressGuard } from '../sandbox/adapters/docker-egress.ts';
import { testAdapter } from './adapters/test.ts';
import type { CredentialAdapter } from './adapters/types.ts';
import type { ForwardResult } from './connector.ts';
import { CredentialInAnswer, CredentialStreamGuard, credentialIn } from './credential-guard.ts';
import { memoryCredentialPort, rawRequest, throughRelay } from './fixtures.ts';

const GITLAB_TOKEN = `glpat-${'Ab1_'.repeat(6)}`;
const NPM_TOKEN = `npm_${'a1B2c3D4e5'.repeat(3)}xyz123`;

describe('the credential guard', () => {
  test('each kind of token a service hands out is recognised, and ordinary text is not', () => {
    const kinds = [
      'gitlab_personal',
      'gitlab_deploy',
      'gitlab_runner',
      'gitlab_trigger',
      'npm',
    ] as const;
    expect(credentialIn(`{"token":"${GITLAB_TOKEN}"}`, kinds)).toBe('gitlab_personal');
    expect(credentialIn(`gldt-${'x'.repeat(20)}`, kinds)).toBe('gitlab_deploy');
    expect(credentialIn(`glrt-${'x'.repeat(20)}`, kinds)).toBe('gitlab_runner');
    expect(credentialIn(`glptt-${'0'.repeat(40)}`, kinds)).toBe('gitlab_trigger');
    expect(credentialIn(`{"token":"${NPM_TOKEN}"}`, kinds)).toBe('npm');
    // A prefix alone, or one the kinds do not name, passes.
    expect(credentialIn('set npm_config_registry and glpat- in your CI', kinds)).toBeNull();
    expect(credentialIn(GITLAB_TOKEN, ['npm'])).toBeNull();
  });

  test('a token split across chunks is seen before any of it is passed on', () => {
    const guard = new CredentialStreamGuard(['gitlab_personal']);
    const before = 'x'.repeat(1000);
    const passed: Buffer[] = [];
    passed.push(guard.feed(Buffer.from(`${before}glpat-Ab1_`)));
    expect(() => guard.feed(Buffer.from('Ab1_Ab1_Ab1_Ab1_Ab1_"}'))).toThrow(CredentialInAnswer);
    const sent = Buffer.concat(passed).toString();
    expect(sent).not.toContain('glpat-');
    expect(before.startsWith(sent)).toBe(true);
    // With nothing found, every byte comes out, in order.
    const clean = new CredentialStreamGuard(['npm']);
    const out = Buffer.concat([
      clean.feed(Buffer.from('hello ')),
      clean.feed(Buffer.from('world')),
      clean.end(),
    ]);
    expect(out.toString()).toBe('hello world');
  });
});

/** An upstream that answers in chunks: `/mint` hands out a token, `/split` sends one in two pieces. */
async function minting() {
  const pair = selfSignedPair('gl.creds.test');
  const server: Server = createHttpsServer(
    { key: pair.key, cert: pair.cert },
    (request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.url === '/split') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write(`{"padding":"${'x'.repeat(70_000)}","token":"glpat-Ab1_`);
          setTimeout(() => response.end('Ab1_Ab1_Ab1_Ab1_Ab1_"}'), 50);
          return;
        }
        if (request.url === '/header') {
          response.writeHead(200, { 'x-new-token': GITLAB_TOKEN });
          response.end('{}');
          return;
        }
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          request.url === '/mint' ? JSON.stringify({ token: GITLAB_TOKEN }) : '{"ok":true}',
        );
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: pair.cert.toString(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const upstream = await minting();
afterAll(() => upstream.close());
let guard: SandboxEgressGuard | null = null;
afterEach(async () => {
  await guard?.close();
  guard = null;
});

async function relay() {
  const forwarded: ForwardResult[] = [];
  const adapter: CredentialAdapter = {
    ...(testAdapter as CredentialAdapter),
    mintedCredentials: ['gitlab_personal'],
  };
  const port = memoryCredentialPort({
    secret: 'the-account-secret',
    account: { adapter, config: testAdapter.parseConfig({ hosts: ['gl.creds.test'] }) },
    admitWrite: async (input) => {
      const result = await input.forward();
      forwarded.push(result);
      return { kind: 'sent', actionId: 'act_SENT', result };
    },
  });
  guard = new SandboxEgressGuard({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    dial: () => connect(upstream.port, '127.0.0.1'),
    credentials: port,
    intercept: {
      upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: upstream.port }),
      upstreamCa: upstream.ca,
    },
  });
  const relayPort = await guard.listen(0, '127.0.0.1');
  guard.allow('127.0.0.1', 'melete-sbx-one', { mode: 'open', session: 'sbx_one', space: 'sp_one' });
  const token = guard.mint('melete-sbx-one', {
    kind: 'command',
    sessionId: 'sbx_one',
    jobId: 'job_one',
    attemptId: 'att_one',
    actionId: 'act_one',
    deadlineAt: Date.now() + 120_000,
  });
  const ca = (await port.ca.certificate()).pem;
  const ask = (method: string, path: string) =>
    throughRelay({
      relayPort,
      host: 'gl.creds.test',
      ca,
      token,
      requests: [rawRequest(method, 'gl.creds.test', path, method === 'GET' ? {} : { body: '{}' })],
    });
  return { ask, forwarded };
}

describe('an answer holding a new credential', () => {
  test('a read whose answer holds a token is withheld, in its body or its headers', async () => {
    const { ask } = await relay();
    // In a header: seen before anything is sent, and answered in plain words.
    const [header] = await ask('GET', '/header');
    expect(header?.status).toBe(502);
    expect(header?.headers['x-melete-egress']).toBe('credential_in_answer');
    expect(JSON.stringify(header)).not.toContain('glpat-');
    // In the body: the answer stops before the token, so it never arrives whole.
    const minted = await ask('GET', '/mint').catch(() => []);
    expect(JSON.stringify(minted)).not.toContain('glpat-');
    expect(minted.map((answer) => answer.body).join('')).not.toContain('"}');
    // An answer without one passes as it is.
    const [plain] = await ask('GET', '/other');
    expect(plain?.status).toBe(201);
    expect(plain?.body).toBe('{"ok":true}');
  });

  test('a token that arrives after the answer has started cuts it off before any of it is sent', async () => {
    const { ask } = await relay();
    const answers = await ask('GET', '/split').catch(() => []);
    expect(JSON.stringify(answers)).not.toContain('glpat-');
    // Whatever arrived is a cut-off answer: never the whole one.
    expect(answers.map((answer) => answer.body).join('')).not.toContain('"}');
  });

  test('a change whose answer holds a token is sent, and its answer is kept from the computer as lost', async () => {
    const { ask, forwarded } = await relay();
    const [answer] = await ask('POST', '/mint');
    expect(forwarded).toEqual([
      { outcome: 'lost', reason: expect.stringContaining('not passed on') },
    ]);
    expect(answer?.status).toBe(502);
    expect(JSON.stringify(answer)).not.toContain('glpat-');
  });
});
