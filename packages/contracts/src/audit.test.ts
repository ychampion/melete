import { describe, expect, test } from 'bun:test';
import { AUDIT_CSV_COLUMNS, auditCsv, csvField, type SpaceAuditEntry } from './audit.ts';

const entry: SpaceAuditEntry = {
  action_id: 'act_1',
  job_id: 'job_1',
  attempt_id: 'att_1',
  job_title: 'Post the notes, "today"',
  audience: 'room',
  kind: 'notes.post',
  effect_class: 'write_external',
  status: 'succeeded',
  payload_hash: 'a'.repeat(64),
  connection: { id: 'conn_1', label: 'Team notes', provider: 'test' },
  principal: { id: 'own_room', name: 'Launch' },
  requested_by: { id: 'own_carol', name: 'Carol' },
  approval: {
    decision: 'approved',
    decided_by: 'own_bob',
    decided_by_name: 'Bob',
    requested_at: '2026-10-15T09:00:00.000Z',
    decided_at: '2026-10-15T09:01:00.000Z',
  },
  created_at: '2026-10-15T09:00:00.000Z',
  dispatched_at: null,
  resolved_at: null,
};

describe('the activity log as CSV', () => {
  test('a field with a comma, quote or line break is quoted, and an empty one is blank', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a, b')).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  test('a value a spreadsheet would run as a formula is kept as text', () => {
    for (const value of ['=SUM(A1:A9)', '+1', '-1', '@cmd', '\tx', '\rx'])
      expect(csvField(value).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  test('one header row, then one row per entry with a value for every column', () => {
    const csv = auditCsv([entry, { ...entry, action_id: 'act_2', approval: null }]);
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(AUDIT_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      [
        '2026-10-15T09:00:00.000Z',
        'act_1',
        'job_1',
        '"Post the notes, ""today"""',
        'room',
        'own_room',
        'Launch',
        'own_carol',
        'Carol',
        'Team notes',
        'test',
        'notes.post',
        'write_external',
        'succeeded',
        'a'.repeat(64),
        'approved',
        'own_bob',
        'Bob',
        '2026-10-15T09:01:00.000Z',
        '',
        '',
      ].join(','),
    );
    // An entry that asked no permission leaves the approval columns blank (the title's
    // comma adds one to a naive split).
    expect(lines[2]?.split(',').slice(16, 20)).toEqual(['', '', '', '']);
  });
});
