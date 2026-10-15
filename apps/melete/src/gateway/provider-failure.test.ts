import { describe, expect, test } from 'bun:test';
import {
  classifyProviderFailure,
  providerFailureCode,
  providerFailureError,
} from './provider-failure.ts';

describe('a provider refusal is read for its class alone', () => {
  test('each kind of refusal providers send gets its class', () => {
    const cases: [number, string, string | null][] = [
      [401, '{"error":{"message":"Incorrect API key provided: sk-abc"}}', 'key_refused'],
      [403, '{"error":{"type":"permission_error"}}', 'key_refused'],
      [402, '', 'quota'],
      [
        429,
        '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
        'quota',
      ],
      [400, '{"error":{"message":"Your credit balance is too low to access the API."}}', 'quota'],
      [429, '{"error":{"type":"rate_limit_error"}}', 'rate_limited'],
      [
        429,
        '[{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}}]',
        'rate_limited',
      ],
      [
        429,
        '[{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}]',
        'quota',
      ],
      [
        429,
        '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
        'quota',
      ],
      [
        429,
        '{"error":{"message":"Rate limit reached for requests per min. You can increase your rate limit by adding a payment method at https://example.test/account/billing."}}',
        'rate_limited',
      ],
      [404, '{"error":{"code":"model_not_found"}}', 'model_not_found'],
      [400, '{"error":{"message":"The model `gpt-9` does not exist"}}', 'model_not_found'],
      [400, '{"error":{"code":"context_length_exceeded"}}', 'context_too_long'],
      [
        400,
        '{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
        'context_too_long',
      ],
      [413, '', 'context_too_long'],
      [500, 'internal error', 'provider_down'],
      [529, '{"error":{"type":"overloaded_error"}}', 'provider_down'],
      [408, '', 'provider_down'],
      [400, '{"error":{"message":"tools.0.name: invalid"}}', null],
    ];
    for (const [status, text, expected] of cases)
      expect([status, text, classifyProviderFailure(status, text)]).toEqual([
        status,
        text,
        expected,
      ]);
  });

  test('the engine gets a status its retry rules read the same way, and a code without words', () => {
    expect(providerFailureError('key_refused')).toMatchObject({
      status: 401,
      code: 'provider_key_refused',
    });
    expect(providerFailureError('quota').status).toBe(402);
    expect(providerFailureError('rate_limited').status).toBe(429);
    expect(providerFailureError('model_not_found').status).toBe(404);
    expect(providerFailureError('context_too_long').status).toBe(413);
    expect(providerFailureError('provider_down')).toMatchObject({
      status: 502,
      code: 'provider_down',
    });
    expect(providerFailureError('quota').detail).toBeUndefined();
    expect(providerFailureCode('rate_limited')).toBe('provider_rate_limited');
  });
});
