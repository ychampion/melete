/**
 * The activity a conversation shows above an answer: each tool entry's title
 * says what was done with what, its fuller input and output are scrubbed line
 * by line, and a failure says which way it went.
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_EXCERPT_LIMIT, TOOL_TITLE_LIMIT, type ToolCall } from '@melete/contracts';
import { type ActionRow, BACKEND_VOCABULARY } from './projectors.ts';
import {
  actionCall,
  HIDDEN_LINE,
  memoryCall,
  runtimeCall,
  runtimePhrase,
  toolExcerpt,
  traceCall,
} from './tools.ts';

const at = new Date('2026-10-01T10:00:00Z');
const later = new Date('2026-10-01T10:00:03Z');
const TOKEN = 'sk-live0123456789abcdef';
const row = (kind: string, extra: Partial<ActionRow> = {}): ActionRow => ({
  id: 'act_01J00000000000000000000000',
  jobId: 'job_01J00000000000000000000000',
  attemptId: 'att_01J00000000000000000000000',
  connectionId: 'conn_1',
  kind,
  effectClass: 'read',
  canonicalPayload: {},
  receipt: null,
  status: 'proposed',
  createdAt: at,
  resolvedAt: null,
  ...extra,
});
const conn = (label: string, provider: string) => ({ id: 'conn_1', label, provider });
const done = (
  kind: string,
  payload: Record<string, unknown>,
  detail: Record<string, unknown> = {},
) =>
  actionCall({
    action: row(kind, { canonicalPayload: payload, receipt: { detail }, status: 'succeeded' }),
    connection: conn('App', 'test'),
    raw: 'succeeded',
    at: later,
  });

function expectSafe(call: ToolCall) {
  const json = JSON.stringify(call);
  expect(json).not.toMatch(BACKEND_VOCABULARY);
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain('sealed-box');
  expect(call.title.length).toBeLessThanOrEqual(TOOL_TITLE_LIMIT);
  for (const excerpt of [call.input_excerpt, call.output_excerpt])
    if (excerpt) expect(excerpt.text.length).toBeLessThanOrEqual(TOOL_EXCERPT_LIMIT);
}

describe('titles say what was done with what', () => {
  test('every built-in family', () => {
    const cases: Array<[ToolCall, string]> = [
      [
        done('web.fetch', { url: 'https://www.example.com/guides/rent?x=1' }),
        'Read page example.com/guides/rent',
      ],
      [
        done('terminal.run', { command: 'python report.py\necho done' }, { exit_code: 0 }),
        'Ran `python report.py` in its computer',
      ],
      [done('exec.python', { code: 'print(1)' }), 'Ran Python code in its computer'],
      [
        done('files.write', { path: 'out/report.md', content: 'x'.repeat(2048) }, { bytes: 2048 }),
        'Wrote report.md (2 KB)',
      ],
      [done('files.read', { path: '/notes/plan.txt' }), 'Read plan.txt'],
      [
        done(
          'email.search',
          {},
          { messages: [{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }] },
        ),
        'Read 3 emails from your inbox',
      ],
      [
        done('email.search', { query: 'invoice' }, { messages: [] }),
        'Found no emails for “invoice”',
      ],
      [
        done('email.send', { to: ['sam@example.com', 'jo@example.com'] }),
        'Sent an email to sam@example.com and 1 more',
      ],
      [done('calendar.create', { summary: 'Dentist' }), 'Added “Dentist” to your calendar'],
      [done('calendar.list', {}, { events: [{}, {}] }), 'Checked your calendar: 2 events'],
      [
        done('computer.open', { url: 'https://example.org/' }),
        'Opened example.org in its computer',
      ],
      [done('computer.screenshot', {}), 'Took a screenshot of its computer'],
      [done('computer.type', { text: 'hunter2' }), 'Typed in its computer'],
      [done('computer.key', { keys: ['Control', 'L'] }), 'Pressed Control+L in its computer'],
      [done('device.run', { command: 'ls ~' }), 'Ran `ls ~` on your computer'],
      [done('device.read_file', { path: 'notes/todo.txt' }), 'Read todo.txt on your computer'],
      [done('artifact.publish', { path: 'report.pdf' }), 'Published report.pdf'],
    ];
    for (const [call, title] of cases) {
      expect(call.title).toBe(title);
      expectSafe(call);
    }
    expect(JSON.stringify(cases)).not.toContain('hunter2');
  });

  test('a tool from an installed server names the server, then the tool', () => {
    const call = actionCall({
      action: row('mcp_gh.create_issue'),
      connection: conn('GitHub', 'mcp'),
      raw: 'proposed',
      at,
    });
    expect(call.title).toBe('Using GitHub → create issue');
  });

  test('a send waiting for the person says so, and names who it goes to', () => {
    const call = actionCall({
      action: row('email.send', {
        effectClass: 'write_external',
        canonicalPayload: { to: 'sam@example.com', subject: 'Report', body: 'Hi Sam,\nattached.' },
      }),
      connection: conn('Mail', 'imap'),
      raw: 'needs_approval',
      at,
      approvalId: 'apr_1',
    });
    expect(call.title).toBe('Proposed sending an email to sam@example.com — waiting for you');
    // The body is the draft's and the permission card's to show, never the activity's.
    expect(JSON.stringify(call)).not.toContain('attached');
  });

  test('a value that fails the scrub leaves the plain verb', () => {
    const call = done('terminal.run', { command: `curl -H "Authorization: Bearer ${TOKEN}" x` });
    expect(call.title).toBe('Ran a command in its computer');
    expect(call.input_excerpt).toBeUndefined();
    expectSafe(call);
    const tokened = done('web.fetch', { url: 'https://example.com/reset/a1b2c3d4e5f6g7h8i9' });
    expect(tokened.title).toBe('Read page example.com');
  });

  test('runtime tools are named by what they were given', () => {
    expect(runtimePhrase('web_search', 'rent prices in Lisbon 2026')?.done).toBe(
      'Searched the web for “rent prices in Lisbon 2026”',
    );
    expect(runtimePhrase('web_extract', 'https://example.com/a')?.done).toBe(
      'Read page example.com/a',
    );
    expect(runtimePhrase('web_extract', 'https://a.test/x https://b.test/y')?.done).toBe(
      'Read 2 pages',
    );
    expect(runtimePhrase('write_file', '/tmp/out/report.md')?.done).toBe('Wrote report.md');
    expect(runtimePhrase('some_new_tool', '')?.done).toBe('Used the tool “some new tool”');
    expect(runtimePhrase('web_search', `key ${TOKEN}`)).toBeNull();
    const call = runtimeCall({
      attemptId: 'att_1',
      callId: 'c1',
      tool: 'web_search',
      arguments: { preview: 'best pizza' },
      proposedAt: at,
      result: { ok: false, at: later },
    });
    expect(call).toMatchObject({
      title: 'Searching the web for “best pizza”',
      status: 'failed',
      failure: 'error',
    });
  });
});

describe('failures say which way they went', () => {
  const send = row('email.send', { effectClass: 'write_external' });
  const call = (raw: string, refusal?: string) =>
    actionCall({ action: send, connection: conn('Mail', 'imap'), raw, at: later, refusal });
  test('declined, refused and errors', () => {
    expect(call('denied')).toMatchObject({
      failure: 'declined',
      output_summary: { text: 'You declined this.' },
    });
    expect(call('failed', 'scope_denied')).toMatchObject({
      failure: 'refused',
      output_summary: { text: 'A rule here does not allow this, so nothing was sent.' },
    });
    // An unknown code still reads plainly, and the broker's own words never show.
    expect(call('failed', 'something_new').output_summary?.text).toBe(
      'This was not allowed, so nothing was sent.',
    );
    expect(call('failed')).toMatchObject({ failure: 'error' });
    expect(call('succeeded').failure).toBeUndefined();
  });
  test('a memory change that failed is an error', () => {
    const failed = memoryCall({
      kind: 'memory_tool',
      op: 'write',
      id: 'write:k@1',
      status: 'failed',
      started_at: at.toISOString(),
      ended_at: later.toISOString(),
      count: 1,
      labels: ['Diet'],
      value: null,
      memory_item_id: null,
      parent: null,
    });
    expect(failed?.failure).toBe('error');
  });
});

describe('excerpts go through the answer filter, span by span', () => {
  test('a key is hidden where it stands, and the words around it are kept', () => {
    const excerpt = toolExcerpt(
      `export API_KEY=${TOKEN}\npython report.py\n\nsee https://user:pw@example.com/x?ref=1`,
      'request',
    );
    expect(excerpt?.text).toBe(`export API_KEY=${HIDDEN_LINE}\npython report.py\n\nsee a link`);
    expect(excerpt?.text).not.toContain(TOKEN);
    expect(excerpt?.more).toBe(false);
  });
  test('a tool name is ordinary text; a whole internal record is taken out', () => {
    expect(toolExcerpt('called email.send\nok', 'app')?.text).toBe('called email.send\nok');
    const excerpt = toolExcerpt(
      'before\n{"tool_call":{"name":"email.send","arguments":{"to":"x@example.com"}}}\nafter',
      'app',
    );
    expect(excerpt?.text).toContain('before');
    expect(excerpt?.text).toContain('after');
    expect(excerpt?.text).not.toContain('arguments');
  });
  test('nothing comes back when no line survives', () => {
    expect(toolExcerpt(`token=${TOKEN}`, 'app')).toBeUndefined();
    expect(toolExcerpt('   \n  ', 'app')).toBeUndefined();
    expect(toolExcerpt(42, 'app')).toBeUndefined();
  });
  test('long output is cut and says so', () => {
    const lines = toolExcerpt(Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), 'app');
    expect(lines?.more).toBe(true);
    expect(lines?.text.split('\n').length).toBe(40);
    const long = toolExcerpt('word '.repeat(1000), 'app');
    expect(long?.more).toBe(true);
    expect(long?.text.length).toBeLessThanOrEqual(TOOL_EXCERPT_LIMIT);
  });
  test('a command prints what it printed, scrubbed, unless the output is binary', () => {
    const run = done(
      'terminal.run',
      { command: 'python report.py' },
      { exit_code: 0, output: `Wrote report.md\nAPI token: ${TOKEN}` },
    );
    expect(run.output_excerpt).toEqual({
      text: `Wrote report.md\nAPI token: ${HIDDEN_LINE}`,
      from: 'app',
      more: false,
    });
    const binary = done(
      'terminal.run',
      { command: 'cat x.bin' },
      { output: 'abc', output_binary: true },
    );
    expect(binary.output_excerpt).toBeUndefined();
  });
  test('a trace writer cannot slip outside text through an excerpt', () => {
    const call = traceCall({
      id: 't1',
      kind: 'sandbox',
      title: 'Ran a script',
      status: 'done',
      started_at: at.toISOString(),
      ended_at: later.toISOString(),
      input_summary: null,
      output_summary: null,
      detail: null,
      parent: null,
      input_excerpt: { text: `ok\nBearer ${TOKEN}`, from: 'request', more: false },
      output_excerpt: { text: `sk-${'a'.repeat(30)}`, from: 'app', more: false },
    });
    expect(call?.input_excerpt?.text).toBe(`ok\nBearer ${HIDDEN_LINE}`);
    expect(JSON.stringify(call)).not.toContain(TOKEN);
    expect(call?.output_excerpt).toBeUndefined();
  });
});
