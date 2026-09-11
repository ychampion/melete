/**
 * Contract tests. Every route is called and its body is parsed with the schema
 * openapi.json was generated from, so "the mock answers" and "the mock answers
 * something the contract describes" are the same assertion.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  actionListResponse,
  actionResponse,
  approvalDecisionResponse,
  approvalListResponse,
  attemptListResponse,
  attemptResponse,
  connectionListResponse,
  connectionResponse,
  errorResponse,
  eventPage,
  healthResponse,
  jobListResponse,
  jobResponse,
  knowledgeRecordResponse,
  knowledgeSearchResponse,
  proposeKnowledgeResponse,
  reactionListResponse,
  reactionResponse,
  SCHEMA_VERSION,
  skillListResponse,
  spaceListResponse,
  THUMBS_DOWN,
  THUMBS_UP,
} from '@melete/contracts';
import { silentWav } from '../../melete/src/connectors/wav.ts';
import { createMock } from './index.ts';
import type { Runner } from './runner.ts';
import { newId, type Store } from './store.ts';

type Mock = ReturnType<typeof createMock>;

let mock: Mock;

const call = async (
  app: Mock['app'],
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> => {
  const response = await app.fetch(
    new Request(`http://mock.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, json: await response.json() };
};

/** Play the scenario to its first decision point and hand back the approval. */
const toApproval = async (mock: Mock, objective: string) => {
  const created = await call(mock.app, 'POST', '/jobs', {
    space_id: mock.spaceId,
    title: objective.slice(0, 60),
    objective,
  });
  const jobId = jobResponse.parse(created.json).job.id;
  await mock.runner.settle();
  const approvals = approvalListResponse.parse(
    (await call(mock.app, 'GET', '/approvals')).json,
  ).approvals;
  return { jobId, approval: approvals.find((a) => a.job_id === jobId) };
};

beforeEach(() => {
  mock = createMock({ speed: 0 });
});

