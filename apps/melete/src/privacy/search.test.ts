import { expect, test } from 'bun:test';
import {
  PrivacyRouter,
  SEARCH_KEPT_DETAILS,
  SEARCH_KEPT_PRIVATE,
  SEARCH_KEPT_TOPIC,
} from './router.ts';
import { MemoryPrivacyStore } from './store.ts';
import { Vault } from './vault.ts';

function router() {
  const store = new MemoryPrivacyStore();
  store.scopes.set('job_1', {
    spaceId: 'spc_1',
    conversationId: 'job_1',
    agentId: 'agt_1',
    turnId: null,
  });
  return { store, router: new PrivacyRouter({ store, cacheMs: 0 }) };
}

test('an ordinary conversation may search the web', async () => {
  const { router: privacy } = router();
  expect(await privacy.outsideSearchRefusal('job_1', 'weather in Lisbon tomorrow')).toBeNull();
});

test('a private space or agent, or a sensitive conversation, never searches outside', async () => {
  const space = router();
  await space.store.saveSettings('spc_1', { private_space: true }, null);
  expect(await space.router.outsideSearchRefusal('job_1', 'weather')).toBe(SEARCH_KEPT_PRIVATE);

  const agent = router();
  await agent.store.saveSettings('spc_1', { private_agent_ids: ['agt_1'] }, null);
  expect(await agent.router.outsideSearchRefusal('job_1', 'weather')).toBe(SEARCH_KEPT_PRIVATE);

  const sensitive = router();
  await sensitive.store.updateConversation('job_1', 'spc_1', { sensitive: 'health' });
  expect(await sensitive.router.outsideSearchRefusal('job_1', 'weather')).toBe(SEARCH_KEPT_PRIVATE);

  const unknown = router();
  expect(await unknown.router.outsideSearchRefusal('job_unknown', 'weather')).toBe(
    SEARCH_KEPT_PRIVATE,
  );
});

test('a query about a sensitive topic, or carrying a detected detail, stays in', async () => {
  const { router: privacy } = router();
  expect(await privacy.outsideSearchRefusal('job_1', 'my doctor wants another blood test')).toBe(
    SEARCH_KEPT_TOPIC,
  );
  expect(await privacy.outsideSearchRefusal('job_1', 'who owns sam.rivera@example.com')).toBe(
    SEARCH_KEPT_DETAILS,
  );
});

test('a conversation the person cleared is not read for a topic, but details still stay in', async () => {
  const { store, router: privacy } = router();
  await store.markConversation('job_1', 'spc_1', null);
  expect(
    await privacy.outsideSearchRefusal('job_1', 'my doctor wants another blood test'),
  ).toBeNull();
  expect(await privacy.outsideSearchRefusal('job_1', 'who owns sam.rivera@example.com')).toBe(
    SEARCH_KEPT_DETAILS,
  );
});

test('what memory learned in a private conversation never goes to an outside search', async () => {
  const { store, router: privacy } = router();
  store.memory.set('spc_1', ['Project Nightjar acquisition of Halvorsen Labs']);
  expect(
    await privacy.outsideSearchRefusal(
      'job_1',
      'Project Nightjar acquisition of Halvorsen Labs treatment options',
    ),
  ).toBe(SEARCH_KEPT_DETAILS);
  expect(await privacy.outsideSearchRefusal('job_1', 'Halvorsen Labs careers')).toBeNull();
});

test('a detail the conversation already swapped for a placeholder stays in, however it is written', async () => {
  const { store, router: privacy } = router();
  // A name the local detector found earlier in this conversation.
  const vault = new Vault();
  vault.assign('name', 'Marisol Quenby');
  await store.saveVault('job_1', 'spc_1', vault);
  expect(await privacy.outsideSearchRefusal('job_1', 'Marisol Quenby linkedin')).toBe(
    SEARCH_KEPT_DETAILS,
  );
  expect(await privacy.outsideSearchRefusal('job_1', 'marisol quenby linkedin')).toBe(
    SEARCH_KEPT_DETAILS,
  );
  // A placeholder the model wrote that was never resolved is refused too.
  expect(await privacy.outsideSearchRefusal('job_1', '⟦NAME_9⟧ linkedin')).toBe(
    SEARCH_KEPT_DETAILS,
  );
});

test('a listed value is caught in another spelling, with its category turned off', async () => {
  const { store, router: privacy } = router();
  await store.saveSettings(
    'spc_1',
    { enabled: [] },
    { known: [{ id: 'k1', label: 'My phone', category: 'phone', value: '+1 415-555-0134' }] },
  );
  for (const query of [
    'who called +1 415-555-0134',
    'who called 14155550134',
    'who called 1 (415) 555 0134',
  ])
    expect(await privacy.outsideSearchRefusal('job_1', query)).toBe(SEARCH_KEPT_DETAILS);
  expect(await privacy.outsideSearchRefusal('job_1', 'area code 415 weather')).toBeNull();
});
