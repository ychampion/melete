/**
 * Automations: routines that run on a schedule. The trigger is a sentence;
 * cron lives under Advanced. Each card carries its run history, a test run,
 * and a retry for a failed run.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, Dialog, Field, Input, Overline, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { Automation, AutomationRun } from '../experience/types.ts';
import { Shell, toast } from '../shell/Shell.tsx';

function RunRow({ run, onRetry }: { run: AutomationRun; onRetry: () => void }) {
  const color =
    run.status === 'ok'
      ? 'var(--success)'
      : run.status === 'failed'
        ? 'var(--danger)'
        : 'var(--primary)';
  return (
    <div className="row" style={{ gap: 10, minHeight: 32, flexWrap: 'wrap' }}>
      <span className="row" style={{ justifyContent: 'center', width: 18, height: 18, color }}>
        {run.status === 'ok' ? (
          <Icon name="circleCheck" size={16} />
        ) : run.status === 'failed' ? (
          <Icon name="circleX" size={16} />
        ) : (
          <Icon name="loader" size={14} stroke={2} className="spin" />
        )}
      </span>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>
        {run.status === 'ok' ? 'Succeeded' : run.status === 'failed' ? 'Failed' : 'Running'}
      </span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
        · {run.when}
        {run.note ? ` · ${run.note}` : ''}
      </span>
      {run.status === 'failed' ? (
        <button type="button" className="btn btn-link" style={{ fontSize: 13 }} onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function RoutineCard({
  automation,
  onChange,
}: {
  automation: Automation;
  onChange: (next: Automation) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [trigger, setTrigger] = useState(automation.trigger);
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="card-pad">
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
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
            {automation.name}
          </span>
          <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
            {automation.trigger} · {automation.description}
          </span>
        </div>
        <Toggle
          on={automation.enabled}
          label={`${automation.name} on`}
          onChange={(enabled) =>
            void adapter
              .toggleAutomation(automation.id, enabled)
              .then((r) => r.data && onChange(r.data))
          }
        />
      </div>
      <div className="col">
        <Overline style={{ paddingBottom: 4 }}>Last runs</Overline>
        {automation.runs.slice(0, 4).map((run) => (
          <RunRow
            key={run.id}
            run={run}
            onRetry={() =>
              void adapter.retryRun(automation.id, run.id).then((r) => r.data && onChange(r.data))
            }
          />
        ))}
        {automation.runs.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>Not run yet</span>
        ) : null}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="outline"
          icon="refresh"
          onClick={() =>
            void adapter.testRun(automation.id).then((r) => {
              if (r.data) {
                onChange(r.data);
                toast({
                  kind: 'info',
                  title: `${automation.name} is running now`,
                  sub: 'Nothing goes out that would not go out on schedule.',
                });
              }
            })
          }
        >
          Test run
        </Button>
        <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing(true)}>
          Edit schedule
        </Button>
        <div className="grow" />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{automation.next_run}</span>
      </div>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit schedule"
        sub="Say it the way you would say it to a person."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                onChange({ ...automation, trigger });
                toast({ kind: 'ok', title: 'Schedule saved', sub: trigger });
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="When">
          <Input
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            width="100%"
            aria-label="When"
          />
        </Field>
        <button
          type="button"
          className="btn btn-link"
          style={{ fontSize: 13, alignSelf: 'flex-start' }}
          onClick={() => setAdvanced((a) => !a)}
        >
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>
        {advanced ? (
          <Field label="Cron" hint="Five fields: minute, hour, day of month, month, day of week.">
            <Input
              defaultValue={automation.cron}
              width="100%"
              aria-label="Cron"
              style={{ fontFamily: 'ui-monospace, monospace' }}
            />
          </Field>
        ) : null}
      </Dialog>
    </div>
  );
}

export function AutomationsScreen() {
  const data = useLoad(() => adapter.automations(), []);
  const list = data.data?.automations ?? [];
  const update = (next: Automation) =>
    data.set({ automations: list.map((a) => (a.id === next.id ? next : a)) });
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
        </div>
        {data.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{data.error}</p> : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 12,
          }}
        >
          {list.map((automation) => (
            <RoutineCard key={automation.id} automation={automation} onChange={update} />
          ))}
        </div>
      </div>
    </Shell>
  );
}
