/**
 * A connected GitHub account end to end, against Postgres: requests shaped as
 * git and gh send them go through the real relay with the GitHub adapter, the
 * sealed token is added on the wire, and every change is brought to the real
 * broker, which asks the person with the exact change, admits it once, and
 * keeps a receipt. Standing rules are made and used through the same
 * permission service the app answers with.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { permissionOutcome } from '@melete/contracts';
import { egressAdmission } from '../../src/broker/egress-admission.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService, EGRESS_RERUN } from '../../src/broker/service.ts';
import { createTableTrustResolver, type TrustTableEntry } from '../../src/broker/trust.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { githubAdapter } from '../../src/egress/adapters/github.ts';
import { credentialAdapters } from '../../src/egress/adapters/index.ts';
import { EgressCertificateAuthority, postgresEgressCaStore } from '../../src/egress/ca.ts';
import { createCommandLineConnector } from '../../src/egress/connector.ts';
import { postgresEgressCredentials } from '../../src/egress/credentials.ts';
import {
  fixtureUpstream,
  rawRequest,
  type SeenRequest,
  throughRelay,
} from '../../src/egress/fixtures.ts';
import { parseReceivePack, parseReportStatus } from '../../src/egress/git-pktline.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { resolveExperienceGrant } from '../../src/experience/rules.ts';
import { SandboxEgressGuard } from '../../src/sandbox/adapters/docker-egress.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const withDb = db ? describe : describe.skip;
const TOKEN = `github_pat_${randomBytes(18).toString('hex')}`;
const ZERO = '0'.repeat(40);
const OLD = 'ef5e63cd808eddbe9fad81f85b15341188093b1b';
const NEW = '73cd911b5626ddbf8abd727ac93642f1825cc3e2';
const OTHER = '42e9cb1f5c224264c8a9b75afa3e43945ff80034';
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

/** What GitHub answers a push: every ref it was asked to update, accepted, inside side-band packets. */
function reportFor(request: SeenRequest) {
  const commands = parseReceivePack(Buffer.from(request.body, 'latin1'));
  const inner = `${pkt('unpack ok\n')}${(commands?.updates ?? []).map((u) => pkt(`ok ${u.ref}\n`)).join('')}0000`;
  return `${pkt(`\x01${inner}`)}0000`;
}
const git = await fixtureUpstream('github.com', (request) =>
  request.path.endsWith('/git-receive-pack')
    ? {
        body: reportFor(request),
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
      }
    : undefined,
);
const PR_URL = 'https://github.com/alice/site/pull/7';
const api = await fixtureUpstream('api.github.com', (request) =>
  request.body.includes('PullRequestCreate')
    ? {
        body: JSON.stringify({
          data: { createPullRequest: { pullRequest: { id: 'PR_kwDOAlice7', url: PR_URL } } },
        }),
      }
    : request.body.includes('RepositoryInfo')
      ? { body: JSON.stringify({ data: { repository: { id: 'R_kgDOAlice', name: 'site' } } }) }
      : undefined,
);
afterAll(async () => {
  await git.close();
  await api.close();
  await db?.close();
}, 15_000);
beforeEach(() => {
  git.seen.length = 0;
  api.seen.length = 0;
});
const guards: SandboxEgressGuard[] = [];
afterAll(async () => {
  for (const guard of guards) await guard.close();
});

/** A push request as git sends it: the commands, then a pack (here, stand-in bytes). */
function pushBody(updates: Array<[string, string, string]>, pack = 'PACK-stand-in') {
  const lines = updates.map(([old, next, ref], index) =>
    pkt(
      `${old} ${next} ${ref}${index === 0 ? '\0 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.5' : ''}`,
    ),
  );
  return `${lines.join('')}0000${updates.every(([, next]) => next === ZERO) ? '' : pack}`;
}
const pushRequest = (updates: Array<[string, string, string]>, pack?: string) =>
  rawRequest('POST', 'github.com', '/alice/site.git/git-receive-pack', {
    headers: {
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
      'user-agent': 'git/2.39.5',
    },
    body: pushBody(updates, pack),
  });

