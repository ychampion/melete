import { afterEach, expect, test } from 'bun:test';
import { connectorManifest, type JsonObject } from '@melete/contracts';
import { BrowserWorkerClient } from '../workers/browser/client.ts';
import type { BrowserSessionService } from '../workers/browser/routes.ts';
import { startBrowserServer } from '../workers/browser/server.ts';
import { BrowserFault, type BrowserSession, BrowserSessions } from '../workers/browser/sessions.ts';
import { browserManifest, createBrowserConnector } from './browser.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function fixture(response: ((body: JsonObject) => Response) | BrowserWorkerClient) {
  const commands: JsonObject[] = [];
  const parks: string[] = [];
  const captures: unknown[] = [];
  const session: BrowserSession = {
    id: 'brws_fixture',
    space_id: 'sp_01',
    profile_dir: 'private-to-worker',
    job_id: 'job_01',
    control_epoch: 4,
    control: 'automation',
    warm_until: Date.now() + 300000,
  };
  let worker: BrowserWorkerClient;
  if (response instanceof BrowserWorkerClient) worker = response;
  else {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as JsonObject;
        commands.push(body);
        return response(body);
      },
    });
    servers.push(server);
    worker = new BrowserWorkerClient(server.url.href, 'x'.repeat(32));
  }
  const sessions: Pick<BrowserSessionService, 'lease' | 'park'> = {
    async lease() {
      return { session, worker };
    },
    async park(_ctx, _id, reason) {
      parks.push(reason);
    },
  };
  const connector = createBrowserConnector({
    sessions,
    artifacts: async (_ctx, observation) => {
      captures.push(observation);
      return {
        id: observation.id,
        tree: { artifact_id: 'art_tree' },
        screenshot: { artifact_id: 'art_shot' },
        schema: observation.schema,
      };
    },
  });
  return { connector, commands, parks, captures };
}

test('browser catalog exposes consequential commits as approved external writes', () => {
  connectorManifest.parse(browserManifest);
  expect(browserManifest.provider).toBe('web');
  expect(browserManifest.tools.find((tool) => tool.name === 'browser.submit')).toMatchObject({
    effect_class: 'write_external',
    requires_approval: true,
  });
  for (const kind of ['fill', 'click', 'select'])
    expect(browserManifest.tools.find((tool) => tool.name === `browser.${kind}`)).toMatchObject({
      effect_class: 'write_reversible',
    });
});

test('an empty 413 rejects an oversized submit before the controller and is not unknown', async () => {
  const sessions = new BrowserSessions({ spaceId: 'sp_01', spaceRoot: 'unused-without-a-lease' });
  let commands = 0;
  const token = 'x'.repeat(32);
  const server = await startBrowserServer({
    sessions,
    token,
    command: async () => {
      commands++;
      return {};
    },
  });
  try {
    const s = fixture(new BrowserWorkerClient(server.url.href, token));
    const submit = connectorAction('browser.submit', {
      session_id: 'brws_fixture',
      control_epoch: 4,
      intent: { fields: { oversized: 'x'.repeat(300 * 1024) } },
    });
    expect(await s.connector.execute(submit, connectorContext(submit))).toEqual({
      outcome: 'failed',
      reason: 'worker_http_413',
      retryable: false,
    });
    expect(commands).toBe(0);
    expect(sessions.page).toBeUndefined();
  } finally {
    await server.stop(true);
    await sessions.close();
  }
});

test.each([400, 413, 500, 200])(
  'malformed worker response %i preserves commit certainty',
  async (status) => {
    const s = fixture(() => new Response('not JSON', { status }));
    const submit = connectorAction('browser.submit', {
      session_id: 'brws_fixture',
      control_epoch: 4,
      intent: {},
    });
    const result = await s.connector.execute(submit, connectorContext(submit));
    expect(result.outcome).toBe(status >= 400 && status < 500 ? 'failed' : 'unknown');
    if (result.outcome === 'failed') {
      expect(result.reason).toBe(`worker_http_${status}`);
      expect(result.retryable).toBe(false);
    }
  },
);

