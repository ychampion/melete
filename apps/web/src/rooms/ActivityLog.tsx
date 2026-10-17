/**
 * Room → Activity log, for the room's owners: everything the room's work did
 * or tried to do through an account, who asked for it and who let it go
 * ahead. What a message said is never shown here, only that it was sent, where
 * and by whose request; each entry carries a fingerprint of its content that
 * matches the receipt. `#/rooms/{id}/activity` opens it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Select } from '../design/primitives.tsx';
import { href, navigate } from '../router.ts';
import { Shell } from '../shell/Shell.tsx';
import {
  type AuditEntry,
  type AuditFilter,
  type RoomDetail,
  type RoomMember,
  roomsApi,
} from './api.ts';

export const EFFECT_WORDS: Record<AuditEntry['effect_class'], string> = {
  read: 'Read',
  write_reversible: 'Changed something that can be undone',
  write_external: 'Sent or posted',
  spend: 'Spent money',
};

const STATUS_WORDS: Record<AuditEntry['status'], string> = {
  proposed: 'About to start',
  needs_approval: 'Waiting for permission',
  approved: 'Allowed, not done yet',
  denied: 'Declined',
  admitted: 'Starting',
  dispatched: 'In progress',
  succeeded: 'Done',
  failed: 'Didn’t go through',
  unknown: 'Not confirmed yet',
  unresolved: 'Couldn’t be confirmed',
};

export const statusWords = (status: AuditEntry['status']) => STATUS_WORDS[status] ?? status;

/** Whose work it was: the member who asked the room, or a person's own work. */
export function whoLine(entry: AuditEntry): string {
  if (entry.audience === 'room')
    return entry.requested_by ? `Asked by ${entry.requested_by.name}` : 'Asked of the room';
  return entry.principal ? `${entry.principal.name}’s own work` : 'Work from before accounts';
}

