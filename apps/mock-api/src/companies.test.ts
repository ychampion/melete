/**
 * The companies surface, checked against the contract it is standing in for.
 *
 * The shapes are parsed with `@melete/contracts` where the contract describes
 * them, so the fixture cannot drift from what the service will serve, and every
 * figure it hands over has to survive `evidenceHolds` against the very message
 * text the detail route returns.
 */
import { expect, test } from 'bun:test';
import * as C from '@melete/contracts';
import { createMock } from './index.ts';

const call = async (
  mock: ReturnType<typeof createMock>,
  path: string,
  method = 'GET',
  body?: unknown,
) => {
  const response = await mock.app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
};

const mapOf = async (mock: ReturnType<typeof createMock>) =>
  (await call(mock, `/spaces/${mock.spaceId}/companies`)).body as unknown as C.CompanyMap;

/**
 * A scripted job advances on timers, so a test waits for the thing it needs
 * rather than for a length of time — a fixed sleep passes alone and fails
 * beside other tests on a loaded machine.
 */
async function until<T>(what: string, check: () => Promise<T | null>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The job's first draft, once the script has written it. */
const draftOf = (mock: ReturnType<typeof createMock>, jobId: string) =>
  until(`a draft on ${jobId}`, async () => {
    const drafts = C.experienceOperations['GET /conversations/{id}/drafts'].response.parse(
      (await call(mock, `/conversations/${jobId}/drafts`)).body,
    ).drafts;
    return drafts[0] ?? null;
  });

test('the map is the contract: prefixed ids, snake_case fields, optionals present and null', () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  return mapOf(mock).then((map) => {
    const parsed = C.companyMap.parse({
      companies: map.companies,
      items: map.items,
      totals: {
        owed_to_you_minor: map.totals.owed_to_you_minor,
        monthly_spend_minor: map.totals.monthly_spend_minor,
        renewals_next_30d: map.totals.renewals_next_30d,
        price_rises: map.totals.price_rises,
        trials_ending: map.totals.trials_ending,
        data_holders: map.totals.data_holders,
      },
      currency: map.currency,
    });
    expect(parsed.companies.length).toBeGreaterThan(5);
    expect(parsed.items.length).toBeGreaterThan(10);
    for (const company of parsed.companies) expect(company.id.startsWith('co_')).toBe(true);
    for (const item of parsed.items) {
      expect(item.id.startsWith('li_')).toBe(true);
      expect(item.company_id.startsWith('co_')).toBe(true);
      // A nullable optional is served as null, never left out.
      expect('amount_minor' in item).toBe(true);
      expect('due_at' in item).toBe(true);
      expect('job_id' in item).toBe(true);
      expect(item.amount_minor === null || item.amount_minor >= 0).toBe(true);
    }
    // Every company belongs to a real company, and every figure is in one currency.
    const ids = new Set(parsed.companies.map((company) => company.id));
    for (const item of parsed.items) expect(ids.has(item.company_id)).toBe(true);
    for (const item of parsed.items)
      expect(item.currency === null || item.currency === parsed.currency).toBe(true);
  });
});

test('the map counts promises in force and promises whose date has passed', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const map = await mapOf(mock);
  const totals = map.totals as C.CompanyMapTotals & {
    promises_in_force: number;
    promises_lapsed: number;
  };
  const promises = map.items.filter((item) => item.kind === 'promise');
  expect(promises.length).toBeGreaterThan(3);
  expect(totals.promises_in_force + totals.promises_lapsed).toBe(promises.length);
  expect(totals.promises_lapsed).toBeGreaterThan(0);
});

test('the fixture is a freelancer’s inbox: two clients, the bills, and the things owed back', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const map = await mapOf(mock);
  const of = (kind: string) => map.items.filter((item) => item.kind === kind);

  // Two clients owing invoices, one already late and one not yet due.
  const invoices = of('invoice_unpaid');
  expect(invoices).toHaveLength(2);
  expect(new Set(invoices.map((item) => item.company_id)).size).toBe(2);
  expect(invoices.some((item) => Date.parse(item.due_at ?? '') < Date.now())).toBe(true);
  expect(invoices.some((item) => Date.parse(item.due_at ?? '') > Date.now())).toBe(true);

  // The things a person is owed back, each one a different shape of owing.
  expect(of('refund_owed').length).toBeGreaterThan(0);
  expect(of('deposit').length).toBeGreaterThan(0);
  expect(of('compensation').length).toBeGreaterThan(0);
  expect(of('wrong_charge').length).toBeGreaterThan(0);

  // A refund that was promised and has not arrived: the promise lapsed.
  const refund = of('refund_owed')[0];
  if (!refund) throw new Error('the fixture has no refund');
  expect(Date.parse(refund.due_at ?? '')).toBeLessThan(Date.now());

  // What goes out every month, and a price rise on some of it.
  expect(of('subscription').length).toBeGreaterThan(1);
  expect(of('price_rise').length).toBeGreaterThan(0);
  expect(of('trial_ending').length).toBeGreaterThan(0);
  expect(of('renewal').length).toBeGreaterThan(0);

  // Everything a company said it would do, from more than one company.
  expect(new Set(of('promise').map((item) => item.company_id)).size).toBeGreaterThan(3);

  // Every name is invented and every domain is reserved for examples.
  for (const company of map.companies) expect(company.domain.endsWith('.example')).toBe(true);
});

