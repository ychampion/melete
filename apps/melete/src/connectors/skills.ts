/**
 * The built-in `skills` connection: the person's own skills. A skill is a
 * short Markdown file with triggers (`SKILL.md`, the format the built-in
 * skills use), kept in the space's `skills/` directory, which the skill loader
 * reads at the start of every attempt. So a skill made here is used from the
 * next message on, whenever its triggers match, and every later attempt can
 * read it by name.
 *
 * Three tools:
 * - `skills.list` names the person's own skills and the built-in ones.
 * - `skills.create` saves a new one. It stays in the person's own space and
 *   changes nothing outside it, so it asks no one; a name already in use is
 *   refused, never replaced.
 * - `skills.update` rewrites one of the person's own skills. The words it
 *   replaces are kept beside it (`PREVIOUS.md`) and in the receipt, so the
 *   change can be undone.
 *
 * Only a person's own work in their personal space keeps skills, and a skill
 * that carries a password, key or token is refused: it is read into every
 * attempt it matches.
 */
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Action,
  BUILT_IN_SKILLS,
  type ConnectorManifest,
  type JsonObject,
  type JsonValue,
  type Receipt,
  skillFrontmatter,
} from '@melete/contracts';
import { loadSpaceSkills, parseSkill } from '@melete/skills';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { credentialMaterial } from '../learning/engine-scan.ts';
import type { Connector, ConnectorContext } from './types.ts';

export const SKILLS_PROVIDER = 'skills';

/** Names of the `skills.` tools themselves, and the broker's `skills.read`. */
const TAKEN_NAMES = new Set(['create', 'update', 'list', 'read']);

const NAME = '^[a-z][a-z0-9-]{0,63}$';
const TRIGGERS = {
  type: 'array',
  minItems: 1,
  maxItems: 12,
  items: { type: 'string', minLength: 2, maxLength: 80 },
};
const TOOLS = { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 100 } };
/** A skill's whole file is at most 400 tokens, by the skill contract. */
const BODY = { type: 'string', minLength: 1, maxLength: 1400 };

export const skillsManifest: ConnectorManifest = {
  name: 'skills',
  version: '0.1.0',
  provider: SKILLS_PROVIDER,
  description: "The person's own skills: saved ways of doing a task that you follow when asked.",
  credentials: [],
  health: true,
  tools: [
    {
      name: 'skills.list',
      description:
        "List the person's own skills (name, description, triggers) and the names of the built-in ones.",
      input_schema: { type: 'object', additionalProperties: false, properties: {} },
      effect_class: 'read',
      required_scopes: ['skills.list'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'skills.create',
      description:
        'Save a skill for the person when they ask you to make one ("make a skill for my weekly review"): a lowercase-with-dashes name, one line saying what it does, the phrases that bring it up (triggers), and its steps as short Markdown (under about 250 words). From their next message on it comes up whenever a trigger matches. Never put a password, key or token in it.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'triggers', 'body'],
        properties: {
          name: { type: 'string', pattern: NAME },
          description: { type: 'string', minLength: 1, maxLength: 300 },
          triggers: TRIGGERS,
          tools: TOOLS,
          body: BODY,
        },
      },
      effect_class: 'write_reversible',
      required_scopes: ['skills.create'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'skills.update',
      description:
        "Change one of the person's own skills when they ask: give its name and only what changes (description, triggers, tools or body). The words replaced are kept, so the change can be undone.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', pattern: NAME },
          description: { type: 'string', minLength: 1, maxLength: 300 },
          triggers: TRIGGERS,
          tools: TOOLS,
          body: BODY,
        },
      },
      effect_class: 'write_reversible',
      required_scopes: ['skills.update'],
      verify: true,
      requires_approval: false,
    },
  ],
};

export type SkillsConnectorOptions = {
  sql: Sql;
  /** Where the spaces live: a space's skills are `<spacesRoot>/<space id>/skills`. */
  spacesRoot: string;
};

type Definition = {
  name: string;
  description: string;
  triggers: string[];
  tools: string[];
  body: string;
};

/**
 * The file a skill is saved as. Every string is written as a JSON string,
 * which YAML reads as the same double-quoted scalar, so nothing in it can
 * start a key of its own.
 */
