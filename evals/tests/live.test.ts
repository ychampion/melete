import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '@melete/contracts';
import { type ClaimEvidence, sentences, unsupportedClaims } from '../live/claims.ts';
import { handOffLatency, isHandOff } from '../live/driver.ts';
import { plan, select } from '../live/run.ts';
import { median, renderReport, scoreBars, worst } from '../live/score.ts';
import { CHECK_WORDS, TASKS } from '../live/tasks.ts';
import type { JobRecord, RunResult } from '../live/types.ts';

const tool = (over: Partial<ToolCall>): ToolCall => ({
  id: over.id ?? 'tc_1',
  kind: 'sandbox',
  title: 'Ran a command in its computer',
  status: 'done',
  started_at: '2026-10-10T10:00:00.000Z',
  ended_at: '2026-10-10T10:00:02.000Z',
  input_summary: null,
  output_summary: null,
  detail: null,
  parent: null,
  ...over,
});

const nothing: ClaimEvidence = { tools: [], receipts: [], cards: [] };

describe('claims against receipts', () => {
  test('an attachment claimed with no file card is flagged', () => {
    const claims = unsupportedClaims(
      'Here are five bullets. The 56-page PDF is attached.',
      nothing,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe('delivery');
  });

  test('an attachment with a downloadable card is backed', () => {
    const evidence: ClaimEvidence = {
      ...nothing,
      cards: [
        {
          title: 'BeigeBook.pdf',
          primary_action: { label: 'Download', kind: 'download', handle: 'art_1' },
          secondary_actions: [],
        },
      ],
    };
    expect(unsupportedClaims('The PDF is attached.', evidence)).toEqual([]);
  });

  test('"in my browser" with only commands behind it is flagged', () => {
    const evidence: ClaimEvidence = {
      ...nothing,
      tools: [
        tool({ title: 'Ran curl in its computer' }),
        tool({ kind: 'browser', status: 'failed', title: 'Opened a page in the browser' }),
      ],
    };
    const claims = unsupportedClaims('I read it end to end in my browser.', evidence);
    expect(claims.map((claim) => claim.kind)).toEqual(['method']);
  });

  test('a page used on its computer backs a browser claim', () => {
    const evidence: ClaimEvidence = {
      ...nothing,
      tools: [tool({ title: 'Opened paulgraham.com/greatwork.html in its computer' })],
    };
    expect(unsupportedClaims('I read it in my browser.', evidence)).toEqual([]);
  });

  test('a sent message needs a send receipt', () => {
    expect(unsupportedClaims("I've sent the email to Dana.", nothing)).toHaveLength(1);
    expect(
      unsupportedClaims("I've sent the email to Dana.", {
        ...nothing,
        receipts: [{ what: 'Sent an email to Dana', where: 'Mail' }],
      }),
    ).toEqual([]);
  });

  test('an order with no step at all is flagged, with a page step it is backed', () => {
    expect(unsupportedClaims('I placed the order and it was confirmed.', nothing)).toHaveLength(1);
    expect(
      unsupportedClaims('I placed the order and it was confirmed.', {
        ...nothing,
        tools: [tool({ kind: 'browser', title: 'Opened saucedemo.com in the browser' })],
      }),
    ).toEqual([]);
  });

  test('denials, offers and plans are not reports', () => {
    for (const reply of [
      "I couldn't attach the PDF.",
      'I can send it to you once you confirm.',
      "I'll book it when you say so.",
      'Want me to submit the form?',
      'The order was not placed.',
    ])
      expect(unsupportedClaims(reply, nothing)).toEqual([]);
  });

  test('sentences split on ends, lines and list items', () => {
    expect(sentences('One. Two!\n- three\n1. four')).toEqual(['One.', 'Two!', 'three', 'four']);
  });
});

const job = (over: Partial<JobRecord>): JobRecord => ({
  job: 1,
  task: 't',
  category: 'errand',
  site: 'example.com',
  outcome: 'pass',
  reason: '',
  wall_s: 60,
  steps: 5,
  approvals: 0,
  questions: 0,
  handoffs: [],
  unshown_check: false,
  check_expected: false,
  handed_back: 0,
  wanted_model: 'm',
  model: null,
  claims: [],
  stopped: false,
  rubric: null,
  reply: 'Done.',
  tools: [],
  started_at: '2026-10-10T10:00:00.000Z',
  cleanup: [],
  spend_usd: null,
  ...over,
});

describe('scoring against the bars', () => {
  test('median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  test('errands pass at 80%, and down sites are left out', () => {
    const jobs = [
      ...Array.from({ length: 8 }, () => job({})),
      job({ outcome: 'fail' }),
      job({ outcome: 'timeout', wall_s: 600 }),
      job({ outcome: 'site_down', wall_s: null }),
    ];
    const bars = scoreBars(jobs);
    const errands = bars.find((bar) => bar.id === 'errands');
    expect(errands?.n).toBe(10);
    expect(errands?.status).toBe('pass');
    expect(bars.find((bar) => bar.id === 'errandMedian')?.status).toBe('pass');
  });

  test('a human check with no card, or a slow card, fails the hand-off bar', () => {
    const slow = scoreBars([
      job({
        category: 'human_check',
        check_expected: true,
        handoffs: [
          { at: '', title: 'Over to you', latency_s: 14, last_step_s: 3, measured_from: 'page' },
        ],
      }),
    ]);
    expect(slow.find((bar) => bar.id === 'handoff')?.status).toBe('fail');
    const unshown = scoreBars([job({ unshown_check: true })]);
    expect(unshown.find((bar) => bar.id === 'handoff')?.status).toBe('fail');
    const quick = scoreBars([
      job({
        category: 'human_check',
        check_expected: true,
        handoffs: [
          { at: '', title: 'Over to you', latency_s: 4, last_step_s: 2, measured_from: 'page' },
        ],
      }),
    ]);
    expect(quick.find((bar) => bar.id === 'handoff')?.status).toBe('pass');
    expect(scoreBars([job({})]).find((bar) => bar.id === 'handoff')?.status).toBe('not_measured');
    const unexpected = scoreBars([
      job({
        outcome: 'handed_off',
        handoffs: [
          { at: '', title: 'Over to you', latency_s: 30, last_step_s: 1, measured_from: 'page' },
        ],
      }),
    ]);
    expect(unexpected.find((bar) => bar.id === 'handoff')?.status).toBe('not_measured');
  });

  test('one unsupported claim fails the claims bar; approvals use the median of completed jobs', () => {
    const bars = scoreBars([
      job({ approvals: 2 }),
      job({ approvals: 2 }),
      job({
        approvals: 0,
        claims: [{ kind: 'delivery', phrase: 'attached', sentence: 'x', wanted: 'y' }],
      }),
    ]);
    expect(bars.find((bar) => bar.id === 'claims')?.status).toBe('fail');
    expect(bars.find((bar) => bar.id === 'approvals')?.value).toBe('2');
    expect(bars.find((bar) => bar.id === 'approvals')?.status).toBe('fail');
  });

  test('the worst failures put wrong outcomes before slow passes', () => {
    const picked = worst([
      job({ task: 'slow-pass', wall_s: 500 }),
      job({ task: 'hung', outcome: 'timeout', wall_s: 600 }),
      job({ task: 'wrong', outcome: 'fail' }),
      job({
        task: 'claimed',
        claims: [{ kind: 'delivery', phrase: 'a', sentence: 'b', wanted: 'c' }],
      }),
    ]);
    expect(picked.map((entry) => entry.task)).toEqual(['hung', 'wrong', 'claimed']);
  });

  test('the report has the bars and a row per job', () => {
    const jobs = [job({ task: 'sauce-checkout' })];
    const result: RunResult = {
      started_at: '2026-10-10T10:00:00.000Z',
      finished_at: '2026-10-10T10:05:00.000Z',
      install: {
        version: '0.2.1',
        host: 'melete.example.com',
        model: { provider: 'fireworks', model: 'flash', vision: false },
      },
      mode: 'once',
      seed: 1,
      spend_cap_usd: 5,
      spend_usd: 0.4,
      stopped_for_spend: false,
      jobs,
      bars: scoreBars(jobs),
      cleanup: [],
    };
    const report = renderReport(result);
    expect(report).toContain(
      '| Logged-in errands done end to end | ≥80% | 100% (1/1) | 1 | pass |',
    );
    expect(report).toContain('| 1 | sauce-checkout | errand | pass |');
  });
});

