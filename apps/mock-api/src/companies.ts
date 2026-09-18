/**
 * The companies surface, in memory: the scan, the map, one ledger item with the
 * message its figures came from, and the route that hands an item to a job.
 *
 * These paths are not in openapi.json yet — the service builds them on its own
 * branch — so they are mounted as plain routes rather than through
 * `experienceOperations`, and the shapes here are the agreed ones: snake_case
 * fields, `co_`/`li_` ids, optionals present and null.
 *
 * `MELETE_MOCK_COMPANIES=empty` starts with nothing found, so the empty state
 * and the scan can be walked through in a browser.
 */
import type { Hono } from 'hono';
import type { AppDeps } from './app.ts';
import {
  buildFixture,
  type Fixture,
  type FixtureItem,
  promiseCounts,
  totalsOf,
} from './companies-fixture.ts';
import type { ExperienceMock } from './experience.ts';
import { newId } from './store.ts';

/** How long a scripted scan takes, and what it says it saw while it runs. */
const SCAN_MS = 4200;
const SCAN_MESSAGES = 2481;

type Scan = { id: string; started_at: number };

const fail = (code: string, message: string) => ({ error: { code, message } });

/** The plain words a person would use for the job this item becomes. */
function askFor(item: FixtureItem, companyName: string, money: string): string {
  switch (item.kind) {
    case 'refund_owed':
      return `Chase ${companyName} for the ${money} refund they owe me.`;
    case 'invoice_unpaid':
      return `Chase ${companyName} for the ${money} invoice that is past its date.`;
    case 'wrong_charge':
      return `Ask ${companyName} to take the ${money} charge off my bill.`;
    case 'price_rise':
      return `Push back on the ${companyName} price rise, using what they told me.`;
    case 'trial_ending':
    case 'subscription':
      return `Cancel ${companyName} before the next payment.`;
    case 'renewal':
      return `Ask ${companyName} for a better price before this renews.`;
    case 'deposit':
      return `Ask ${companyName} to return the ${money} deposit they are holding.`;
    case 'compensation':
      return `Claim the ${money} back from ${companyName} for what they lost.`;
    default:
      return `Take this up with ${companyName} and hold them to what they said.`;
  }
}

const money = (minor: number | null, currency: string | null): string => {
  if (minor === null) return 'the';
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${symbol}${(minor / 100).toFixed(2)}`;
};

export function mountCompaniesMock(
  app: Hono,
  deps: AppDeps,
  experience: ExperienceMock,
): { fixture: Fixture } {
  const principalId = newId('own');
  const fixture = buildFixture(deps.spaceId, principalId);
  const startEmpty = process.env.MELETE_MOCK_COMPANIES === 'empty';
  let found = !startEmpty;
  let scan: Scan | null = null;

  const item = (id: string) => fixture.items.find((row) => row.id === id) ?? null;
  const companyOf = (row: FixtureItem) =>
    fixture.companies.find((company) => company.id === row.company_id) ?? null;

  /** The scan's progress, read from the clock rather than kept in a timer. */
  const progress = () => {
    if (!scan) return null;
    const elapsed = Date.now() - scan.started_at;
    const share = Math.min(1, elapsed / SCAN_MS);
    const done = share >= 1;
    if (done) found = true;
    return {
      status: done ? ('done' as const) : ('running' as const),
      messages_seen: Math.round(SCAN_MESSAGES * share),
      items_found: Math.round(fixture.items.length * share),
      error: null,
    };
  };

  app.post('/spaces/:spaceId/companies/scan', (c) => {
    if (c.req.param('spaceId') !== deps.spaceId)
      return c.json(fail('not_found', 'No such space.'), 404);
    // Idempotent while one is running: the same scan comes back rather than a second.
    if (!scan || progress()?.status === 'done') scan = { id: newId('job'), started_at: Date.now() };
    return c.json({ scan_id: scan.id, status: 'running' });
  });

  app.get('/spaces/:spaceId/companies/scan/:scanId', (c) => {
    if (!scan || scan.id !== c.req.param('scanId'))
      return c.json(fail('not_found', 'No such scan.'), 404);
    return c.json(progress());
  });

  app.get('/spaces/:spaceId/companies', (c) => {
    if (c.req.param('spaceId') !== deps.spaceId)
      return c.json(fail('not_found', 'No such space.'), 404);
    if (!found)
      return c.json({
        companies: [],
        items: [],
        totals: {
          owed_to_you_minor: 0,
          monthly_spend_minor: 0,
          renewals_next_30d: 0,
          price_rises: 0,
          trials_ending: 0,
          data_holders: 0,
          promises_in_force: 0,
          promises_lapsed: 0,
        },
        currency: fixture.currency,
      });
    const shown = fixture.items.filter((row) => row.status !== 'dropped');
    return c.json({
      companies: fixture.companies,
      items: shown,
      totals: { ...totalsOf(fixture), ...promiseCounts(fixture.items) },
      currency: fixture.currency,
    });
  });

  app.get('/ledger/:id', (c) => {
    const row = item(c.req.param('id'));
    const company = row ? companyOf(row) : null;
    const message = row ? fixture.messages.get(row.evidence[0]?.message_id ?? '') : undefined;
    if (!row || !company || !message) return c.json(fail('not_found', 'No such item.'), 404);
    return c.json({ item: row, company, message });
  });

  app.patch('/ledger/:id', async (c) => {
    const row = item(c.req.param('id'));
    if (!row) return c.json(fail('not_found', 'No such item.'), 404);
    const body = (await c.req.json().catch(() => null)) as { status?: string } | null;
    if (body?.status !== 'dropped' && body?.status !== 'settled')
      return c.json(fail('invalid_request', 'Say whether it is settled or not this.'), 400);
    row.status = body.status;
    return c.json(row);
  });

  app.post('/ledger/:id/handle', (c) => {
    const row = item(c.req.param('id'));
    const company = row ? companyOf(row) : null;
    if (!row || !company) return c.json(fail('not_found', 'No such item.'), 404);
    if (row.job_id) return c.json({ job_id: row.job_id });
    const agent = [...experience.agents.values()][0];
    if (!agent) return c.json(fail('no_agent', 'Make an assistant first.'), 409);
    const conversation = experience.start(
      company.name,
      agent.id,
      askFor(row, company.name, money(row.amount_minor, row.currency)),
      undefined,
      'company-chase',
    );
    const chat = experience.chats.get(conversation.id);
    if (chat) chat.follow = { from: fixture.from_address };
    row.job_id = conversation.id;
    row.status = 'handling';
    return c.json({ job_id: conversation.id });
  });

  return { fixture };
}