async function setup(options: { holdSeconds: number }) {
  if (!db) throw new Error('Postgres is unavailable');
  const { sql } = db;
  const { claims, connectionId } = await seedJob(sql, {
    provider: 'command_line',
    scopes: ['egress.github_read', 'egress.github_write'],
  });
  const masterKey = randomBytes(32).toString('hex');
  const secrets = new SealedSecretStore(new PostgresSecretRepository(sql), () => masterKey);
  const secretId = await secrets.put(claims.space_id, TOKEN);
  await sql`update connection set secret_ref = ${secretId},
    configuration = ${JSON.stringify({ kind: 'command_line', adapter: 'github', config: {}, account: 'alice' })}::jsonb
    where id = ${connectionId}`;
  const registry = new ConnectorRegistry().register(
    connectionId,
    createCommandLineConnector('github'),
  );
  // The person named the repository themselves, so a rule may be offered for it.
  const trust = new Map<string, TrustTableEntry>([['alice/site', { origin_trust: 'owner' }]]);
  const broker = new BrokerService({
    sql,
    connectors: registry,
    resolveTrust: createTableTrustResolver(trust),
    resolveStandingGrant: resolveExperienceGrant,
  });
  const permissions = new ExperiencePermissions(
    sql,
    broker,
    new ExperienceEffects(sql, broker, registry),
  );
  const ca = new EgressCertificateAuthority({
    store: postgresEgressCaStore(sql),
    sealer: secrets,
    constraints: githubAdapter.constraints,
  });
  const credentials = postgresEgressCredentials({
    sql,
    secrets,
    adapters: credentialAdapters(),
    ca,
    admission: egressAdmission(broker, { pollMs: 50 }),
  });
  const ports: Record<string, number> = { 'github.com': git.port, 'api.github.com': api.port };
  const guard = new SandboxEgressGuard({
    resolve: async () => [{ address: '140.82.112.3', family: 4 }],
    dial: () => connect(git.port, '127.0.0.1'),
    credentials,
    intercept: {
      upstream: (host) => ({
        address: { address: '127.0.0.1', family: 4 },
        port: ports[host] ?? git.port,
      }),
      upstreamCa: [git.ca, api.ca],
      approvalHoldSeconds: options.holdSeconds,
    },
  });
  guards.push(guard);
  const relayPort = await guard.listen(0, '127.0.0.1');
  const sandbox = `melete-sbx-${recordId('sbx').toLowerCase()}`;
  guard.allow('127.0.0.1', sandbox, { mode: 'open', session: 'sbx_one', space: claims.space_id });
  const token = (attemptId = claims.attempt_id) =>
    guard.mint(sandbox, {
      kind: 'command',
      sessionId: 'sbx_one',
      jobId: claims.job_id,
      attemptId,
      actionId: 'act_cmd',
      deadlineAt: Date.now() + 120_000,
    });
  const caPem = (await ca.certificate()).pem;
  const send = (host: string, requests: string[], attemptId?: string) =>
    throughRelay({ relayPort, host, ca: caPem, token: token(attemptId), requests });
  const push = async (updates: Array<[string, string, string]>, pack?: string) => {
    const [answer] = await send('github.com', [pushRequest(updates, pack)]);
    if (!answer) throw new Error('no answer');
    return {
      ...answer,
      report: parseReportStatus(Buffer.from(answer.body, 'latin1')),
    };
  };
  const actions = async () =>
    sql`select * from action where job_id = ${claims.job_id}
      and kind = 'egress.github_write' order by created_at`;
  const card = async () => {
    const listed = await permissions.list(claims.space_id);
    return listed.permissions.at(-1);
  };
  return { sql, claims, broker, permissions, send, push, actions, card };
}

