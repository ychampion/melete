/**
 * The knowledge and skills HTTP surface, backed by @melete/knowledge and
 * @melete/skills.
 *
 * Two things are load-bearing here. A request is bound to exactly one space
 * before any handler runs, and a handler that is given a different space id
 * refuses rather than serving it, so an injected model cannot search a space by
 * naming it. And nothing an agent sends lands in a space: a proposal is staged
 * and diffed, and applying it is a separate call that ends in a git commit.
 *
 * Authentication is not here. The placeholder middleware reads the space from a
 * header; the session will supply it, and every handler below is written as
 * though it already does.
 */
import {
  type ErrorResponse,
  ID_PREFIXES,
  type KnowledgeType,
  knowledgeSearchQuery,
  proposedWrite,
  retractKnowledgeRequest,
} from '@melete/contracts';
import {
  applyProposal,
  DEFAULT_POLICY,
  type Finding,
  getProposal,
  hardDelete,
  knownIds,
  type LoadedRecord,
  listProposals,
  loadSpace,
  proposeWrite,
  rebuild,
  requiresApproval,
  retract,
  type SearchHit,
  SpaceIndex,
  type SpacePolicy,
  toMatchQuery,
} from '@melete/knowledge';
import { chooseSkills, loadSkills } from '@melete/skills';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { stableUlid } from './ids.ts';
import type { SpaceRef, SpaceResolver } from './spaces.ts';

export type KnowledgeDeps = {
  spaces: SpaceResolver;
  /** What each space lets an agent do without a person. */
  policyFor?: (space: SpaceRef) => SpacePolicy;
  now?: () => Date;
};

type Variables = { space: SpaceRef };

/** The header the session will replace. Tests and scripts use it directly. */
export const SPACE_HEADER = 'x-melete-space';

const fail = (code: string, message: string, detail?: Record<string, unknown>): ErrorResponse => ({
  error: { code, message, ...(detail ? { detail } : {}) },
});

const findingsDetail = (findings: readonly Finding[]): Record<string, unknown> => ({
  findings: findings.map((f) => ({
    check: f.check,
    severity: f.severity,
    message: f.message,
    ...(f.field ? { field: f.field } : {}),
  })),
});

const asRecordResponse = (record: LoadedRecord) => ({
  id: record.frontmatter.id,
  path: record.path,
  frontmatter: record.frontmatter,
  body: record.body,
});

/**
 * Search the files rather than the index. Only the owner's own audit view uses
 * this: retracted records are not in the index by design, and this is the one
 * path that can show what Melete used to believe. No model ever reaches it.
 */
function scanForRetracted(records: readonly LoadedRecord[], text: string, limit: number) {
  const tokens = (toMatchQuery(text) ?? '')
    .split(' OR ')
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  return records
    .filter((record) => {
      const haystack =
        `${record.frontmatter.title} ${record.frontmatter.tags.join(' ')} ${record.body}`.toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    })
    .slice(0, limit)
    .map((record) => ({
      id: record.frontmatter.id,
      path: record.path,
      title: record.frontmatter.title,
      excerpt: record.body.slice(0, 160),
      status: record.frontmatter.status,
      score: 0,
    }));
}

const hitView = (hit: SearchHit) => ({
  id: hit.id,
  path: hit.path,
  title: hit.title,
  excerpt: hit.excerpt,
  status: hit.status,
  score: hit.score,
});

/**
 * Open a space's index, building it when it has never been built. Opened per
 * request and closed again: a knowledge search is not a hot path, and a handle
 * that outlives the request is a handle that can outlive a revocation.
 */
function withIndex<T>(space: SpaceRef, use: (index: SpaceIndex) => T): T {
  const index = SpaceIndex.open(space.paths);
  try {
    if (index.count() === 0) rebuild(space.paths, index);
    return use(index);
  } finally {
    index.close();
  }
}

