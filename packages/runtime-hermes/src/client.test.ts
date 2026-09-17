import { describe, expect, test } from 'bun:test';
import { type AttemptBundle, CONTEXT_LIMITS, EMPTY_SINCE_LAST } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import {
  HERMES_APPROVAL_ANSWERS,
  HERMES_ROUTES,
  HermesClient,
  hermesApprovalRequest,
  hermesRunStatus,
  IDENTITY,
  parseSse,
} from './client.ts';
import { HERMES_PINNED_TAG, RUNTIME_VERSION } from './index.ts';
import {
  instructionTokens,
  measureRenderedInput,
  renderInput,
  renderInstructions,
} from './instructions.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const bundle: AttemptBundle = {
  attempt: {
    id: `att_${SUFFIX}`,
    job_id: `job_${SUFFIX}`,
    epoch: 3,
    revision: 1,
    token: 'capability.jwt.here',
  },
  job: {
    title: 'Chase the lease renewal',
    objective: 'Get a signed renewal before the end of the month.',
    constraints: {},
    progress_summary: 'One message sent on Tuesday.',
    unresolved_questions: [],
    deliverable: { kind: 'message_sent' },
  },
  inputs: {
    new_user_messages: [{ role: 'user', content: 'any news?', at: '2026-09-11T00:00:00.000Z' }],
    approval_results: [{ action_id: `act_${SUFFIX}`, decision: 'denied', note: null }],
    trigger_events: [],
    repair_briefs: [],
  },
  since_last: EMPTY_SINCE_LAST,
  transcript: [],
  tools: [],
  skills: [{ name: 'draft-follow-up', body: 'Four sentences. Ask for a date.' }],
  knowledge: [
    {
      path: 'knowledge/landlord-contact.md',
      excerpt: 'The landlord answers email but never the phone.',
      key: null,
      origin_trust: 'owner',
      disputed: false,
      provenance: {
        id: `k_${SUFFIX}`,
        asserted_by: 'user',
        observed_at: '2026-09-10',
        status: 'active',
      },
    },
  ],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 120000, max_actions: 3 },
  model: { provider: 'fireworks', model: 'deepseek-v4p1-flash', fallback: null },
};

const client = new HermesClient({ baseUrl: 'http://runtime:8790/', token: 'surrogate' });

describe('request building', () => {
  test('start posts to /v1/runs with the surrogate token', () => {
    const req = client.startRun(bundle);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`http://runtime:8790${HERMES_ROUTES.runs}`);
    expect(req.headers.authorization).toBe('Bearer surrogate');
    expect(req.headers['content-type']).toBe('application/json');
  });

  test('the run body carries only fields the engine reads', () => {
    const body = JSON.parse(client.startRun(bundle).body ?? '{}');
    // POST /v1/runs has no toolset, memory or context-file fields: _create_agent
    // reads those from config.yaml. Sending them would be decoration.
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'session_id']);
    expect(body.model).toBe('deepseek-v4p1-flash');
  });

  test('the attempt id is the idempotency key and the job id is the session', () => {
    const req = client.startRun(bundle);
    expect(req.headers['Idempotency-Key']).toBe(`att_${SUFFIX}`);
    expect(req.headers['X-Hermes-Session-Key']).toBe(`job_${SUFFIX}`);
    expect(JSON.parse(req.body ?? '{}').session_id).toBe(`job_${SUFFIX}`);
  });

  test('capabilities is a plain read', () => {
    expect(client.capabilities().url).toBe('http://runtime:8790/v1/capabilities');
    expect(client.capabilities().method).toBe('GET');
  });

  test('status and stop address the run by id', () => {
    expect(client.status('run_1').url).toBe('http://runtime:8790/v1/runs/run_1');
    expect(client.stop('run_1').url).toBe('http://runtime:8790/v1/runs/run_1/stop');
    expect(client.stop('run_1').method).toBe('POST');
  });

  test('the event request asks for a stream and does not try to resume one', () => {
    const req = client.events('run_1');
    expect(req.headers.accept).toBe('text/event-stream');
    // The engine's queue has no replay, so a Last-Event-ID would be a lie about
    // what a reconnect could recover.
    expect(req.headers['last-event-id']).toBeUndefined();
  });

  test('an approval answers a request id with once or deny and nothing else', () => {
    const req = client.approve('run_1', 'req_9', 'once');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ request_id: 'req_9', choice: 'once' });
    expect(HERMES_APPROVAL_ANSWERS).toEqual(['once', 'deny']);
    expect(HERMES_APPROVAL_ANSWERS).not.toContain('always');
  });

  test('no token means no authorization header, rather than an empty one', () => {
    const anonymous = new HermesClient({ baseUrl: 'http://runtime:8790' });
    expect(anonymous.status('run_1').headers.authorization).toBeUndefined();
  });
});

