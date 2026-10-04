/**
 * Automations: routines that run on a schedule. The trigger is a sentence
 * from the service; each card carries its recent runs, what each said or why
 * it did not finish, a link to the thread with the whole answer, and a test
 * run. Creating one takes the days, the time and the agent.
 *
 * A routine set up in a conversation is background work that repeats. It is
 * listed here too, with its schedule, next time, pause and stop, so every
 * schedule the person has is in one place.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import {
  Badge,
  Button,
  Chip,
  Dialog,
  Field,
  Input,
  Overline,
  Select,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { defaultAgentOf, useApp, useLoad } from '../experience/hooks.ts';
import { plainRunReason, plainSchedule } from '../experience/plain.ts';
import type { Automation, AutomationRun, Run } from '../experience/types.ts';
import { href } from '../router.ts';
import { isFinished, isPaused, standingLine } from '../runs/words.ts';
import { RailToggle, Shell, toast } from '../shell/Shell.tsx';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const when = (iso: string) => {
  const date = new Date(iso);
  const today = new Date().toDateString();
  const day =
    date.toDateString() === today
      ? 'Today'
      : date.toDateString() === new Date(Date.now() - 86_400_000).toDateString()
        ? 'Yesterday'
        : date.toLocaleDateString('en-US', { weekday: 'short' });
  return `${day} at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

export const runLabel = (run: AutomationRun) =>
  run.status === 'done'
    ? 'Succeeded'
    : run.status === 'failed'
      ? 'Failed'
      : run.status === 'stopped'
        ? 'Stopped'
        : run.status === 'needs_you'
          ? 'Waiting for you'
          : 'Running';

export function RunRow({ run }: { run: AutomationRun }) {
  const ok = run.status === 'done';
  const stopped = run.status === 'stopped';
  const failed = run.status === 'failed' || stopped;
  const waiting = run.status === 'needs_you';
  const color = ok
    ? 'var(--success)'
    : stopped
      ? 'var(--muted)'
      : failed
        ? 'var(--danger)'
        : waiting
          ? 'var(--secondary)'
          : 'var(--primary)';
  return (
    <div className="col" style={{ gap: 2, padding: '6px 0' }}>
      <div className="row" style={{ gap: 10, minHeight: 24 }}>
        <span className="row" style={{ justifyContent: 'center', width: 18, height: 18, color }}>
          {ok ? (
            <Icon name="circleCheck" size={16} />
          ) : failed ? (
            <Icon name="circleX" size={16} />
          ) : waiting ? (
            <Icon name="info" size={16} />
          ) : (
            <Icon name="loader" size={14} stroke={2} className="spin" />
          )}
        </span>
        {/* The status gives way before the link does, so "Open result" never sits alone. */}
        <span className="clamp1 grow" style={{ fontSize: 13, minWidth: 0 }}>
          <span style={{ color: 'var(--text)' }}>{runLabel(run)}</span>
          <span style={{ color: 'var(--muted)' }}> · {when(run.started_at)}</span>
        </span>
        {run.conversation_id ? (
          <a
            href={href(`/chat/${run.conversation_id}`)}
            style={{ fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}
            className="section-link"
          >
            Open result
          </a>
        ) : null}
      </div>
      {run.summary ? (
        <p
          style={{
            fontSize: 13,
            lineHeight: '19px',
            color: 'var(--secondary)',
            paddingLeft: 28,
            overflowWrap: 'anywhere',
          }}
        >
          {run.summary}
        </p>
      ) : null}
      {run.reason ? (
        <p
          style={{
            fontSize: 12,
            lineHeight: '18px',
            color: failed && !stopped ? 'var(--danger)' : 'var(--muted)',
            paddingLeft: 28,
            overflowWrap: 'anywhere',
          }}
        >
          {plainRunReason(run.reason)}
        </p>
      ) : null}
    </div>
  );
}

/** A routine card's top line: its icon, name, schedule in words, and whether it is on. */
function RoutineHead({
  title,
  schedule,
  state,
}: {
  title: string;
  schedule: string;
  state: 'on' | 'paused' | 'stopped';
}) {
  return (
    <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
      <span
        className="row"
        style={{
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 10,
          background: 'var(--soft)',
          border: '1px solid var(--line)',
          color: 'var(--secondary)',
          flexShrink: 0,
        }}
      >
        <Icon name="automations" size={20} />
      </span>
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>{title}</span>
        <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{schedule}</span>
      </div>
      <Badge tone={state === 'on' ? 'success' : 'neutral'} dot={state === 'on'}>
        {state === 'stopped' ? 'Stopped' : state === 'on' ? 'On' : 'Paused'}
      </Badge>
    </div>
  );
}

