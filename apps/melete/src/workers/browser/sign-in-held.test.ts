import { expect, test } from 'bun:test';
import { heldWriteOnSite, signInRefusal } from './controller.ts';
import { BrowserNetworkError } from './egress.ts';

const write = (entry: string, credentials = true) => {
  const [method = '', host = ''] = entry.split(' ');
  return { method, host, budget: false, credentials };
};

test('a sign-in posted to another origin of the same site counts as sent elsewhere', () => {
  const origin = 'https://www.example.com';
  expect(heldWriteOnSite([write('POST api.example.com')], origin)).toBe(true);
  expect(heldWriteOnSite([write('PUT login.example.com')], origin)).toBe(true);
  // A third party's beacon, a read, or the page's own host say nothing of the sign-in.
  expect(heldWriteOnSite([write('POST www.google-analytics.com')], origin)).toBe(false);
  expect(heldWriteOnSite([write('GET api.example.com')], origin)).toBe(false);
  expect(heldWriteOnSite([write('POST www.example.com')], origin)).toBe(false);
  expect(heldWriteOnSite([], origin)).toBe(false);
  // Sites under a shared suffix are separate sites.
  expect(heldWriteOnSite([write('POST other.github.io')], 'https://mine.github.io')).toBe(false);
  expect(heldWriteOnSite([write('POST api.example.com')], '')).toBe(false);
});

test("a site's own telemetry to another of its hosts never turns a refusal into sent elsewhere", () => {
  const origin = 'https://www.example.com';
  // A wrong password with a metrics beacon held back meanwhile is still a wrong password.
  expect(heldWriteOnSite([write('POST metrics.example.com', false)], origin)).toBe(false);
  expect(
    heldWriteOnSite(
      [write('POST metrics.example.com', false), write('POST api.example.com', true)],
      origin,
    ),
  ).toBe(true);
});

test('what the sign-in network window refused becomes the step answer', () => {
  expect(signInRefusal(new BrowserNetworkError('sign_in_origin', 'x'))).toBe('wrong_site');
  expect(signInRefusal(new BrowserNetworkError('sign_in_secret_elsewhere', 'x'))).toBe(
    'wrong_site',
  );
  expect(signInRefusal(new BrowserNetworkError('sign_in_secret_in_url', 'x'))).toBe('unsafe_form');
  expect(signInRefusal(new BrowserNetworkError('sign_in_budget', 'x'))).toBeUndefined();
  expect(signInRefusal(new Error('sign_in_origin'))).toBeUndefined();
});