test('every figure on the map opens a sentence that is word for word in its message', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const map = await mapOf(mock);
  for (const item of map.items) {
    const { body } = await call(mock, `/ledger/${item.id}`);
    const detail = body as unknown as {
      item: C.LedgerItem;
      company: C.Company;
      message: { id: string; subject: string; from: string; received_at: string; text: string };
    };
    expect(detail.company.id).toBe(item.company_id);
    expect(detail.message.id).toBe(item.evidence[0]?.message_id ?? '');
    for (const span of detail.item.evidence)
      expect(C.evidenceHolds(detail.message.text, span)).toBe(true);
  }
});

test('a scan says what it has seen while it runs, and the same one comes back until it is done', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const first = (await call(mock, `/spaces/${mock.spaceId}/companies/scan`, 'POST')).body as {
    scan_id: string;
    status: string;
  };
  expect(first.status).toBe('running');
  const again = (await call(mock, `/spaces/${mock.spaceId}/companies/scan`, 'POST')).body as {
    scan_id: string;
  };
  expect(again.scan_id).toBe(first.scan_id);
  const progress = (await call(mock, `/spaces/${mock.spaceId}/companies/scan/${first.scan_id}`))
    .body as { status: string; messages_seen: number; items_found: number };
  expect(['running', 'done']).toContain(progress.status);
  expect(progress.messages_seen).toBeGreaterThanOrEqual(0);
  expect(progress.items_found).toBeGreaterThanOrEqual(0);
  // Inside a space the caller can see, an unknown scan is simply missing.
  const missing = await call(mock, `/spaces/${mock.spaceId}/companies/scan/job_nope`);
  expect(missing.response.status).toBe(404);
});

test('a space the caller cannot see is refused, and says nothing about what is in it', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const started = (await call(mock, `/spaces/${mock.spaceId}/companies/scan`, 'POST')).body as {
    scan_id: string;
  };
  const foreign = 'sp_01M2000000000000000000000A';
  expect(foreign).not.toBe(mock.spaceId);

  for (const [path, method] of [
    [`/spaces/${foreign}/companies`, 'GET'],
    [`/spaces/${foreign}/companies/scan`, 'POST'],
    // A real scan id asked for through the wrong space is refused too, and the
    // answer is the same whether or not that scan exists.
    [`/spaces/${foreign}/companies/scan/${started.scan_id}`, 'GET'],
    [`/spaces/${foreign}/companies/scan/job_nope`, 'GET'],
  ] as const) {
    const { response, body } = await call(mock, path, method);
    expect(response.status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe('scope_denied');
    // Nothing of the space's contents leaks through the refusal.
    expect(JSON.stringify(body)).not.toContain(started.scan_id);
    expect(JSON.stringify(body)).not.toContain('co_');
  }

  // A caller outside the space cannot tell a real scan id from a made-up one.
  const real = await call(mock, `/spaces/${foreign}/companies/scan/${started.scan_id}`);
  const fake = await call(mock, `/spaces/${foreign}/companies/scan/job_nope`);
  expect(real.body).toEqual(fake.body);
});

test('an unknown ledger id stays a 404, on every route that takes one', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  for (const [path, method] of [
    ['/ledger/li_01M2000000000000000000000A', 'GET'],
    ['/ledger/li_01M2000000000000000000000A/handle', 'POST'],
  ] as const) {
    const { response, body } = await call(mock, path, method);
    expect(response.status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('not_found');
  }
  const patched = await call(mock, '/ledger/li_01M2000000000000000000000A', 'PATCH', {
    status: 'settled',
  });
  expect(patched.response.status).toBe(404);
});

