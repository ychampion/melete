import { describe, expect, test } from 'bun:test';
import type { ConnectorTool, JsonObject, OriginWarning } from '@melete/contracts';
import {
  changesPersonFiles,
  escalationReason,
  reviewerApproves,
  reviewTier,
} from './auto-review.ts';

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

  test("a file saved into, or moved in or out of, the person's own Files is theirs, not sandbox work", () => {
    const write = tool('files.write', 'write_reversible');
    const move = tool('files.move', 'write_reversible');
    for (const [t, payload] of [
      [write, { path: 'imgtest.png', area: 'artifacts', content: 'x' }],
      [move, { from: 'shot.png', to: 'shot.png', to_area: 'artifacts' }],
      [move, { from: 'shot.png', to: 'shot.png', area: 'artifacts' }],
    ] as const)
      expect(tier(t, 'files', payload)).toMatchObject({
        tier: 'reviewable',
        actionClass: 'app_changes',
      });
    // Its own workspace stays sandbox work, named or by default.
    for (const [t, payload] of [
      [write, { path: 'notes.md', content: 'x' }],
      [write, { path: 'notes.md', area: 'work', content: 'x' }],
      [move, { from: 'a.md', to: 'b.md', area: 'work', to_area: 'work' }],
    ] as const)
      expect(tier(t, 'files', payload)).toMatchObject({ tier: 'sandbox' });
    expect(changesPersonFiles('files.read', { path: 'a.md', area: 'artifacts' })).toBe(false);
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

  test('an update counts as the person’s own only when the calendar says the event has no guests', () => {
    const update = tool('calendar.update', 'write_external');
    const payload = { uid: 'act_1', etag: '"1"', summary: 'Focus', start: 'x', end: 'y' };
    const decide = (existingGuests?: number | null) =>
      reviewTier({ tool: update, provider: 'caldav', payload, doubts: [], existingGuests });
    expect(decide(0)).toMatchObject({ tier: 'reviewable', actionClass: 'calendar' });
    expect(decide(2)).toEqual({
      tier: 'person',
      actionClass: null,
      reason: 'It changes a meeting that has guests, and they would be told.',
    });
    for (const unknown of [undefined, null])
      expect(decide(unknown)).toEqual({
        tier: 'person',
        actionClass: null,
        reason: 'Melete could not check whether this event has guests.',
      });
    // A new event has no existing guests to ask about.
    expect(
      reviewTier({
        tool: tool('calendar.create', 'write_external'),
        provider: 'caldav',
        payload: { summary: 'Focus' },
        doubts: [],
        existingGuests: null,
      }),
    ).toMatchObject({ tier: 'reviewable' });
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
    [
      'deleting, named in camel case',
      tool('mcp_tracker.deleteIssue', 'write_reversible', true),
      {},
    ],
    ['removing, named in Pascal case', tool('mcp_team.RemoveMember', 'write_reversible', true), {}],
    [
      'an access token, keyed in camel case',
      tool('settings.update', 'write_reversible', true),
      { auth: { accessToken: 'x' } },
    ],
    [
      'a new password, keyed in camel case',
      tool('account.update', 'write_reversible', true),
      { newPassword: 'x' },
    ],
    [
      'a client secret, keyed in camel case',
      tool('app.configure', 'write_reversible', true),
      { clientSecret: 'x' },
    ],
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

describe('publishing apps', () => {
  const publish = tool('apps.publish', 'write_external', true);
  const rollback = tool('apps.rollback', 'write_external', true);

  test('a publish or rollback that raises no risk is decided by the apps rule', () => {
    for (const t of [publish, rollback])
      expect(tier(t, 'apps', { risks: [] })).toMatchObject({ tier: 'apps', actionClass: 'apps' });
  });

  test('each risk the connector bound sends it to the person, with the reason', () => {
    const widen = 'New people could open it: bo@example.test.';
    expect(tier(publish, 'apps', { risks: [widen] })).toEqual({
      tier: 'person',
      actionClass: null,
      reason: widen,
    });
    const webrtc = 'Its code can open direct connections to other servers (WebRTC).';
    expect(tier(rollback, 'apps', { risks: [webrtc] })).toMatchObject({
      tier: 'person',
      reason: webrtc,
    });
    // The connection warning asks on its own, even with the reasons left out.
    expect(tier(publish, 'apps', { risks: [], opens_connections: ['app.js'] })).toMatchObject({
      tier: 'person',
      reason: webrtc,
    });
  });

  test('a payload the connector never checked asks', () => {
    for (const payload of [{}, { risks: 'none' }, { risks: [1] }] as JsonObject[])
      expect(tier(publish, 'apps', payload)).toMatchObject({ tier: 'person', actionClass: null });
  });

  test('the same names from any other connection are not publishing apps', () => {
    for (const provider of ['mcp', 'app', 'files', 'exec'])
      expect(tier(publish, provider, { risks: [] }).tier).not.toBe('apps');
    expect(tier(tool('apps.delete', 'write_external', true), 'apps', { risks: [] }).tier).toBe(
      'person',
    );
  });

  test('a doubt about a value still keeps it with the person', () => {
    expect(tier(publish, 'apps', { risks: [] }, [doubt])).toMatchObject({ tier: 'person' });
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

describe('a change from the command line', () => {
  test('is always the person’s to decide, and a destructive one says so', () => {
    const write = tool('egress.test_write', 'write_external', true);
    expect(tier(write, 'command_line', { method: 'POST', destructive: false })).toMatchObject({
      tier: 'person',
      actionClass: null,
    });
    expect(tier(write, 'command_line', { method: 'DELETE', destructive: true }).reason).toContain(
      'deletes or overwrites',
    );
    // Even dressed up as a reversible write, it stays with the person.
    expect(tier(tool('egress.test_write', 'write_reversible'), 'exec').tier).toBe('person');
  });
});
