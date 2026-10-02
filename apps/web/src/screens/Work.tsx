/**
 * Work in progress: bigger jobs an assistant keeps at in the background for
 * hours or days. The list shows where each stands; a page per piece of work
 * shows the latest update, what comes next, the best result so far, its
 * helpers, and the full record behind it, with a way to steer, pause or stop.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Button, Dialog, Field, Input, Status } from '../design/primitives.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import { useLoad, useNow } from '../experience/hooks.ts';
import type { Run, RunEntry } from '../experience/types.ts';
import { href, navigate } from '../router.ts';
import { usePoll } from '../runs/poll.ts';
import { RecordTimeline } from '../runs/Record.tsx';
import { useRun } from '../runs/useRun.ts';
import {
  ago,
  appendEntries,
  formatValue,
  helperWord,
  hoursFrom,
  isFinished,
  isPaused,
  keepsMoving,
  lastActivity,
  recordFileName,
  standingLine,
  statusOf,
  workOrder,
} from '../runs/words.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import '../runs/runs.css';

const failed = (result: Result<unknown>, fallback: string) =>
  toast({ kind: 'err', title: result.error ?? result.unavailable ?? fallback });

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- starting something ---------- */

function StartDialog({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (run: Run) => void;
}) {
  const [goal, setGoal] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const goalId = useId();
  const start = () => {
    setBusy(true);
    void adapter
      .createRun({
        goal: goal.trim(),
        ...(doneWhen.trim() ? { done_when: doneWhen.trim() } : {}),
      })
      .then((result) => {
        setBusy(false);
        if (!result.data) return failed(result, 'Couldn’t start it');
        setGoal('');
        setDoneWhen('');
        onStarted(result.data.run);
        onClose();
      });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start something bigger"
      sub="Your assistant keeps at it in the background and sends you updates."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy || !goal.trim()} onClick={start}>
            Start
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 6 }}>
        <label htmlFor={goalId} className="run-field-label">
          What should it work on?
        </label>
        <textarea
          id={goalId}
          className="textarea"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Find the best-reviewed physio near me who takes my insurance"
          rows={3}
          maxLength={4000}
          autoFocus
        />
      </div>
      <Field label="How will we know it’s done?" hint="Optional">
        <Input
          value={doneWhen}
          onChange={(event) => setDoneWhen(event.target.value)}
          placeholder="Three options with prices and openings this month"
          width="100%"
          maxLength={1000}
        />
      </Field>
    </Dialog>
  );
}

/* ---------- the list ---------- */

function WorkCard({ run, now }: { run: Run; now: number }) {
  const status = statusOf(run);
  const needs = run.status === 'needs_you';
  return (
    <a className="run-card" href={href(`/runs/${run.id}`)} data-needs={needs ? 'true' : undefined}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <span className="run-card-title grow">{run.title}</span>
        <Status tone={status.tone} quiet={!needs}>
          {status.word}
        </Status>
      </div>
      <span className="run-card-line">{run.status_line}</span>
      {run.standing ? <span className="run-card-repeat">{standingLine(run)}</span> : null}
      <span className="run-card-meta">
        Started {ago(run.started_at, now)} · updated {ago(lastActivity(run), now)}
      </span>
    </a>
  );
}

function WorkList() {
  const data = useLoad(() => adapter.runs(), []);
  const [starting, setStarting] = useState(false);
  const now = useNow(true, 60_000);
  const runs = workOrder(data.data?.runs ?? []);
  usePoll(
    data.reload,
    10_000,
    runs.some((run) => !isFinished(run.status)),
  );
  const open = runs.filter((run) => !isFinished(run.status));
  const finished = runs.filter((run) => isFinished(run.status));
  return (
    <Shell title="Work" rail={false}>
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Work in progress</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              Bigger jobs your assistants keep at in the background, for hours or days.
            </p>
          </div>
          <Button icon="plus" onClick={() => setStarting(true)}>
            Start something
          </Button>
        </div>
        {data.error ? (
          <LoadError what="your work" error={data.error} onRetry={data.reload} />
        ) : null}
        {data.unavailable ? <p className="run-muted">{data.unavailable}</p> : null}
        {open.length > 0 ? (
          <section className="col" style={{ gap: 10 }} aria-labelledby="work-open">
            <h2 id="work-open" className="run-section-title">
              Going now
            </h2>
            <div className="run-grid">
              {open.map((run) => (
                <WorkCard key={run.id} run={run} now={now} />
              ))}
            </div>
          </section>
        ) : null}
        {finished.length > 0 ? (
          <section className="col" style={{ gap: 10 }} aria-labelledby="work-finished">
            <h2 id="work-finished" className="run-section-title">
              Finished
            </h2>
            <div className="run-grid">
              {finished.map((run) => (
                <WorkCard key={run.id} run={run} now={now} />
              ))}
            </div>
          </section>
        ) : null}
        {data.data && !data.error && runs.length === 0 ? (
          <div className="run-empty">
            <span className="run-empty-icon" aria-hidden="true">
              <Icon name="progress" size={22} />
            </span>
            <span className="run-empty-title">Nothing in progress yet</span>
            <span className="run-muted" style={{ maxWidth: 420 }}>
              Hand over something that takes a while, like research or comparing options, and it
              keeps going here while you get on with your day.
            </span>
            <Button variant="outline" icon="plus" onClick={() => setStarting(true)}>
              Start something
            </Button>
          </div>
        ) : null}
      </div>
      <StartDialog
        open={starting}
        onClose={() => setStarting(false)}
        onStarted={(run) => navigate(`/runs/${run.id}`)}
      />
    </Shell>
  );
}

