/**
 * The engine-skill intake as a deployment serves it: through the runtime's one
 * internal HTTP exit, built by `createInternalServer`, with nothing wired by hand.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createInternalServer } from '../../src/broker/internal-server.ts';
import { ENGINE_SKILL_PATH } from '../../src/learning/runtime-route.ts';
import { procedureCandidate } from '../../src/learning/schema.ts';
import { DIGEST_BODY, engineSkillFixture, ownerItem } from './engine-skill-fixtures.ts';

const fixture = await engineSkillFixture();
const internal = fixture
  ? createInternalServer({
      sql: fixture.handle.sql,
      connectors: { get: () => undefined },
      capabilityKey: fixture.runner.options.key,
      approvalKey: 'engine-intake-approval-key-00000000000000',
      catalog: {
        skills: async () => [],
      },
    })
  : null;
const base = internal
  ? await new Promise<string>((resolve, reject) => {
      internal.server.once('error', reject);
      internal.server.listen(0, '127.0.0.1', () => {
        const address = internal.server.address();
        if (!address || typeof address === 'string') reject(new Error('No address'));
        else resolve(`http://127.0.0.1:${address.port}`);
      });
    })
  : '';
afterAll(async () => {
  await new Promise<void>((resolve) =>
    internal ? internal.server.close(() => resolve()) : resolve(),
  );
  await fixture?.close();
}, 30000);

const post = (token: string | null, body: unknown) =>
  fetch(`${base}${ENGINE_SKILL_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

(fixture ? describe : describe.skip)('the engine-skill intake on the internal server', () => {
  test('a skill posted under a running attempt capability is admitted and delivered', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const writer = await fixture.writing(spaceId, { items: [ownerItem()], finish: false });
    const skill = {
      name: 'weekly-digest',
      description: 'Write the weekly digest.',
      body: DIGEST_BODY,
    };
    // Without the capability, nothing is read or stored.
    const anonymous = await post(null, skill);
    expect(anonymous.status).toBe(401);
    const response = await post(writer.token, skill);
    expect(response.status).toBe(200);
    const admitted = (await response.json()) as { skill_id: string; state: string };
    expect(admitted).toMatchObject({ name: 'weekly-digest', state: 'live', reason: null });
    const [row] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, admitted.skill_id));
    expect(row).toMatchObject({
      spaceId,
      sourceJobId: writer.row.id,
      sourceAttemptId: writer.attemptId,
      body: DIGEST_BODY,
    });
    // A built-in name is refused on this path as well.
    const reserved = await post(writer.token, { ...skill, name: 'research-with-sources' });
    expect(reserved.status).toBe(200);
    expect(await reserved.json()).toMatchObject({ state: 'rejected', reason: 'reserved_name' });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);
  }, 120000);
});
