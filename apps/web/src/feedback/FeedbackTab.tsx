/**
 * Settings, Feedback: the problem reports people sent from inside the app.
 * Whoever runs the installation sees every report and moves it along; anyone
 * else sees the reports they sent and where each one stands.
 */
import { type ReactNode, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  IconButton,
  Segmented,
  Select,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { FeedbackReport, FeedbackStatus } from '../experience/types.ts';
import { href, navigate } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { openFeedback } from './FeedbackPanel.tsx';
import './feedback.css';

export const STATUS: Record<FeedbackStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'blue' },
  fixing: { label: 'Fixing', tone: 'finance' },
  fixed: { label: 'Fixed', tone: 'success' },
  wontfix: { label: 'Won’t fix', tone: 'neutral' },
};
const STATUS_OPTIONS = (Object.keys(STATUS) as FeedbackStatus[]).map((value) => ({
  value,
  label: STATUS[value].label,
}));

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function copy(text: string, what: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast({ kind: 'ok', title: `Copied ${what}` }))
    .catch(() => toast({ kind: 'err', title: 'Couldn’t copy' }));
}

function Row({ report }: { report: FeedbackReport }) {
  return (
    <a className="feedback-row" href={href(`/settings/feedback/${report.id}`)}>
      <span className="feedback-row-id">{report.id}</span>
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="clamp1" style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
          {report.summary}
        </span>
        <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {report.route ?? 'No page details'}
          {report.reporter.email ? ` · ${report.reporter.email}` : ''}
        </span>
      </span>
      <span className="feedback-row-when" style={{ fontSize: 12, color: 'var(--muted)' }}>
        {when(report.created_at)}
      </span>
      <Badge tone={STATUS[report.status].tone}>{STATUS[report.status].label}</Badge>
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="col" style={{ gap: 8 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}>{title}</h3>
      {children}
    </section>
  );
}

function Detail({
  id,
  canManage,
  onChanged,
}: {
  id: string;
  canManage: boolean;
  onChanged: (report: FeedbackReport) => void;
}) {
  const loaded = useLoad(() => adapter.feedbackReport(id), [id]);
  const report = loaded.data?.report ?? null;
  const [status, setStatus] = useState<FeedbackStatus>('open');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!report) return;
    setStatus(report.status);
    setNote(report.note ?? '');
  }, [report]);

  if (loaded.error) return <p style={{ color: 'var(--danger)', fontSize: 13 }}>{loaded.error}</p>;
  if (!report) return null;
  const { context } = report;
  const command = `bun run feedback show ${report.id}`;
  const changed = status !== report.status || note.trim() !== (report.note ?? '');
  const save = () => {
    setSaving(true);
    void adapter.setFeedbackStatus(report.id, status, note.trim() || null).then((result) => {
      setSaving(false);
      if (!result.data) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t save' });
        return;
      }
      loaded.set({ report: result.data.report });
      onChanged(result.data.report);
      toast({ kind: 'ok', title: `${report.id} is ${STATUS[status].label.toLowerCase()}` });
    });
  };
  const errors = context.console_errors ?? [];
  const failed = context.failed_requests ?? [];
  return (
    <div className="card-12 col" style={{ gap: 18, padding: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="ghost"
          icon="chevronLeft"
          onClick={() => navigate('/settings/feedback')}
        >
          All reports
        </Button>
        <div className="grow" />
        <Badge tone={STATUS[report.status].tone}>{STATUS[report.status].label}</Badge>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <h2 className="feedback-id" style={{ flex: 'none', fontSize: 20 }}>
          {report.id}
        </h2>
        <IconButton
          name="copy"
          label="Copy the report id"
          onClick={() => copy(report.id, report.id)}
        />
      </div>
      <Section title="What went wrong">
        <p style={{ fontSize: 14, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
          {report.message}
        </p>
      </Section>
      {canManage ? (
        <Section title="Status">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Select
              label="Status"
              value={status}
              onChange={(value) => setStatus(value as FeedbackStatus)}
              options={STATUS_OPTIONS}
              width={160}
            />
            <textarea
              className="textarea"
              aria-label="A note"
              placeholder="A note for whoever picks this up next"
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              style={{ flex: '1 1 240px', minHeight: 36 }}
            />
            <Button disabled={!changed || saving} loading={saving} onClick={save}>
              Save
            </Button>
          </div>
        </Section>
      ) : report.note ? (
        <Section title="Note">
          <p style={{ fontSize: 14, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
            {report.note}
          </p>
        </Section>
      ) : null}
      <Section title="Details">
        <dl className="feedback-meta">
          <dt>Sent</dt>
          <dd>
            {when(report.created_at)}
            {report.reporter.email ? ` by ${report.reporter.email}` : ''}
          </dd>
          <dt>Page</dt>
          <dd>{report.route ?? 'Not included'}</dd>
          <dt>Version</dt>
          <dd>{report.app_version}</dd>
          {context.user_agent ? (
            <>
              <dt>Browser</dt>
              <dd>{context.user_agent}</dd>
            </>
          ) : null}
          {context.viewport ? (
            <>
              <dt>Screen</dt>
              <dd>
                {context.viewport.width} × {context.viewport.height}
                {context.color_scheme ? `, ${context.color_scheme}` : ''}
              </dd>
            </>
          ) : null}
          {context.language || context.time_zone ? (
            <>
              <dt>Locale</dt>
              <dd>{[context.language, context.time_zone].filter(Boolean).join(', ')}</dd>
            </>
          ) : null}
        </dl>
      </Section>
      <Section title={`Console errors (${errors.length})`}>
        {errors.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>None recorded.</span>
        ) : (
          <pre className="feedback-json">
            {errors.map((entry) => `${entry.at}  ${entry.message}`).join('\n')}
          </pre>
        )}
      </Section>
      <Section title={`Failed requests (${failed.length})`}>
        {failed.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>None recorded.</span>
        ) : (
          <pre className="feedback-json">
            {failed
              .map(
                (entry) =>
                  `${entry.at}  ${entry.method} ${entry.url} → ${entry.status ?? 'no answer'}${
                    entry.code ? ` (${entry.code})` : ''
                  }`,
              )
              .join('\n')}
          </pre>
        )}
      </Section>
      {canManage ? (
        <Section title="Hand it to a coding agent">
          <div className="row feedback-id-row" style={{ gap: 8 }}>
            <code className="grow" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
              {command}
            </code>
            <IconButton
              name="copy"
              label="Copy the command"
              onClick={() => copy(command, 'the command')}
            />
          </div>
        </Section>
      ) : null}
    </div>
  );
}

export function FeedbackTab({ selected }: { selected: string | null }) {
  const list = useLoad(() => adapter.feedback(), []);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const reports = list.data?.reports ?? [];
  const canManage = list.data?.can_manage ?? false;
  const shown =
    filter === 'all'
      ? reports
      : reports.filter((r) => r.status === 'open' || r.status === 'fixing');

  if (selected)
    return (
      <Detail
        id={selected}
        canManage={canManage}
        onChanged={(next) =>
          list.data &&
          list.set({ ...list.data, reports: reports.map((r) => (r.id === next.id ? next : r)) })
        }
      />
    );

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <p
          className="grow"
          style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560, minWidth: 200 }}
        >
          {canManage
            ? 'Problems people reported from inside the app, with the page details they chose to send.'
            : 'Problems you reported, and where each one stands.'}
        </p>
        <Segmented
          label="Which reports"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="outline" icon="bug" onClick={() => openFeedback()}>
          Report a problem
        </Button>
      </div>
      {list.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{list.error}</p> : null}
      <div className="card-12" style={{ overflow: 'hidden' }}>
        <div style={{ height: 1, marginTop: -1 }} />
        {shown.map((report) => (
          <Row key={report.id} report={report} />
        ))}
        {list.data && shown.length === 0 ? (
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
              {filter === 'all' ? 'No reports yet' : 'Nothing open'}
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              The bug button at the bottom of the sidebar sends one.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
