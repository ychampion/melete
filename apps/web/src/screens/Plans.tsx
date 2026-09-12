/**
 * Plans: a table of objectives with milestones, a docked sheet for the
 * selected plan, and a way to ask Melete about one. Everything reads from
 * the contract's plans; what it has no call for (templates, sharing, adding a
 * milestone later) is not offered.
 */
import { useMemo, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import {
  Badge,
  type BadgeTone,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Input,
  Overline,
  Segmented,
  Select,
  TabsUnderline,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { agentById, lookOf, useApp, useLoad } from '../experience/hooks.ts';
import type { Plan } from '../experience/types.ts';
import { href, navigate, useRoute } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';

type Category = 'travel' | 'wellbeing' | 'learning' | 'finance' | 'other';

export const CATEGORY: Record<
  Category,
  { label: string; icon: IconName; tone: BadgeTone; bg: string; ink: string }
> = {
  travel: {
    label: 'Travel',
    icon: 'compass',
    tone: 'travel',
    bg: 'var(--travel)',
    ink: 'var(--travel-ink)',
  },
  wellbeing: {
    label: 'Wellbeing',
    icon: 'leaf',
    tone: 'wellbeing',
    bg: 'var(--sage)',
    ink: 'var(--sage-ink)',
  },
  learning: {
    label: 'Learning',
    icon: 'book',
    tone: 'learning',
    bg: 'var(--lilac)',
    ink: 'var(--lilac-ink)',
  },
  finance: {
    label: 'Finances',
    icon: 'piggy',
    tone: 'finance',
    bg: 'var(--sand)',
    ink: 'var(--sand-ink)',
  },
  other: {
    label: 'Plan',
    icon: 'plans',
    tone: 'neutral',
    bg: 'var(--soft)',
    ink: 'var(--secondary)',
  },
};

/** The contract's category is free text; the tint follows the closest word. */
export function categoryOf(text: string): Category {
  const lower = text.toLowerCase();
  if (/travel|trip|holiday/.test(lower)) return 'travel';
  if (/well|health|run|fit|sleep/.test(lower)) return 'wellbeing';
  if (/learn|study|language|course|spanish/.test(lower)) return 'learning';
  if (/financ|money|saving|fund|budget/.test(lower)) return 'finance';
  return 'other';
}

export function CategoryTile({ category, size = 36 }: { category: Category; size?: number }) {
  const c = CATEGORY[category];
  return (
    <span
      className="row"
      style={{
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 10,
        background: c.bg,
        color: c.ink,
        flexShrink: 0,
      }}
    >
      <Icon name={c.icon} size={Math.round(size / 2)} />
    </span>
  );
}

export function PlanTable({
  plans,
  selected,
  compact = false,
}: {
  plans: Plan[];
  selected?: string | null;
  compact?: boolean;
}) {
  const columns = compact ? 'minmax(0, 1fr) 140px 40px' : 'minmax(0, 1fr) 128px 168px 40px';
  return (
    <div className="card-12" style={{ overflow: 'hidden' }}>
      <div
        className="plan-grid"
        style={{ gridTemplateColumns: columns, height: 36, background: 'var(--soft)' }}
      >
        <Overline>Plan</Overline>
        {compact ? null : <Overline>Category</Overline>}
        <Overline>Progress</Overline>
        <div />
      </div>
      {plans.length === 0 ? (
        <div
          className="col"
          style={{
            alignItems: 'center',
            gap: 12,
            padding: '32px 24px',
            textAlign: 'center',
            borderTop: '1px solid var(--line)',
          }}
        >
          <span
            className="row"
            style={{
              justifyContent: 'center',
              width: 48,
              height: 48,
              borderRadius: 12,
              background: 'var(--blue-soft)',
              color: 'var(--blue-ink)',
            }}
          >
            <Icon name="plans" size={20} />
          </span>
          <span
            style={{
              fontFamily: 'var(--font-head)',
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--heading)',
            }}
          >
            No plans here yet
          </span>
        </div>
      ) : null}
      {plans.map((plan) => {
        const on = plan.id === selected;
        const category = categoryOf(plan.category);
        return (
          <a
            key={plan.id}
            className="plan-grid hoverable"
            href={href(`/plans/${plan.id}`)}
            style={{
              gridTemplateColumns: columns,
              height: 56,
              borderTop: '1px solid var(--line)',
              background: on ? 'var(--soft)' : undefined,
              boxShadow: on ? 'inset 3px 0 0 var(--primary)' : undefined,
              textDecoration: 'none',
              color: 'inherit',
            }}
            aria-current={on ? 'true' : undefined}
          >
            <div className="row" style={{ gap: 12, minWidth: 0 }}>
              <CategoryTile category={category} />
              <div className="col" style={{ minWidth: 0, gap: 2 }}>
                <span
                  className="clamp1"
                  style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                >
                  {plan.title}
                </span>
                <span className="clamp1" style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {plan.next_step ?? 'All milestones done'}
                </span>
              </div>
            </div>
            {compact ? null : (
              <div>
                <Badge tone={CATEGORY[category].tone}>{plan.category}</Badge>
              </div>
            )}
            <div className="row" style={{ gap: 10 }}>
              <div
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 4,
                  background: 'var(--line)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${plan.progress_percent}%`,
                    height: '100%',
                    borderRadius: 4,
                    background: 'var(--primary)',
                  }}
                />
              </div>
              <span
                className="tabular"
                style={{
                  width: 34,
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--secondary)',
                  textAlign: 'right',
                }}
              >
                {Math.round(plan.progress_percent)}%
              </span>
            </div>
            <span style={{ color: 'var(--secondary)', display: 'flex', justifyContent: 'center' }}>
              <Icon name="chevronRight" size={16} />
            </span>
          </a>
        );
      })}
    </div>
  );
}

