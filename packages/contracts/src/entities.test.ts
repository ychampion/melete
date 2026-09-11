import { describe, expect, test } from 'bun:test';
import { canonicalizePayload } from './broker.ts';
import { ID_PREFIXES, isErr, isOk, ok, unwrap } from './common.ts';
import {
  action,
  approval,
  attempt,
  budgetLedger,
  connection,
  connectionView,
  event,
  job,
  knowledgeRecordRow,
  owner,
  skillRow,
  space,
  TABLES,
  trigger,
} from './entities.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const id = (prefix: string) => `${prefix}_${SUFFIX}`;
const NOW = '2026-09-11T00:00:00.000Z';
const HASH = canonicalizePayload({ to: 'a@example.com' }).hash;

describe('the schema covers every table in the specification', () => {
  test('tables are named exactly once', () => {
    expect(new Set(TABLES).size).toBe(TABLES.length);
    expect(TABLES).toContain('knowledge_record');
    expect(TABLES).toContain('budget_ledger');
  });
});

describe('owner and space', () => {
  test('an owner row parses', () => {
    expect(
      owner.safeParse({
        id: id(ID_PREFIXES.owner),
        email: 'owner@example.com',
        password_hash: null,
        passkey: null,
        created_at: NOW,
      }).success,
    ).toBe(true);
  });

  test('a space carries the reserved audience field', () => {
    const parsed = space.parse({
      id: id(ID_PREFIXES.space),
      name: 'personal',
      kind: 'personal',
      audience: 'owner',
      git_path: '/data/spaces/personal',
      created_at: NOW,
    });
    expect(parsed.audience).toBe('owner');
  });
});

describe('connection', () => {
  const row = {
    id: id(ID_PREFIXES.connection),
    space_id: id(ID_PREFIXES.space),
    provider: 'smtp' as const,
    label: 'Personal mail',
    secret_ref: id(ID_PREFIXES.secret),
    scopes: ['email.send'],
    status: 'active' as const,
    health: 'ok' as const,
    last_checked_at: NOW,
    created_at: NOW,
  };

  test('the stored row carries a secret reference', () => {
    expect(connection.parse(row).secret_ref).toBe(id(ID_PREFIXES.secret));
  });

  test('the view the API returns has no way to carry one', () => {
    const view = connectionView.parse(row);
    expect('secret_ref' in view).toBe(false);
  });
});

describe('job', () => {
  const row = {
    id: id(ID_PREFIXES.job),
    space_id: id(ID_PREFIXES.space),
    title: 'Chase the lease renewal',
    objective: 'Get a signed renewal before the end of the month.',
    constraints: {
      deliverable: { kind: 'message_sent', connection_id: id(ID_PREFIXES.connection) },
      allowed_domains: [],
      public_compartment: false,
    },
    state: 'queued',
    revision: 0,
    lease_epoch: 0,
    next_wake_at: null,
    wait: { kind: 'none' },
    budget: {
      max_turns: 12,
      max_output_tokens: 8000,
      max_wall_ms: 300000,
      max_actions: 5,
      max_attempts: 3,
      max_usd_est: 1,
    },
    created_by: 'owner',
    created_at: NOW,
    updated_at: NOW,
    state_version: 0,
  };

  test('parses with a declared deliverable', () => {
    const parsed = job.parse(row);
    expect(parsed.constraints.deliverable.kind).toBe('message_sent');
  });

  test('refuses a state that is not in the machine', () => {
    expect(job.safeParse({ ...row, state: 'thinking' }).success).toBe(false);
  });

  test('refuses a budget with no ceiling on wall time', () => {
    expect(job.safeParse({ ...row, budget: { ...row.budget, max_wall_ms: 0 } }).success).toBe(
      false,
    );
  });
});

