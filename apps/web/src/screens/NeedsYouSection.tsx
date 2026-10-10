/**
 * "Needs you": the new mail and calendar changes that need the person, and
 * what Melete noticed on its own, most pressing first. Everything shown is what
 * `GET /needs-you` returned. Each item says why (the message or meeting it
 * rests on), its urgency, and lets the person mark it seen or dismiss it.
 * "Handle it" starts an ordinary chat about it, where anything Melete would do
 * still asks first. The person's message names only the item's source; the
 * source itself goes with it as an attached file, which the agent reads as
 * untrusted data, so nothing a sender wrote is ever said in the person's name. With nothing to show, one calm line; never a made-up item.
 */

import type { AttachmentView } from '@melete/contracts/attachments';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { Button, Status } from '../design/primitives.tsx';
import type { Result } from '../experience/adapter.ts';
import { call } from '../experience/call.ts';
import { clockTime, sameDay, weekday } from '../experience/clock.ts';
import type { NeedsYou, NeedsYouItem } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

export const needsYouApi = {
  list: () => call<NeedsYou>('/needs-you'),
  /** The item's source as a file in this space, for the chat's first message to carry. */
  source: (item: NeedsYouItem) =>
    call<{ attachment: AttachmentView }>(`/needs-you/${encodeURIComponent(item.id)}/source`, {
      method: 'POST',
    }),
  /** A sorted item is marked through its own routes; something noticed, through the situation's. */
  mark: (item: NeedsYouItem, what: 'ack' | 'dismiss'): Promise<Result<unknown>> =>
    call(
      `/${item.source === 'situation' ? 'situations' : 'needs-you'}/${encodeURIComponent(item.id)}/${what}`,
      { method: 'POST' },
    ),
};

const ICON: Record<NeedsYouItem['because']['kind'], IconName> = {
  mail: 'mail',
  calendar: 'calendar',
  situation: 'bell',
};

/** The urgency as a person would read it; nothing for the ordinary lane. */
export function urgencyWords(urgency: NeedsYouItem['urgency']): string | null {
  return urgency === 'urgent' ? 'Urgent' : urgency === 'soon' ? 'Soon' : null;
}

/**
 * When the source is from, in the person's own zone: the time today, the day
 * and time otherwise.
 */
export function whenWords(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = clockTime(date);
  if (sameDay(date, new Date(now))) return time;
  return `${weekday(date)} ${time}`;
}

const WAITING_BECAUSE: Record<NonNullable<NeedsYou['unsorted_reason']>, string> = {
  kept_private: 'kept private, with no local model to sort them',
  limit_reached: 'background work has reached its limit',
  failed: 'the model could not be reached',
  off: 'sorting is turned off',
};

/** "3 not sorted yet: kept private, with no local model to sort them", or nothing. */
export function unsortedLine(count: number, reason: NeedsYou['unsorted_reason']): string | null {
  if (count <= 0) return null;
  return reason ? `${count} not sorted yet: ${WAITING_BECAUSE[reason]}` : `${count} not sorted yet`;
}

function Row({
  item,
  now,
  busy,
  onStart,
  onMark,
}: {
  item: NeedsYouItem;
  now: number;
  busy: boolean;
  onStart: (item: NeedsYouItem) => void;
  onMark: (item: NeedsYouItem, what: 'ack' | 'dismiss') => void;
}) {
  const [open, setOpen] = useState(false);
  const urgency = urgencyWords(item.urgency);
  const at = whenWords(item.because.at, now);
  const detailsId = `needs-you-because-${item.id}`;
  return (
    <li className="needs-you-row" data-seen={item.seen ? 'true' : undefined}>
      <Icon name={ICON[item.because.kind]} size={16} />
      <span className="col grow needs-you-words">
        <span className="needs-you-sentence">
          {item.sentence}
          {urgency ? (
            <>
              {' '}
              <Status tone={item.urgency === 'urgent' ? 'late' : 'needs'} quiet>
                {urgency}
              </Status>
            </>
          ) : null}
        </span>
        <button
          type="button"
          className="needs-you-because"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="clamp1">
            Because: {item.because.label}
            {at ? `, ${at}` : ''}
          </span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {open ? (
          <span id={detailsId} className="needs-you-source">
            {item.because.subject ? <span className="clamp2">“{item.because.subject}”</span> : null}
            {item.reason ? <span>{item.reason}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="needs-you-actions">
        {item.chat_prompt ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Handle it: ${item.sentence}`}
            onClick={() => onStart(item)}
          >
            Handle it
          </Button>
        ) : null}
        {!item.seen ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Mark seen: ${item.sentence}`}
            onClick={() => onMark(item, 'ack')}
          >
            Seen
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={`Dismiss: ${item.sentence}`}
          onClick={() => onMark(item, 'dismiss')}
        >
          Dismiss
        </Button>
      </span>
    </li>
  );
}

export function NeedsYouSection({
  now,
  onStart,
}: {
  now: number;
  onStart: (text: string, attached: readonly AttachmentView[]) => Promise<void>;
}) {
  const [view, setView] = useState<NeedsYou | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    const result = await needsYouApi.list();
    if (live.current && result.data) setView(result.data);
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const mark = async (item: NeedsYouItem, what: 'ack' | 'dismiss') => {
    if (busy) return;
    setBusy(item.id);
    const result = await needsYouApi.mark(item, what);
    if (result.data === null) {
      toast({
        kind: 'err',
        title: what === 'ack' ? 'Couldn’t mark it seen' : 'Couldn’t dismiss it',
        sub: result.error ?? result.unavailable ?? '',
      });
    } else await load();
    if (live.current) setBusy(null);
  };

  const start = async (item: NeedsYouItem) => {
    if (busy || !item.chat_prompt) return;
    setBusy(item.id);
    if (!item.seen) await needsYouApi.mark(item, 'ack');
    // The source goes as a file; a situation, or a service without file storage, goes by reference alone.
    const source = item.source === 'triage' ? await needsYouApi.source(item) : null;
    await onStart(item.chat_prompt, source?.data ? [source.data.attachment] : []);
    if (live.current) setBusy(null);
  };

  // The service has no list for this person (an older one, or none yet): nothing to draw.
  if (!view) return null;
  const meta = unsortedLine(view.unsorted, view.unsorted_reason);
  return (
    <section className="home-section" aria-labelledby="home-needs-you">
      <div className="home-section-head">
        <h2 id="home-needs-you">Needs you</h2>
        {meta ? <span className="home-section-meta">{meta}</span> : null}
      </div>
      {view.items.length ? (
        <ul className="needs-you-list">
          {view.items.map((item) => (
            <Row
              key={item.id}
              item={item}
              now={now}
              busy={busy !== null}
              onStart={(chosen) => void start(chosen)}
              onMark={(chosen, what) => void mark(chosen, what)}
            />
          ))}
        </ul>
      ) : (
        <p className="needs-you-empty voice">Nothing needs you right now.</p>
      )}
    </section>
  );
}
