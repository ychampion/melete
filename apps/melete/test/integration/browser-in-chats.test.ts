import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CapabilityClaims, JsonObject } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { browserManifest, createBrowserConnector } from '../../src/connectors/browser.ts';
import {
  databasePublicReads,
  PUBLIC_READS_OFF,
  saveWebReadSetting,
} from '../../src/connectors/web.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import { BROWSER_BUSY, BrowserSessionService } from '../../src/workers/browser/routes.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

/**
 * The browser as a conversation uses it: a chat job with no domain list of its own, a real
 * worker and Chromium, and the broker between them. The fixture's loopback origin stands in for
 * a public site; every other loopback address stays private.
 */
const fixture = chromiumAvailable ? await testDatabase() : null;
const suite = fixture ? describe : describe.skip;
if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});

const tempParent = await realpath(tmpdir());
const spaces = await mkdtemp(join(tempParent, 'melete-browser-chats-'));

function startSite() {
  // Nothing listens here once it stops, and the fixture injection does not admit it.
  const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const privatePort = closed.port;
  closed.stop(true);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const title = path === '/news' ? 'Morning news' : 'Public page';
      return new Response(
        `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1><p>Read by ${path}</p></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    privateUrl: `http://127.0.0.1:${privatePort}/inside`,
    close: () => server.stop(true),
  };
}

