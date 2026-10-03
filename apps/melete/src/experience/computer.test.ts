import { expect, test } from 'bun:test';
import { projectComputer, terminalText } from './computer.ts';
import type { ActionRow } from './projectors.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 9, minute));
let n = 0;
const row = (kind: string, detail: Record<string, unknown>, payload = {}, status = 'succeeded') =>
  ({
    id: `act_${++n}`,
    jobId: 'job_1',
    attemptId: 'att_1',
    connectionId: 'conn_1',
    kind,
    effectClass: 'read',
    canonicalPayload: payload,
    receipt: { detail },
    status,
    createdAt: at(n),
    resolvedAt: at(n),
  }) as unknown as ActionRow;
const observation = (url: string, title: string, screenshot?: string) => ({
  session_id: 'bs_1',
  control_epoch: 1,
  observation: {
    id: 'obs',
    url,
    title,
    ...(screenshot ? { screenshot: { artifact_id: screenshot } } : {}),
  },
});
const available = { browser: true, terminal: false };

test('the newest observation decides the page; an older picture is not carried past a hand-back', () => {
  const view = projectComputer({
    rows: [
      row('browser.observe', observation('https://example.test/start', 'Start', 'art_before')),
      row(
        'browser.observe',
        observation('https://example.test/account/[redacted]', 'Code [redacted]'),
      ),
    ],
    bindings: [{ id: 'bs_1', control: 'automation', updated_at: at(1) }],
    available,
  });
  expect(view.browser).toMatchObject({
    session_id: 'bs_1',
    control: 'agent',
    title: 'Code [redacted]',
    screenshot: null,
  });
});

test('an address loses its query, and the binding touched last is the browser shown', () => {
  const view = projectComputer({
    rows: [
      row('browser.observe', {
        ...observation('https://example.test/a?token=abc#x', 'A', 'art_a'),
        session_id: 'bs_2',
      }),
    ],
    bindings: [
      { id: 'bs_1', control: 'automation', updated_at: at(1) },
      { id: 'bs_2', control: 'human', updated_at: at(5) },
    ],
    available,
  });
  expect(view.browser).toMatchObject({
    session_id: 'bs_2',
    control: 'you',
    url: 'https://example.test/a',
    screenshot: { artifact_id: 'art_a' },
  });
});

test('terminal text keeps the last lines, strips escapes and hides a credential line whole', () => {
  const text = terminalText(
    'first\r\nexport TOKEN=abcdef123456\n\u001b[1mbold\u001b[0m\n\n',
    4000,
    'last',
  );
  expect(text).toBe('first\n[hidden]\nbold');
  expect(terminalText('ab '.repeat(2000), 100, 'first').length).toBe(100);
});

test('a quoted secret key and a password in a connection string hide their lines', () => {
  const text = terminalText(
    [
      '{',
      '  "user": "melete",',
      '  "password": "hunter2",',
      '}',
      'DATABASE_URL=postgres://melete:s3cret@db:5432/melete',
      'see https://example.test/a:b@c for the notes',
    ].join('\n'),
    4000,
    'last',
  );
  expect(text).toBe(
    [
      '{',
      '  "user": "melete",',
      '[hidden]',
      '}',
      '[hidden]',
      'see https://example.test/a:b@c for the notes',
    ].join('\n'),
  );
});

test('file paths built from record ids are shown, and keys that contain slashes are still hidden', () => {
  const text = terminalText(
    [
      "python3 - <<'EOF'",
      "open('/home/agent/screens/act_01M3W8C7DPW288T2ZC2Z1JCYN8.png', 'rb').read()",
      'ls work/notes/act_01M3W8C7DPW288T2ZC2Z1JCYN8',
      'EOF',
      'aws configure set x wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY9',
      'cat /srv/keys/Zx8kQ2mPq9Lw4Rt7Yv3Bn6Hc1Jd5Fs0Ga',
    ].join('\n'),
    4000,
    'first',
  );
  expect(text.split('\n')).toEqual([
    "python3 - <<'EOF'",
    "open('/home/agent/screens/act_01M3W8C7DPW288T2ZC2Z1JCYN8.png', 'rb').read()",
    'ls work/notes/act_01M3W8C7DPW288T2ZC2Z1JCYN8',
    'EOF',
    '[hidden]',
    '[hidden]',
  ]);
});