test('the mock content endpoint serves WAV bytes only for its session space', async () => {
  const created = await call(mock.app, 'POST', '/jobs', {
    space_id: mock.spaceId,
    title: 'Audio',
    objective: 'Audio fixture',
  });
  const jobId = jobResponse.parse(created.json).job.id;
  const id = newId('art');
  const bytes = silentWav({ script: 'Mock artifact.' });
  mock.store.artifacts.set(id, {
    artifact: {
      id,
      space_id: mock.spaceId,
      job_id: jobId,
      path: 'artifacts/episode.wav',
      content_hash: createHash('sha256').update(bytes).digest('hex'),
      mime: 'audio/wav',
      size: bytes.length,
      audience: 'owner',
      created_at: new Date().toISOString(),
    },
    bytes,
  });
  const session = await mock.app.request('/spaces');
  const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
  const response = await mock.app.request(`/artifacts/${id}/content`, { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('audio/wav');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  expect((await mock.app.request(`/artifacts/${id}/content`)).status).toBe(401);
  const entry = mock.store.artifacts.get(id);
  if (!entry) throw new Error('Missing fixture artifact');
  entry.artifact.space_id = newId('sp');
  expect((await mock.app.request(`/artifacts/${id}/content`, { headers: { cookie } })).status).toBe(
    404,
  );
});

describe('every route answers with a body the contract describes', () => {
  test('GET /health', async () => {
    const { status, json } = await call(mock.app, 'GET', '/health');
    expect(status).toBe(200);
    expect(healthResponse.parse(json).status).toBe('ok');
  });

  test('GET and POST /spaces', async () => {
    const listed = await call(mock.app, 'GET', '/spaces');
    expect(spaceListResponse.parse(listed.json).spaces).toHaveLength(1);

    const created = await call(mock.app, 'POST', '/spaces', { name: 'work' });
    expect(created.status).toBe(201);
    expect(spaceListResponse.parse(created.json).spaces).toHaveLength(2);
  });

  test('POST /spaces refuses an empty name', async () => {
    const { status, json } = await call(mock.app, 'POST', '/spaces', { name: '' });
    expect(status).toBe(400);
    expect(errorResponse.parse(json).error.code).toBe('invalid_request');
  });

  test('GET and POST /jobs', async () => {
    const created = await call(mock.app, 'POST', '/jobs', {
      space_id: mock.spaceId,
      title: 'Chase the heating repair',
      objective: 'Ask the building manager for a date.',
    });
    expect(created.status).toBe(201);
    const job = jobResponse.parse(created.json).job;
    expect(job.state).toBe('queued');

    const listed = await call(mock.app, 'GET', `/jobs?space_id=${mock.spaceId}&limit=10`);
    expect(jobListResponse.parse(listed.json).jobs).toHaveLength(1);
  });

  test('GET /jobs/{jobId} and its 404', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');
    const found = await call(mock.app, 'GET', `/jobs/${jobId}`);
    expect(jobResponse.parse(found.json).job.id).toBe(jobId);

    const missing = await call(mock.app, 'GET', '/jobs/job_01J000000000000000000000');
    expect(missing.status).toBe(404);
    expect(errorResponse.parse(missing.json).error.code).toBe('not_found');
  });

  test('GET /jobs/{jobId}/attempts and GET /attempts/{attemptId}', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');
    const listed = await call(mock.app, 'GET', `/jobs/${jobId}/attempts`);
    const attempts = attemptListResponse.parse(listed.json).attempts;
    expect(attempts.length).toBeGreaterThan(0);

    const first = attempts[0];
    if (!first) throw new Error('no attempt');
    const one = await call(mock.app, 'GET', `/attempts/${first.id}`);
    const attempt = attemptResponse.parse(one.json).attempt;
    expect(attempt.provider).toBe('test');
    expect(attempt.model_actual).toBe(attempt.model);
  });

  test('GET /events and GET /jobs/{jobId}/events as JSON', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');

    const global = await call(mock.app, 'GET', '/events?after=0&limit=500');
    const page = eventPage.parse(global.json);
    expect(page.events.length).toBeGreaterThan(3);
    expect(page.next_cursor).toBe(page.events[page.events.length - 1]?.seq ?? 0);

    const scoped = eventPage.parse(
      (await call(mock.app, 'GET', `/jobs/${jobId}/events?after=0&limit=500`)).json,
    );
    expect(scoped.events.every((event) => event.job_id === jobId)).toBe(true);
  });

  test('GET /actions and GET /actions/{actionId}', async () => {
    await toApproval(mock, 'Chase the heating repair by email.');
    const listed = await call(mock.app, 'GET', '/actions?limit=50');
    const actions = actionListResponse.parse(listed.json).actions;
    expect(actions).toHaveLength(1);

    const first = actions[0];
    if (!first) throw new Error('no action');
    const one = await call(mock.app, 'GET', `/actions/${first.id}`);
    expect(actionResponse.parse(one.json).action.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('GET /approvals and POST /approvals/{approvalId}', async () => {
    const { approval } = await toApproval(mock, 'Chase the heating repair by email.');
    if (!approval) throw new Error('no approval was raised');

    const decided = await call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
      decision: 'approved',
      payload_hash: approval.payload_hash,
    });
    expect(decided.status).toBe(200);
    expect(approvalDecisionResponse.parse(decided.json).decision).toBe('approved');
  });

  test('GET, POST and health on /connections', async () => {
    const listed = await call(mock.app, 'GET', '/connections');
    const connections = connectionListResponse.parse(listed.json).connections;
    expect(connections).toHaveLength(3);
    expect(connections.every((c) => !('secret_ref' in c))).toBe(true);

    const created = await call(mock.app, 'POST', '/connections', {
      space_id: mock.spaceId,
      provider: 'caldav',
      label: 'calendar',
      scopes: ['calendar.read'],
      credentials: { url: 'https://dav.example.com', password: 'hunter2' },
    });
    expect(created.status).toBe(201);
    const connection = connectionResponse.parse(created.json).connection;
    expect(JSON.stringify(connection)).not.toContain('hunter2');

    const checked = await call(mock.app, 'POST', `/connections/${connection.id}/health`);
    expect(connectionResponse.parse(checked.json).connection.health).toBe('ok');

    const one = await call(mock.app, 'GET', `/connections/${connection.id}`);
    expect(connectionResponse.parse(one.json).connection.id).toBe(connection.id);
  });

  test('GET /knowledge/search, GET and DELETE /knowledge/{recordId}', async () => {
    const found = await call(
      mock.app,
      'GET',
      `/knowledge/search?space_id=${mock.spaceId}&q=heating&limit=5`,
    );
    const hits = knowledgeSearchResponse.parse(found.json).hits;
    expect(hits.length).toBeGreaterThan(0);

    const first = hits[0];
    if (!first) throw new Error('no hit');
    const record = await call(mock.app, 'GET', `/knowledge/${first.id}`);
    expect(knowledgeRecordResponse.parse(record.json).frontmatter.schema_version).toBe(
      SCHEMA_VERSION,
    );

    const retracted = await call(mock.app, 'DELETE', `/knowledge/${first.id}`, {
      reason: 'The engineer came and it is fixed.',
    });
    expect(knowledgeRecordResponse.parse(retracted.json).frontmatter.status).toBe('retracted');

    const again = await call(
      mock.app,
      'GET',
      `/knowledge/search?space_id=${mock.spaceId}&q=heating&limit=5`,
    );
    const remaining = knowledgeSearchResponse.parse(again.json).hits;
    expect(remaining.some((hit) => hit.id === first.id)).toBe(false);
  });

  test('POST /knowledge/proposals returns a diff a person can read', async () => {
    const { json, status } = await call(mock.app, 'POST', '/knowledge/proposals', {
      space: 'personal',
      path: 'knowledge/engineer-booked.md',
      rationale: 'The manager gave a date.',
      body: 'An engineer is booked for 19 September.',
      frontmatter: {
        id: 'k_01JBQ8G7Z9X4M2N0P1R3S5T7V9',
        title: 'An engineer is booked for 19 September',
        space: 'personal',
        audience: 'private',
        type: 'fact',
        status: 'active',
        confidence: 'high',
        asserted_by: 'document',
        source: { kind: 'file', ref: 'raw/ht-4471-reply.eml', quote: '19 September', sha256: null },
        observed_at: '2026-09-11',
        valid_from: '2026-09-11',
        valid_until: null,
        supersedes: [],
        superseded_by: null,
        created: '2026-09-11',
        updated: '2026-09-11',
        tags: ['flat'],
        links: [],
        schema_version: SCHEMA_VERSION,
      },
    });
    expect(status).toBe(201);
    const proposal = proposeKnowledgeResponse.parse(json);
    expect(proposal.path.startsWith('.proposed/')).toBe(true);
    expect(proposal.diff).toContain('+An engineer is booked');
  });

  test('GET /skills', async () => {
    const { json } = await call(mock.app, 'GET', '/skills');
    const skills = skillListResponse.parse(json).skills;
    expect(skills).toHaveLength(2);
    expect(skills.some((skill) => skill.space_id === null)).toBe(true);
  });

  test('an unknown endpoint says so in the contract error shape', async () => {
    const { status, json } = await call(mock.app, 'GET', '/nope');
    expect(status).toBe(404);
    expect(errorResponse.parse(json).error.code).toBe('not_found');
  });
});

