import { expect, test } from 'bun:test';
import { recallRequest } from '@melete/contracts';
import { cacheIdentity, type ReadAudience } from './recall.ts';
import { cosine, validateVector } from './views.ts';

test('cache identity binds audience, policy, data, access, job revision, query, and recipe', () => {
  const audience: ReadAudience = {
    scope: {
      ownerId: 'owner',
      spaceId: 'space',
      role: 'owner',
      publisher: 'server',
      audience: 'private',
    },
    audiences: ['private'],
    jobRevision: 1,
    constraints: null,
    purpose: 'responsibility',
    publicCompartment: false,
  };
  const snapshot = {
    space_id: 'space',
    policy_generation: 1,
    data_revision: 1,
    access_generation: 1,
    eligibility_generation: 1,
    restore_ready: true,
  };
  const request = recallRequest.parse({ query: 'trip' });
  const key = cacheIdentity(audience, snapshot, request, 'lexical-v1');
  for (const field of ['policy_generation', 'data_revision', 'access_generation'] as const)
    expect(cacheIdentity(audience, { ...snapshot, [field]: 2 }, request, 'lexical-v1')).not.toBe(
      key,
    );
  expect(
    cacheIdentity({ ...audience, audiences: ['space'] }, snapshot, request, 'lexical-v1'),
  ).not.toBe(key);
  expect(cacheIdentity({ ...audience, jobRevision: 2 }, snapshot, request, 'lexical-v1')).not.toBe(
    key,
  );
  expect(cacheIdentity(audience, snapshot, { ...request, query: 'travel' }, 'lexical-v1')).not.toBe(
    key,
  );
  expect(cacheIdentity(audience, snapshot, request, 'dense-v1')).not.toBe(key);
});
test('dense vectors cannot mix dimensions or nonfinite components', () => {
  expect(cosine([1, 0], [1, 0])).toBe(1);
  expect(() => validateVector([1, Number.NaN], 2)).toThrow('embedding_space_mismatch');
  expect(() => cosine([1, 0], [1])).toThrow('embedding_space_mismatch');
});
