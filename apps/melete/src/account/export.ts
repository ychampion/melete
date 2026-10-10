/**
 * Everything an account holds, as one zip a person can read without Melete.
 *
 * The archive's README.md says what each part is; in short:
 *
 * - `account.json`: the account, and the spaces in this export.
 * - `spaces/<name>-<id>/` for each space the account owns:
 *   - `chats/`: each chat as Markdown to read and JSON to reuse, every
 *     message with its answer;
 *   - `runs/`: each long piece of work as Markdown;
 *   - `memory.json`: what Melete believes, in the file Memory's own export writes;
 *   - `files/`: the original files, as they are on disk: Files
 *     (`artifacts`), knowledge records, saved sources and skills;
 *   - `records/`: every row Melete keeps for the space, one JSON file per
 *     kind of record (settings, automations, plans, tasks, activity,
 *     memory's own records), with secrets left out.
 * - `account/records/`: rows kept for the account itself rather than a space,
 *   such as notification and memory settings.
 *
 * Secrets never leave: sealed keys and tokens, password and passkey data, and
 * session and link digests are withheld by table and by column, and a column
 * that holds raw bytes or vectors is left out as unreadable.
 *
 * A room the account owns is exported with its room chats and the files of
 * the room's work and the account's own, not the private chats and files
 * members keep there, which are theirs; nor are its records, which hold both.
 * A room someone else owns is theirs to export.
 */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { ZipEntry } from './zip.ts';

export type AccountExportDeps = {
  sql: Sql;
  spacesRoot: string;
  /** A run as Markdown, as its own export writes it. */
  runs?: (spaceId: string, runId: string) => Promise<string>;
  /** Memory as its own export writes it, or null where memory is not in use. */
  memory?: (spaceId: string, principalId: string) => Promise<string | null>;
  now?: () => Date;
};

/** Tables that hold only secrets, digests or sign-in state. */
const WITHHELD_TABLES = new Set([
  'secret',
  'session',
  'password_reset',
  'magic_link',
  'mcp_token',
  'privacy_vault',
  'provider_credential',
]);
/** Columns that hold a secret, a digest of one, or sealed data. */
const WITHHELD_COLUMN =
  /(ciphertext|sealed|secret|password|passkey|token|hash|vault|private_key|api_key|cookie|credential)/i;
/** Column types with nothing a person can read. */
const UNREADABLE_TYPES = new Set(['bytea', 'USER-DEFINED', 'tsvector']);

/** Where a space's content is on disk, and what is not content: the browser's own profile. */
const CONTENT_DIRECTORIES = ['artifacts', 'knowledge', 'raw', 'skills'];

const README = `# Your Melete export

This archive holds everything Melete keeps for your account, in files any
program can open. Nothing in it needs Melete to read.

- account.json: your account, and the spaces in this export.
- spaces/<name>-<id>/: one folder for each space you own.
  - space.json: the space itself.
  - chats/: each chat twice, as Markdown to read and as JSON to reuse. Every
    message you sent is there with Melete's answer to it.
  - runs/: each long piece of work, as Markdown.
  - memory.json: what Melete believes about you, in the same file Memory's
    own export writes, which Memory can import again.
  - files/: your original files as they are stored: files/artifacts is your
    Files, files/knowledge your knowledge records, files/raw the sources
    saved for them, files/skills the skills you made.
  - records/: every record Melete keeps for the space, one JSON file per kind
    (settings, automations, plans, tasks, activity, memory's own records,
    and so on). Each file is a list of rows; each row is a JSON object.
- account/records/: records kept for your account rather than a space, such
  as notification and memory settings.

Left out on purpose: passwords, passkeys, sign-in sessions, and the sealed
keys and tokens of your connections. They are secrets, and they would not
work anywhere else. Columns that only hold raw bytes or search vectors are
left out too.

For a room you own, the room's own chats and files, and yours there, are
here. Chats and files members keep to themselves in your room are theirs, and
are not.
`;