describe('the rules the API is supposed to enforce', () => {
  test('an approval cannot be spent on different content', async () => {
    const { approval } = await toApproval(mock, 'Chase the heating repair by email.');
    if (!approval) throw new Error('no approval was raised');

    const { status, json } = await call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
      decision: 'approved',
      payload_hash: 'f'.repeat(64),
    });
    expect(status).toBe(409);
    expect(errorResponse.parse(json).error.code).toBe('approval_hash_mismatch');
  });

  test('a decided approval cannot be decided twice', async () => {
    const { approval } = await toApproval(mock, 'Chase the heating repair by email.');
    if (!approval) throw new Error('no approval was raised');
    const decide = () =>
      call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
        decision: 'approved',
        payload_hash: approval.payload_hash,
      });
    expect((await decide()).status).toBe(200);
    expect((await decide()).status).toBe(409);
  });

  test('a message to a job that is not waiting for input is refused', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');
    const { status, json } = await call(mock.app, 'POST', `/jobs/${jobId}/messages`, {
      text: 'hello?',
    });
    expect(status).toBe(409);
    expect(errorResponse.parse(json).error.code).toBe('not_waiting_for_input');
  });

  test('cancelling twice is refused by the state machine, not by the route', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');
    const first = await call(mock.app, 'POST', `/jobs/${jobId}/cancel`, { reason: 'changed mind' });
    expect(jobResponse.parse(first.json).job.state).toBe('cancelled');

    const second = await call(mock.app, 'POST', `/jobs/${jobId}/cancel`, {});
    expect(second.status).toBe(409);
    expect(errorResponse.parse(second.json).error.code).toBe('already_terminal');
  });

  test('resolving an action that is not awaiting reconciliation is refused', async () => {
    await toApproval(mock, 'Chase the heating repair by email.');
    const actions = actionListResponse.parse(
      (await call(mock.app, 'GET', '/actions')).json,
    ).actions;
    const first = actions[0];
    if (!first) throw new Error('no action');
    const { status, json } = await call(mock.app, 'POST', `/actions/${first.id}/resolve`, {
      resolution: 'succeeded',
    });
    expect(status).toBe(409);
    expect(errorResponse.parse(json).error.code).toBe('not_awaiting_reconciliation');
  });

  test('the payload the approval shows is canonical, not what the model typed', async () => {
    const { approval } = await toApproval(mock, 'Chase the heating repair by email.');
    if (!approval) throw new Error('no approval was raised');
    // Two spellings of one recipient went in; one normalised address comes out,
    // so a person is never asked to approve the same send twice.
    expect(approval.canonical_payload.to).toEqual(['manager@example.com']);
  });
});