describe('context assembly', () => {
  test('the scaffolding tripwire measures instructions, rendered input and tools', () => {
    const representative = structuredClone(bundle);
    representative.job.constraints = { deadline: 'Friday', tone: 'plain' };
    representative.transcript = [
      { role: 'user', content: 'Prior conversation. '.repeat(2000), at: '2026-09-11T00:00:00Z' },
    ];
    const knowledge = representative.knowledge[0];
    if (!knowledge) throw new Error('Missing representative knowledge');
    knowledge.excerpt = 'Knowledge body. '.repeat(2000);
    representative.skills = ['draft', 'verify', 'follow-up'].map((name) => ({
      name,
      body: 'Read the record and check the receipt before making a claim. '.repeat(10),
    }));
    // A catalog at its whole allowance: the schema budget and the names-only index.
    const allowance = CONTEXT_LIMITS.core_catalog_tokens + CONTEXT_LIMITS.catalog_index_tokens;
    representative.tools = [];
    for (let index = 0; estimateTokens(JSON.stringify(representative.tools)) < allowance; index++)
      representative.tools.push({
        name: `email.send_${index}`,
        description: 'Send an email after approval.',
        effect_class: 'write_external',
        connection_id: null,
        input_schema: { type: 'object', properties: { body: { type: 'string' } } },
      });
    expect(estimateTokens(JSON.stringify(representative.tools))).toBeGreaterThanOrEqual(allowance);
    representative.since_last = {
      attempt_id: `att_${SUFFIX}`,
      ended_at: '2026-09-11T00:00:00Z',
      evidence: [
        {
          kind: 'source',
          handle: 'source:claim_1@1',
          label: 'contacts observation',
          at: '2026-09-11T00:00:00Z',
        },
      ],
      actions: [
        {
          action_id: `act_${SUFFIX}`,
          kind: 'email.send',
          status: 'succeeded',
          receipt_ref: 'receipt_1',
          at: '2026-09-11T00:00:00Z',
        },
      ],
      pending_questions: [{ id: 'q1', text: 'Which deadline?', state: 'asked' }],
      pending_approvals: [],
      repair_briefs: [],
    };
    representative.inputs.repair_briefs = [
      {
        id: 'repair_1',
        job_id: bundle.attempt.job_id,
        key: null,
        changed_handle: 'claim_1@1',
        replacement_handle: 'claim_1@2',
        old_value: 'Tuesday',
        new_value: 'Friday',
        affected: [
          { kind: 'plan_step', output_id: 'renewal', output_version: '1', location: 'deadline' },
        ],
        created_at: '2026-09-11T00:00:00Z',
      },
    ];
    const rendered = [
      renderInstructions(representative),
      renderInput(representative),
      JSON.stringify(representative.tools),
    ].join('\n\n');
    expect(instructionTokens(representative)).toBe(estimateTokens(rendered));
    const bodies =
      JSON.stringify(representative.transcript).length +
      representative.knowledge.reduce((sum, entry) => sum + entry.excerpt.length, 0);
    expect(Math.ceil((rendered.length - bodies) / 4)).toBeLessThan(4000);
    expect(measureRenderedInput(representative).scaffolding).toBe(
      Math.ceil((rendered.length - bodies) / 4),
    );
    representative.job.constraints = { bloated: 'x'.repeat(16000) };
    expect(measureRenderedInput(representative).scaffolding).toBeGreaterThan(4000);
  });
  test('an approved decision names the tool, the approved payload and how to carry it out', () => {
    const resumed = structuredClone(bundle);
    resumed.inputs.approval_results = [
      {
        action_id: `act_${SUFFIX}`,
        decision: 'approved',
        note: 'go ahead',
        kind: 'email.send',
        status: 'approved',
        payload: { to: 'alex@example.test', body: 'I can attend Friday.' },
      },
    ];
    const text = renderInput(resumed);
    expect(text).toContain(`act_${SUFFIX} (email.send) was approved and has not been carried out.`);
    expect(text).toContain(`Call resume_action with action_id "act_${SUFFIX}"`);
    expect(text).toContain('{"to":"alex@example.test","body":"I can attend Friday."}');
    expect(text).toContain('The owner said: go ahead');
    // Once it has left, or when it was refused, there is nothing to resume.
    const [decision] = resumed.inputs.approval_results;
    if (!decision) throw new Error('fixture decision absent');
    decision.status = 'succeeded';
    expect(renderInput(resumed)).not.toContain('resume_action');
    expect(renderInput(resumed)).toContain('was approved; it is now succeeded.');
    decision.status = 'denied';
    decision.decision = 'denied';
    expect(renderInput(resumed)).toContain('(email.send) was denied. It was not carried out');
    expect(renderInput(resumed)).not.toContain('resume_action');
    // A very large payload is abbreviated, never silently dropped.
    decision.status = 'approved';
    decision.decision = 'approved';
    decision.payload = { body: 'x'.repeat(9000) };
    expect(renderInput(resumed)).toContain(
      '[payload abbreviated; the stored bytes are sent whole]',
    );
    expect(renderInput(resumed).length).toBeLessThan(4000);
  });

  test("the job's registered triggers are named with id, event and a plain description", () => {
    const waiting = structuredClone(bundle);
    expect(renderInput(waiting)).not.toContain('## Events this job can wait for');
    waiting.job.triggers = [
      {
        id: `trg_${SUFFIX}`,
        kind: 'event',
        event_name: 'mail.new',
        description: `fires on each mail.new event from conn_${SUFFIX}`,
      },
    ];
    const text = renderInput(waiting);
    expect(text).toContain('## Events this job can wait for');
    expect(text).toContain(
      `- trg_${SUFFIX}: mail.new, fires on each mail.new event from conn_${SUFFIX}`,
    );
    expect(text).toContain('job.wait takes the trigger id or the event name');
  });

  test('the identity is short enough to be a prefix, not a personality', () => {
    // A rough four-characters-per-token estimate; the contract caps it at 250.
    expect(Math.ceil(IDENTITY.length / 4)).toBeLessThan(CONTEXT_LIMITS.identity_tokens);
  });

  test('the identity tells the model that a claim without a receipt is not allowed', () => {
    expect(IDENTITY).toContain('receipt');
  });

  test('the instructions are identity, then skills, then knowledge', () => {
    const system = client.renderSystem(bundle);
    expect(system.indexOf(IDENTITY)).toBe(0);
    expect(system.indexOf('draft-follow-up')).toBeLessThan(system.indexOf('already knows'));
  });

  test('every knowledge excerpt carries where it came from', () => {
    const system = client.renderSystem(bundle);
    expect(system).toContain('knowledge/landlord-contact.md (user, 2026-09-10, active)');
  });

  test('the model is told that a parked action has not happened', () => {
    expect(client.renderSystem(bundle)).toContain('has NOT happened');
  });

  test('the input carries what changed since the last attempt', () => {
    const input = client.renderInput(bundle);
    expect(input).toContain('any news?');
    expect(input).toContain('was denied');
    expect(input).toContain('One message sent on Tuesday.');
  });
});

