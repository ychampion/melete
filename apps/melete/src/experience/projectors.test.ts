import { expect, test } from 'bun:test';
import { APPROVAL_OUTDATED_NOTE, PERMISSION_FILE_PREVIEW_CHARS } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { browserManifest } from '../connectors/browser.ts';
import { COMPUTER_TOOLS } from '../connectors/sandbox-computer.ts';
import { DEVICE_TOOL_SHAPES } from '../devices/connector.ts';
import { AGENT_TEMPLATES, agentIdentity } from './agents.ts';
import { forLine } from './permissions.ts';
import {
  type ActionRow,
  answerText,
  BACKEND_VOCABULARY,
  plainText,
  projectActionGroup,
  projectArtifact,
  projectCards,
  projectPermission,
  projectPermissionDecision,
  projectQuestionDecision,
  STOPPED_NOTE,
  SUPERSEDED_NOTE,
  safeUrl,
  senderAddress,
  tooLongToAsk,
} from './projectors.ts';

const base: ActionRow = {
  id: 'one',
  jobId: 'chat',
  attemptId: 'attempt',
  connectionId: 'calendar-connection',
  kind: 'calendar.list',
  effectClass: 'read',
  canonicalPayload: {},
  receipt: {
    detail: {
      events: [{ summary: 'Dinner', start: '2026-09-12T19:00:00Z', end: '2026-09-12T20:00:00Z' }],
    },
  },
  status: 'succeeded',
  createdAt: new Date(),
  resolvedAt: new Date(),
};
test('three calls across two connections produce one compound action with attributable sources', () => {
  const calendar = { id: 'calendar-connection', label: 'My calendar', provider: 'caldav' };
  const mail = { id: 'mail-connection', label: 'My mail', provider: 'imap' };
  const rows = [
    { action: base, connection: calendar },
    {
      action: {
        ...base,
        id: 'two',
        kind: 'email.search',
        connectionId: mail.id,
        receipt: { detail: { messages: [{ subject: 'Dinner invite' }] } },
      },
      connection: mail,
    },
    {
      action: {
        ...base,
        id: 'three',
        kind: 'email.read',
        connectionId: mail.id,
        receipt: { detail: { message: { subject: 'Menu' } } },
      },
      connection: mail,
    },
  ];
  const group = projectActionGroup(rows);
  expect(group?.label).toBe('Checked your calendar, Checked your mail, Read a message');
  expect(group?.sources.map((source) => source.connection_id)).toEqual([
    calendar.id,
    mail.id,
    mail.id,
  ]);
  expect(JSON.stringify(group)).not.toMatch(BACKEND_VOCABULARY);
  expect(projectCards(base, calendar)[0]?.facts).toHaveLength(2);
});
test('source content cannot smuggle backend labels or credential URLs', () => {
  expect(plainText('{"canonical_payload": {"to": "a@b.c"}}', 'Event')).toBe('Event');
  expect(plainText('Lunch, key sk-proj-Q7vLm2Xr9TbW4kZp8NcY3dHs', 'Event')).toBe(
    'Lunch, key [hidden]',
  );
  expect(safeUrl('https://user:password@example.com')).toBeUndefined();
  expect(safeUrl('javascript:alert(1)')).toBeUndefined();
  expect(safeUrl('https://example.com/menu?token=private')).toBe('https://example.com/menu');
});
test('agent identity includes personalization and stays within the existing 250-token counter', () => {
  for (const template of AGENT_TEMPLATES.templates) {
    const text = agentIdentity(template.agent);
    expect(text).toContain(template.agent.name);
    expect(text).toContain(template.agent.tone);
    expect(text).toContain(template.agent.standing_instruction);
    expect(estimateTokens(text)).toBeLessThanOrEqual(250);
  }
});

test('the mailbox a message would leave from is read off the connection, or left out', () => {
  expect(senderAddress({ kind: 'mail', mail: { from: 'jo@example.test' } })).toBe(
    'jo@example.test',
  );
  expect(senderAddress({ from: ' jo@example.test ' })).toBe('jo@example.test');
  // An operator-configured mailbox keeps its address in the environment.
  for (const unknown of [{}, null, undefined, { kind: 'mail', mail: {} }, { from: '   ' }])
    expect(senderAddress(unknown)).toBeNull();
  // Anything that would not survive being shown verbatim is left out instead.
  expect(senderAddress({ from: 'Bearer sk-abcdefghijkl' })).toBeNull();
  expect(senderAddress({ from: { address: 'jo@example.test' } })).toBeNull();
});

