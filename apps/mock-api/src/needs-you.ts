/**
 * "Needs you" for the demonstration: three sorted items that need the person
 * (a renewal to sign, a lunch to confirm, a meeting that moved), shaped as the
 * service's `GET /needs-you` returns them. Seen and dismissed are kept in
 * memory. With the demonstration's seed off, or `needsYou: false`, the list is
 * empty, which shows the calm line Home draws for it.
 */
import type { AttachmentView, NeedsYouItem, NeedsYouList } from '@melete/contracts';
import type { Hono } from 'hono';

const HOUR = 3_600_000;

function seededItems(now: number): NeedsYouItem[] {
  const at = (offset: number) => new Date(now + offset).toISOString();
  return [
    {
      id: 'tri_01JA0000000000000000000001',
      source: 'triage',
      sentence: 'Dana is waiting on your signature for the renewal.',
      reason: 'She asked for it by Friday.',
      because: {
        kind: 'mail',
        label: 'Email from Dana Kim',
        handle: 'event:101',
        subject: 'Can you sign the renewal by Friday?',
        at: at(-2 * HOUR),
      },
      urgency: 'soon',
      seen: false,
      created_at: at(-2 * HOUR),
      chat_prompt: 'Help me with this item from my Home list (source event:101).',
    },
    {
      id: 'tri_01JA0000000000000000000002',
      source: 'triage',
      sentence: 'Your board review moved an hour later tomorrow.',
      reason: 'The start time changed.',
      because: {
        kind: 'calendar',
        label: 'Changed meeting',
        handle: 'event:102',
        subject: 'Board review',
        at: at(26 * HOUR),
      },
      urgency: 'normal',
      seen: false,
      created_at: at(-1 * HOUR),
      chat_prompt: 'Help me with this item from my Home list (source event:102).',
    },
    {
      id: 'tri_01JA0000000000000000000003',
      source: 'triage',
      sentence: 'Sam wants you to confirm a time for lunch tomorrow.',
      reason: 'A friend is waiting on your answer.',
      because: {
        kind: 'mail',
        label: 'Email from Sam Ortiz',
        handle: 'event:103',
        subject: 'Lunch tomorrow - please confirm the time',
        at: at(-3 * HOUR),
      },
      urgency: 'normal',
      seen: true,
      created_at: at(-3 * HOUR),
      chat_prompt: 'Help me with this item from my Home list (source event:103).',
    },
  ];
}

export function mountNeedsYouMock(
  app: Hono,
  options: {
    seeded: boolean;
    /** Keeps a text file as an attachment the next message can carry. */
    attach: (name: string, text: string) => AttachmentView;
  },
) {
  let items = options.seeded ? seededItems(Date.now()) : [];
  const lane = { urgent: 0, soon: 1, normal: 2 } as const;
  const list = (): NeedsYouList => ({
    items: [...items].sort(
      (a, b) =>
        lane[a.urgency] - lane[b.urgency] ||
        Number(a.seen) - Number(b.seen) ||
        b.created_at.localeCompare(a.created_at),
    ),
    unsorted: 0,
    unsorted_reason: null,
  });
  const find = (id: string) => items.find((item) => item.id === id);
  const missing = { error: { code: 'not_found', message: 'No such item.' } };

  app.get('/needs-you', (c) => c.json(list()));
  // The source as a text file for "Handle it" to send with its message.
  app.post('/needs-you/:id/source', (c) => {
    const item = find(c.req.param('id'));
    if (item?.source !== 'triage') return c.json(missing, 404);
    const text = [
      `Source: ${item.because.handle}`,
      item.because.kind === 'mail' ? 'An email, headers only.' : 'A calendar change.',
      `${item.because.label}`,
      item.because.subject ? `Subject: ${item.because.subject}` : '',
      '',
    ].join('\n');
    const name = item.because.kind === 'mail' ? 'email-source.txt' : 'calendar-source.txt';
    return c.json({ attachment: options.attach(name, text) }, 201);
  });
  app.post('/needs-you/:id/ack', (c) => {
    const item = find(c.req.param('id'));
    if (!item) return c.json(missing, 404);
    item.seen = true;
    return c.json({ item });
  });
  app.post('/needs-you/:id/dismiss', (c) => {
    const item = find(c.req.param('id'));
    if (!item) return c.json(missing, 404);
    items = items.filter((entry) => entry.id !== item.id);
    return c.json({ item: { ...item, seen: true } });
  });
}