describe('the event stream', () => {
  const readStream = async (
    app: Mock['app'],
    path: string,
    headers: Record<string, string> = {},
  ): Promise<string> => {
    const response = await app.fetch(
      new Request(`http://mock.test${path}`, {
        headers: { accept: 'text/event-stream', ...headers },
      }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no stream body');
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value);
  };

  test('replays the persisted log from the after cursor', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');
    const text = await readStream(mock.app, `/jobs/${jobId}/events?after=0`);
    expect(text).toContain('event: job_created');
    expect(text).toMatch(/^id: 1\n/);
  });

  test('honours Last-Event-ID over the after query', async () => {
    const { jobId } = await toApproval(mock, 'Chase the heating repair by email.');
    const text = await readStream(mock.app, `/jobs/${jobId}/events?after=0`, {
      'last-event-id': '3',
    });
    expect(text).not.toContain('\nid: 1\n');
    expect(text.startsWith('id: 4')).toBe(true);
  });

  /**
   * Read until the marker shows up. The stream stays open after the replay, so
   * the read is raced against a short timer: a replay that stops early has to
   * fail on what it delivered, not hang waiting for what it never will.
   */
  const drainUntil = async (app: Mock['app'], path: string, marker: string): Promise<string> => {
    const response = await app.fetch(
      new Request(`http://mock.test${path}`, { headers: { accept: 'text/event-stream' } }),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no stream body');
    const decoder = new TextDecoder();
    const idle = Symbol('idle');
    let text = '';
    // Each frame is enqueued on its own, so one read is one frame.
    for (let read = 0; read < 5000 && !text.includes(marker); read += 1) {
      const next = await Promise.race([
        reader.read(),
        new Promise<typeof idle>((resolve) => setTimeout(() => resolve(idle), 250)),
      ]);
      if (next === idle || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    return text;
  };

  // A page is capped because the caller asked for a page and gets a cursor to
  // continue with. A stream has no second request to make, so a cap would hand
  // the client a hole it never asked about.
  test('replays a long history in full rather than capping it', async () => {
    for (let n = 0; n < 1200; n += 1) {
      mock.store.append({ type: 'notice', payload: { level: 'info', title: `n${n}`, body: '' } });
    }
    const text = await drainUntil(mock.app, '/events?after=0', 'id: 1200');
    expect(text).toContain('id: 1000\n');
    expect(text).toContain('id: 1200\n');
  });

  test('a page still honours the limit it was given, and says there is more', async () => {
    for (let n = 0; n < 300; n += 1) {
      mock.store.append({ type: 'notice', payload: { level: 'info', title: `n${n}`, body: '' } });
    }
    const page = eventPage.parse((await call(mock.app, 'GET', '/events?after=0&limit=50')).json);
    expect(page.events).toHaveLength(50);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBe(50);
  });
});

describe('the runner uses the real state machine', () => {
  const stateOf = async (mock: Mock, jobId: string) =>
    jobResponse.parse((await call(mock.app, 'GET', `/jobs/${jobId}`)).json).job.state;

  test('an approved send runs to completed with a receipt', async () => {
    const { jobId, approval } = await toApproval(mock, 'Chase the heating repair by email.');
    if (!approval) throw new Error('no approval was raised');
    expect(await stateOf(mock, jobId)).toBe('waiting_for_approval');

    await call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
      decision: 'approved',
      payload_hash: approval.payload_hash,
    });
    await mock.runner.settle();

    expect(await stateOf(mock, jobId)).toBe('completed');
    const action = actionResponse.parse(
      (await call(mock.app, 'GET', `/actions/${approval.action_id}`)).json,
    ).action;
    expect(action.status).toBe('succeeded');
    expect(action.receipt?.external_ref).toBe('<20260911.ht4471@example.com>');
  });

  test('a denied send leaves the job waiting for input and sends nothing', async () => {
    const { jobId, approval } = await toApproval(mock, 'Chase the heating repair by email.');
    if (!approval) throw new Error('no approval was raised');

    await call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
      decision: 'denied',
      payload_hash: approval.payload_hash,
    });
    await mock.runner.settle();

    expect(await stateOf(mock, jobId)).toBe('waiting_for_input');
    const action = actionResponse.parse(
      (await call(mock.app, 'GET', `/actions/${approval.action_id}`)).json,
    ).action;
    expect(action.status).toBe('denied');
    expect(action.dispatched_at).toBeNull();

    const answered = await call(mock.app, 'POST', `/jobs/${jobId}/messages`, {
      text: 'Ask for a date in the first line instead.',
    });
    expect(answered.status).toBe(202);
    await mock.runner.settle();
    expect(await stateOf(mock, jobId)).toBe('completed');
  });

  test('an unknown outcome parks the job at needs_reconciliation', async () => {
    const { jobId, approval } = await toApproval(
      mock,
      'Write one line to the flaky test destination and tell me if the outcome is unknown.',
    );
    if (!approval) throw new Error('no approval was raised');

    await call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
      decision: 'approved',
      payload_hash: approval.payload_hash,
    });
    await mock.runner.settle();

    expect(await stateOf(mock, jobId)).toBe('needs_reconciliation');
    const action = actionResponse.parse(
      (await call(mock.app, 'GET', `/actions/${approval.action_id}`)).json,
    ).action;
    expect(action.status).toBe('unknown');
    expect(action.dispatched_at).not.toBeNull();

    const settled = await call(mock.app, 'POST', `/actions/${action.id}/resolve`, {
      resolution: 'succeeded',
      note: 'The line is in the ledger. I checked.',
    });
    expect(actionResponse.parse(settled.json).action.status).toBe('succeeded');
    await mock.runner.settle();
    expect(await stateOf(mock, jobId)).toBe('completed');
  });

  test('an action is never dispatched twice, whatever the outcome was', async () => {
    const { approval } = await toApproval(
      mock,
      'Write one line to the flaky test destination and tell me if the outcome is unknown.',
    );
    if (!approval) throw new Error('no approval was raised');
    await call(mock.app, 'POST', `/approvals/${approval.approval_id}`, {
      decision: 'approved',
      payload_hash: approval.payload_hash,
    });
    await mock.runner.settle();
    await call(mock.app, 'POST', `/actions/${approval.action_id}/resolve`, {
      resolution: 'unresolved',
      note: 'I cannot tell.',
    });
    await mock.runner.settle();

    const events = eventPage.parse((await call(mock.app, 'GET', '/events?limit=1000')).json).events;
    const dispatches = events.filter(
      (event) =>
        event.type === 'action_status_changed' &&
        (event.payload as { status?: string }).status === 'dispatched',
    );
    expect(dispatches).toHaveLength(1);
  });
});

