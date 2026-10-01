import { expect, test } from 'bun:test';
import { describeFailure, isExtractionFailure } from './health.ts';

test('every way a read is given up counts as a failure, and a deliberate skip does not', () => {
  for (const code of [
    'extraction_provider_auth',
    'extraction_provider_refused',
    'extraction_call_refused',
    'extraction_unreadable',
    'extraction_response_size',
    'extraction_input_size',
    'extraction_budget',
    'no_extraction_gateway',
    'extraction_provider_unavailable:given_up',
    'memory_daily_budget:given_up',
  ])
    expect([code, isExtractionFailure(code)]).toEqual([code, true]);
  // Kept private on purpose, or a proposal memory refused: not a lost read.
  for (const code of ['extraction_kept_private', 'unsupported_attribution', 'invalid_proposal'])
    expect([code, isExtractionFailure(code)]).toEqual([code, false]);
});

test('each failure is named in words an operator can act on', () => {
  expect(describeFailure('extraction_provider_auth')).toBe('provider_auth');
  expect(describeFailure('extraction_provider_refused')).toBe('provider_refused');
  expect(describeFailure('extraction_unreadable')).toBe('unreadable_answer');
  expect(describeFailure('extraction_call_refused')).toBe('too_large');
  expect(describeFailure('no_extraction_gateway')).toBe('no_memory_model');
  expect(describeFailure('extraction_provider_unavailable:given_up')).toBe('provider_unavailable');
  expect(describeFailure('extraction_provider_timeout:given_up')).toBe('provider_slow');
  expect(describeFailure('memory_daily_budget:given_up')).toBe('daily_budget');
  expect(describeFailure('extraction_failed:TypeError')).toBe('other');
});
