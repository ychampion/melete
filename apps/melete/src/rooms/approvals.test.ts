import { describe, expect, test } from 'bun:test';
import { approverRuleFor, waitingFor } from './approvals.ts';

const open = { approvers: 'any_member', team_account_approvers: 'any_member' } as const;
const closed = { approvers: 'owners', team_account_approvers: 'owners' } as const;

describe('approverRuleFor', () => {
  test("a command-line account the room uses is always its owners', whatever the room's rules", () => {
    for (const policy of [open, closed])
      for (const guestAsked of [false, true])
        expect(approverRuleFor(policy, { account: 'command_line', guestAsked })).toEqual({
          approvers: 'owners',
          rule: 'team_accounts',
        });
  });

  test("a command-line account set to each person's own is only ever the asker's", () => {
    for (const policy of [open, closed])
      expect(approverRuleFor(policy, { account: 'own_account', guestAsked: false })).toEqual({
        approvers: 'requester',
        rule: 'own_account',
      });
  });

  test("any other team account follows the room's team-account rule", () => {
    expect(approverRuleFor(open, { account: 'team', guestAsked: false }).approvers).toBe(
      'any_member',
    );
    expect(approverRuleFor(closed, { account: 'team', guestAsked: false }).approvers).toBe(
      'owners',
    );
  });

  test('the card names whose own account a change goes through', () => {
    const authority = {
      spaceId: 'sp_1',
      requestJobId: 'job_1',
      threadId: null,
      requestedBy: 'prn_ana',
      approvers: 'requester',
      rule: 'own_account',
    } as const;
    expect(waitingFor(authority, new Map([['prn_ana', 'Ana']]))).toBe(
      "It goes through Ana's own account. Waiting for Ana to answer it.",
    );
    expect(waitingFor(authority, new Map())).toBe(
      'It goes through the own account of the person who asked, who is no longer in the room, so nobody can answer it.',
    );
    expect(waitingFor({ ...authority, requestedBy: null }, new Map())).toBe(
      "It goes through each person's own account, and no person asked for it, so nobody can answer it.",
    );
  });
});
