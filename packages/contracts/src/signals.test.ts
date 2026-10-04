import { describe, expect, test } from 'bun:test';
import { eventCatalog, producesEvent } from './signals.ts';

describe('event catalogs', () => {
  test('a mailbox reports mail and a calendar reports occurrences, and neither reports the other', () => {
    expect(producesEvent('imap', 'mail.received')).toBe(true);
    expect(producesEvent('imap', 'mail.new')).toBe(true);
    expect(producesEvent('imap', 'calendar.event.changed')).toBe(false);
    expect(producesEvent('caldav', 'calendar.event.changed')).toBe(true);
    expect(producesEvent('caldav', 'calendar.updated')).toBe(false);
    expect(producesEvent('caldav', 'mail.received')).toBe(false);
  });

  test('a family named by prefix needs something after the prefix', () => {
    expect(producesEvent('room', 'room.handoff_settled.hnd_1')).toBe(true);
    expect(producesEvent('room', 'room.handoff_settled.')).toBe(false);
    expect(producesEvent('room', 'mail.received')).toBe(false);
  });

  test('a connection that reports nothing has an empty catalog', () => {
    expect(eventCatalog('web')).toEqual({ names: [], prefixes: [] });
    expect(producesEvent('mcp', 'mail.received')).toBe(false);
  });
});
