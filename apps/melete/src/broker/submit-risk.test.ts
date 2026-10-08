import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { submitRisk } from './auto-review.ts';

const form = (fields: Record<string, string>, name = 'Continue', url = 'https://shop.example/go') =>
  ({ intent: { url, method: 'POST', role: 'button', name, fields } }) as unknown as JsonObject;

describe('what a browser submit does, by its fields and its button', () => {
  test('the risks only the person lets through', () => {
    expect(submitRisk(form({ party: '6', amount: '50' }))?.risk).toBe('spend');
    expect(submitRisk(form({ card_number: '4111 1111 1111 1111' }))?.risk).toBe('credentials');
    expect(submitRisk(form({ size: 'M' }, 'Place order'))?.risk).toBe('spend');
    expect(submitRisk(form({ password: 'x' }))?.risk).toBe('credentials');
    expect(submitRisk(form({ id: '7' }, 'Delete account'))?.risk).toBe('delete');
    expect(submitRisk(form({ to: 'someone@else.example', body: 'Hi' }))?.risk).toBe('outside_send');
    expect(submitRisk(form({ visibility: 'public' }))?.risk).toBe('visibility');
  });

  test('an ordinary form is none of them, a forgery guard included', () => {
    expect(submitRisk(form({ party: '6', time: '19:00' }, 'Book'))).toBeNull();
    expect(
      submitRisk(form({ email: 'ada@example.test', csrf_token: 'f00d' }, 'Subscribe me')),
    ).toBeNull();
    expect(
      submitRisk(form({ email: 'ada@example.test', csrf_token: 'f00d' }, 'Sign up')),
    ).toBeNull();
    expect(submitRisk(form({ q: 'shoes' }, 'Search'))).toBeNull();
  });
});
