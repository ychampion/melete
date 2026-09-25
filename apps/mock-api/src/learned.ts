/**
 * What Melete learned, served the way the service serves it: lessons from the
 * person's corrections and skills the engine wrote for itself, one list, each
 * item carrying only the actions its state allows. The latest change can be
 * undone by the id the person was shown, so a newer change is never undone by
 * mistake. `MELETE_MOCK_LEARNED=empty` starts with nothing learned.
 */
import { createHash } from 'node:crypto';
import {
  engineSkillApprovalRequest,
  engineSkillEditRequest,
  engineSkillListResponse,
  type engineSkillRecord,
  engineSkillResponse,
  type LearnedAction,
  type LearnedChange,
  type LearnedItem,
  type LearnedState,
  learnedItemResponse,
  learnedList,
  learnedTryRequest,
  learnedUndoRequest,
  learningSpaceRequest,
  procedureReasonRequest,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppDeps } from './app.ts';
import { newId } from './store.ts';

/** The actions each state allows, as the service assigns them per source. */
const ACTIONS: Record<LearnedItem['source'], Record<LearnedState, LearnedAction[]>> = {
  correction: {
    proposed: ['try', 'remove'],
    trial: ['pause', 'remove'],
    active: ['pause', 'remove'],
    paused: ['resume', 'remove'],
    reverted: ['remove'],
  },
  engine: {
    proposed: ['approve', 'edit', 'remove', 'stop'],
    trial: ['pause', 'edit', 'remove', 'stop'],
    active: ['pause', 'edit', 'remove', 'stop'],
    paused: ['resume', 'edit', 'remove', 'stop'],
    reverted: ['remove'],
  },
};

type EngineSkillRecord = z.infer<typeof engineSkillRecord>;

const DAY = 86_400_000;
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

type Entry = { item: LearnedItem; body: string };
type Change = { change: LearnedChange; before: LearnedItem };

const fail = (code: string, message: string) => ({ error: { code, message } });