describe('attempt, action, approval', () => {
  test('an attempt records what the provider actually served', () => {
    const parsed = attempt.parse({
      id: id(ID_PREFIXES.attempt),
      job_id: id(ID_PREFIXES.job),
      epoch: 1,
      runtime_version: 'hermes@v2026.9.7',
      provider: 'fireworks',
      model: 'deepseek-v4p1-flash',
      model_actual: 'deepseek-v4p1-flash-0903',
      usage: {},
      started_at: NOW,
      ended_at: null,
      outcome: null,
      outcome_detail: null,
      context_snapshot_ref: null,
    });
    expect(parsed.model_actual).toBe('deepseek-v4p1-flash-0903');
    expect(parsed.usage.output_tokens).toBe(0);
  });

  test('an action carries the hash its approval will bind to', () => {
    const parsed = action.parse({
      id: id(ID_PREFIXES.action),
      job_id: id(ID_PREFIXES.job),
      attempt_id: id(ID_PREFIXES.attempt),
      connection_id: id(ID_PREFIXES.connection),
      kind: 'email.send',
      effect_class: 'write_external',
      canonical_payload: { to: 'a@example.com' },
      payload_hash: HASH,
      status: 'proposed',
      authorization_ref: null,
      budget_reservation: null,
      idempotency_key: id(ID_PREFIXES.action),
      dispatched_at: null,
      receipt: null,
      resolved_at: null,
      reconciliation: null,
      created_at: NOW,
    });
    expect(parsed.idempotency_key).toBe(parsed.id);
  });

  test('an approval pins both the payload hash and the job revision', () => {
    const parsed = approval.parse({
      id: id(ID_PREFIXES.approval),
      action_id: id(ID_PREFIXES.action),
      job_revision: 3,
      payload_hash: HASH,
      requested_at: NOW,
      decided_at: null,
      decision: null,
      decided_by: null,
      expires_at: null,
    });
    expect(parsed.job_revision).toBe(3);
  });

  test('an approval with a truncated hash is refused', () => {
    expect(
      approval.safeParse({
        id: id(ID_PREFIXES.approval),
        action_id: id(ID_PREFIXES.action),
        job_revision: 0,
        payload_hash: 'abc',
        requested_at: NOW,
        decided_at: null,
        decision: null,
        decided_by: null,
        expires_at: null,
      }).success,
    ).toBe(false);
  });
});

describe('event, trigger, ledger, knowledge, skill', () => {
  test('an event carries the dedup key that makes replay idempotent', () => {
    const parsed = event.parse({
      seq: 42,
      job_id: id(ID_PREFIXES.job),
      attempt_id: id(ID_PREFIXES.attempt),
      type: 'tool_result',
      payload: {},
      dedup_key: `${id(ID_PREFIXES.attempt)}:7`,
      created_at: NOW,
    });
    expect(parsed.dedup_key).toContain(':7');
  });

  test('a schedule trigger needs a timezone, because "every morning" is local', () => {
    expect(
      trigger.safeParse({
        id: id(ID_PREFIXES.trigger),
        job_id: id(ID_PREFIXES.job),
        kind: 'schedule',
        spec: { kind: 'schedule', cron: '0 8 * * *' },
        cursor: null,
        enabled: true,
        created_at: NOW,
      }).success,
    ).toBe(false);
  });

  test('a ledger row can be reserved and not yet settled', () => {
    const parsed = budgetLedger.parse({
      id: id(ID_PREFIXES.ledger),
      job_id: id(ID_PREFIXES.job),
      attempt_id: id(ID_PREFIXES.attempt),
      action_id: null,
      kind: 'tokens',
      reserved: 8000,
      settled: null,
      at: NOW,
    });
    expect(parsed.settled).toBeNull();
  });

  test('a knowledge row is a catalog entry, not the record itself', () => {
    const parsed = knowledgeRecordRow.parse({
      id: id(ID_PREFIXES.knowledge),
      space_id: id(ID_PREFIXES.space),
      path: 'knowledge/prefers-bun.md',
      frontmatter: {},
      content_hash: 'deadbeef',
      status: 'active',
      updated_at: NOW,
    });
    expect(parsed.path).toBe('knowledge/prefers-bun.md');
  });

  test('a built-in skill has no space', () => {
    const parsed = skillRow.parse({
      id: id(ID_PREFIXES.skill),
      space_id: null,
      name: 'draft-follow-up',
      path: 'skills/draft-follow-up.md',
      frontmatter: {},
      enabled: true,
    });
    expect(parsed.space_id).toBeNull();
  });
});

describe('Result helpers', () => {
  test('narrow correctly', () => {
    const good = ok(1);
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(unwrap(good)).toBe(1);
  });
});