const waitFor = async <T>(read: () => Promise<T | undefined>, ms = 10_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const bounds = () => ({
  count_cap: 5,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  reconsent_after_days: 7,
});

withDb('GitHub from the agent’s computer', () => {
  test('a push asks with its exact ref updates, and a re-run after approval pushes once', async () => {
    const s = await setup({ holdSeconds: 0 });
    const update: Array<[string, string, string]> = [[OLD, NEW, 'refs/heads/melete/fix-login']];
    // A clone or fetch is a read: the token goes out, nothing asks.
    const [refs] = await s.send('github.com', [
      rawRequest('GET', 'github.com', '/alice/site.git/info/refs?service=git-receive-pack'),
    ]);
    expect(refs?.status).toBe(200);
    expect(git.seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );
    const first = await s.push(update);
    // git is told in its own words, beside the ref it asked to update.
    expect(first.status).toBe(200);
    expect(first.report?.refs).toEqual([
      {
        ref: 'refs/heads/melete/fix-login',
        ok: false,
        reason: expect.stringContaining(
          'Waiting for your approval in Melete: Push to alice/site (melete/fix-login).',
        ),
      },
    ]);
    expect(git.seen.filter((r) => r.method === 'POST')).toEqual([]);
    const [row] = await s.actions();
    if (!row) throw new Error('no action');
    expect(row.status).toBe('needs_approval');
    expect(row.canonical_payload).toMatchObject({
      operation: 'push',
      resource: 'alice/site',
      updates: [{ ref: 'refs/heads/melete/fix-login', old: OLD, new: NEW }],
      destructive: false,
      summary: { title: 'Push to alice/site (melete/fix-login)' },
    });
    const card = await s.card();
    expect(card?.what).toBe('Push to alice/site (melete/fix-login)');
    expect(JSON.stringify(card)).toContain('update ef5e63c → 73cd911');
    await s.broker.decide(row.id, { decision: 'approved', payload_hash: row.payload_hash });
    // The job wakes into a new attempt, which runs the same command again.
    const next = recordId('att');
    await s.sql`update attempt set outcome = 'completed', ended_at = now() where id = ${s.claims.attempt_id}`;
    await s.sql`update job set lease_epoch = 2, state = 'running' where id = ${s.claims.job_id}`;
    await s.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${next}, ${s.claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
    const resumed = await s.broker.resume({ ...s.claims, attempt_id: next, epoch: 2 }, row.id);
    expect(resumed.message).toBe(EGRESS_RERUN);
    // git packs the same commits again; the bytes of the pack may differ, the updates do not.
    const second = await s.push(update, 'PACK-packed-again');
    expect(second.report).toEqual({
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/melete/fix-login', ok: true }],
    });
    const sent = git.seen.filter((r) => r.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('PACK-packed-again');
    const [done] = await s.actions();
    expect(done?.id).toBe(row.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.receipt?.detail).toMatchObject({
      repository: 'alice/site',
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/melete/fix-login', ok: true }],
    });
    // A third run is answered from the record and sends nothing.
    const third = await s.push(update);
    expect(third.report?.refs[0]?.ok).toBe(false);
    expect(git.seen.filter((r) => r.method === 'POST')).toHaveLength(1);
    // A different new commit for the same branch is a new approval.
    const moved = await s.push([[NEW, OTHER, 'refs/heads/melete/fix-login']]);
    expect(moved.report?.refs[0]?.reason).toContain('Waiting for your approval');
    expect(await s.actions()).toHaveLength(2);
    expect(JSON.stringify(await s.actions())).not.toContain(TOKEN);
  }, 30_000);

  test('a standing rule admits pushes to melete branches and never to the default branch', async () => {
    const s = await setup({ holdSeconds: 0 });
    await s.push([[OLD, NEW, 'refs/heads/melete/fix-login']]);
    const asked = await s.card();
    if (!asked) throw new Error('no permission card');
    expect(asked.options).toContain('always');
    const answer = permissionOutcome.parse(
      await s.permissions.decide(s.claims.space_id, asked.id, {
        option: 'always',
        version: asked.version,
        bounds: bounds(),
      }),
    );
    expect(answer.rule).toMatchObject({ kind: 'push_branch', recipient_class: 'alice/site' });
    expect(answer.rule?.text).toStartWith(
      'Pushes to melete/ branches in alice/site, up to 5 times',
    );
    // The approved push goes through on its re-run.
    expect((await s.push([[OLD, NEW, 'refs/heads/melete/fix-login']])).report?.refs[0]?.ok).toBe(
      true,
    );
    // Another melete branch: admitted by the rule, with no question asked.
    const covered = await s.push([[ZERO, OTHER, 'refs/heads/melete/next-step']]);
    expect(covered.report?.refs).toEqual([{ ref: 'refs/heads/melete/next-step', ok: true }]);
    const byRule = (await s.actions()).at(-1);
    expect(byRule?.status).toBe('succeeded');
    const [approval] = await s.sql`select id from approval where action_id = ${byRule?.id}`;
    expect(approval).toBeUndefined();
    // The default branch, and a push that touches it beside a melete branch, ask.
    const main = await s.push([[OLD, NEW, 'refs/heads/main']]);
    expect(main.report?.refs[0]?.reason).toContain('Waiting for your approval');
    const mixed = await s.push([
      [OLD, NEW, 'refs/heads/main'],
      [ZERO, OTHER, 'refs/heads/melete/third'],
    ]);
    expect(mixed.report?.refs.every((ref) => !ref.ok)).toBe(true);
    const mainCard = await s.card();
    expect(mainCard?.options).not.toContain('always');
    expect(git.seen.filter((r) => r.method === 'POST')).toHaveLength(2);
  }, 30_000);

  test('a branch delete is shown as a delete and always asks', async () => {
    const s = await setup({ holdSeconds: 0 });
    // A rule for the repository's melete branches exists.
    await s.push([[OLD, NEW, 'refs/heads/melete/fix-login']]);
    const asked = await s.card();
    if (!asked) throw new Error('no permission card');
    await s.permissions.decide(s.claims.space_id, asked.id, {
      option: 'always',
      version: asked.version,
      bounds: bounds(),
    });
    const deleted = await s.push([[NEW, ZERO, 'refs/heads/melete/fix-login']]);
    expect(deleted.report?.refs[0]?.reason).toContain(
      'Waiting for your approval in Melete: Delete melete/fix-login in alice/site.',
    );
    const row = (await s.actions()).at(-1);
    expect(row?.status).toBe('needs_approval');
    expect(row?.canonical_payload).toMatchObject({ destructive: true });
    const card = await s.card();
    expect(card?.what).toBe('Delete melete/fix-login in alice/site');
    expect(JSON.stringify(card)).toContain('This deletes or overwrites something.');
    expect(JSON.stringify(card)).toContain('delete (was 73cd911)');
    expect(card?.options).not.toContain('always');
    // gh pr merge --delete-branch deletes through the API: that asks as well.
    const [viaApi] = await s.send('api.github.com', [
      rawRequest(
        'DELETE',
        'api.github.com',
        '/repos/alice/site/git/refs/heads/melete%2Ffix-login',
        {
          headers: { accept: 'application/vnd.github+json' },
        },
      ),
    ]);
    expect(viaApi?.status).toBe(403);
    expect(JSON.parse(viaApi?.body ?? '{}').message).toContain('Waiting for your approval');
    expect(api.seen).toEqual([]);
    expect(git.seen.filter((r) => r.method === 'POST')).toEqual([]);
  }, 30_000);

  test('gh pr create opens the pull request after approval and the receipt links it', async () => {
    const s = await setup({ holdSeconds: 20 });
    // The requests gh 2.83 sent for `gh pr create`, as recorded.
    const recorded = readFileSync(
      path.join(import.meta.dir, '../../src/egress/adapters/fixtures/github/gh-pr-create.http'),
      'utf8',
    )
      .split(/^### .*$/m)
      .slice(1)
      .map((block) => {
        const lines = block.trim().split('\n');
        const blank = lines.indexOf('');
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1, blank)) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
        }
        return rawRequest('POST', 'api.github.com', '/graphql', {
          headers: { ...headers, authorization: 'token melete-proxy-adds-this' },
          body: lines.slice(blank + 1).join('\n'),
        });
      });
    expect(recorded).toHaveLength(3);
    // Its two queries are reads and go straight out with the token.
    const reads = await s.send('api.github.com', recorded.slice(0, 2));
    expect(reads.map((answer) => answer.status)).toEqual([200, 200]);
    expect(api.seen.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
    // The mutation waits for the person, who approves while it is held.
    const pending = s.send('api.github.com', recorded.slice(2));
    const row = await waitFor(async () => {
      const found = (await s.actions()).at(-1);
      return found?.status === 'needs_approval' ? found : undefined;
    });
    expect(row.canonical_payload).toMatchObject({
      operation: 'graphql',
      summary: { title: 'Open a pull request: Fix (melete/fix-login → main)' },
      graphql: { operation_name: 'PullRequestCreate', fields: ['createPullRequest'] },
    });
    expect(api.seen).toHaveLength(2);
    await s.broker.decide(row.id, { decision: 'approved', payload_hash: row.payload_hash });
    const [created] = await pending;
    expect(created?.status).toBe(200);
    expect(JSON.parse(created?.body ?? '{}').data.createPullRequest.pullRequest.url).toBe(PR_URL);
    expect(api.seen).toHaveLength(3);
    const done = (await s.actions()).at(-1);
    expect(done?.status).toBe('succeeded');
    expect(done?.receipt?.detail).toMatchObject({
      host: 'api.github.com',
      operation: 'graphql',
      urls: [PR_URL],
      node_ids: ['PR_kwDOAlice7'],
    });
    expect(JSON.stringify(done?.receipt)).not.toContain(TOKEN);
  }, 30_000);
});
