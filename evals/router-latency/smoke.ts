/** Bounded HTTP observation of an already provisioned disposable target. Never configures a service. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

export const EXPECTED_MODEL = 'nebius/nvidia/Nemotron-3.5-Super-VL';
const id = z.string().min(1);
const instant = z.iso.datetime({ offset: true });
const httpUrl = z.url().refine((s) => {
  const url = new URL(s);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, 'Use an HTTP URL without embedded credentials');
const localUrl = httpUrl.refine(
  (s) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(s).hostname),
  'Evidence and fake providers must be local',
);
const eventSchema = z.strictObject({ summary: id, start: instant, end: instant });
const account = z.strictObject({ sessionEnv: id });
const candidate = z.strictObject({
  principalId: id,
  availability: z.enum(['busy', 'free']),
  calendarUrl: localUrl,
  authEnv: id.optional(),
});
export const configSchema = z.strictObject({
  version: z.literal(1),
  preprovisionedDisposable: z.literal(true),
  targetId: id,
  revision: id,
  baseUrl: httpUrl,
  campaignId: id,
  expectedModel: z.literal(EXPECTED_MODEL),
  accounts: z.record(id, account),
  gate: z.strictObject({ url: localUrl, tokenEnv: id, verificationFile: id }),
  evidence: z.strictObject({ url: localUrl, tokenEnv: id.optional() }),
  cases: z
    .array(
      z.strictObject({
        roomId: id,
        requestedBy: id,
        candidates: z.array(candidate).min(2),
        sourceMessage: z.strictObject({ id, subject: id }),
        event: eventSchema,
        answer: id,
      }),
    )
    .min(1)
    .max(2),
  timeoutMs: z.number().int().min(100).max(180_000).default(120_000),
  requestTimeoutMs: z.number().int().min(50).max(5000).default(3000),
  pollMs: z.number().int().min(10).max(5000).default(250),
  maxRequests: z.number().int().min(5).max(2000).default(1000),
});
export type SmokeConfig = z.input<typeof configSchema>;
const gateSchema = z.object({
  campaignId: id,
  targetId: id,
  revision: id,
  gateId: id,
  hardCapUsd: z.number().positive().max(0.25),
  spentUsd: z.number().nonnegative(),
  heldUsd: z.number().nonnegative(),
  preCallEnforced: z.literal(true),
  includesBackground: z.literal(true),
  includesRetries: z.literal(true),
  allModelPurposes: z.literal(true),
  resolvedModels: z.record(id, z.literal(EXPECTED_MODEL)),
  expiresAt: instant,
  proofSha256: z.string().regex(/^[a-f\d]{64}$/),
});
const proofSchema = z.object({
  campaignId: id,
  gateId: id,
  targetId: id,
  revision: id,
  method: z.literal('pre-call rejection verified'),
  proofSha256: z.string().regex(/^[a-f\d]{64}$/),
  verifiedAt: instant,
});
const usageCall = z.object({
  id,
  purpose: id,
  modelActual: id,
  costUsd: z.number().nonnegative(),
  status: id,
  jobId: id.nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  startedAt: instant.nullable(),
  endedAt: instant.nullable(),
});
const evidenceSchema = z.object({
  campaignId: id,
  targetId: id,
  revision: id,
  quiescent: z.boolean(),
  calls: z.array(usageCall),
  sourceReads: z.array(z.object({ messageId: id, jobId: id, at: instant.nullable() })),
  tools: z.array(
    z.object({
      jobId: id,
      name: id,
      memberId: id.optional(),
      complete: z.boolean().optional(),
      at: instant.nullable(),
    }),
  ),
  actions: z.array(
    z.object({
      id,
      approvalId: id,
      payloadHash: id,
      memberId: id,
      kind: z.literal('room.add_to_member_calendar'),
      event: eventSchema,
      status: id,
      verifiedAt: instant.nullable(),
    }),
  ),
  calendarOperations: z.array(
    z.object({
      method: z.enum(['PUT', 'GET']),
      memberId: id,
      uid: id,
      status: z.number().int(),
      at: instant.nullable(),
    }),
  ),
  observations: z
    .array(
      z.object({
        stage: id,
        at: instant.nullable(),
        source: id,
        jobId: id.optional(),
        attemptId: id.optional(),
        actionId: id.optional(),
      }),
    )
    .default([]),
});
const boardSchema = z.object({
  items: z.array(
    z.object({
      id,
      kind: id,
      state: id,
      title: id,
      thread_id: id.nullable(),
      starts_at: instant.nullable(),
      assignee: z.object({ principal_id: id }).nullable(),
    }),
  ),
});
const cardSchema = z.object({
  id,
  version: id,
  payload_hash: id,
  eligible_approvers: z.array(z.object({ principal_id: id })),
});
const threadSchema = z.object({
  requests: z.array(
    z.object({
      job_id: id,
      status: id,
      permissions: z.array(cardSchema).default([]),
      receipts: z.array(z.object({ id }).passthrough()).default([]),
    }),
  ),
});

type Stage = {
  stage: string;
  at: string | null;
  observedAt: string;
  source: string;
  jobId?: string;
  actionId?: string;
};
export type SmokeReport = {
  version: 1;
  status: 'passed' | 'stopped';
  targetId: string;
  revision: string;
  expectedModel: string;
  workflowsAttempted: number;
  httpRequests: number;
  cleanupRequests: number;
  httpMs: number;
  elapsedMs: number;
  humanAutomationMs: number;
  observationPollMs: number;
  observations: Stage[];
  gate?: z.infer<typeof gateSchema>;
  calls: z.infer<typeof usageCall>[];
  cases: {
    roomId: string;
    status: 'passed';
    memberId: string;
    actionId: string;
    actualStartUtc: string;
    actualEndUtc: string;
    wallMs: number;
  }[];
  error?: string;
};
function sameEvent(actual: z.infer<typeof eventSchema>, wanted: z.infer<typeof eventSchema>) {
  return (
    actual.summary === wanted.summary &&
    Date.parse(actual.start) === Date.parse(wanted.start) &&
    Date.parse(actual.end) === Date.parse(wanted.end)
  );
}
function utcIcs(value: string): string {
  if (!/^\d{8}T\d{6}Z$/.test(value))
    throw new Error('Read-back must carry an exact UTC event instant');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error('Invalid calendar instant');
  return new Date(iso).toISOString();
}
export function verifyCalendar(
  text: string,
  actionId: string,
  hash: string,
  wanted: z.infer<typeof eventSchema>,
) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) {
      events.push(current);
      current = undefined;
    } else current?.push(line);
  }
  const matching = events.filter((e) => e.includes(`UID:${actionId}`));
  if (matching.length !== 1) throw new Error('Calendar read-back has no unique action UID');
  const event = matching[0] ?? [];
  const field = (key: string) => {
    const values = event.filter((line) => line.startsWith(`${key}:`));
    if (values.length !== 1) throw new Error(`Calendar read-back has no unique ${key}`);
    return (values[0] ?? '').slice(key.length + 1);
  };
  if (field('X-MELETE-ACTION-ID') !== actionId || field('X-MELETE-PAYLOAD-HASH') !== hash)
    throw new Error('Calendar read-back does not bind the approved action');
  const summary = field('SUMMARY').replace(/\\([nN,;\\])/g, (_match, escaped: string) =>
    escaped.toLowerCase() === 'n' ? '\n' : escaped,
  );
  if (summary !== wanted.summary) throw new Error('Calendar read-back has the wrong summary');
  const start = utcIcs(field('DTSTART'));
  const end = utcIcs(field('DTEND'));
  if (Date.parse(start) !== Date.parse(wanted.start) || Date.parse(end) !== Date.parse(wanted.end))
    throw new Error('Calendar read-back has the wrong event instant');
  return { start, end };
}

export async function runSmoke(
  input: SmokeConfig,
  options: { budgetUsd: number; limit: number },
  env: Record<string, string | undefined> = process.env,
): Promise<SmokeReport> {
  const config = configSchema.parse(input);
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > 0.25)
    throw new Error('Supply a positive campaign budget no greater than 0.25 USD');
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 2 ||
    options.limit > config.cases.length
  )
    throw new Error('Limit must be 1 or 2 and no greater than the assigned cases');
  if (new Set(config.cases.map((c) => c.roomId)).size !== config.cases.length)
    throw new Error('Cases require different empty rooms');
  const secret = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing local reference ${name}`);
    return value;
  };
  const session = (person: string) => {
    const account = config.accounts[person];
    if (!account) throw new Error('No session assigned to the actual member');
    return secret(account.sessionEnv);
  };
  // Resolve prerequisites before any product mutation. The proof is supplied by the target provisioner.
  const proof = proofSchema.parse(JSON.parse(await readFile(config.gate.verificationFile, 'utf8')));
  const gateToken = secret(config.gate.tokenEnv);
  for (const c of config.cases.slice(0, options.limit)) {
    session(c.requestedBy);
    if (Date.parse(c.event.end) <= Date.parse(c.event.start))
      throw new Error('Event ends before it starts');
    for (const candidate of c.candidates) {
      session(candidate.principalId);
      if (candidate.authEnv) secret(candidate.authEnv);
    }
    if (
      new Set(c.candidates.map((p) => p.principalId)).size !== c.candidates.length ||
      !c.candidates.some((p) => p.availability === 'busy') ||
      !c.candidates.some((p) => p.availability === 'free')
    )
      throw new Error('Assign distinct busy and free candidates');
  }
  const started = performance.now();
  const deadline = started + config.timeoutMs;
  const report: SmokeReport = {
    version: 1,
    status: 'stopped',
    targetId: config.targetId,
    revision: config.revision,
    expectedModel: config.expectedModel,
    workflowsAttempted: 0,
    httpRequests: 0,
    cleanupRequests: 0,
    httpMs: 0,
    elapsedMs: 0,
    humanAutomationMs: 0,
    observationPollMs: config.pollMs,
    observations: [],
    calls: [],
    cases: [],
  };
  const activeJobs: { room: string; job: string; person: string }[] = [];
  const request = async (
    url: string,
    method = 'GET',
    headers: Record<string, string> = {},
    body?: unknown,
    cleanup = false,
  ) => {
    if (!cleanup && (report.httpRequests >= config.maxRequests || performance.now() >= deadline))
      throw new Error('HTTP probe bound reached');
    if (cleanup) report.cleanupRequests++;
    else report.httpRequests++;
    const before = performance.now();
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              config.requestTimeoutMs,
              cleanup ? config.requestTimeoutMs : deadline - performance.now(),
            ),
          ),
        ),
      });
      // Consume under the same timeout and cap, including chunked responses.
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      try {
        if (reader)
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4 * 1024 * 1024) throw new Error('HTTP response exceeds 4 MiB');
            chunks.push(value);
          }
      } finally {
        await reader?.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(response.status === 204 || response.status === 304 ? null : bytes, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      report.httpMs += performance.now() - before;
    }
  };
  const getJson = async (url: string, headers: Record<string, string> = {}) => {
    const response = await request(url, 'GET', headers);
    if (!response.ok) throw new Error(`Evidence HTTP ${response.status}`);
    return response.json();
  };
  const product = async (
    person: string,
    path: string,
    method = 'GET',
    body?: unknown,
    expected = 200,
  ) => {
    const response = await request(
      new URL(path, config.baseUrl).toString(),
      method,
      { Cookie: session(person) },
      body,
    );
    if (response.status !== expected)
      throw new Error(`Product ${method} returned ${response.status}, expected ${expected}`);
    return response.json();
  };
  const record = (stage: string, extra: Partial<Stage> = {}) =>
    report.observations.push({
      stage,
      at: null,
      observedAt: new Date().toISOString(),
      source: 'http',
      ...extra,
    });
  const sleep = async () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('HTTP probe timed out');
    await Bun.sleep(Math.min(config.pollMs, remaining));
  };
  const gateStatus = async () => {
    const gate = gateSchema.parse(
      await getJson(config.gate.url, { Authorization: `Bearer ${gateToken}` }),
    );
    if (
      gate.campaignId !== config.campaignId ||
      gate.targetId !== config.targetId ||
      gate.revision !== config.revision ||
      gate.hardCapUsd > options.budgetUsd ||
      gate.spentUsd + gate.heldUsd > gate.hardCapUsd ||
      Date.parse(gate.expiresAt) <= Date.now() ||
      !Object.keys(gate.resolvedModels).length ||
      proof.campaignId !== gate.campaignId ||
      proof.targetId !== gate.targetId ||
      proof.revision !== gate.revision ||
      proof.gateId !== gate.gateId ||
      proof.proofSha256 !== gate.proofSha256 ||
      Date.parse(proof.verifiedAt) > Date.now()
    )
      throw new Error(
        'Verified hard campaign gate does not cover this target, revision, model and allowance',
      );
    report.gate = gate;
    return gate;
  };
  const evidence = async () => {
    const data = evidenceSchema.parse(
      await getJson(
        config.evidence.url,
        config.evidence.tokenEnv
          ? { Authorization: `Bearer ${secret(config.evidence.tokenEnv)}` }
          : {},
      ),
    );
    if (
      data.targetId !== config.targetId ||
      data.campaignId !== config.campaignId ||
      data.revision !== config.revision
    )
      throw new Error('Evidence belongs to a different target or campaign');
    report.calls = data.calls;
    if (data.calls.some((c) => c.modelActual !== config.expectedModel))
      throw new Error('Unexpected actual model identity');
    if (new Set(data.calls.map((c) => c.id)).size !== data.calls.length)
      throw new Error('Duplicate model receipt IDs');
    if (data.calls.reduce((sum, c) => sum + c.costUsd, 0) > options.budgetUsd)
      throw new Error('Recorded campaign cost exceeded allowance');
    return data;
  };
  const readThread = async (person: string, room: string, thread: string) => {
    const view = threadSchema.parse(await product(person, `/rooms/${room}/threads/${thread}`));
    if (view.requests.some((r) => r.status === 'failed' || r.status === 'stopped'))
      throw new Error('Product work stopped or failed');
    return view;
  };
  try {
    await gateStatus();
    const baseline = await evidence();
    if (!baseline.quiescent) throw new Error('Assigned target has work still running');
    const initialCalls = new Set(baseline.calls.map((c) => c.id));
    for (const c of config.cases.slice(0, options.limit)) {
      const before = performance.now();
      const boardPath = `/rooms/${c.roomId}/board`;
      for (const person of new Set([c.requestedBy, ...c.candidates.map((x) => x.principalId)])) {
        if (boardSchema.parse(await product(person, boardPath)).items.length)
          throw new Error('Assigned room board must be empty');
      }
      const threads = z
        .object({ threads: z.array(z.unknown()) })
        .parse(await product(c.requestedBy, `/rooms/${c.roomId}/threads`));
      if (threads.threads.length) throw new Error('Assigned case room already has threads');
      await gateStatus();
      report.workflowsAttempted++;
      const opened = z.object({ thread: z.object({ id }), request_job_id: id.nullable() }).parse(
        await product(
          c.requestedBy,
          `/rooms/${c.roomId}/threads`,
          'POST',
          {
            ask_agent: true,
            submission_id: randomUUID(),
            text: `Retrieve the seeded coach email with subject "${c.sourceMessage.subject}" (message ${c.sourceMessage.id}). Arrange ${c.event.summary} at ${c.event.start} until ${c.event.end}: check the shared calendars, ask an available eligible helper, and if they accept propose the exact calendar event for their approval. Update the board after verified completion.`,
          },
          201,
        ),
      );
      if (!opened.request_job_id) throw new Error('No initial request was created');
      activeJobs.push({ room: c.roomId, job: opened.request_job_id, person: c.requestedBy });
      record('ingress_accepted', { jobId: opened.request_job_id });
      let chosen: z.infer<typeof candidate> | undefined;
      let question: z.infer<typeof boardSchema>['items'][number] | undefined;
      while (!question) {
        const view = await readThread(c.requestedBy, c.roomId, opened.thread.id);
        const questions = new Map<string, z.infer<typeof boardSchema>['items'][number]>();
        for (const person of new Set([c.requestedBy, ...c.candidates.map((x) => x.principalId)])) {
          for (const item of boardSchema.parse(await product(person, boardPath)).items)
            if (item.kind === 'question' && item.state === 'open') questions.set(item.id, item);
        }
        if (questions.size > 1) throw new Error('Additional human input requested');
        question = [...questions.values()][0];
        if (view.requests.some((r) => r.permissions.length))
          throw new Error('Calendar approval preceded the helper answer');
        if (!question && view.requests.some((r) => r.status === 'needs_you'))
          throw new Error('Additional human input requested');
        if (!question) await sleep();
      }
      chosen = c.candidates.find(
        (p) => p.principalId === question?.assignee?.principal_id && p.availability === 'free',
      );
      if (!chosen || question.thread_id !== opened.thread.id)
        throw new Error('Question was not addressed to an available eligible member');
      record('question_available');
      const humanStarted = performance.now();
      const answered = z.object({ request_job_id: id.nullable() }).parse(
        await product(chosen.principalId, `${boardPath}/${question.id}/answer`, 'POST', {
          answer: c.answer,
        }),
      );
      report.humanAutomationMs += performance.now() - humanStarted;
      if (!answered.request_job_id) throw new Error('Answer created no member request');
      activeJobs.push({ room: c.roomId, job: answered.request_job_id, person: chosen.principalId });
      record('answer_accepted', { jobId: answered.request_job_id });
      let card: z.infer<typeof cardSchema> | undefined;
      while (!card) {
        const view = await readThread(chosen.principalId, c.roomId, opened.thread.id);
        const board = boardSchema.parse(await product(chosen.principalId, boardPath));
        if (board.items.some((i) => i.kind === 'question' && i.state === 'open'))
          throw new Error('Additional human input requested');
        const permissions = view.requests.flatMap((r) => r.permissions);
        if (permissions.length > 1) throw new Error('Additional approval requested');
        card = permissions[0];
        if (!card && view.requests.some((r) => r.status === 'needs_you'))
          throw new Error('Additional human input requested');
        if (!card) await sleep();
      }
      if (
        card.eligible_approvers.length !== 1 ||
        card.eligible_approvers[0]?.principal_id !== chosen.principalId
      )
        throw new Error('Calendar approval is not restricted to the member');
      const proposed = await evidence();
      const caseJobs = new Set([opened.request_job_id, answered.request_job_id]);
      const action = proposed.actions.find(
        (a) =>
          a.approvalId === card.id &&
          a.payloadHash === card.payload_hash &&
          a.memberId === chosen.principalId,
      );
      if (
        !action ||
        !sameEvent(action.event, c.event) ||
        !proposed.sourceReads.some(
          (read) => read.messageId === c.sourceMessage.id && caseJobs.has(read.jobId),
        )
      )
        throw new Error('Seeded message retrieval or exact calendar proposal is unverified');
      if (proposed.calendarOperations.some((op) => op.uid === action.id && op.method === 'PUT'))
        throw new Error('Calendar write preceded the member approval');
      for (const member of c.candidates)
        if (
          !proposed.tools.some(
            (t) =>
              t.name === 'room.member_freebusy' &&
              caseJobs.has(t.jobId) &&
              t.memberId === member.principalId &&
              t.complete === true,
          )
        )
          throw new Error('Relevant complete free/busy evidence is missing');
      record('approval_available', { actionId: action.id });
      const wrong = c.candidates.find((p) => p.principalId !== chosen.principalId)?.principalId;
      if (!wrong) throw new Error('No wrong-account check is possible');
      const decision = {
        option: 'allow_once',
        version: card.version,
        payload_hash: card.payload_hash,
      };
      const decisionStarted = performance.now();
      await product(wrong, `/rooms/${c.roomId}/approvals/${card.id}`, 'POST', decision, 403);
      await product(
        chosen.principalId,
        `/rooms/${c.roomId}/approvals/${card.id}`,
        'POST',
        decision,
      );
      report.humanAutomationMs += performance.now() - decisionStarted;
      record('approval_decided', { actionId: action.id });
      let final: z.infer<typeof evidenceSchema>;
      while (true) {
        const view = await readThread(chosen.principalId, c.roomId, opened.thread.id);
        const board = boardSchema.parse(await product(chosen.principalId, boardPath));
        if (
          board.items.some((i) => i.kind === 'question' && i.state === 'open') ||
          view.requests.some((r) => r.permissions.length)
        )
          throw new Error('Additional human input requested');
        final = await evidence();
        if (final.quiescent && view.requests.some((r) => r.status === 'needs_you'))
          throw new Error('Additional human input requested');
        const checked = final.actions.find((a) => a.id === action.id);
        const updated = board.items.some(
          (i) =>
            i.kind === 'event' &&
            i.title === c.event.summary &&
            i.state === 'done' &&
            i.assignee?.principal_id === chosen.principalId &&
            i.starts_at !== null &&
            Date.parse(i.starts_at) === Date.parse(c.event.start),
        );
        if (
          updated &&
          checked?.status === 'succeeded' &&
          checked.verifiedAt &&
          final.quiescent &&
          view.requests.every((r) => r.status === 'done')
        )
          break;
        await sleep();
      }
      const writes = final.calendarOperations.filter(
        (op) => op.uid === action.id && op.method === 'PUT',
      );
      if (
        writes.length !== 1 ||
        writes[0]?.memberId !== chosen.principalId ||
        ![200, 201, 204].includes(writes[0]?.status ?? 0)
      )
        throw new Error('Fake provider did not record one canonical calendar write');
      if (
        !final.calendarOperations.some(
          (op) =>
            op.uid === action.id &&
            op.method === 'GET' &&
            op.memberId === chosen.principalId &&
            op.status === 200,
        )
      )
        throw new Error('Product calendar read-back evidence is missing');
      const provider = await request(
        new URL(
          `${encodeURIComponent(action.id)}.ics`,
          chosen.calendarUrl.endsWith('/') ? chosen.calendarUrl : `${chosen.calendarUrl}/`,
        ).toString(),
        'GET',
        chosen.authEnv ? { Authorization: secret(chosen.authEnv) } : {},
      );
      if (!provider.ok) throw new Error('Fake CalDAV read-back failed');
      const actual = verifyCalendar(await provider.text(), action.id, action.payloadHash, c.event);
      record('verification_completed', {
        actionId: action.id,
        at: final.actions.find((a) => a.id === action.id)?.verifiedAt ?? null,
        source: 'provider-export',
      });
      record('board_update_observed');
      for (const observation of final.observations) record(observation.stage, observation);
      if (!final.calls.some((call) => !initialCalls.has(call.id)))
        throw new Error('No model identity and cost receipts for the workflow');
      for (const call of final.calls) initialCalls.add(call.id);
      report.cases.push({
        roomId: c.roomId,
        status: 'passed',
        memberId: chosen.principalId,
        actionId: action.id,
        actualStartUtc: actual.start,
        actualEndUtc: actual.end,
        wallMs: performance.now() - before,
      });
    }
    await gateStatus();
    report.status = 'passed';
  } catch (error) {
    report.error =
      error instanceof z.ZodError
        ? 'Required configuration or evidence fields are missing or invalid'
        : (error as Error).message;
    // Stop known requests on failure; do not send corrective messages or try another workflow.
    for (const job of activeJobs) {
      try {
        const response = await request(
          new URL(`/rooms/${job.room}/requests/${job.job}/stop`, config.baseUrl).toString(),
          'POST',
          { Cookie: session(job.person) },
          {},
          true,
        );
        await response.body?.cancel();
      } catch {
        /* The pre-call gate still bounds any background work when the target cannot be reached. */
      }
    }
  }
  report.elapsedMs = performance.now() - started;
  return report;
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'smoke.ts --config JSON --budget-usd USD --limit 1 --out JSON\nRequires a pre-provisioned disposable target and externally verified hard pre-call campaign gate.\n',
    );
    return;
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag ||
      !['--config', '--budget-usd', '--limit', '--out'].includes(flag) ||
      !value ||
      flags.has(flag)
    )
      throw new Error('Invalid or repeated argument');
    flags.set(flag, value);
  }
  const path = flags.get('--config');
  const out = flags.get('--out');
  if (!path || !out || !flags.has('--budget-usd') || !flags.has('--limit'))
    throw new Error('Supply --config, --budget-usd, --limit and --out');
  const report = await runSmoke(JSON.parse(await readFile(path, 'utf8')), {
    budgetUsd: Number(flags.get('--budget-usd')),
    limit: Number(flags.get('--limit')),
  });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof z.ZodError ? 'Invalid probe configuration' : (error as Error).message}\n`,
    );
    process.exitCode = 1;
  }
}
