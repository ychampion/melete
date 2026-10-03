/**
 * Settings → Approvals: what agents may do without asking. The person picks
 * between asking for everything and auto-review, and switches each kind of
 * low-risk action on or off. What always asks is listed, not switchable.
 */
import { useRef } from 'react';
import { Icon } from '../design/icons.tsx';
import { Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { ApprovalSettings } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

type Mode = ApprovalSettings['mode'];
type ClassKey = keyof ApprovalSettings['classes'];

const MODES: readonly { value: Mode; title: string; sub: string }[] = [
  {
    value: 'auto_review',
    title: 'Auto-review low-risk',
    sub: 'Work inside an agent’s own workspace goes ahead. The kinds of change you switch on below are checked by an independent reviewer first, and anything it is unsure of comes to you.',
  },
  {
    value: 'ask',
    title: 'Ask me for everything',
    sub: 'Every change an agent wants to make waits for your yes. Reading, and drafts kept for you, never do.',
  },
];

const CLASSES: readonly { key: ClassKey; title: string; sub: string; reviewed: boolean }[] = [
  {
    key: 'sandbox',
    title: 'Work in the agent’s own workspace',
    sub: 'Commands, files and its own browser. Decided by a fixed rule, with a receipt for each.',
    reviewed: false,
  },
  {
    key: 'calendar',
    title: 'Events on your own calendar',
    sub: 'Adding or moving an event with no guests. Agents set to ask before acting still ask.',
    reviewed: true,
  },
  {
    key: 'app_changes',
    title: 'Reversible changes in connected apps',
    sub: 'Creating or editing something the app can take back, like a task or a note.',
    reviewed: true,
  },
  {
    key: 'apps',
    title: 'Publishing your apps',
    sub: 'A new app or version, or an earlier version, for the same people as now. Decided by a fixed rule, with a receipt for each. Switch it off to be asked every time.',
    reviewed: false,
  },
];

const ALWAYS_ASKS = [
  'Paying or spending money',
  'Sending, publishing or submitting anything, except an app for the same people as now',
  'An app that new people could open, that uses WebRTC, or that shows new data',
  'Deleting or removing anything',
  'Passwords, keys, codes or card details',
  'A recipient, place or amount you didn’t give Melete yourself',
];

export function ApprovalsTab() {
  const loaded = useLoad(() => adapter.approvalSettings(), []);
  // Controls stay enabled while a save is in flight, so focus stays where the keyboard left
  // it; only the answer to the latest save is shown.
  const latest = useRef(0);
  const settings = loaded.data?.settings ?? null;
  const reviewer = loaded.data?.reviewer_available ?? true;

  const save = (next: ApprovalSettings) => {
    const before = loaded.data;
    if (!before) return;
    loaded.set({ ...before, settings: next });
    const turn = ++latest.current;
    void adapter.saveApprovalSettings(next).then((r) => {
      if (turn !== latest.current) return;
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t save that' });
        loaded.reload();
        return;
      }
      loaded.set(r.data);
      toast({ kind: 'ok', title: 'Approvals updated' });
    });
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        Choose what agents may do without asking you. Every action still leaves a receipt, and
        anything auto-review let through says why.
      </p>
      {loaded.error ? (
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>{loaded.error}</p>
      ) : loaded.unavailable ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>{loaded.unavailable}</p>
      ) : null}
      {settings ? (
        <>
          <fieldset className="card-12 approvals-modes">
            <legend className="sr-only">When agents ask you</legend>
            {MODES.map((mode) => (
              <label key={mode.value} className="list-row approvals-row">
                <input
                  type="radio"
                  className="radio"
                  name="approval-mode"
                  value={mode.value}
                  checked={settings.mode === mode.value}
                  onChange={() => save({ ...settings, mode: mode.value })}
                />
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="approvals-title">{mode.title}</span>
                  <span className="approvals-sub">{mode.sub}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <section className="col" style={{ gap: 8 }} aria-labelledby="approvals-classes">
            <h2 id="approvals-classes" className="approvals-head">
              What auto-review may decide
            </h2>
            {!reviewer ? (
              <p style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 560 }}>
                No reviewer is set up on this installation, so the reviewed kinds below still come
                to you.
              </p>
            ) : null}
            <div
              className="card-12"
              style={{ overflow: 'hidden' }}
              data-inactive={settings.mode === 'ask' ? 'true' : undefined}
            >
              <div style={{ height: 1 }} />
              {CLASSES.map((item) => (
                <div key={item.key} className="list-row approvals-row">
                  <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span className="approvals-title">
                      {item.title}
                      {item.reviewed ? <span className="approvals-tag">Reviewed</span> : null}
                    </span>
                    <span className="approvals-sub">{item.sub}</span>
                  </span>
                  <Toggle
                    on={settings.classes[item.key]}
                    label={item.title}
                    disabled={settings.mode === 'ask'}
                    onChange={(on) =>
                      save({ ...settings, classes: { ...settings.classes, [item.key]: on } })
                    }
                  />
                </div>
              ))}
            </div>
            {settings.mode === 'ask' ? (
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                These apply when auto-review is on.
              </p>
            ) : null}
          </section>

          <section className="col" style={{ gap: 8 }} aria-labelledby="approvals-always">
            <h2 id="approvals-always" className="approvals-head">
              Always asks you
            </h2>
            <ul className="card-12 approvals-always">
              {ALWAYS_ASKS.map((line) => (
                <li key={line}>
                  <Icon name="lock" size={14} className="approvals-lock" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 560 }}>
              The reviewer can only let something through or send it to you. If it is slow, unsure
              or gives an answer that doesn’t read, you decide.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
