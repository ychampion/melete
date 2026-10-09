/**
 * The built-in `skills` connection: the person's own skills. A skill is a
 * short Markdown file with triggers (`SKILL.md`, the format the built-in
 * skills use), kept in the space's `skills/` directory, which the skill loader
 * reads at the start of every attempt. So a skill made here is used from the
 * next message on, whenever its triggers match, and every later attempt can
 * read it by name.
 *
 * The tools:
 * - `skills.list` names the person's own skills and the built-in ones.
 * - `skills.create` saves a new one. It stays in the person's own space and
 *   changes nothing outside it, so it asks no one; a name already in use is
 *   refused, never replaced.
 * - `skills.update` rewrites one of the person's own skills. The words it
 *   replaces are kept beside it (`PREVIOUS.md`) and in the receipt, so the
 *   change can be undone.
 * - `skills.delete` moves one of the person's own skills into the space's
 *   trash, the same trash the Files connection deletes into. It stays in their
 *   space and Undo puts it back (`skills.restore`), so it asks no one.
 *
 * Only a person's own work in their personal space keeps skills, and a skill
 * that carries a password, key or token is refused: it is read into every
 * attempt it matches.
 */
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
import {
  DEFAULT_TRASH_DAYS,
  hasTrash,
  moveToTrash,
  restoreFromTrash,
  TRASH_DIRECTORY,
  type TrashPlace,
} from './files-trash.ts';
import type { Connector, ConnectorContext } from './types.ts';

export const SKILLS_PROVIDER = 'skills';

/** Names of the `skills.` tools themselves, and the broker's `skills.read`. */
const TAKEN_NAMES = new Set(['create', 'update', 'delete', 'restore', 'list', 'read']);
const TRASH_ID = '^del_[0-9]{13}_[0-9a-f]{12}$';

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
    {
      name: 'skills.delete',
      description:
        "Delete one of the person's own skills when they ask, including one you made for them: give its name. It goes to the trash, so Undo or skills.restore puts it back.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', pattern: NAME } },
      },
      effect_class: 'write_reversible',
      required_scopes: ['skills.delete'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'skills.restore',
      description:
        'Put back a skill skills.delete moved to the trash, by the trash_id its receipt gave. It never replaces a skill that took the name since.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['trash_id'],
        properties: { trash_id: { type: 'string', pattern: TRASH_ID } },
      },
      effect_class: 'write_reversible',
      required_scopes: ['skills.restore'],
      verify: false,
      requires_approval: false,
    },
  ],
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

/** The space's skills directory, which must be a real directory, never a link. */
export async function skillsDirectory(
  spacesRoot: string,
  spaceId: string,
  create: boolean,
): Promise<string> {
  if (!/^sp_[0-9A-Z]{26}$/.test(spaceId)) throw new Error('not a space id');
  const base = await realpath(spacesRoot);
  const root = path.join(base, spaceId);
  const skills = path.join(root, 'skills');
  if (create) await mkdir(skills, { recursive: true });
  for (const place of [root, skills]) {
    const stats = await lstat(place).catch(() => null);
    if (stats && !stats.isDirectory())
      throw new BrokerFault('scope_denied', 'The skills folder is not a plain folder.');
  }
  return skills;
}

/** Check a skill as the loader will read it, and give back its file, or say what is wrong with it. */
export function checkedSkillFile(skill: Definition): string {
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
}

/** One skill directory's files, written whole and then moved into place. */
async function saveSkill(skills: string, folderName: string, file: string, previous?: string) {
  const folder = path.join(skills, folderName);
  await mkdir(folder, { recursive: true });
  const stats = await lstat(folder);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('the skill folder is not a plain folder');
  if (previous !== undefined) await writeFile(path.join(folder, 'PREVIOUS.md'), previous);
  const temporary = path.join(folder, `.SKILL.md.${process.pid}.${Date.now()}`);
  await writeFile(temporary, file, { flag: 'wx' });
  await rename(temporary, path.join(folder, 'SKILL.md'));
}

