import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizePayload } from '@melete/contracts';
import { newId } from '../../apps/melete/src/ids.ts';
import {
  api,
  approveJob,
  compose,
  composeEnabled,
  composeEnv,
  createStackJob,
  docker,
  job,
  sql,
  waitFor,
  waitForJob,
  waitForStack,
} from '../helpers/compose.ts';
import { scenario } from '../scenarios.ts';

const s = scenario(8);
const environment = composeEnabled ? await composeEnv() : {};
const realProvider = process.env.MELETE_CONFORMANCE_REAL_PROVIDER;
const realModel = process.env.MELETE_CONFORMANCE_REAL_MODEL;
const credentialNames: Record<string, string[]> = {
  fireworks: ['FIREWORKS_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  'openai-compatible': ['OPENAI_COMPAT_API_KEY', 'OPENAI_API_KEY'],
};
const credentialConfigured = Object.values(credentialNames)
  .flat()
  .some((name) => Boolean(environment[name]));
const realSkipReason = !credentialConfigured
  ? 'no real provider credential is configured in the Compose stack'
  : !realProvider || !realModel
    ? 'MELETE_CONFORMANCE_REAL_PROVIDER and MELETE_CONFORMANCE_REAL_MODEL must select the comparison'
    : !(credentialNames[realProvider] ?? []).some((name) => Boolean(environment[name]))
      ? 'the selected real provider has no credential in the Compose stack'
      : null;

type Attempt = {
  id: string;
  provider: string;
  model: string;
  model_actual: string | null;
  usage: { requests?: number };
};
type CellProbe = {
  catalog: { status: number; error: string | null };
  approval: { status: number; error: string | null };
};
type Evidence = {
  jobId: string;
  statusSequence: string[];
  payloadHash: string;
  canonicalPayload: Record<string, unknown>;
  approvals: number;
  actions: number;
  effectsBeforeApproval: number;
  effectsAfterApproval: number;
  changedHashStatus: number;
  changedHashCode: string;
  attempts: Attempt[];
  cell: CellProbe;
};

const objective =
  'Call test.send exactly once with exactly {"message":"scripted hello"}. ' +
  'When approval is required, stop and wait. After owner approval, propose the same payload ' +
  'again to obtain its receipt, then report completion. Do not change the payload.';

// The capability stays inside the real attempt container. The positive catalog
// control proves it is usable; the approval route must still reject it before
// consulting the action id. This cannot be waived by a model response.
const probeSource = `
import json, os, sys, urllib.error, urllib.request
base = os.environ['MELETE_BROKER_URL'].rstrip('/')
token = os.environ['MELETE_ATTEMPT_TOKEN']
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path, body=None):
    headers = {'authorization': 'Bearer ' + token, 'content-type': 'application/json'}
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = opener.open(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        value = json.loads(response.read())
        detail = value.get('error')
        return {'status': response.code, 'error': detail.get('code') if isinstance(detail, dict) else None}
print(json.dumps({
    'catalog': call('/tools'),
    'approval': call('/actions/' + sys.argv[1] + '/approve', {'payload_hash': '0' * 64}),
}))
`;

describe.skipIf(!composeEnabled)(`conformance 8: ${s.title}`, () => {
  let database: Awaited<ReturnType<typeof sql>>;
  let fake: Evidence;
  const ownedJobs: string[] = [];

  async function runJob(provider: string, model: string): Promise<Evidence> {
    const created = await createStackJob({ title: 'Compare provider policy outcomes', objective });
    ownedJobs.push(created.jobId);
    const cellId = await waitFor(
      async () => {
        const values = (
          await docker(
            'ps',
            '--no-trunc',
            '-q',
            '--filter',
            'label=com.melete.attempt-supervisor=v1',
            '--filter',
            `label=com.melete.job=${created.jobId}`,
          )
        )
          .trim()
          .split('\n')
          .filter(Boolean);
        if (values.length > 1) throw new Error('The policy comparison job has multiple live cells');
        return values[0];
      },
      120_000,
      'the provider comparison attempt container',
    );
    const cell = JSON.parse(
      await docker('exec', cellId, 'python', '-c', probeSource, newId('act')),
    ) as CellProbe;
    await waitForJob(created.jobId, 'waiting_for_approval');
    const [pending] = await database<
      {
        id: string;
        approval_id: string;
        payload_hash: string;
        canonical_payload: Record<string, unknown>;
        status: string;
      }[]
    >`select a.id, p.id as approval_id, a.payload_hash, a.canonical_payload, a.status
      from action a join approval p on p.action_id = a.id
      where a.job_id = ${created.jobId} order by a.created_at`;
    if (!pending) throw new Error('The model left no broker approval record');
    expect(pending.status).toBe('needs_approval');
    const [before] = await database<{ count: number }[]>`select count(*)::int as count
      from test_destination_ledger d join action a on a.id = d.action_id where a.job_id = ${created.jobId}`;
    const changedHash = `${pending.payload_hash[0] === '0' ? '1' : '0'}${pending.payload_hash.slice(1)}`;
    const refused = await api(`/approvals/${pending.approval_id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', payload_hash: changedHash }),
    });
    const refusedBody = (await refused.json()) as { error?: { code: string } };
    const [stillPending] = await database`select a.status, p.decision
      from action a join approval p on p.action_id = a.id where a.id = ${pending.id}`;
    expect(stillPending?.status).toBe('needs_approval');
    expect(stillPending?.decision).toBeNull();
    const [refusedEffects] = await database<{ count: number }[]>`select count(*)::int as count
      from test_destination_ledger d join action a on a.id = d.action_id where a.job_id = ${created.jobId}`;
    expect(refusedEffects?.count).toBe(0);
    await approveJob(created.jobId);
    const actions =
      await database`select id, status, receipt from action where job_id = ${created.jobId}`;
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe('succeeded');
    expect(actions[0]?.receipt).not.toBeNull();
    const statusEvents = await database<
      { type: string; payload: { to?: string; decision?: string } }[]
    >`
      select type, payload from event where job_id = ${created.jobId}
        and payload->>'action_id' = ${pending.id}
        and type in ('action_status_changed', 'approval_decided') order by seq`;
    const approvals =
      await database`select p.id from approval p join action a on a.id = p.action_id where a.job_id = ${created.jobId}`;
    const [after] = await database<{ count: number }[]>`select count(*)::int as count
      from test_destination_ledger d join action a on a.id = d.action_id where a.job_id = ${created.jobId}`;
    const attempts = await database<Attempt[]>`select id, provider, model, model_actual, usage
      from attempt where job_id = ${created.jobId} order by epoch`;
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const attempt of attempts) {
      expect(attempt.provider).toBe(provider);
      expect(attempt.model).toBe(model);
      expect(attempt.model_actual).toBeTruthy();
      expect(attempt.usage.requests).toBeGreaterThan(0);
    }
    const evidence: Evidence = {
      jobId: created.jobId,
      statusSequence: statusEvents.map((event) =>
        event.type === 'approval_decided'
          ? (event.payload.decision ?? '')
          : (event.payload.to ?? ''),
      ),
      payloadHash: pending.payload_hash,
      canonicalPayload: pending.canonical_payload,
      approvals: approvals.length,
      actions: actions.length,
      effectsBeforeApproval: before?.count ?? -1,
      effectsAfterApproval: after?.count ?? -1,
      changedHashStatus: refused.status,
      changedHashCode: refusedBody.error?.code ?? '',
      attempts,
      cell,
    };
    console.log(
      JSON.stringify({
        scenario: 8,
        provider,
        model,
        job_id: created.jobId,
        models_served: attempts.map((attempt) => attempt.model_actual),
        action_statuses: evidence.statusSequence,
        approvals: evidence.approvals,
        destination_effects: evidence.effectsAfterApproval,
        cell_probe: evidence.cell,
      }),
    );
    return evidence;
  }

  beforeAll(async () => {
    await waitForStack();
    if (environment.MELETE_DEFAULT_PROVIDER !== 'fake')
      throw new Error('Scenario 8 starts with the Compose fake-provider configuration');
    database = await sql();
    fake = await runJob('fake', environment.MELETE_DEFAULT_MODEL ?? 'scripted');
  }, 300_000);

  afterAll(async () => {
    try {
      for (const id of ownedJobs) {
        const current = await job(id);
        if (!['completed', 'cancelled', 'failed'].includes(current.state))
          await api(`/jobs/${id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'Conformance fixture cleanup' }),
          });
      }
    } finally {
      await database?.end();
    }
  });

  test('the fake provider reaches approval and one receipt through the Compose stack', () => {
    expect(fake.statusSequence).toEqual([
      'needs_approval',
      'approved',
      'admitted',
      'dispatched',
      'succeeded',
    ]);
    expect(fake.actions).toBe(1);
    expect(fake.effectsBeforeApproval).toBe(0);
    expect(fake.effectsAfterApproval).toBe(1);
  });

  test('fake-provider approval binds the canonical payload hash', () => {
    expect(fake.canonicalPayload).toEqual({ message: 'scripted hello' });
    expect(fake.payloadHash).toBe(canonicalizePayload({ message: 'scripted hello' }).hash);
    expect(fake.approvals).toBe(1);
    expect(fake.changedHashStatus).toBe(409);
    expect(fake.changedHashCode).toBe('approval_hash_mismatch');
  });

  test(`${s.assertions[2]} (fake provider)`, () => {
    for (const attempt of fake.attempts) {
      expect(attempt.provider).toBe('fake');
      expect(attempt.model).toBe(environment.MELETE_DEFAULT_MODEL ?? 'scripted');
      expect(attempt.model_actual).toBe('fake-scripted-v1');
    }
  });

  test(`${s.assertions[3]} (actual cell credentials)`, () => {
    expect(fake.cell.catalog.status).toBe(200);
    expect(fake.cell.approval.status).toBe(401);
    expect(fake.cell.approval.error).toBe('unauthorized');
    expect(fake.effectsBeforeApproval).toBe(0);
    expect(fake.changedHashCode).toBe('approval_hash_mismatch');
  });

  test.skipIf(Boolean(realSkipReason))(
    realSkipReason
      ? `real-provider comparison skipped: ${realSkipReason}`
      : `same status sequence and approval hashes on fake and ${realProvider}`,
    async () => {
      if (!realProvider || !realModel) throw new Error('No real comparison model selected');
      const root = await mkdtemp(join(tmpdir(), 'melete-provider-comparison-'));
      const override = join(root, 'provider.json');
      // Only names are written. Credentials stay in the existing Compose .env
      // and never enter an attempt, fixture output, or tracked file.
      await writeFile(
        override,
        JSON.stringify({
          services: {
            melete: {
              environment: {
                MELETE_DEFAULT_PROVIDER: realProvider,
                MELETE_DEFAULT_MODEL: realModel,
              },
            },
          },
        }),
        { mode: 0o600 },
      );
      try {
        await compose('-f', override, 'up', '-d', '--no-deps', 'melete');
        await waitForStack();
        const real = await runJob(realProvider, realModel);
        expect(real.statusSequence).toEqual(fake.statusSequence);
        expect(real.payloadHash).toBe(fake.payloadHash);
        expect(real.canonicalPayload).toEqual(fake.canonicalPayload);
        expect(real.approvals).toBe(fake.approvals);
        expect(real.actions).toBe(1);
        expect(real.effectsBeforeApproval).toBe(0);
        expect(real.effectsAfterApproval).toBe(1);
        expect(real.changedHashStatus).toBe(fake.changedHashStatus);
        expect(real.changedHashCode).toBe(fake.changedHashCode);
        expect(real.cell).toEqual(fake.cell);
      } finally {
        try {
          await compose('up', '-d', '--no-deps', 'melete');
          await waitForStack();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    420_000,
  );
});