describe('reactions', () => {
  /** The mock's transcript is its event log, so a message id is an event seq. */
  const aMessage = async (): Promise<{ jobId: string; messageId: string }> => {
    const created = await call(mock.app, 'POST', '/jobs', {
      space_id: mock.spaceId,
      title: 'Chase the heating repair',
      objective: 'Chase the heating repair by email.',
    });
    const jobId = jobResponse.parse(created.json).job.id;
    const events = eventPage.parse(
      (await call(mock.app, 'GET', `/jobs/${jobId}/events?limit=1000`)).json,
    ).events;
    const message = events.find((event) => event.type !== 'reaction');
    if (!message) throw new Error('the mock produced no message');
    return { jobId, messageId: String(message.seq) };
  };

  test('a reaction is recorded, streamed as an event, and listed on its message', async () => {
    const { jobId, messageId } = await aMessage();
    const posted = await call(mock.app, 'POST', `/messages/${messageId}/reactions`, {
      emoji: THUMBS_UP,
    });
    expect(posted.status).toBe(201);
    const parsed = reactionResponse.parse(posted.json).reaction;
    expect(parsed.message_id).toBe(messageId);
    expect(parsed.by).toBe('person');
    expect(parsed.job_id).toBe(jobId);

    const listed = await call(mock.app, 'GET', `/messages/${messageId}/reactions`);
    expect(reactionListResponse.parse(listed.json).reactions).toHaveLength(1);

    const perJob = await call(mock.app, 'GET', `/jobs/${jobId}/reactions`);
    expect(reactionListResponse.parse(perJob.json).reactions).toHaveLength(1);

    const events = eventPage.parse(
      (await call(mock.app, 'GET', `/jobs/${jobId}/events?limit=1000`)).json,
    ).events;
    expect(events.filter((event) => event.type === 'reaction')).toHaveLength(1);
  });

  test('the public mock route rejects assistant attribution without writing', async () => {
    const { messageId } = await aMessage();
    const spoofed = await call(mock.app, 'POST', `/messages/${messageId}/reactions`, {
      emoji: THUMBS_UP,
      by: 'assistant',
    });
    expect(spoofed.status).toBe(400);
    const listed = await call(mock.app, 'GET', `/messages/${messageId}/reactions`);
    expect(reactionListResponse.parse(listed.json).reactions).toHaveLength(0);
  });

  test('reacting twice with the same emoji records one reaction', async () => {
    const { messageId } = await aMessage();
    await call(mock.app, 'POST', `/messages/${messageId}/reactions`, { emoji: THUMBS_DOWN });
    await call(mock.app, 'POST', `/messages/${messageId}/reactions`, { emoji: THUMBS_DOWN });
    const listed = await call(mock.app, 'GET', `/messages/${messageId}/reactions`);
    expect(reactionListResponse.parse(listed.json).reactions).toHaveLength(1);
  });

  test('a message that does not exist is a 404, and a word is not an emoji', async () => {
    const missing = await call(mock.app, 'POST', '/messages/999999/reactions', {
      emoji: THUMBS_UP,
    });
    expect(missing.status).toBe(404);
    expect(errorResponse.parse(missing.json).error.code).toBe('not_found');

    const { messageId } = await aMessage();
    const word = await call(mock.app, 'POST', `/messages/${messageId}/reactions`, {
      emoji: 'thumbsup',
    });
    expect(word.status).toBe(400);
  });
});

describe('the store and the runner keep their own invariants', () => {
  let store: Store;
  let runner: Runner;

  beforeEach(() => {
    store = mock.store;
    runner = mock.runner;
  });

  test('the event log is dense and monotonic', async () => {
    await toApproval(mock, 'Chase the heating repair by email.');
    const { events } = store.eventsAfter(0, { limit: 1000 });
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.dedup_key)).size).toBe(events.length);
  });

  test('signalling a job nobody is waiting on is a no-op', () => {
    expect(runner.signal('job_01J000000000000000000000', { kind: 'cancelled' })).toBe(false);
  });
});