/* ---------- one piece of work ---------- */

function MessageBox({
  label,
  placeholder,
  action,
  onSend,
}: {
  label: string;
  placeholder: string;
  action: string;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const send = () => {
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    void onSend(clean).then((ok) => {
      setBusy(false);
      if (ok) setText('');
    });
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        className="textarea"
        rows={2}
        maxLength={4000}
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" icon="send" loading={busy} disabled={busy || !text.trim()} onClick={send}>
          {action}
        </Button>
      </div>
    </div>
  );
}

function Block({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section className="run-block" aria-labelledby={id}>
      <h2 id={id} className="run-block-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BestResult({ run }: { run: Run }) {
  const best = run.experiments.best;
  const count = run.experiments.count;
  if (count === 0) return null;
  return (
    <Block title="Best result" id="run-best">
      {best && best.value !== null ? (
        <div className="run-best">
          <span className="run-best-value voice tabular">{formatValue(best.value)}</span>
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            {run.metric ? <span className="run-best-name">{run.metric.name}</span> : null}
            <span className="run-best-title">{best.title}</span>
            {best.checked ? (
              <span className="run-checked">
                <Icon name="circleCheck" size={12} />
                confirmed from its output
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <span className="run-muted">
        {count} {count === 1 ? 'try' : 'tries'}
        {isFinished(run.status) ? '' : ' so far'}
        {run.metric ? ` · ${run.metric.direction === 'higher' ? 'higher' : 'lower'} is better` : ''}
      </span>
    </Block>
  );
}

/** The limit with a new number of hours, or without hours; null once nothing is left. */
export function withHours(limit: Run['limit'], hours: number | null): Run['limit'] {
  const { max_hours: _hours, ...rest } = limit ?? {};
  const next = hours === null ? rest : { ...rest, max_hours: hours };
  return Object.keys(next).length > 0 ? next : null;
}

function LimitControl({
  run,
  act,
}: {
  run: Run;
  act: (call: () => Promise<Result<{ run: Run }>>) => Promise<Result<{ run: Run }>>;
}) {
  const current = run.limit?.max_hours ?? null;
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(current ? String(current) : '');
  const [busy, setBusy] = useState(false);
  const save = (value: number | null) => {
    setBusy(true);
    void act(() => adapter.setRunLimit(run.id, withHours(run.limit, value))).then((result) => {
      setBusy(false);
      if (!result.data) return failed(result, 'Couldn’t set the limit');
      setOpen(false);
      toast({
        kind: 'info',
        title: value === null ? 'No time limit now' : `It stops after ${formatValue(value)} hours`,
      });
    });
  };
  if (!open)
    return (
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {current ? (
          <span className="run-muted">Stops after {formatValue(current)} hours</span>
        ) : null}
        <Button size="sm" variant="ghost" icon="clock" onClick={() => setOpen(true)}>
          {current ? 'Change the limit' : 'Set a limit'}
        </Button>
      </div>
    );
  const value = hoursFrom(hours);
  return (
    <div className="run-limit">
      <Field label="Stop after this many hours">
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="decimal"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
          width={120}
          autoFocus
        />
      </Field>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          loading={busy}
          disabled={busy || value === null}
          onClick={() => save(value)}
        >
          Save
        </Button>
        {current ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save(null)}>
            No limit
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The record, read a page at a time once the person opens it. */
function useRecord(id: string, open: boolean) {
  const [entries, setEntries] = useState<RunEntry[]>([]);
  // Where the next page starts; null once the end has been read.
  const [cursor, setCursor] = useState<string | null>(null);
  // Where the last page started, to look for newer entries at the end.
  const tail = useRef<string | null>(null);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const read = useCallback(
    (after: string | null) => {
      setLoading(true);
      void adapter.runRecord(id, after).then((result) => {
        setLoading(false);
        if (!result.data) return failed(result, 'Couldn’t load the record');
        const page = result.data;
        tail.current = after;
        setEntries((shown) => appendEntries(shown, page.entries));
        setCursor(page.next_cursor);
      });
    },
    [id],
  );
  useEffect(() => {
    if (open && !started) {
      setStarted(true);
      read(null);
    }
  }, [open, started, read]);
  return {
    entries,
    more: cursor !== null,
    loading,
    loadMore: () => (cursor ? read(cursor) : undefined),
    /** Newer entries, once every older page is shown. */
    refresh: () => {
      if (started && cursor === null && !loading) read(tail.current);
    },
  };
}

function WorkDetail({ id }: { id: string }) {
  const data = useRun(id);
  const run = data.run;
  const now = useNow(true, 60_000);
  const [busy, setBusy] = useState<'pause' | 'stop' | 'download' | null>(null);
  const [stopping, setStopping] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const record = useRecord(id, recordOpen);
  usePoll(
    () => {
      data.reload();
      if (recordOpen) record.refresh();
    },
    5_000,
    run !== null && keepsMoving(run.status),
  );

  if (!run)
    return (
      <Shell title="Work" rail={false} phoneBack={() => navigate('/runs')}>
        <div className="page">
          <a className="section-link" href={href('/runs')}>
            <Icon name="chevronLeft" size={14} />
            All work
          </a>
          {data.error ? (
            <LoadError what="this work" error={data.error} onRetry={data.reload} />
          ) : null}
          {data.unavailable ? <p className="run-muted">{data.unavailable}</p> : null}
        </div>
      </Shell>
    );

  const status = statusOf(run);
  const finished = isFinished(run.status);
  const paused = isPaused(run);
  const helpers = new Map(run.steps.map((step) => [step.id, step.title]));

  const act = (
    kind: 'pause' | 'stop',
    call: () => Promise<Result<{ run: Run }>>,
    fallback: string,
  ) => {
    setBusy(kind);
    void data.act(call).then((result) => {
      setBusy(null);
      if (!result.data) failed(result, fallback);
    });
  };
  const message = async (text: string) => {
    const reopening = finished;
    const result = await data.act(() => adapter.messageRun(run.id, text));
    if (!result.data) {
      failed(result, 'Couldn’t send that');
      return false;
    }
    toast(
      reopening
        ? { kind: 'info', title: 'It’s picking this up again' }
        : { kind: 'info', title: 'Sent', sub: 'It takes this into account from here.' },
    );
    return true;
  };
  const exportRecord = () => {
    setBusy('download');
    void adapter.exportRun(run.id).then((result) => {
      setBusy(null);
      if (!result.data) return failed(result, 'Couldn’t download the record');
      download(recordFileName(run.title), result.data.markdown);
    });
  };

  return (
    <Shell title={run.title} rail={false} phoneBack={() => navigate('/runs')}>
      <div className="page">
        <div className="run-detail">
          <a className="section-link run-back" href={href('/runs')}>
            <Icon name="chevronLeft" size={14} />
            All work
          </a>
          <header className="col" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Status tone={status.tone}>{status.word}</Status>
              <span className="run-muted">
                Started {ago(run.started_at, now)}
                {run.finished_at ? ` · finished ${ago(run.finished_at, now)}` : ''}
              </span>
            </div>
            <h1 className="run-title">{run.title}</h1>
            {/* Waiting on the person, the line is the question, which is asked below. */}
            {run.status === 'needs_you' && run.question ? null : (
              <p className="run-status-line" aria-live="polite">
                {run.status_line}
              </p>
            )}
            <dl className="run-goal">
              <dt>Goal</dt>
              <dd>{run.goal}</dd>
              {run.standing ? (
                <>
                  <dt>Wakes</dt>
                  <dd>{standingLine(run)}</dd>
                </>
              ) : null}
              {run.done_when ? (
                <>
                  <dt>Done when</dt>
                  <dd>{run.done_when}</dd>
                </>
              ) : null}
            </dl>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {finished ? null : paused ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon="play"
                  loading={busy === 'pause'}
                  disabled={busy !== null}
                  onClick={() =>
                    act('pause', () => adapter.resumeRun(run.id), 'Couldn’t resume it')
                  }
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === 'pause'}
                  disabled={busy !== null}
                  onClick={() => act('pause', () => adapter.pauseRun(run.id), 'Couldn’t pause it')}
                >
                  Pause
                </Button>
              )}
              {finished ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="square"
                  disabled={busy !== null}
                  onClick={() => setStopping(true)}
                >
                  Stop
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon="arrowDown"
                loading={busy === 'download'}
                disabled={busy !== null}
                onClick={exportRecord}
              >
                Download record
              </Button>
            </div>
          </header>

          {run.status === 'needs_you' ? (
            <section className="run-question" aria-labelledby="run-question">
              <h2 id="run-question" className="run-block-title">
                It needs you
              </h2>
              <p className="run-question-text voice">
                {run.question ?? 'It’s waiting to hear from you before it carries on.'}
              </p>
              <MessageBox
                label="Your reply"
                placeholder="Your answer"
                action="Reply"
                onSend={message}
              />
            </section>
          ) : null}

          {run.result ? (
            <Block title="Result" id="run-result">
              <p className="run-prose voice">{run.result}</p>
            </Block>
          ) : null}

          {run.latest_report ? (
            <Block title="Latest update" id="run-update">
              <div className="col" style={{ gap: 4 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="run-update-title">{run.latest_report.title}</span>
                  <span className="run-muted">{ago(run.latest_report.created_at, now)}</span>
                </div>
                {run.latest_report.body ? (
                  <p className="run-prose">{run.latest_report.body}</p>
                ) : null}
              </div>
            </Block>
          ) : null}

          {run.next && !finished ? (
            <Block title="What’s next" id="run-next">
              <p className="run-prose">{run.next}</p>
            </Block>
          ) : null}

          <BestResult run={run} />

          {run.plan ? (
            <Block title="The plan" id="run-plan">
              <p className="run-prose">{run.plan}</p>
            </Block>
          ) : null}

          {run.steps.length > 0 ? (
            <Block title="Helpers" id="run-helpers">
              <ul className="run-helpers">
                {run.steps.map((step) => {
                  const word = statusOf({ status: step.status, status_line: '' });
                  return (
                    <li key={step.id} className="run-helper">
                      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                        <span className="run-helper-title grow">{step.title}</span>
                        <Status tone={word.tone} quiet>
                          {helperWord(step.status)}
                        </Status>
                      </div>
                      {step.result ? <p className="run-helper-result">{step.result}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </Block>
          ) : null}

          {finished || run.status === 'needs_you' ? null : (
            <Block title="Tell it something" id="run-steer">
              <MessageBox
                label="Tell it something"
                placeholder="A new idea, a change of direction, or something it should know"
                action="Send"
                onSend={message}
              />
            </Block>
          )}

          {run.status === 'done' || run.status === 'failed' ? (
            <Block title="Keep going" id="run-again">
              <MessageBox
                label="Ask it to pick this up again"
                placeholder="Ask it to pick this up again, and say what to look at next"
                action="Keep going"
                onSend={message}
              />
            </Block>
          ) : null}

          {finished ? null : <LimitControl run={run} act={data.act} />}

          <section className="run-block" aria-labelledby="run-record-head">
            <h2 id="run-record-head" className="run-block-title">
              <button
                type="button"
                className="run-disclosure"
                aria-expanded={recordOpen}
                aria-controls="run-record"
                onClick={() => setRecordOpen(!recordOpen)}
              >
                <Icon name={recordOpen ? 'chevronDown' : 'chevronRight'} size={16} />
                Full record
              </button>
            </h2>
            <div id="run-record" hidden={!recordOpen}>
              {recordOpen ? (
                <RecordTimeline
                  entries={record.entries}
                  helpers={helpers}
                  more={record.more}
                  loading={record.loading}
                  onMore={record.loadMore}
                />
              ) : null}
            </div>
          </section>
        </div>
      </div>
      <Dialog
        open={stopping}
        onClose={() => setStopping(false)}
        title="Stop this work?"
        sub="It stops for good, along with its helpers. Everything it found so far stays in the record."
        tone="danger"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopping(false)}>
              Keep going
            </Button>
            <Button
              variant="destructive"
              loading={busy === 'stop'}
              disabled={busy !== null}
              onClick={() => {
                setStopping(false);
                act('stop', () => adapter.stopRun(run.id), 'Couldn’t stop it');
              }}
            >
              Stop
            </Button>
          </>
        }
      />
    </Shell>
  );
}

export function WorkScreen({ id }: { id: string | null }) {
  return id ? <WorkDetail id={id} /> : <WorkList />;
}
