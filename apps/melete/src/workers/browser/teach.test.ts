/**
 * Teaching by showing, in the worker: the step log a person's own input makes, what it never
 * keeps, its cap, and the control epoch that bounds it. The page is a stand-in for the fixture
 * bank site, answering the probe as Chromium's accessibility tree would; `cdpTeachProbe` itself
 * needs a real Chromium and is exercised only where one is installed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { LiveInput } from './live-protocol.ts';
import { BrowserFault, BrowserSessions } from './sessions.ts';
import {
  downloadName,
  type ElementFacts,
  StepLog,
  secretField,
  TEACH_STEP_LIMIT,
  TeachRecorder,
  taughtUrl,
} from './teach.ts';

/** One control on the fixture page: where it is drawn, and what the browser says it is. */
type Placed = ElementFacts & { box: { x: number; y: number; w: number; h: number } };
const control = (
  role: string,
  name: string,
  box: Placed['box'],
  tag = 'button',
  attributes: Record<string, string> = {},
  node = Math.floor(Math.random() * 1e9),
): Placed => ({ role, name, tag, attributes, node, box });

/** The fixture bank site's statements page, and its sign-in page's secret fields. */
const STATEMENTS = control('link', 'Statements', { x: 10, y: 10, w: 100, h: 20 }, 'a');
const SEARCH = control('searchbox', 'Search statements', { x: 10, y: 50, w: 200, h: 20 }, 'input', {
  type: 'search',
  name: 'q',
});
const MONTH = control('button', 'October 2026', { x: 10, y: 90, w: 120, h: 20 });
const DOWNLOAD = control('button', 'Download PDF', { x: 10, y: 130, w: 120, h: 20 });
const PASSWORD = control('textbox', 'Password', { x: 300, y: 50, w: 200, h: 20 }, 'input', {
  type: 'password',
  name: 'pw',
});
const CODE = control('textbox', 'Verification', { x: 300, y: 90, w: 200, h: 20 }, 'input', {
  autocomplete: 'one-time-code',
  inputmode: 'numeric',
  name: 'verify',
});
const CARD = control('textbox', 'Card number', { x: 300, y: 130, w: 200, h: 20 }, 'input', {
  name: 'number',
});
const NOTE = control('textbox', 'Note to self', { x: 300, y: 170, w: 200, h: 20 }, 'input');
const FIXTURE = [STATEMENTS, SEARCH, MONTH, DOWNLOAD, PASSWORD, CODE, CARD, NOTE];

