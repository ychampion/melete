/**
 * "Show me only what needs me", as the service answers it: the setting kept
 * with the space, the file content routes refusing while it is on, and the
 * original read only through its own route, each open noted in the space's
 * activity. `MELETE_MOCK_SUMMARIES_ONLY=on` starts with it on, a few files the
 * agent saved, and the notes those leave, so the screens can be seen without
 * a model.
 */
import * as C from '@melete/contracts';
import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { newId, type Store } from './store.ts';

export const SUMMARIES_REFUSAL =
  'This space shows only what needs you. Open the original if you need it; each open is noted in the space’s activity.';

export type SummariesDeps = {
  store: Store;
  spaceId: string;
  session: string;
  /** Where the space's activity is kept, and who the person is called there. */
  activity: () => C.ActivityEntry[];
  name: () => string;
};

const NOTE_WORDS: Record<NonNullable<C.ActivityEntry['note']>, string> = {
  original_opened: 'Opened the original',
  summaries_on: 'Turned on “Show me only what needs me”',
  summaries_off: 'Turned off “Show me only what needs me”',
};

/** A note in the space's activity: what was opened or changed and by whom, never what it said. */
export function noteActivity(
  deps: Pick<SummariesDeps, 'activity' | 'name'>,
  note: NonNullable<C.ActivityEntry['note']>,
  destination: string | null = null,
  at = new Date(),
): void {
  deps.activity().unshift(
    C.activityEntry.parse({
      id: newId('act'),
      what: NOTE_WORDS[note],
      where: note === 'original_opened' ? 'Files' : 'Space rules',
      destination,
      reference: null,
      outcome: 'succeeded',
      source: deps.name(),
      happened_at: at.toISOString(),
      note,
    }),
  );
}

export function mountSummariesMock(app: Hono, deps: SummariesDeps): void {
  const fail = (code: string, message: string) => ({ error: { code, message } });
  const view = () =>
    C.summariesOnlySetting.parse({
      space_id: deps.spaceId,
      on: deps.store.summariesOnly,
      can_change: true,
      recent: deps
        .activity()
        .filter((entry) => entry.note)
        .slice(0, 20)
        .map((entry) => ({
          note: entry.note,
          by: entry.source,
          what: entry.destination,
          at: entry.happened_at,
        })),
    });

  // The space's rules sit beside the switch in Settings; nothing is restricted here.
  let rules: C.SpacePolicyRules = {
    allowed_models: [],
    denied_connector_kinds: [],
    denied_tool_kinds: [],
  };
  let rulesChanged: string | null = null;
  const policy = () =>
    C.spacePolicyResponse.parse({
      policy: { space_id: deps.spaceId, ...rules, updated_by: null, updated_at: rulesChanged },
      can_change: true,
    });
  app.get('/spaces/:id/policy', (c) => {
    if (getCookie(c, 'melete_mock_session') !== deps.session)
      return c.json(fail('unauthorized', 'A session is required.'), 401);
    if (c.req.param('id') !== deps.spaceId)
      return c.json(fail('scope_denied', 'Space is not accessible.'), 403);
    return c.json(policy());
  });
  app.put('/spaces/:id/policy', async (c) => {
    if (getCookie(c, 'melete_mock_session') !== deps.session)
      return c.json(fail('unauthorized', 'A session is required.'), 401);
    if (c.req.param('id') !== deps.spaceId)
      return c.json(fail('scope_denied', 'Space is not accessible.'), 403);
    const change = C.spacePolicyRules.safeParse(await c.req.json().catch(() => null));
    if (!change.success) return c.json(fail('invalid_request', 'Those rules are not valid.'), 400);
    rules = change.data;
    rulesChanged = new Date().toISOString();
    return c.json(policy());
  });

  app.get('/spaces/:id/summaries-only', (c) => {
    if (getCookie(c, 'melete_mock_session') !== deps.session)
      return c.json(fail('unauthorized', 'A session is required.'), 401);
    if (c.req.param('id') !== deps.spaceId)
      return c.json(fail('scope_denied', 'Space is not accessible.'), 403);
    return c.json(view());
  });

  app.put('/spaces/:id/summaries-only', async (c) => {
    if (getCookie(c, 'melete_mock_session') !== deps.session)
      return c.json(fail('unauthorized', 'A session is required.'), 401);
    if (c.req.param('id') !== deps.spaceId)
      return c.json(fail('scope_denied', 'Space is not accessible.'), 403);
    const change = C.summariesOnlyChange.safeParse(await c.req.json().catch(() => null));
    if (!change.success) return c.json(fail('invalid_request', 'Say whether it is on.'), 400);
    if (change.data.on !== deps.store.summariesOnly)
      noteActivity(deps, change.data.on ? 'summaries_on' : 'summaries_off');
    deps.store.summariesOnly = change.data.on;
    return c.json(view());
  });
}

/** What the content routes answer while the space shows only what needs the person. */
export const summariesRefused = () => ({
  error: { code: C.SUMMARIES_ONLY_CODE, message: SUMMARIES_REFUSAL },
});

/** Files the agent saved while helping with someone else's accounts. */
const SEEDED = [
  {
    name: 'Pharmacy refill notice.txt',
    text: 'Your refill is ready for pickup. Please collect it by November 4.\n',
    hoursAgo: 2,
  },
  {
    name: 'Electric bill, October.txt',
    text: 'Amount due: $86.40. Due date: November 12. Autopay is not set up.\n',
    hoursAgo: 26,
  },
  {
    name: 'Health plan letter.txt',
    text: 'Your plan’s drug list changes on January 1. Two of your medicines move tiers.\n',
    hoursAgo: 75,
  },
];

/** Turns it on with a few saved files and the notes they would leave. */
export function seedSummariesOnly(deps: SummariesDeps): void {
  deps.store.summariesOnly = true;
  const now = Date.now();
  for (const file of SEEDED)
    deps.store.savedFiles.set(newId('act'), {
      name: file.name,
      bytes: new TextEncoder().encode(file.text),
      savedAt: new Date(now - file.hoursAgo * 3_600_000).toISOString(),
    });
  noteActivity(deps, 'summaries_on', null, new Date(now - 80 * 3_600_000));
  noteActivity(deps, 'original_opened', 'A text document', new Date(now - 74 * 3_600_000));
}
