import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test('smoke CLI documents its bounded, pre-provisioned configuration', () => {
  const run = Bun.spawnSync(['bun', join(import.meta.dir, 'smoke.ts'), '--help']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain('--budget-usd');
  expect(run.stdout.toString()).toContain('--limit');
});

async function fixture(
  mode:
    | 'ok'
    | 'wrong-date'
    | 'wrong-summary'
    | 'extra-question'
    | 'wrong-model'
    | 'unverified'
    | 'duplicate-write'
    | 'missing-readback'
    | 'bare-input' = 'ok',
) {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { EXPECTED_MODEL } = await import('./smoke.ts');
  const root = await mkdtemp(join(tmpdir(), 'router-smoke-'));
  roots.push(root);
  const proof = {
    campaignId: 'campaign',
    targetId: 'target',
    revision: 'abc1234',
    gateId: 'gate',
    method: 'pre-call rejection verified',
    proofSha256: 'a'.repeat(64),
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
  };
  const verificationFile = join(root, 'proof.json');
  await writeFile(verificationFile, JSON.stringify(proof));
  let state = 0;
  let workflows = 0;
  let wrongApprovals = 0;
  let approvals = 0;
  let stops = 0;
  let answers = 0;
  const event = {
    summary: 'Practice pickup',
    start: '2027-01-10T09:00:00Z',
    end: '2027-01-10T10:00:00Z',
  };
  const question = {
    id: 'question',
    kind: 'question',
    state: 'open',
    title: 'Can you handle pickup?',
    starts_at: null,
    thread_id: 'thread',
    assignee: { principal_id: 'member' },
  };
  const card = {
    id: 'approval',
    version: 'version',
    payload_hash: 'hash',
    eligible_approvers: [{ principal_id: 'member' }],
  };
  const action = () => ({
    id: 'action',
    approvalId: 'approval',
    payloadHash: 'hash',
    memberId: 'member',
    kind: 'room.add_to_member_calendar',
    event,
    status: state >= 3 ? 'succeeded' : 'needs_approval',
    verifiedAt: state >= 3 ? new Date().toISOString() : null,
  });
  const response = (body: unknown, status = 200) => Response.json(body, { status });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/gate')
        return response({
          ...proof,
          hardCapUsd: 0.2,
          spentUsd: state >= 3 ? 0.002 : 0,
          heldUsd: 0,
          preCallEnforced: mode !== 'unverified',
          includesBackground: true,
          includesRetries: true,
          allModelPurposes: true,
          resolvedModels: { agent: EXPECTED_MODEL, memory: EXPECTED_MODEL, retry: EXPECTED_MODEL },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      if (path === '/evidence')
        return response({
          campaignId: 'campaign',
          targetId: 'target',
          revision: 'abc1234',
          quiescent: state === 0 || state >= 3,
          calls:
            state >= 3
              ? ['agent', 'background'].map((purpose) => ({
                  id: `call_${purpose}`,
                  purpose,
                  modelActual: mode === 'wrong-model' ? 'local/other' : EXPECTED_MODEL,
                  costUsd: 0.001,
                  status: 'succeeded',
                  jobId: purpose === 'agent' ? 'job_answer' : null,
                  latencyMs: 20,
                  startedAt: null,
                  endedAt: null,
                }))
              : [],
          sourceReads: state ? [{ messageId: 'seed', jobId: 'job_first', at: null }] : [],
          tools: state
            ? ['requester', 'member'].map((memberId) => ({
                jobId: 'job_first',
                name: 'room.member_freebusy',
                memberId,
                complete: true,
                at: null,
              }))
            : [],
          actions: state >= 2 ? [action()] : [],
          observations: [],
          calendarOperations:
            state >= 3
              ? [
                  { method: 'PUT', memberId: 'member', uid: 'action', status: 201, at: null },
                  ...(mode === 'duplicate-write'
                    ? [{ method: 'PUT', memberId: 'member', uid: 'action', status: 201, at: null }]
                    : []),
                  ...(mode === 'missing-readback'
                    ? []
                    : [
                        { method: 'GET', memberId: 'member', uid: 'action', status: 200, at: null },
                      ]),
                ]
              : [],
        });
      if (path === '/rooms/room/threads' && request.method === 'GET')
        return response({ threads: [] });
      if (path === '/rooms/room/threads' && request.method === 'POST') {
        workflows++;
        state = 1;
        const body = (await request.json()) as { text: string };
        expect(body.text).toContain('coach email');
        return response({ thread: { id: 'thread' }, request_job_id: 'job_first' }, 201);
      }
      if (path === '/rooms/room/board' && request.method === 'GET')
        return response({
          items:
            state === 0 || mode === 'bare-input'
              ? []
              : [
                  { ...question, state: state >= 2 ? 'answered' : 'open' },
                  ...(mode === 'extra-question' ? [{ ...question, id: 'second_question' }] : []),
                  {
                    id: 'event',
                    kind: 'event',
                    state: state >= 3 ? 'done' : 'open',
                    title: event.summary,
                    starts_at: event.start,
                    thread_id: 'thread',
                    assignee: { principal_id: 'member' },
                  },
                ],
        });
      if (path === '/rooms/room/board/question/answer') {
        expect(request.headers.get('cookie')).toBe('member-session');
        answers++;
        state = 2;
        return response({ request_job_id: 'job_answer' });
      }
      if (path === '/rooms/room/threads/thread')
        return response({
          requests: [
            {
              job_id: 'job_first',
              status: mode === 'bare-input' && state === 1 ? 'needs_you' : 'done',
              turns: [],
              receipts: [],
              permissions: [],
            },
            ...(state >= 2
              ? [
                  {
                    job_id: 'job_answer',
                    status: state >= 3 ? 'done' : 'needs_you',
                    turns: [],
                    receipts: state >= 3 ? [{ id: 'action' }] : [],
                    permissions: state >= 3 ? [] : [card],
                  },
                ]
              : []),
          ],
        });
      if (path === '/rooms/room/approvals/approval') {
        if (request.headers.get('cookie') !== 'member-session') {
          wrongApprovals++;
          return response({ error: 'refused' }, 403);
        }
        approvals++;
        state = 3;
        return response({ status: 'ok' });
      }
      if (path.endsWith('/stop')) {
        stops++;
        return response({ status: 'ok' });
      }
      if (path === '/calendar/action.ics')
        return new Response(
          [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:action',
            'X-MELETE-ACTION-ID:action',
            'X-MELETE-PAYLOAD-HASH:hash',
            `SUMMARY:${mode === 'wrong-summary' ? 'Different obligation' : event.summary}`,
            `DTSTART:${mode === 'wrong-date' ? '20270109T090000Z' : '20270110T090000Z'}`,
            'DTEND:20270110T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
            '',
          ].join('\r\n'),
        );
      return response({ error: 'unknown' }, 404);
    },
  });
  servers.push(server);
  const config: import('./smoke.ts').SmokeConfig = {
    version: 1,
    preprovisionedDisposable: true,
    targetId: 'target',
    revision: 'abc1234',
    campaignId: 'campaign',
    baseUrl: server.url.toString(),
    expectedModel: EXPECTED_MODEL,
    accounts: {
      requester: { sessionEnv: 'ROUTER_REQUESTER' },
      member: { sessionEnv: 'ROUTER_MEMBER' },
    },
    gate: {
      url: new URL('gate', server.url).toString(),
      tokenEnv: 'ROUTER_GATE',
      verificationFile,
    },
    evidence: { url: new URL('evidence', server.url).toString() },
    cases: [
      {
        roomId: 'room',
        requestedBy: 'requester',
        sourceMessage: { id: 'seed', subject: 'Practice pickup' },
        event,
        answer: 'Yes, I can handle the pickup.',
        candidates: [
          {
            principalId: 'requester',
            availability: 'busy',
            calendarUrl: new URL('busy/', server.url).toString(),
          },
          {
            principalId: 'member',
            availability: 'free',
            calendarUrl: new URL('calendar/', server.url).toString(),
          },
        ],
      },
    ],
    timeoutMs: 1000,
    requestTimeoutMs: 200,
    pollMs: 10,
    maxRequests: 100,
  };
  return {
    config,
    env: {
      ROUTER_REQUESTER: 'requester-session',
      ROUTER_MEMBER: 'member-session',
      ROUTER_GATE: 'gate-secret',
    },
    counts: () => ({ workflows, answers, approvals, wrongApprovals, stops }),
  };
}
const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test('HTTP probe follows the actual member and requires exact provider read-back and all usage', async () => {
  const { runSmoke } = await import('./smoke.ts');
  const f = await fixture();
  const report = await runSmoke(f.config, { budgetUsd: 0.2, limit: 1 }, f.env);
  expect(report.error).toBeUndefined();
  expect(report.status).toBe('passed');
  expect(report.cases[0]?.actualStartUtc).toBe('2027-01-10T09:00:00.000Z');
  expect(report.calls.map((c) => c.purpose)).toEqual(['agent', 'background']);
  expect(report.humanAutomationMs).toBeGreaterThanOrEqual(0);
  expect(report.observations.find((s) => s.stage === 'question_available')?.at).toBeNull();
  expect(f.counts()).toEqual({
    workflows: 1,
    answers: 1,
    approvals: 1,
    wrongApprovals: 1,
    stops: 0,
  });
  expect(JSON.stringify(report)).not.toContain('gate-secret');
  expect(JSON.stringify(report)).not.toContain('member-session');
});

