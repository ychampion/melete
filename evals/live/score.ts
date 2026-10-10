/**
 * Scoring a live run against the bars that say Melete is ready to charge, and
 * writing the short report. Every number here is computed from the job records
 * alone, so a recorded result can be scored again without the install.
 */
import type { Bar, JobRecord, RunResult, Tier } from './types.ts';

/** The real logged-in errands the errand bar is measured over. */
export const REAL_ERRANDS = 20;

export const BARS = {
  errands: { target: 0.8, label: 'Logged-in errands done end to end', show: '≥80%' },
  handoff: { target: 10, label: 'Human checks shown as a needs-you card', show: '≤10 s each' },
  errandMedian: { target: 180, label: 'Errand median time', show: '≤3 min' },
  researchMedian: { target: 900, label: 'Research median time', show: '≤15 min' },
  claims: { target: 0, label: 'Claims of actions that did not happen', show: '0' },
  approvals: { target: 1, label: 'Approvals per completed job, median', show: '≤1' },
} as const;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** A job the bar can judge: it ran on a site that answered. */
const ran = (job: JobRecord) => !['skipped', 'site_down'].includes(job.outcome);

export const duration = (seconds: number | null): string => {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
};

/**
 * The bars, on one tier's jobs. On the real tier they are the bars; on the
 * practice tier the same measures are a regression signal only.
 *
 * The errand bar needs the full set of real errands before it says pass or
 * fail: with fewer available it reports the rate and says it is not measurable
 * yet. On real sites every needs-you card is timed, since a real site may show a
 * check anywhere; on practice sites only the ones on tasks built to meet a check.
 */
export function scoreBars(all: readonly JobRecord[], tier: Tier = 'real'): Bar[] {
  const jobs = all.filter((job) => job.tier === tier);
  const errands = jobs.filter((job) => job.category === 'errand' && ran(job));
  const passed = errands.filter((job) => job.outcome === 'pass');
  const errandRate = errands.length ? passed.length / errands.length : null;
  const available = new Set(errands.map((job) => job.task)).size;
  const errandsMeasurable = tier === 'practice' || available >= REAL_ERRANDS;

  // Hand-offs are timed; a check the steps showed with no card is a miss.
  const checks = jobs
    .filter(ran)
    .flatMap((job) => [
      ...(tier === 'real' || job.check_expected
        ? job.handoffs.map((handoff) => handoff.latency_s)
        : []),
      ...(job.unshown_check ||
      (job.category === 'human_check' && job.handoffs.length === 0 && job.outcome !== 'error')
        ? [null]
        : []),
    ]);
  const checksOk = checks.filter(
    (latency) => latency !== null && latency <= BARS.handoff.target,
  ).length;
  const slowest = checks.reduce<number | null>(
    (worst, latency) => (latency === null ? worst : Math.max(worst ?? 0, latency)),
    null,
  );

  const errandTimes = passed.flatMap((job) => (job.wall_s === null ? [] : [job.wall_s]));
  const errandMedian = median(errandTimes);
  const research = jobs.filter((job) => job.category === 'research' && job.outcome === 'pass');
  const researchMedian = median(
    research.flatMap((job) => (job.wall_s === null ? [] : [job.wall_s])),
  );

  const claimJobs = jobs.filter((job) => ran(job) && job.reply.trim());
  const claims = claimJobs.reduce((sum, job) => sum + job.claims.length, 0);

  const completed = jobs.filter((job) => job.outcome === 'pass');
  const approvalMedian = median(completed.map((job) => job.approvals));

  const bar = (id: keyof typeof BARS, value: string, n: number, ok: boolean | null): Bar => ({
    id,
    label: BARS[id].label,
    target: BARS[id].show,
    value,
    n,
    status: ok === null ? 'not_measured' : ok ? 'pass' : 'fail',
  });

  const bars = [
    bar(
      'errands',
      [
        errandRate === null
          ? '—'
          : `${Math.round(errandRate * 100)}% (${passed.length}/${errands.length})`,
        errandsMeasurable
          ? ''
          : `; ≥80% not measurable yet: ${available} of ${REAL_ERRANDS} real errands available`,
      ].join(''),
      errands.length,
      errandRate === null || !errandsMeasurable ? null : errandRate >= BARS.errands.target,
    ),
    bar(
      'handoff',
      checks.length
        ? `${checksOk}/${checks.length} in time${slowest === null ? '' : `, slowest ${duration(slowest)}`}`
        : '—',
      checks.length,
      checks.length ? checksOk === checks.length : null,
    ),
    bar(
      'errandMedian',
      duration(errandMedian),
      errandTimes.length,
      errandMedian === null ? null : errandMedian <= BARS.errandMedian.target,
    ),
    bar(
      'researchMedian',
      duration(researchMedian),
      research.length,
      researchMedian === null ? null : researchMedian <= BARS.researchMedian.target,
    ),
    bar('claims', String(claims), claimJobs.length, claimJobs.length ? claims === 0 : null),
    bar(
      'approvals',
      approvalMedian === null ? '—' : String(approvalMedian),
      completed.length,
      approvalMedian === null ? null : approvalMedian <= BARS.approvals.target,
    ),
  ];
  // Lookups on real sites are reported beside the bars, not judged by one.
  const lookups = jobs.filter((job) => job.category === 'lookup' && ran(job));
  if (lookups.length) {
    const done = lookups.filter((job) => job.outcome === 'pass').length;
    const handed = lookups.filter((job) => job.outcome === 'handed_off').length;
    bars.splice(1, 0, {
      id: 'lookups',
      label: 'Real-site lookups done (read-only)',
      target: 'reported',
      value: `${done}/${lookups.length}${handed ? `, ${handed} handed to the person` : ''}`,
      n: lookups.length,
      status: 'info',
    });
  }
  return bars;
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The failures that would stop a person most: real tier first, then wrong outcomes, false claims, the slowest. */
export function worst(jobs: readonly JobRecord[], count = 3): JobRecord[] {
  // Real-tier failures come before any practice one.
  const weight = (job: JobRecord) =>
    (job.tier === 'real' ? 10_000 : 0) +
    { error: 6, timeout: 5, fail: 4, handed_off: 3, pass: 0, skipped: -1, site_down: -1 }[
      job.outcome
    ] *
      1000 +
    job.claims.length * 100 +
    (job.wall_s ?? 0) / 60;
  return [...jobs]
    .filter((job) => job.outcome !== 'pass' || job.claims.length > 0 || job.unshown_check)
    .filter((job) => !['skipped', 'site_down'].includes(job.outcome))
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, count);
}

