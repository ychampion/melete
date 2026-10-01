import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { PrivacyRouter } from './router.ts';
import { mountPrivacy } from './routes.ts';
import { MemoryPrivacyStore } from './store.ts';

const SPACE = 'sp_01J00000000000000000000000';
const CHAT = 'job_01J00000000000000000000000';
const OWNER = 'own_01J0000000000000000000000O';
const MEMBER = 'own_01J0000000000000000000000M';

/** The privacy routes as a signed-in person in a shared space reaches them. */
async function as(principalId: string, role: 'owner' | 'member') {
  const store = new MemoryPrivacyStore();
  store.scopes.set(CHAT, { spaceId: SPACE, conversationId: CHAT, agentId: null, turnId: 't' });
  // The member's conversation, found to be about therapy.
  store.people.set(CHAT, MEMBER);
  await store.markConversation(CHAT, SPACE, 'therapy');
  const router = new PrivacyRouter({ store });
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: 'internal_error' } }, 500),
  );
  app.use(async (c, next) => {
    c.set('experienceSpaceId', SPACE);
    c.set('sessionSpace', { spaceId: SPACE, kind: 'shared', role } as never);
    c.set('owner', { id: principalId, email: 'person@example.test', created_at: '' });
    await next();
  });
  mountPrivacy(app, { router: () => router });
  const put = (sensitive: string | null) =>
    app.request(`/conversations/${CHAT}/privacy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sensitive }),
    });
  return { store, put };
}

describe("clearing a conversation's sensitivity", () => {
  test("the space's owner cannot say a member's conversation is not sensitive", async () => {
    const { store, put } = await as(OWNER, 'owner');
    const response = await put(null);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'scope_denied' } });
    expect(await store.conversation(CHAT)).toMatchObject({ sensitive: 'therapy', cleared: false });
  });

  test('the person whose conversation it is can', async () => {
    const { store, put } = await as(MEMBER, 'member');
    expect((await put(null)).status).toBe(200);
    expect(await store.conversation(CHAT)).toMatchObject({ sensitive: null, cleared: true });
  });

  test('marking it sensitive stays open to the owner', async () => {
    const { store, put } = await as(OWNER, 'owner');
    expect((await put('health')).status).toBe(200);
    expect((await store.conversation(CHAT)).sensitive).toBe('health');
  });
});
