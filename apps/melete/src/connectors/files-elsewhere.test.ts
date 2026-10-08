/**
 * A file the agent saved in one conversation can be found from the next one:
 * the artifacts area lists what was saved in the person's other conversations
 * in the same space, and reads it back, and never another person's.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalizePayload, jobConstraints } from '@melete/contracts';
import { testDatabase } from '../../test/helpers/database.ts';
import { recordId } from '../broker/records.ts';
import { createFilesConnector, FROM_CHATS } from './files.ts';
import { connectorAction } from './test-fixtures.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  if (handle) await handle.sql`truncate "owner", principal, space cascade`;
});
afterAll(async () => handle?.close());

withDb('files saved in other conversations', () => {
  const setup = async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const root = await mkdtemp(path.join(tmpdir(), 'melete-files-elsewhere-'));
    const workRoot = path.join(root, 'work');
    const spacesRoot = path.join(root, 'spaces');
    await mkdir(spacesRoot, { recursive: true });
    const spaceId = recordId('sp');
    const ownerId = recordId('own');
    const strangerId = recordId('own');
    await sql`insert into "owner" (id, email) values (${ownerId}, 'me@example.test')`;
    await sql`insert into principal (id, email) values (${ownerId}, 'me@example.test'),
      (${strangerId}, 'someone@example.test')`;
    await sql`insert into space (id, name, git_path) values (${spaceId}, 'Home', ${`/spaces/${spaceId}`})`;
    const connectionId = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label)
      values (${connectionId}, ${spaceId}, 'files', 'Files')`;
    const chat = async (title: string, principal: string | null, agentId: string | null = null) => {
      const id = recordId('job');
      await sql`insert into job (id, space_id, title, objective, principal_id, agent_id)
        values (${id}, ${spaceId}, ${title}, 'Chat', ${principal}, ${agentId})`;
      await mkdir(path.join(workRoot, id), { recursive: true });
      return id;
    };
    /** A file written in a conversation, recorded the way the broker records it. */
    const written = async (jobId: string, file: string, content: string) => {
      await writeFile(path.join(workRoot, jobId, file), content);
      const id = recordId('act');
      const payload = { path: file, content };
      const attemptId = recordId('att');
      await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
      await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status, resolved_at)
        values (${id}, ${jobId}, ${attemptId}, ${connectionId}, 'files.write', 'write_reversible',
          ${JSON.stringify(canonicalizePayload(payload).canonical)}::jsonb, ${canonicalizePayload(payload).hash},
          ${id}, 'succeeded', now())`;
      return id;
    };
    /** A file a command produced in a conversation's workspace, recorded as an artifact. */
    const produced = async (jobId: string, file: string, content: string) => {
      await writeFile(path.join(workRoot, jobId, file), content);
      const id = recordId('art');
      await sql`insert into artifact (id, space_id, job_id, source_job_id, area, path, kind,
          content_hash, mime, size)
        values (${id}, ${spaceId}, ${jobId}, ${jobId}, 'work', ${file}, 'markdown',
          ${digest(content)}, 'text/markdown', ${Buffer.byteLength(content)})`;
      return id;
    };
    /** The agents the person marked private, as the privacy settings say. */
    const privateAgents = new Set<string>();
    const connector = createFilesConnector({
      workRoot,
      spacesRoot,
      sql,
      privateContext: async ({ agentId }) => agentId !== null && privateAgents.has(agentId),
    });
    const call = async (jobId: string, kind: string, payload: Record<string, unknown>) => {
      const action = { ...connectorAction(kind, payload, recordId('act')), job_id: jobId };
      const result = await connector.execute(action, {
        job_id: jobId,
        space_id: spaceId,
        idempotency_key: action.id,
        constraints: jobConstraints.parse({}),
      });
      if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
      return result.receipt.detail as Record<string, unknown>;
    };
    const agent = async (name: string) => {
      const id = recordId('agt');
      await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
          standing_instruction)
        values (${id}, ${spaceId}, ${name}, 'Helper', 'blue', 'plain', 'dark', 'warm', '')`;
      return id;
    };
    /** A conversation the privacy check found to be about a sensitive topic. */
    const sensitive = async (jobId: string) => {
      await sql`insert into privacy_conversation (conversation_id, space_id, sensitive)
        values (${jobId}, ${spaceId}, 'health')`;
    };
    return {
      chat,
      written,
      produced,
      call,
      ownerId,
      strangerId,
      agent,
      sensitive,
      privateAgents,
      sql,
      spaceId,
      workRoot,
      spacesRoot,
    };
  };

  test('a new conversation lists and reads what earlier conversations saved', async () => {
    const { chat, written, produced, call, ownerId, strangerId } = await setup();
    const research = await chat('Heat pump research', ownerId);
    const approvals = await chat('Approval test', null);
    const theirs = await chat('Their private notes', strangerId);
    const now = await chat('List my files', ownerId);
    const report = await produced(research, 'heat-pumps-report.md', '# Heat pumps\n');
    const note = await written(approvals, 'approve-test.txt', 'approved');
    await written(theirs, 'diary.txt', 'not yours');

    const root = await call(now, 'files.list', { path: '.', area: 'artifacts' });
    expect(root.entries).toEqual([{ name: FROM_CHATS, kind: 'directory' }]);

    const listed = await call(now, 'files.list', { path: FROM_CHATS, area: 'artifacts' });
    const entries = listed.entries as Array<{ name: string; chat: string }>;
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [`${note}/approve-test.txt`, `${report}/heat-pumps-report.md`].sort(),
    );
    expect(entries.find((entry) => entry.name.endsWith('report.md'))?.chat).toBe(
      'Heat pump research',
    );
    // Another person's conversation is not the person's to read.
    expect(JSON.stringify(listed)).not.toContain('diary.txt');

    const read = await call(now, 'files.read', {
      path: `${FROM_CHATS}/${report}/heat-pumps-report.md`,
      area: 'artifacts',
    });
    expect(read).toMatchObject({ content: '# Heat pumps\n', chat: 'Heat pump research' });
  });

  test("another person's saved file cannot be read by naming it", async () => {
    const { chat, written, call, ownerId, strangerId } = await setup();
    const theirs = await chat('Their private notes', strangerId);
    const now = await chat('List my files', ownerId);
    const diary = await written(theirs, 'diary.txt', 'not yours');
    let said = 'resolved';
    try {
      await call(now, 'files.read', {
        path: `${FROM_CHATS}/${diary}/diary.txt`,
        area: 'artifacts',
      });
    } catch (error) {
      said = String(error);
    }
    expect(said).toContain('there is no file');
  });

  test('a file saved in a private or sensitive conversation stays out of an ordinary one', async () => {
    const { chat, written, produced, call, ownerId, agent, sensitive, privateAgents } =
      await setup();
    const diary = await agent('Diary');
    privateAgents.add(diary);
    const health = await chat('Test results', ownerId);
    await sensitive(health);
    const journal = await chat('Journal', ownerId, diary);
    const open = await chat('Heat pump research', ownerId);
    const now = await chat('List my files', ownerId);
    const results = await written(health, 'results.txt', 'biopsy results');
    const entry = await produced(journal, 'entry.md', '# Dear diary\n');
    const report = await written(open, 'report.txt', 'heat pumps');

    const listed = await call(now, 'files.list', { path: FROM_CHATS, area: 'artifacts' });
    const names = (listed.entries as Array<{ name: string }>).map((item) => item.name);
    expect(names).toEqual([`${report}/report.txt`]);
    for (const [id, file] of [
      [results, 'results.txt'],
      [entry, 'entry.md'],
    ]) {
      let said = 'resolved';
      try {
        await call(now, 'files.read', { path: `${FROM_CHATS}/${id}/${file}`, area: 'artifacts' });
      } catch (error) {
        said = String(error);
      }
      expect(said).toContain('there is no file');
    }

    // A private conversation already keeps to the person's own model: it may read them.
    const quiet = await chat('Private follow-up', ownerId, diary);
    const fromPrivate = await call(quiet, 'files.list', { path: FROM_CHATS, area: 'artifacts' });
    expect(
      (fromPrivate.entries as Array<{ name: string }>).map((item) => item.name).sort(),
    ).toEqual([`${entry}/entry.md`, `${report}/report.txt`, `${results}/results.txt`].sort());
  });

  test('a conversation the person said is not sensitive is offered again', async () => {
    const { chat, written, call, ownerId, sql, spaceId } = await setup();
    const earlier = await chat('Addiction research', ownerId);
    await sql`insert into privacy_conversation (conversation_id, space_id, sensitive)
      values (${earlier}, ${spaceId}, 'none')`;
    const now = await chat('Now', ownerId);
    const note = await written(earlier, 'sources.txt', 'reading list');
    const listed = await call(now, 'files.list', { path: FROM_CHATS, area: 'artifacts' });
    expect((listed.entries as Array<{ name: string }>).map((item) => item.name)).toEqual([
      `${note}/sources.txt`,
    ]);
  });

  test('without a privacy check no other conversation is offered', async () => {
    const { chat, written, ownerId, sql, spaceId, workRoot, spacesRoot } = await setup();
    const earlier = await chat('Earlier', ownerId);
    const now = await chat('Now', ownerId);
    await written(earlier, 'note.txt', 'hello');
    const unchecked = createFilesConnector({ workRoot, spacesRoot, sql });
    const action = {
      ...connectorAction('files.list', { path: '.', area: 'artifacts' }, recordId('act')),
      job_id: now,
    };
    const result = await unchecked.execute(action, {
      job_id: now,
      space_id: spaceId,
      idempotency_key: action.id,
      constraints: jobConstraints.parse({}),
    });
    expect(result.outcome).toBe('succeeded');
    expect(JSON.stringify(result)).not.toContain(FROM_CHATS);
  });

  test("a file a deleted chat saved to the person's Files is deleted there, and the agent is told where", async () => {
    const { chat, call, ownerId, sql, spaceId, spacesRoot, workRoot } = await setup();
    const now = await chat('Tidy up', ownerId);
    await mkdir(path.join(spacesRoot, spaceId, 'artifacts'), { recursive: true });
    await writeFile(path.join(spacesRoot, spaceId, 'artifacts', 'o-test-note.txt'), 'note');
    // As a deleted chat leaves it: no job, in the person's Files.
    const id = recordId('art');
    await sql`insert into artifact (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
      values (${id}, ${spaceId}, null, null, 'artifacts', 'o-test-note.txt', ${digest('note')}, 'text/plain', 4)`;
    const listed = await call(now, 'files.list', { path: FROM_CHATS, area: 'artifacts' });
    expect(JSON.stringify(listed)).toContain(`${id}/o-test-note.txt`);
    const files = createFilesConnector({
      workRoot,
      spacesRoot,
      sql,
      privateContext: async () => false,
    });
    let said = 'resolved';
    try {
      await files.prepare?.(
        { path: `${FROM_CHATS}/${id}/o-test-note.txt`, area: 'artifacts' },
        {
          job_id: now,
          space_id: spaceId,
          idempotency_key: '',
          constraints: jobConstraints.parse({}),
        },
        sql,
        'files.delete',
      );
    } catch (error) {
      said = String(error);
    }
    expect(said).toContain("in the person's Files");
    expect(said).toContain('o-test-note.txt');
  });
});