/** Who let it go ahead, or that nobody had to. */
export function approvalLine(entry: AuditEntry): string {
  const approval = entry.approval;
  if (!approval) return 'No permission needed';
  if (!approval.decision) return 'Waiting for permission';
  const allowed = approval.decision === 'approved';
  if (approval.decided_by === 'policy')
    return allowed ? 'Allowed by a standing rule' : 'Declined by a standing rule';
  if (approval.decided_by === 'reviewer')
    return allowed ? 'Allowed by the reviewer' : 'Stopped by the reviewer';
  const by = approval.decided_by_name ?? 'someone';
  return allowed ? `Approved by ${by}` : `Declined by ${by}`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * The days a person picked, as the instants the log is filtered on: from the
 * start of the first day to the end of the last, in their own time zone.
 */
export function dayRange(from: string, to: string): Pick<AuditFilter, 'since' | 'until'> {
  const start = (day: string) => {
    const [year, month, date] = day.split('-').map(Number);
    return year && month && date ? new Date(year, month - 1, date) : null;
  };
  const first = from ? start(from) : null;
  const last = to ? start(to) : null;
  if (last) last.setDate(last.getDate() + 1);
  return {
    ...(first ? { since: first.toISOString() } : {}),
    ...(last ? { until: last.toISOString() } : {}),
  };
}

/** The entries, newest first. */
export function AuditEntries({ entries }: { entries: AuditEntry[] }) {
  return (
    <ul className="card-12 activity-log" aria-label="Activity">
      {entries.map((entry) => (
        <li key={entry.action_id} className="activity-log-row">
          <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span className="activity-log-title">
              {EFFECT_WORDS[entry.effect_class]} · {entry.connection.label}
            </span>
            <span className="activity-log-sub">
              {whoLine(entry)} · {approvalLine(entry)}
              {entry.job_title ? ` · from “${entry.job_title}”` : ''}
            </span>
            <span className="activity-log-meta">
              <time dateTime={entry.created_at}>{when(entry.created_at)}</time> · {entry.kind} ·{' '}
              <span title={`Fingerprint of what it sent: ${entry.payload_hash}`}>
                {entry.payload_hash.slice(0, 12)}
              </span>
            </span>
          </div>
          <span className="activity-log-status" data-status={entry.status}>
            {statusWords(entry.status)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const EFFECT_CHOICES = [
  { value: '', label: 'Everything' },
  ...Object.entries(EFFECT_WORDS).map(([value, label]) => ({ value, label })),
];

const nameOf = (member: RoomMember) => member.display_name.replace(/\s*<[^>]*>$/, '');

export function ActivityLog({ roomId }: { roomId: string }) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [refused, setRefused] = useState(false);
  const [person, setPerson] = useState('');
  const [effect, setEffect] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the answer to the latest read is shown, so a slow page never lands on newer filters.
  const latest = useRef(0);

  const filter: AuditFilter = {
    ...(person ? { principal_id: person } : {}),
    ...(effect ? { effect_class: effect as AuditEntry['effect_class'] } : {}),
    ...dayRange(from, to),
  };
  const key = JSON.stringify(filter);

  useEffect(() => {
    void roomsApi.detail(roomId).then((result) => {
      if (result.data) setDetail(result.data);
    });
  }, [roomId]);

  const read = useCallback(
    async (cursor: string | null) => {
      const turn = ++latest.current;
      setLoading(true);
      const result = await roomsApi.audit(roomId, JSON.parse(key) as AuditFilter, cursor);
      if (turn !== latest.current) return;
      setLoading(false);
      if (!result.data) {
        if (result.status === 403) setRefused(true);
        else setError(result.error ?? result.unavailable);
        // A first page that failed leaves nothing from the filters before it on screen.
        if (!cursor) {
          setEntries(null);
          setNext(null);
        }
        return;
      }
      setError(null);
      const page = result.data;
      setEntries((before) => (cursor && before ? [...before, ...page.entries] : page.entries));
      setNext(page.next_cursor);
    },
    [roomId, key],
  );
  useEffect(() => {
    void read(null);
  }, [read]);

  const room = detail?.room;
  // Guests ask the room too, so an owner can narrow the log to one of them.
  const people = detail?.members ?? [];

  return (
    <Shell
      title="Activity log"
      rail={false}
      phoneBack={() => navigate(`/rooms/${roomId}`)}
      phoneSub={room?.name}
    >
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <a className="room-crumb" href={href(`/rooms/${roomId}`)}>
              {room?.name ?? 'Room'}
            </a>
            <h1>Activity log</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 620 }}>
              Everything {room?.agent_name ?? 'the agent'} did or tried to do through an account in
              this room: who asked, who said yes, and when. What a message said isn’t shown here;
              each entry has a fingerprint that matches its receipt.
            </p>
          </div>
          {refused ? null : (
            <a
              className="btn btn-md btn-outline"
              href={roomsApi.auditExportUrl(roomId, filter)}
              download
            >
              Download CSV
            </a>
          )}
        </div>
        {refused ? (
          <p style={{ fontSize: 14 }}>Only the room’s owners can read its activity log.</p>
        ) : (
          <>
            <div className="row activity-log-filters">
              <Field label="Person">
                <Select
                  label="Person"
                  value={person}
                  onChange={setPerson}
                  options={[
                    { value: '', label: 'Everyone' },
                    ...people.map((member) => ({
                      value: member.principal_id,
                      label: nameOf(member),
                    })),
                  ]}
                />
              </Field>
              <Field label="Kind">
                <Select label="Kind" value={effect} onChange={setEffect} options={EFFECT_CHOICES} />
              </Field>
              <Field label="From">
                <Input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
            </div>
            {error ? (
              <div className="row" style={{ gap: 12, fontSize: 13, color: 'var(--secondary)' }}>
                <span>Couldn’t read the activity log. {error}</span>
                <Button size="sm" variant="outline" onClick={() => void read(null)}>
                  Try again
                </Button>
              </div>
            ) : null}
            {entries === null ? null : entries.length ? (
              <AuditEntries entries={entries} />
            ) : (
              <p style={{ fontSize: 14, color: 'var(--muted)' }}>
                Nothing yet{person || effect || from || to ? ' for these filters' : ''}.
              </p>
            )}
            {next ? (
              <div>
                <Button variant="outline" loading={loading} onClick={() => void read(next)}>
                  Show older
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Shell>
  );
}
