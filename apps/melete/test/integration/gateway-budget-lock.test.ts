/**
 * A model call's admission takes the event order lock. The operator's routes
 * for the call (a vision model, fallbacks) are read from the model settings on
 * the pool, so they must be read outside that lock. Real Postgres, with the
 * lock guard refusing any statement sent to the pool while the lock is held.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { signCapability } from '../../src/broker/capability.ts';
import { PostgresGatewayBudget } from '../../src/broker/gateway-budget.ts';
import { loadEnv } from '../../src/env.ts';
import { ModelSettingsService } from '../../src/gateway/model-settings.ts';
import { seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const suite = fixture ? describe : describe.skip;
const capabilityKey = 'gateway-budget-lock-signing-key-000000000';

const STRONG = { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4' };
const VISION = { provider: 'fireworks', model: 'accounts/fireworks/models/qwen-vl' };
const BACKUP = { provider: 'fireworks', model: 'accounts/fireworks/models/backup-chat' };

suite('gateway budget and the event order lock', () => {
  const guard = process.env.MELETE_EVENT_LOCK_GUARD;
  beforeAll(() => {
    process.env.MELETE_EVENT_LOCK_GUARD = 'throw';
  });
  afterAll(async () => {
    if (guard === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
    else process.env.MELETE_EVENT_LOCK_GUARD = guard;
    await fixture?.close();
  });

  async function attemptOnServerDefault(rules?: { allowedModels: string[] }) {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const seed = await seedJob(fixture.sql);
    // The server's default model, so its routes are looked up in the settings.
    await fixture.sql`update attempt set provider = ${STRONG.provider}, model = ${STRONG.model}
      where id = ${seed.claims.attempt_id}`;
    if (rules)
      await fixture.sql`insert into space_policy (space_id, allowed_models)
        values (${seed.claims.space_id}, ${JSON.stringify(rules.allowedModels)}::jsonb)`;
    return seed;
  }

  function budgetWithSettings() {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const env = loadEnv({
      MELETE_DEFAULT_PROVIDER: STRONG.provider,
      MELETE_DEFAULT_MODEL: STRONG.model,
    });
    const settings = new ModelSettingsService({ db: fixture.db, env });
    const routing = { fast: null, vision: VISION, fallback: [BACKUP] };
    return new PostgresGatewayBudget({
      sql: fixture.sql,
      capabilityKey,
      routes: (attempt) => settings.attemptRoutes(routing, attempt),
    });
  }

  test("a call's routes are read from the model settings without holding the lock", async () => {
    const seed = await attemptOnServerDefault();
    const budget = budgetWithSettings();
    const principal = await budget.authenticate(signCapability(seed.claims, capabilityKey));
    expect(principal.routes).toEqual({ vision: VISION, fallback: [BACKUP] });
    expect(principal.allowedModels).toEqual([STRONG, VISION, BACKUP]);
    // The principal still reserves under the lock as before.
    const reservation = await budget.reserve({
      principal,
      requestId: 'req-1',
      provider: BACKUP.provider,
      model: BACKUP.model,
      estimatedTokens: 200,
      maxOutputTokens: 64,
    });
    expect(reservation.id).toBeString();
  });

  test("the space's rules, read under the lock, still bound the routes read after it", async () => {
    const seed = await attemptOnServerDefault({
      allowedModels: [`${STRONG.provider}/${STRONG.model}`, `${BACKUP.provider}/${BACKUP.model}`],
    });
    const principal = await budgetWithSettings().authenticate(
      signCapability(seed.claims, capabilityKey),
    );
    expect(principal.routes).toEqual({ fallback: [BACKUP] });
    expect(principal.allowedModels).toEqual([STRONG, BACKUP]);
  });
});
