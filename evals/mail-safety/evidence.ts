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
  outsiderStatuses: number[];
  expectedHelper: string;
  requiredVisibility: string;
  usage: Usage[];
  settled: boolean;
  transport?: { mode: string; cursor: number; reconnects: number };
  threadId?: string;
  submissionId?: string;
  guardReceipt?: string;
  error?: string;
};
export const NEMOTRON = 'nebius/nvidia/Nemotron-3.5-Super-VL';
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
    observations.some((o) => !o.settled || !o.usage.length) || rows.some((u) => !known(u));
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
  };
}

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
