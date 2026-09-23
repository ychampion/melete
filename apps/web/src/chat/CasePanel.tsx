/**
 * The case panel: for a conversation that is handling a ledger item, what the
 * item is worth, where it stands, and the steps of the job. Every step is read
 * from something the service already returned (the item and its evidence
 * message, the drafts, the permission, the receipts, the turns), and a step
 * with nothing behind it is not drawn.
 */
import { useEffect, useState } from 'react';
import { companiesApi, currentSpaceId } from '../companies/api.ts';
import { amountWords, dayOf, KIND_WORDS } from '../companies/format.ts';
import { statusOf } from '../companies/Ledger.tsx';
import { Icon } from '../design/icons.tsx';
import { CompanyTile, IconButton, Status } from '../design/primitives.tsx';
import type { Transcript } from '../experience/reduce.ts';
import type { Company, LedgerDetail, LedgerItem } from '../experience/types.ts';
import { href } from '../router.ts';
import { timeOf } from './parts.tsx';

export type Case = { item: LedgerItem; company: Company; detail: LedgerDetail | null };

/**
 * The ledger item a conversation is handling, if any. The map is read again
 * whenever the conversation settles, so a settled item shows as settled.
 */
export function useCase(conversationId: string | null, settledKey: string): Case | null {
  const [found, setFound] = useState<Case | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: settledKey is the reload trigger
  useEffect(() => {
    if (!conversationId) {
      setFound(null);
      return;
    }
    let live = true;
    void (async () => {
      const space = await currentSpaceId();
      if (!live || space.data === null) return;
      const map = await companiesApi.map(space.data);
      if (!live || map.data === null) return;
      const item = map.data.items.find((entry) => entry.job_id === conversationId);
      const company = item
        ? map.data.companies.find((entry) => entry.id === item.company_id)
        : null;
      if (!item || !company) {
        setFound(null);
        return;
      }
      setFound((previous) => ({ item, company, detail: previous?.detail ?? null }));
      const detail = await companiesApi.item(item.id);
      if (live && detail.data) setFound({ item, company, detail: detail.data });
    })();
    return () => {
      live = false;
    };
  }, [conversationId, settledKey]);
  return found;
}

type Step = { key: string; label: string; sub?: string; state: 'done' | 'now' | 'later' };

const longDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

export function caseSteps(found: Case, transcript: Transcript): Step[] {
  const { item, company, detail } = found;
  const blocks = transcript.turns.flatMap((turn) => turn.blocks);
  const drafts = Object.values(transcript.drafts);
  const permission = blocks.find((block) => block.type === 'permission');
  const sent = blocks.find(
    (block) =>
      block.type === 'receipt' &&
      !block.reversed &&
      !block.receipt.what.startsWith('Removed again'),
  );
  const steps: Step[] = [
    {
      key: 'found',
      label: 'Found in your mail',
      sub: detail?.message ? `Their email of ${longDay(detail.message.received_at)}` : undefined,
      state: 'done',
    },
  ];
  if (drafts.length > 0 || sent)
    steps.push({ key: 'draft', label: 'Draft written', sub: drafts[0]?.subject, state: 'done' });
  if (permission?.type === 'permission') {
    const allowed =
      permission.decided === 'allow_once' ||
      permission.decided === 'always' ||
      (permission.decided === 'closed' && Boolean(sent));
    steps.push({
      key: 'ok',
      label: allowed
        ? permission.decided === 'always'
          ? 'Always allowed'
          : 'Allowed once'
        : 'Your OK',
      sub:
        permission.decided === 'deny'
          ? 'You said not to send it'
          : `Asked once for ${company.name}`,
      state: allowed ? 'done' : 'now',
    });
  }
  if (drafts.length > 0 || sent) {
    steps.push({
      key: 'sent',
      label: 'Sent from your address',
      sub:
        sent?.type === 'receipt'
          ? `${dayOf(sent.receipt.when)} · ${timeOf(sent.receipt.when)}`
          : undefined,
      state: sent ? 'done' : 'later',
    });
    steps.push({
      key: 'watch',
      label: 'Watches the thread',
      state: item.status === 'settled' ? 'done' : sent ? 'now' : 'later',
    });
  }
  steps.push({
    key: 'settled',
    label: 'Settled',
    state: item.status === 'settled' ? 'done' : 'later',
  });
  return steps;
}

export function CasePanel({
  found,
  transcript,
  now,
  onClose,
}: {
  found: Case;
  transcript: Transcript;
  now: number;
  onClose: () => void;
}) {
  const { item, company } = found;
  const amount = amountWords(item);
  const status = statusOf(item, now);
  const settled = item.status === 'settled';
  const steps = caseSteps(found, transcript);
  return (
    <aside className="side-panel case-panel" aria-label={`The case with ${company.name}`}>
      <div className="case-head">
        <CompanyTile id={company.id} name={company.name} size={28} />
        <span className="case-name clamp1">{company.name}</span>
        <div className="grow" />
        <a className="section-link" href={href('/companies')}>
          Companies
          <Icon name="chevronRight" size={13} />
        </a>
        <IconButton name="x" label="Close the case" className="case-close" onClick={onClose} />
      </div>
      <div className="case-body">
        {amount ? (
          <div className="case-figure">
            <span className="case-label">{settled ? 'Settled' : amount.direction}</span>
            <span className="figure" data-settled={settled ? 'true' : undefined}>
              {amount.figure}
            </span>
          </div>
        ) : null}
        <div className="case-status">
          <Status tone={status.tone} quiet>
            {status.words}
            {item.due_at && !settled ? ` · ${dayOf(item.due_at)}` : ''}
          </Status>
          <span className="case-ref">{KIND_WORDS[item.kind]}</span>
        </div>
        <div className="hairline" />
        <ol className="case-steps">
          {steps.map((step) => (
            <li key={step.key} className="case-step" data-state={step.state}>
              <span className="case-mark" aria-hidden="true">
                {step.state === 'done' ? <Icon name="check" size={11} stroke={3} /> : null}
              </span>
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="case-step-label">
                  {step.label}
                  <span className="sr-only">
                    {step.state === 'done' ? ', done' : step.state === 'now' ? ', now' : ', next'}
                  </span>
                </span>
                {step.sub ? <span className="case-step-sub">{step.sub}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
