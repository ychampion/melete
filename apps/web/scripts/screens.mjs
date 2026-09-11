/**
 * Walk every designed surface at three widths in both themes, check for
 * horizontal overflow and console errors, and write the screenshots that
 * apps/web/docs/screens carries.
 *
 * Needs the mock on :3210 and the dev server on :5180:
 *   bun run dev:mock            (in one shell; MOCK_PORT=3210)
 *   bun run dev:web             (in another)
 *   bun run --cwd apps/web screens
 *
 * The chat states are real: the script starts the dinner conversation through
 * the mock, waits for the agent to reach each state, decides the permission,
 * and sends the follow-up that opens the sandboxed browser.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
const api = async (method, path, body) => {
  const response = await fetch(`${API}/experience${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};

const waitFor = async (check, timeoutMs = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await sleep(400);
  }
  throw new Error('timed out waiting for the mock');
};

const permissionOf = (conversation) =>
  conversation.events.find((e) => e.type === 'block' && e.payload.block.kind === 'permission')
    ?.payload.block.permission;

const results = [];
const captions = [];
let failures = 0;

const browser = await chromium.launch();

/**
 * Render one surface at every width and theme. `prepare` runs once per
 * viewport after navigation and can click through the interface.
 */
async function surface(name, caption, route, { prepare, settle = 1200, only } = {}) {
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
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
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
      const ok = !overflow && errors.length === 0;
      if (!ok) failures += 1;
      results.push({ name, key, overflow, errors, file: COMMIT.has(key) ? file : null });
      process.stdout.write(
        `${ok ? 'ok  ' : 'FAIL'} ${name} ${key}${overflow ? ' overflow' : ''}${errors.length ? ` ${errors[0]}` : ''}\n`,
      );
      await context.close();
    }
  }
}

// ---- state the mock needs before the walk ----

const seeded = await api('GET', '/conversations');
const kyoto = seeded.conversations.find((c) => c.title === 'Kyoto in October');
const passport = seeded.conversations.find((c) => c.title === 'Passport renewal');

// ---- the walk ----

await surface(
  'design-sheet',
  'The living component sheet at #/design: every primitive in every state.',
  '/design',
  { settle: 800 },
);

await api('POST', '/session/sign-out');
await surface(
  'sign-in',
  'Sign-in: magic link, and the OAuth buttons the adapter reports as available.',
  '/',
);
await api('POST', '/session/complete', {});

await surface(
  'home',
  'Home with the day panel: composer first, then active plans and recent chats.',
  '/',
);

const dinner = (
  await api('POST', '/conversations', {
    text: 'Find a lovely spot for dinner with Alex and Priya tonight at 7:30.',
    agent_id: 'nova',
  })
).conversation;
await surface(
  'chat-working',
  'The dinner conversation while Nova works: trail with say and action steps, sources with logos, Pause in the composer.',
  `/chat/${dinner.id}`,
  { settle: 1200, only: [WIDTHS[0], WIDTHS[2]] },
);

await waitFor(async () => permissionOf(await api('GET', `/conversations/${dinner.id}`)));
await surface(
  'chat-decide',
  'The result card whose primary button decides the calendar permission, the draft with explicit send, the trail collapsed.',
  `/chat/${dinner.id}`,
  { settle: 1500 },
);

const permission = permissionOf(await api('GET', `/conversations/${dinner.id}`));
await api('POST', `/permissions/${permission.id}`, {
  decision: 'allow_once',
  payload_hash: permission.payload_hash,
});
await waitFor(async () =>
  (await api('GET', `/conversations/${dinner.id}`)).events.some(
    (e) => e.type === 'trail_step' && e.payload.step.kind === 'done',
  ),
);
await surface(
  'chat-done',
  'The finished turn: card confirmed with the receipt and undo, draft still unsent, reactions inline.',
  `/chat/${dinner.id}`,
  { settle: 1500 },
);

await api('POST', `/conversations/${dinner.id}/messages`, {
  text: 'Perfect, book it and remind me at 6.',
});
await waitFor(async () =>
  (await api('GET', `/conversations/${dinner.id}`)).events.some(
    (e) => e.type === 'block' && e.payload.block.kind === 'browser',
  ),
);
await surface(
  'chat-browser',
  'The browser task card and the docked browser panel while Nova books the table; hidden entirely when the adapter reports no browser.',
  `/chat/${dinner.id}`,
  { settle: 2000 },
);

