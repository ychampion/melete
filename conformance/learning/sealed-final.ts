import type { RecordCase } from './records.ts';

/** Loaded only after the validation selection is durably recorded; never imported by the proposer. */
export function sealedFinalCases(): readonly RecordCase[] {
  return [
    {
      template: 'final-numeric-priorities',
      task: {
        columns: ['id', 'priority', 'label'],
        rows: [
          { id: 'a', priority: 8, label: 'oak' },
          { id: 'b', priority: 120, label: 'birch' },
          { id: 'c', priority: 31, label: 'elm' },
          { id: 'd', priority: 5, label: 'ash' },
        ],
        key: 'priority',
        type: 'number',
        direction: 'descending',
        dateFormat: 'iso',
      },
      expectedIds: ['b', 'c', 'a', 'd'],
    },
    {
      template: 'final-expiry-register',
      task: {
        columns: ['id', 'expiry'],
        rows: [
          { id: 'a', expiry: '2027-01-03' },
          { id: 'b', expiry: '2026-10-09' },
          { id: 'c', expiry: '2028-04-15' },
          { id: 'd', expiry: '2027-11-30' },
        ],
        key: 'expiry',
        type: 'date',
        direction: 'descending',
        dateFormat: 'iso',
      },
      expectedIds: ['c', 'd', 'a', 'b'],
    },
    {
      template: 'final-reverse-catalog',
      task: {
        columns: ['id', 'name'],
        rows: [
          { id: 'a', name: 'copper' },
          { id: 'b', name: 'zinc' },
          { id: 'c', name: 'iron' },
          { id: 'd', name: 'aluminum' },
        ],
        key: 'name',
        type: 'text',
        direction: 'descending',
        dateFormat: 'iso',
      },
      expectedIds: ['b', 'c', 'a', 'd'],
    },
  ];
}
export const sealedFinalMemory = [
  'source-authority/document-paraphrase-dispute.json',
  'forgetting-and-access/forget-survives-restore.json',
] as const;
