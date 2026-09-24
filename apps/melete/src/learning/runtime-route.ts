import { createHash } from 'node:crypto';
import {
  type CapabilityClaims,
  type EngineSkillIntakeRequest,
  engineSkillIntakeRequest,
  engineSkillIntakeResponse,
  MAX_ENGINE_SKILL_BODY,
  type ToolSpec,
  toolSpec,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ServiceError } from '../api/errors.ts';
import { AuthenticationError, verifyCapability } from '../broker/capability.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { BrokerOperations } from '../broker/http.ts';
import { appendEvent, checkAttempt, lockJob } from '../broker/records.ts';

/** The path the plugin inside the agent's container posts a skill package to. */
export const ENGINE_SKILL_PATH = '/tools/learning/skill';

/**
 * What the intake needs from whoever mounts this route: the service function,
 * given the verified claims and the package. Supplied by the deployment that
 * has a database; without it the path falls through to the broker's own 404.
 */
export type EngineSkillIntakeOperations = {
  intake(
    claims: CapabilityClaims,
    skill: EngineSkillIntakeRequest,
  ): Promise<{ candidateId: string; state: 'live' | 'held' | 'rejected'; reason: string | null }>;
};

export const LEARNING_TOOL: ToolSpec = {
  name: 'learning.propose',
  description:
    'Refer the owner correction in this job to evaluated procedure learning. Returns pending history, never installs a live skill. Requires a recorded owner intervention.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  effect_class: 'read',
  connection_id: null,
};

/**
 * Hermes can refer an existing owner intervention, but cannot invent one or publish a skill.
 * This read-only handoff uses the existing capability verifier and current-attempt authorizer.
 */
/** Said once per process: an unwired intake is a deployment mistake, not traffic. */
let warnedUnwired = false;