type Table = { name: string; columns: string[]; spaceKeyed: boolean };

/** The tables an export reads, with the columns a person may take with them. */
async function readableTables(sql: Sql): Promise<Table[]> {
  const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select c.table_name, c.column_name, c.data_type
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
    order by c.table_name, c.ordinal_position`;
  const tables = new Map<string, { all: string[]; kept: string[] }>();
  for (const row of rows) {
    const entry = tables.get(row.table_name) ?? { all: [], kept: [] };
    entry.all.push(row.column_name);
    if (!WITHHELD_COLUMN.test(row.column_name) && !UNREADABLE_TYPES.has(row.data_type))
      entry.kept.push(row.column_name);
    tables.set(row.table_name, entry);
  }
  const out: Table[] = [];
  for (const [name, entry] of tables) {
    if (WITHHELD_TABLES.has(name) || name.startsWith('__')) continue;
    const spaceKeyed = entry.all.includes('space_id');
    if (!spaceKeyed && !entry.all.includes('principal_id')) continue;
    if (entry.kept.length) out.push({ name, columns: entry.kept, spaceKeyed });
  }
  return out;
}

/** A time as the database hands it back, a Date or a string, written the one way. */
export const iso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();

/** A folder or file name that reads well and is safe on any system. */
export function slug(text: string, fallback: string): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
  return cleaned || fallback;
}

/** Rows as a JSON list, written as they are read so a large table is never held whole. */
async function* rowsAsJson(rows: AsyncIterable<readonly unknown[]>): AsyncGenerator<string> {
  yield '[';
  let first = true;
  for await (const batch of rows)
    for (const row of batch) {
      yield `${first ? '\n' : ',\n'}${JSON.stringify(row)}`;
      first = false;
    }
  yield first ? ']\n' : '\n]\n';
}

/** Every file under a directory, never following a link out of it. */
async function* filesUnder(root: string, prefix = ''): AsyncGenerator<string> {
  let names: string[];
  try {
    names = (await readdir(join(root, prefix))).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(root, relative)).catch(() => null);
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (name === '.git' || name === '.trash') continue;
      yield* filesUnder(root, relative);
    } else if (stat.isFile()) yield relative;
  }
}

/** Every content file of a space of one's own. */
async function* everyFile(root: string): AsyncGenerator<{ directory: string; relative: string }> {
  for (const directory of CONTENT_DIRECTORIES)
    for await (const relative of filesUnder(join(root, directory))) yield { directory, relative };
}

/**
 * The files of a room the account owns that it may take: those its Files list
 * records for the room's own work, or for the account's own. A member's
 * private work there is theirs, and so is a file whose work is gone and can no
 * longer say whose it was. Only plain files inside the room's `artifacts`
 * folder are read, never through a link.
 */
async function* roomFiles(
  sql: Sql,
  root: string,
  spaceId: string,
  principalId: string,
): AsyncGenerator<{ directory: string; relative: string }> {
  const rows = await sql<{ path: string }[]>`select distinct a.path from artifact a
    join job j on j.id = coalesce(a.job_id, a.source_job_id)
    where a.space_id = ${spaceId} and a.area = 'artifacts' and j.space_id = ${spaceId}
      and (j.audience = 'room'
        or coalesce(j.principal_id, (select id from owner limit 1)) = ${principalId})
    order by a.path`;
  const folder = await realpath(join(root, 'artifacts')).catch(() => null);
  if (!folder) return;
  for (const row of rows) {
    const relative = row.path.replace(/^artifacts\//, '');
    const parts = relative.split('/');
    if (
      !relative ||
      parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
    )
      continue;
    const real = await realpath(join(folder, ...parts)).catch(() => null);
    if (real !== join(folder, ...parts)) continue;
    yield { directory: 'artifacts', relative: parts.join('/') };
  }
}

/** Already compressed, so storing it as it is costs nothing. */
const COMPRESSED =
  /\.(png|jpe?g|gif|webp|heic|avif|mp3|m4a|aac|ogg|opus|mp4|mov|webm|zip|gz|xz|7z|pdf|docx|xlsx|pptx)$/i;

function chatMarkdown(
  chat: { title: string; created_at: unknown },
  turns: readonly { text: string; answer: string; created_at: unknown; author: string | null }[],
): string {
  const lines = [`# ${chat.title}`, '', `Started ${iso(chat.created_at)}`, ''];
  for (const turn of turns) {
    lines.push(`## ${turn.author ?? 'You'}, ${iso(turn.created_at)}`, '', turn.text, '');
    if (turn.answer.trim()) lines.push('### Melete', '', turn.answer, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The spaces an account owns and can still open. */
export async function ownedSpaces(sql: Sql, principalId: string) {
  return sql<{ id: string; name: string; kind: string; created_at: string }[]>`
    select s.id, s.name, s.kind, s.created_at from space s
    where s.removed_at is null and (
      (s.kind = 'personal'
        and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
      or exists (select 1 from space_membership m where m.space_id = s.id
        and m.principal_id = ${principalId} and m.role = 'owner' and m.revoked_at is null))
    order by s.created_at, s.id`;
}

/** The entries of an account's export, read one at a time as the archive is written. */
export async function* accountExport(
  deps: AccountExportDeps,
  principalId: string,
): AsyncGenerator<ZipEntry> {
  const { sql } = deps;
  const now = deps.now?.() ?? new Date();
  const [account] = await sql<
    { id: string; email: string; display_name: string | null; kind: string; created_at: string }[]
  >`select id, email, display_name, kind, created_at from principal where id = ${principalId}`;
  if (!account) return;
  const spaces = await ownedSpaces(sql, principalId);
  const folders = new Map(
    spaces.map((space) => [space.id, `spaces/${slug(space.name, 'space')}-${space.id}`]),
  );
  yield { name: 'README.md', data: README, modified: now };
  yield {
    name: 'account.json',
    modified: now,
    data: `${JSON.stringify(
      {
        exported_at: now.toISOString(),
        account,
        spaces: spaces.map((space) => ({ ...space, folder: folders.get(space.id) })),
      },
      null,
      2,
    )}\n`,
  };
  const tables = await readableTables(sql);
  const withheld: string[] = [];
  for (const space of spaces) {
    const folder = folders.get(space.id) ?? `spaces/${space.id}`;
    const personal = space.kind === 'personal';
    const [row] = await sql`select id, name, kind, audience, purpose, created_at
      from space where id = ${space.id}`;
    yield {
      name: `${folder}/space.json`,
      modified: now,
      data: `${JSON.stringify(row, null, 2)}\n`,
    };

    // In a room, the room's own work and the account's own; in a space of
    // one's own, all of it.
    const jobs = await sql<
      { id: string; kind: string; title: string; created_at: string; state: string }[]
    >`select id, kind, title, created_at, state from job
      where space_id = ${space.id} and kind in ('chat', 'run')
        and (${personal}::boolean or audience = 'room'
          or coalesce(principal_id, (select id from owner limit 1)) = ${principalId})
      order by created_at, id`;
    for (const chat of jobs.filter((entry) => entry.kind === 'chat')) {
      const turns = await sql<
        {
          id: string;
          text: string;
          answer: string;
          status: string;
          created_at: string;
          finished_at: Date | null;
          author_principal_id: string | null;
          author: string | null;
        }[]
      >`select t.id, t.text, t.answer, t.status, t.created_at, t.finished_at,
          t.author_principal_id,
          case when t.author_principal_id is null or t.author_principal_id = ${principalId} then null
            else coalesce(p.display_name, split_part(p.email, '@', 1)) end as author
        from experience_turn t left join principal p on p.id = t.author_principal_id
        where t.job_id = ${chat.id} order by t.created_at, t.id`;
      const base = `${folder}/chats/${iso(chat.created_at).slice(0, 10)}-${slug(chat.title, 'chat')}-${chat.id}`;
      const started = new Date(iso(chat.created_at));
      yield { name: `${base}.md`, modified: started, data: chatMarkdown(chat, turns) };
      yield {
        name: `${base}.json`,
        modified: started,
        data: `${JSON.stringify(
          {
            ...chat,
            messages: turns.map(({ author, ...turn }) => ({
              ...turn,
              from: author ?? 'you',
            })),
          },
          null,
          2,
        )}\n`,
      };
    }
    const runs = deps.runs;
    if (runs)
      for (const run of jobs.filter((entry) => entry.kind === 'run')) {
        const markdown = await runs(space.id, run.id).catch(
          () => `# ${run.title}\n\nThis run could not be written out.\n`,
        );
        yield {
          name: `${folder}/runs/${iso(run.created_at).slice(0, 10)}-${slug(run.title, 'run')}-${run.id}.md`,
          modified: new Date(iso(run.created_at)),
          data: markdown,
        };
      }
    if (deps.memory) {
      const memory = await deps.memory(space.id, principalId).catch(() => null);
      if (memory) yield { name: `${folder}/memory.json`, modified: now, data: memory };
    }

    const root = join(deps.spacesRoot, space.id);
    // A space of one's own: every file in it. A room: only the files of the
    // room's own work and the account's own, never a member's private files.
    const files: AsyncIterable<{ directory: string; relative: string }> = personal
      ? everyFile(root)
      : roomFiles(sql, root, space.id, principalId);
    for await (const { directory, relative } of files) {
      const path = join(root, directory, relative);
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile()) continue;
      yield {
        name: `${folder}/files/${directory}/${relative}`,
        modified: stat.mtime,
        store: COMPRESSED.test(relative),
        data: Bun.file(path).stream(),
      };
    }

    // A room holds its members' private work too, which is theirs: its rows
    // are not the owner's to take.
    if (!personal) continue;
    for (const table of tables.filter((entry) => entry.spaceKeyed)) {
      const rows = await tryRows(sql, table, 'space_id', space.id);
      if (rows === 'denied') withheld.push(table.name);
      else if (rows !== 'empty')
        yield { name: `${folder}/records/${table.name}.json`, modified: now, data: rows };
    }
  }
  for (const table of tables.filter((entry) => !entry.spaceKeyed)) {
    const rows = await tryRows(sql, table, 'principal_id', principalId);
    if (rows === 'denied') withheld.push(table.name);
    else if (rows !== 'empty')
      yield { name: `account/records/${table.name}.json`, modified: now, data: rows };
  }
  if (withheld.length)
    yield {
      name: 'not-included.json',
      modified: now,
      data: `${JSON.stringify(
        {
          note: 'Melete could not read these kinds of record for the export.',
          records: [...new Set(withheld)].sort(),
        },
        null,
        2,
      )}\n`,
    };
}

/**
 * A table's rows for one key; `empty` when it has none, so the archive is not
 * a folder of empty lists, and `denied` when this database role may not read
 * the table.
 */
async function tryRows(
  sql: Sql,
  table: Table,
  key: 'space_id' | 'principal_id',
  value: string,
): Promise<AsyncGenerator<string> | 'empty' | 'denied'> {
  try {
    const [any] = await sql`select 1 as present from ${sql(table.name)}
      where ${sql(key)} = ${value} limit 1`;
    if (!any) return 'empty';
  } catch {
    return 'denied';
  }
  const ordered = table.columns.includes('id') ? sql`order by id` : sql``;
  const cursor = sql`select ${sql(table.columns)} from ${sql(table.name)}
    where ${sql(key)} = ${value} ${ordered}`.cursor(200);
  return rowsAsJson(cursor);
}
