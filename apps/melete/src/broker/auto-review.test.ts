import { describe, expect, test } from 'bun:test';
import type { ConnectorTool, JsonObject, OriginWarning } from '@melete/contracts';
import { escalationReason, reviewerApproves, reviewTier } from './auto-review.ts';

type Tool = Pick<ConnectorTool, 'name' | 'effect_class' | 'requires_approval' | 'execution'>;
const tool = (
  name: string,
  effect_class: ConnectorTool['effect_class'],
  requires_approval = false,
  execution?: ConnectorTool['execution'],
): Tool => ({ name, effect_class, requires_approval, ...(execution ? { execution } : {}) });

const doubt: OriginWarning = {
  field: 'to',
  origin_trust: 'inferred',
  handle: null,
  description: 'Guessed from an earlier message.',
};

const tier = (t: Tool, provider = 'app', payload: JsonObject = {}, doubts: OriginWarning[] = []) =>
  reviewTier({ tool: t, provider, payload, doubts });

describe('reviewTier', () => {
  test.each([
    ['a read', tool('mail.search', 'read'), 'app'],
    ['a command in the sandbox', tool('terminal.run', 'write_reversible'), 'exec'],
    ['a file written in the workspace', tool('files.write', 'write_reversible'), 'files'],
    [
      'a tool that runs in the cell',
      tool('notes.scratch', 'write_reversible', false, 'in_cell'),
      'app',
    ],
    ['filling a field in its own browser', tool('browser.fill', 'write_reversible'), 'browser'],
    ['a draft in the mailbox', tool('email.draft', 'write_reversible'), 'imap'],
  ])('%s is sandbox work', (_name, t, provider) => {
    expect(tier(t, provider)).toMatchObject({ tier: 'sandbox', actionClass: 'sandbox' });
  });

  test('a reversible change in a connected app is reviewable as an app change', () => {
    expect(tier(tool('tasks.create', 'write_reversible', true), 'mcp')).toMatchObject({
      tier: 'reviewable',
      actionClass: 'app_changes',
    });
  });

  test('an event on the person’s own calendar, with no guests, is reviewable as calendar', () => {
    expect(
      tier(tool('calendar.create', 'write_external'), 'caldav', { title: 'Focus', start: 'x' }),
    ).toMatchObject({ tier: 'reviewable', actionClass: 'calendar' });
  });

  test.each([
    ['spending', tool('payments.pay', 'spend'), {}],
    ['sending mail', tool('email.send', 'write_external'), { to: 'a@example.com' }],
    ['submitting a form', tool('browser.submit', 'write_external'), {}],
    ['publishing', tool('social.post', 'write_external'), {}],
    [
      'a calendar event with guests',
      tool('calendar.create', 'write_external'),
      { attendees: ['a@b.c'] },
    ],
    [
      'an update that invites someone',
      tool('calendar.update', 'write_external'),
      { event: { guests: ['x'] } },
    ],
    ['deleting in an app', tool('tasks.delete', 'write_reversible', true), {}],
    ['removing a member', tool('team.remove_member', 'write_reversible'), {}],
    ['revoking access', tool('drive.revoke', 'write_reversible'), {}],
    ['deleting a sandbox file', tool('files.delete', 'write_reversible'), {}],
    ['a stored password', tool('vault.store', 'write_reversible', true), { password: 'x' }],
    [
      'a nested API key',
      tool('settings.update', 'write_reversible', true),
      { auth: { api_key: 'x' } },
    ],
    ['a card number', tool('checkout.fill', 'write_reversible', true), { card_number: '4111' }],
    [
      'typing a password in its browser',
      tool('browser.fill', 'write_reversible'),
      { label: 'Password', value: 'x' },
    ],
    [
      'a one-time code in its browser',
      tool('browser.fill', 'write_reversible'),
      { label: 'One-time code', value: '1' },
    ],
  ])('%s is always the person’s', (_name, t, payload) => {
    expect(tier(t, 'app', payload as JsonObject)).toMatchObject({
      tier: 'person',
      actionClass: null,
    });
  });

  test('a recipient Melete inferred keeps even sandbox or reversible work with the person', () => {
    for (const t of [
      tool('terminal.run', 'write_reversible'),
      tool('tasks.create', 'write_reversible', true),
      tool('calendar.create', 'write_external'),
    ])
      expect(tier(t, 'exec', {}, [doubt])).toMatchObject({ tier: 'person' });
  });

  test('a sandbox tool whose manifest demands approval is not sandbox work', () => {
    expect(tier(tool('terminal.run', 'write_reversible', true), 'exec').tier).toBe('reviewable');
  });

  test('spending wins over every other reading', () => {
    expect(tier(tool('files.buy', 'spend'), 'files').reason).toBe('It spends money.');
  });
});

describe('verdicts', () => {
  test('only an explicit low-risk approval lets an action go ahead', () => {
    expect(reviewerApproves({ verdict: 'approve', risk: 'low', reason: 'ok' })).toBe(true);
    expect(reviewerApproves({ verdict: 'approve', risk: 'medium', reason: 'ok' })).toBe(false);
    expect(reviewerApproves({ verdict: 'escalate', risk: 'low', reason: 'no' })).toBe(false);
    expect(reviewerApproves({ verdict: 'none', failure: 'timeout', reason: 'late' })).toBe(false);
  });

  test('an approval above low risk escalates with the rating in its reason', () => {
    expect(escalationReason({ verdict: 'approve', risk: 'high', reason: 'Broad change.' })).toBe(
      'The reviewer rated it high risk: Broad change.',
    );
  });
});
