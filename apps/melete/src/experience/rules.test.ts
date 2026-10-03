import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { egressPayload } from '../broker/egress-admission.ts';
import { githubAdapter } from '../egress/adapters/github.ts';
import type { InterceptedRequest } from '../egress/adapters/types.ts';
import { ruleCovers, ruleView } from './rules.ts';

const ZERO = '0'.repeat(40);
const A = 'ef5e63cd808eddbe9fad81f85b15341188093b1b';
const B = '73cd911b5626ddbf8abd727ac93642f1825cc3e2';
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

/** The payload the broker would hold for a push of these updates, through the real classifier. */
function push(updates: Array<[string, string, string]>, options: string[] = []): JsonObject {
  const lines = updates.map(([old, next, ref], index) =>
    pkt(
      `${old} ${next} ${ref}${index === 0 ? `\0 report-status side-band-64k${options.length ? ' push-options' : ''}` : ''}`,
    ),
  );
  const deletesOnly = updates.every(([, next]) => next === ZERO);
  const sent = options.length ? `0000${options.map((option) => pkt(`${option}\n`)).join('')}` : '';
  const request: InterceptedRequest = {
    host: 'github.com',
    method: 'POST',
    path: '/alice/site.git/git-receive-pack',
    query: '',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.from(`${lines.join('')}${sent}0000${deletesOnly ? '' : 'PACK'}`),
  };
  const verdict = githubAdapter.classify(request, {});
  if (verdict.kind !== 'write') throw new Error('expected a write');
  return egressPayload(verdict);
}
const covered = (payload: JsonObject, kind = 'egress.github_write') =>
  ruleCovers({ kind, canonical_payload: payload });

describe('what a push rule says it allows', () => {
  test('the rule says its pushes run the repository workflows with its secrets, and what to protect', () => {
    const view = ruleView({
      id: 'rule_1',
      tool_kind: 'egress.github_write',
      connection_id: 'conn_01J00000000000000000000000',
      recipient_class: 'alice/site',
      job_id: null,
      count_cap: 5,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      reconsent_after_days: 7,
      used: 0,
      created_at: new Date().toISOString(),
    });
    expect(view.kind).toBe('push_branch');
    expect(view.text).toStartWith('Pushes to melete/ branches in alice/site, up to 5 times');
    expect(view.text).toContain(
      "runs the repository's workflows on the pushed code, with the repository's secrets",
    );
    expect(view.text).toContain('can change the default branch unless it is protected');
    expect(view.text).toContain('without the Workflows permission');
  });
});

describe('which pushes a standing rule may cover', () => {
  test('creating or moving melete branches is covered', () => {
    expect(covered(push([[ZERO, B, 'refs/heads/melete/fix-login']]))).toBe(true);
    expect(
      covered(
        push([
          [A, B, 'refs/heads/melete/fix-login'],
          [ZERO, B, 'refs/heads/melete/other'],
        ]),
      ),
    ).toBe(true);
  });

  test('the default branch, any other branch, a tag or a delete always asks', () => {
    expect(covered(push([[A, B, 'refs/heads/main']]))).toBe(false);
    expect(covered(push([[A, B, 'refs/heads/feature/x']]))).toBe(false);
    expect(covered(push([[ZERO, B, 'refs/tags/melete/v1']]))).toBe(false);
    expect(covered(push([[A, ZERO, 'refs/heads/melete/fix-login']]))).toBe(false);
    // One update outside melete/ is enough to ask for the whole push.
    expect(
      covered(
        push([
          [A, B, 'refs/heads/melete/fix-login'],
          [A, B, 'refs/heads/main'],
        ]),
      ),
    ).toBe(false);
    // A look-alike prefix is not the prefix.
    expect(covered(push([[A, B, 'refs/heads/melete-x']]))).toBe(false);
    expect(covered(push([[A, B, 'refs/heads/melete/']]))).toBe(false);
  });

  test('a push with push options always asks, even to a melete branch', () => {
    // GitLab reads these to open or merge a merge request, or to skip or vary its pipeline.
    const withOptions = push([[ZERO, B, 'refs/heads/melete/fix-login']], ['merge_request.create']);
    expect(withOptions.push_options).toEqual(['merge_request.create']);
    expect(covered(withOptions)).toBe(false);
    expect(covered(push([[A, B, 'refs/heads/melete/fix-login']], ['ci.skip']))).toBe(false);
    // A payload that names no options at all is not taken to have none.
    const { push_options: _left, ...unnamed } = push([[ZERO, B, 'refs/heads/melete/x']]);
    expect(covered(unnamed)).toBe(false);
  });

  test('a GitLab push is never covered by a rule', () => {
    expect(covered(push([[ZERO, B, 'refs/heads/melete/x']]), 'egress.gitlab_write')).toBe(false);
  });

  test('no other change from the computer is covered, whatever repository it names', () => {
    const request: InterceptedRequest = {
      host: 'api.github.com',
      method: 'DELETE',
      path: '/repos/alice/site/git/refs/heads/melete%2Ffix-login',
      query: '',
      headers: {},
      body: Buffer.alloc(0),
    };
    const verdict = githubAdapter.classify(request, {});
    if (verdict.kind !== 'write') throw new Error('expected a write');
    expect(verdict.payload.resource).toBe('alice/site');
    expect(covered(egressPayload(verdict))).toBe(false);
    // A kind with no rule at all.
    expect(covered(push([[ZERO, B, 'refs/heads/melete/x']]), 'egress.test_write')).toBe(false);
  });
});