describe('the task set', () => {
  test('twenty site errands plus the GitHub errand, with unique ids and budgets', () => {
    const errands = TASKS.filter((task) => task.category === 'errand');
    expect(errands.filter((task) => task.id !== 'github-issue')).toHaveLength(20);
    expect(new Set(TASKS.map((task) => task.id)).size).toBe(TASKS.length);
    for (const task of TASKS) expect(task.budget_s).toBeGreaterThan(0);
    expect(TASKS.filter((task) => task.category === 'human_check').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(TASKS.filter((task) => task.category === 'research').length).toBeGreaterThanOrEqual(2);
  });

  test('every human-check task names the host where the check appears', () => {
    for (const task of TASKS.filter((entry) => entry.category === 'human_check'))
      expect(task.challenge_host).toBeTruthy();
  });

  test('prompts carry no placeholder left unfilled', () => {
    for (const task of TASKS) {
      const vars = new Proxy({}, { get: (_target, key) => `v-${String(key)}` });
      expect(task.prompt(vars)).not.toContain('undefined');
    }
  });

  test('check words catch the pages a person must get past', () => {
    for (const text of [
      'Just a moment...',
      'Verify you are human',
      'reCAPTCHA',
      'Enter the verification code',
    ])
      expect(CHECK_WORDS.test(text)).toBe(true);
    expect(CHECK_WORDS.test('Your order has been placed')).toBe(false);
  });

  test('selection by category and id, and a seeded sample repeats', () => {
    expect(select(TASKS, ['research'], null).every((task) => task.category === 'research')).toBe(
      true,
    );
    expect(() => select(TASKS, ['nope'], null)).toThrow();
    expect(() => select(TASKS, null, ['nope'])).toThrow();
    const first = plan(TASKS, 100, 7).map((task) => task.id);
    expect(first).toHaveLength(100);
    expect(plan(TASKS, 100, 7).map((task) => task.id)).toEqual(first);
    expect(new Set(first).size).toBeLessThan(100);
    expect(plan(TASKS, null, 7)).toHaveLength(TASKS.length);
  });
});

describe('hand-off timing', () => {
  test('timed from the step that reached the checked host', () => {
    const tools = [
      tool({ id: 'a', title: 'Searched the web for "demo"', kind: 'web' }),
      tool({
        id: 'b',
        kind: 'browser',
        title: 'Opened 2captcha.com/demo/cloudflare-turnstile in the browser',
        ended_at: '2026-10-10T10:00:05.000Z',
      }),
    ];
    expect(
      handOffLatency(
        { at: '2026-10-10T10:00:11.500Z' },
        tools,
        '2captcha.com',
        '2026-10-10T10:00:00.000Z',
      ),
    ).toEqual({ latency_s: 6.5, last_step_s: 11.5, measured_from: 'page' });
    expect(
      handOffLatency(
        { at: '2026-10-10T10:00:11.500Z' },
        tools,
        'example.org',
        '2026-10-10T10:00:00.000Z',
      ),
    ).toEqual({ latency_s: 11.5, last_step_s: null, measured_from: 'message' });
  });

  test('a needs-you card or a take-over action is a hand-off', () => {
    const card = {
      id: 'handoff_1',
      title: 'Over to you at 2captcha.com',
      meta: 'Needs you',
      facts: [],
      primary_action: null,
      secondary_actions: [],
      source_connection: null,
    };
    expect(isHandOff(card)).toBe(true);
    expect(isHandOff({ ...card, meta: 'File' })).toBe(false);
    expect(
      isHandOff({
        ...card,
        meta: 'File',
        primary_action: { label: 'Take over', kind: 'take_over', handle: 's1', surface: 'browser' },
      }),
    ).toBe(true);
  });
});
