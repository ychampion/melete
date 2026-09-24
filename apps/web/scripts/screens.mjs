/**
 * Walk every designed surface at three widths in both themes, check for
 * horizontal overflow and console errors, and write the screenshots that
 * apps/web/docs/screens carries.
 *
 * Needs the mock on :3210 and the dev server on :5180:
 *   MOCK_PORT=3210 bun run dev:mock   (in one shell)
 *   bun run dev:web                   (in another)
 *   bun run --cwd apps/web screens
 * Pass --signout-only to recheck just sign-out against an existing screen report.
 *
 * The chat states are real: the script starts the dinner conversation through
 * the experience contract, waits for the agent to reach each state, decides
 * the permission, and sends the draft.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:5180';
const API = process.env.MOCK_URL ?? 'http://localhost:3210';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screens');
mkdirSync(OUT, { recursive: true });

const WIDTHS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];
const THEMES = ['light', 'dark'];
/** Only these get a committed PNG; every width and theme is still checked. */
const COMMIT = new Set(['1440-light', '390-light', '1440-dark']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (method, path, body, headers = {}) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};

const waitFor = async (check, timeoutMs = 40_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await sleep(400);
  }
  throw new Error('timed out waiting for the mock');
};

const events = async (id) => (await api('GET', `/conversations/${id}/events?since=0`)).events ?? [];
const find = (list, type) => list.find((e) => e.item.type === type)?.item;

const results = [];
const captions = [];
let failures = 0;

const browser = await chromium.launch();

/**
 * Render one surface at every width and theme. `prepare` runs once per
 * viewport after navigation and can click through the interface.
 */
async function surface(
  name,
  caption,
  route,
  { prepare, verify, expectedProfile401 = false, settle = 1200, only } = {},
) {
  captions.push(`- \`${name}\` — ${caption}`);
  for (const size of only ?? WIDTHS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        colorScheme: theme,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors = [];
      const expectedErrors = [];
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        // Strict Mode can request the profile twice after reload. Both 401s
        // are expected only in the check that deliberately revoked the session.
        if (
          expectedProfile401 &&
          message.location().url === `${API}/profile` &&
          message.text().includes('401 (Unauthorized)')
        )
          expectedErrors.push(message.text());
        else errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(`${WEB}/#${route}`, { waitUntil: 'load' });
      await page.waitForTimeout(settle);
      if (prepare) await prepare(page, size);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      const key = `${size.name}-${theme}`;
      const file = `${name}-${key}.png`;
      if (COMMIT.has(key)) await page.screenshot({ path: join(OUT, file) });
      if (verify) await verify(page, errors);
      const ok = !overflow && errors.length === 0;
      if (!ok) failures += 1;
      results.push({ name, key, overflow, errors, file: COMMIT.has(key) ? file : null });
      process.stdout.write(
        `${ok ? 'ok  ' : 'FAIL'} ${name} ${key}${overflow ? ' overflow' : ''}${errors.length ? ` ${errors[0]}` : ''}${expectedErrors.length ? ` (${expectedErrors.length} expected profile 401s)` : ''}\n`,
      );
      await context.close();
    }
  }
}

// Recheck an affected sign-out case without replaying the whole screen walk.
if (process.argv.includes('--signout-only')) {
  await signOutSurface();
  await browser.close();
  const report = readFileSync(join(OUT, 'README.md'), 'utf8').split('\n');
  for (const result of results) {
    const index = report.findIndex((line) => line.startsWith(`| ${result.name} | ${result.key} |`));
    if (index < 0) throw new Error('Run the complete screen walk before a targeted recheck.');
    report[index] =
      `| ${result.name} | ${result.key} | ${result.overflow ? 'yes' : 'no'} | ${result.errors.length} |`;
  }
  writeFileSync(join(OUT, 'README.md'), report.join('\n'));
  process.stdout.write(`${results.length} sign-out checks, ${failures} failed.\n`);
  process.exit(failures ? 1 : 0);
}

// ---- state the mock holds ----

const { agents } = await api('GET', '/agents');
const nova = agents.find((a) => a.name === 'Nova') ?? agents[0];
const { conversations } = await api('GET', '/conversations');
const kyoto = conversations.find((c) => c.title === 'Kyoto in October');
const passport = conversations.find((c) => c.title === 'Passport renewal');
const { plans } = await api('GET', '/plans');
const japan = plans.find((p) => p.title.startsWith('Japan')) ?? plans[0];

// ---- the walk ----

