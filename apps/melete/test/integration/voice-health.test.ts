/**
 * Voice is offered only while its speech connections work: the space's own
 * Voice and Voice to text rows, as their last check left them. A call that
 * works sets them back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { mountVoice, speechHealthFrom, type VoiceAllowance } from '../../src/api/voice.ts';
import { fakeTranscriptionAdapter } from '../../src/connectors/transcribe.ts';
import { silentWav } from '../../src/connectors/wav.ts';
import { connection, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
afterAll(async () => {
  await handle?.close();
}, 30_000);
const withDb = handle ? describe : describe.skip;

withDb('speech health as voice reads it', () => {
  test('a failing row turns off what it serves, in its own space only', async () => {
    if (!handle) return;
    const here = newId('sp');
    const there = newId('sp');
    await handle.db.insert(space).values([
      { id: here, name: 'Personal', gitPath: `/spaces/${here}` },
      { id: there, name: 'Personal', gitPath: `/spaces/${there}` },
    ]);
    const speech = newId('conn');
    const words = newId('conn');
    await handle.db.insert(connection).values([
      {
        id: speech,
        spaceId: here,
        provider: 'generation',
        label: 'Voice',
        scopes: ['audio.synthesize'],
        configuration: { builtin: 'generation' },
      },
      {
        id: words,
        spaceId: here,
        provider: 'generation',
        label: 'Voice to text',
        scopes: ['audio.transcribe'],
        configuration: { builtin: 'transcription' },
      },
    ]);
    const started = new Date(Date.now() - 1000);
    const health = speechHealthFrom(handle.db, started);
    expect(await health(here)).toEqual({ speech: true, transcription: true });

    // A refused key leaves both failing; a passing Test sets each back.
    await handle.db
      .update(connection)
      .set({ health: 'failing', lastCheckedAt: new Date() })
      .where(eq(connection.id, speech));
    expect(await health(here)).toEqual({ speech: false, transcription: true });
    await handle.db
      .update(connection)
      .set({ health: 'failing', lastCheckedAt: new Date() })
      .where(eq(connection.id, words));
    expect(await health(here)).toEqual({ speech: false, transcription: false });
    // Another space's rows say nothing about this one.
    expect(await health(there)).toEqual({ speech: true, transcription: true });
    // The key is read at start: a refusal recorded before this start says
    // nothing about the key in use now, so a replaced key brings voice back.
    const restarted = speechHealthFrom(handle.db, new Date(Date.now() + 60_000));
    expect(await restarted(here)).toEqual({ speech: true, transcription: true });
    // A removed row is not a failing one.
    await handle.db.update(connection).set({ status: 'revoked' }).where(eq(connection.id, speech));
    expect((await health(here)).speech).toBe(true);
  });

  test('a transcription that works sets the failing Voice to text rows back to working', async () => {
    if (!handle) return;
    const db = handle.db;
    const here = newId('sp');
    const there = newId('sp');
    await db.insert(space).values([
      { id: here, name: 'Personal', gitPath: `/spaces/${here}` },
      { id: there, name: 'Personal', gitPath: `/spaces/${there}` },
    ]);
    // As a refused key left them, before the key was replaced and the service restarted.
    const checked = new Date(Date.now() - 60_000);
    const row = (spaceId: string, builtin: 'generation' | 'transcription') => ({
      id: newId('conn'),
      spaceId,
      provider: 'generation',
      label: builtin === 'generation' ? 'Voice' : 'Voice to text',
      scopes: [builtin === 'generation' ? 'audio.synthesize' : 'audio.transcribe'],
      configuration: { builtin },
      health: 'failing',
      lastCheckedAt: checked,
    });
    const rows = [
      row(here, 'generation'),
      row(here, 'transcription'),
      row(there, 'generation'),
      row(there, 'transcription'),
      { ...row(there, 'transcription'), health: 'ok' },
    ];
    await db.insert(connection).values(rows);
    const allowance: VoiceAllowance = { take: async () => 'r1', giveBack: async () => {} };
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('owner', {
        id: 'prn_01J00000000000000000000000',
        email: 'voice@example.test',
        created_at: new Date().toISOString(),
      });
      c.set('experienceSpaceId', here);
      await next();
    });
    mountVoice(app, {
      db,
      allowance,
      providers: { transcription: fakeTranscriptionAdapter, live: null },
      limits: { seconds: 1800, characters: 20_000, sessions: 30, asides: 600 },
      privacy: async () => null,
    });
    const audio = silentWav({ script: 'Move my dentist to Friday.', durationMs: 2400 });
    const response = await app.request('/voice/transcriptions?duration_ms=2400', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: audio,
    });
    expect(response.status).toBe(200);
    const read = await db
      .select({ id: connection.id, health: connection.health })
      .from(connection)
      .where(
        inArray(
          connection.id,
          rows.map((r) => r.id),
        ),
      );
    const healthOf = (id: string) => read.find((r) => r.id === id)?.health;
    // The key works: every space's Voice to text row reads working again.
    expect(healthOf(rows[1]?.id ?? '')).toBe('ok');
    expect(healthOf(rows[3]?.id ?? '')).toBe('ok');
    // A transcription says nothing about reading aloud.
    expect(healthOf(rows[0]?.id ?? '')).toBe('failing');
    expect(healthOf(rows[2]?.id ?? '')).toBe('failing');
    // A row already working is not written to.
    const [kept] = await db
      .select({ at: connection.lastCheckedAt })
      .from(connection)
      .where(eq(connection.id, rows[4]?.id ?? ''));
    expect(kept?.at?.getTime()).toBe(checked.getTime());
  });
});
