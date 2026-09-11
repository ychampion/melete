/**
 * Plans: a table of objectives with milestones, a docked sheet for the
 * selected plan, templates to start from, and a way to ask Melete about one.
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
import { agentById, useApp, useLoad } from '../experience/hooks.ts';
import type { Plan, PlanCategory, PlanTemplate } from '../experience/types.ts';
import { href, navigate, useRoute } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';

export const CATEGORY: Record<
  PlanCategory,
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
};

export function CategoryTile({ category, size = 36 }: { category: PlanCategory; size?: number }) {
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
              <CategoryTile category={plan.category} />
              <div className="col" style={{ minWidth: 0, gap: 2 }}>
                <span
                  className="clamp1"
                  style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                >
                  {plan.title}
                </span>
                <span className="clamp1" style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {plan.next_step}
                </span>
              </div>
            </div>
            {compact ? null : (
              <div>
                <Badge tone={CATEGORY[plan.category].tone}>{CATEGORY[plan.category].label}</Badge>
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
                    width: `${plan.progress}%`,
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
                {plan.progress}%
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
  const { agents } = useApp();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const done = plan.milestones.filter((m) => m.done).length;
  const r = 28;
  const circ = 2 * Math.PI * r;
  const dash = (plan.progress / 100) * circ;
  const c = CATEGORY[plan.category];
  return (
    <aside className="side-panel" aria-label={plan.title}>
      <div className="panel-body">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Badge tone={c.tone}>{c.label}</Badge>
          <div className="row" style={{ gap: 2 }}>
            <IconButton
              name="share"
              label="Share plan"
              onClick={() => {
                void navigator.clipboard?.writeText(`${window.location.origin}/#/plans/${plan.id}`);
                toast({
                  kind: 'ok',
                  title: 'Link copied',
                  sub: 'People with the link can follow along. Only you can edit.',
                });
              }}
            />
            <IconButton name="x" label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, lineHeight: '26px' }}>{plan.title}</h2>
          {plan.description ? (
            <p style={{ fontSize: 14, color: 'var(--secondary)' }}>{plan.description}</p>
          ) : null}
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
              {plan.progress}%
            </span>
          </div>
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
              {done} of {plan.milestones.length} milestones done
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Updated {plan.updated_at}</span>
          </div>
        </div>
        {plan.needs_you ? (
          <div
            className="row"
            style={{
              gap: 10,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'var(--sand)',
              color: 'var(--sand-ink)',
              fontSize: 13,
            }}
          >
            <Icon name="hand" size={16} />
            <span>{plan.needs_you}</span>
          </div>
        ) : null}
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between', height: 24 }}>
            <Overline>Milestones</Overline>
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>
              Add
            </Button>
          </div>
          {plan.milestones.map((milestone) => {
            const agent =
              milestone.assignee?.kind === 'agent'
                ? agentById(agents, milestone.assignee.agent_id)
                : null;
            return (
              <div
                key={milestone.id}
                className="row"
                style={{ gap: 10, minHeight: 36, padding: '4px 0' }}
              >
                <Checkbox
                  checked={milestone.done}
                  label={milestone.text}
                  onChange={(next) =>
                    void adapter
                      .toggleMilestone(plan.id, milestone.id, next)
                      .then((r) => r.data && onChange(r.data))
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
                  {milestone.text}
                </span>
                {agent ? (
                  <span
                    className="row"
                    style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}
                    title={`${agent.name} owns this`}
                  >
                    <AgentFace
                      look={agent.look}
                      size={20}
                      state={milestone.done ? 'done' : 'idle'}
                    />
                    {agent.name}
                  </span>
                ) : milestone.assignee?.kind === 'person' ? (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>you</span>
                ) : null}
              </div>
            );
          })}
          {adding ? (
            <form
              className="row"
              style={{ gap: 8, paddingTop: 4 }}
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!text) return;
                void adapter.addMilestone(plan.id, text).then((r) => r.data && onChange(r.data));
                setDraft('');
                setAdding(false);
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="A milestone"
                aria-label="New milestone"
                width="100%"
                height={32}
                autoFocus
              />
              <Button size="sm" type="submit">
                Add
              </Button>
            </form>
          ) : null}
        </div>
        {plan.linked.length ? (
          <div className="col" style={{ gap: 6 }}>
            <Overline>Linked</Overline>
            {plan.linked.map((link) => (
              <a
                key={`${link.kind}-${link.id}`}
                className="row hoverable"
                href={link.kind === 'chat' ? href(`/chat/${link.id}`) : '#'}
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
                  <Icon name={link.kind === 'chat' ? 'chat' : 'fileText'} size={18} />
                </span>
                <span className="col grow" style={{ minWidth: 0 }}>
                  <span
                    className="clamp1"
                    style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                  >
                    {link.title}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{link.sub}</span>
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
          onClick={() =>
            void adapter
              .startConversation({
                text: `About the plan “${plan.title}”: what should I do next?`,
                agent_id: 'nova',
                plan_id: plan.id,
              })
              .then((r) => {
                if (r.data) navigate(`/chat/${r.data.conversation.id}`);
                else toast({ kind: 'err', title: r.error ?? 'Couldn’t start the chat' });
              })
          }
        >
          Ask Melete about this plan
        </Button>
        {plan.status === 'in_progress' ? (
          <Button
            variant="outline"
            icon="check"
            block
            onClick={() =>
              void adapter.completePlan(plan.id).then((r) => r.data && onChange(r.data))
            }
          >
            Mark complete
          </Button>
        ) : (
          <Badge tone="success" dot>
            Completed
          </Badge>
        )}
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
  const [category, setCategory] = useState<PlanCategory>('wellbeing');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a plan"
      sub="Melete will suggest milestones once you save."
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
              void adapter.createPlan({ title: title.trim(), category, why }).then((r) => {
                setBusy(false);
                if (r.data) {
                  onCreated(r.data.plan);
                  setTitle('');
                  setWhy('');
                  onClose();
                } else toast({ kind: 'err', title: r.error ?? 'Couldn’t create the plan' });
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
          onChange={(v) => setCategory(v as PlanCategory)}
          width="100%"
          options={Object.entries(CATEGORY).map(([value, c]) => ({ value, label: c.label }))}
        />
      </Field>
      <Field
        label={
          <span>
            Why it matters{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
          </span>
        }
      >
        <textarea
          className="textarea"
          value={why}
          onChange={(event) => setWhy(event.target.value)}
          placeholder="A sentence or two."
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
  const [category, setCategory] = useState<'all' | PlanCategory>('all');
  const [view, setView] = useState<'table' | 'board'>('table');
  const [creating, setCreating] = useState(route.query.get('new') === '1');

  const plans = data.data?.plans ?? [];
  const templates = data.data?.templates ?? [];
  const visible = useMemo(
    () =>
      plans.filter(
        (plan) =>
          (tab === 'progress' ? plan.status === 'in_progress' : plan.status === 'completed') &&
          (category === 'all' || plan.category === category) &&
          plan.title.toLowerCase().includes(filter.toLowerCase()),
      ),
    [plans, tab, category, filter],
  );
  const current = plans.find((plan) => plan.id === selected) ?? null;
  const update = (next: Plan) =>
    data.set({ plans: plans.map((p) => (p.id === next.id ? next : p)), templates });

  const startFromTemplate = (template: PlanTemplate) =>
    void adapter
      .createPlan({ title: template.title, category: template.category, why: template.description })
      .then((r) => {
        if (r.data) {
          data.set({ plans: [r.data.plan, ...plans], templates });
          navigate(`/plans/${r.data.plan.id}`);
        }
      });

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
                count: plans.filter((p) => p.status === 'in_progress').length,
              },
              {
                value: 'done',
                label: 'Completed',
                count: plans.filter((p) => p.status === 'completed').length,
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
                  ...Object.entries(CATEGORY).map(([value, c]) => ({
                    value: value as PlanCategory,
                    label: c.label,
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
              {(Object.keys(CATEGORY) as PlanCategory[]).map((key) => (
                <div key={key} className="col" style={{ gap: 8 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone={CATEGORY[key].tone}>{CATEGORY[key].label}</Badge>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {visible.filter((p) => p.category === key).length}
                    </span>
                  </div>
                  {visible
                    .filter((p) => p.category === key)
                    .map((plan) => (
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
                          {plan.next_step}
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
                              width: `${plan.progress}%`,
                              height: '100%',
                              background: 'var(--primary)',
                            }}
                          />
                        </div>
                      </a>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="col" style={{ gap: 12 }}>
          <div className="section-head">
            <h2>Start from a template</h2>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 12,
            }}
          >
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="card-12 hoverable col"
                style={{ alignItems: 'flex-start', gap: 10, padding: 14, textAlign: 'left' }}
                onClick={() => startFromTemplate(template)}
              >
                <CategoryTile category={template.category} />
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
                  {template.title}
                </span>
                <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: '18px' }}>
                  {template.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <NewPlanDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(plan) => {
          data.set({ plans: [plan, ...plans], templates });
          navigate(`/plans/${plan.id}`);
        }}
      />
    </Shell>
  );
}
