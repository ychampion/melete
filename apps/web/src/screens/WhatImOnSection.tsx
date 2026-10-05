/**
 * "What I'm on": what the person asked Melete to see through, each with where
 * it stands, what happens next and by when. Everything shown is what
 * `GET /intents` returned. Melete's reading is read back in one line, and every
 * detail the person never said is marked as Melete's guess, so they can see it
 * and correct it. A correction makes the detail theirs. Cancel stops the work
 * and says what happened to anything it had already changed. With nothing
 * kept, the section is not drawn.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, Status, type StatusTone } from '../design/primitives.tsx';
import type { Result } from '../experience/adapter.ts';
import { call } from '../experience/call.ts';
import type { IntentCancelled, IntentItem, Intents } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

export const intentsApi = {
  list: () => call<Intents>('/intents'),
  edit: (item: IntentItem, values: Record<string, string | number | null>) =>
    call<{ intent: IntentItem }>(`/intents/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: { version: item.version, values },
    }),
  cancel: (item: IntentItem): Promise<Result<IntentCancelled>> =>
    call<IntentCancelled>(`/intents/${encodeURIComponent(item.id)}/cancel`, { method: 'POST' }),
};

const STATE: Record<IntentItem['state'], [StatusTone, string]> = {
  active: ['working', 'On it'],
  waiting: ['waiting', 'Waiting'],
  at_risk: ['late', 'At risk'],
  done: ['settled', 'Done'],
  failed: ['late', 'Didn’t work'],
  cancelled: ['kind', 'Cancelled'],
  expired: ['late', 'Ran out of time'],
};

const OPEN = new Set<IntentItem['state']>(['active', 'waiting', 'at_risk']);

/** "By Tue 6 Oct, 5:00 PM", in the browser's own zone. */
export function byWords(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `By ${day.replace(',', '')}, ${time}`;
}

/** The fields a person can correct, as they are labelled and typed in the form. */
const FIELDS: Record<string, { label: string; kind: 'text' | 'number' | 'when' | 'day' }> = {
  'place.name': { label: 'Place', kind: 'text' },
  'place.kind': { label: 'Kind of place', kind: 'text' },
  'place.near': { label: 'Near', kind: 'text' },
  'party.size': { label: 'How many', kind: 'number' },
  'window.from': { label: 'From', kind: 'when' },
  'window.to': { label: 'Until', kind: 'when' },
  deadline_at: { label: 'Done by', kind: 'when' },
  'budget.max': { label: 'Up to', kind: 'number' },
  deliverable: { label: 'What to deliver', kind: 'text' },
};

function valueAt(item: IntentItem, path: string): string | number | null {
  if (path === 'deadline_at') return item.deadline_at;
  let node: unknown = item.constraints;
  for (const key of path.split('.'))
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  return typeof node === 'string' || typeof node === 'number' ? node : null;
}