export function RoutineCard({
  automation,
  onChange,
  onRemoved,
  onReplaced,
}: {
  automation: Automation;
  onChange: (next: Automation) => void;
  onRemoved: (id: string) => void;
  /** An ended routine was started again; the new one takes its place. */
  onReplaced: (id: string, next: Automation) => void;
}) {
  const [busy, setBusy] = useState<'test' | 'switch' | 'restart' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const toggle = () => {
    setBusy('switch');
    const change = automation.enabled ? adapter.pauseAutomation : adapter.resumeAutomation;
    void change(automation.id).then((r) => {
      setBusy(null);
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t change it' });
        return;
      }
      onChange(r.data.automation);
    });
  };
  const restart = () => {
    setBusy('restart');
    void adapter.restartAutomation(automation.id).then((r) => {
      setBusy(null);
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t start it again' });
        return;
      }
      onReplaced(automation.id, r.data.automation);
      toast({
        kind: 'info',
        title: `${automation.title} is on again`,
        sub: 'It runs at its next scheduled time.',
      });
    });
  };
  const remove = () => {
    setBusy('remove');
    void adapter.deleteAutomation(automation.id).then((r) => {
      setBusy(null);
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t delete it' });
        return;
      }
      onRemoved(automation.id);
      toast({
        kind: 'info',
        title: `${automation.title} is deleted`,
        sub: 'It will not run again. Its thread and results are gone; what it did outside Melete stays in Activity.',
      });
    });
  };
  return (
    <div className="card-pad">
      <RoutineHead
        title={automation.title}
        schedule={plainSchedule(automation.schedule)}
        state={automation.ended ? 'stopped' : automation.enabled ? 'on' : 'paused'}
      />
      <div className="col">
        <Overline style={{ paddingBottom: 4 }}>Last runs</Overline>
        {automation.runs.slice(0, 4).map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
        {automation.runs.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>Not run yet</span>
        ) : null}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {automation.ended ? null : (
          <Button
            size="sm"
            variant="outline"
            icon="refresh"
            loading={busy === 'test'}
            disabled={busy !== null || !automation.enabled}
            onClick={() => {
              setBusy('test');
              void adapter.testAutomation(automation.id).then(async (r) => {
                setBusy(null);
                if (r.data === null) {
                  toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t run it' });
                  return;
                }
                const fresh = await adapter.automations();
                const next = fresh.data?.automations.find((a) => a.id === automation.id);
                if (next) onChange(next);
                toast({
                  kind: 'info',
                  title: `${automation.title} is running now`,
                  sub: 'Its answer appears in its thread and on Home. Nothing goes out that would not go out on schedule.',
                });
              });
            }}
          >
            Test run
          </Button>
        )}
        {automation.ended ? (
          <Button
            size="sm"
            variant="outline"
            icon="refresh"
            loading={busy === 'restart'}
            disabled={busy !== null}
            onClick={restart}
          >
            Start again
          </Button>
        ) : null}
        {automation.ended ? null : (
          <Button
            size="sm"
            variant="outline"
            loading={busy === 'switch'}
            disabled={busy !== null}
            onClick={toggle}
          >
            {automation.enabled ? 'Pause' : 'Resume'}
          </Button>
        )}
        {automation.runs.some((run) => run.conversation_id) ? (
          <a href={href(`/chat/${automation.conversation_id}`)} className="btn btn-sm btn-ghost">
            All results
          </a>
        ) : null}
        {confirming ? (
          <>
            <span
              id={`delete-${automation.id}`}
              style={{ fontSize: 13, color: 'var(--secondary)' }}
            >
              This also deletes its thread and every result in it. What it did outside Melete stays
              in Activity.
            </span>
            <Button
              size="sm"
              aria-describedby={`delete-${automation.id}`}
              variant="destructive"
              loading={busy === 'remove'}
              disabled={busy !== null}
              onClick={remove}
            >
              Delete routine
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

/** Background work that repeats, as set up in a conversation: shown as the routine it is. */
export const repeats = (run: Run) => run.standing !== null && !isFinished(run.status);

export function RepeatingWorkCard({
  run,
  onChange,
  onStopped,
}: {
  run: Run;
  onChange: (next: Run) => void;
  onStopped: (id: string) => void;
}) {
  const [busy, setBusy] = useState<'switch' | 'stop' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const paused = isPaused(run);
  const toggle = () => {
    setBusy('switch');
    void (paused ? adapter.resumeRun : adapter.pauseRun)(run.id).then((r) => {
      setBusy(null);
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t change it' });
        return;
      }
      onChange(r.data.run);
    });
  };
  const stop = () => {
    setBusy('stop');
    void adapter.stopRun(run.id).then((r) => {
      setBusy(null);
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t stop it' });
        return;
      }
      onStopped(run.id);
      toast({
        kind: 'info',
        title: `${run.title} is stopped`,
        sub: 'It will not run again. What it found stays in its record.',
      });
    });
  };
  return (
    <div className="card-pad">
      <RoutineHead
        title={run.title}
        schedule={standingLine(run) ?? run.status_line}
        state={paused ? 'paused' : 'on'}
      />
      <div className="col" style={{ gap: 2 }}>
        <Overline style={{ paddingBottom: 4 }}>Latest</Overline>
        <span style={{ fontSize: 13, color: 'var(--secondary)', overflowWrap: 'anywhere' }}>
          {run.latest_report?.title ?? run.status_line}
        </span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="outline"
          loading={busy === 'switch'}
          disabled={busy !== null}
          onClick={toggle}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <a href={href(`/runs/${run.id}`)} className="btn btn-sm btn-ghost">
          Open
        </a>
        {confirming ? (
          <>
            <span id={`stop-${run.id}`} style={{ fontSize: 13, color: 'var(--secondary)' }}>
              It stops for good and its schedule is removed. What it found stays in its record.
            </span>
            <Button
              size="sm"
              aria-describedby={`stop-${run.id}`}
              variant="destructive"
              loading={busy === 'stop'}
              disabled={busy !== null}
              onClick={stop}
            >
              Stop routine
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function NewRoutineDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (a: Automation) => void;
}) {
  const { agents } = useApp();
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [at, setAt] = useState('08:30');
  const [agentId, setAgentId] = useState(defaultAgentOf(agents)?.id ?? '');
  const [busy, setBusy] = useState(false);
  const agent = agentId || defaultAgentOf(agents)?.id || '';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New routine"
      sub="Say what should happen, and when. The schedule comes back as a sentence."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!title.trim() || !instruction.trim() || days.length === 0 || !agent}
            onClick={() => {
              setBusy(true);
              void adapter
                .createAutomation({
                  title: title.trim(),
                  instruction: instruction.trim(),
                  weekdays: days,
                  at,
                  agent_id: agent,
                })
                .then((r) => {
                  setBusy(false);
                  if (r.data) {
                    onCreated(r.data.automation);
                    onClose();
                  } else
                    toast({
                      kind: 'err',
                      title: r.error ?? r.unavailable ?? 'Couldn’t create the routine',
                    });
                });
            }}
          >
            Create routine
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Morning brief"
          width="100%"
          autoFocus
        />
      </Field>
      <Field label="What it does">
        <Input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Today’s events, open tasks and the weather"
          width="100%"
        />
      </Field>
      <Field label="Days">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {WEEKDAYS.map((label, index) => (
            <Chip
              key={label}
              on={days.includes(index)}
              onClick={() =>
                setDays((d) => (d.includes(index) ? d.filter((x) => x !== index) : [...d, index]))
              }
            >
              {label}
            </Chip>
          ))}
        </div>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <Field label="At">
          <Input type="time" value={at} onChange={(e) => setAt(e.target.value)} width="100%" />
        </Field>
        <Field label="Who runs it">
          <Select
            label="Who runs it"
            value={agent}
            onChange={setAgentId}
            width="100%"
            options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.role}` }))}
          />
        </Field>
      </div>
    </Dialog>
  );
}

export function AutomationsScreen() {
  const data = useLoad(() => adapter.automations(), []);
  const work = useLoad(() => adapter.runs(), []);
  const [creating, setCreating] = useState(false);
  const list = data.data?.automations ?? [];
  const runs = work.data?.runs ?? [];
  const repeating = runs.filter(repeats);
  const update = (next: Automation) =>
    data.set({ automations: list.map((a) => (a.id === next.id ? next : a)) });
  const updateRun = (next: Run) =>
    work.set({ runs: runs.map((r) => (r.id === next.id ? next : r)) });
  return (
    <Shell title="Automations">
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Automations</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              Routines that run on a schedule, and tell you what they did.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button icon="plus" onClick={() => setCreating(true)}>
              New routine
            </Button>
            <RailToggle />
          </div>
        </div>
        {data.error ? (
          <LoadError what="your routines" error={data.error} onRetry={data.reload} />
        ) : null}
        {work.error ? (
          <LoadError what="your background routines" error={work.error} onRetry={work.reload} />
        ) : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 12,
          }}
        >
          {list.map((automation) => (
            <RoutineCard
              key={automation.id}
              automation={automation}
              onChange={update}
              onRemoved={(id) => data.set({ automations: list.filter((a) => a.id !== id) })}
              onReplaced={(id, next) =>
                data.set({ automations: list.map((a) => (a.id === id ? next : a)) })
              }
            />
          ))}
          {repeating.map((run) => (
            <RepeatingWorkCard
              key={run.id}
              run={run}
              onChange={updateRun}
              onStopped={(id) => work.set({ runs: runs.filter((r) => r.id !== id) })}
            />
          ))}
        </div>
        {data.data && !data.error && list.length === 0 && repeating.length === 0 ? (
          <div
            className="col"
            style={{ alignItems: 'center', gap: 8, padding: '32px 24px', textAlign: 'center' }}
          >
            <span
              style={{
                fontFamily: 'var(--font-head)',
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--heading)',
              }}
            >
              No routines yet
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              A morning brief is a good first one.
            </span>
          </div>
        ) : null}
      </div>
      <NewRoutineDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(a) => data.set({ automations: [a, ...list] })}
      />
    </Shell>
  );
}
