/**
 * "What I'm on" for the demonstration: two things the person asked Melete to
 * see through, shaped as the service's `GET /intents` returns them. One has a
 * time Melete chose and a budget nobody named, both marked as its guess; the
 * other is near its deadline. Corrections and cancelling are kept in memory,
 * and a corrected detail becomes the person's, as it does in the service.
 */
import {
  type IntentCancelResponse,
  type IntentView,
  intentEdit,
  type ReadBackPart,
} from '@melete/contracts';
import type { Hono } from 'hono';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const dayWords = (at: Date) =>
  `${at.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${at.getUTCDate()} ${at.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
const timeWords = (at: Date) =>
  at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** The read-back parts from the details, the way the service words them. */
function partsOf(item: IntentView): ReadBackPart[] {
  const c = item.constraints;
  const parts: ReadBackPart[] = [];
  const add = (path: string, text: string) =>
    parts.push({ path, text, origin: item.origins[path] ?? 'inferred' });
  if (c.place?.name) add('place.name', c.place.name);
  if (c.party?.size) add('party.size', `for ${c.party.size}`);
  for (const [index, name] of (c.counterparties ?? []).entries())
    add(`counterparties[${index}]`, `with ${name}`);
  if (c.window?.from) {
    const at = new Date(c.window.from);
    add('window.from', `${dayWords(at)}, ${timeWords(at)}`);
  }
  if (item.deadline_at) add('deadline_at', `by ${dayWords(new Date(item.deadline_at))}`);
  if (c.budget?.max !== undefined) add('budget.max', `up to $${c.budget.max}`);
  return parts;
}

function withLine(item: IntentView): IntentView {
  const parts = partsOf(item);
  const details = parts
    .map((part) => (part.origin === 'inferred' ? `${part.text} (my guess)` : part.text))
    .join(', ');
  const title = item.title.replace(/[.\s]+$/, '');
  return {
    ...item,
    read_back: { line: details ? `On it: ${title}. ${details}.` : `On it: ${title}.`, parts },
  };
}

function seeded(now: number): IntentView[] {
  const at = (offset: number) => new Date(now + offset).toISOString();
  const dinnerDay = new Date(now + 4 * DAY);
  dinnerDay.setUTCHours(19, 0, 0, 0);
  const deadline = new Date(dinnerDay);
  deadline.setUTCHours(17, 0, 0, 0);
  const base = {
    source: 'chat' as const,
    conversation_id: null,
    version: 1,
    closed_reason: null,
    read_back: { line: '', parts: [] },
  };
  return [
    withLine({
      ...base,
      id: 'int_01JA0000000000000000000001',
      kind: 'booking',
      words: `Family birthday, book a suitable Haidilao on the ${dinnerDay.getUTCDate()}th for 6 of us`,
      title: 'Book a table for the family birthday',
      constraints: {
        place: { name: 'Haidilao' },
        party: { size: 6 },
        window: { from: dinnerDay.toISOString() },
        budget: { max: 300, currency: 'USD' },
      },
      origins: {
        'place.name': 'person',
        'party.size': 'person',
        'window.from': 'inferred',
        deadline_at: 'person',
        'budget.max': 'inferred',
        'budget.currency': 'inferred',
      },
      state: 'active',
      next_step: 'Checking which evenings they have a table for six',
      deadline_at: deadline.toISOString(),
      deadline_origin: 'person',
      run_id: 'job_01JA0000000000000000000101',
      created_at: at(-2 * HOUR),
      updated_at: at(-HOUR),
    }),
    withLine({
      ...base,
      id: 'int_01JA0000000000000000000002',
      kind: 'reply',
      words: 'Get the signed renewal back from Dana before Friday',
      title: 'Get the signed renewal back from Dana',
      constraints: { counterparties: ['Dana Kim'] },
      origins: { 'counterparties[0]': 'person', deadline_at: 'inferred' },
      state: 'at_risk',
      next_step: 'Running out of time',
      deadline_at: at(90 * 60_000),
      deadline_origin: 'inferred',
      run_id: 'job_01JA0000000000000000000102',
      created_at: at(-DAY),
      updated_at: at(-10 * 60_000),
    }),
  ];
}

export function mountIntentsMock(app: Hono, options: { seeded: boolean }) {
  let items = options.seeded ? seeded(Date.now()) : [];
  const missing = { error: { code: 'not_found', message: 'That was not found.' } };
  app.get('/intents', (c) => c.json({ intents: items }));
  app.patch('/intents/:id', async (c) => {
    const item = items.find((entry) => entry.id === c.req.param('id'));
    if (!item) return c.json(missing, 404);
    const parsed = intentEdit.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json(
        { error: { code: 'invalid_request', message: 'Change at least one detail.' } },
        400,
      );
    if (parsed.data.version !== item.version)
      return c.json(
        { error: { code: 'revision_mismatch', message: 'This changed since you opened it.' } },
        409,
      );
    const next: IntentView = structuredClone(item);
    for (const [path, value] of Object.entries(parsed.data.values)) {
      if (path === 'deadline_at') next.deadline_at = value === null ? null : String(value);
      else if (path === 'title' && typeof value === 'string') next.title = value;
      else {
        const [group, key] = path.split('.') as [string, string];
        const holder = next.constraints as Record<string, Record<string, unknown> | undefined>;
        holder[group] = { ...(holder[group] ?? {}), [key]: value };
      }
      if (value === null) delete next.origins[path];
      else next.origins[path] = 'person';
    }
    next.version += 1;
    next.updated_at = new Date().toISOString();
    if (next.deadline_at) next.deadline_origin = next.origins.deadline_at ?? 'inferred';
    const shown = withLine(next);
    items = items.map((entry) => (entry.id === item.id ? shown : entry));
    return c.json({ intent: shown });
  });
  app.post('/intents/:id/cancel', (c) => {
    const item = items.find((entry) => entry.id === c.req.param('id'));
    if (!item) return c.json(missing, 404);
    const ended: IntentView = {
      ...item,
      state: 'cancelled',
      next_step: null,
      closed_reason: 'You cancelled it.',
      updated_at: new Date().toISOString(),
    };
    items = items.map((entry) => (entry.id === item.id ? ended : entry));
    const body: IntentCancelResponse = { intent: ended, effects: [] };
    return c.json(body);
  });
}