/** A page that answers the recorder as the browser would, focusing what was last pressed. */
function fixturePage(title = 'Statements | Fixture Bank') {
  let focused: Placed | undefined;
  let probes = 0;
  const at = (x: number, y: number) =>
    FIXTURE.find(({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
  return {
    probe: {
      async at(x: number, y: number) {
        probes++;
        focused = at(x, y);
        return focused;
      },
      async focused() {
        probes++;
        return focused;
      },
      async title() {
        return title;
      },
    },
    probes: () => probes,
  };
}

const press = (part: Placed): LiveInput[] => {
  const point = { x: part.box.x + 5, y: part.box.y + 5 };
  return [
    { k: 'down', ...point, button: 0, mods: 0, clicks: 1 },
    { k: 'up', ...point, button: 0, mods: 0, clicks: 1 },
  ];
};
const type = (text: string): LiveInput[] => [
  ...[...text].map(
    (key): LiveInput => ({ k: 'key', down: true, key, code: '', vk: 0, mods: 0, text: key }),
  ),
  { k: 'text', text },
];
const ENTER: LiveInput = { k: 'key', down: true, key: 'Enter', code: 'Enter', vk: 13, mods: 0 };

async function drive(recorder: TeachRecorder, events: LiveInput[]) {
  for (const event of events) await recorder.before(event);
}

test('a scripted teaching session keeps navigations, clicks by role and name, field labels with placeholders, and the download', async () => {
  const page = fixturePage();
  const log = new StepLog(7);
  const recorder = new TeachRecorder(log, () => page.probe);
  recorder.navigated(
    'https://bank.example/accounts?session=8f3k9x2mq7&tab=overview&token=eyJhbGciOiJIUzI1NiJ9',
    'Accounts | Fixture Bank',
  );
  await drive(recorder, press(STATEMENTS));
  // A redirect after the click is one page reached, its last address kept.
  recorder.navigated('https://bank.example/statements?sid=a81b22c9', 'Loading');
  recorder.navigated('https://bank.example/statements?view=list', 'Statements | Fixture Bank');
  await drive(recorder, [...press(SEARCH), ...type('october'), ENTER]);
  await drive(recorder, press(MONTH));
  await drive(recorder, press(DOWNLOAD));
  recorder.downloaded(
    downloadName(
      'attachment; filename="statement-october.pdf"',
      'https://bank.example/files/9f8e7d6c5b4a',
    ),
    'application/pdf; charset=binary',
  );
  const shown = log.seal();
  expect(shown).toEqual({
    truncated: false,
    steps: [
      {
        kind: 'open',
        url: 'https://bank.example/accounts?tab=overview',
        title: 'Accounts | Fixture Bank',
      },
      { kind: 'click', role: 'link', name: 'Statements', title: 'Statements | Fixture Bank' },
      {
        kind: 'open',
        url: 'https://bank.example/statements?view=list',
        title: 'Statements | Fixture Bank',
      },
      { kind: 'fill', label: 'Search statements', value: '{search statements}' },
      { kind: 'press', key: 'Enter' },
      { kind: 'click', role: 'button', name: 'October 2026', title: 'Statements | Fixture Bank' },
      { kind: 'click', role: 'button', name: 'Download PDF', title: 'Statements | Fixture Bank' },
      { kind: 'download', file: 'statement-october.pdf', type: 'application/pdf' },
    ],
  });
  // No value the person typed, and no token from an address.
  const kept = JSON.stringify(shown);
  for (const secret of ['october"', '8f3k9x2mq7', 'a81b22c9', 'eyJhbGci'])
    expect([secret, kept.includes(secret)]).toEqual([secret, false]);
  // One look per field, not one per key.
  expect(page.probes()).toBeLessThan(10);
});

test('a password field and a one-time-code field are never captured, not even their length', async () => {
  const page = fixturePage('Sign in | Fixture Bank');
  const log = new StepLog(3);
  const recorder = new TeachRecorder(log, () => page.probe);
  await drive(recorder, [...press(PASSWORD), ...type('hunter2-very-secret'), ENTER]);
  await drive(recorder, [...press(CODE), ...type('482913')]);
  await drive(recorder, [...press(CARD), ...type('4242424242424242')]);
  await drive(recorder, [...press(NOTE), ...type('fine')]);
  const shown = log.seal();
  expect(shown.steps).toEqual([
    { kind: 'press', key: 'Enter' },
    { kind: 'fill', label: 'Note to self', value: '{note to self}' },
  ]);
  const kept = JSON.stringify(shown);
  for (const part of ['Password', 'Verification', 'Card', 'hunter2', '482913', '4242', '19', '6'])
    expect([part, kept.includes(part)]).toEqual([part, false]);
  // The rule itself, for each way a field says what it is.
  expect(secretField(PASSWORD)).toBe(true);
  expect(secretField(CODE)).toBe(true);
  expect(secretField(CARD)).toBe(true);
  expect(secretField({ ...NOTE, attributes: { autocomplete: 'cc-exp' } })).toBe(true);
  expect(secretField({ ...NOTE, attributes: { name: 'otp_code' } })).toBe(true);
  expect(secretField({ ...NOTE, name: 'Enter the 6-digit code' })).toBe(true);
  expect(secretField(NOTE)).toBe(false);
  expect(secretField(SEARCH)).toBe(false);
});

test('the cap holds: steps past it are counted as cut off and never kept', async () => {
  const page = fixturePage();
  const log = new StepLog(1);
  const recorder = new TeachRecorder(log, () => page.probe);
  for (let index = 0; index < TEACH_STEP_LIMIT + 50; index++) await drive(recorder, press(MONTH));
  recorder.navigated('https://bank.example/after-the-cap', 'After');
  recorder.downloaded('late.pdf', 'application/pdf');
  const shown = log.seal();
  expect(shown.steps).toHaveLength(TEACH_STEP_LIMIT);
  expect(shown.truncated).toBe(true);
  expect(JSON.stringify(shown)).not.toContain('after-the-cap');
  expect(JSON.stringify(shown)).not.toContain('late.pdf');
});

test('a sealed log takes nothing more, and a slow or failing look leaves no step', async () => {
  const log = new StepLog(2);
  const hanging = new TeachRecorder(log, () => ({
    at: () => new Promise<undefined>(() => {}),
    focused: () => Promise.reject(new Error('gone')),
    title: async () => '',
  }));
  const started = Date.now();
  await drive(hanging, [...press(MONTH), ...type('x')]);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(log.size).toBe(0);
  const sealed = log.seal();
  log.clicked(MONTH, 'late');
  log.opened('https://bank.example/late', 'late');
  log.downloaded('late.pdf', 'application/pdf');
  expect(sealed.steps).toEqual([]);
  expect(log.seal().steps).toEqual([]);
});

test('a step keeps an address without its tokens and ids, and names without secret shapes', () => {
  expect(taughtUrl('https://bank.example/statements?tab=pdf&page=2')).toBe(
    'https://bank.example/statements?tab=pdf&page=2',
  );
  expect(
    taughtUrl(
      'https://bank.example/s/7f3k9x2m/download?user_id=42&code=ABCD&state=x&email=a%40b.c&ref=3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ),
  ).toBe('https://bank.example/s/%5Bredacted%5D/download');
  expect(taughtUrl('https://u:p@bank.example/p#frag')).toBe('https://bank.example/p');
  expect(taughtUrl('about:blank')).toBe('');
  expect(
    downloadName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'https://x.example/'),
  ).toBe('résumé.pdf');
  expect(downloadName(undefined, 'https://x.example/files/report.csv')).toBe('report.csv');
  expect(downloadName('attachment; filename="../../acct-12345678.pdf"', 'https://x.example/')).toBe(
    '[redacted].pdf',
  );
  const log = new StepLog(1);
  log.clicked({ role: 'button', name: 'Use code KXQPMZ', tag: 'button', attributes: {} }, 't');
  expect(log.seal().steps).toEqual([
    { kind: 'click', role: 'button', name: 'Use code [redacted]', title: 't' },
  ]);
});

describe('the control epoch bounds a teaching takeover', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  /** A session whose Chromium is a stand-in: control and epochs are what is under test. */
  async function session() {
    const root = await mkdtemp(join(tmpdir(), 'melete-teach-'));
    roots.push(root);
    const page = { setDefaultTimeout() {}, url: () => 'about:blank' };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
      browser: () => null,
      cookies: async () => [],
    } as unknown as BrowserContext;
    const sessions = new BrowserSessions({
      spaceId: 'sp_teach',
      spaceRoot: root,
      launch: async () => context,
    });
    const leased = await sessions.lease('job_teach', {
      public_compartment: false,
      allowed_domains: [],
    });
    return { sessions, id: leased.id };
  }
  const fault = (operation: () => unknown) => {
    try {
      operation();
      return 'none';
    } catch (error) {
      return error instanceof BrowserFault ? error.reason : String(error);
    }
  };

  test('teaching is a takeover: same epoch bump, and automation is refused while it lasts', async () => {
    const { sessions, id } = await session();
    const before = sessions.session?.control_epoch ?? -1;
    const taken = await sessions.takeover(id, { teach: true });
    expect(taken).toMatchObject({ control: 'human', control_epoch: before + 1, teaching: true });
    expect(fault(() => sessions.checkInput(id, before))).toBe('stale_control_epoch');
    expect(fault(() => sessions.checkInput(id, taken.control_epoch))).toBe('human_control');
    // The log is the live channel's for this epoch alone.
    expect(sessions.teaching(id, taken.control_epoch)?.epoch).toBe(taken.control_epoch);
    expect(fault(() => sessions.teaching(id, before))).toBe('epoch_changed');
    // A plain takeover records nothing.
    const plain = await sessions.takeover(id);
    expect(plain.teaching).toBeUndefined();
    expect(sessions.teaching(id, plain.control_epoch)).toBeUndefined();
    await sessions.close();
  });

  test('the steps leave only in the handback that ends their own epoch; anything after, or discarded, never does', async () => {
    const { sessions, id } = await session();
    const taken = await sessions.takeover(id, { teach: true });
    const log = sessions.teaching(id, taken.control_epoch);
    log?.clicked(DOWNLOAD, 'Statements');
    const back = await sessions.handback(id);
    expect(back.control).toBe('automation');
    expect(back.shown?.steps).toEqual([
      { kind: 'click', role: 'button', name: 'Download PDF', title: 'Statements' },
    ]);
    // Read after the person handed back: the sealed log takes nothing, and nothing is handed again.
    log?.clicked(MONTH, 'after');
    expect(fault(() => sessions.teaching(id, taken.control_epoch))).toBe('epoch_changed');
    expect((await sessions.handback(id)).shown).toBeUndefined();

    // Discard throws the steps away.
    const again = await sessions.takeover(id, { teach: true });
    sessions.teaching(id, again.control_epoch)?.clicked(MONTH, 'Statements');
    expect((await sessions.handback(id, { discard: true })).shown).toBeUndefined();

    // A takeover that starts over a teaching one ends the first log empty-handed.
    const first = await sessions.takeover(id, { teach: true });
    const stale = sessions.teaching(id, first.control_epoch);
    stale?.clicked(MONTH, 'first');
    await sessions.takeover(id);
    stale?.clicked(DOWNLOAD, 'first');
    expect((await sessions.handback(id)).shown).toBeUndefined();

    // So does the session closing under it.
    const last = await sessions.takeover(id, { teach: true });
    const closing = sessions.teaching(id, last.control_epoch);
    closing?.clicked(MONTH, 'last');
    await sessions.close();
    closing?.clicked(DOWNLOAD, 'last');
    expect(closing?.seal().steps).toHaveLength(1);
  });
});
