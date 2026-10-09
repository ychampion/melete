import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  type CapabilityClaims,
  canonicalizePayload,
  runListResponse,
  runResponse,
} from '@melete/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import {
  action,
  approval,
  connection,
  job,
  owner,
  pushIntent,
  runEntry,
  space,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { PushService } from '../../src/push/service.ts';
import { attachRuns, RunService, WAITING_FOR_OK } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'runs-approval-fixture-signing-key-32b';
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: KEY,
      resolveModel: async () => ({ provider: 'fireworks', model: 'deepseek' }),
    })
  : null;
const runs = jobs ? new RunService(jobs) : null;
if (runner && runs) attachRuns(runner, runs);
const approvals = jobs && runner ? new ApprovalService(jobs, runner) : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      runs: runs ?? undefined,
      approvals: approvals ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
const web = newId('conn');
const computer = newId('conn');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'runs-approval@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  await handle.db.insert(connection).values([
    { id: web, spaceId, label: 'Web', provider: 'web' },
    { id: computer, spaceId, label: 'Computer', provider: 'sandbox' },
  ]);
}
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, method = 'GET', body?: unknown) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const view = async (id: string) =>
  runResponse.parse(await (await request(`/runs/${id}`)).json()).run;
const row = async (id: string) => required(jobs).get(id);
const db = () => required(handle).db;

/** A conversation, and long work it started in the background. */
async function startFromChat(goal: string, doneWhen: string) {
  return required(jobs).transaction(async (tx) => {
    const chat = await required(jobs).createInTransaction(
      tx,
      { space_id: spaceId, title: 'Robot vacuums', objective: goal },
      { kind: 'chat' },
    );
    const run = await required(runs).create(
      tx,
      spaceId,
      { goal, done_when: doneWhen },
      { conversation: chat, principalId: ownerId },
    );
    return { chat, run };
  });
}

async function claimNow(id: string) {
  await db()
    .update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
  const current = await row(id);
  return required(runner).claim({
    job_id: id,
    expected_epoch: current.leaseEpoch,
    expected_version: current.stateVersion,
    reason: 'timer',
  });
}
const claim = async (id: string) => required(await claimNow(id));
const tool = (claims: CapabilityClaims, name: string, input: unknown) =>
  required(runs).call(claims, name, input);
const commit = (claims: CapabilityClaims, outcome: AttemptOutcome = done()) =>
  required(runner).commitOutcome(claims, outcome);
const done = (summary = 'Shift over.'): AttemptOutcome => ({
  kind: 'completed',
  summary,
  evidence: [],
});

/** Pages the shift read, each one recorded by Melete with what it said. */
async function read(jobId: string, attemptId: string, pages: string[], status = 'succeeded') {
  for (const url of pages) {
    const id = newId('act');
    await db()
      .insert(action)
      .values({
        id,
        jobId,
        attemptId,
        connectionId: web,
        kind: 'web.fetch',
        effectClass: 'read',
        canonicalPayload: { url },
        payloadHash: createHash('sha256').update(id).digest('hex'),
        idempotencyKey: id,
        status,
        receipt:
          status === 'succeeded'
            ? {
                action_id: id,
                connection_id: web,
                external_ref: url,
                detail: {
                  url,
                  final_url: url,
                  title: `Review at ${new URL(url).hostname}`,
                  body: 'The Roborock Q7 M5+ picked up cat hair best of the robots we tested.',
                },
              }
            : null,
      });
  }
}

/** The shift asks to scroll its own browser, and the person's OK is asked for. */
async function askToScroll(jobId: string, attemptId: string) {
  const payload = {
    step: 7,
    actions: [
      { action: 'scroll', x: 640, y: 400, amount: 15 },
      { action: 'scroll', x: 640, y: 400, amount: 15 },
    ],
  };
  const canonical = canonicalizePayload(payload);
  const actionId = newId('act');
  await db().insert(action).values({
    id: actionId,
    jobId,
    attemptId,
    connectionId: computer,
    kind: 'computer.batch',
    effectClass: 'write_reversible',
    canonicalPayload: canonical.canonical,
    payloadHash: canonical.hash,
    idempotencyKey: actionId,
    status: 'needs_approval',
  });
  const approvalId = newId('apr');
  await db()
    .insert(approval)
    .values({
      id: approvalId,
      actionId,
      jobRevision: (await row(jobId)).revision,
      payloadHash: canonical.hash,
    });
  return { actionId, approvalId, hash: canonical.hash };
}