test('observation persists captures and returns handles without screenshot or tree bytes', async () => {
  const s = fixture(() =>
    Response.json({
      session_id: 'brws_fixture',
      control_epoch: 4,
      observation: {
        id: 'observation_1',
        url: 'https://fixture.example/',
        tree: 'private page contents',
        screenshot: 'c2NyZWVuc2hvdA==',
        schema: [{ label: 'Name', role: 'textbox', required: true }],
      },
    }),
  );
  const action = connectorAction('browser.observe', {});
  const result = await s.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  expect(s.captures).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('private page contents');
  expect(JSON.stringify(result)).not.toContain('c2NyZWVuc2hvdA==');
  expect(JSON.stringify(result)).not.toContain('private-to-worker');
  expect(s.commands[0]).toMatchObject({
    session_id: 'brws_fixture',
    job_id: action.job_id,
    control_epoch: 4,
  });
});

test('planned epoch is never refreshed at dispatch and controller refusal parks the job', async () => {
  const s = fixture(() => Response.json({ error: 'stale_control_epoch' }, { status: 409 }));
  const action = connectorAction('browser.fill', {
    session_id: 'brws_fixture',
    control_epoch: 3,
    after_observation: 'obs_prior',
    label: 'Name',
    value: 'Alice',
  });
  const result = await s.connector.execute(action, connectorContext(action));
  expect(s.commands[0]?.control_epoch).toBe(3);
  expect(result).toEqual({ outcome: 'failed', reason: 'stale_control_epoch', retryable: false });
  expect(s.parks).toEqual(['stale_control_epoch']);
});

test('read refresh keys stay inside the broker and observe failures park the leased session', async () => {
  const s = fixture(() => Response.json({ error: 'human_control' }, { status: 409 }));
  const action = connectorAction('browser.observe', { after_observation: 'obs_prior' });
  expect((await s.connector.execute(action, connectorContext(action))).outcome).toBe('failed');
  expect(s.commands[0]?.operation).toEqual({ kind: 'observe' });
  expect(s.parks).toEqual(['human_control']);
});

test('non-observation actions cannot invent a current epoch and identity mismatch never dispatches', async () => {
  const s = fixture(() => Response.json({}));
  const action = connectorAction('browser.fill', { label: 'Name', value: 'Alice' });
  await expect(s.connector.execute(action, connectorContext(action))).rejects.toThrow(
    'planned browser session',
  );
  const observe = connectorAction('browser.observe', {});
  const missingObservation = connectorAction('browser.fill', {
    session_id: 'brws_fixture',
    control_epoch: 4,
    label: 'Name',
    value: 'Alice',
  });
  await expect(
    s.connector.execute(missingObservation, connectorContext(missingObservation)),
  ).rejects.toThrow('observation id');
  await expect(
    s.connector.execute(observe, { ...connectorContext(observe), job_id: 'job_other' }),
  ).rejects.toThrow('identity mismatch');
  expect(s.commands).toHaveLength(0);
});

test('sensitive-input refusal is a service wait and uncertain submits are never marked unsent', async () => {
  const s = fixture(() =>
    Response.json({ error: 'sensitive_input_require_takeover' }, { status: 409 }),
  );
  const action = connectorAction('browser.fill', {
    session_id: 'brws_fixture',
    control_epoch: 4,
    after_observation: 'obs_prior',
    label: 'Password',
    value: 'a-secret',
  });
  expect((await s.connector.execute(action, connectorContext(action))).outcome).toBe('failed');
  expect(s.parks).toEqual(['sensitive_input_require_takeover']);
  const sessions: Pick<BrowserSessionService, 'lease' | 'park'> = {
    lease: async () => {
      throw new Error('transport failed');
    },
    park: async () => {},
  };
  const connector = createBrowserConnector({ sessions, artifacts: async () => ({}) });
  const submit = connectorAction('browser.submit', {
    session_id: 'brws_fixture',
    control_epoch: 4,
    intent: {},
  });
  expect((await connector.execute(submit, connectorContext(submit))).outcome).toBe('unknown');
  expect(new BrowserFault('human_control').reason).toBe('human_control');
});
