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
      reversal: () => ({ mode: 'compensation' as const, kind: 'bookings.cancel', payload: {} }),
    };
    const booked = { ...created('act_made'), kind: 'bookings.book' } as Action;
    expect(await planReversal(none, 'spc_1', booked, connector)).toMatchObject({
      declared: 'connector',
    });
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
