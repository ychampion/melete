import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/fake.ts';
import { compileProcedure, definitionHash } from '../../src/learning/procedure.ts';
import { openProposalGateway } from '../../src/learning/proposal-gateway.ts';
import { learningModelCall } from '../../src/learning/proposal-schema.ts';
import { ProcedureProposer } from '../../src/learning/proposer.ts';
import { learningRuntimeFetch } from '../../src/learning/runtime-route.ts';
import {
  episode,
  learningAttempt,
  procedureCandidate,
  procedureTransition,
} from '../../src/learning/schema.ts';
import { learningFixture, learningScope, rejectsWith, wake } from './learning-fixtures.ts';

const fixture = await learningFixture();
const requests: Record<string, unknown>[] = [];
let output: unknown = {
  target: 'skill_body',
  steps: ['sort-typed-values', 'keep-header-and-rows'],
  test: 'ordering-and-shape',
};
const gateway = fixture
  ? await openProposalGateway({
      db: fixture.handle.db,
      provider: 'fake',
      model: 'scripted-proposer-v1',
      providers: [fakeProvider],
      fake: async (body, attemptId, protocol) => {
        requests.push(body);
        return createScriptedProvider([{ text: JSON.stringify(output) }])(
          body,
          attemptId,
          protocol,
        );
      },
    })
  : null;
const proposer = fixture && gateway ? new ProcedureProposer(fixture.jobs, gateway) : null;
afterAll(async () => {
  await gateway?.close();
  await fixture?.close();
}, 15000);

async function correction(key: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await fixture.create(key, 'PRIVATE-INPUT-713 arrange these records');
  const first = await fixture.runner.claim(wake(row));
  if (!first) throw new Error('No attempt');
  const saved = await fixture.episodes.intervene(fixture.ownerId, row.id, {
    idempotency_key: key,
    kind: 'demonstration',
    text: 'PLANTED-SECRET-319: compare the amounts as numbers.',
    signal: 'typed_ordering',
  });
  const second = await fixture.runner.claim(wake(await fixture.jobs.get(row.id)));
  if (!second) throw new Error('No corrected attempt');
  await fixture.runner.commitOutcome(second.claims, {
    kind: 'completed',
    summary: 'Corrected records',
    evidence: [],
  });
  return saved;
}