function PlanSheet({
  plan,
  onChange,
  onClose,
}: {
  plan: Plan;
  onChange: (next: Plan) => void;
  onClose: () => void;
}) {
  const { agents, conversations } = useApp();
  const done = plan.milestones.filter((m) => m.done).length;
  const r = 28;
  const circ = 2 * Math.PI * r;
  const dash = (plan.progress_percent / 100) * circ;
  const category = categoryOf(plan.category);
  const linked = plan.conversation_ids
    .map((id) => conversations.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  const updated = new Date(plan.updated_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return (
    <aside className="side-panel" aria-label={plan.title}>
      <div className="panel-body">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Badge tone={CATEGORY[category].tone}>{plan.category}</Badge>
          <div className="row" style={{ gap: 2 }}>
            <IconButton
              name="share"
              label="Share plan"
              onClick={() =>
                void adapter.sharePlan(plan.id).then((r) => {
                  toast({
                    kind: 'info',
                    title: 'Sharing is not available yet',
                    sub: r.unavailable ?? r.error ?? '',
                  });
                })
              }
            />
            <IconButton name="x" label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, lineHeight: '26px' }}>{plan.title}</h2>
        </div>
        <div
          className="row"
          style={{
            gap: 16,
            padding: 14,
            borderRadius: 12,
            background: 'var(--soft)',
            border: '1px solid var(--line)',
          }}
        >
          <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
            <svg
              width="64"
              height="64"
              viewBox="0 0 64 64"
              style={{ transform: 'rotate(-90deg)' }}
              aria-hidden="true"
            >
              <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
              <circle
                cx="32"
                cy="32"
                r={r}
                fill="none"
                stroke="var(--primary)"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${dash.toFixed(1)} ${circ.toFixed(1)}`}
              />
            </svg>
            <span
              className="row"
              style={{
                position: 'absolute',
                inset: 0,
                justifyContent: 'center',
                fontFamily: 'var(--font-head)',
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--heading)',
              }}
            >
              {Math.round(plan.progress_percent)}%
            </span>
          </div>
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
              {done} of {plan.milestones.length} milestones done
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Updated {updated}</span>
          </div>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between', height: 24 }}>
            <Overline>Milestones</Overline>
          </div>
          {plan.milestones.map((milestone) => {
            const agent =
              milestone.assignee.kind === 'agent'
                ? agentById(agents, milestone.assignee.agent_id)
                : null;
            const byAgent = milestone.assignee.kind === 'agent';
            return (
              <div
                key={milestone.id}
                className="row"
                style={{ gap: 10, minHeight: 36, padding: '4px 0' }}
              >
                <Checkbox
                  checked={milestone.done}
                  disabled={byAgent}
                  label={milestone.title}
                  onChange={(next) =>
                    void adapter.setMilestone(plan.id, milestone.id, next).then((r) => {
                      if (r.data) onChange(r.data.plan);
                      else
                        toast({
                          kind: 'info',
                          title: r.unavailable ?? r.error ?? 'Couldn’t change that',
                        });
                    })
                  }
                />
                <span
                  style={{
                    flex: 1,
                    fontSize: 14,
                    color: milestone.done ? 'var(--muted)' : 'var(--text)',
                    textDecoration: milestone.done ? 'line-through' : 'none',
                  }}
                >
                  {milestone.title}
                </span>
                {agent ? (
                  <span
                    className="row"
                    style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}
                    title={`${agent.name} does this step`}
                  >
                    <AgentFace
                      look={lookOf(agent)}
                      size={20}
                      state={
                        milestone.done
                          ? 'done'
                          : milestone.status === 'working'
                            ? 'working'
                            : 'idle'
                      }
                    />
                    {agent.name}
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>you</span>
                )}
              </div>
            );
          })}
        </div>
        {linked.length ? (
          <div className="col" style={{ gap: 6 }}>
            <Overline>Linked</Overline>
            {linked.map((chat) => (
              <a
                key={chat.id}
                className="row hoverable"
                href={href(`/chat/${chat.id}`)}
                style={{
                  gap: 10,
                  height: 44,
                  padding: '0 10px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span style={{ color: 'var(--muted)', display: 'flex' }}>
                  <Icon name="chat" size={18} />
                </span>
                <span className="col grow" style={{ minWidth: 0 }}>
                  <span
                    className="clamp1"
                    style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                  >
                    {chat.title}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Chat</span>
                </span>
                <span style={{ color: 'var(--muted)', display: 'flex' }}>
                  <Icon name="chevronRight" size={16} />
                </span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
      <div className="panel-foot">
        <Button
          icon="chat"
          block
          onClick={() => {
            const agent = agents[0];
            if (!agent) return;
            void adapter.planConversation(plan.id, agent.id).then((r) => {
              if (r.data) navigate(`/chat/${r.data.conversation.id}`);
              else
                toast({
                  kind: 'err',
                  title: r.error ?? r.unavailable ?? 'Couldn’t start the chat',
                });
            });
          }}
        >
          Ask Melete about this plan
        </Button>
      </div>
    </aside>
  );
}

function NewPlanDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (plan: Plan) => void;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Wellbeing');
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a plan"
      sub="Start with one milestone; add the rest from a chat."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!title.trim()}
            onClick={() => {
              setBusy(true);
              void adapter
                .createPlan({
                  title: title.trim(),
                  category,
                  milestones: first.trim()
                    ? [{ title: first.trim(), assignee: { kind: 'person' } }]
                    : [],
                })
                .then((r) => {
                  setBusy(false);
                  if (r.data) {
                    onCreated(r.data.plan);
                    setTitle('');
                    setFirst('');
                    onClose();
                  } else
                    toast({
                      kind: 'err',
                      title: r.error ?? r.unavailable ?? 'Couldn’t create the plan',
                    });
                });
            }}
          >
            Create plan
          </Button>
        </>
      }
    >
      <Field label="Title">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Run a 10K in November"
          width="100%"
          autoFocus
        />
      </Field>
      <Field label="Category">
        <Select
          label="Category"
          value={category}
          onChange={setCategory}
          width="100%"
          options={['Travel', 'Wellbeing', 'Learning', 'Finances', 'Home', 'Work'].map((value) => ({
            value,
            label: value,
          }))}
        />
      </Field>
      <Field
        label={
          <span>
            First milestone{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
          </span>
        }
      >
        <Input
          value={first}
          onChange={(event) => setFirst(event.target.value)}
          placeholder="Get checked out and pick shoes"
          width="100%"
        />
      </Field>
    </Dialog>
  );
}

export function PlansScreen({ selected }: { selected: string | null }) {
  const route = useRoute();
  const data = useLoad(() => adapter.plans(), []);
  const [tab, setTab] = useState<'progress' | 'done'>('progress');
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<'all' | Category>('all');
  const [view, setView] = useState<'table' | 'board'>('table');
  const [creating, setCreating] = useState(route.query.get('new') === '1');

  const plans = data.data?.plans ?? [];
  const visible = useMemo(
    () =>
      plans.filter(
        (plan) =>
          (tab === 'progress' ? plan.progress_percent < 100 : plan.progress_percent >= 100) &&
          (category === 'all' || categoryOf(plan.category) === category) &&
          plan.title.toLowerCase().includes(filter.toLowerCase()),
      ),
    [plans, tab, category, filter],
  );
  const current = plans.find((plan) => plan.id === selected) ?? null;
  const update = (next: Plan) =>
    data.set({ plans: plans.map((p) => (p.id === next.id ? next : p)) });

  return (
    <Shell
      title="Plans"
      rail={false}
      panel={
        current ? (
          <PlanSheet plan={current} onChange={update} onClose={() => navigate('/plans')} />
        ) : undefined
      }
    >
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Plans</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              Turn an objective into milestones.
            </p>
          </div>
          <Button icon="plus" onClick={() => setCreating(true)}>
            New plan
          </Button>
        </div>
        <div className="col" style={{ gap: 16 }}>
          <TabsUnderline
            label="Plans"
            value={tab}
            onChange={setTab}
            tabs={[
              {
                value: 'progress',
                label: 'In progress',
                count: plans.filter((p) => p.progress_percent < 100).length,
              },
              {
                value: 'done',
                label: 'Completed',
                count: plans.filter((p) => p.progress_percent >= 100).length,
              },
            ]}
          />
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Input
              placeholder="Filter plans…"
              icon="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              width={200}
              aria-label="Filter plans"
            />
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
              <Segmented
                label="Category"
                value={category}
                onChange={setCategory}
                options={[
                  { value: 'all', label: 'All' },
                  ...(['travel', 'wellbeing', 'learning', 'finance'] as const).map((value) => ({
                    value,
                    label: CATEGORY[value].label,
                  })),
                ]}
              />
            </div>
            <div className="grow" />
            <Segmented
              label="View"
              value={view}
              onChange={setView}
              options={[
                { value: 'table', label: 'Table' },
                { value: 'board', label: 'Board' },
              ]}
            />
          </div>
          {data.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{data.error}</p> : null}
          {view === 'table' ? (
            <PlanTable plans={visible} selected={selected} compact={Boolean(current)} />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 12,
              }}
            >
              {(['travel', 'wellbeing', 'learning', 'finance', 'other'] as const).map((key) => {
                const column = visible.filter((p) => categoryOf(p.category) === key);
                if (column.length === 0) return null;
                return (
                  <div key={key} className="col" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <Badge tone={CATEGORY[key].tone}>{CATEGORY[key].label}</Badge>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{column.length}</span>
                    </div>
                    {column.map((plan) => (
                      <a
                        key={plan.id}
                        className="card-12 hoverable"
                        href={href(`/plans/${plan.id}`)}
                        style={{
                          padding: 12,
                          textDecoration: 'none',
                          color: 'inherit',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          boxShadow:
                            plan.id === selected ? 'inset 0 0 0 2px var(--primary)' : undefined,
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                          {plan.title}
                        </span>
                        <span className="clamp1" style={{ fontSize: 13, color: 'var(--muted)' }}>
                          {plan.next_step ?? 'All milestones done'}
                        </span>
                        <div
                          style={{
                            height: 4,
                            borderRadius: 4,
                            background: 'var(--line)',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${plan.progress_percent}%`,
                              height: '100%',
                              background: 'var(--primary)',
                            }}
                          />
                        </div>
                      </a>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <NewPlanDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(plan) => {
          data.set({ plans: [plan, ...plans] });
          navigate(`/plans/${plan.id}`);
        }}
      />
    </Shell>
  );
}
