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

/** A message the person sent that nobody has answered, as `GET /waiting-on` lists it. */
type AwaitedReply = {
  id: string;
  to: string;
  to_name: string;
  subject: string;
  quote: string;
  days_ago: number;
  status: 'found' | 'handling' | 'waiting' | 'settled' | 'dropped';
  job_id: string | null;
};

/** The replies the demonstration person is waiting on. Invented, under `.example`. */
const awaitedReplies = (): AwaitedReply[] => [
  {
    id: newId('awr'),
    to: 'rowan@ellisbuilders.example',
    to_name: 'Rowan Ellis',
    subject: 'Kitchen extension quote',
    quote: 'Could you send the quote and a week you could start?',
    days_ago: 9,
    status: 'found',
    job_id: null,
  },
  {
    id: newId('awr'),
    to: 'priya@shahdesign.example',
    to_name: 'Priya Shah',
    subject: 'Logo files',
    quote: 'Can you send the final logo files this week?',
    days_ago: 4,
    status: 'found',
    job_id: null,
  },
  {
    id: newId('awr'),
    to: 'lettings@northgatehomes.example',
    to_name: 'Northgate Homes',
    subject: 'Moving out on 30 September',
    quote: 'Please confirm the date of the check-out inspection.',
    days_ago: 6,
    status: 'found',
    job_id: null,
  },
];

