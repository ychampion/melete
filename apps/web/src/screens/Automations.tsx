/**
 * Automations: routines that run on a schedule. The trigger is a sentence
 * from the service; each card carries its run history and a test run.
 * Creating one takes the days, the time and the agent.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
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
import { useApp, useLoad } from '../experience/hooks.ts';
import type { Automation, AutomationRun } from '../experience/types.ts';
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

function RunRow({ run }: { run: AutomationRun }) {
  const ok = run.status === 'done';
  const failed = run.status === 'failed' || run.status === 'stopped';
  const color = ok ? 'var(--success)' : failed ? 'var(--danger)' : 'var(--primary)';
  return (
    <div className="row" style={{ gap: 10, minHeight: 32, flexWrap: 'wrap' }}>
      <span className="row" style={{ justifyContent: 'center', width: 18, height: 18, color }}>
        {ok ? (
          <Icon name="circleCheck" size={16} />
        ) : failed ? (
          <Icon name="circleX" size={16} />
        ) : (
          <Icon name="loader" size={14} stroke={2} className="spin" />
        )}
      </span>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>
        {ok ? 'Succeeded' : failed ? 'Failed' : 'Running'}
      </span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>· {when(run.started_at)}</span>
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
  const [busy, setBusy] = useState(false);
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
            {automation.title}
          </span>
          <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{automation.schedule}</span>
        </div>
        <Badge tone={automation.enabled ? 'success' : 'neutral'} dot={automation.enabled}>
          {automation.enabled ? 'On' : 'Off'}
        </Badge>
      </div>
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
        <Button
          size="sm"
          variant="outline"
          icon="refresh"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void adapter.testAutomation(automation.id).then(async (r) => {
              setBusy(false);
              if (r.data === null) {
                toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t run it' });
                return;
              }
              const fresh = await adapter.automations();
              const next = fresh.data?.automations.find((a) => a.id === automation.id);
              if (next) onChange(next);
              toast({
                kind: 'info',
                title: `${automation.title} ran now`,
                sub: 'Nothing goes out that would not go out on schedule.',
              });
            });
          }}
        >
          Test run
        </Button>
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
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const agent = agentId || agents[0]?.id || '';
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
  const [creating, setCreating] = useState(false);
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
          <div className="row" style={{ gap: 8 }}>
            <Button icon="plus" onClick={() => setCreating(true)}>
              New routine
            </Button>
            <RailToggle />
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
        {data.data && list.length === 0 ? (
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
