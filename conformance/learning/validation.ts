import type { RecordCase } from './records.ts';

export const validationCases: readonly RecordCase[] = [
  {
    template: 'validation-numeric-totals',
    task: {
      columns: ['id', 'total'],
      rows: [
        { id: 'n1', total: 20 },
        { id: 'n2', total: 3 },
        { id: 'n3', total: 100 },
      ],
      key: 'total',
      type: 'number',
      direction: 'ascending',
      dateFormat: 'iso',
    },
    expectedIds: ['n2', 'n1', 'n3'],
  },
  {
    template: 'validation-iso-reminders',
    task: {
      columns: ['id', 'due'],
      rows: [
        { id: 'd1', due: '2026-12-02' },
        { id: 'd2', due: '2026-03-14' },
        { id: 'd3', due: '2026-08-20' },
      ],
      key: 'due',
      type: 'date',
      direction: 'ascending',
      dateFormat: 'iso',
    },
    expectedIds: ['d2', 'd3', 'd1'],
  },
  {
    template: 'validation-label-index',
    task: {
      columns: ['id', 'label'],
      rows: [
        { id: 't1', label: 'pear' },
        { id: 't2', label: 'apple' },
        { id: 't3', label: 'orange' },
      ],
      key: 'label',
      type: 'text',
      direction: 'ascending',
      dateFormat: 'iso',
    },
    expectedIds: ['t2', 't3', 't1'],
  },
];
export const validationMemory = [
  'source-authority/no-nearby-message-citation.json',
  'forgetting-and-access/revoked-source-leaves-retrieval.json',
] as const;