(fixture ? describe : describe.skip)('bounded procedure generation through the gateway', () => {
  test('Hermes skill creation refers only this current job owner intervention', async () => {
    if (!fixture) return;
    const row = await fixture.create('runtime-handoff');
    const first = await fixture.runner.claim(wake(row));
    if (!first) throw new Error('No attempt');
    const serve = learningRuntimeFetch({
      sql: fixture.handle.sql,
      capabilityKey: 'learning-tests-capability-key-at-least-32',
      broker: new BrokerService({ sql: fixture.handle.sql, connectors: new ConnectorRegistry() }),
      fallback: () => Response.json({ tools: [] }),
      onError: (error) => console.error('tool catalogue capture', String(error)),
    });
    const request = (token: string, body: object = {}) =>
      new Request('http://learning.test/tools/learning/propose', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    expect((await serve(request(first.bundle.attempt.token))).status).toBe(409);
    const source = await fixture.episodes.intervene(fixture.ownerId, row.id, {
      idempotency_key: 'runtime-owner',
      kind: 'correction',
      text: 'Sort dates chronologically. PRIVATE-777.',
    });
    expect((await serve(request(first.bundle.attempt.token))).status).toBe(403);
    const current = await fixture.runner.claim(wake(await fixture.jobs.get(row.id)));
    if (!current) throw new Error('No corrected attempt');
    const result = await serve(request(current.bundle.attempt.token));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: 'candidate_pending',
      episode_id: source.id,
    });
    expect(
      (
        await serve(
          request(current.bundle.attempt.token, { target: 'skills/live.md', body: 'PRIVATE-777' }),
        )
      ).status,
    ).toBe(400);
    const catalog = await serve(
      new Request('http://learning.test/tools', {
        headers: { authorization: `Bearer ${current.bundle.attempt.token}` },
      }),
    );
    expect(await catalog.json()).toMatchObject({
      tools: [{ name: 'learning.propose', connection_id: null }],
    });
    const [captured] = await fixture.handle.db
      .select()
      .from(learningAttempt)
      .where(eq(learningAttempt.attemptId, current.claims.attempt_id));
    expect(captured?.versions.tools).toHaveLength(1);
    expect(captured?.versions.tools[0]).toMatchObject({
      name: 'learning.propose',
      version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const other = await fixture.create('different-runtime-job');
    const otherClaim = await fixture.runner.claim(wake(other));
    if (!otherClaim) throw new Error('No second job attempt');
    expect((await serve(request(otherClaim.bundle.attempt.token))).status).toBe(409);
    await fixture.jobs.cancel(row.id);
    await fixture.jobs.cancel(other.id);
  }, 15000);

  test('one corrected episode produces one scoped candidate with no private prose', async () => {
    if (!fixture || !proposer) return;
    const source = await correction('proposal-one');
    const candidate = await proposer.generate(fixture.ownerId, fixture.spaceId, source.id);
    expect(candidate).toMatchObject({
      state: 'candidate',
      spaceId: fixture.spaceId,
      scope: learningScope,
      compatibleModels: ['fake/scripted-learning-v1'],
      selectedEvaluationId: null,
    });
    expect(candidate.body).toBe(compileProcedure(output).body);
    expect(candidate.bodyHash).toBe(definitionHash(candidate));
    expect(JSON.stringify(candidate)).not.toContain('PLANTED-SECRET-319');
    expect(JSON.stringify(requests)).not.toContain('PLANTED-SECRET-319');
    expect(JSON.stringify(requests)).not.toContain('PRIVATE-INPUT-713');
    expect(JSON.stringify(requests)).not.toContain(source.id);
    expect(requests).toHaveLength(1);
    expect((await proposer.generate(fixture.ownerId, fixture.spaceId, source.id)).id).toBe(
      candidate.id,
    );
    expect(requests).toHaveLength(1);
    const [call] = await fixture.handle.db
      .select()
      .from(learningModelCall)
      .where(eq(learningModelCall.episodeId, source.id));
    expect(call?.reservedTokens).toBeLessThanOrEqual(2048);
    expect(call?.maxOutputTokens).toBe(512);
    expect(call?.settlement).toMatchObject({
      status: 'succeeded',
      modelActual: 'fake-scripted-v1',
    });
    expect(call?.settlement?.usage?.totalTokens).toBe(20);
    const history = await fixture.handle.db
      .select()
      .from(procedureTransition)
      .where(eq(procedureTransition.candidateId, candidate.id));
    expect(history.map((entry) => entry.toState)).toEqual(['candidate']);
  }, 15000);

  test('a model returning private text or a forbidden edit target cannot create a procedure', async () => {
    if (!fixture || !proposer) return;
    for (const bad of [
      { target: 'authorizer', steps: ['sort-typed-values'], test: 'ordering-and-shape' },
      { ...(output as object), body: 'PLANTED-SECRET-319' },
    ]) {
      output = bad;
      const source = await correction(`bad-proposal-${requests.length}`);
      await rejectsWith(
        () => proposer.generate(fixture.ownerId, fixture.spaceId, source.id),
        'proposal_rejected',
      );
      const candidates = await fixture.handle.db
        .select()
        .from(procedureCandidate)
        .where(eq(procedureCandidate.episodeId, source.id));
      expect(candidates).toHaveLength(0);
      const [saved] = await fixture.handle.db
        .select()
        .from(episode)
        .where(eq(episode.id, source.id));
      expect(saved?.generationState).toBe('rejected');
      const [call] = await fixture.handle.db
        .select()
        .from(learningModelCall)
        .where(eq(learningModelCall.episodeId, source.id));
      expect(call?.errorCode).toBe('proposal_rejected');
      await rejectsWith(
        () => proposer.generate(fixture.ownerId, fixture.spaceId, source.id),
        'proposal_already_attempted',
      );
    }
  }, 20000);

  test('a stored note and another space cannot authorize proposal generation', async () => {
    if (!fixture || !proposer) return;
    const source = await correction('proposal-scoped');
    const other = await fixture.createSpace();
    await rejectsWith(() => proposer.generate(fixture.ownerId, other, source.id), 'not_found');
    await fixture.handle.db
      .update(episode)
      .set({ intervention: null })
      .where(eq(episode.id, source.id));
    await rejectsWith(
      () => proposer.generate(fixture.ownerId, fixture.spaceId, source.id),
      'not_procedural',
    );
  }, 15000);
});
