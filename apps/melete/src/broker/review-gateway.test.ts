import { describe, expect, test } from 'bun:test';
import { reviewPrincipal } from './review-gateway.ts';

describe('reviewPrincipal', () => {
  test('a review call names the space and the job whose action it carries', () => {
    const principal = reviewPrincipal(
      'token-1',
      { spaceId: 'sp_1', jobId: 'job_1' },
      { provider: 'fireworks', model: 'chosen' },
    );
    expect(principal.privacy).toEqual({
      kind: 'service',
      purpose: 'action_review',
      spaceId: 'sp_1',
      sourceJobId: 'job_1',
    });
    expect(principal).toMatchObject({
      jobId: 'review:sp_1',
      attemptId: 'review:token-1',
      maxRequests: 1,
      allowedModels: [{ provider: 'fireworks', model: 'chosen' }],
    });
  });
});
