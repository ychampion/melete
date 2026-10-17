/**
 * Settings › Installation, for the person who runs this Melete for others:
 * how the installation is doing, everyone's account with what they spent
 * against their caps, and a record of every change made here. The service
 * answers these pages to the installation's owner alone; everyone else never
 * sees the tab.
 *
 * Every link that sets a password is shown to copy, whether or not it was
 * also emailed, so an installation without mail can still bring people in.
 */
import { useState } from 'react';
import { LoadError } from '../design/LoadError.tsx';
import { Badge, type BadgeTone, Button, Dialog, Field, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type {
  AccountRemovalPreview,
  OperatorAuditEntry,
  OperatorCaps,
  OperatorOneTimeLink,
  OperatorOverview,
  OperatorPerson,
} from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';
import { DeleteAccountDialog } from './AccountData.tsx';

/**
 * The people with a request under way. A person's buttons stay busy until
 * their own request ends, whatever happens to anyone else's, and a second
 * click while one is under way does nothing, so a reset link is never made
 * twice by a double click or a click on another row in between.
 */
export class InFlight {
  private readonly ids = new Set<string>();
  constructor(private readonly changed: (ids: ReadonlySet<string>) => void) {}

  /** Runs `work` for a person, or answers null when one is already under way. */
  async run<T>(id: string, work: () => Promise<T>): Promise<T | null> {
    if (this.ids.has(id)) return null;
    this.ids.add(id);
    this.changed(new Set(this.ids));
    try {
      return await work();
    } finally {
      this.ids.delete(id);
      this.changed(new Set(this.ids));
    }
  }
}

/* ---------- words, kept apart so they can be tested without a page ---------- */

export const usd = (amount: number) =>
  `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "$4.20 of $50.00", or "$4.20, no cap" when nothing limits it. */
export const spentOf = (spent: number, cap: number | null) =>
  cap === null ? `${usd(spent)}, no cap` : `${usd(spent)} of ${usd(cap)}`;

/**
 * The day a month's spending starts again. The service resets at midnight UTC
 * on the first, so the day is read in UTC: on a clock behind UTC the local
 * date would be the last day of the month before.
 */
export const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const momentOf = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** How long ago, in the largest whole unit: "just now", "5 minutes ago", "3 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 60) return say(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return say(hours, 'hour');
  return say(Math.floor(hours / 24), 'day');
}

export const STATUS: Record<OperatorPerson['status'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'outline' },
  disabled: { label: 'Turned off', tone: 'danger' },
  removing: { label: 'Being deleted', tone: 'neutral' },
};

/** The newest backup, and whether it is older than the installation allows. */
export function backupLine(
  backup: OperatorOverview['backup'],
  now = Date.now(),
): { text: string; ok: boolean } {
  if (!backup.newest_at) return { text: 'None noted yet', ok: false };
  const hours = (now - new Date(backup.newest_at).getTime()) / 3_600_000;
  return { text: `Taken ${ago(backup.newest_at, now)}`, ok: hours <= backup.max_age_hours };
}

const who = (side: { email: string | null }, fallback: string) => side.email ?? fallback;

/** One change, as a sentence: who did what to whom. Never a link or a code. */
export function auditSentence(entry: OperatorAuditEntry): string {
  const actor = who(entry.actor, 'The command line on the server');
  const target = who(entry.target, 'someone since deleted');
  const account = entry.target.email
    ? `${entry.target.email}’s account`
    : 'an account since deleted';
  const said: Record<OperatorAuditEntry['action'], string> = {
    invited: `invited ${target}`,
    invite_resent: `sent ${target} a new invite`,
    reset_sent: `sent ${target} a password reset`,
    disabled: `turned off ${account}`,
    enabled: `turned ${account} back on`,
    caps_changed: `changed the caps on ${account}`,
    removed: `deleted ${account}`,
  };
  return `${actor} ${said[entry.action]}`;
}

/**
 * What the owner typed into a cap: blank keeps the installation's (null), a
 * dollar amount is that amount, anything else is a mistake to point out.
 */
export function readCap(text: string): number | null | 'invalid' {
  const trimmed = text.trim().replace(/^\$/, '').replaceAll(',', '');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 'invalid';
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount > 0 ? amount : 'invalid';
}

const CAP_FIELDS: { key: keyof OperatorCaps; label: string }[] = [
  { key: 'day_usd', label: 'Each day' },
  { key: 'month_usd', label: 'Each month' },
  { key: 'background_day_usd', label: 'Background work, each day' },
  { key: 'background_month_usd', label: 'Background work, each month' },
];

const problemOf = (
  result: { error: string | null; unavailable: string | null },
  fallback: string,
) => result.error ?? result.unavailable ?? fallback;

/* ---------- the installation at a glance ---------- */

function Tile({
  label,
  value,
  note,
  warn = false,
}: {
  label: string;
  value: string;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div className="card-12 col operator-tile" data-warn={warn ? 'true' : undefined}>
      <span className="operator-tile-label">{label}</span>
      <span className="operator-tile-value">{value}</span>
      {note ? <span className="operator-tile-note">{note}</span> : null}
    </div>
  );
}

export function OverviewTiles({ overview, now }: { overview: OperatorOverview; now?: number }) {
  const { spend, people, runs, computers, disk, health } = overview;
  const backup = backupLine(overview.backup, now);
  const failing = health.checks.filter((check) => !check.ok);
  const perPerson = (limit: number | null) => (limit ? `, ${limit} each` : '');
  return (
    <section className="col" style={{ gap: 8 }} aria-labelledby="operator-glance">
      <h2 id="operator-glance" className="operator-head">
        This installation
      </h2>
      <div className="operator-tiles">
        <Tile
          label="Spent this month"
          value={spentOf(spend.month_usd, spend.month_cap_usd)}
          note={`Starts again ${dayOf(spend.month_resets_at)}`}
          warn={spend.month_cap_usd !== null && spend.month_usd >= spend.month_cap_usd}
        />
        <Tile
          label="Spent today"
          value={spentOf(spend.day_usd, spend.day_cap_usd)}
          warn={spend.day_cap_usd !== null && spend.day_usd >= spend.day_cap_usd}
        />
        <Tile
          label="People"
          value={`${people.active} active of ${people.total}`}
          note={`${people.invited} invited, ${people.disabled} turned off. Active means seen in the last 7 days.`}
        />
        <Tile
          label="Agent runs going now"
          value={`${runs.used} of ${runs.limit}`}
          note={`At most ${runs.limit} at once${perPerson(runs.per_person)}`}
          warn={runs.used >= runs.limit}
        />
        <Tile
          label="Agent computers running"
          value={`${computers.used} of ${computers.limit}`}
          note={`At most ${computers.limit} at once${perPerson(computers.per_person)}`}
          warn={computers.used >= computers.limit}
        />
        <Tile
          label="Newest backup"
          value={backup.text}
          note={
            backup.ok
              ? `Counts as stale after ${overview.backup.max_age_hours} hours`
              : 'Run melete backup on the server, or check its schedule'
          }
          warn={!backup.ok}
        />
        {disk ? (
          <Tile
            label="Free disk"
            value={disk.free_mb === null ? 'Not measured' : `${disk.free_mb.toLocaleString()} MB`}
            note={`Keeps at least ${disk.floor_mb.toLocaleString()} MB free`}
            warn={!disk.ok}
          />
        ) : null}
        <Tile
          label="Health"
          value={health.status === 'ok' ? 'Everything is working' : 'Needs a look'}
          note={
            failing.length
              ? failing.map((check) => `${check.name}: ${check.detail}`).join('. ')
              : `Version ${overview.version}`
          }
          warn={health.status !== 'ok'}
        />
      </div>
    </section>
  );
}

/* ---------- one-time links ---------- */

/** A link that sets a password, to copy and pass on, with when it stops working. */
export function OneTimeLink({ link, email }: { link: OperatorOneTimeLink; email: string }) {
  const [copied, setCopied] = useState(false);
  const shown = link.link ?? link.code;
  const what = link.purpose === 'invite' ? 'invite' : 'password reset';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
    } catch {
      toast({ kind: 'err', title: 'Couldn’t copy it. Select it and copy it instead.' });
    }
  };
  return (
    <div className="col" style={{ gap: 8 }} role="status">
      <span style={{ fontSize: 13, color: 'var(--text)' }}>
        {link.emailed
          ? `The ${what} was emailed to ${email}. You can also pass on this link yourself.`
          : link.mail_problem
            ? `The ${what} could not be emailed: ${link.mail_problem} The link still works, so pass it on yourself.`
            : `Send this ${link.link ? 'link' : 'code'} to ${email} yourself.`}
      </span>
      <div className="row" style={{ gap: 8, minWidth: 0 }}>
        <Input
          readOnly
          value={shown}
          aria-label={link.link ? `The ${what} link` : `The ${what} code`}
          onFocus={(event) => event.currentTarget.select()}
          width="100%"
        />
        <Button size="sm" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        {link.link
          ? 'It works once'
          : 'They enter it under “Forgot your password?” on the sign-in page. It works once'}
        , until {momentOf(link.expires_at)}. This is the only time it is shown.
      </span>
    </div>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; invite: OperatorOneTimeLink } | null>(null);
  const send = async () => {
    setBusy(true);
    setProblem(null);
    const done = await adapter.invitePerson(email.trim());
    setBusy(false);
    if (done.data === null) {
      setProblem(problemOf(done, 'Couldn’t invite them.'));
      return;
    }
    setSent({ email: done.data.person.email ?? email.trim(), invite: done.data.invite });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      icon="mail"
      title={sent ? `${sent.email} is invited` : 'Invite someone'}
      sub={
        sent
          ? undefined
          : 'They get an account of their own, with their own space, and choose a password from the link.'
      }
      footer={
        sent ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="operator-invite"
              loading={busy}
              disabled={busy || !email.includes('@')}
            >
              Invite
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <OneTimeLink link={sent.invite} email={sent.email} />
      ) : (
        <form
          id="operator-invite"
          className="col"
          style={{ gap: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && email.includes('@')) void send();
          }}
        >
          <Field label="Their email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
              autoFocus
              width="100%"
            />
          </Field>
          {problem ? (
            <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
              {problem}
            </span>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

/* ---------- one person ---------- */

function CapsDialog({
  person,
  defaults,
  onClose,
  onSaved,
}: {
  person: OperatorPerson;
  defaults: OperatorCaps;
  onClose: () => void;
  onSaved: (person: OperatorPerson) => void;
}) {
  const start = (value: number | null) => (value === null ? '' : String(value));
  const [typed, setTyped] = useState<Record<keyof OperatorCaps, string>>({
    day_usd: start(person.caps.own.day_usd),
    month_usd: start(person.caps.own.month_usd),
    background_day_usd: start(person.caps.own.background_day_usd),
    background_month_usd: start(person.caps.own.background_month_usd),
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (caps: OperatorCaps) => {
    setBusy(true);
    setProblem(null);
    const done = await adapter.setPersonCaps(person.id, caps);
    setBusy(false);
    if (done.data === null) {
      setProblem(problemOf(done, 'Couldn’t save the caps.'));
      return;
    }
    onSaved(done.data.person);
  };
  const submit = () => {
    const caps = {} as OperatorCaps;
    for (const { key, label } of CAP_FIELDS) {
      const read = readCap(typed[key]);
      if (read === 'invalid') {
        setProblem(`${label}: type a dollar amount, such as 5 or 12.50, or leave it blank.`);
        return;
      }
      caps[key] = read;
    }
    void save(caps);
  };
  const name = person.email ?? 'this account';
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      icon="piggy"
      title={`Spending caps for ${name}`}
      sub="Leave a cap blank to keep the installation’s. A cap of their own can’t pass what the whole installation may spend."
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void save({
                day_usd: null,
                month_usd: null,
                background_day_usd: null,
                background_month_usd: null,
              })
            }
          >
            Use the installation’s
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="operator-caps" loading={busy} disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="operator-caps"
        className="col"
        style={{ gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
      >
        {CAP_FIELDS.map(({ key, label }) => (
          <Field
            key={key}
            label={`${label} (USD)`}
            hint={
              defaults[key] === null
                ? 'The installation sets no cap here.'
                : `The installation’s: ${usd(defaults[key])}`
            }
          >
            <Input
              inputMode="decimal"
              value={typed[key]}
              placeholder={defaults[key] === null ? 'No cap' : String(defaults[key])}
              onChange={(event) => setTyped({ ...typed, [key]: event.target.value })}
              autoComplete="off"
              width="100%"
            />
          </Field>
        ))}
        {problem ? (
          <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
            {problem}
          </span>
        ) : null}
      </form>
    </Dialog>
  );
}

function TurnOffDialog({
  person,
  onClose,
  onDone,
}: {
  person: OperatorPerson;
  onClose: () => void;
  onDone: (person: OperatorPerson) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      icon="lock"
      tone="danger"
      title={`Turn off ${person.email ?? 'this account'}?`}
      sub="They are signed out everywhere at once. Until you turn the account back on, they can’t sign in and their routines and other work don’t run. Nothing of theirs is deleted."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              void adapter.setPersonDisabled(person.id, true).then((done) => {
                setBusy(false);
                if (done.data === null) setProblem(problemOf(done, 'Couldn’t turn it off.'));
                else onDone(done.data.person);
              });
            }}
          >
            Turn off
          </Button>
        </>
      }
    >
      {problem ? (
        <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {problem}
        </span>
      ) : null}
    </Dialog>
  );
}

/** A person's row: who, how they stand, what they spent, and what can be done. */
export function PersonRow({
  person,
  now,
  onCaps,
  onLink,
  onTurnOff,
  onTurnOn,
  onDelete,
  busy = false,
}: {
  person: OperatorPerson;
  now?: number;
  onCaps: () => void;
  onLink: () => void;
  onTurnOff: () => void;
  onTurnOn: () => void;
  onDelete: () => void;
  busy?: boolean;
}) {
  const status = STATUS[person.status];
  const name = person.email ?? 'An account being deleted';
  const own = Object.values(person.caps.own).some((cap) => cap !== null);
  const seen = person.last_active_at ? `Seen ${ago(person.last_active_at, now)}` : 'Not seen yet';
  return (
    <li className="list-row operator-person">
      <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span className="operator-person-name">
            {person.display_name ? `${person.display_name}, ` : ''}
            {name}
          </span>
          {person.owner ? <Badge tone="neutral">You, the owner</Badge> : null}
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
          {person.kind === 'guest' ? <Badge tone="outline">Room guest</Badge> : null}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {seen} · {spentOf(person.spend.month_usd, person.caps.effective.month_usd)} this month ·{' '}
          {spentOf(person.spend.day_usd, person.caps.effective.day_usd)} today
          {own ? ' · caps of their own' : ''}
        </span>
      </div>
      {person.status === 'removing' ? null : (
        <div className="row operator-actions">
          <Button size="sm" variant="outline" disabled={busy} onClick={onCaps}>
            Caps…
          </Button>
          {person.owner ? null : (
            <>
              {person.status === 'disabled' ? null : (
                <Button size="sm" variant="outline" disabled={busy} onClick={onLink}>
                  {person.status === 'invited' ? 'New invite link' : 'Reset password'}
                </Button>
              )}
              {person.status === 'disabled' ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy}
                  disabled={busy}
                  onClick={onTurnOn}
                >
                  Turn on
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy} onClick={onTurnOff}>
                  Turn off…
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onDelete}
                aria-label={`Delete ${name}`}
              >
                Delete…
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/* ---------- the record of changes ---------- */

export function AuditList({ entries }: { entries: OperatorAuditEntry[] }) {
  if (entries.length === 0)
    return (
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
        Nothing yet. Invites, caps, turning accounts off and deleting them show up here.
      </span>
    );
  return (
    <ul className="card-12 operator-audit">
      {entries.map((entry) => (
        <li key={entry.id} className="list-row" style={{ minHeight: 52 }}>
          <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: 'var(--text)', overflowWrap: 'anywhere' }}>
              {auditSentence(entry)}
            </span>
            {entry.detail ? (
              <span style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                {entry.detail}
              </span>
            ) : null}
          </div>
          <time dateTime={entry.at} style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
            {momentOf(entry.at)}
          </time>
        </li>
      ))}
    </ul>
  );
}

/* ---------- the tab ---------- */

type Open =
  | { kind: 'invite' }
  | { kind: 'caps'; person: OperatorPerson }
  | { kind: 'off'; person: OperatorPerson }
  | { kind: 'link'; person: OperatorPerson; link: OperatorOneTimeLink }
  | { kind: 'delete'; person: OperatorPerson; preview: AccountRemovalPreview };

export function OperatorTab() {
  const overview = useLoad(() => adapter.operatorOverview(), []);
  const people = useLoad(() => adapter.operatorPeople(), []);
  const audit = useLoad(() => adapter.operatorAudit(), []);
  const [open, setOpen] = useState<Open | null>(null);
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  const [inFlight] = useState(() => new InFlight(setWorking));

  /** After any change: the people, the record, and the counts at the top. */
  const changed = () => {
    people.reload();
    audit.reload();
    overview.reload();
  };
  const replace = (person: OperatorPerson) => {
    if (people.data)
      people.set({
        ...people.data,
        people: people.data.people.map((p) => (p.id === person.id ? person : p)),
      });
    audit.reload();
    overview.reload();
  };

  const sendLink = async (person: OperatorPerson) => {
    const done = await inFlight.run(person.id, () => adapter.sendPersonReset(person.id));
    if (done === null) return;
    if (done.data === null) {
      toast({ kind: 'err', title: 'Couldn’t make a link', sub: problemOf(done, '') });
      return;
    }
    replace(done.data.person);
    setOpen({ kind: 'link', person: done.data.person, link: done.data.reset });
  };
  const turnOn = async (person: OperatorPerson) => {
    const done = await inFlight.run(person.id, () => adapter.setPersonDisabled(person.id, false));
    if (done === null) return;
    if (done.data === null) {
      toast({ kind: 'err', title: 'Couldn’t turn it on', sub: problemOf(done, '') });
      return;
    }
    replace(done.data.person);
    toast({ kind: 'ok', title: `${person.email ?? 'The account'} can sign in again` });
  };
  const askDelete = async (person: OperatorPerson) => {
    const read = await inFlight.run(person.id, () => adapter.personRemovalPreview(person.id));
    if (read === null) return;
    if (read.data === null) {
      toast({ kind: 'err', title: 'Couldn’t check that account', sub: problemOf(read, '') });
      return;
    }
    setOpen({ kind: 'delete', person, preview: read.data.preview });
  };

  const list = people.data?.people ?? [];
  return (
    <div className="col" style={{ gap: 24 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560, margin: 0 }}>
        You run this Melete. Here is how it is doing, everyone who has an account, and every change
        made to their accounts. Only you see this page.
      </p>

      {overview.error ? (
        <LoadError what="the installation" error={overview.error} onRetry={overview.reload} />
      ) : overview.data ? (
        <OverviewTiles overview={overview.data} />
      ) : null}

      <section className="col" style={{ gap: 8 }} aria-labelledby="operator-people">
        <div className="row" style={{ gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <h2 id="operator-people" className="operator-head">
              People
            </h2>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              {people.data?.can_email
                ? 'Invites and reset links are emailed, and shown here to copy too.'
                : 'Mail isn’t set up, so you pass on invites and reset links yourself.'}
            </span>
          </div>
          <Button icon="plus" onClick={() => setOpen({ kind: 'invite' })}>
            Invite someone
          </Button>
        </div>
        {people.error ? (
          <LoadError what="the people" error={people.error} onRetry={people.reload} />
        ) : list.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {people.loading ? 'Loading…' : 'Nobody has an account yet.'}
          </span>
        ) : (
          <ul className="card-12 operator-people">
            {list.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                busy={working.has(person.id)}
                onCaps={() => setOpen({ kind: 'caps', person })}
                onLink={() => void sendLink(person)}
                onTurnOff={() => setOpen({ kind: 'off', person })}
                onTurnOn={() => void turnOn(person)}
                onDelete={() => void askDelete(person)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="col" style={{ gap: 8 }} aria-labelledby="operator-audit">
        <h2 id="operator-audit" className="operator-head">
          Changes
        </h2>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Who changed whose account, and when, newest first. Links and codes are never kept here.
        </span>
        {audit.error ? (
          <LoadError what="the changes" error={audit.error} onRetry={audit.reload} />
        ) : audit.data ? (
          <AuditList entries={audit.data.entries} />
        ) : null}
      </section>

      {open?.kind === 'invite' ? (
        <InviteDialog onClose={() => setOpen(null)} onDone={changed} />
      ) : null}
      {open?.kind === 'caps' && people.data ? (
        <CapsDialog
          person={open.person}
          defaults={people.data.defaults}
          onClose={() => setOpen(null)}
          onSaved={(person) => {
            setOpen(null);
            replace(person);
            toast({ kind: 'ok', title: `Caps saved for ${person.email ?? 'the account'}` });
          }}
        />
      ) : null}
      {open?.kind === 'off' ? (
        <TurnOffDialog
          person={open.person}
          onClose={() => setOpen(null)}
          onDone={(person) => {
            setOpen(null);
            replace(person);
            toast({
              kind: 'ok',
              title: `${person.email ?? 'The account'} is turned off`,
              sub: 'They were signed out everywhere.',
            });
          }}
        />
      ) : null}
      {open?.kind === 'link' ? (
        <Dialog
          open
          onClose={() => setOpen(null)}
          icon="mail"
          title={
            open.link.purpose === 'invite'
              ? `A new invite for ${open.person.email}`
              : `A password reset for ${open.person.email}`
          }
          sub={
            open.link.purpose === 'invite'
              ? 'Any earlier invite link for them stops working.'
              : 'Their password stays as it is until they use the link.'
          }
          footer={<Button onClick={() => setOpen(null)}>Done</Button>}
        >
          <OneTimeLink link={open.link} email={open.person.email ?? ''} />
        </Dialog>
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteAccountDialog
          open
          own={false}
          preview={open.preview}
          onClose={() => setOpen(null)}
          onDelete={async (email) => {
            const done = await adapter.removePerson(open.person.id, email);
            if (done.data === null) return problemOf(done, 'Couldn’t delete it.');
            setOpen(null);
            toast({
              kind: 'ok',
              title: `${open.preview.confirm} was deleted`,
              sub: 'Their spaces are being cleared now.',
            });
            changed();
            return null;
          }}
        />
      ) : null}
    </div>
  );
}
