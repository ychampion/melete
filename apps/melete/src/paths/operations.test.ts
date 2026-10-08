import { describe, expect, test } from 'bun:test';
import { formClass, formTarget, toolClass } from './operations.ts';

describe('which action an effect is', () => {
  test("a form's address names the action, however it is written", () => {
    const one = formTarget('https://Book.Example./reserve/?party=6#top', 'post');
    expect(one).toBe('form POST https://book.example/reserve');
    expect(formTarget('https://book.example/reserve', 'POST')).toBe(one);
    // Another form at the same site is another action.
    expect(formTarget('https://book.example/newsletter', 'POST')).not.toBe(one);
    expect(formTarget('https://book.example:8443/reserve', 'POST')).not.toBe(one);
    expect(formTarget('javascript:void(0)', 'POST')).toBeNull();
  });

  test("a form's fields and a tool's name say what kind of action it is, or nothing", () => {
    expect(formClass({ to: 'a@b.example', subject: 'Hi', body: 'Hello' })).toBe('message');
    expect(formClass({ party_size: '6', time: '19:00' })).toBe('booking');
    expect(formClass({ summary: 'Lunch', dtstart: '2026-10-10' })).toBe('event');
    expect(formClass({ q: 'shoes' })).toBeNull();
    expect(formClass({ email: 'a@b.example' })).toBeNull();
    expect(toolClass('email.send')).toBe('message');
    expect(toolClass('calendar.create')).toBe('event');
    expect(toolClass('opentable.book')).toBe('booking');
    expect(toolClass('email.draft')).toBeNull();
    expect(toolClass('files.write')).toBeNull();
  });
});
