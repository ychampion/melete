/**
 * Model usage: this month's spending in Settings › Models, and the quiet
 * notice every page shows once a limit is close or reached. The figures are
 * the service's estimates from its price table.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { useLoad } from '../experience/hooks.ts';
import { modelDisplayName } from '../experience/model-name.ts';
import { type Usage, usage } from './api.ts';

const dollars = (value: number) =>
  value < 0.01 && value > 0 ? 'under $0.01' : `$${value.toFixed(2)}`;
const tokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M tokens`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k tokens`
      : `${value} tokens`;
const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/**
 * When the day's count starts again, in the reader's own time: "today at
 * 5:00 PM", "tomorrow at 5:30 AM", or a date if further off. The service's day
 * ends at midnight UTC, which is rarely midnight where the reader is.
 */
export function dayResetLine(iso: string, now = new Date(), timeZone?: string) {
  const at = new Date(iso);
  const zone = timeZone ? { timeZone } : {};
  const dateKey = (date: Date) => date.toLocaleDateString('en-CA', zone);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...zone });
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (dateKey(at) === dateKey(now)) return `today at ${time}`;
  if (dateKey(at) === dateKey(tomorrow)) return `tomorrow at ${time}`;
  return `on ${at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...zone })} at ${time}`;
}

/**
 * A model as a person reads it on the usage list: "Kimi K3", not its provider
 * path. The model that indexes memory for search is named for what it does.
 */
export function usageModelName(model: string): string {
  if (/embed/i.test(model)) return 'Memory search';
  return modelDisplayName(model) || model;
}

/** "$4.20 of $10.00 · 1.2M tokens", or without the limit when there is none. */
export function usageLine(
  spent: { usd: number; tokens: number },
  limit: Usage['limits']['person']['month'],
) {
  const money =
    limit.usd !== null ? `${dollars(spent.usd)} of ${dollars(limit.usd)}` : dollars(spent.usd);
  const count =
    limit.tokens !== null
      ? `${tokens(spent.tokens)} of ${tokens(limit.tokens)}`
      : tokens(spent.tokens);
  return `${money} · ${count}`;
}

/** "$4.20 of $10.00 · 12 calls", or without the limit when there is none. */
export function groupLine(row: { usd: number; calls: number }, limit: number | null) {
  const money = limit !== null ? `${dollars(row.usd)} of ${dollars(limit)}` : dollars(row.usd);
  return `${money} · ${row.calls} call${row.calls === 1 ? '' : 's'}`;
}

type Group = { key: string; name: string; line: string; reached: boolean };

/**
 * This month by space and by person, as Settings lists them. A list with a
 * single row and no limit says nothing the totals above do not, so it is left
 * out; a room is marked as one so it is not mistaken for someone's own space.
 */
export function usageGroups(data: Pick<Usage, 'by_space' | 'by_member'>) {
  const spaceRows = (data.by_space ?? []).map((row) => ({ ...row, limit: row.budget_usd }));
  const memberRows = (data.by_member ?? []).map((row) => ({ ...row, limit: row.limit_usd }));
  const worth = (rows: { limit: number | null }[]) =>
    rows.length > 1 || rows.some((row) => row.limit !== null);
  const shape = (row: { usd: number; calls: number; limit: number | null }) => ({
    line: groupLine(row, row.limit),
    reached: row.limit !== null && row.usd >= row.limit,
  });
  return {
    spaces: worth(spaceRows)
      ? spaceRows.map(
          (row): Group => ({
            key: row.space_id,
            name: row.kind === 'shared' ? `${row.name} (room)` : row.name,
            ...shape(row),
          }),
        )
      : [],
    members: worth(memberRows)
      ? memberRows.map(
          (row): Group => ({ key: row.principal_id, name: row.name || 'Someone', ...shape(row) }),
        )
      : [],
  };
}

function GroupList({ title, rows }: { title: string; rows: Group[] }) {
  if (!rows.length) return null;
  return (
    <>
      <span className="models-overline models-usage-group">{title}</span>
      <ul className="models-usage-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span className="models-usage-name">{row.name}</span>
            <span style={row.reached ? { color: 'var(--danger)' } : undefined}>{row.line}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function UsageThisMonth() {
  const loaded = useLoad(() => usage(), []);
  const data = loaded.data;
  if (!data) return null;
  const mine = data.person ?? data.installation;
  const limits = data.person ? data.limits.person : data.limits.installation;
  if (!mine || !limits) return null;
  const limit = limits.month;
  const groups = usageGroups(data);
  return (
    <section className="card-12 models-usage" aria-labelledby="usage-head">
      <span id="usage-head" className="models-overline">
        Usage this month
      </span>
      <span className="models-active-name">{usageLine(mine.month, limit)}</span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
        Today {usageLine(mine.day, limits.day)} · resets {dayResetLine(data.day_resets_at)}
      </span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
        This month resets on {dayOf(data.month_resets_at)}
      </span>
      {data.notice ? (
        <span
          className="models-warning"
          role="note"
          // Close to a limit is a quiet note; a reached limit keeps the warning colour.
          style={data.notice.level === 'warning' ? { color: 'var(--sand-ink)' } : undefined}
        >
          <Icon name="alert" size={14} />
          {data.notice.message}
        </span>
      ) : null}
      {data.models.length ? (
        <ul className="models-usage-list">
          {data.models.map((row) => (
            <li key={`${row.provider}/${row.model}`}>
              <span className="models-usage-name" title={row.model}>
                {usageModelName(row.model)}
              </span>
              <span>
                {row.role ? (
                  <span className="models-role">
                    {row.role === 'primary' ? 'Primary' : 'Secondary'}
                  </span>
                ) : null}
                {row.calls} call{row.calls === 1 ? '' : 's'} · {dollars(row.usd)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <GroupList title="By space" rows={groups.spaces} />
      <GroupList title="By person" rows={groups.members} />
    </section>
  );
}

const DISMISSED = 'melete.usage-notice';

function dismissedKey(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}

/** A slim line above the page while a limit is close or reached; a warning can be put away. */
export function UsageNotice() {
  const loaded = useLoad(() => usage(), []);
  const [hidden, setHidden] = useState<string | null>(dismissedKey);
  const notice = loaded.data?.notice;
  if (!notice) return null;
  const id = `${notice.level}:${notice.period}:${notice.resets_at}`;
  if (notice.level === 'warning' && hidden === id) return null;
  return (
    <div className="usage-notice" role="status" data-level={notice.level}>
      <Icon name="alert" size={14} />
      <span className="grow">{notice.message}</span>
      {notice.level === 'warning' ? (
        <button
          type="button"
          className="usage-notice-close"
          aria-label="Hide this notice"
          onClick={() => {
            try {
              window.localStorage.setItem(DISMISSED, id);
            } catch {
              // Hidden for this page only.
            }
            setHidden(id);
          }}
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}