describe('response schemas', () => {
  test('a run status parses', () => {
    expect(hermesRunStatus.parse({ run_id: 'r1', status: 'running' }).status).toBe('running');
  });

  test('an unknown status falls back to running rather than losing the run', () => {
    // A status this build does not know about still names a live run; refusing
    // the parse would drop the run id with it.
    expect(hermesRunStatus.parse({ run_id: 'r1', status: 'thinking' }).status).toBe('running');
  });

  test('interrupted and cancelled are statuses, not surprises', () => {
    for (const status of ['interrupted', 'cancelled', 'waiting_for_approval'] as const) {
      expect(hermesRunStatus.parse({ run_id: 'r1', status }).status).toBe(status);
    }
  });

  test('an approval notification carries the fields the probe recorded', () => {
    const parsed = hermesApprovalRequest.parse({
      request_id: '4ea455eb1c1745bb8761c66d81237bad',
      command: 'rm -rf ~/Documents',
      description: 'recursive delete',
      pattern_key: 'rm -rf',
      pattern_keys: ['rm -rf'],
      allow_session: true,
      allow_permanent: true,
    });
    expect(parsed.request_id).toHaveLength(32);
  });

  test('a notification with no request id is refused, because nothing could answer it', () => {
    expect(hermesApprovalRequest.safeParse({ command: 'ls' }).success).toBe(false);
  });
});

describe('SSE parsing', () => {
  test('splits complete messages and keeps the remainder', () => {
    const { messages, rest } = parseSse(
      'id: 1\nevent: turn_started\ndata: {"turn":0}\n\nid: 2\nevent: text_delta\ndata: partial',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: '1', event: 'turn_started', data: '{"turn":0}' });
    expect(rest).toContain('data: partial');
  });

  test('joins multi-line data the way the specification says', () => {
    const { messages } = parseSse('data: one\ndata: two\n\n');
    expect(messages[0]?.data).toBe('one\ntwo');
  });

  test('ignores keepalive comments', () => {
    const { messages } = parseSse(': keepalive\n\ndata: real\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('real');
  });

  test('handles carriage returns from a proxy that rewrote the stream', () => {
    const { messages } = parseSse('id: 5\r\ndata: x\r\n\r\n');
    expect(messages[0]?.id).toBe('5');
  });
});

describe('the pin', () => {
  test('names the exact release the image is built from', () => {
    expect(HERMES_PINNED_TAG).toBe('v2026.9.7');
    expect(RUNTIME_VERSION).toBe('hermes@v2026.9.7+melete-observers.2');
  });
});
