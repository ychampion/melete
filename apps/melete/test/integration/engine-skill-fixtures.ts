import { EngineSkillService } from '../../src/learning/engine-skills.ts';
import { newId } from '../../src/memory/db.ts';
import { wake } from './learning-fixtures.ts';
import { generalLearningFixture } from './learning-general-fixtures.ts';

export type ContextItem = {
  claim_id: string;
  revision: number;
  handle: string;
  key: string | null;
  origin_trust: string;
  sources: { source_id: string; source_version: string }[];
};

export const ownerItem = (claimId = newId('k')): ContextItem => ({
  claim_id: claimId,
  revision: 1,
  handle: `${claimId}@1`,
  key: 'fact.digest_length',
  origin_trust: 'owner',
  sources: [],
});
export const externalItem = (claimId = newId('k')): ContextItem => ({
  ...ownerItem(claimId),
  origin_trust: 'external_content',
});

export const DIGEST_BODY = [
  '# Weekly digest',
  '',
  '1. Read the notes in ./notes for the week.',
  '2. Keep the digest under 200 words.',
  '3. Put the three decisions first.',
].join('\n');

type WritingOptions = {
  objective?: string;
  principal?: string;
  items?: readonly ContextItem[];
  context?: boolean;
  finish?: boolean;
};

/** The engine-skill fixture: the learning fixture plus the skill service and its intake. */
export async function engineSkillFixture() {
  const learning = await generalLearningFixture();
  if (!learning) return null;
  const engine = new EngineSkillService(learning.jobs);

  /** The memory context of an attempt: what the service recorded that it read. */
  const recordContext = async (
    spaceId: string,
    jobId: string,
    attemptId: string,
    items: readonly ContextItem[],
  ) => {
    const id = newId('ctx');
    await learning.handle
      .sql`insert into memory_contexts (id, space_id, job_id, attempt_id, job_revision,
      policy_generation, data_revision, access_generation, audience, purpose, items, recipe,
      token_budget, recall_status)
      values (${id}, ${spaceId}, ${jobId}, ${attemptId}, 0, 0, 0, 0, '[]'::jsonb, 'work',
      ${JSON.stringify(items)}::jsonb, 'fixture', '{}'::jsonb, 'complete')`;
    for (const item of items)
      await learning.handle
        .sql`insert into memory_derivations (space_id, input_kind, input_id, input_version,
        output_kind, output_id, output_version)
        values (${spaceId}, 'claim', ${item.claim_id}, ${String(item.revision)}, 'context', ${id}, '1')
        on conflict do nothing`;
    return id;
  };

  /**
   * A job with a claimed attempt, and the trust record for that attempt unless the
   * test is about a missing one. Returns the claims a capability would carry.
   */
  const writing = async (spaceId: string, options: WritingOptions = {}) => {
    const row = await learning.create(
      spaceId,
      options.objective ?? 'Write up the week for me',
      options.principal ?? learning.ownerId,
    );
    const claim = await learning.runner.claim(wake(row));
    if (!claim) throw new Error('No attempt was claimed');
    const attemptId = claim.bundle.attempt.id;
    if (options.context !== false)
      await recordContext(spaceId, row.id, attemptId, options.items ?? []);
    if (options.finish !== false)
      await learning.runner.commitOutcome(claim.claims, {
        kind: 'completed',
        summary: 'Wrote the week up.',
        evidence: [],
      });
    return {
      row,
      attemptId,
      token: claim.bundle.attempt.token,
      claims: {
        space_id: spaceId,
        job_id: row.id,
        attempt_id: attemptId,
        principal_id: options.principal ?? learning.ownerId,
      },
    };
  };

  /** The skills a later job of this principal actually receives. */
  const deliveredTo = async (spaceId: string, objective: string, principal?: string) => {
    const row = await learning.create(spaceId, objective, principal ?? learning.ownerId);
    const claim = await learning.runner.claim(wake(row));
    const names = claim?.bundle.skills.map((skill) => skill.name) ?? [];
    await learning.jobs.cancel(row.id);
    return names;
  };

  const sharedSpace = async (withMember = false) => {
    const spaceId = await learning.createSpace();
    await learning.handle
      .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${learning.ownerId} where id = ${spaceId}`;
    await learning.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${learning.ownerId}, 'owner')`;
    if (!withMember) return { spaceId, memberId: null };
    const memberId = newId('own');
    await learning.handle
      .sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
    await learning.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${memberId}, 'member')`;
    return { spaceId, memberId };
  };

  return { ...learning, engine, recordContext, writing, deliveredTo, sharedSpace };
}
