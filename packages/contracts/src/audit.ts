/**
 * A space's audit log: every effect its work proposed through a connection,
 * with whose work it was, who asked for it and who approved it. It is read by
 * the space's owners (and by the person who set the installation up, for any
 * shared space), and it names effects without saying what they said: a
 * payload is shown by its hash, never its body.
 */
import { z } from 'zod';
import { actionStatus, effectClass, payloadHash } from './broker.ts';
import { timestamp } from './common.ts';

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
/** The most rows one CSV export carries; a longer log is exported a window at a time. */
export const AUDIT_EXPORT_MAX = 10_000;

/** The filters the log and its export share. */
export const spaceAuditFilter = z.object({
  principal_id: z.string().min(1).max(100).optional().meta({
    description:
      'Only work by this person: their own jobs, and the requests they made of a room’s agent',
  }),
  since: timestamp.optional().meta({ description: 'Only effects proposed at or after this time' }),
  until: timestamp.optional().meta({ description: 'Only effects proposed before this time' }),
  effect_class: effectClass.optional(),
});
export type SpaceAuditFilter = z.infer<typeof spaceAuditFilter>;

export const spaceAuditQuery = spaceAuditFilter.extend({
  cursor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .meta({ description: 'The `next_cursor` of the page before' }),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
});
export type SpaceAuditQuery = z.infer<typeof spaceAuditQuery>;

/** A person named in the log: their id and the name others see. */
export const auditPerson = z
  .object({
    id: z.string(),
    /** The display name, or the part of the email before the @. */
    name: z.string(),
  })
  .meta({ id: 'AuditPerson' });

export const spaceAuditEntry = z
  .object({
    action_id: z.string(),
    job_id: z.string(),
    attempt_id: z.string(),
    /**
     * The chat, plan or request the effect came from. Null when the reader
     * could not otherwise read it: another person's own work, or a room's
     * request read by someone who is not in the room.
     */
    job_title: z.string().nullable(),
    /** `room` for a request made of a room's agent; `principal` for a person's own work. */
    audience: z.enum(['principal', 'room']),
    /** The tool the effect went through, such as `gmail.send`. */
    kind: z.string(),
    effect_class: effectClass,
    status: actionStatus,
    payload_hash: payloadHash,
    connection: z.object({
      id: z.string(),
      label: z.string(),
      provider: z.string(),
    }),
    /** Whose work it was. For a room request this is the room's own principal. */
    principal: auditPerson.nullable(),
    /** For a room request, the member who asked. */
    requested_by: auditPerson.nullable(),
    /** The latest answer to its permission, when it asked one. */
    approval: z
      .object({
        /** `approved` or `denied`; null while it is open. */
        decision: z.string().nullable(),
        /**
         * Who answered: a person, or `policy` / `reviewer` when a rule or the
         * reviewer did. Null while the question is open.
         */
        decided_by: z.string().nullable(),
        decided_by_name: z.string().nullable(),
        requested_at: timestamp,
        decided_at: timestamp.nullable(),
      })
      .nullable(),
    created_at: timestamp,
    dispatched_at: timestamp.nullable(),
    resolved_at: timestamp.nullable(),
  })
  .meta({ id: 'SpaceAuditEntry' });
export type SpaceAuditEntry = z.infer<typeof spaceAuditEntry>;

export const spaceAuditResponse = z
  .object({
    entries: z.array(spaceAuditEntry),
    /** Pass as `cursor` for the next page; null on the last one. */
    next_cursor: z.string().nullable(),
  })
  .meta({ id: 'SpaceAuditResponse' });
export type SpaceAuditResponse = z.infer<typeof spaceAuditResponse>;

/** The CSV export's columns, in order. */
export const AUDIT_CSV_COLUMNS = [
  'created_at',
  'action_id',
  'job_id',
  'job_title',
  'audience',
  'principal_id',
  'principal_name',
  'requested_by_id',
  'requested_by_name',
  'connection_label',
  'connection_provider',
  'kind',
  'effect_class',
  'status',
  'payload_hash',
  'approval_decision',
  'decided_by',
  'decided_by_name',
  'decided_at',
  'dispatched_at',
  'resolved_at',
] as const;

/**
 * One CSV field. A value a spreadsheet would read as a formula (it starts with
 * `=`, `+`, `-`, `@`, a tab or a carriage return) is prefixed with `'`, so a
 * job title cannot run anything in the program that opens the file.
 */
export function csvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The log as CSV: a header row, then one row per entry, lines ending in CRLF. */
export function auditCsv(entries: readonly SpaceAuditEntry[]): string {
  const rows = entries.map((entry) =>
    [
      entry.created_at,
      entry.action_id,
      entry.job_id,
      entry.job_title,
      entry.audience,
      entry.principal?.id,
      entry.principal?.name,
      entry.requested_by?.id,
      entry.requested_by?.name,
      entry.connection.label,
      entry.connection.provider,
      entry.kind,
      entry.effect_class,
      entry.status,
      entry.payload_hash,
      entry.approval?.decision,
      entry.approval?.decided_by,
      entry.approval?.decided_by_name,
      entry.approval?.decided_at,
      entry.dispatched_at,
      entry.resolved_at,
    ]
      .map(csvField)
      .join(','),
  );
  return [AUDIT_CSV_COLUMNS.join(','), ...rows].map((line) => `${line}\r\n`).join('');
}