test.each([
  'wrong-date',
  'wrong-summary',
  'extra-question',
  'wrong-model',
  'unverified',
  'duplicate-write',
  'missing-readback',
  'bare-input',
] as const)('%s evidence stops without corrective nudges', async (mode) => {
  const { runSmoke } = await import('./smoke.ts');
  const f = await fixture(mode);
  const report = await runSmoke(f.config, { budgetUsd: 0.2, limit: 1 }, f.env);
  expect(report.status).toBe('stopped');
  expect(report.cases).toEqual([]);
  if (mode === 'wrong-model') expect(report.calls[0]?.modelActual).toBe('local/other');
  expect(f.counts().workflows).toBe(mode === 'unverified' ? 0 : 1);
  if (mode === 'extra-question') {
    expect(f.counts().answers).toBe(0);
    expect(f.counts().stops).toBe(1);
  }
});

test('response bodies are bounded by the request timeout and size cap', async () => {
  const { runSmoke } = await import('./smoke.ts');
  const f = await fixture();
  for (const large of [true, false]) {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(
          large
            ? new Uint8Array(4 * 1024 * 1024 + 1)
            : new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{'));
                },
              }),
        ),
    });
    servers.push(server);
    const before = performance.now();
    const report = await runSmoke(
      { ...f.config, gate: { ...f.config.gate, url: server.url.toString() } },
      { budgetUsd: 0.2, limit: 1 },
      f.env,
    );
    expect(report.status).toBe('stopped');
    expect(report.httpRequests).toBe(1);
    expect(performance.now() - before).toBeLessThan(1000);
    expect(f.counts().workflows).toBe(0);
  }
});

test('missing secrets, insufficient cap and invalid workflow limits cannot start paid work', async () => {
  const { runSmoke } = await import('./smoke.ts');
  const f = await fixture();
  await expect(runSmoke(f.config, { budgetUsd: 0.2, limit: 1 }, {})).rejects.toThrow(
    'Missing local reference',
  );
  await expect(runSmoke(f.config, { budgetUsd: 0.2, limit: 3 }, f.env)).rejects.toThrow('Limit');
  const report = await runSmoke(f.config, { budgetUsd: 0.1, limit: 1 }, f.env);
  expect(report.status).toBe('stopped');
  expect(f.counts().workflows).toBe(0);
});

test('the HTTP count bound stops rather than polling indefinitely', async () => {
  const { runSmoke } = await import('./smoke.ts');
  const f = await fixture();
  const report = await runSmoke(
    { ...f.config, maxRequests: 5 },
    { budgetUsd: 0.2, limit: 1 },
    f.env,
  );
  expect(report.status).toBe('stopped');
  expect(report.error).toContain('bound');
  expect(f.counts().workflows).toBe(0);
});
