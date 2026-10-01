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