export function mountLearnedMock(app: Hono, deps: AppDeps): void {
  const now = () => deps.store.now();
  const entries = new Map<string, Entry>();
  let last: Change | null = null;
  // Removed items keep their body here so undo can bring them back whole.
  const removedBodies = new Map<string, string>();

  const add = (
    source: LearnedItem['source'],
    name: string,
    does: string[],
    state: LearnedState,
    extra: Partial<LearnedItem> = {},
  ) => {
    const id = newId('pc');
    const body = does.join('\n');
    const item: LearnedItem = {
      id,
      source,
      name,
      does,
      applies_when: [],
      space_id: deps.spaceId,
      shared: false,
      state,
      reason: null,
      reason_code: null,
      definition_hash: hashOf(body),
      learned_at: new Date(now().getTime() - 3 * DAY).toISOString(),
      expires_at: null,
      expiring_soon: false,
      actions: ACTIONS[source][state],
      ...extra,
    };
    entries.set(id, { item, body });
  };

  if (process.env.MELETE_MOCK_LEARNED !== 'empty') {
    add(
      'correction',
      'Chasing a company',
      [
        'Quote back the date they gave you, in their own words',
        'Keep it to five lines and ask one question',
        'Sign off with your name, never “Kind regards”',
      ],
      'active',
      { applies_when: ['chase', 'follow up with'] },
    );
    add(
      'correction',
      'Replies to the landlord',
      ['Email, never call', 'Open with the reference number'],
      'proposed',
      {
        applies_when: ['landlord'],
        expires_at: new Date(now().getTime() + 5 * DAY).toISOString(),
        expiring_soon: true,
      },
    );
    add(
      'engine',
      'refund-follow-up',
      ['Follow up on a refund five working days after the date the company gave'],
      'proposed',
    );
    add(
      'correction',
      'Morning brief',
      ['Lead with what needs a decision', 'Then the day’s calendar, then the weather'],
      'paused',
      { applies_when: ['brief'] },
    );
  }

  const setState = (entry: Entry, state: LearnedState, reason: string | null = null) => {
    entry.item = {
      ...entry.item,
      state,
      reason,
      reason_code: reason ? 'owner_stopped' : null,
      actions: ACTIONS[entry.item.source][state],
    };
  };

  const record = (
    entry: Entry,
    before: LearnedItem,
    action: LearnedChange['action'],
  ): LearnedChange => {
    const change: LearnedChange = {
      id: newId('chg'),
      item_id: entry.item.id,
      source: entry.item.source,
      action,
      name: entry.item.name,
      created_at: now().toISOString(),
    };
    last = { change, before };
    return change;
  };

  /** Read and check a body; a foreign space is refused the way the service refuses it. */
  const read = async <T extends { space_id: string }>(
    c: Context,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  ): Promise<{ ok: true; value: T } | { ok: false; response: Response }> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !parsed.data)
      return {
        ok: false,
        response: c.json(fail('invalid_request', 'That request is not one this accepts.'), 400),
      };
    if (parsed.data.space_id !== deps.spaceId)
      return {
        ok: false,
        response: c.json(fail('scope_denied', 'This space is not yours to change.'), 403),
      };
    return { ok: true, value: parsed.data };
  };

  const find = (c: Context, action: LearnedAction) => {
    const entry = entries.get(c.req.param('id') ?? '');
    if (!entry)
      return { entry: null, response: c.json(fail('not_found', 'Nothing by that id.'), 404) };
    if (!entry.item.actions.includes(action))
      return {
        entry: null,
        response: c.json(
          fail('conflict', `This can’t be done while it is ${entry.item.state}.`),
          409,
        ),
      };
    return { entry, response: null };
  };

  const skillOf = (entry: Entry): EngineSkillRecord => ({
    id: entry.item.id,
    name: entry.item.name,
    description: entry.item.does[0] ?? '',
    body: entry.body,
    definition_hash: entry.item.definition_hash,
    state:
      entry.item.state === 'proposed'
        ? 'held'
        : entry.item.state === 'paused'
          ? 'paused'
          : entry.item.state === 'reverted'
            ? 'reverted'
            : 'live',
    reason: entry.item.reason,
    source_job_id: null,
    created_at: entry.item.learned_at,
  });

  app.get('/learned', (c) => {
    if (c.req.query('space_id') !== deps.spaceId)
      return c.json(fail('scope_denied', 'This space is not yours to read.'), 403);
    return c.json(
      learnedList.parse({
        items: [...entries.values()].map((entry) => entry.item),
        last_change: last?.change ?? null,
      }),
    );
  });

  // Undo names the change the person saw; only the latest can be undone.
  app.post('/learned/undo', async (c) => {
    const body = await read(c, learnedUndoRequest);
    if (!body.ok) return body.response;
    if (!last || last.change.id !== body.value.change_id)
      return c.json(fail('conflict', 'Only your latest change can be undone.'), 409);
    const restored = last.before;
    const kept =
      entries.get(restored.id)?.body ?? removedBodies.get(restored.id) ?? restored.does.join('\n');
    removedBodies.delete(restored.id);
    entries.set(restored.id, { item: restored, body: kept });
    last = null;
    return c.json(learnedItemResponse.parse({ item: restored, change: null }));
  });

  for (const action of ['pause', 'resume', 'remove', 'share'] as const) {
    app.post(`/learned/:id/${action}`, async (c) => {
      const body = await read(c, learningSpaceRequest);
      if (!body.ok) return body.response;
      const { entry, response } = find(c, action);
      if (!entry) return response;
      const before = entry.item;
      if (action === 'pause') setState(entry, 'paused');
      else if (action === 'resume') setState(entry, 'active');
      else if (action === 'share') entry.item = { ...entry.item, shared: true };
      const change =
        action === 'share' ? null : record(entry, before, action === 'remove' ? 'remove' : action);
      if (action === 'remove') {
        removedBodies.set(entry.item.id, entry.body);
        entries.delete(entry.item.id);
        return c.json(learnedItemResponse.parse({ item: null, change }));
      }
      return c.json(learnedItemResponse.parse({ item: entry.item, change }));
    });
  }

  app.post('/learned/:id/try', async (c) => {
    const body = await read(c, learnedTryRequest);
    if (!body.ok) return body.response;
    const { entry, response } = find(c, 'try');
    if (!entry) return response;
    if (body.value.definition_hash !== entry.item.definition_hash)
      return c.json(fail('definition_changed', 'This changed while you were reading it.'), 409);
    setState(entry, 'trial');
    entry.item = { ...entry.item, expires_at: null, expiring_soon: false };
    return c.json(learnedItemResponse.parse({ item: entry.item, change: null }));
  });

  app.get('/engine-skills', (c) => {
    if (c.req.query('space_id') !== deps.spaceId)
      return c.json(fail('scope_denied', 'This space is not yours to read.'), 403);
    return c.json(
      engineSkillListResponse.parse({
        skills: [...entries.values()].filter((e) => e.item.source === 'engine').map(skillOf),
      }),
    );
  });

  const engine = (c: Context, action: LearnedAction) => {
    const found = find(c, action);
    if (found.entry && found.entry.item.source !== 'engine')
      return {
        entry: null,
        response: c.json(fail('not_found', 'No engine skill by that id.'), 404),
      };
    return found;
  };

  app.post('/engine-skills/:id/approve', async (c) => {
    const body = await read(c, engineSkillApprovalRequest);
    if (!body.ok) return body.response;
    const { entry, response } = engine(c, 'approve');
    if (!entry) return response;
    if (body.value.definition_hash !== entry.item.definition_hash)
      return c.json(fail('definition_changed', 'This changed while you were reading it.'), 409);
    setState(entry, 'active');
    return c.json(engineSkillResponse.parse({ skill: skillOf(entry) }));
  });

  app.post('/engine-skills/:id/edit', async (c) => {
    const body = await read(c, engineSkillEditRequest);
    if (!body.ok) return body.response;
    const { entry, response } = engine(c, 'edit');
    if (!entry) return response;
    if (body.value.definition_hash !== entry.item.definition_hash)
      return c.json(fail('definition_changed', 'This changed while you were reading it.'), 409);
    // The person's own text replaces the engine's, and what they wrote is in use.
    entry.body = body.value.body;
    const does = body.value.body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    entry.item = { ...entry.item, does, definition_hash: hashOf(body.value.body) };
    setState(entry, 'active');
    return c.json(engineSkillResponse.parse({ skill: skillOf(entry) }));
  });

  app.post('/engine-skills/:id/stop', async (c) => {
    const body = await read(c, procedureReasonRequest);
    if (!body.ok) return body.response;
    const { entry, response } = engine(c, 'stop');
    if (!entry) return response;
    setState(entry, 'reverted', 'You said not to do this.');
    return c.json(engineSkillResponse.parse({ skill: skillOf(entry) }));
  });
}