export function knowledgeRoutes(deps: KnowledgeDeps) {
  const app = new Hono<{ Variables: Variables }>();
  const policyFor = deps.policyFor ?? (() => DEFAULT_POLICY);
  const contextFor = (space: SpaceRef) => ({
    paths: space.paths,
    spacesRoot: space.paths.root.slice(0, space.paths.root.length - space.name.length - 1),
    knownIds: knownIds(loadSpace(space.paths)),
    policy: policyFor(space),
    ...(deps.now ? { now: deps.now } : {}),
  });

  // Every request this module serves is bound to one space before a handler
  // runs. The paths are named rather than starred: this app is mounted at the
  // root of the service, and a module must not answer for another module's
  // routes, least of all with an error about a space.
  const bindSpace: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const header = c.req.header(SPACE_HEADER);
    if (!header) {
      return c.json(
        fail(
          'no_space',
          `this request needs a space; the session will supply it, and until then ${SPACE_HEADER} does`,
        ),
        401,
      );
    }
    const space = await deps.spaces.byId(header);
    if (!space) return c.json(fail('no_such_space', `no space with id ${header}`), 404);
    c.set('space', space);
    await next();
    return undefined;
  };

  for (const path of ['/knowledge', '/knowledge/*', '/skills']) app.use(path, bindSpace);

  /** The space id a caller passed must be the space it is already bound to. */
  const sameSpace = (space: SpaceRef, given: string): boolean => given === space.id;

  app.get('/knowledge/search', (c) => {
    const space = c.get('space');
    const parsed = knowledgeSearchQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(fail('invalid_request', parsed.error.issues[0]?.message ?? 'bad query'), 400);
    }
    if (!sameSpace(space, parsed.data.space_id)) {
      return c.json(fail('wrong_space', 'this session cannot search that space'), 403);
    }

    const { q, limit, include_retracted } = parsed.data;
    if (include_retracted) {
      const records = loadSpace(space.paths).records;
      return c.json({ hits: scanForRetracted(records, q, limit) });
    }
    const hits = withIndex(space, (index) => index.query(q, { limit }));
    return c.json({ hits: hits.map(hitView) });
  });

  app.get('/knowledge/proposals', (c) => {
    const space = c.get('space');
    const policy = policyFor(space);
    return c.json({
      proposals: listProposals(space.paths).map((proposal) => ({
        proposal_id: proposal.id,
        path: proposal.path,
        rationale: proposal.rationale,
        type: proposal.type,
        proposed_by: proposal.proposedBy,
        proposed_at: proposal.proposedAt,
        requires_approval: requiresApproval(policy, proposal.type as KnowledgeType),
      })),
    });
  });

  app.post('/knowledge/proposals', async (c) => {
    const space = c.get('space');
    const body = proposedWrite.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        fail('invalid_request', 'the proposal is not a knowledge write', {
          issues: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        }),
        400,
      );
    }
    if (!sameSpace(space, spaceIdOf(space, body.data.space))) {
      return c.json(fail('wrong_space', 'this session cannot write to that space'), 403);
    }

    const result = proposeWrite(contextFor(space), body.data);
    if (!result.ok) {
      return c.json(
        fail('lint_failed', 'the record was not staged', findingsDetail(result.findings)),
        400,
      );
    }
    return c.json(
      { proposal_id: result.proposal.id, path: result.proposal.path, diff: result.diff },
      201,
    );
  });

  app.post('/knowledge/proposals/:proposalId/apply', async (c) => {
    const space = c.get('space');
    const proposal = getProposal(space.paths, c.req.param('proposalId'));
    if (!proposal) return c.json(fail('not_found', 'no proposal with that id is staged'), 404);

    const body = (await c.req.json().catch(() => ({}))) as { approved_by?: string };
    const policy = policyFor(space);
    const needsPerson = requiresApproval(policy, proposal.type as KnowledgeType);
    const approvedBy = body.approved_by ?? (needsPerson ? null : 'policy:auto-apply');
    if (!approvedBy) {
      return c.json(
        fail('approval_required', `a ${proposal.type} record in this space needs a person`),
        409,
      );
    }

    const applied = await applyProposal(contextFor(space), proposal, { approvedBy });
    if (!applied.ok) {
      return c.json(
        fail('apply_failed', 'the proposal was not applied', findingsDetail(applied.findings)),
        409,
      );
    }
    return c.json({
      proposal_id: proposal.id,
      path: applied.path,
      commit: applied.commit.sha,
      approved_by: approvedBy,
    });
  });

  app.get('/knowledge', (c) => {
    const space = c.get('space');
    const given = c.req.query('space_id');
    if (given && !sameSpace(space, given)) {
      return c.json(fail('wrong_space', 'this session cannot list that space'), 403);
    }
    return c.json({
      records: loadSpace(space.paths).records.map((record) => ({
        id: record.frontmatter.id,
        path: record.path,
        title: record.frontmatter.title,
        type: record.frontmatter.type,
        status: record.frontmatter.status,
        tags: record.frontmatter.tags,
        updated: record.frontmatter.updated,
      })),
    });
  });

  app.get('/knowledge/:recordId', (c) => {
    const space = c.get('space');
    const record = findRecord(space, c.req.param('recordId'));
    if (!record) return c.json(fail('not_found', 'no record with that id in this space'), 404);
    return c.json(asRecordResponse(record));
  });

  app.delete('/knowledge/:recordId', async (c) => {
    const space = c.get('space');
    const record = findRecord(space, c.req.param('recordId'));
    if (!record) return c.json(fail('not_found', 'no record with that id in this space'), 404);

    const body = retractKnowledgeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(fail('invalid_request', 'a retraction needs a reason'), 400);
    }

    const request = {
      reason: body.data.reason,
      by: 'owner',
      ...(deps.now ? { now: deps.now } : {}),
    };

    const index = SpaceIndex.open(space.paths);
    try {
      if (index.count() === 0) rebuild(space.paths, index);

      if (body.data.hard_delete) {
        await hardDelete(space.paths, index, record, request);
        // The record is gone; what is returned is what was just deleted.
        return c.json(asRecordResponse(record));
      }

      await retract(space.paths, index, record, request);
      const after = findRecord(space, record.frontmatter.id);
      return c.json(asRecordResponse(after ?? record));
    } catch (error) {
      return c.json(
        fail('cannot_retract', String(error instanceof Error ? error.message : error)),
        409,
      );
    } finally {
      index.close();
    }
  });

  app.get('/skills', (c) => {
    const space = c.get('space');
    const loaded = loadSkills({ spaceSkillsDirectory: space.paths.skills });
    return c.json({
      skills: loaded.skills.map((skill) => ({
        id: `${ID_PREFIXES.skill}_${stableUlid(`skill:${skill.frontmatter.name}`)}`,
        space_id: skill.source === 'space' ? space.id : null,
        path: skill.path,
        enabled: true,
        frontmatter: skill.frontmatter,
      })),
    });
  });

  return app;
}

/** Selection, exposed so a caller can see which skills an objective would load. */
export const skillsForObjective = (
  objective: string,
  latestMessage: string,
  spaceSkillsDirectory?: string,
) =>
  chooseSkills(
    objective,
    latestMessage,
    loadSkills(spaceSkillsDirectory ? { spaceSkillsDirectory } : {}).skills,
  );

const findRecord = (space: SpaceRef, id: string): LoadedRecord | undefined =>
  loadSpace(space.paths).records.find((record) => record.frontmatter.id === id);

/** A write names its space by directory name; the session knows it by id. */
const spaceIdOf = (space: SpaceRef, name: string): string =>
  name === space.name ? space.id : `${ID_PREFIXES.space}_unresolved`;