if (kyoto) {
  await surface(
    'chat-question',
    'A question with keyboard answers (1–4) and the unknown-outcome-free plain turn with sources.',
    `/chat/${kyoto.id}`,
    { settle: 1500 },
  );
}
if (passport) {
  await surface(
    'chat-plain',
    'A plain answer with its one source; nothing to decide.',
    `/chat/${passport.id}`,
    { settle: 1200 },
  );
}

await surface(
  'command-palette',
  'The command palette (⌘K) with typed results across chats, plans, tasks, events, connections and actions.',
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
  'Plans with the sheet open on Japan: milestones with assignees, linked chat and file, Ask Melete about this plan.',
  '/plans/japan',
);
await surface(
  'agents',
  'Agents with Nova open in the editor: look, the nine states, the face wall, templates.',
  '/agents/nova',
);
await surface(
  'automations',
  'Automations: sentence triggers, run history with retry, test run.',
  '/automations',
);
await surface(
  'settings-memory',
  'Settings › Memory in plain language with edit, delete and why.',
  '/settings/memory',
);
await surface(
  'settings-connections',
  'Settings › Connections with the available → connecting → connected → error states and what each may do.',
  '/settings/connections',
);
await surface(
  'settings-rules',
  'Settings › Rules: standing grants with revoke.',
  '/settings/rules',
);

await surface(
  'onboarding-welcome',
  'Setup step 1: welcome, name, and the morning brief.',
  '/setup',
);
await surface(
  'onboarding-tour',
  'Setup step 2: the tour, only the stages the adapter reports as available.',
  '/setup',
  {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Show me' }).click();
      await page.waitForTimeout(900);
    },
  },
);
await surface('onboarding-connect', 'Setup step 3: plug in apps.', '/setup', {
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Show me' }).click();
    for (let i = 0; i < 6; i += 1) {
      const next = page.getByRole('button', { name: /^(Next|Continue)$/ });
      if ((await next.count()) === 0) break;
      await next.first().click();
      await page.waitForTimeout(200);
      if ((await page.getByText('Plug in what Melete may look at').count()) > 0) break;
    }
    await page.waitForTimeout(500);
  },
});
await surface(
  'onboarding-agent',
  'Setup step 4: meet your first agent, with import SVG/PNG.',
  '/setup',
  {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Show me' }).click();
      for (let i = 0; i < 8; i += 1) {
        const next = page.getByRole('button', { name: /^(Next|Continue)$/ });
        if ((await next.count()) === 0) break;
        await next.first().click();
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(500);
    },
  },
);
await surface(
  'onboarding-know-you',
  'Setup step 5: four answers that become memory items.',
  '/setup',
  {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Show me' }).click();
      for (let i = 0; i < 8; i += 1) {
        const next = page.getByRole('button', { name: /^(Next|Continue)$/ });
        if ((await next.count()) === 0) break;
        await next.first().click();
        await page.waitForTimeout(200);
      }
      await page.getByRole('button', { name: 'Say hello' }).click();
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: 'New York' }).click();
      await page.waitForTimeout(1600);
    },
  },
);

await surface('phone-drawer', 'The phone layout with the sidebar drawer open.', '/', {
  only: [WIDTHS[2]],
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Open the sidebar' }).click();
    await page.waitForTimeout(400);
  },
});
await surface('phone-day', 'The phone layout with the day panel sheet open.', '/', {
  only: [WIDTHS[2]],
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Your day' }).click();
    await page.waitForTimeout(400);
  },
});

await browser.close();

const lines = [
  '# Screens',
  '',
  'Written by `bun run --cwd apps/web screens` against the mock. Every surface is checked at 1440, 1024 and 390 px in light and dark for horizontal overflow and console errors; the committed images are 1440 light, 390 light and 1440 dark.',
  '',
  ...captions,
  '',
  '## Last run',
  '',
  '| surface | viewport | overflow | console errors |',
  '|---|---|---|---|',
  ...results.map(
    (r) => `| ${r.name} | ${r.key} | ${r.overflow ? 'yes' : 'no'} | ${r.errors.length} |`,
  ),
  '',
];
writeFileSync(join(OUT, 'README.md'), lines.join('\n'));
process.stdout.write(`\n${results.length} checks, ${failures} failed. Screens in ${OUT}\n`);
process.exit(failures ? 1 : 0);
