/**
 * Voice is offered only while its speech connections work: the space's own
 * Voice and Voice to text rows, as their last check left them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { speechHealthFrom } from '../../src/api/voice.ts';
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
    const health = speechHealthFrom(handle.db);
    expect(await health(here)).toEqual({ speech: true, transcription: true });

    // A refused key leaves both failing; a passing Test sets each back.
    await handle.db.update(connection).set({ health: 'failing' }).where(eq(connection.id, speech));
    expect(await health(here)).toEqual({ speech: false, transcription: true });
    await handle.db.update(connection).set({ health: 'failing' }).where(eq(connection.id, words));
    expect(await health(here)).toEqual({ speech: false, transcription: false });
    // Another space's rows say nothing about this one.
    expect(await health(there)).toEqual({ speech: true, transcription: true });
    // A removed row is not a failing one.
    await handle.db.update(connection).set({ status: 'revoked' }).where(eq(connection.id, speech));
    expect((await health(here)).speech).toBe(true);
  });
});
