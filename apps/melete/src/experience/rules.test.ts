import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { egressPayload } from '../broker/egress-admission.ts';
import { githubAdapter } from '../egress/adapters/github.ts';
import type { InterceptedRequest } from '../egress/adapters/types.ts';
import { ruleCovers } from './rules.ts';

const ZERO = '0'.repeat(40);
const A = 'ef5e63cd808eddbe9fad81f85b15341188093b1b';
const B = '73cd911b5626ddbf8abd727ac93642f1825cc3e2';
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

/** The payload the broker would hold for a push of these updates, through the real classifier. */
function push(updates: Array<[string, string, string]>): JsonObject {
  const lines = updates.map(([old, next, ref], index) =>
    pkt(`${old} ${next} ${ref}${index === 0 ? '\0 report-status side-band-64k' : ''}`),
  );
  const deletesOnly = updates.every(([, next]) => next === ZERO);
  const request: InterceptedRequest = {
    host: 'github.com',
    method: 'POST',
    path: '/alice/site.git/git-receive-pack',
    query: '',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.from(`${lines.join('')}0000${deletesOnly ? '' : 'PACK'}`),
  };
  const verdict = githubAdapter.classify(request, {});
  if (verdict.kind !== 'write') throw new Error('expected a write');
  return egressPayload(verdict);
}
const covered = (payload: JsonObject, kind = 'egress.github_write') =>
  ruleCovers({ kind, canonical_payload: payload });

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
