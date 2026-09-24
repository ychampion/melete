import { describe, expect, test } from 'bun:test';
import type { ScanRecord } from './repository.ts';
import { SCAN_ALLOWANCE_NOTE, scanView } from './routes.ts';

const record = (counts: Record<string, number>): ScanRecord => ({
  id: 'scn_1',
  status: 'done',
  messagesSeen: 40,
  itemsFound: 12,
  counts,
  error: null,
  startedAt: '2026-09-18T09:00:00.000Z',
  finishedAt: '2026-09-18T09:01:00.000Z',
});

describe('what a scan says about itself', () => {
  test('a scan that stopped at the daily allowance says the rest comes tomorrow', () => {
    expect(scanView(record({ daily_allowance_reached: 3 }))).toEqual({
      status: 'done',
      messages_seen: 40,
      items_found: 12,
      note: SCAN_ALLOWANCE_NOTE,
    });
    expect(SCAN_ALLOWANCE_NOTE).toBe('Some messages will be read on your next scan tomorrow.');
  });

  test('a scan that read everything carries no note', () => {
    expect(scanView(record({ already_read: 5 }))).not.toHaveProperty('note');
  });
});
