import { expect, test } from 'bun:test';
import { checkIsThisWorks } from './check-screen.ts';

const LEFT = 'https://captcha-demo.example/demo/cloudflare-turnstile';
const screenshot = { kind: 'computer.screenshot', payload: {} };

test('a check another chat left on the screen is not this work’s, on a look or after an open elsewhere', () => {
  expect(
    checkIsThisWorks({ screenUrl: LEFT, current: screenshot, own: [], leftByOther: LEFT }),
  ).toBe(false);
  // The open of another site went through, but the page left in front is still the other one.
  expect(
    checkIsThisWorks({
      screenUrl: LEFT,
      current: { kind: 'computer.open', payload: { url: 'https://forms.example/form' } },
      own: [],
      leftByOther: LEFT,
    }),
  ).toBe(false);
});

test('a check on a site this work opened or reached is its own, whoever was there before', () => {
  expect(
    checkIsThisWorks({
      screenUrl: LEFT,
      current: { kind: 'computer.open', payload: { url: 'https://captcha-demo.example/' } },
      own: [],
      leftByOther: LEFT,
    }),
  ).toBe(true);
  expect(
    checkIsThisWorks({
      screenUrl: LEFT,
      current: {
        kind: 'computer.batch',
        payload: { actions: [{ action: 'open', url: 'https://www.captcha-demo.example/x' }] },
      },
      own: [],
      leftByOther: LEFT,
    }),
  ).toBe(true);
  expect(
    checkIsThisWorks({
      screenUrl: LEFT,
      current: screenshot,
      own: [{ kind: 'computer.click', payload: {}, url: 'https://captcha-demo.example/start' }],
      leftByOther: LEFT,
    }),
  ).toBe(true);
});

test('a check counts when nobody else left a page, or left another one', () => {
  expect(
    checkIsThisWorks({ screenUrl: LEFT, current: screenshot, own: [], leftByOther: null }),
  ).toBe(true);
  // Reached by a click from somewhere else: not the page the other chat left.
  expect(
    checkIsThisWorks({
      screenUrl: 'https://www.travel.example/flights',
      current: { kind: 'computer.click', payload: {} },
      own: [],
      leftByOther: 'https://www.travel.example/',
    }),
  ).toBe(true);
  // A screen with no address cannot be told apart, so it counts.
  expect(
    checkIsThisWorks({ screenUrl: null, current: screenshot, own: [], leftByOther: LEFT }),
  ).toBe(true);
});
