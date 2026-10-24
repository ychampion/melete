import { describe, expect, test } from 'bun:test';
import {
  actionWords,
  asksForIt,
  type Evidence,
  judge,
  reaches,
  sendsMail,
  WEIGHTS,
} from './proactive.ts';

const mail = actionWords('email.send', ['contact']);
const issue = actionWords('github.create_issue', []);
const bob = ['bob@example.com'];

describe('what counts as asking for it', () => {
  test.each([
    ['Every Friday, email Bob the weekly summary.', mail, bob],
    ['Reply to anything from my landlord.', mail, ['landlord@flat.example']],
    ['Send the notes to bob@example.com after each call.', mail, bob],
    ['Open an issue for every failing build.', issue, ['acme/site']],
    ['When Bob writes, reply right away.', mail, bob],
    ['You can always email Bob the weekly summary.', mail, bob],
    ['Your job is to reply to Bob for me.', mail, bob],
    ['Draft the summary and email it to Bob every Monday.', mail, bob],
  ] as const)('"%s" does', (text, words, to) => {
    expect(asksForIt(text, words, to)).not.toBeNull();
  });

  test.each([
    ['Every Friday, email Sam the weekly summary.', mail, bob],
    ['Never email Bob.', mail, bob],
    ['Draft replies and show each draft before it is sent.', mail, bob],
    ['Only draft replies to Bob.', mail, bob],
    ['Send nothing without my ok. Keep my inbox tidy.', mail, bob],
    ['Ask before you email Bob.', mail, bob],
    ['Keep the weekly summary up to date.', mail, bob],
    // Describing the work, or what someone does, is not telling the agent to do it.
    ['You manage my email.', mail, bob],
    ['You handle my email and calendar.', mail, bob],
    ['Bob emails me every Friday.', mail, bob],
    ['I usually reply to Bob within a day.', mail, bob],
    ['My inbox gets lots of replies from Bob.', mail, bob],
    ['This agent looks after issues for the site.', issue, ['acme/site']],
  ] as const)('"%s" does not', (text, words, to) => {
    expect(asksForIt(text, words, to)).toBeNull();
  });
});

describe('the score', () => {
  const item = (kind: Evidence['kind']): Evidence => ({
    kind,
    weight: WEIGHTS[kind],
    says: kind,
  });
  const options = { threshold: 0.6, doubted: false, mail: false, draftOnly: false };

  test('below the threshold nothing goes; at it, it goes with the reasons', () => {
    expect(judge([item('preference'), item('past')], options)).toMatchObject({
      score: 0.45,
      act: false,
    });
    const going = judge([item('preference'), item('past'), item('past')], options);
    expect(going).toMatchObject({ score: 0.6, act: true });
    expect(going.reason).toBe(
      'Confidence is 0.60 from what you said before: preference; past; past.',
    );
  });

  test('mail needs the instruction itself', () => {
    const evidence = [item('preference'), item('past'), item('past')];
    expect(judge(evidence, { ...options, mail: true }).act).toBe(false);
    expect(judge([item('instruction')], { ...options, mail: true }).act).toBe(true);
  });

  test('a refusal outweighs, a doubted recipient zeroes, draft-only holds', () => {
    expect(judge([item('instruction'), item('refused')], options)).toMatchObject({
      score: 0.1,
      act: false,
    });
    expect(judge([item('instruction')], { ...options, doubted: true })).toMatchObject({
      score: 0,
      act: false,
    });
    expect(judge([item('instruction')], { ...options, draftOnly: true }).act).toBe(false);
    expect(judge([item('instruction'), item('preference'), item('past')], options).score).toBe(1);
  });

  test('the threshold is the operator setting', () => {
    expect(judge([item('preference')], { ...options, threshold: 0.3 }).act).toBe(true);
    expect(judge([item('instruction')], { ...options, threshold: 0.9 }).act).toBe(false);
  });
});

describe('whom an action reaches', () => {
  test('recipients and channels, not what it says', () => {
    expect(
      reaches(
        { to: ['Bob@Example.com'], cc: 'ana@example.com', body: 'sam@example.com' },
        'email.send',
      ).sort(),
    ).toEqual(['ana@example.com', 'bob@example.com']);
    expect(reaches({ channel: '#general', text: 'hi' }, 'slack.post_message')).toEqual([
      '#general',
    ]);
  });

  test('mail is told from chat apps', () => {
    expect(sendsMail('email.send')).toBe(true);
    expect(sendsMail('mcp_gmail.send_email')).toBe(true);
    expect(sendsMail('slack.post_message')).toBe(false);
    expect(sendsMail('sms.send')).toBe(false);
  });
});