/** The check of the run's latest result, still under way. */
async function checker(runId: string) {
  const steps = (await view(runId)).steps.filter(
    (step) => step.title === 'Checking the result' && step.status !== 'done',
  );
  return required(steps.at(-1)).id;
}

const decisionPushes = async (approvalId: string) =>
  db()
    .select({ url: pushIntent.url, kind: pushIntent.kind })
    .from(pushIntent)
    .where(eq(pushIntent.dedupKey, `decision:approval:${approvalId}`));

const PAGES = [
  'https://www.rtings.com/vacuum/reviews/roborock/q7-m5-plus',
  'https://www.rtings.com/vacuum/reviews/ecovacs/t90-pro-omni',
  'https://www.vacuumwars.com/best-robot-vacuums',
  'https://www.vacuumwars.com/eufy-omni-c28-review',
  'https://www.cnet.com/home/kitchen-and-household/best-robot-vacuum',
  'https://www.tomsguide.com/best-picks/best-robot-vacuums',
  'https://www.pcmag.com/picks/the-best-robot-vacuums',
  'https://www.zdnet.com/article/best-robot-vacuum-for-pet-hair',
  'https://www.wired.com/gallery/best-robot-vacuums',
  'https://www.theverge.com/robot-vacuum-guide',
  'https://www.techradar.com/news/best-robot-vacuum-cleaners',
  'https://www.trustedreviews.com/best/best-robot-vacuum',
];
const REPORT =
  'Five robot vacuums under $600 for a small apartment with a cat: Ecovacs T90 Pro Omni, eufy Omni C28, Roborock Q8 Max+, Roborock Q7 M5+, MOVA P10 Pro Ultra.';