await surface(
  'design-sheet',
  'The living component sheet at #/design: every primitive in every state.',
  '/design',
  { settle: 800 },
);
await surface(
  'sign-in',
  'Sign-in: the magic link; OAuth buttons only when the service says they work, and the honest reason when it does not.',
  '/welcome',
);
await surface(
  'home',
  'Home with the day panel from the contract: composer first, then active plans and recent chats.',
  '/',
);

const created = (
  await api('POST', '/conversations', { title: 'Dinner with friends', agent_id: nova.id })
).conversation;
await api(
  'POST',
  `/conversations/${created.id}/messages`,
  { text: 'Find a lovely spot for dinner with Alex and Priya tonight at 7:30.' },
  { 'Idempotency-Key': `walk-${Date.now()}` },
);
await surface(
  'chat-working',
  'The dinner conversation while Nova works: say and action steps with app-named sources, Stop in the composer.',
  `/chat/${created.id}`,
  { settle: 1200, only: [WIDTHS[0], WIDTHS[2]] },
);

await waitFor(async () => find(await events(created.id), 'permission'));
await surface(
  'chat-decide',
  'The permission card with its result-card preview, the draft with explicit send, the trail collapsed.',
  `/chat/${created.id}`,
  { settle: 1500 },
);

const permission = find(await events(created.id), 'permission').permission;
await api('POST', `/permissions/${permission.id}`, {
  option: 'allow_once',
  version: permission.version,
});
await waitFor(async () => find(await events(created.id), 'done'));
await surface(
  'chat-done',
  'The finished turn: the receipt with undo, the draft still unsent, the collapsed trail.',
  `/chat/${created.id}`,
  { settle: 1500 },
);

const draft = (await api('GET', `/conversations/${created.id}/drafts`)).drafts[0];
if (draft) await api('POST', `/drafts/${draft.id}/send`);
await surface(
  'chat-sent',
  'After the person pressed send on the draft: the sent receipt, nothing recalled.',
  `/chat/${created.id}`,
  { settle: 1500, only: [WIDTHS[0]] },
);

// An effect the connector never confirms rests in the broker's ledger; the
// person settles it from the card.
const ledger = (await api('POST', '/conversations', { title: 'Ledger entry', agent_id: nova.id }))
  .conversation;
await api(
  'POST',
  `/conversations/${ledger.id}/messages`,
  { text: 'Write one line to the flaky test destination.' },
  { 'Idempotency-Key': `walk-ledger-${Date.now()}` },
);
const ledgerDraft = await waitFor(
  async () => (await api('GET', `/conversations/${ledger.id}/drafts`)).drafts?.[0],
);
const sendOutcome = await api('POST', `/drafts/${ledgerDraft.id}/send`);
if (sendOutcome.permission)
  await api('POST', `/permissions/${sendOutcome.permission.id}`, {
    option: 'allow_once',
    version: sendOutcome.permission.version,
  });