export function renderReport(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Live benchmark, ${result.started_at.slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');
  lines.push(
    `Install ${result.install.host}, version ${result.install.version ?? 'unknown'}. ` +
      `${result.jobs.length} jobs (${result.mode === 'sample' ? 'sampled with repeats' : 'each task once'}, seed ${result.seed}). ` +
      `Model spend recorded by the install: ${result.spend_usd === null ? 'unknown' : `$${result.spend_usd.toFixed(2)}`} ` +
      `(cap $${result.spend_cap_usd.toFixed(2)}${result.stopped_for_spend ? ', reached: the run stopped early' : ''}).`,
  );
  const model = result.install.model;
  lines.push(
    model
      ? `Chats ran on ${model.model} (${model.provider}), ${model.vision ? 'with' : 'without'} screenshots shown to the model.`
      : 'The model the chats ran on could not be read.',
  );
  const mismatched = result.jobs.filter((job) => job.model && job.model.model !== job.wanted_model);
  if (mismatched.length) {
    const wanted = [...new Set(mismatched.map((job) => job.wanted_model))];
    lines.push(
      `${mismatched.length} jobs ran on a different model than they are meant to be measured on (${wanted.join(', ')}); the install picks one model for every chat, so those need a run with it set.`,
    );
  }
  const table = (bars: readonly Bar[]) => {
    lines.push('| Bar | Target | Value | n | Status |');
    lines.push('|---|---|---|---|---|');
    for (const bar of bars)
      lines.push(
        `| ${bar.label} | ${bar.target} | ${cell(bar.value)} | ${bar.n} | ${bar.status.replace('_', ' ')} |`,
      );
  };
  lines.push('');
  lines.push('## Bars (real tier)');
  lines.push('');
  lines.push('Real sites and real accounts only. Practice-site jobs are never counted here.');
  lines.push('');
  table(result.bars);
  const slots = result.jobs.filter(
    (job) =>
      job.tier === 'real' && job.outcome === 'skipped' && /^account not provided/.test(job.reason),
  );
  if (slots.length) {
    lines.push('');
    lines.push('Not covered yet:');
    for (const job of slots) lines.push(`- ${job.task}: ${cell(job.reason)}`);
  }
  if (result.practice?.length && result.jobs.some((job) => job.tier === 'practice')) {
    lines.push('');
    lines.push('## Practice tier (regression only, not counted toward any bar)');
    lines.push('');
    lines.push(
      'Demo sites built to be automated: no real bot checks, two-step logins or accounts.',
    );
    lines.push('');
    table(result.practice);
  }
  lines.push('');
  lines.push('## Jobs');
  lines.push('');
  lines.push(
    '| # | Task | Tier | Category | Outcome | Time | Steps | Approvals | Hand-off (from first reaching the page) | Claims | Why |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const job of result.jobs) {
    const handoff = job.handoffs.length
      ? job.handoffs
          .map(
            (handoff) =>
              `${duration(handoff.latency_s)}${handoff.last_step_s === null ? '' : ` (${duration(handoff.last_step_s)} after the last step there)`}`,
          )
          .join(', ')
      : job.unshown_check
        ? 'not shown'
        : '—';
    lines.push(
      `| ${job.job} | ${job.task} | ${job.tier} | ${job.category} | ${job.outcome} | ${duration(job.wall_s)} | ${job.steps} | ${job.approvals} | ${handoff} | ${job.claims.length} | ${cell(job.reason).slice(0, 200)} |`,
    );
  }
  const flagged = result.jobs.filter((job) => job.claims.length);
  if (flagged.length) {
    lines.push('');
    lines.push('## Claims with nothing behind them');
    lines.push('');
    for (const job of flagged)
      for (const claim of job.claims)
        lines.push(
          `- ${job.task} (#${job.job}): "${cell(claim.sentence).slice(0, 200)}" — wanted ${claim.wanted}.`,
        );
  }
  const bad = worst(result.jobs);
  if (bad.length) {
    lines.push('');
    lines.push('## Worst failures');
    lines.push('');
    for (const job of bad)
      lines.push(
        `- ${job.task} (#${job.job}, ${job.outcome}, ${duration(job.wall_s)}): ${cell(job.reason)}`,
      );
  }
  if (result.cleanup.length) {
    lines.push('');
    lines.push('## Clean-up');
    lines.push('');
    for (const line of result.cleanup) lines.push(`- ${line}`);
  }
  lines.push('');
  return lines.join('\n');
}