/** One of the person's own skills as it is on disk now. */
export type OwnSkill = Definition & {
  /** The file's sha256: a change from the page names the version the person was shown. */
  version: string;
  updated_at: string;
  /** Its place under `skills/`: its own folder, or its file when it is a single file. */
  entry: string;
  folder: boolean;
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** The person's own skills in one space, by name. A file the loader cannot read is left out. */
export async function readOwnSkills(spacesRoot: string, spaceId: string): Promise<OwnSkill[]> {
  const skills = await skillsDirectory(spacesRoot, spaceId, false);
  const found: OwnSkill[] = [];
  for (const skill of loadSpaceSkills(skills).skills) {
    const parts = path.relative(skills, skill.path).split(path.sep);
    const folder = parts.length === 2 && parts[1] === 'SKILL.md';
    const file = await readFile(skill.path, 'utf8').catch(() => null);
    const info = await stat(skill.path).catch(() => null);
    if (file === null || !info) continue;
    found.push({
      name: skill.frontmatter.name,
      description: skill.frontmatter.description,
      triggers: [...skill.frontmatter.triggers],
      tools: [...skill.frontmatter.tools],
      body: skill.body.trim(),
      version: digest(file),
      updated_at: info.mtime.toISOString(),
      entry: folder ? (parts[0] as string) : parts.join('/'),
      folder,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rewrite one of the person's own skills from what changed. A folder keeps the
 * words it replaces beside it (`PREVIOUS.md`); a single-file skill is written
 * whole and moved into place.
 */
export async function rewriteOwnSkill(
  spacesRoot: string,
  spaceId: string,
  own: OwnSkill,
  change: { description?: string; triggers?: string[]; body?: string },
): Promise<void> {
  const skills = await skillsDirectory(spacesRoot, spaceId, true);
  const file = checkedSkillFile({
    name: own.name,
    description: change.description?.trim() || own.description,
    triggers: change.triggers?.length ? change.triggers : own.triggers,
    tools: own.tools,
    body: change.body?.trim() || own.body,
  });
  const where = path.join(skills, own.entry);
  const previous = await readFile(own.folder ? path.join(where, 'SKILL.md') : where, 'utf8');
  if (file === previous) return;
  if (own.folder) {
    await saveSkill(skills, own.entry, file, previous);
    return;
  }
  const stats = await lstat(where);
  if (!stats.isFile()) throw new Error('the skill file is not a plain file');
  const temporary = path.join(
    path.dirname(where),
    `.${path.basename(where)}.${process.pid}.${Date.now()}`,
  );
  await writeFile(temporary, file, { flag: 'wx' });
  await rename(temporary, where);
}

/** Take one of the person's own skills off disk, as the person asked from the page. */
export async function removeOwnSkill(spacesRoot: string, spaceId: string, own: OwnSkill) {
  const skills = await skillsDirectory(spacesRoot, spaceId, false);
  const where = path.join(skills, own.entry);
  const stats = await lstat(where);
  if (stats.isSymbolicLink() || (own.folder ? !stats.isDirectory() : !stats.isFile()))
    throw new BrokerFault('scope_denied', 'The skill is not a plain file or folder.');
  await rm(where, { recursive: own.folder });
}

/** Where a delete puts a skill: the space's trash, beside the Files connection's. */
const skillTrash = (base: string, spaceId: string, jobId: string): TrashPlace => ({
  area: 'skills',
  base,
  origin: [spaceId, 'skills'],
  trash: [spaceId, TRASH_DIRECTORY, jobId],
});

/** Every file and folder under a skill's folder, as paths under `skills/`; a link moves as a link. */
async function contentsOf(skills: string, entry: string) {
  const files: string[] = [];
  const folders: string[] = [entry];
  const walk = async (relative: string) => {
    for (const item of await readdir(path.join(skills, relative), { withFileTypes: true })) {
      const inner = `${relative}/${item.name}`;
      if (item.isDirectory() && !item.isSymbolicLink()) {
        folders.push(inner);
        await walk(inner);
      } else files.push(inner);
    }
  };
  await walk(entry);
  return { files, folders };
}

export type SkillsConnectorOptions = {
  sql: Sql;
  /** Where the spaces live: a space's skills are `<spacesRoot>/<space id>/skills`. */
  spacesRoot: string;
  /** How many days a deleted skill stays in the trash (`MELETE_TRASH_DAYS`). */
  trashDays?: number;
};

export function createSkillsConnector(options: SkillsConnectorOptions): Connector {
  const trashDays = options.trashDays ?? DEFAULT_TRASH_DAYS;
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

  const directory = (spaceId: string, create: boolean) =>
    skillsDirectory(options.spacesRoot, spaceId, create);

  const ownSkills = async (spaceId: string) =>
    loadSpaceSkills(await directory(spaceId, false)).skills;

  const definitionOf = (payload: JsonObject): Definition => ({
    name: text(payload.name) ?? '',
    description: text(payload.description) ?? '',
    triggers: strings(payload.triggers) ?? [],
    tools: strings(payload.tools) ?? [],
    body: text(payload.body) ?? '',
  });

  const fileOf = async (spaceId: string, name: string): Promise<string | null> => {
    const skills = await directory(spaceId, false);
    return readFile(path.join(skills, name, 'SKILL.md'), 'utf8').catch(() => null);
  };

  const trashPlace = async (spaceId: string, jobId: string) =>
    skillTrash(await realpath(options.spacesRoot), spaceId, jobId);

  return {
    manifest: skillsManifest,
    // A skill made, deleted into the trash or put back stays in the person's own space.
    staysInSpace: (action) =>
      action.kind === 'skills.create' ||
      action.kind === 'skills.delete' ||
      action.kind === 'skills.restore',

    /** Refused at admission, so the model hears why at once and nothing is recorded as tried. */
    async prepare(payload, ctx, tx, kind) {
      if (kind === 'skills.list') return payload;
      await ownWork(ctx, tx);
      if (kind === 'skills.create') {
        const skill = definitionOf(payload);
        checkedSkillFile(skill);
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
      if (kind === 'skills.update' || kind === 'skills.delete') {
        const name = text(payload.name) ?? '';
        const own = (await ownSkills(ctx.space_id)).find(
          (skill) => skill.frontmatter.name === name,
        );
        if (!own)
          throw new BrokerFault(
            'payload_invalid',
            (BUILT_IN_SKILLS as readonly string[]).includes(name)
              ? `"${name}" is a built-in skill, which cannot be changed or deleted.`
              : `The person has no skill of their own named "${name}". skills.list names them.`,
          );
      }
      if (kind === 'skills.restore' && !new RegExp(TRASH_ID).test(String(payload.trash_id ?? '')))
        throw new BrokerFault('payload_invalid', 'Give the trash_id the delete returned.');
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
        const file = checkedSkillFile(skill);
        const there = await fileOf(ctx.space_id, skill.name);
        // A retry of this same save finds its own words there and is done.
        if (there !== null && there !== file)
          return {
            outcome: 'failed',
            reason: `The person already has a skill named "${skill.name}"; nothing was replaced.`,
            retryable: false,
          };
        if (there === null) await saveSkill(skills, skill.name, file);
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            {
              name: skill.name,
              saved: true,
              note: `Saved as the person's skill "${skill.name}". It is used from their next message on when one of its triggers comes up; they can ask you to change or delete it at any time.`,
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
        const file = checkedSkillFile({
          name,
          description: change.description || own.frontmatter.description,
          triggers: change.triggers.length ? change.triggers : own.frontmatter.triggers,
          tools: strings(action.canonical_payload.tools) ?? own.frontmatter.tools,
          body: change.body || own.body,
        });
        if (file !== previous) await saveSkill(skills, name, file, previous);
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
      if (action.kind === 'skills.delete') {
        const name = text(action.canonical_payload.name) ?? '';
        const own = (await readOwnSkills(options.spacesRoot, ctx.space_id)).find(
          (skill) => skill.name === name,
        );
        if (!own)
          return {
            outcome: 'failed',
            reason: `The person has no skill of their own named "${name}"; nothing was deleted.`,
            retryable: false,
          };
        const { files, folders } = own.folder
          ? await contentsOf(skills, own.entry)
          : { files: [own.entry], folders: [] };
        const trashed = await moveToTrash(
          await trashPlace(ctx.space_id, ctx.job_id),
          files.map((file) => ({ path: file, hash: null })),
          { days: trashDays, folders },
        );
        if (!trashed.trash_id)
          return {
            outcome: 'failed',
            reason: `The skill "${name}" could not be moved to the trash${trashed.kept[0] ? `: ${trashed.kept[0].reason}` : ''}.`,
            retryable: false,
          };
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            {
              name,
              deleted: true,
              trash_id: trashed.trash_id,
              restorable_until: trashed.restorable_until,
              ...(trashed.kept.length ? { kept: trashed.kept.slice(0, 5) } : {}),
              note: `Deleted the person's skill "${name}"; it is no longer used. It stays in the trash until ${trashed.restorable_until.slice(0, 10)}, and skills.restore with trash_id ${trashed.trash_id} puts it back.`,
            },
            `skills/${name}`,
          ),
        };
      }
      if (action.kind === 'skills.restore') {
        const id = String(action.canonical_payload.trash_id ?? '');
        // This conversation's own trash, or, for the person's Undo from a
        // receipt, the trash of the conversation the delete came from.
        const [row] =
          await options.sql`select experience_parent_id from job where id = ${ctx.job_id}`;
        let place: TrashPlace | null = null;
        for (const job of [ctx.job_id, row?.experience_parent_id].filter(
          (value): value is string => typeof value === 'string',
        )) {
          const candidate = await trashPlace(ctx.space_id, job);
          if (await hasTrash(candidate, id)) {
            place = candidate;
            break;
          }
        }
        if (!place)
          return {
            outcome: 'failed',
            reason: 'Nothing this conversation deleted is in the trash under that id.',
            retryable: false,
          };
        const back = await restoreFromTrash(place, id);
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            {
              trash_id: id,
              restored_count: back.restored.length,
              ...(back.kept.length ? { kept: back.kept.slice(0, 5) } : {}),
              note: back.kept.length
                ? 'Part of the skill could not be put back; what stayed in the trash is listed.'
                : 'Put the skill back; it is used again from the next message on.',
            },
            null,
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