/** A seeded generator, so the fuzz below is the same run every time. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('base64 keys that contain a slash stay hidden after a path, as they were before file names were let through', () => {
  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // The rule before record ids were let through: any long mixed run is a key.
  const before =
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}/;
  const random = seeded(175);
  const keys = Array.from({ length: 4000 }, () =>
    Array.from({ length: 40 }, () => BASE64[Math.floor(random() * 64)]).join(''),
  ).filter((key) => key.includes('/'));
  expect(keys.length).toBeGreaterThan(1500);
  for (const context of [
    (key: string) => `cp out /tmp/${key}.txt`,
    (key: string) => `ls /home/agent/${key}`,
    (key: string) => `cat work/notes/${key}`,
    (key: string) => `key: ${key}`,
  ]) {
    const lines = keys.map(context);
    const shown = lines.filter((line) => terminalText(line, 4000, 'first') !== '[hidden]').length;
    const shownBefore = lines.filter((line) => !before.test(line)).length;
    expect(shown).toBeLessThanOrEqual(shownBefore);
    expect(shown).toBeLessThanOrEqual(keys.length / 100);
  }
});

test('a key with slashes behind a path, and a webhook address, stay hidden', () => {
  for (const line of [
    'cat /home/agent/wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'curl https://hooks.slack.com/services/T0AB12CD3/B0EF45GH6/sLaCkWeBhOoKsEcReTvAlUe',
  ])
    expect(terminalText(line, 4000, 'first')).toBe('[hidden]');
});

test("the agent's processes show the running ones first, with a scrubbed last line", () => {
  const process = (
    id: string,
    state: 'running' | 'exited' | 'lost',
    minute: number,
    line: string,
  ) => ({
    id,
    name: `task ${id}`,
    state,
    started_at: at(minute),
    created_at: at(minute),
    port: id === 'prc_server' ? 5173 : null,
    last_line: line,
  });
  const view = projectComputer({
    rows: [],
    bindings: [],
    processes: [
      process('prc_old', 'exited', 1, 'done'),
      process('prc_server', 'running', 2, '\u001b[32mready\u001b[0m on http://localhost:5173'),
      process('prc_lost', 'lost', 3, 'export API_TOKEN=sk-live-0123456789abcdef0123456789'),
    ],
    available,
  });
  expect(view.processes.map((each) => [each.id, each.state])).toEqual([
    ['prc_server', 'running'],
    ['prc_lost', 'lost'],
    ['prc_old', 'exited'],
  ]);
  expect(view.processes[0]).toMatchObject({
    port: 5173,
    last_line: 'ready on http://localhost:5173',
    can_preview: false,
  });
  expect(view.processes[1]?.last_line).toBe('[hidden]');
});

test('a process started by another person or in a sensitive conversation shows no name and no output', () => {
  const view = projectComputer({
    rows: [],
    bindings: [],
    processes: [
      {
        id: 'prc_theirs',
        name: 'deploy --token=abc',
        state: 'running',
        started_at: at(1),
        created_at: at(1),
        port: 8080,
        last_line: 'listening for the private plan',
        attributable: false,
      },
    ],
    available,
  });
  expect(view.processes[0]).toMatchObject({
    id: 'prc_theirs',
    name: 'Process',
    state: 'running',
    port: 8080,
    last_line: null,
  });
});

test('a preview is offered only for a running server that the person reading started', () => {
  const row = (
    id: string,
    state: 'running' | 'exited',
    port: number | null,
    previewable?: boolean,
  ) => ({
    id,
    name: id,
    state,
    started_at: at(1),
    created_at: at(1),
    port,
    last_line: null,
    ...(previewable === undefined ? {} : { previewable }),
  });
  const view = projectComputer({
    rows: [],
    bindings: [],
    processes: [
      row('prc_mine', 'running', 5173, true),
      row('prc_theirs', 'running', 5174, false),
      row('prc_unknown', 'running', 5175),
      row('prc_noport', 'running', null, true),
      row('prc_ended', 'exited', 5176, true),
    ],
    available,
  });
  expect(Object.fromEntries(view.processes.map((each) => [each.id, each.can_preview]))).toEqual({
    prc_mine: true,
    prc_theirs: false,
    prc_unknown: false,
    prc_noport: false,
    prc_ended: false,
  });
});
