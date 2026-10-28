/**
 * The week across rooms: one grid, Monday first, with every dated board item
 * from the rooms the person is in, each as that room lets them see it. It
 * changes nothing on its own: each card opens its room's board, where it is
 * claimed, completed or answered.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../design/primitives.tsx';
import { clockTime, dayKey, displayZone } from '../experience/clock.ts';
import { useApp } from '../experience/hooks.ts';
import { BoardRow, shortName, useMeId } from '../rooms/Board.tsx';
import { type BoardItem, boardApi, itemWhen, mergeItems } from '../rooms/board-api.ts';
import '../rooms/board.css';
import { href } from '../router.ts';
import { Shell } from '../shell/Shell.tsx';
import { weekStrip } from '../shell/week-strip.ts';

const DAY = 86_400_000;
const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** How often an open week reads the boards again. */
const REFRESH_MS = 15_000;

/** The bounds of the week `offset` weeks from this one, as instants, with its days. */
export function weekOf(now: Date, zone: string, offset: number) {
  const shifted = new Date(now.getTime() + offset * 7 * DAY);
  const { month, days } = weekStrip(shifted, zone, []);
  const first = days[0]?.key ?? dayKey(shifted, zone);
  // A day either side, so the window holds the whole week in any zone; items are placed by day.
  const from = new Date(Date.parse(`${first}T00:00:00Z`) - DAY);
  const to = new Date(from.getTime() + 9 * DAY);
  return { month, days, from, to };
}

export function HouseholdScreen() {
  const { capabilities } = useApp();
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zone = displayZone();
  const me = useMeId(capabilities.multiplayer);
  const week = useMemo(() => weekOf(new Date(), zone, offset), [zone, offset]);

  const read = useCallback(async () => {
    const result = await boardApi.across({
      from: week.from.toISOString(),
      to: week.to.toISOString(),
    });
    if (result.data) {
      setItems(result.data.items);
      setError(null);
    } else setError(result.error ?? result.unavailable);
  }, [week]);

  useEffect(() => {
    setItems(null);
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [read]);

  const byDay = useMemo(() => {
    const map = new Map<string, BoardItem[]>();
    for (const entry of items ?? []) {
      const at = itemWhen(entry);
      if (!at) continue;
      const key = dayKey(new Date(at), zone);
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    for (const list of map.values())
      list.sort((a, b) => (itemWhen(a) ?? '').localeCompare(itemWhen(b) ?? ''));
    return map;
  }, [items, zone]);

  const changed = (entry: BoardItem) => setItems((held) => mergeItems(held ?? [], [entry]));
  const [opened, setOpened] = useState<string | null>(null);
  // On a phone the days stack, so an empty one is left out; a week with none says so once.
  const emptyWeek = items !== null && week.days.every((day) => !byDay.get(day.key)?.length);
  const openItem = items?.find((entry) => entry.id === opened) ?? null;

  if (!capabilities.multiplayer)
    return (
      <Shell title="This week" rail={false}>
        <div className="page">
          <p className="board-empty">Rooms are not available on this server.</p>
        </div>
      </Shell>
    );

  return (
    <Shell title="This week" rail={false}>
      <div className="page household">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>This week</h1>
            <p className="board-sub">
              What is on the boards of your rooms, as each room lets you see it.
            </p>
          </div>
          <div className="row household-nav">
            <Button
              size="sm"
              variant="outline"
              icon="chevronLeft"
              aria-label="Previous week"
              onClick={() => setOffset((n) => n - 1)}
            />
            <Button size="sm" variant="outline" onClick={() => setOffset(0)} disabled={!offset}>
              This week
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon="chevronRight"
              aria-label="Next week"
              onClick={() => setOffset((n) => n + 1)}
            />
          </div>
        </div>
        {error ? <p className="board-error">Couldn’t read the boards. {error}</p> : null}
        <ol className="household-week" aria-label={`Week of ${week.month}`}>
          {week.days.map((day, index) => {
            const list = byDay.get(day.key) ?? [];
            return (
              <li
                key={day.key}
                className="household-day"
                data-today={day.today && offset === 0 ? 'true' : undefined}
                data-empty={items !== null && list.length === 0 ? 'true' : undefined}
              >
                <h2 className="household-day-head">
                  <span>{LONG_DAYS[index]}</span>
                  <span className="household-day-num">{day.num}</span>
                </h2>
                {items === null ? null : list.length === 0 ? (
                  <p className="household-none">Nothing</p>
                ) : (
                  <ul className="household-cards">
                    {list.map((entry) => {
                      const at = itemWhen(entry);
                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            className="household-card"
                            data-state={entry.state}
                            aria-expanded={opened === entry.id}
                            onClick={() => setOpened((was) => (was === entry.id ? null : entry.id))}
                          >
                            <span className="household-card-time">
                              {at ? clockTime(new Date(at)) : ''}
                              {entry.starts_at ? '' : ' due'}
                            </span>
                            <span className="household-card-title">{entry.title}</span>
                            <span className="household-card-meta">
                              {entry.room_name}
                              {entry.assignee ? ` · ${shortName(entry.assignee.display_name)}` : ''}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
        {emptyWeek ? <p className="board-empty household-week-empty">Nothing this week.</p> : null}
        {openItem ? (
          <div className="household-open">
            <ul className="board-list">
              <BoardRow entry={openItem} me={me} onChanged={changed} showRoom />
            </ul>
            <a className="board-link" href={href(`/rooms/${openItem.room_id}/board`)}>
              Open {openItem.room_name}’s board
            </a>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
