import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EffectProposalResponse } from '@melete/contracts';
import { signCapability } from '../../src/broker/capability.ts';
import { startEffectBoundary } from '../../src/broker/start.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { scriptFromWav } from '../../src/connectors/wav.ts';
import { loadEnv } from '../../src/env.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => fixture?.close(), 60_000);

async function removeFixture(root: string) {
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}

databaseTest(
  'production speech admission binds approval, origin, intent, trusted spend and receipt',
  async () => {
    if (!fixture) return;
    const { sql } = fixture;
    const seed = await seedJob(sql, { provider: 'generation', scopes: ['audio.synthesize'] });
    const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-speech-broker-'));
    const env = loadEnv({
      DATABASE_URL: fixture.url,
      MELETE_CAPABILITY_KEY: 'c'.repeat(32),
      MELETE_APPROVAL_KEY: 'a'.repeat(32),
      MELETE_BROKER_BIND: '127.0.0.1:3192',
      MELETE_WORK_DIR: root,
      MELETE_SPACES_DIR: root,
      MELETE_ENABLE_FAKE_PROVIDER: 'true',
    });
    const boundary = await startEffectBoundary(fixture, env, {
      resolveTrust: createTableTrustResolver({
        'episode.wav': { origin_trust: 'external_content' },
      }),
    });
    try {
      // The fixture changes trusted operator pricing, never a runtime payload.
      const connector = boundary.registry.get(seed.connectionId);
      if (!connector?.capability) throw new Error('Missing configured speech connector');
      connector.capability.unit_cost_usd = 0.037;
      const token = signCapability(seed.claims, env.MELETE_CAPABILITY_KEY ?? '');
      const request = {
        connection_id: seed.connectionId,
        kind: 'audio.synthesize',
        payload: { script: 'A short episode with a durable receipt.', path: 'episode.wav' },
      };
      const post = async (path: string, body: unknown, credential = token) =>
        fetch(`http://127.0.0.1:3192${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const response = await post('/actions', request);
      expect(response.status).toBe(201);
      const proposed = (await response.json()) as EffectProposalResponse;
      expect(proposed.status).toBe('needs_approval');
      expect(proposed.origin_warnings).toMatchObject([
        { field: 'path', origin_trust: 'external_content' },
      ]);
      expect(
        await rejectionOf(
          boundary.broker.admit(seed.claims, proposed.action_id, proposed.payload_hash),
        ),
      ).toMatchObject({ code: 'untrusted_recipient_origin' });
      expect(
        await sql`select * from budget_ledger where action_id = ${proposed.action_id}`,
      ).toHaveLength(0);
      const approval = await post(
        `/actions/${proposed.action_id}/approve`,
        { payload_hash: proposed.payload_hash },
        env.MELETE_APPROVAL_KEY,
      );
      expect(approval.status).toBe(200);

      const admitted = await boundary.broker.admit(
        seed.claims,
        proposed.action_id,
        proposed.payload_hash,
      );
      expect(admitted.status).toBe('admitted');
      expect(admitted.authorization_ref).toBe(proposed.approval_id);
      const [reserved] =
        await sql`select reserved, settled from budget_ledger where action_id = ${proposed.action_id} and kind = 'usd_est'`;
      expect(Number(reserved?.reserved)).toBe(0.037);
      expect(reserved?.settled).toBeNull();
      const dispatched = await post('/actions', request);
      expect(dispatched.status).toBe(201);
      expect(await dispatched.json()).toMatchObject({
        action_id: proposed.action_id,
        status: 'succeeded',
        repeated: true,
      });
      const stored = await boundary.broker.get(seed.claims, proposed.action_id);
      expect(stored.receipt?.action_id).toBe(proposed.action_id);
      expect(stored.receipt?.detail).toMatchObject({
        kind: 'artifact',
        path: 'artifacts/episode.wav',
        provider: 'fake',
      });
      const bytes = await readFile(join(root, seed.claims.space_id, 'artifacts', 'episode.wav'));
      expect(scriptFromWav(bytes)).toBe(request.payload.script);
      const [settled] =
        await sql`select reserved, settled from budget_ledger where action_id = ${proposed.action_id} and kind = 'usd_est'`;
      expect(Number(settled?.settled)).toBe(0.037);
      const duplicate = await post('/actions', request);
      expect(await duplicate.json()).toMatchObject({
        action_id: proposed.action_id,
        status: 'succeeded',
        repeated: true,
      });
      expect(await sql`select id from action where job_id = ${seed.claims.job_id}`).toHaveLength(1);
      expect(
        await sql`select seq from event where job_id = ${seed.claims.job_id} and type = 'action_status_changed' and payload->>'to' = 'dispatched'`,
      ).toHaveLength(1);
      const tampered = await post('/actions', {
        ...request,
        payload: { ...request.payload, price: 0 },
      });
      expect(tampered.status).toBe(409);
      expect(await tampered.json()).toMatchObject({ error: { code: 'payload_invalid' } });
      const changed = await post('/actions', {
        ...request,
        payload: { ...request.payload, script: 'Changed script.' },
      });
      const next = (await changed.json()) as EffectProposalResponse;
      expect(next.status).toBe('needs_approval');
      expect(next.action_id).not.toBe(proposed.action_id);
      expect(next.approval_id).not.toBe(proposed.approval_id);
      expect(
        await sql`select * from budget_ledger where action_id = ${next.action_id}`,
      ).toHaveLength(0);
    } finally {
      await boundary.close();
      await removeFixture(root);
    }
  },
  60_000,
);