withDb('background work that needs the person’s OK', () => {
  afterAll(async () => {
    runs?.stopWatchdog();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('an OK it asks for shows on Home, the run and its chat, is sent once, and approving it lets the run report back', async () => {
    const { chat, run } = await startFromChat(
      'Find the 5 best robot vacuums under $600 for a small apartment with a cat',
      'Five named, each backed by three review sources',
    );
    const shift = await claim(run.id);
    await read(run.id, shift.claims.attempt_id, PAGES);
    await read(run.id, shift.claims.attempt_id, ['https://www.bestbuy.com/blocked'], 'failed');
    const asked = await askToScroll(run.id, shift.claims.attempt_id);
    // Before, while its shift still ran, the run read "Working on it".
    const working = await view(run.id);
    expect(working.status).toBe('needs_you');
    expect(working.status_line).toBe(WAITING_FOR_OK);
    await commit(shift.claims, { kind: 'waiting_for_approval', action_ids: [asked.actionId] });
    expect((await row(run.id)).state).toBe('waiting_for_approval');

    // The run's page and its card in the chat say it waits for the person.
    const waiting = await view(run.id);
    expect(waiting.status).toBe('needs_you');
    expect(waiting.question).toBe(WAITING_FOR_OK);
    const inChat = runListResponse.parse(
      await (await request(`/runs?conversation_id=${chat.id}`)).json(),
    ).runs;
    expect(inChat.map((entry) => [entry.id, entry.status])).toEqual([[run.id, 'needs_you']]);

    // Home's list of permissions holds it, answerable, under the run's id.
    const permissions = new ExperiencePermissions(required(handle).sql, {} as never, {} as never);
    const listed = (await permissions.list(spaceId)).permissions;
    const card = required(listed.find((entry) => entry.id === asked.approvalId));
    expect(card.conversation_id).toBe(run.id);
    expect(card.options).toEqual(['allow_once', 'deny']);

    // The decision notification opens the run, not a chat that is not there.
    const push = new PushService(db(), { keys: null, subject: null, extraOrigins: [] });
    await push.collectDecisions(ownerId, new Date(0));
    expect(await decisionPushes(asked.approvalId)).toEqual([
      { url: `/#/runs/${run.id}`, kind: 'decision' },
    ]);
    // The watchdog does not call it stalled: it tells the person, once.
    const watchdog = required(runs);
    expect((await watchdog.watch(4)).asked).toEqual([asked.approvalId]);
    expect((await view(run.id)).latest_report?.title).toBe('It needs your OK to go on');
    expect((await watchdog.watch(4)).asked).toEqual([]);
    expect((await watchdog.watch(4)).paused).not.toContain(run.id);
    expect(await decisionPushes(asked.approvalId)).toHaveLength(1);

    // Approving it wakes the run, which goes on.
    const approved = await request(`/approvals/${asked.approvalId}`, 'POST', {
      decision: 'approved',
      payload_hash: asked.hash,
    });
    expect(approved.status).toBe(200);
    expect((await row(run.id)).state).toBe('queued');
    expect((await view(run.id)).status).toBe('working');
    const next = await claim(run.id);
    // It carries out the scroll it was allowed, as the broker records it.
    await db().update(action).set({ status: 'succeeded' }).where(eq(action.id, asked.actionId));
    await tool(next.claims, 'run.finish', { summary: REPORT });
    await commit(next.claims);

    // The check is shown what the record says was read, not only what the result cites.
    const check = await claim(await checker(run.id));
    const brief = check.bundle.job.objective;
    expect(brief).toContain(
      '12 page reads that went through (12 distinct pages), 1 read that did not',
    );
    expect(brief).toContain(PAGES[0] as string);
    expect(brief).toContain('cat hair');
    expect(brief).toContain('A page listed here was read');
    expect(brief).not.toContain('bestbuy.com/blocked');
    await tool(check.claims, 'run.finish', { summary: 'Holds up.', verdict: 'passes' });
    await commit(check.claims);

    // The result is given without another shift, and reaches the conversation.
    expect(await claimNow(run.id)).toBeNull();
    const reported = runListResponse.parse(
      await (await request(`/runs?conversation_id=${chat.id}`)).json(),
    ).runs;
    expect(reported[0]?.status).toBe('done');
    expect(reported[0]?.result).toBe(REPORT);
    expect(reported[0]?.status_line).toStartWith('Done · checked');
  });

  test('a reply while it waits for an OK takes the place of the request; gaps it cannot close are reported, not disowned', async () => {
    const { run } = await startFromChat(
      'Find the 5 best robot vacuums under $600 for a cat',
      'Five named, with sources',
    );
    const shift = await claim(run.id);
    await read(run.id, shift.claims.attempt_id, PAGES.slice(0, 4));
    const asked = await askToScroll(run.id, shift.claims.attempt_id);
    await commit(shift.claims, { kind: 'waiting_for_approval', action_ids: [asked.actionId] });

    // Before, these words were kept as a note and changed nothing.
    const reply = await request(`/runs/${run.id}/message`, 'POST', {
      text: 'Just send me what you have in the chat, please.',
    });
    expect(reply.status).toBe(200);
    const [withdrawn] = await db()
      .select({ decision: approval.decision, by: approval.decidedBy })
      .from(approval)
      .where(eq(approval.id, asked.approvalId));
    expect(withdrawn).toEqual({ decision: 'denied', by: 'replaced' });
    expect((await row(run.id)).state).toBe('queued');
    expect((await view(run.id)).status).toBe('working');
    const answered = await claim(run.id);
    expect(answered.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'Just send me what you have in the chat, please.',
    ]);
    await tool(answered.claims, 'run.finish', { summary: REPORT });
    await commit(answered.claims);

    // The check names a gap, and the run is told its record shows the reads.
    const check = await claim(await checker(run.id));
    await tool(check.claims, 'run.finish', {
      summary: 'Two gaps.',
      verdict: 'gaps',
      gaps: ['Only 4 review sites were read; three per pick is not shown for the MOVA P10.'],
    });
    await commit(check.claims);
    const back = await claim(run.id);
    expect(back.bundle.job.objective).toContain('Your own record shows what you read');
    expect(back.bundle.job.objective).toContain(PAGES[2] as string);
    expect(back.bundle.job.objective).toContain('do not take them back');
    await commit(back.claims);

    // Shifts that cannot close the gap give the result with the gap named,
    // instead of stopping to ask while the person hears nothing.
    for (let idle = 1; idle < 3; idle++) await commit((await claim(run.id)).claims);
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.check.state).toBe('not_confirmed');
    expect(finished.result).toBe(
      `${REPORT}\n\nWhat a separate check could not confirm:\n- Only 4 review sites were read; three per pick is not shown for the MOVA P10.`,
    );
    const done = await db()
      .select({ title: pushIntent.title })
      .from(pushIntent)
      .where(sql`starts_with(${pushIntent.dedupKey}, ${`run-report:${run.id}:`})`);
    expect(done.map((entry) => entry.title)).toContain(`${run.title}: Done`);
    const gaveUp = await db()
      .select({ kind: runEntry.kind })
      .from(runEntry)
      .where(
        and(
          eq(runEntry.runJobId, run.id),
          eq(runEntry.kind, 'finished'),
          isNull(runEntry.stepJobId),
        ),
      );
    expect(gaveUp).toHaveLength(1);
  });
});