export function skillFile(skill: Definition): string {
  const list = (values: string[]) =>
    values.length ? values.map((value) => `\n  - ${JSON.stringify(value)}`).join('') : ' []';
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    `triggers:${list(skill.triggers)}`,
    `tools:${list(skill.tools)}`,
    'max_tokens: 400',
    '---',
    '',
    skill.body.trim(),
    '',
  ].join('\n');
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.map((item) => item.trim()).filter(Boolean)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function createSkillsConnector(options: SkillsConnectorOptions): Connector {
  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });

  /**
   * The person's own work, in their own space; anything else keeps no skills.
   * Read through `query` at admission, which holds the event order lock.
   */
  const ownWork = async (
    ctx: Pick<ConnectorContext, 'job_id' | 'space_id' | 'constraints'>,
    query: Query = options.sql,
  ) => {
    const [row] = await query`select j.audience, j.space_id, s.kind
      from job j join space s on s.id = j.space_id where j.id = ${ctx.job_id}`;
    if (!row || row.space_id !== ctx.space_id || row.audience !== 'principal')
      throw new BrokerFault('scope_denied', "Only a person's own work keeps skills.");
    if (row.kind !== 'personal')
      throw new BrokerFault('scope_denied', 'Skills are kept only in your own space.');
    if (ctx.constraints.public_compartment)
      throw new BrokerFault('scope_denied', 'Skills are not kept from a public conversation.');
  };

  /** The space's skills directory, which must be a real directory, never a link. */
  const directory = async (spaceId: string, create: boolean): Promise<string> => {
    if (!/^sp_[0-9A-Z]{26}$/.test(spaceId)) throw new Error('not a space id');
    const base = await realpath(options.spacesRoot);
    const root = path.join(base, spaceId);
    const skills = path.join(root, 'skills');
    if (create) await mkdir(skills, { recursive: true });
    for (const place of [root, skills]) {
      const stats = await lstat(place).catch(() => null);
      if (stats && !stats.isDirectory())
        throw new BrokerFault('scope_denied', 'The skills folder is not a plain folder.');
    }
    return skills;
  };

  const ownSkills = async (spaceId: string) =>
    loadSpaceSkills(await directory(spaceId, false)).skills;

  /** Check a skill as the loader will read it, or say what is wrong with it. */
  const checked = (skill: Definition): string => {
    if (!skillFrontmatter.shape.name.safeParse(skill.name).success)
      throw new BrokerFault(
        'payload_invalid',
        'A skill name is lowercase letters, digits and dashes.',
      );
    const material = credentialMaterial(
      [skill.name, skill.description, ...skill.triggers, skill.body].join('\n'),
    );
    if (material)
      throw new BrokerFault(
        'payload_invalid',
        'A skill cannot hold a password, key or token. Leave it out; a connected account is used without one.',
      );
    const file = skillFile(skill);
    const parsed = parseSkill(file);
    if (!parsed.ok)
      throw new BrokerFault(
        'payload_invalid',
        `The skill is not one the loader can use: ${parsed.issues.join('; ')}. Make it shorter or simpler.`,
      );
    return file;
  };

  const definitionOf = (payload: JsonObject): Definition => ({
    name: text(payload.name) ?? '',
    description: text(payload.description) ?? '',
    triggers: strings(payload.triggers) ?? [],
    tools: strings(payload.tools) ?? [],
    body: text(payload.body) ?? '',
  });

  /** One skill directory's files, written whole and then moved into place. */
  const save = async (skills: string, name: string, file: string, previous?: string) => {
    const folder = path.join(skills, name);
    await mkdir(folder, { recursive: true });
    const stats = await lstat(folder);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error('the skill folder is not a plain folder');
    if (previous !== undefined) await writeFile(path.join(folder, 'PREVIOUS.md'), previous);
    const temporary = path.join(folder, `.SKILL.md.${process.pid}.${Date.now()}`);
    await writeFile(temporary, file, { flag: 'wx' });
    await rename(temporary, path.join(folder, 'SKILL.md'));
  };

  const fileOf = async (spaceId: string, name: string): Promise<string | null> => {
    const skills = await directory(spaceId, false);
    return readFile(path.join(skills, name, 'SKILL.md'), 'utf8').catch(() => null);
  };

  return {
    manifest: skillsManifest,
    // A new skill stays in the person's own space and replaces nothing.
    staysInSpace: (action) => action.kind === 'skills.create',

    /** Refused at admission, so the model hears why at once and nothing is recorded as tried. */
    async prepare(payload, ctx, tx, kind) {
      if (kind === 'skills.list') return payload;
      await ownWork(ctx, tx);
      if (kind === 'skills.create') {
        const skill = definitionOf(payload);
        checked(skill);
        // A skill is found in discovery as `skills.<name>`, so a name these tools take is not free.
        if (
          (BUILT_IN_SKILLS as readonly string[]).includes(skill.name) ||
          TAKEN_NAMES.has(skill.name)
        )
          throw new BrokerFault(
            'payload_invalid',
            `"${skill.name}" is already taken by a built-in skill or tool. Choose another name.`,
          );
        if ((await ownSkills(ctx.space_id)).some((own) => own.frontmatter.name === skill.name))
          throw new BrokerFault(
            'payload_invalid',
            `The person already has a skill named "${skill.name}". Change it with skills.update, or choose another name.`,
          );
      }
      if (kind === 'skills.update') {
        const name = text(payload.name) ?? '';
        const own = (await ownSkills(ctx.space_id)).find(
          (skill) => skill.frontmatter.name === name,
        );
        if (!own)
          throw new BrokerFault(
            'payload_invalid',
            `The person has no skill of their own named "${name}". skills.list names them.`,
          );
      }
      return payload;
    },

    async execute(action, ctx) {
      if (action.job_id !== ctx.job_id || action.id !== ctx.idempotency_key)
        throw new Error('connector action identity mismatch');
      ctx.signal?.throwIfAborted();
      if (action.kind === 'skills.list') {
        const own = await ownSkills(ctx.space_id).catch(() => []);
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            {
              skills: own.map((skill) => ({
                name: skill.frontmatter.name,
                description: skill.frontmatter.description,
                triggers: skill.frontmatter.triggers,
              })),
              built_in: [...BUILT_IN_SKILLS],
            },
            null,
          ),
        };
      }
      await ownWork(ctx);
      const skills = await directory(ctx.space_id, true);
      if (action.kind === 'skills.create') {
        const skill = definitionOf(action.canonical_payload);
        const file = checked(skill);
        const there = await fileOf(ctx.space_id, skill.name);
        // A retry of this same save finds its own words there and is done.
        if (there !== null && there !== file)
          return {
            outcome: 'failed',
            reason: `The person already has a skill named "${skill.name}"; nothing was replaced.`,
            retryable: false,
          };
        if (there === null) await save(skills, skill.name, file);
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            {
              name: skill.name,
              saved: true,
              note: `Saved as the person's skill "${skill.name}". It is used from their next message on when one of its triggers comes up; they can ask you to change it at any time.`,
            },
            `skills/${skill.name}`,
          ),
        };
      }
      if (action.kind === 'skills.update') {
        const name = text(action.canonical_payload.name) ?? '';
        const own = (await ownSkills(ctx.space_id)).find(
          (skill) => skill.frontmatter.name === name,
        );
        const previous = await fileOf(ctx.space_id, name);
        if (!own || previous === null)
          return {
            outcome: 'failed',
            reason: `The person has no skill of their own named "${name}".`,
            retryable: false,
          };
        const change = definitionOf(action.canonical_payload);
        const file = checked({
          name,
          description: change.description || own.frontmatter.description,
          triggers: change.triggers.length ? change.triggers : own.frontmatter.triggers,
          tools: strings(action.canonical_payload.tools) ?? own.frontmatter.tools,
          body: change.body || own.body,
        });
        if (file !== previous) await save(skills, name, file, previous);
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            {
              name,
              updated: true,
              previous,
              note: `Changed the person's skill "${name}"; the earlier words are kept beside it.`,
            },
            `skills/${name}`,
          ),
        };
      }
      throw new Error('unknown skills tool');
    },

    async verify(action, ctx) {
      const name = text(action.canonical_payload.name) ?? '';
      const there = await fileOf(ctx.space_id, name).catch(() => null);
      if (action.kind === 'skills.create' && there !== null) {
        const expected = skillFile(definitionOf(action.canonical_payload));
        if (there === expected)
          return {
            decision: 'succeeded',
            evidence: { name },
            receipt: receiptFor(action, { name, saved: true }, `skills/${name}`),
          };
      }
      return { decision: 'undecided', reason: 'the skill file does not show this change' };
    },

    async health() {
      return { status: 'ok', detail: 'skills are available', checked_at: new Date().toISOString() };
    },
  };
}