/** An instant as a `datetime-local` value, in the browser's zone; a day stays a day. */
function localInput(value: string | number | null): string {
  if (typeof value !== 'string') return value === null ? '' : String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T17:00`;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The read-back line, with each detail Melete chose marked as its guess. */
export function ReadBack({ item }: { item: IntentItem }) {
  const title = item.title.replace(/[.\s]+$/, '');
  return (
    <span className="intent-readback">
      {title}
      {item.read_back.parts.length ? '. ' : '.'}
      {item.read_back.parts.map((part, index) => (
        <span key={part.path}>
          {index ? ', ' : ''}
          {part.origin === 'inferred' ? (
            <span className="intent-guess" title="Melete’s guess: you didn’t say this">
              {part.text}
              <span className="intent-guess-mark"> (my guess)</span>
            </span>
          ) : (
            part.text
          )}
        </span>
      ))}
      {item.read_back.parts.length ? '.' : ''}
    </span>
  );
}

function EditForm({
  item,
  busy,
  onSave,
  onClose,
}: {
  item: IntentItem;
  busy: boolean;
  onSave: (values: Record<string, string | number | null>) => void;
  onClose: () => void;
}) {
  const paths = [
    ...item.read_back.parts.map((part) => part.path).filter((path) => FIELDS[path]),
    ...(item.deadline_at ? [] : ['deadline_at']),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const start = Object.fromEntries(paths.map((path) => [path, localInput(valueAt(item, path))]));
  const [values, setValues] = useState<Record<string, string>>(start);
  const [problem, setProblem] = useState<string | null>(null);
  const save = () => {
    const changed: Record<string, string | number | null> = {};
    for (const path of paths) {
      const before = start[path] ?? '';
      const now = (values[path] ?? '').trim();
      if (now === before) continue;
      const field = FIELDS[path];
      if (!now) changed[path] = null;
      else if (field?.kind === 'number') changed[path] = Number(now);
      else if (field?.kind === 'when') {
        const at = new Date(now);
        const year = at.getFullYear();
        if (Number.isNaN(at.getTime()) || year < 2000 || year > 2200) {
          setProblem(`${field.label}: that isn’t a time Melete can read.`);
          return;
        }
        changed[path] = at.toISOString();
      } else changed[path] = now;
    }
    setProblem(null);
    if (Object.keys(changed).length) onSave(changed);
    else onClose();
  };
  return (
    <form
      className="intent-edit"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {paths.map((path) => {
        const field = FIELDS[path];
        if (!field) return null;
        const id = `intent-${item.id}-${path}`;
        const guessed = item.origins[path] === 'inferred';
        return (
          <label key={path} htmlFor={id} className="intent-field">
            <span>
              {field.label}
              {guessed ? <span className="intent-guess-mark"> (my guess)</span> : null}
            </span>
            <input
              id={id}
              type={
                field.kind === 'number'
                  ? 'number'
                  : field.kind === 'when'
                    ? 'datetime-local'
                    : 'text'
              }
              value={values[path] ?? ''}
              onChange={(event) => setValues((was) => ({ ...was, [path]: event.target.value }))}
            />
          </label>
        );
      })}
      {problem ? (
        <span className="intent-problem" role="alert">
          {problem}
        </span>
      ) : null}
      <span className="intent-edit-actions">
        <Button size="sm" type="submit" disabled={busy}>
          Save
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onClose}>
          Close
        </Button>
      </span>
    </form>
  );
}

function Row({
  item,
  busy,
  onSave,
  onCancel,
}: {
  item: IntentItem;
  busy: boolean;
  onSave: (item: IntentItem, values: Record<string, string | number | null>) => Promise<boolean>;
  onCancel: (item: IntentItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [tone, words] = STATE[item.state];
  const open = OPEN.has(item.state);
  const by = byWords(item.deadline_at);
  const meta = open ? [item.next_step, by].filter(Boolean).join(' · ') : (item.closed_reason ?? '');
  return (
    <li className="needs-you-row intent-row" data-state={item.state}>
      <Icon name="progress" size={16} />
      <span className="col grow needs-you-words">
        <span className="needs-you-sentence">
          <ReadBack item={item} />{' '}
          <Status tone={tone} quiet>
            {words}
          </Status>
        </span>
        {meta ? <span className="intent-meta">{meta}</span> : null}
        {item.words ? <span className="intent-words clamp1">You said: “{item.words}”</span> : null}
        {editing ? (
          <EditForm
            item={item}
            busy={busy}
            onClose={() => setEditing(false)}
            onSave={(values) =>
              void onSave(item, values).then((saved) => {
                if (saved) setEditing(false);
              })
            }
          />
        ) : null}
      </span>
      {open && !editing ? (
        <span className="needs-you-actions">
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-label={`Stop it: ${item.title}`}
                onClick={() => onCancel(item)}
              >
                Stop it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-label={`Edit: ${item.title}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Cancel: ${item.title}`}
                onClick={() => setConfirming(true)}
              >
                Cancel
              </Button>
            </>
          )}
        </span>
      ) : null}
    </li>
  );
}

/** What cancelling did, in one line for the toast. */
export function cancelledLine(result: IntentCancelled): string {
  const kept = result.effects.filter((effect) => effect.outcome !== 'reversed');
  const undone = result.effects.length - kept.length;
  const parts = [
    undone ? `${undone} change${undone === 1 ? '' : 's'} undone` : null,
    kept.length
      ? `still in place: ${kept.map((effect) => effect.title.toLowerCase()).join(', ')}`
      : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}.` : 'Nothing had changed yet.';
}

export function WhatImOnSection() {
  const [items, setItems] = useState<IntentItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    const result = await intentsApi.list();
    if (live.current && result.data) setItems(result.data.intents);
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const save = async (item: IntentItem, values: Record<string, string | number | null>) => {
    if (busy) return false;
    setBusy(item.id);
    const result = await intentsApi.edit(item, values);
    if (result.data === null)
      toast({
        kind: 'err',
        title: 'Couldn’t change it',
        sub: result.error ?? result.unavailable ?? '',
      });
    await load();
    if (live.current) setBusy(null);
    return result.data !== null;
  };

  const cancel = async (item: IntentItem) => {
    if (busy) return;
    setBusy(item.id);
    const result = await intentsApi.cancel(item);
    if (result.data === null)
      toast({
        kind: 'err',
        title: 'Couldn’t stop it',
        sub: result.error ?? result.unavailable ?? '',
      });
    else toast({ kind: 'ok', title: 'Stopped', sub: cancelledLine(result.data) });
    await load();
    if (live.current) setBusy(null);
  };

  if (!items?.length) return null;
  return (
    <section className="home-section" aria-labelledby="home-what-im-on">
      <div className="home-section-head">
        <h2 id="home-what-im-on">What I’m on</h2>
      </div>
      <ul className="needs-you-list">
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            busy={busy !== null}
            onSave={save}
            onCancel={(chosen) => void cancel(chosen)}
          />
        ))}
      </ul>
    </section>
  );
}