suite('the browser in everyday chats', () => {
  const sql = fixture?.sql as NonNullable<typeof fixture>['sql'];
  let site: ReturnType<typeof startSite>;
  let pool: BrowserWorkerPool;
  beforeAll(() => {
    site = startSite();
    pool = new BrowserWorkerPool({
      spacesRoot: spaces,
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [site.url],
    });
  });
  afterAll(async () => {
    await pool?.close();
    site?.close();
    await fixture?.close();
    const absolute = resolve(spaces);
    if (
      dirname(absolute) !== tempParent ||
      !basename(absolute).startsWith('melete-browser-chats-') ||
      (await realpath(absolute)) !== absolute
    )
      throw new Error('Refusing to remove an unverified browser test directory');
    await rm(absolute, { recursive: true, force: true });
  }, 30_000);

  /** A space with one browser connection and a running chat in it, wired as the service wires it. */
  async function space(options: { busyWaitMs?: number } = {}) {
    const seed = await seedJob(sql, {
      provider: 'web',
      scopes: browserManifest.tools.map((tool) => tool.name),
    });
    const agentId = recordId('agent');
    await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${agentId}, ${seed.claims.space_id}, 'Melete', 'assistant', 'blue', 'soft', 'dark', 'plain', '')`;
    await sql`update job set kind = 'chat', agent_id = ${agentId} where id = ${seed.claims.job_id}`;
    const sessions = new BrowserSessionService(sql, pool, {
      busyWaitMs: options.busyWaitMs ?? 1_500,
      busyPollMs: 100,
    });
    const connector = createBrowserConnector({
      sessions,
      artifacts: browserArtifactSink(sql, spaces),
      spaceId: seed.claims.space_id,
      publicReads: databasePublicReads({ sql, connectionId: seed.connectionId }),
    });
    const broker = new BrokerService({
      sql,
      connectors: { get: (id) => (id === seed.connectionId ? connector : undefined) },
      resolveTrust: createTableTrustResolver({}, { fallback: 'owner' }),
    });
    /** Another conversation in the same space, running its own turn. */
    const chat = async (): Promise<CapabilityClaims> => {
      const jobId = recordId('job');
      const attemptId = recordId('att');
      await sql`insert into job (id, space_id, kind, agent_id, title, objective, state, lease_epoch, budget, constraints)
        select ${jobId}, space_id, 'chat', agent_id, 'Another chat', objective, 'running', 1, budget, constraints
        from job where id = ${seed.claims.job_id}`;
      await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
      return { ...seed.claims, job_id: jobId, attempt_id: attemptId };
    };
    const browse = async (claims: CapabilityClaims, kind: string, payload: JsonObject) => {
      const proposal = await broker.propose(claims, {
        kind: `browser.${kind}`,
        connection_id: seed.connectionId,
        payload,
      });
      const [row] = await sql<
        { status: string; receipt: { detail: JsonObject } | null; reconciliation: JsonObject }[]
      >`select status, receipt, reconciliation from action where id = ${proposal.action_id}`;
      if (!row) throw new Error('no action recorded');
      return {
        status: row.status,
        detail: row.receipt?.detail ?? {},
        reason: String(row.reconciliation?.reason ?? ''),
      };
    };
    /** A turn that has finished: its attempt ended and the chat waits for the next message. */
    const finish = async (claims: CapabilityClaims) => {
      await sql`update attempt set ended_at = now(), outcome = 'completed' where id = ${claims.attempt_id}`;
      await sql`update job set state = 'completed' where id = ${claims.job_id}`;
    };
    const artifacts = (jobId: string) =>
      sql<
        { mime: string; size: number }[]
      >`select mime, size from artifact where job_id = ${jobId}`;
    return { ...seed, agentId, sessions, broker, chat, browse, finish, artifacts };
  }

  test('a chat with no list opens a public page, and a private address is still refused', async () => {
    const s = await space();
    const opened = await s.browse(s.claims, 'open', { url: `${site.url}/news` });
    expect(opened.reason).toBe('');
    expect(opened.status).toBe('succeeded');
    const observation = opened.detail.observation as JsonObject;
    expect(observation.url).toBe(`${site.url}/news`);
    expect(observation.title).toBe('Morning news');
    // A page that loaded leaves its look with the answer.
    expect((await s.artifacts(s.claims.job_id)).map((row) => row.mime).sort()).toEqual([
      'image/png',
      'text/plain',
    ]);
    const refused = await s.browse(s.claims, 'open', { url: site.privateUrl });
    expect(refused.status).toBe('failed');
    expect(refused.reason).toBe('non_public_address');
    await s.finish(s.claims);
    await s.sessions.afterAttempt(s.claims.attempt_id);
  }, 60_000);

  test('a space that turned public reads off keeps its browser to the sites work was given', async () => {
    const s = await space();
    await saveWebReadSetting(sql, s.claims.space_id, false);
    const refused = await s.browse(s.claims, 'open', { url: `${site.url}/news` });
    expect(refused.status).toBe('failed');
    expect(refused.reason).toBe(`domain_not_allowed: ${PUBLIC_READS_OFF}`);
    // Work given a list keeps to it, with the setting on again.
    await saveWebReadSetting(sql, s.claims.space_id, true);
    const listed = await s.chat();
    await sql`update job set constraints = ${JSON.stringify({ public_compartment: false, allowed_domains: ['listed.example'] })}::jsonb
      where id = ${listed.job_id}`;
    await s.finish(s.claims);
    const outside = await s.browse(listed, 'open', { url: `${site.url}/news` });
    expect(outside.status).toBe('failed');
    expect(outside.reason).toStartWith('domain_not_allowed: This work may open only the sites');
    await s.finish(listed);
    await s.sessions.afterAttempt(listed.attempt_id);
  }, 60_000);

  test('a second chat waits briefly, is told plainly, and gets the browser once the first ends', async () => {
    const s = await space();
    const first = await s.browse(s.claims, 'open', { url: `${site.url}/news` });
    expect(first.status).toBe('succeeded');
    const second = await s.chat();
    // The first chat's turn is still running: the second waits, then hears why in plain words.
    const busy = await s.browse(second, 'open', { url: `${site.url}/weather` });
    expect(busy.status).toBe('failed');
    expect(busy.reason).toBe(BROWSER_BUSY);
    expect(busy.reason).not.toContain('session_busy');
    // A turn that ends while the second chat waits hands the browser over within the wait.
    // A new step, not the refused one again: an identical step in one attempt is answered once.
    const waiting = s.browse(second, 'open', { url: `${site.url}/forecast` });
    await Bun.sleep(300);
    await s.finish(s.claims);
    const taken = await waiting;
    expect(taken.reason).toBe('');
    expect(taken.status).toBe('succeeded');
    expect((taken.detail.observation as JsonObject).url).toBe(`${site.url}/forecast`);
    // The first chat's page went with its session: the second chat's browser is its own.
    expect(taken.detail.session_id).not.toBe(first.detail.session_id);
    const looked = await s.browse(second, 'observe', {});
    expect((looked.detail.observation as JsonObject).url).toBe(`${site.url}/forecast`);
    // Stopped work gives the browser up at once, with nobody waiting for it.
    await sql`update job set state = 'cancelled' where id = ${second.job_id}`;
    await sql`update attempt set ended_at = now(), outcome = 'fenced' where id = ${second.attempt_id}`;
    await s.sessions.afterAttempt(second.attempt_id);
    expect(await (await pool.get(s.claims.space_id)).holder()).toBeNull();
  }, 60_000);

  test('a stopped chat frees the browser, and a finished turn keeps its pages for the next message', async () => {
    const s = await space();
    await s.browse(s.claims, 'open', { url: `${site.url}/news` });
    // A turn that finished keeps its session for the same chat's next message.
    await s.finish(s.claims);
    await s.sessions.afterAttempt(s.claims.attempt_id);
    const worker = await pool.get(s.claims.space_id);
    expect(await worker.holder()).toMatchObject({ job_id: s.claims.job_id });
    // Stop leaves a chat waiting for its next message, with its turn marked stopped.
    const turnId = recordId('turn');
    await sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
      values (${turnId}, ${s.claims.job_id}, ${s.agentId}, ${recordId('sub')}, 'Find the news', 'stopped')`;
    await sql`update job set state = 'waiting_for_input', current_turn_id = ${turnId} where id = ${s.claims.job_id}`;
    await s.sessions.afterAttempt(s.claims.attempt_id);
    expect(await worker.holder()).toBeNull();
  }, 60_000);

  test('a failed load and a blank tab leave no empty file and no error picture with the answer', async () => {
    const s = await space();
    const failed = await s.browse(s.claims, 'open', { url: 'http://unknown-host.invalid/' });
    expect(failed.status).toBe('failed');
    expect(failed.reason).toStartWith('site_not_found:');
    // Looking at what the tab shows after it still answers, and keeps nothing.
    const looked = await s.browse(s.claims, 'observe', {});
    expect(looked.status).toBe('succeeded');
    expect(String((looked.detail.observation as JsonObject).url)).not.toStartWith('http');
    expect(await s.artifacts(s.claims.job_id)).toHaveLength(0);
    // A page that loads after it is kept as before, and nothing kept is empty.
    await s.browse(s.claims, 'open', { url: `${site.url}/news` });
    const kept = await s.artifacts(s.claims.job_id);
    expect(kept).toHaveLength(2);
    expect(kept.every((row) => Number(row.size) > 0)).toBe(true);
    await s.finish(s.claims);
    await sql`update job set state = 'cancelled' where id = ${s.claims.job_id}`;
    await s.sessions.afterAttempt(s.claims.attempt_id);
  }, 60_000);
});
