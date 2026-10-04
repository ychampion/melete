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
  const state = { opened: false };
  const sessions: Pick<BrowserSessionService, 'lease' | 'park'> = {
    async lease() {
      return { session, worker, opened: state.opened };
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
  return { connector, commands, parks, captures, sessions, state };
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

test.each(['fill', 'submit'])(
  'a park failure preserves the named %s refusal and records failed parking',
  async (kind) => {
    const s = fixture(() => Response.json({ error: 'stale_control_epoch' }, { status: 409 }));
    s.sessions.park = async (_ctx, _id, reason) => {
      s.parks.push(reason);
      throw new Error('database connection secret must not enter the result');
    };
    const action = connectorAction(`browser.${kind}`, {
      session_id: 'brws_fixture',
      control_epoch: 3,
      after_observation: 'obs_prior',
      ...(kind === 'fill' ? { label: 'Name', value: 'Alice' } : { intent: {} }),
    });
    expect(await s.connector.execute(action, connectorContext(action))).toEqual({
      outcome: 'failed',
      reason: 'stale_control_epoch; browser_park_failed',
      retryable: false,
    });
    expect(s.parks).toEqual(['stale_control_epoch']);
  },
);

test('read refresh keys stay inside the broker and observe failures park the leased session', async () => {
  const s = fixture(() => Response.json({ error: 'human_control' }, { status: 409 }));
  const action = connectorAction('browser.observe', { after_observation: 'obs_prior' });
  expect((await s.connector.execute(action, connectorContext(action))).outcome).toBe('failed');
  expect(s.commands[0]?.operation).toEqual({ kind: 'observe' });
  expect(s.parks).toEqual(['human_control']);
});

test('an unplanned submit never dispatches and identity mismatch never dispatches', async () => {
  const s = fixture(() => Response.json({}));
  const submit = connectorAction('browser.submit', { intent: {} });
  await expect(s.connector.execute(submit, connectorContext(submit))).rejects.toThrow(
    'planned browser session',
  );
  const observe = connectorAction('browser.observe', {});
  await expect(
    s.connector.execute(observe, { ...connectorContext(observe), job_id: 'job_other' }),
  ).rejects.toThrow('identity mismatch');
  expect(s.commands).toHaveLength(0);
});

const observed = (body: JsonObject) =>
  Response.json({
    session_id: 'brws_fixture',
    control_epoch: 4,
    observation: {
      id: `obs_${(body.operation as JsonObject).kind}`,
      url: 'https://fixture.example/',
      tree: 'tree',
      screenshot: '',
      schema: [],
    },
  });

test("steps without a session act on the job's current session at its epoch", async () => {
  const s = fixture(observed);
  const action = connectorAction('browser.fill', { label: 'Name', value: 'Alice' });
  const result = await s.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  expect(s.commands).toEqual([
    {
      session_id: 'brws_fixture',
      job_id: action.job_id,
      control_epoch: 4,
      operation: { kind: 'fill', label: 'Name', value: 'Alice' },
    },
  ]);
});

test('a browser this step started is looked at once before the step acts', async () => {
  const s = fixture(observed);
  s.state.opened = true;
  const action = connectorAction('browser.open', { url: 'https://fixture.example/' });
  const result = await s.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  expect(s.commands.map((command) => command.operation)).toEqual([
    { kind: 'observe' },
    { kind: 'open', url: 'https://fixture.example/' },
  ]);
  const look = connectorAction('browser.observe', {});
  s.commands.length = 0;
  await s.connector.execute(look, connectorContext(look));
  expect(s.commands.map((command) => command.operation)).toEqual([{ kind: 'observe' }]);
});

test('a named session that has closed says how to reach the current one', async () => {
  const s = fixture(() => Response.json({}));
  s.sessions.lease = async () => {
    throw new BrowserFault('session_not_found');
  };
  const action = connectorAction('browser.fill', {
    session_id: 'brws_closed',
    label: 'Name',
    value: 'Alice',
  });
  const result = await s.connector.execute(action, connectorContext(action));
  expect(result).toMatchObject({ outcome: 'failed', retryable: false });
  if (result.outcome !== 'failed') throw new Error('expected a failure');
  expect(result.reason).toStartWith('session_not_found');
  expect(result.reason).toContain("Leave session_id and control_epoch out to use this job's");
  expect(s.parks).toEqual([]);
});

/** A query stand-in holding bindings for two jobs; it answers only for the scope it is asked. */
function bindings(rows: Array<{ id: string; job_id: string; control_epoch: number }>) {
  const asked: unknown[][] = [];
  const tx = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    asked.push(values);
    const [space, job] = values;
    return space === 'sp_01'
      ? rows
          .filter((row) => row.job_id === job)
          .map(({ id, control_epoch }) => ({ id, control_epoch }))
      : [];
  }) as unknown as Parameters<NonNullable<ReturnType<typeof createBrowserConnector>['prepare']>>[2];
  return { tx, asked };
}

test("an unknown session id is refused at proposal with only this job's sessions listed", async () => {
  const s = fixture(() => Response.json({}));
  const { tx } = bindings([
    { id: 'brws_mine', job_id: 'job_01', control_epoch: 2 },
    { id: 'brws_theirs', job_id: 'job_other', control_epoch: 7 },
  ]);
  const prepare = s.connector.prepare;
  if (!prepare) throw new Error('browser connector binds sessions at proposal');
  const ctx = connectorContext(connectorAction('browser.fill', {}));
  for (const named of ['brws_made_up', 'brws_theirs']) {
    const message = await prepare({ session_id: named, label: 'Name', value: 'A' }, ctx, tx).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).toContain(`no browser session ${named} in this job`);
    expect(message).toContain("This job's sessions: brws_mine.");
    expect(message).not.toContain('brws_theirs.');
  }
  expect(await prepare({ session_id: 'brws_mine', label: 'Name', value: 'A' }, ctx, tx)).toEqual({
    session_id: 'brws_mine',
    label: 'Name',
    value: 'A',
  });
  expect(await prepare({ label: 'Name', value: 'A' }, ctx, tx)).toEqual({
    label: 'Name',
    value: 'A',
  });
});

test("a submit is bound at proposal to the job's current session and its epoch", async () => {
  const s = fixture(() => Response.json({}));
  const prepare = s.connector.prepare;
  if (!prepare) throw new Error('browser connector binds sessions at proposal');
  const ctx = connectorContext(connectorAction('browser.submit', {}));
  const { tx } = bindings([
    { id: 'brws_mine', job_id: 'job_01', control_epoch: 2 },
    { id: 'brws_theirs', job_id: 'job_other', control_epoch: 7 },
  ]);
  expect(await prepare({ intent: { name: 'Send' } }, ctx, tx)).toEqual({
    intent: { name: 'Send' },
    session_id: 'brws_mine',
    control_epoch: 2,
  });
  // An epoch the caller planned under is kept, so a stale plan is still refused at dispatch.
  expect(await prepare({ intent: {}, session_id: 'brws_mine', control_epoch: 1 }, ctx, tx)).toEqual(
    { intent: {}, session_id: 'brws_mine', control_epoch: 1 },
  );
  const empty = bindings([{ id: 'brws_theirs', job_id: 'job_other', control_epoch: 7 }]);
  await expect(prepare({ intent: {} }, ctx, empty.tx)).rejects.toThrow(
    'no browser page to submit from',
  );
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