const OPEN = new Set(['found', 'handling', 'waiting']);

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
  // The mailbox a company chase leaves from is the one the profile names.
  experience.sendingAddress = fixture.from_address;
  const startEmpty = process.env.MELETE_MOCK_COMPANIES === 'empty';
  let found = !startEmpty;
  let scan: Scan | null = null;

  const item = (id: string) => fixture.items.find((row) => row.id === id) ?? null;
  const companyOf = (row: FixtureItem) =>
    fixture.companies.find((company) => company.id === row.company_id) ?? null;

  /**
   * A space the caller cannot see is refused, not reported missing. The real
   * service guards `/spaces/:spaceId/*` before any route underneath it runs, so
   * a caller outside the space learns only that it is not theirs — never
   * whether it, or anything in it, exists. Returns the refusal, or null to go on.
   *
   * `/ledger/:id` is not scoped this way: a foreign or unknown item id is a 404
   * there, because the id alone says nothing about which space it belongs to.
   */
  const outsideSpace = (spaceId: string): Response | null =>
    spaceId === deps.spaceId
      ? null
      : Response.json(fail('scope_denied', 'This space is not yours to read.'), { status: 403 });

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
    const denied = outsideSpace(c.req.param('spaceId'));
    if (denied) return denied;
    // Idempotent while one is running: the same scan comes back rather than a second.
    if (!scan || progress()?.status === 'done') scan = { id: newId('job'), started_at: Date.now() };
    return c.json({ scan_id: scan.id, status: 'running' });
  });

  app.get('/spaces/:spaceId/companies/scan/:scanId', (c) => {
    // The space guard runs first, so a foreign space never learns whether a
    // scan id exists inside it.
    const denied = outsideSpace(c.req.param('spaceId'));
    if (denied) return denied;
    if (!scan || scan.id !== c.req.param('scanId'))
      return c.json(fail('not_found', 'No such scan.'), 404);
    return c.json(progress());
  });

  app.get('/spaces/:spaceId/companies', (c) => {
    const denied = outsideSpace(c.req.param('spaceId'));
    if (denied) return denied;
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
    // Idempotent: an item that already names a job hands that job back and the
    // playbook is not run a second time. The first call made something, so it
    // answers 201; a repeat made nothing, so it answers 200.
    if (row.job_id) return c.json({ job_id: row.job_id }, 200);
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
    if (chat)
      chat.follow = {
        from: fixture.from_address,
        // The chase ends when the money is back: the item it was about is settled.
        settle: () => {
          row.status = 'settled';
        },
      };
    row.job_id = conversation.id;
    row.status = 'handling';
    return c.json({ job_id: conversation.id }, 201);
  });

  const replies = awaitedReplies();

  // What the person is waiting on, built the way the service builds it: the
  // map's owed figure, its open owed items, the open replies, and a top three
  // that takes turns between money and replies among those nothing chases yet.
  app.get('/waiting-on', (c) => {
    const state = progress();
    const scanStatus = found ? 'done' : state ? state.status : 'none';
    const owed = found
      ? fixture.items
          .filter((row) => row.direction === 'owed_to_you' && OPEN.has(row.status))
          .map((row) => ({
            kind: 'owed' as const,
            id: row.id,
            who: companyOf(row)?.name ?? 'A company',
            what: row.summary,
            amount_minor: row.amount_minor,
            currency: row.currency,
            due_at: row.due_at,
            sent_at: null,
            status: row.status,
            job_id: row.job_id,
          }))
          .sort((a, b) => (b.amount_minor ?? -1) - (a.amount_minor ?? -1))
      : [];
    const waiting = found
      ? replies
          .filter((reply) => OPEN.has(reply.status))
          .map((reply) => ({
            kind: 'reply' as const,
            id: reply.id,
            who: reply.to_name,
            what: reply.quote,
            amount_minor: null,
            currency: null,
            due_at: null,
            sent_at: new Date(Date.now() - reply.days_ago * 86_400_000).toISOString(),
            status: reply.status,
            job_id: reply.job_id,
          }))
          .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
      : [];
    const open = <T extends { status: string; job_id: string | null }>(entry: T) =>
      entry.status === 'found' && entry.job_id === null;
    const money = owed.filter(open);
    const words = waiting.filter(open);
    const top: ((typeof owed)[number] | (typeof waiting)[number])[] = [];
    for (let index = 0; top.length < 3 && (money[index] || words[index]); index++)
      for (const entry of [money[index], words[index]])
        if (entry && top.length < 3) top.push(entry);
    return c.json({
      currency: fixture.currency,
      owed_minor: found ? totalsOf(fixture).owed_to_you_minor : 0,
      owed,
      replies: waiting,
      top,
      scan: {
        space_id: deps.spaceId,
        connected: true,
        status: scanStatus,
        finished_at: found ? new Date().toISOString() : null,
        stale: false,
      },
    });
  });

  app.post('/waiting-on/replies/:id/chase', (c) => {
    const reply = replies.find((entry) => entry.id === c.req.param('id'));
    if (!reply || !found) return c.json(fail('not_found', 'Not found.'), 404);
    // Idempotent, like Handle it: a reply already being chased hands its chase back.
    if (reply.job_id) return c.json({ job_id: reply.job_id }, 200);
    if (reply.status === 'settled' || reply.status === 'dropped')
      return c.json(fail('already_terminal', 'This one is already finished.'), 409);
    const agent = [...experience.agents.values()][0];
    if (!agent) return c.json(fail('no_agent', 'Make an assistant first.'), 409);
    const conversation = experience.start(
      reply.to_name,
      agent.id,
      `I'm waiting on a reply from ${reply.to_name} about "${reply.subject}". Chase it.`,
      undefined,
      'reply-chase',
    );
    reply.job_id = conversation.id;
    reply.status = 'handling';
    return c.json({ job_id: conversation.id }, 201);
  });

  // Dismissed: it leaves the list. The demonstration has no chase to stop.
  app.post('/waiting-on/replies/:id/drop', (c) => {
    const reply = replies.find((entry) => entry.id === c.req.param('id'));
    if (!reply || !found) return c.json(fail('not_found', 'Not found.'), 404);
    reply.status = 'dropped';
    return c.json({
      id: reply.id,
      space_id: deps.spaceId,
      principal_id: principalId,
      message_id: `<${reply.id}@mock.example>`,
      to: reply.to,
      to_name: reply.to_name,
      subject: reply.subject,
      sent_at: new Date(Date.now() - reply.days_ago * 86_400_000).toISOString(),
      evidence: {
        message_id: `<${reply.id}@mock.example>`,
        quote: reply.quote,
        start: 0,
        end: reply.quote.length,
      },
      status: reply.status,
      job_id: reply.job_id,
    });
  });

  app.post('/ledger/:id/stop', (c) => {
    const row = item(c.req.param('id'));
    if (!row) return c.json(fail('not_found', 'No such item.'), 404);
    if (row.status === 'settled' || row.status === 'dropped')
      return c.json(fail('not_handling', 'This item is already closed.'), 409);
    // The chase stops where the service would cancel its job; the item is open again.
    const chat = row.job_id ? experience.chats.get(row.job_id) : undefined;
    if (chat && !chat.stopped) {
      chat.stopped = true;
      experience.state(chat, 'stopped');
    }
    row.job_id = null;
    row.status = 'found';
    return c.json(row);
  });

  return { fixture };
}