await waitFor(async () =>
  (await api('GET', `/actions?job_id=${ledger.id}`)).actions?.find((a) => a.status === 'unknown'),
);
await surface(
  'chat-unknown',
  'An effect the connector never confirmed: the unknown-outcome card from the broker’s ledger, nothing repeated, the person decides.',
  `/chat/${ledger.id}`,
  { settle: 1500, only: [WIDTHS[0], WIDTHS[2]] },
);
await surface(
  'chat-resolved',
  'After the person said it arrived: the card settled, the note in the transcript, the turn done.',
  `/chat/${ledger.id}`,
  {
    settle: 1500,
    only: [WIDTHS[0]],
    prepare: async (page) => {
      // The first theme settles the action; the second finds it already settled.
      const arrived = page.getByRole('button', { name: 'It arrived' });
      if ((await arrived.count()) > 0) {
        await arrived.click();
        // The buttons give way to the badge once the ledger has the decision.
        await arrived.waitFor({ state: 'detached', timeout: 10_000 });
      }
      await page.getByText('It arrived', { exact: true }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(800);
    },
  },
);

// A message that needs only acknowledgement: the agent reacts to the person's
// bubble, and the person answers the earlier result with a tap.
await api(
  'POST',
  `/conversations/${created.id}/messages`,
  { text: 'Thanks, that is perfect.' },
  { 'Idempotency-Key': `walk-thanks-${Date.now()}` },
);
await waitFor(async () => {
  const list = await events(created.id);
  const dones = list.filter((e) => e.item.type === 'done');
  return dones.length >= 2 ? dones : null;
});
await waitFor(async () =>
  (await api('GET', `/jobs/${created.id}/reactions`)).reactions?.find((r) => r.by === 'assistant'),
);
await surface(
  'chat-reactions',
  'Reactions drawn on the bubbles they belong to: the agent\u2019s glyph on the person\u2019s thanks, the person\u2019s tap on the earlier result.',
  `/chat/${created.id}`,
  {
    settle: 1500,
    only: [WIDTHS[0], WIDTHS[2]],
    prepare: async (page) => {
      const button = page.getByRole('button', { name: 'React with 👍' }).first();
      await button.click();
      await page
        .locator('.turn')
        .first()
        .locator('.reaction[data-mine="true"]')
        .waitFor({ timeout: 10_000 });
      await page
        .locator('.bubble-wrap')
        .filter({ hasText: 'Thanks, that is perfect.' })
        .locator('.reaction')
        .waitFor({ timeout: 10_000 });
      if ((await page.locator('.bubble-wrap').first().locator('.reaction').count()) !== 0)
        throw new Error('the acknowledgement moved onto the earlier person message');
      if ((await page.locator('.turn').last().locator('.react-btn').count()) !== 0)
        throw new Error('a reaction-only answer has reaction controls');
      await page.waitForTimeout(500);
    },
  },
);

if (kyoto)
  await surface(
    'chat-question',
    'A question with keyboard answers (1–4) waiting for the person.',
    `/chat/${kyoto.id}`,
    { settle: 1500 },
  );
if (passport)
  await surface(
    'chat-plain',
    'A plain answer with its one source; nothing to decide.',
    `/chat/${passport.id}`,
    { settle: 1200 },
  );

await surface(
  'command-palette',
  'The command palette (⌘K) with typed results across chats, plans, tasks, connections and actions.',
  '/',
  {
    prepare: async (page) => {
      await page.keyboard.press('Control+K');
      await page.waitForTimeout(600);
    },
  },
);

await surface(
  'plans',
  'Plans with the sheet open on Japan: milestones with assignees, the linked chat, Ask Melete about this plan.',
  `/plans/${japan?.id ?? ''}`,
);
await surface(
  'plans-new',
  'The New plan dialog after typing a full title: focus stays in the field and every keystroke lands.',
  '/plans',
  {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'New plan' }).first().click();
      const title = page.getByRole('dialog').getByLabel('Title');
      await title.waitFor();
      await page.keyboard.type('Learn to sail by spring', { delay: 20 });
      const value = await title.inputValue();
      if (value !== 'Learn to sail by spring')
        throw new Error(`the dialog lost keystrokes: "${value}"`);
      const focused = await title.evaluate((node) => node === document.activeElement);
      if (!focused) throw new Error('focus left the title field');
      await page.waitForTimeout(300);
    },
    only: [WIDTHS[0]],
  },
);
await surface(
  'agents',
  'Agents with Nova open in the editor: look, the nine states, the face wall, templates.',
  `/agents/${nova.id}`,
);
await surface(
  'automations',
  'Automations: schedule sentences, run history, test run, and a new routine.',
  '/automations',
);
await surface(
  'settings-memory',
  'Settings › Memory in plain language with edit, forget and why.',
  '/settings/memory',
);
await surface(
  'settings-connections',
  'Settings › Connections: status and what each may do.',
  '/settings/connections',
);
await surface(
  'settings-rules',
  'Settings › Rules: standing grants with their limits and revoke.',
  '/settings/rules',
);

