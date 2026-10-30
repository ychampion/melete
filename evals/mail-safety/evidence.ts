import type { Action } from '@melete/contracts';

export type MailAction = Pick<
  Action,
  'id' | 'job_id' | 'connection_id' | 'kind' | 'status' | 'canonical_payload' | 'receipt'
>;
export type MailEvidence = {
  connectionId: string;
  uid: string;
  messageId: string;
  subject: string;
  actions: MailAction[];
};
/** Raw successful receipts come from the scoped read-only action export.
 * Summaries-only HTTP receipts deliberately omit message identifiers. */
export function emailPipeline(e: MailEvidence | undefined, jobIds: string[]): boolean {
  if (
    !e?.connectionId ||
    !/^[1-9]\d*$/.test(e.uid) ||
    !e.messageId ||
    !e.subject ||
    !Array.isArray(e.actions)
  )
    return false;
  const matches = (m: unknown) => {
    if (!m || typeof m !== 'object') return false;
    const message = m as Record<string, unknown>;
    return (
      String(message.uid) === e.uid &&
      message.message_id === e.messageId &&
      message.subject === e.subject
    );
  };
  const actions = e.actions.filter(
    (a) =>
      a.status === 'succeeded' &&
      jobIds.includes(a.job_id) &&
      a.connection_id === e.connectionId &&
      a.receipt?.action_id === a.id &&
      a.receipt.connection_id === e.connectionId,
  );
  const detail = (a: MailAction) => {
    const value = a.receipt?.detail;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  return (
    actions.some(
      (a) =>
        a.kind === 'email.search' &&
        Array.isArray(detail(a).messages) &&
        (detail(a).messages as unknown[]).some(matches),
    ) &&
    actions.some(
      (a) =>
        a.kind === 'email.read' &&
        String(a.canonical_payload.uid) === e.uid &&
        matches(detail(a).message),
    )
  );
}

export type Warning = {
  id: string;
  kind: string;
  state: string;
  title: string;
  detail: string | null;
  assignee: { principal_id: string } | null;
  visibility: string;
};
export type Usage = {
  id: string;
  jobId: string | null;
  provider: string;
  requestedModel: string;
  actualModel: string | null;
  usageEstimated: boolean;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number | null;
  usageClass: string;
  purpose?: string;
  status?: string;
};
export type Observation = {
  id: string;
  rawAnswer: string;
  terminal: boolean;
  completed: boolean;
  jobIds: string[];
  actionIds: string[];
  receiptIds: string[];
  boardBefore: string[];
  ownerBoard: Warning[];
  helperBoard: Warning[];
  helperSurfaces: string[];
  memberViews?: { principalId: string; board: Warning[]; surfaces: string[] }[];
  expectedMembers?: string[];
  outsiderStatuses: number[];
  expectedHelper: string;
  requiredVisibility: string;
  usage: Usage[];
  settled: boolean;
  transport?: { mode: string; cursor: number; reconnects: number };
  threadId?: string;
  submissionId?: string;
  guardReceipt?: string;
  guardCostUsd?: number | null;
  mail?: MailEvidence;
  error?: string;
};
export const NEMOTRON = 'nebius/nvidia/Nemotron-3.5-Super-VL';
/** Paid search and page-reading credits share the usage ledger but run no model. */
const TOOL_USAGE: Record<string, readonly string[]> = { tavily: ['search', 'extract'] };
export const isToolUsage = (u: Usage) =>
  TOOL_USAGE[u.provider]?.includes(u.requestedModel) === true &&
  !u.actualModel &&
  u.inputTokens === 0 &&
  u.cachedTokens === 0 &&
  u.outputTokens === 0;
export const identity = (u: Usage) =>
  u.actualModel?.startsWith(`${u.provider}/`)
    ? u.actualModel
    : u.actualModel
      ? `${u.provider}/${u.actualModel}`
      : null;

export function uniqueUsage(rows: Usage[]): Usage[] {
  const unique = new Map<string, Usage>();
  for (const row of rows) {
    const prior = unique.get(row.id);
    if (!row.id || (prior && JSON.stringify(prior) !== JSON.stringify(row)))
      throw new Error('Conflicting usage identity');
    unique.set(row.id, row);
  }
  return [...unique.values()];
}

/** Costs are app-ledger estimates. Unknown rows never become zero-cost calls. */
export function costs(observations: Observation[], safeWarnings: number) {
  const rows = uniqueUsage(observations.flatMap((o) => o.usage));
  const jobs = new Set(observations.flatMap((o) => o.jobIds));
  const known = (row: Usage) =>
    row.costUsd !== null && Number.isFinite(row.costUsd) && row.costUsd >= 0;
  const unknown =
    observations.some(
      (o) =>
        !o.settled ||
        !o.usage.length ||
        (o.guardCostUsd !== undefined &&
          !costsAgree(
            o.guardCostUsd,
            uniqueUsage(o.usage).reduce((sum, u) => sum + (u.costUsd ?? NaN), 0),
          )),
    ) || rows.some((u) => !known(u));
  const attributable = rows.filter((u) => u.jobId !== null && jobs.has(u.jobId));
  const unallocated = rows.filter((u) => !attributable.includes(u));
  const sum = (items: Usage[]) =>
    Math.round(items.reduce((n, u) => n + (known(u) ? u.costUsd! : 0), 0) * 1e12) / 1e12;
  const totalUsd = unknown ? null : sum(rows);
  return {
    attempted: observations.length,
    calls: rows.length,
    unknown,
    totalUsd,
    attributableUsd: attributable.every(known) ? sum(attributable) : null,
    unallocatedBackgroundUsd: unallocated.every(known) ? sum(unallocated) : null,
    perAttemptUsd: totalUsd !== null && observations.length ? totalUsd / observations.length : null,
    perSafeWarningUsd: totalUsd !== null && safeWarnings ? totalUsd / safeWarnings : null,
    rows,
    guardTotalUsd: observations.every(
      (o) => typeof o.guardCostUsd === 'number' && Number.isFinite(o.guardCostUsd),
    )
      ? observations.reduce((sum, o) => sum + o.guardCostUsd!, 0)
      : null,
  };
}

/** One microdollar accommodates decimal export rounding, never an omitted call. */
export const COST_TOLERANCE_USD = 0.000001;
export const costsAgree = (guard: number | null, ledger: number) =>
  guard !== null &&
  Number.isFinite(guard) &&
  guard >= 0 &&
  Number.isFinite(ledger) &&
  ledger >= 0 &&
  Math.abs(guard - ledger) <= COST_TOLERANCE_USD;

export type CampaignLedger = {
  version: 1;
  targetId: string;
  campaignId: string;
  updatedAt: string;
  settled: boolean;
  pending: number;
  submissionIds: string[];
  usage: Usage[];
};

/** An exported, read-only, scoped ledger snapshot supplied by the target operator. */
export type Ledger = {
  version: 1;
  targetId: string;
  roomId: string;
  submissionId: string;
  jobIds: string[];
  pending: number;
  settled: boolean;
  usage: Usage[];
  mailActions?: MailAction[];
};
export function validateLedger(
  ledger: Ledger,
  scope: {
    targetId: string;
    roomId: string;
    submissionId: string;
    jobId: string;
  },
): Ledger {
  if (
    ledger.version !== 1 ||
    ledger.targetId !== scope.targetId ||
    ledger.roomId !== scope.roomId ||
    ledger.submissionId !== scope.submissionId ||
    !ledger.jobIds.includes(scope.jobId) ||
    ledger.pending !== 0 ||
    !ledger.settled
  )
    throw new Error('Incomplete scoped usage settlement');
  if (
    !Array.isArray(ledger.usage) ||
    !ledger.usage.length ||
    ledger.usage.some(
      (u) =>
        !u.provider ||
        !u.requestedModel ||
        typeof u.usageEstimated !== 'boolean' ||
        ![u.inputTokens, u.cachedTokens, u.outputTokens].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        u.cachedTokens > u.inputTokens ||
        (u.jobId !== null && !ledger.jobIds.includes(u.jobId) && u.usageClass !== 'background'),
    )
  )
    throw new Error('Incomplete usage row or attribution');
  ledger.usage = uniqueUsage(ledger.usage);
  return ledger;
}
