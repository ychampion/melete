/**
 * "Show me only what needs me": for a space where the person helps someone
 * else with their accounts. Melete still reads everything there; the person
 * sees summaries and action cards, and opens an original only on purpose. The
 * service refuses the ordinary file reads while it is on and notes each open,
 * and each change of the setting, in the space's activity.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Toggle } from '../design/primitives.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import { assistantName } from '../experience/instance.ts';
import type { SummariesOnlyView } from '../experience/types.ts';
import { href } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import './summaries.css';

export const SUMMARIES_TITLE = 'Show me only what needs me';

/** What the setting does, in the words the person reads beside it. */
export const summariesLine = () =>
  `${assistantName()} reads everything here and shows you only what needs you. Open an original when you need it; each open is noted here.`;

const waiting = <T,>(): Promise<Result<T>> =>
  Promise.resolve({ data: null, error: null, unavailable: 'Loading your space…' });

/**
 * Whether the space this session uses shows only what needs the person. Read
 * once per screen; anything that fails to load leaves it off, as the service
 * does for a space without the setting, and the service still refuses.
 */
export function useSummariesOnly(): { on: boolean; spaceId: string | null } {
  const members = useLoad(() => adapter.spaceMembers(), []);
  const spaceId = members.data?.space.id ?? null;
  const setting = useLoad(
    () => (spaceId ? adapter.summariesOnly(spaceId) : waiting<SummariesOnlyView>()),
    [spaceId],
  );
  return { on: setting.data?.on === true, spaceId };
}

const NOTE_WORDS: Record<SummariesOnlyView['recent'][number]['note'], string> = {
  original_opened: 'opened',
  summaries_on: 'turned this on',
  summaries_off: 'turned this off',
};

const noteTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** One note in words: who, what they did or opened, and when. */
export const noteLine = (note: SummariesOnlyView['recent'][number]): string =>
  `${note.by} ${NOTE_WORDS[note.note]}${note.what ? ` ${note.what}` : ''} · ${noteTime(note.at)}`;

/**
 * The switch: at the top of Settings → Space rules, and in a room's settings
 * (`room`), where the room's id is its space's. Only the space's maker turns
 * it on or off; everyone sees it and the latest notes.
 */
export function SummariesOnlySetting({
  spaceId,
  room = false,
}: {
  spaceId: string | undefined;
  room?: boolean;
}) {
  const setting = useLoad(
    () => (spaceId ? adapter.summariesOnly(spaceId) : waiting<SummariesOnlyView>()),
    [spaceId],
  );
  const [saving, setSaving] = useState(false);
  if (!setting.data) return null;
  const { on, can_change: canChange, recent } = setting.data;
  const place = room ? 'room' : 'space';
  const change = (next: boolean) => {
    if (!spaceId) return;
    setSaving(true);
    void adapter.setSummariesOnly(spaceId, next).then((result) => {
      setSaving(false);
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t change that' });
        return;
      }
      setting.set(result.data);
      toast({
        kind: 'ok',
        title: result.data.on ? 'Showing only what needs you' : 'Showing everything again',
        sub: `This change is noted in the ${place}’s activity.`,
      });
    });
  };
  return (
    <div
      className={room ? 'settings-switch summaries-room' : 'card-12 summaries-setting'}
      data-on={on ? 'true' : undefined}
    >
      {room ? null : (
        <span className="summaries-icon" aria-hidden="true">
          <Icon name="lock" size={20} />
        </span>
      )}
      <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
        <span className={room ? 'settings-choice-title' : 'summaries-title'}>
          {SUMMARIES_TITLE}
        </span>
        <span className={room ? 'people-hint' : 'summaries-sub'}>{summariesLine()}</span>
        <span className={room ? 'people-hint' : 'summaries-sub'}>
          {on ? 'On.' : 'Off.'}
          {room ? null : (
            <>
              {' '}
              <a href={href('/settings/activity')}>See what was opened</a>
            </>
          )}
          {canChange ? null : ` Only the person who made this ${place} turns this on or off.`}
        </span>
        {recent.length ? (
          <ul className="summaries-notes" aria-label="Latest opens and changes">
            {recent.slice(0, 5).map((note) => (
              <li key={`${note.at}-${note.note}-${note.what ?? ''}`}>{noteLine(note)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <Toggle on={on} disabled={!canChange || saving} label={SUMMARIES_TITLE} onChange={change} />
    </div>
  );
}

/** What Files says while the space shows only what needs the person. */
export function SummariesOnlyBanner() {
  return (
    <div className="card-12 summaries-banner" role="note">
      <span className="summaries-icon" aria-hidden="true">
        <Icon name="lock" size={18} />
      </span>
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="summaries-title">Showing only what needs you</span>
        <span className="summaries-sub">
          {summariesLine()} <a href={href('/settings/activity')}>See what was opened</a>
        </span>
      </div>
    </div>
  );
}
