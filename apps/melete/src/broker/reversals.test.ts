import { describe, expect, test } from 'bun:test';
import { appsManifest } from '../connectors/apps.ts';
import { calendarManifest } from '../connectors/calendar.ts';
import { emailManifest } from '../connectors/email.ts';
import { filesManifest } from '../connectors/files.ts';
import { declarationOf, heldKind, REVERSALS, reverseInOrder } from './reversals.ts';

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