test('"not this" takes a row off the map and "settled" leaves it on it', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const before = await mapOf(mock);
  const dropped = before.items[0];
  const settled = before.items[1];
  if (!dropped || !settled) throw new Error('the fixture is empty');

  const refused = await call(mock, `/ledger/${dropped.id}`, 'PATCH', { status: 'handling' });
  expect(refused.response.status).toBe(400);

  await call(mock, `/ledger/${dropped.id}`, 'PATCH', { status: 'dropped' });
  await call(mock, `/ledger/${settled.id}`, 'PATCH', { status: 'settled' });
  const after = await mapOf(mock);
  expect(after.items.some((item) => item.id === dropped.id)).toBe(false);
  expect(after.items.find((item) => item.id === settled.id)?.status).toBe('settled');
});

test('handling an item starts one job, and asking again returns the same one', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const map = await mapOf(mock);
  const item = map.items.find((row) => row.kind === 'refund_owed');
  if (!item) throw new Error('the fixture has no refund');

  const first = (await call(mock, `/ledger/${item.id}/handle`, 'POST')).body as { job_id: string };
  expect(first.job_id.startsWith('job_')).toBe(true);
  const again = (await call(mock, `/ledger/${item.id}/handle`, 'POST')).body as { job_id: string };
  expect(again.job_id).toBe(first.job_id);

  // The job is a conversation like any other, and the item now names it.
  const conversation = C.experienceOperations['GET /conversations/{id}'].response.parse(
    (await call(mock, `/conversations/${first.job_id}`)).body,
  ).conversation;
  expect(conversation.title).toBe(
    map.companies.find((company) => company.id === item.company_id)?.name ?? '',
  );
  const after = await mapOf(mock);
  expect(after.items.find((row) => row.id === item.id)?.job_id).toBe(first.job_id);
  expect(after.items.find((row) => row.id === item.id)?.status).toBe('handling');
});

test('the job parks on one approval that names the address it sends from', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const map = await mapOf(mock);
  const item = map.items.find((row) => row.kind === 'refund_owed');
  if (!item) throw new Error('the fixture has no refund');
  const jobId = ((await call(mock, `/ledger/${item.id}/handle`, 'POST')).body as { job_id: string })
    .job_id;
  const draft = await draftOf(mock, jobId);
  // Nothing has been sent: the draft is a draft until a person says so.
  expect(draft.status).toBe('draft');

  const sent = C.experienceOperations['POST /drafts/{id}/send'].response.parse(
    (await call(mock, `/drafts/${draft.id}/send`, 'POST')).body,
  );
  const permission = sent.permission;
  if (!permission) throw new Error('the send did not ask');
  expect(permission.options).toEqual(['allow_once', 'deny']);
  expect(permission.draft?.body).toContain('TC-88412');
  expect(permission.why.join(' ')).toContain('From: jamie.davis@fastmail.example');
  expect(permission.why.join(' ')).toContain('To: ');
});

test('once approved the job sends, keeps going, and the sent step can still be undone', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const map = await mapOf(mock);
  const item = map.items.find((row) => row.kind === 'refund_owed');
  if (!item) throw new Error('the fixture has no refund');
  const jobId = ((await call(mock, `/ledger/${item.id}/handle`, 'POST')).body as { job_id: string })
    .job_id;
  const draft = await draftOf(mock, jobId);
  const permission = C.experienceOperations['POST /drafts/{id}/send'].response.parse(
    (await call(mock, `/drafts/${draft.id}/send`, 'POST')).body,
  ).permission;
  if (!permission) throw new Error('the send did not ask');

  await call(mock, `/permissions/${permission.id}`, 'POST', {
    option: 'allow_once',
    version: permission.version,
  });
  // The send leaves a receipt, and the rest of the days play out after it.
  const receipts = await until(`the receipt on ${jobId}`, async () => {
    const rows = C.experienceOperations['GET /conversations/{id}/receipts'].response.parse(
      (await call(mock, `/conversations/${jobId}/receipts`)).body,
    ).receipts;
    return rows.length > 0 ? rows : null;
  });
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.what).toContain('Sent a message to');
  expect(receipts[0]?.undo).not.toBeNull();

  // The reply, the follow-up and the ending are on the timeline, in order.
  const said = await until(`the ending on ${jobId}`, async () => {
    const events = C.experienceEventPage.parse(
      (await call(mock, `/conversations/${jobId}/events?since=0&limit=200`)).body,
    ).events;
    const text = events
      .map((event) =>
        event.item.type === 'note' || event.item.type === 'say' ? event.item.text : '',
      )
      .join('\n');
    return text.includes('Settled.') ? text : null;
  });
  expect(said).toContain('they replied');
  expect(said).toContain('replied again');
  expect(said).toContain('Settled.');
});
