import { describe, expect, test } from 'bun:test';
import type { Action } from '@melete/contracts';
import { appsManifest } from '../connectors/apps.ts';
import { calendarManifest } from '../connectors/calendar.ts';
import { emailManifest } from '../connectors/email.ts';
import { filesManifest } from '../connectors/files.ts';
import type { Query } from './records.ts';
import {
  declarationOf,
  heldKind,
  planReversal,
  REVERSALS,
  type ReversalPlan,
  reverseInOrder,
  undoDecides,
} from './reversals.ts';

describe('the reversal registry', () => {
  test('calendar, mail, files and apps each declare how their changes are taken back', () => {
    expect(declarationOf('calendar.create').mode).toBe('reversal');
    expect(declarationOf('calendar.update').mode).toBe('reversal');
    expect(declarationOf('calendar.delete').mode).toBe('compensation');
    expect(declarationOf('email.draft').mode).toBe('reversal');
    expect(declarationOf('email.send').mode).toBe('hold');
    expect(declarationOf('files.delete').mode).toBe('reversal');
    expect(declarationOf('apps.publish').mode).toBe('reversal');
    expect(heldKind('email.send')).toBe(true);
    expect(heldKind('calendar.create')).toBe(false);
  });

  test('every declared tool is a real tool, and an undeclared one has none', () => {
    const tools = new Set(
      [calendarManifest, emailManifest, filesManifest, appsManifest].flatMap((manifest) =>
        manifest.tools.map((tool) => tool.name),
      ),
    );
    for (const kind of Object.keys(REVERSALS)) expect(tools.has(kind)).toBe(true);
    expect(declarationOf('room.post').mode).toBe('none');
  });

  test('a connected app can declare its own tools', () => {
    const connector = {
      reversalDeclared: (kind: string) =>
        kind === 'tasks.create' ? ({ mode: 'reversal', says: 'Removes the task.' } as const) : null,
    };
    expect(declarationOf('tasks.create', connector).mode).toBe('reversal');
    expect(declarationOf('tasks.rename', connector).mode).toBe('none');
  });
});

describe('what an undo may reach', () => {
  const created = (uid: string) =>
    ({
      id: 'act_made',
      kind: 'calendar.create',
      status: 'succeeded',
      connection_id: 'con_1',
      canonical_payload: { summary: 'Focus' },
      receipt: { detail: { uid, etag: '"1"' } },
    }) as unknown as Action;
  const none = {} as Query;

  test('undoing a new event removes that event, never one its receipt names instead', async () => {
    expect(await planReversal(none, 'spc_1', created('act_made'))).toEqual({
      mode: 'reversal',
      kind: 'calendar.delete',
      payload: { uid: 'act_made', etag: '"1"' },
    });
    expect(await planReversal(none, 'spc_1', created('act_someone_else'))).toBeNull();
  });

  test('an Undo approves only built-in reversals of what Melete made, never a connector’s own', () => {
    expect(undoDecides({ kind: 'calendar.delete' })).toBe(true);
    expect(undoDecides({ kind: 'files.restore' })).toBe(true);
    expect(undoDecides({ kind: 'calendar.delete', declared: 'connector' })).toBe(false);
    expect(undoDecides({ kind: 'email.send' })).toBe(false);
    expect(undoDecides({ kind: 'bookings.cancel' })).toBe(false);
  });

  test('a connector’s own reversal is marked as declared by it', async () => {
    const connector = {
      manifest: { ...calendarManifest, provider: 'mcp' as const },
      reversal: (): ReversalPlan => ({
        mode: 'compensation',
        kind: 'bookings.cancel',
        payload: {},
      }),
    };
    const booked = { ...created('act_made'), kind: 'bookings.book' } as Action;
    expect(await planReversal(none, 'spc_1', booked, connector)).toMatchObject({
      declared: 'connector',
    });
  });
});

describe('restoring from the trash', () => {
  const deleted = (kind: string, detail: Record<string, string>) =>
    ({
      id: 'act_del',
      kind,
      status: 'succeeded',
      connection_id: 'con_1',
      canonical_payload: {},
      receipt: { detail },
    }) as unknown as Action;
  const filesConnection = (async () => [{ id: 'con_files' }]) as unknown as Query;
  const from = (provider: 'files' | 'sandbox' | 'mcp') => ({
    manifest: { ...calendarManifest, provider },
  });

  test('only the connector that deleted into the trash names what Undo restores', async () => {
    const trash = { trash_id: 'del_1790000000000_abcdefabcdef' };
    expect(
      await planReversal(filesConnection, 'spc_1', deleted('files.delete', trash), from('files')),
    ).toMatchObject({ kind: 'files.restore', payload: trash });
    expect(
      await planReversal(filesConnection, 'spc_1', deleted('files.delete', trash), from('mcp')),
    ).toBeNull();
    const command = { workspace_trash: 'del_1790000000000_abcdefabcdef' };
    expect(
      await planReversal(filesConnection, 'spc_1', deleted('exec.run', command), from('sandbox')),
    ).toMatchObject({ kind: 'files.restore', connectionId: 'con_files' });
    // Another app's receipt cannot name a trash entry for Undo to restore.
    expect(
      await planReversal(filesConnection, 'spc_1', deleted('notes.write', command), from('mcp')),
    ).toBeNull();
  });
});

describe('holds a connected app declares', () => {
  test('a send its connector declares as held is held like a message', () => {
    const connector = {
      reversalDeclared: (kind: string) =>
        kind === 'chat.send' ? ({ mode: 'hold', says: 'Waits before sending.' } as const) : null,
    };
    expect(heldKind('chat.send', connector)).toBe(true);
    expect(heldKind('chat.send')).toBe(false);
    expect(heldKind('chat.read', connector)).toBe(false);
  });
});

describe('taking back a series of changes', () => {
  test('runs newest first, and keeps going past a step that fails', async () => {
    const ran: string[] = [];
    const steps = await reverseInOrder(['hold', 'booking', 'note'], async (effect) => {
      ran.push(effect);
      if (effect === 'booking') throw new Error('The table could not be cancelled.');
      return { ok: true };
    });
    expect(ran).toEqual(['note', 'booking', 'hold']);
    expect(steps.map((step) => [step.effect, step.ok])).toEqual([
      ['note', true],
      ['booking', false],
      ['hold', true],
    ]);
    expect(steps[1]?.reason).toBe('The table could not be cancelled.');
  });
});