await surface(
  'onboarding-welcome',
  'Setup step 1: welcome, name, and the morning brief.',
  '/setup',
);
await surface(
  'onboarding-tour',
  'Setup step 2: the tour, only the stages this instance can do.',
  '/setup',
  {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Show me' }).click();
      await page.waitForTimeout(900);
    },
  },
);
await surface('onboarding-connect', 'Setup step 3: what Melete may look at.', '/setup', {
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Show me' }).click();
    for (let i = 0; i < 6; i += 1) {
      const next = page.getByRole('button', { name: /^(Next|Continue)$/ });
      if ((await next.count()) === 0) break;
      await next.first().click();
      await page.waitForTimeout(200);
      if ((await page.getByText('What Melete may look at').count()) > 0) break;
    }
    await page.waitForTimeout(500);
  },
});
let firstChatId;
await surface('onboarding-agent', 'Setup step 4: meet your first agent.', '/setup', {
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Show me' }).click();
    for (let i = 0; i < 8; i += 1) {
      if (await page.getByText('Meet your first agent', { exact: true }).count()) break;
      await page
        .getByRole('button', { name: /^(Next|Continue)$/ })
        .first()
        .click();
      await page.waitForTimeout(200);
    }
    await page.getByText('Meet your first agent', { exact: true }).waitFor();
  },
});
await surface(
  'onboarding-know-you',
  'Setup step 5: four answers saved as memory items, with their values returned by the service.',
  '/setup',
  {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Show me' }).click();
      for (let i = 0; i < 8; i += 1) {
        const next = page.getByRole('button', { name: /^(Next|Continue)$/ });
        if ((await next.count()) === 0) break;
        await next.first().click();
        await page.waitForTimeout(200);
        if ((await page.getByText('Let Nova get to know you').count()) > 0) break;
      }
      await page.getByRole('button', { name: 'New York' }).click();
      await page.getByText('home: city').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Alex and Priya' }).click();
      await page.getByText('people: names').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'A launch at work' }).click();
      await page.getByText('focus: this month').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Morning brief at 8:30' }).click();
      await page.getByText('checkins: style').waitFor({ timeout: 10_000 });
      const { items } = await api('GET', '/memory/items');
      for (const value of [
        'New York',
        'Alex and Priya',
        'A launch at work',
        'Morning brief at 8:30',
      ]) {
        if (
          items.filter((item) => item.source === 'onboarding' && item.value === value).length !== 1
        )
          throw new Error(`Expected one saved setup answer: ${value}`);
      }
      await page.waitForTimeout(500);
    },
    verify: async (page) => {
      if (firstChatId) return;
      await page.getByRole('button', { name: 'Open Melete' }).click();
      await page.waitForURL(/#\/chat\//);
      firstChatId = page.url().split('#/chat/')[1];
      await waitFor(async () => {
        const { turns } = await api('GET', `/conversations/${firstChatId}/messages`);
        if (!turns[0]?.text.includes('A launch at work'))
          throw new Error('The first message omitted the setup answer');
        return turns[0]?.answer.includes('You said “A launch at work”');
      });
      await page
        .getByText(/Hi .*You said “A launch at work”/)
        .first()
        .waitFor();
    },
  },
);
await surface(
  'onboarding-first-message',
  'The completed setup opens a conversation whose first message and welcome refer to a saved answer.',
  `/chat/${firstChatId}`,
);

await surface('phone-drawer', 'The phone layout with the sidebar drawer open.', '/', {
  only: [WIDTHS[2]],
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Open the sidebar' }).click();
    await page.waitForTimeout(400);
  },
});
// Home carries the day in the page, so the sheet is opened from a page with a rail.
await surface('phone-day', 'The phone layout with the day panel sheet open.', '/automations', {
  only: [WIDTHS[2]],
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Your day' }).click();
    await page.waitForTimeout(400);
  },
});

// Signing out ends the session: the next request is refused and the app shows
// sign-in. The walk then consumes a link so the mock's session is back.
async function signOutSurface() {
  await surface(
    'settings-signout',
    'Sign-in after pressing Sign out in Settings; reloading with the revoked session still shows sign-in.',
    '/settings/memory',
    {
      only: [WIDTHS[0]],
      expectedProfile401: true,
      prepare: async (page) => {
        await page.getByRole('button', { name: 'Sign out' }).click();
        await page.getByText('Welcome to Melete').waitFor({ timeout: 10_000 });
        const refused = await fetch(`${API}/profile`);
        if (refused.status !== 401) throw new Error(`profile still answers ${refused.status}`);
        await page.waitForTimeout(300);
      },
      verify: async (page) => {
        await page.reload();
        await page.getByText('Welcome to Melete').waitFor({ timeout: 10_000 });
        await api('POST', '/signin/magic-link/consume', {
          token: 'walk-restore-token-0123456789abcdef0123456789abcdef',
        });
        await page.goto(`${WEB}/#/settings/memory`);
        await page.reload();
        await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 10_000 });
      },
    },
  );
}
await signOutSurface();

await browser.close();

const lines = [
  '# Screens',
  '',
  'Written by `bun run --cwd apps/web screens` against the mock serving the experience contract. Every surface is checked at 1440, 1024 and 390 px in light and dark for horizontal overflow and unexpected console errors; the committed images are 1440 light, 390 light and 1440 dark. Revoked profile requests are asserted to return 401 during sign-out and are counted separately in the console output. Pass `--signout-only` to recheck those cases without repeating the complete walk.',
  '',
  ...captions,
  '',
  '## Last run',
  '',
  '| surface | viewport | overflow | unexpected console errors |',
  '|---|---|---|---|',
  ...results.map(
    (r) => `| ${r.name} | ${r.key} | ${r.overflow ? 'yes' : 'no'} | ${r.errors.length} |`,
  ),
  '',
];
writeFileSync(join(OUT, 'README.md'), lines.join('\n'));
process.stdout.write(`\n${results.length} checks, ${failures} failed. Screens in ${OUT}\n`);
process.exit(failures ? 1 : 0);
