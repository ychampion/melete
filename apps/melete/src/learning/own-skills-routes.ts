/**
 * The person's own skills, on the page where they read what Melete learned.
 *
 * A skill the person asked the agent to make is a file in their personal
 * space's `skills/` folder (`connectors/skills.ts`). Here the person reads each
 * one whole, changes its words, or deletes it. Every change names the version
 * of the file the person was shown, so a skill the agent changed since is
 * never overwritten or removed unseen. Only the owner of a personal space
 * reaches its skills; a shared space keeps none.
 */
import {
  learningSpaceQuery,
  type OwnSkillRecord,
  ownSkillDeleteRequest,
  ownSkillEditRequest,
  ownSkillName,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { BrokerFault } from '../broker/errors.ts';
import {
  type OwnSkill,
  readOwnSkills,
  removeOwnSkill,
  rewriteOwnSkill,
} from '../connectors/skills.ts';
import type { Database } from '../db/client.ts';
import { spaceAuthority } from '../principals/authority.ts';

export type OwnSkillsDeps = { db: Database; spacesRoot: string };

const record = (skill: OwnSkill): OwnSkillRecord => ({
  name: skill.name,
  description: skill.description,
  triggers: skill.triggers,
  body: skill.body,
  version: skill.version,
  updated_at: skill.updated_at,
});

/** A refusal from the skill files, said to the person in the same words. */
function asServiceError(error: unknown): never {
  if (error instanceof BrokerFault)
    throw new ServiceError(
      error.code === 'scope_denied' ? 'scope_denied' : 'invalid_request',
      error.message,
      error.code === 'scope_denied' ? 403 : 400,
    );
  throw error;
}

export function mountOwnSkills(app: Hono, deps: OwnSkillsDeps) {
  /** The person's personal space, which they own; any other space keeps no skills. */
  const ownSpace = async (principalId: string, spaceId: string) => {
    const access = await spaceAuthority(deps.db, spaceId, principalId);
    if (access.space.kind !== 'personal' || access.role !== 'owner')
      throw new ServiceError('scope_denied', 'Skills are kept only in your own space.', 403);
  };

  /** The skill by name, as it is now, checked against the version the person saw. */
  const current = async (spaceId: string, name: string, version: string) => {
    const found = (await readOwnSkills(deps.spacesRoot, spaceId).catch(asServiceError)).find(
      (skill) => skill.name === name,
    );
    if (!found) throw new ServiceError('not_found', 'You have no skill by that name.', 404);
    if (found.version !== version)
      throw new ServiceError(
        'skill_changed',
        'This skill changed since you opened it. Look at it again before changing it.',
        409,
      );
    return found;
  };

  app.get('/own-skills', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    await ownSpace(c.get('owner').id, input.space_id);
    const skills = await readOwnSkills(deps.spacesRoot, input.space_id).catch(asServiceError);
    return c.json({ skills: skills.map(record) });
  });

  app.post('/own-skills/:name/edit', async (c) => {
    const name = ownSkillName().parse(c.req.param('name'));
    const input = ownSkillEditRequest.parse(await c.req.json());
    await ownSpace(c.get('owner').id, input.space_id);
    const found = await current(input.space_id, name, input.version);
    await rewriteOwnSkill(deps.spacesRoot, input.space_id, found, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.triggers !== undefined ? { triggers: input.triggers } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }).catch(asServiceError);
    const after = (await readOwnSkills(deps.spacesRoot, input.space_id)).find(
      (skill) => skill.name === name,
    );
    if (!after) throw new ServiceError('not_found', 'You have no skill by that name.', 404);
    return c.json({ skill: record(after) });
  });

  app.post('/own-skills/:name/delete', async (c) => {
    const name = ownSkillName().parse(c.req.param('name'));
    const input = ownSkillDeleteRequest.parse(await c.req.json());
    await ownSpace(c.get('owner').id, input.space_id);
    const found = await current(input.space_id, name, input.version);
    await removeOwnSkill(deps.spacesRoot, input.space_id, found).catch(asServiceError);
    return c.json({ deleted: name });
  });
}
