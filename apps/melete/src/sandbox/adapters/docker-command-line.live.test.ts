/**
 * GitLab and npm accounts in a real computer on a real Docker engine: the
 * computer's own git, glab and npm reach stand-ins for gitlab.com and
 * registry.npmjs.org only through the service's egress relay, which adds the
 * account on the wire. Skipped unless `MELETE_SANDBOX_LIVE=docker`, and the
 * relay's checks need this process to be a container on the same engine, as
 * the service is in the Compose deployment.
 *
 *   MELETE_SANDBOX_DOCKER_IMAGE    the image to run (default melete-sandbox:local)
 *   MELETE_DOCKER_SOCKET           the engine (default /var/run/docker.sock)
 *   MELETE_LIVE_NPM_REGISTRY       a registry that speaks npm's protocol (a Verdaccio
 *                                  container in CI); the npm check needs it
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { resolveHost } from '../../connectors/web.ts';
import { gitlabAdapter } from '../../egress/adapters/gitlab.ts';
import { npmAdapter } from '../../egress/adapters/npm.ts';
import type { CredentialAdapter } from '../../egress/adapters/types.ts';
import { memoryCredentialPort } from '../../egress/fixtures.ts';
import { type GitRequestSeen, gitSmartHttp } from '../../egress/git-fixture.ts';
import { selfSignedPair } from '../../gateway/fixtures/self-signed.ts';
import { serviceContainerId } from '../docker-default.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import type { SandboxHandle } from '../types.ts';
import { DOCKER_SANDBOX_DEFAULTS, DockerSandboxHost, DockerSandboxSocket } from './docker.ts';
import { SandboxEgressGuard } from './docker-egress.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'docker';
const socket = process.env.MELETE_DOCKER_SOCKET ?? '/var/run/docker.sock';
const image = process.env.MELETE_SANDBOX_DOCKER_IMAGE ?? 'melete-sandbox:local';
const registryUrl = process.env.MELETE_LIVE_NPM_REGISTRY;
const selfId = serviceContainerId({ MELETE_RUNTIME_ADAPTER: 'docker' });
const PROJECT = `livecl${Date.now().toString(36)}`;
const signal = () => AbortSignal.timeout(180_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** An HTTPS stand-in for `host`, with a certificate only the relay is told to trust. */
async function standIn(
  host: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const pair = selfSignedPair(host);
  const server: Server = createHttpsServer({ key: pair.key, cert: pair.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
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

/**
 * A host whose guard holds one account and sends its hosts to `port`; the
 * first change waits for approval and every later one is approved.
 */
function accountHost(input: {
  adapter: CredentialAdapter;
  secret: string;
  hosts: string[];
  /** A public address the hosts resolve to; requests still go to the stand-in. */
  address: string;
  upstream: { port: number; ca: string };
  egressPort: number;
}) {
  const writes: EgressWriteInput[] = [];
  const port = memoryCredentialPort({
    secret: input.secret,
    account: { adapter: input.adapter, config: {} },
    admitWrite: async (write) => {
      writes.push(write);
      if (writes.length === 1)
        return {
          kind: 'waiting',
          actionId: 'act_LIVE_held',
          message: `Waiting for your approval in Melete: ${write.write.summary.title}. Run the same command again once it is approved.`,
        };
      return {
        kind: 'sent',
        actionId: `act_LIVE_${writes.length}`,
        result: await write.forward(),
      };
    },
  });
  const guard = new SandboxEgressGuard({
    resolve: async (name) =>
      input.hosts.includes(name) ? [{ address: input.address, family: 4 }] : resolveHost(name),
    credentials: port,
    intercept: {
      upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: input.upstream.port }),
      upstreamCa: input.upstream.ca,
    },
  });
  const host = new DockerSandboxHost(
    {
      socket,
      project: PROJECT,
      ...DOCKER_SANDBOX_DEFAULTS,
      memoryMb: 1024,
      pids: 256,
      diskMb: 256,
      egressPort: input.egressPort,
      egressCredentials: port,
      ...(selfId ? { selfId } : {}),
    },
    new DockerSandboxSocket(socket),
    { guard },
  );
  return { host, guard, writes };
}

const opened: Array<{ host: DockerSandboxHost; handle: SandboxHandle }> = [];
async function computer(host: DockerSandboxHost, session: string) {
  const handle = await openSandbox(
    host,
    {
      image,
      egress: { kind: 'open' },
      region: null,
      lifetimeSeconds: 1_800,
      idleSeconds: null,
      workdir: '/work',
      labels: sandboxLabels({
        project: PROJECT,
        connection: 'conn_LIVE',
        space: 'sp_LIVE',
        session,
      }),
      env: { LANG: 'C.UTF-8' },
    },
    signal(),
  );
  opened.push({ host, handle });
  return handle;
}

/** One command with the account's attribution, answering what it printed. */
async function attributed(host: DockerSandboxHost, handle: SandboxHandle, lines: string[]) {
  const command = await host.attributeCommand(handle, {
    kind: 'command',
    sessionId: handle.providerSandboxId,
    jobId: 'job_LIVE',
    attemptId: 'att_LIVE',
    actionId: `act_LIVE_${Date.now()}`,
  });
  try {
    const outcome = await host.exec(
      handle,
      {
        marker: `act_${Date.now()}`,
        argv: ['/bin/sh', '-c', lines.join('\n')],
        cwd: '/work',
        timeoutMs: 150_000,
        maxOutputBytes: 64 * 1024,
        env: command.env,
      },
      AbortSignal.timeout(200_000),
    );
    return text(outcome.output);
  } finally {
    command.settle();
  }
}

/** Lines that say how often the secret appears in the computer's environment and files. */
const secretNowhere = (secret: string) => {
  const half = Math.floor(secret.length / 2);
  return [
    `A='${secret.slice(0, half)}'; B='${secret.slice(half)}'`,
    'env | grep -cF "$A$B" | sed "s/^/env=/"',
    'grep -rlF "$A$B" /home /work /tmp /etc 2>/dev/null | wc -l | sed "s/^/files=/"',
  ];
};

if (!live || !selfId) {
  test.skip('command-line accounts in a live computer need MELETE_SANDBOX_LIVE=docker inside a container on the engine', () => {});
} else {
  afterAll(async () => {
    for (const { host, handle } of opened) await host.destroy(handle, signal()).catch(() => {});
  }, 180_000);

  describe('docker sandbox live: command-line accounts through the relay', () => {
    test('git and glab in a real computer push and change GitLab through the relay, and the computer never holds the token', async () => {
      const token = `glpat-${randomBytes(16).toString('hex')}`;
      const run = promisify(execFile);
      const root = await mkdtemp(path.join(tmpdir(), 'melete-live-gitlab-'));
      const bare = path.join(root, 'alice', 'site.git');
      await run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      await run('git', ['-C', bare, 'config', 'receive.advertisePushOptions', 'true']);
      const seed = path.join(root, 'seed');
      await run('git', ['init', '-q', '-b', 'main', seed]);
      await run('git', [
        '-C',
        seed,
        '-c',
        'user.name=A',
        '-c',
        'user.email=a@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Start',
      ]);
      await run('git', ['-C', seed, 'push', '-q', bare, 'main']);
      const account = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
      const gitSeen: GitRequestSeen[] = [];
      const git = gitSmartHttp({ root, account, seen: gitSeen });
      const apiSeen: Array<{ method: string; path: string; token: string | undefined }> = [];
      // gitlab.com serves git and its API on one host.
      const gitlab = await standIn('gitlab.com', (request, response) => {
        const url = request.url ?? '/';
        if (!url.startsWith('/api/')) return git(request, response);
        apiSeen.push({
          method: request.method ?? '',
          path: url,
          token: request.headers['private-token'] as string | undefined,
        });
        request.resume();
        const json = (status: number, body: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (request.headers['private-token'] !== token)
          return json(401, { message: '401 Unauthorized' });
        if (url === '/api/v4/user') return json(200, { id: 1, username: 'alice' });
        if (request.method === 'POST' && url.startsWith('/api/v4/projects/alice%2Fsite/issues'))
          return json(201, { iid: 1, web_url: 'https://gitlab.com/alice/site/-/issues/1' });
        json(404, { message: '404 Not found' });
      });
      const { host, guard, writes } = accountHost({
        adapter: gitlabAdapter as CredentialAdapter,
        secret: token,
        hosts: ['gitlab.com'],
        address: '172.65.251.78',
        upstream: gitlab,
        egressPort: 18_795,
      });
      try {
        const handle = await computer(host, 'sbx_livegl');
        const printed = await attributed(host, handle, [
          'cd /work',
          'git clone -q https://gitlab.com/alice/site.git site 2>&1; echo clone=$?',
          'cd site && git checkout -q -b melete/fix-login',
          'echo fixed > login.txt && git add login.txt',
          'git -c user.name=A -c user.email=a@example.com commit -q -m "Fix login"',
          'echo new=$(git rev-parse HEAD)',
          'git push -o merge_request.create origin melete/fix-login 2>&1 | sed "s/^/first: /"',
          'git push -o merge_request.create origin melete/fix-login 2>&1 | sed "s/^/second: /"',
          'echo gl_user=$(glab api user 2>&1 | jq -r .username)',
          'echo issue=$(glab api -X POST "projects/alice%2Fsite/issues" -f title=Hello 2>&1 | jq -r .web_url)',
          'echo glab=$(glab --version | head -1)',
          ...secretNowhere(token),
        ]);
        process.stdout.write(`docker live, gitlab: ${printed}\n`);
        expect(printed).toContain('clone=0');
        const newId = /new=([0-9a-f]{40})/.exec(printed)?.[1] ?? '';
        expect(newId).toMatch(/^[0-9a-f]{40}$/);
        expect(printed).toContain(
          'first:  ! [remote rejected] melete/fix-login -> melete/fix-login (Waiting for your approval in Melete: Push to alice/site (melete/fix-login), and open a merge request.',
        );
        expect(printed).toMatch(
          /second: .*\* \[new branch\]\s+melete\/fix-login -> melete\/fix-login/,
        );
        const onServer = await run('git', ['-C', bare, 'rev-parse', 'refs/heads/melete/fix-login']);
        expect(onServer.stdout.trim()).toBe(newId);
        const [held, sent] = writes;
        expect(held?.write.payload).toMatchObject({
          site: 'gitlab.com',
          resource: 'alice/site',
          updates: [{ ref: 'refs/heads/melete/fix-login', old: '0'.repeat(40), new: newId }],
          push_options: ['merge_request.create'],
        });
        expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
        expect(printed).toContain('gl_user=alice');
        expect(printed).toContain('issue=https://gitlab.com/alice/site/-/issues/1');
        expect(printed).toContain('glab=glab 1.120.0');
        expect(writes[2]?.write.summary.title).toBe('Open an issue in alice/site: Hello');
        // glab's usage reports never left; everything that did carried the account.
        expect(apiSeen.some((request) => request.path.includes('usage_data'))).toBe(false);
        expect(new Set(apiSeen.map((request) => request.token))).toEqual(new Set([token]));
        expect(gitSeen.length).toBeGreaterThanOrEqual(4);
        expect(new Set(gitSeen.map((request) => request.authorization))).toEqual(
          new Set([account]),
        );
        expect(printed).toContain('env=0');
        expect(printed).toContain('files=0');
        expect(printed).not.toContain(token);
      } finally {
        await guard.close();
        await gitlab.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 300_000);

    test.skipIf(!registryUrl)(
      'npm in a real computer publishes to and installs from the registry through the relay, and the computer never holds the token',
      async () => {
        const registry = new URL(registryUrl ?? 'http://127.0.0.1:4873');
        // An account on the stand-in registry; its token is the secret the relay adds.
        const password = randomBytes(12).toString('hex');
        const signup = await fetch(new URL('/-/user/org.couchdb.user:alice', registry), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            _id: 'org.couchdb.user:alice',
            name: 'alice',
            password,
            type: 'user',
          }),
        });
        const token = String(((await signup.json()) as { token?: string }).token ?? '');
        expect(token.length).toBeGreaterThan(10);
        const seen: Array<{ method: string; path: string; authorization: string | undefined }> = [];
        // registry.npmjs.org, in front of the stand-in registry.
        const front = await standIn('registry.npmjs.org', (request, response) => {
          seen.push({
            method: request.method ?? '',
            path: request.url ?? '',
            authorization: request.headers.authorization,
          });
          const { host: _host, ...headers } = request.headers;
          const upstream = httpRequest(
            {
              host: registry.hostname,
              port: registry.port || 80,
              method: request.method,
              path: request.url,
              headers,
            },
            (answer) => {
              response.writeHead(answer.statusCode ?? 502, answer.headers);
              answer.pipe(response);
            },
          );
          upstream.on('error', () => {
            response.writeHead(502);
            response.end();
          });
          request.pipe(upstream);
        });
        const { host, guard, writes } = accountHost({
          adapter: npmAdapter as CredentialAdapter,
          secret: token,
          hosts: ['registry.npmjs.org'],
          address: '104.16.0.35',
          upstream: front,
          egressPort: 18_796,
        });
        const name = `melete-live-${Date.now().toString(36)}`;
        try {
          const handle = await computer(host, 'sbx_livenpm');
          const printed = await attributed(host, handle, [
            'mkdir -p /work/pkg /work/app && cd /work/pkg',
            `printf '{"name":"${name}","version":"1.0.0","main":"index.js","license":"MIT"}' > package.json`,
            "echo 'module.exports = 42;' > index.js",
            'echo whoami=$(npm whoami 2>&1)',
            'npm publish 2>&1 | sed "s/^/first: /"',
            'npm publish 2>&1 | sed "s/^/second: /"',
            `echo version=$(npm view ${name} version 2>&1)`,
            'cd /work/app && echo "{}" > package.json',
            `npm install ${name} 2>&1 | tail -2 | sed "s/^/install: /"`,
            `echo loaded=$(node -e 'console.log(require("${name}"))')`,
            'echo node=$(node --version) npm=$(npm --version)',
            ...secretNowhere(token),
          ]);
          process.stdout.write(`docker live, npm: ${printed}\n`);
          expect(printed).toContain('whoami=alice');
          expect(printed).toContain(
            `Waiting for your approval in Melete: Publish ${name}@1.0.0 to npm (tag latest).`,
          );
          expect(printed).toMatch(/second: \+ melete-live-[a-z0-9]+@1\.0\.0/);
          expect(printed).toContain('version=1.0.0');
          expect(printed).toContain('loaded=42');
          const [held, sent] = writes;
          expect(writes).toHaveLength(2);
          expect(held?.write.payload).toMatchObject({
            resource: name,
            publish: { versions: ['1.0.0'], dist_tags: { latest: '1.0.0' } },
          });
          expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
          // Every request that reached the registry carried the account.
          expect(seen.length).toBeGreaterThanOrEqual(4);
          expect(new Set(seen.map((request) => request.authorization))).toEqual(
            new Set([`Bearer ${token}`]),
          );
          expect(printed).toContain('env=0');
          expect(printed).toContain('files=0');
          expect(printed).not.toContain(token);
        } finally {
          await guard.close();
          await front.close();
        }
      },
      300_000,
    );
  });
}