export function learningRuntimeFetch(options: {
  sql: Sql;
  capabilityKey: string;
  broker: Pick<BrokerOperations, 'authorize'>;
  fallback: (request: Request) => Response | Promise<Response>;
  onError?: (error: unknown) => void;
  skills?: EngineSkillIntakeOperations;
}) {
  let available: Promise<boolean> | undefined;
  async function hasLearningSchema() {
    available ??=
      options.sql`select to_regclass('public.episode') is not null and to_regclass('public.learning_attempt') is not null as available`.then(
        (rows) => rows[0]?.available === true,
        (error) => {
          // A transient connection failure must not disable the catalog for this process.
          available = undefined;
          throw error;
        },
      );
    return available;
  }
  async function principal(request: Request) {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer '))
      throw new AuthenticationError('attempt capability required');
    const claims: CapabilityClaims = verifyCapability(header.slice(7), options.capabilityKey);
    await options.broker.authorize(claims);
    return claims;
  }
  async function source(claims: CapabilityClaims) {
    const [row] = await options.sql`
      select e.id, e.generation_state from episode e
      where (e.job_id = ${claims.job_id} or e.corrective_job_id = ${claims.job_id}) and e.space_id = ${claims.space_id}
        and not e.restricted and e.expires_at > now() and e.intervention is not null
        and e.scope->>'task_family' <> 'unclassified'
        and e.judgement in ('pending','corrected')
      order by e.created_at desc limit 1`;
    return row;
  }
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (
      path !== '/tools/learning/propose' &&
      path !== ENGINE_SKILL_PATH &&
      !(path === '/tools' && request.method === 'GET')
    )
      return options.fallback(request);
    try {
      // Standalone broker deployments can precede the additive learning migration.
      if (!(await hasLearningSchema())) return options.fallback(request);
      if (path === ENGINE_SKILL_PATH) {
        if (request.method !== 'POST')
          return Response.json({ error: { code: 'not_found' } }, { status: 404 });
        // Mounted without an intake, this path would quietly answer 404 and a whole
        // write surface would look absent rather than unwired. It says so instead,
        // once per process, and answers with a code naming the missing wiring.
        if (!options.skills) {
          if (!warnedUnwired) {
            warnedUnwired = true;
            options.onError?.(
              new Error(
                'The engine-skill intake is mounted without a service; skill packages are refused.',
              ),
            );
          }
          return Response.json({ error: { code: 'skill_intake_unwired' } }, { status: 503 });
        }
        // Who is asking, and how much they declare, are settled before the body is read.
        const claims = await principal(request);
        const limit = MAX_ENGINE_SKILL_BODY + 2048;
        if (Number(request.headers.get('content-length') ?? 0) > limit)
          return Response.json({ error: { code: 'payload_invalid' } }, { status: 413 });
        const raw = await request.text();
        if (raw.length > limit)
          return Response.json({ error: { code: 'payload_invalid' } }, { status: 413 });
        // Strict: the package is the only thing the caller may say, so a request
        // that also names a principal, space, job or attempt is refused outright.
        const skill = engineSkillIntakeRequest.parse(JSON.parse(raw));
        const admission = await options.skills.intake(claims, skill);
        return Response.json(
          engineSkillIntakeResponse.parse({
            skill_id: admission.candidateId,
            name: skill.name,
            state: admission.state,
            reason: admission.reason,
          }),
        );
      }
      if (path === '/tools' && request.method === 'GET') {
        const response = await options.fallback(request);
        if (!response.ok) return response;
        const body = z.object({ tools: z.array(toolSpec) }).parse(await response.json());
        const claims = await principal(request);
        if (await source(claims)) {
          if (body.tools.length < 15) body.tools.push(LEARNING_TOOL);
          else {
            // Preserve the delivered catalog and record the omission once per attempt.
            await options.sql.begin(async (tx) => {
              await tx`select pg_advisory_xact_lock(31003103)`;
              await checkAttempt(tx, await lockJob(tx, claims.job_id), claims);
              await appendEvent(
                tx,
                claims.job_id,
                claims.attempt_id,
                'notice',
                {
                  kind: 'learning_catalog_full',
                  tool: LEARNING_TOOL.name,
                  limit: 15,
                  tool_count: body.tools.length,
                  message:
                    'Learning handoff omitted from the full catalog; owner interventions still drain automatically.',
                },
                `learning:${claims.attempt_id}:catalog-full`,
              );
            });
          }
        }
        // Hermes obtains its actual catalog over HTTP after claim; bind those delivered specs too.
        const versions = body.tools.map((tool) => ({
          name: tool.name,
          version: `sha256:${createHash('sha256').update(JSON.stringify(tool)).digest('hex')}`,
        }));
        await options.sql`update learning_attempt set versions = jsonb_set(versions, '{tools}', ${JSON.stringify(versions)}::jsonb) where attempt_id = ${claims.attempt_id}`;
        return Response.json(body);
      }
      if (request.method !== 'POST')
        return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      const raw = await request.text();
      if (raw.length > 1024)
        return Response.json({ error: { code: 'payload_invalid' } }, { status: 413 });
      z.strictObject({}).parse(JSON.parse(raw));
      const row = await source(await principal(request));
      if (!row)
        return Response.json({ error: { code: 'owner_intervention_required' } }, { status: 409 });
      return Response.json({
        status: 'candidate_pending',
        episode_id: row.id,
        generation_state: row.generation_state,
        instruction:
          'The service evaluates reusable steps after corrected completion. No live skill was written.',
      });
    } catch (error) {
      if (error instanceof AuthenticationError)
        return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
      if (error instanceof BrokerFault)
        return Response.json({ error: { code: error.code } }, { status: 403 });
      // A refused intake answers with its reason code, never with what was refused.
      if (error instanceof ServiceError)
        return Response.json({ error: { code: error.code } }, { status: error.status });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json({ error: { code: 'payload_invalid' } }, { status: 400 });
      options.onError?.(error);
      return Response.json({ error: { code: 'learning_unavailable' } }, { status: 500 });
    }
  };
}