test('a permission to send shows the mailbox it leaves from above the recipient', () => {
  const send: ActionRow = {
    ...base,
    kind: 'email.send',
    effectClass: 'write_external',
    connectionId: 'mail-connection',
    canonicalPayload: { to: 'support@acme.test', subject: 'Refund', body: 'Please refund me.' },
    receipt: null,
    status: 'needs_approval',
  };
  const mailbox = { id: 'mail-connection', label: 'Mail', provider: 'imap' };
  const shown = projectPermission({
    id: 'apr_one',
    version: 'v1',
    action: send,
    connection: { ...mailbox, sender: 'jo@example.test' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: true,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  // The queue is oldest first, so the card says when it was asked.
  expect(shown.created_at).toBe('2026-09-24T08:00:00.000Z');
  expect(shown.preview?.facts.slice(0, 2)).toEqual([
    { label: 'From', value: 'jo@example.test' },
    { label: 'To', value: 'support@acme.test' },
  ]);
  // Without a known mailbox the card is exactly what it was before.
  const withoutSender = projectPermission({
    id: 'apr_one',
    version: 'v1',
    action: send,
    connection: mailbox,
    reasons: ['This change needs your permission before it happens.'],
    canAlways: true,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  expect(withoutSender.preview?.facts.map((fact) => fact.label)).toEqual([
    'To',
    'Subject',
    'Message',
  ]);
  expect(JSON.stringify(shown)).not.toMatch(BACKEND_VOCABULARY);
});

test("a permission to run a command in the agent's computer shows the command and where it runs", () => {
  const command: ActionRow = {
    ...base,
    kind: 'terminal.run',
    effectClass: 'write_reversible',
    connectionId: 'sandbox-connection',
    canonicalPayload: { command: 'date -u', cwd: 'reports' },
    receipt: null,
    status: 'needs_approval',
  };
  const computer = { id: 'sandbox-connection', label: 'Computer', provider: 'sandbox' };
  const shown = projectPermission({
    id: 'apr_cmd',
    version: 'v1',
    action: command,
    connection: computer,
    reasons: ['This change needs your permission before it happens.'],
    canAlways: true,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  // Asked for in the present tense, before anything has run.
  expect(shown.what).toBe("Run a command on the agent's computer");
  expect(shown.preview?.title).toBe("Run a command on the agent's computer");
  expect(shown.preview?.facts).toEqual([
    { label: 'Command', value: 'date -u' },
    { label: 'Runs in', value: '/work/reports' },
    { label: 'Computer', value: "The agent's own computer, not yours" },
  ]);
  // A long command says it was cut, and anything invisible in it is written out.
  const long = projectPermission({
    id: 'apr_long',
    version: 'v1',
    action: { ...command, canonicalPayload: { command: `echo ‮${'x'.repeat(5000)}` } },
    connection: computer,
    reasons: ['This change needs your permission before it happens.'],
    canAlways: false,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  const facts = long.preview?.facts ?? [];
  expect(facts[0]?.value.startsWith('echo <U+202E>x')).toBe(true);
  expect(facts.find((fact) => fact.label === 'Length')?.value).toContain('5013 characters');
  expect(facts.find((fact) => fact.label === 'Runs in')?.value).toBe('/work');
});

test('a sandbox command longer than its card shows is refused, not asked for in part', () => {
  expect(tooLongToAsk('terminal.run', { command: 'date -u' })).toBeNull();
  expect(tooLongToAsk('terminal.run', { command: 'x'.repeat(3000) })).toBeNull();
  expect(tooLongToAsk('terminal.run', { command: 'x'.repeat(3001) })).toContain('Nothing ran');
  // Measured as shown: invisible characters are written out on the card.
  expect(tooLongToAsk('terminal.run', { command: `echo ${'\u200b'.repeat(400)}` })).toContain(
    'Nothing ran',
  );
  expect(tooLongToAsk('exec.python', { intent: { code: 'print(1)\n'.repeat(400) } })).toContain(
    'code',
  );
  expect(tooLongToAsk('exec.run', { intent: { command: 'ls' } })).toBeNull();
  // Other actions are shown their own way.
  expect(tooLongToAsk('device.run', { command: 'x'.repeat(5000) })).toBeNull();
  // A card is always a valid card, however much of a command is invisible.
  const shown = projectPermission({
    id: 'apr_hidden',
    version: 'v1',
    action: {
      ...base,
      kind: 'terminal.run',
      effectClass: 'write_reversible',
      connectionId: 'sandbox-connection',
      canonicalPayload: { command: `echo ${'\u0007'.repeat(2000)}` },
      receipt: null,
      status: 'needs_approval',
    },
    connection: { id: 'sandbox-connection', label: 'Computer', provider: 'sandbox' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: false,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  expect(shown.preview?.facts.find((fact) => fact.label === 'Length')).toBeDefined();
});

test('a decided permission says which of the three choices was taken', () => {
  const at = new Date('2026-09-24T09:00:00.000Z');
  const decided = (decision: string, ruleSaved: boolean) =>
    projectPermissionDecision({ approvalId: 'apr_one', decision, ruleSaved, at });
  expect(decided('approved', false)).toEqual({
    kind: 'permission',
    id: 'apr_one',
    outcome: 'allow_once',
    answer: null,
    decided_at: '2026-09-24T09:00:00.000Z',
  });
  expect(decided('approved', true).outcome).toBe('always');
  expect(decided('denied', false).outcome).toBe('deny');
});

test('a closed question is answered with the chosen text, or withdrawn with none', () => {
  const at = new Date('2026-09-24T09:00:00.000Z');
  expect(
    projectQuestionDecision({ questionId: 'q_one', state: 'answered', answer: 'Cook at home', at }),
  ).toEqual({
    kind: 'question',
    id: 'q_one',
    outcome: 'answered',
    answer: 'Cook at home',
    decided_at: '2026-09-24T09:00:00.000Z',
  });
  const withdrawn = projectQuestionDecision({
    questionId: 'q_one',
    state: 'withdrawn',
    answer: 'ignored',
    at,
  });
  expect([withdrawn.outcome, withdrawn.answer]).toEqual(['withdrawn', null]);
});

test('a permission a later message made stale reads as replaced, not as a refusal', () => {
  expect(
    projectPermissionDecision({
      approvalId: 'apr_one',
      decision: 'denied',
      ruleSaved: false,
      note: SUPERSEDED_NOTE,
      at: new Date('2026-09-25T09:00:00.000Z'),
    }).outcome,
  ).toBe('replaced');
});

test('a permission a stop withdrew reads as withdrawn, not as a refusal', () => {
  expect(
    projectPermissionDecision({
      approvalId: 'apr_one',
      decision: 'denied',
      ruleSaved: false,
      note: STOPPED_NOTE,
      at: new Date('2026-09-25T09:00:00.000Z'),
    }).outcome,
  ).toBe('withdrawn');
});

test('a permission withdrawn because what it relied on changed says so, not that anyone stopped', () => {
  expect(
    projectPermissionDecision({
      approvalId: 'apr_one',
      decision: 'denied',
      ruleSaved: false,
      note: APPROVAL_OUTDATED_NOTE,
      at: new Date('2026-09-25T09:00:00.000Z'),
    }).outcome,
  ).toBe('outdated');
});

test('a draft card offers sending only while its draft can still be sent', () => {
  const mail = { id: 'mail-connection', label: 'My mail', provider: 'imap' };
  const draft: ActionRow = {
    ...base,
    id: 'act_draft',
    connectionId: mail.id,
    kind: 'email.draft',
    effectClass: 'write_reversible',
    canonicalPayload: { to: 'alex@example.test', subject: 'Dinner', body: 'At seven?' },
    receipt: { detail: {} },
  };
  const action = (status?: Parameters<typeof projectCards>[2]) =>
    projectCards(draft, mail, status)[0]?.primary_action ?? null;
  const send = { kind: 'send' as const, label: 'Review and send', handle: 'act_draft' };
  expect(action('draft')).toEqual(send);
  // A send the person refused leaves the draft theirs to send again.
  expect(action('denied')).toEqual(send);
  for (const status of ['awaiting_permission', 'sent', 'discarded', undefined] as const)
    expect(action(status)).toBeNull();
  // A draft that cannot be shown in full cannot be reviewed, so it is never offered.
  const hidden = {
    ...draft,
    canonicalPayload: { to: 'alex@example.test', body: 'x'.repeat(200_001) },
  };
  expect(projectCards(hidden, mail, 'draft')[0]?.primary_action ?? null).toBeNull();
  // Other actions keep their own primary action.
  expect(projectCards(base, mail, 'draft')[0]?.primary_action ?? null).toBeNull();
});

test('a click names the page and element from the read, with anything hidden written out', () => {
  const click: ActionRow = {
    ...base,
    kind: 'device.browser_click',
    effectClass: 'write_external',
    connectionId: 'device-connection',
    canonicalPayload: {
      tab_id: 41,
      ref: 'e3',
      expect: {
        url: 'https://bank.example/settings',
        title: `Settings${String.fromCodePoint(0x202e)}`,
        element: {
          role: 'button',
          name: 'Save',
          tag: 'button',
          shows: 'Delete account',
          target: 'https://bank.example/close',
        },
      },
    },
    receipt: null,
    status: 'needs_approval',
  };
  const shown = projectPermission({
    id: 'apr_click',
    version: 'v1',
    action: click,
    connection: { id: 'device-connection', label: 'Test laptop', provider: 'device' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: false,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  expect(shown.what).toBe('Click in your browser');
  expect(shown.preview?.facts).toEqual([
    { label: 'Page', value: 'https://bank.example/settings' },
    { label: 'Title', value: 'Settings<U+202E>' },
    {
      label: 'Element',
      value: 'button "Save", showing "Delete account", going to https://bank.example/close',
    },
  ]);
});

test('a permission for a connected computer writes out what would not show', () => {
  const run: ActionRow = {
    ...base,
    kind: 'device.run',
    effectClass: 'write_external',
    connectionId: 'device-connection',
    // A right-to-left override and a zero-width space would make this read differently.
    canonicalPayload: {
      command: `echo safe ${String.fromCodePoint(0x202e)}hs.lave${String.fromCodePoint(0x200b)}`,
    },
    receipt: null,
    status: 'needs_approval',
  };
  const permission = (action: ActionRow) =>
    projectPermission({
      id: 'apr_device',
      version: 'v1',
      action,
      connection: { id: 'device-connection', label: 'Test laptop', provider: 'device' },
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date('2026-09-24T08:00:00.000Z'),
    });
  expect(permission(run).preview?.facts).toEqual([
    { label: 'Command', value: 'echo safe <U+202E>hs.lave<U+200B>' },
  ]);
  const open: ActionRow = {
    ...run,
    kind: 'device.open_url',
    effectClass: 'write_reversible',
    canonicalPayload: { url: 'http://192.168.1.1/admin' },
  };
  expect(permission(open).preview?.facts).toEqual([
    { label: 'Page', value: 'http://192.168.1.1/admin' },
    { label: 'Network', value: 'This page is on your computer or your local network' },
  ]);
});

test('a permission for a connected computer shows the exact command and where it runs', () => {
  const run: ActionRow = {
    ...base,
    kind: 'device.run',
    effectClass: 'write_external',
    connectionId: 'device-connection',
    canonicalPayload: { command: 'echo hello', cwd: 'Projects', timeout_ms: 30000 },
    receipt: null,
    status: 'needs_approval',
  };
  const shown = projectPermission({
    id: 'apr_device',
    version: 'v1',
    action: run,
    connection: { id: 'device-connection', label: 'Test laptop', provider: 'device' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: true,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  // Asked before it runs, never phrased as already done.
  expect(shown.what).toBe('Run a command on your computer');
  expect(shown.preview?.facts).toEqual([
    { label: 'Command', value: 'echo hello' },
    { label: 'Runs in', value: 'Projects' },
  ]);
});

test('answer text keeps prose that starts with a bracket and drops whole records', () => {
  expect(answerText('\n\n[')).toBe('\n\n[');
  expect(answerText('[your name]\n\nSay the word')).toBe('[your name]\n\nSay the word');
  expect(answerText('[the guide](https://example.com)')).toBe('[the guide](https://example.com)');
  expect(answerText('{"tool":"email.send","to":"a@b.c"}')).toBe('');
  // Plain data is something the agent said.
  expect(answerText(' [1, 2, 3] ')).toBe(' [1, 2, 3] ');
});

test('answer text keeps addresses, sites and file names that share a word with a tool', () => {
  const answers = [
    'The draft to someone@email.com is ready. Send it from the draft card when it reads right.',
    'Maya’s new address is maya@files.com, and the old one at web.de still forwards for a month.',
    'I saved the notes as test.txt. The guide on web.dev covers the rest.',
    'Their support team answers at help@calendar.org within a day.',
    'DeepSeek publishes its pricing on deepseek.com, and the team writes from hi@claude-fans.org.',
    'Reply to billing@email.read.example.com if the invoice is wrong.',
  ];
  for (const answer of answers) {
    expect(answerText(answer)).toBe(answer);
    expect(plainText(answer, 'fallback')).toBe(answer);
  }
});

test('answer text keeps tool names and model ids, and hides only a credential', () => {
  for (const said of [
    "I'm Nova. Running on `accounts/fireworks/models/deepseek-v4p1-flash`.",
    'I called email.draft with the text below.',
    'Next I will run web.fetch(https://example.com).',
    'Saved through files.write.',
    'The payload_hash for this action is 9f2c.',
    'Running on gpt-4o today.',
  ]) {
    expect(answerText(said)).toBe(said);
    expect(plainText(said, 'fallback')).toBe(said);
  }
  expect(answerText('Authorization: Bearer abcdefghijklmnop')).toBe(
    'Authorization: Bearer [hidden]',
  );
  expect(plainText('Bearer abcdefghijklmnop', 'Event')).toBe('Bearer [hidden]');
  expect(plainText('{"tool_call": {"name": "email.send"}}', 'Event')).toBe('Event');
  expect(safeUrl('https://example.com/?access_token=private')).toBeUndefined();
});

test('a permission to save a file names the file and carries its exact text', () => {
  const content = '# Email and admin\n\n| When | What |\n|---|---|\n| 4pm | Replies, café |\n';
  const write: ActionRow = {
    ...base,
    kind: 'files.write',
    effectClass: 'write_reversible',
    connectionId: 'files-connection',
    canonicalPayload: { path: 'plans/email-and-admin.md', content },
    receipt: null,
    status: 'needs_approval',
  };
  const files = { id: 'files-connection', label: 'Files', provider: 'files' };
  const permission = (payload: Record<string, unknown>) =>
    projectPermission({
      id: 'apr_file',
      version: 'v1',
      action: { ...write, canonicalPayload: payload },
      connection: files,
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date('2026-09-30T04:00:00.000Z'),
    });
  const shown = permission({ path: 'plans/email-and-admin.md', content });
  // Present tense and the path, not "Saved a file".
  expect(shown.what).toBe('Save plans/email-and-admin.md');
  // Into the person's own Files, the card says so; so does a move in or out of them.
  expect(permission({ path: 'imgtest.png', area: 'artifacts', content }).what).toBe(
    'Save imgtest.png to your Files',
  );
  const move = (payload: Record<string, unknown>) =>
    projectPermission({
      id: 'apr_move',
      version: 'v1',
      action: { ...write, kind: 'files.move', canonicalPayload: payload },
      connection: files,
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date('2026-09-30T04:00:00.000Z'),
    }).what;
  expect(move({ from: 'shots/a.png', to: 'a.png', to_area: 'artifacts' })).toBe(
    'Move “a.png” into your Files',
  );
  expect(move({ from: 'a.png', to: 'a.png', area: 'artifacts', to_area: 'work' })).toBe(
    'Move “a.png” out of your Files',
  );
  // A delete names the folder, lists what is in it with a count of the rest,
  // says why it asks, and that it can be restored.
  const deleting = projectPermission({
    id: 'apr_delete',
    version: 'v1',
    action: {
      ...write,
      kind: 'files.delete',
      canonicalPayload: {
        path: 'reports',
        area: 'artifacts',
        checked: {
          owner: 'person',
          what: 'folder',
          files: 42,
          bytes: 2048,
          names: ['q1.pdf', 'q2.pdf'],
          reason: "It is in the person's Files.",
          warning: 'This deletes the folder “reports” from your Files, with its 42 files.',
        },
      },
    },
    connection: files,
    reasons: ['This change needs your permission before it happens.'],
    canAlways: false,
    requestedAt: new Date('2026-09-30T04:00:00.000Z'),
  });
  expect(deleting.what).toBe('Delete the folder “reports” from your Files');
  expect(deleting.preview?.facts).toEqual(
    expect.arrayContaining([
      { label: 'Folder', value: 'reports' },
      { label: 'Files in it', value: '42' },
      { label: 'Inside', value: 'q1.pdf, q2.pdf, and 40 more' },
      { label: 'Why you are asked', value: "It is in the person's Files." },
      {
        label: 'Warning',
        value: 'This deletes the folder “reports” from your Files, with its 42 files.',
      },
    ]),
  );
  expect(shown.file).toEqual({
    path: 'plans/email-and-admin.md',
    bytes: Buffer.byteLength(content, 'utf8'),
    content,
    truncated: false,
  });
  expect(shown.preview?.facts).toEqual([
    { label: 'File', value: 'plans/email-and-admin.md' },
    { label: 'Size', value: `${Buffer.byteLength(content, 'utf8')} bytes` },
  ]);
  // Ordinary names that look like tool names are still shown as they are.
  expect(permission({ path: 'test.txt', content: 'x' }).file?.path).toBe('test.txt');
  // Control characters are taken out; line breaks and tabs stay.
  expect(permission({ path: 'a.txt', content: 'one\u0007\ttwo\nthree' }).file?.content).toBe(
    'one\ttwo\nthree',
  );
  // Past the preview limit the text is cut and says so.
  const long = 'a'.repeat(PERMISSION_FILE_PREVIEW_CHARS + 10);
  const cut = permission({ path: 'long.txt', content: long }).file;
  expect(cut?.content.length).toBe(PERMISSION_FILE_PREVIEW_CHARS);
  expect(cut?.truncated).toBe(true);
  expect(cut?.bytes).toBe(long.length);
  // Never half of a character at the cut.
  const pairs = `${'a'.repeat(PERMISSION_FILE_PREVIEW_CHARS - 1)}\u{1F600}tail`;
  expect(permission({ path: 'emoji.txt', content: pairs }).file?.content).toBe(
    'a'.repeat(PERMISSION_FILE_PREVIEW_CHARS - 1),
  );
  // A write with no text to show carries no file.
  expect(permission({ path: 'x.txt' }).file).toBeUndefined();
});

test('a saved file card opens text in the app and offers anything else as a download', () => {
  const row = (path: string, mime: string) =>
    ({ id: 'art_01ABC', path, mime, size: 12 }) as Parameters<typeof projectArtifact>[0];
  expect(projectArtifact(row('plans/week.md', 'text/markdown')).primary_action).toEqual({
    kind: 'open',
    label: 'Open',
    handle: 'art_01ABC',
  });
  expect(projectArtifact(row('data.json', 'application/json')).primary_action?.kind).toBe('open');
  expect(projectArtifact(row('report.pdf', 'application/pdf')).primary_action).toEqual({
    kind: 'download',
    label: 'Download',
    handle: 'art_01ABC',
  });
});

test('every step in a browser or on a computer is asked for by name, with its target', () => {
  const kinds = [
    ...COMPUTER_TOOLS.map((tool) => tool.name),
    ...browserManifest.tools.map((tool) => tool.name),
    ...Object.keys(DEVICE_TOOL_SHAPES).map((tool) => `device.${tool}`),
  ];
  const payload = {
    step: 1,
    url: 'https://ftE-round3-nowhere.invalid/form',
    path: 'notes/plan.md',
    command: 'ls -la',
    text: 'hello there',
    keys: ['ctrl+l'],
    x: 10,
    y: 20,
    amount: 3,
    name: 'Send',
    label: 'Email',
    value: 'jo@example.test',
    intent: {
      url: 'https://shop.example.test/checkout',
      method: 'POST',
      role: 'button',
      name: 'Place order',
      fields: { Email: 'jo@example.test' },
    },
  };
  for (const kind of kinds) {
    const shown = projectPermission({
      id: 'apr_step',
      version: 'v1',
      action: {
        ...base,
        kind,
        effectClass: 'write_reversible',
        connectionId: 'x',
        canonicalPayload: payload,
        receipt: null,
        status: 'needs_approval',
      },
      connection: { id: 'x', label: 'Computer', provider: 'sandbox' },
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date('2026-10-02T08:00:00.000Z'),
    });
    expect(shown.what).not.toBe('Completed a step');
    expect(shown.what).not.toMatch(/^Used /);
    // Asked in the present tense, before anything has happened.
    expect(shown.what).not.toMatch(/^(Opened|Clicked|Typed|Pressed|Looked|Submitted|Used) /);
    const facts = JSON.stringify(shown.preview?.facts ?? []);
    if (/open|open_url/.test(kind)) {
      expect(shown.what).toContain('ftE-round3-nowhere.invalid'.toLowerCase());
      expect(facts).toContain('https://ftE-round3-nowhere.invalid/form');
    }
    if (kind === 'browser.submit') {
      expect(shown.what).toBe('Submit “Place order” to shop.example.test');
      expect(facts).toContain('https://shop.example.test/checkout');
    }
    if (kind === 'computer.type') expect(facts).toContain('hello there');
    if (kind === 'computer.key') expect(shown.what).toBe("Press ctrl+l on the agent's computer");
  }
});

test('a form submit card shows every value a repeated field name sends, each on its own line', () => {
  const padded = 'x'.repeat(3200);
  const shown = projectPermission({
    id: 'apr_group',
    version: 'v1',
    action: {
      ...base,
      kind: 'browser.submit',
      effectClass: 'write_external',
      connectionId: 'x',
      canonicalPayload: {
        intent: {
          url: 'https://shop.example.test/order',
          method: 'POST',
          role: 'button',
          name: 'Submit order',
          fields: { topping: [padded, 'deliver-to-attacker'], note: ['a, b'] },
        },
      },
      receipt: null,
      status: 'needs_approval',
    },
    connection: { id: 'x', label: 'Browser', provider: 'browser' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: false,
    requestedAt: new Date('2026-10-02T08:00:00.000Z'),
  });
  const facts = shown.preview?.facts ?? [];
  expect(facts.filter((fact) => fact.label === 'topping').map((fact) => fact.value)).toEqual([
    `${padded.slice(0, 3000)}…`,
    'deliver-to-attacker',
  ]);
  expect(facts.filter((fact) => fact.label === 'note').map((fact) => fact.value)).toEqual(['a, b']);
});

test('the line naming the request ends with one stop, never two', () => {
  expect(forLine('Plan the trip')).toBe('For Plan the trip.');
  expect(forLine('[ftE] impossible / open…')).toBe('For [ftE] impossible / open…');
  expect(forLine('Is it done?')).toBe('For Is it done?');
});

test('a permission to publish an app names it, its size, who can open it and the data it shows', () => {
  const publish: ActionRow = {
    ...base,
    kind: 'apps.publish',
    effectClass: 'write_external',
    connectionId: 'apps-connection',
    canonicalPayload: {
      dir: 'app',
      name: 'Deals',
      create: true,
      file_count: 14,
      total_bytes: 225_280,
      audience: { kind: 'people', emails: ['bo@example.test'], principal_ids: ['own_bo'] },
      data: { deals: { kind: 'artifact', path: 'data/deals.json', source_job_id: 'chat' } },
      data_shown: ['deals: data/deals.json from this conversation, newest version each time'],
      manifest_hash: 'a'.repeat(64),
    },
    receipt: null,
    status: 'needs_approval',
  };
  const apps = { id: 'apps-connection', label: 'Apps', provider: 'apps' };
  const ask = (payload: Record<string, unknown>) =>
    projectPermission({
      id: 'apr_app',
      version: 'v1',
      action: {
        ...publish,
        canonicalPayload: { ...(publish.canonicalPayload as object), ...payload },
      },
      connection: apps,
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date('2026-09-24T08:00:00.000Z'),
    });
  const shown = ask({});
  expect(shown.what).toBe('Publish Deals');
  expect(shown.preview?.facts).toEqual([
    { label: 'App', value: 'Deals' },
    { label: 'Files', value: '14 files, 220 KB' },
    { label: 'Viewers', value: 'You and bo@example.test' },
    {
      label: 'Data it shows',
      value:
        'deals: data/deals.json from this conversation, newest version each time. Viewers see each new version automatically.',
    },
  ]);
  // Code that opens WebRTC connections is a warning on the card, never a refusal.
  expect(ask({ opens_connections: ['call.js'] }).preview?.facts.at(-1)).toEqual({
    label: 'Warning',
    value:
      'Its code can open direct connections to other servers (WebRTC, in call.js), which can send what the app shows, or what a viewer types into it, anywhere. Publish it only if you trust that code with that data.',
  });
  // Why it came to the person rather than going ahead on its own leads the card.
  expect(
    ask({
      risks: [
        'New people could open it: bo@example.test.',
        'Its code can open direct connections to other servers (WebRTC).',
      ],
    }).preview?.facts[0],
  ).toEqual({
    label: 'Why you are asked',
    value:
      'New people could open it: bo@example.test. Its code can open direct connections to other servers (WebRTC).',
  });
  expect(ask({ risks: [] }).preview?.facts).toEqual(shown.preview?.facts);
  // A new version names the app it replaces as it is called now, whatever name
  // the request gives, and a new name is a fact of its own on the card.
  const again = ask({
    create: false,
    app_id: 'app_PAYROLL',
    current_name: 'Payroll',
    audience: { kind: 'unchanged', now: 'only you' },
  });
  expect(again.what).toBe('Publish a new version of Payroll');
  expect(again.preview?.facts.slice(0, 2)).toEqual([
    { label: 'App', value: 'Payroll' },
    { label: 'Renames it to', value: 'Deals' },
  ]);
  expect(again.preview?.facts.find((fact) => fact.label === 'Viewers')?.value).toBe(
    'Unchanged: only you',
  );
  const sameName = ask({ create: false, current_name: 'Deals' });
  expect(sameName.preview?.facts.map((fact) => fact.label)).not.toContain('Renames it to');
  expect(
    ask({ audience: { kind: 'everyone' } }).preview?.facts.find((fact) => fact.label === 'Viewers')
      ?.value,
  ).toBe('Everyone with an account here');
  // Who keeps access whatever the audience says is named, never hidden behind "Only you".
  const viewersOf = (audience: Record<string, unknown>) =>
    ask({ audience }).preview?.facts.find((fact) => fact.label === 'Viewers')?.value;
  expect(viewersOf({ kind: 'only_me' })).toBe('Only you');
  expect(viewersOf({ kind: 'only_me', also: 'alice@example.test' })).toBe(
    'You and alice@example.test',
  );
  expect(
    viewersOf({
      kind: 'people',
      emails: ['bo@example.test'],
      principal_ids: ['own_bo'],
      also: 'alice@example.test',
    }),
  ).toBe('You and bo@example.test, alice@example.test');
  expect(JSON.stringify(shown)).not.toMatch(BACKEND_VOCABULARY);
});

test("a permission to change the version of an app shows that version's data and who will see it", () => {
  const rollback: ActionRow = {
    ...base,
    kind: 'apps.rollback',
    effectClass: 'write_external',
    connectionId: 'apps-connection',
    canonicalPayload: {
      app_id: 'app_DEALS',
      version_id: 'b'.repeat(64),
      name: 'Deals',
      version_published_at: '2026-09-20T07:02:00.000Z',
      viewers_now: 'everyone with an account here',
      data_shown: ['salaries: data/salaries.json from this conversation, newest version each time'],
      collections_shown: ['feedback'],
    },
    receipt: null,
    status: 'needs_approval',
  };
  const shown = projectPermission({
    id: 'apr_back',
    version: 'v1',
    action: rollback,
    connection: { id: 'apps-connection', label: 'Apps', provider: 'apps' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: false,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  expect(shown.what).toBe('Change which version of Deals people see');
  expect(shown.preview?.facts).toEqual([
    { label: 'App', value: 'Deals' },
    { label: 'Version', value: 'The one published 2026-09-20T07:02:00.000Z' },
    { label: 'Viewers', value: 'Everyone with an account here' },
    {
      label: 'Data it shows',
      value:
        'salaries: data/salaries.json from this conversation, newest version each time. Viewers see each new version automatically.',
    },
    { label: 'Responses it collects', value: 'feedback' },
  ]);
});
