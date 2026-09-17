import { describe, expect, test } from 'bun:test';
import * as contracts from '@melete/contracts';
import { z } from 'zod';
import {
  hostOf,
  LIVE_LIMITS,
  LIVE_VIEWPORT,
  LiveFrameBudget,
  type LiveInput,
  LiveInputLimiter,
  LiveNetworkBudget,
  LiveSiteScope,
  liveInput,
  liveUp,
  siteOf,
} from './live-protocol.ts';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const move: LiveInput = { k: 'move', x: 10, y: 10, button: 0, mods: 0, clicks: 1 };

describe('live site scope', () => {
  test('scope admits a redirect hop and refuses a typed off-scope host', () => {
    const scope = new LiveSiteScope(['shop.example.com'], 'https://www.example.com/signin');
    expect(scope.list()).toEqual(['example.com']);
    expect(scope.admits('login.example.com')).toBe(true);

    // The sign-in form redirects to an identity provider on another site.
    expect(
      scope.follow('https://auth.idp-example.net/authorize?x=1', 'https://www.example.com/login'),
    ).toBe('admitted');
    expect(scope.admits('static.idp-example.net')).toBe(true);
    expect(
      scope.follow('https://www.example.com/account', 'https://auth.idp-example.net/done'),
    ).toBe('in_scope');

    // A navigation no in-scope document started (typed, or from an error page) stays out.
    expect(scope.follow('https://evil.example.org/', undefined)).toBe('off_scope');
    expect(scope.follow('https://evil.example.org/', 'chrome-error://chromewebdata/')).toBe(
      'off_scope',
    );
    expect(scope.follow('https://evil.example.org/', 'https://other.example.org/')).toBe(
      'off_scope',
    );
    expect(scope.admits('evil.example.org')).toBe(false);
    expect(scope.list()).toEqual(['example.com', 'idp-example.net']);

    // The person can allow that host for this takeover only.
    expect(scope.allow('evil.example.org')).toBe('admitted');
    expect(scope.admits('www.evil.example.org')).toBe(true);
    expect(
      new LiveSiteScope(['shop.example.com'], 'https://www.example.com/').admits(
        'evil.example.org',
      ),
    ).toBe(false);
  });

  test('sites come from the public suffix list, including private suffixes and addresses', () => {
    expect(siteOf('a.b.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('WWW.Example.COM.')).toBe('example.com');
    expect(siteOf('alice.github.io')).toBe('alice.github.io');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('[::1]')).toBe('::1');
    const scope = new LiveSiteScope([], 'https://alice.github.io/');
    expect(scope.admits('bob.github.io')).toBe(false);
    expect(new LiveSiteScope(['127.0.0.1']).admits('127.0.0.2')).toBe(false);
    expect(hostOf('about:blank')).toBeUndefined();
    expect(hostOf('data:text/html,hi')).toBeUndefined();
  });

  test('additions stop at twelve sites and the floor is never dropped', () => {
    const scope = new LiveSiteScope(['start.example'], 'https://start.example/');
    for (let index = 1; index < 12; index++)
      expect(scope.follow(`https://site${index}.example/`, 'https://start.example/')).toBe(
        'admitted',
      );
    expect(scope.list()).toHaveLength(12);
    expect(scope.follow('https://site12.example/', 'https://start.example/')).toBe('scope_full');
    expect(scope.allow('site12.example')).toBe('scope_full');
    expect(scope.admits('start.example')).toBe(true);
    const wide = new LiveSiteScope(
      Array.from({ length: 20 }, (_, index) => `allowed${index}.example`),
      'https://page.example/',
    );
    expect(wide.list()).toHaveLength(21);
    expect(wide.allow('another.example')).toBe('scope_full');
  });

  test('an allowed host must be a bare host name', () => {
    const scope = new LiveSiteScope([], 'https://www.example.com/');
    for (const host of [
      'example.org:8443',
      'user@example.org',
      'example.org/path',
      'exa mple.org',
      '',
    ])
      expect(scope.allow(host)).toBe('off_scope');
    expect(scope.allow('Example.ORG')).toBe('admitted');
  });
});

describe('live input limits', () => {
  test('a batch above two hundred events per second is refused whole and refills with time', () => {
    const time = clock();
    const limiter = new LiveInputLimiter(time.now);
    expect(limiter.admit(Array.from({ length: 150 }, () => move))).toBe(true);
    expect(limiter.admit(Array.from({ length: 60 }, () => move))).toBe(false);
    expect(limiter.admit(Array.from({ length: 50 }, () => move))).toBe(true);
    expect(limiter.admit([move])).toBe(false);
    time.advance(500);
    expect(limiter.admit(Array.from({ length: 100 }, () => move))).toBe(true);
    expect(new LiveInputLimiter(time.now).admit(Array.from({ length: 201 }, () => move))).toBe(
      false,
    );
  });

  test('text is at most four kilobytes per event and four events per second', () => {
    const time = clock();
    const limiter = new LiveInputLimiter(time.now);
    expect(limiter.admit([{ k: 'text', text: 'é'.repeat(2049) }])).toBe(false);
    expect(limiter.admit([{ k: 'text', text: 'a'.repeat(4096) }])).toBe(true);
    const typed: LiveInput = { k: 'text', text: 'a' };
    expect(new LiveInputLimiter(time.now).admit([typed, typed, typed, typed])).toBe(true);
    expect(new LiveInputLimiter(time.now).admit([typed, typed, typed, typed, typed])).toBe(false);
  });

  test('input bytes are at most sixty-four kilobytes per second', () => {
    const time = clock();
    const limiter = new LiveInputLimiter(time.now);
    const paste: LiveInput = { k: 'text', text: 'a'.repeat(4000) };
    expect(limiter.admit([paste, paste, paste, paste])).toBe(true);
    time.advance(1000);
    expect(limiter.admit([paste, paste, paste, paste])).toBe(true);
    time.advance(1000);
    // Sixteen kilobytes at a time stays within the rate; the text-event count is what refuses.
    expect(limiter.admit([paste, paste, paste, paste, paste])).toBe(false);
    const moves = Array.from({ length: 200 }, () => ({ ...move, x: 1000.123456789 }));
    expect(new LiveInputLimiter(time.now).admit(moves)).toBe(true);
    const touches: LiveInput[] = Array.from({ length: 200 }, () => ({
      k: 'touch',
      phase: 'move',
      points: Array.from({ length: 10 }, (_, id) => ({ id, x: 1023.123456789, y: 767.123456789 })),
    }));
    const bytes = touches.reduce(
      (total, touch) => total + Buffer.byteLength(JSON.stringify(touch)),
      0,
    );
    expect(bytes).toBeGreaterThan(LIVE_LIMITS.input_bytes_per_second);
    expect(new LiveInputLimiter(time.now).admit(touches.slice(0, 100))).toBe(true);
    expect(new LiveInputLimiter(time.now).admit(touches)).toBe(false);
  });

  test('input names page events only and refuses browser protocol methods and stray fields', () => {
    for (const raw of [
      { k: 'cdp', method: 'Runtime.evaluate', params: { expression: '1' } },
      { ...move, method: 'Input.dispatchMouseEvent' },
      { ...move, x: LIVE_VIEWPORT.width + 1 },
      { ...move, y: -1 },
      { ...move, button: 3 },
      { k: 'wheel', x: 1, y: 1, dx: Number.POSITIVE_INFINITY, dy: 0, mods: 0 },
      { k: 'key', down: true, key: '', code: 'KeyA', vk: 65, mods: 0 },
      { k: 'text', text: '' },
      {
        k: 'touch',
        phase: 'start',
        points: Array.from({ length: 11 }, (_, id) => ({ id, x: 1, y: 1 })),
      },
    ])
      expect(liveInput.safeParse(raw).success).toBe(false);
    expect(
      liveUp.safeParse({ live_id: 'a'.repeat(43), ack_through: 0, events: Array(201).fill(move) })
        .success,
    ).toBe(false);
    expect(
      liveUp.safeParse({ live_id: 'a'.repeat(43), ack_through: 3, events: [move] }).success,
    ).toBe(true);
  });
});

describe('live frame and network budgets', () => {
  test('frames wait above 500 KB a second averaged over ten seconds and never run out', () => {
    const time = clock();
    const budget = new LiveFrameBudget(time.now);
    const frame = 100 * 1024;
    for (let index = 0; index < 50; index++) expect(budget.take(frame)).toBe(true);
    expect(budget.take(frame)).toBe(false);
    time.advance(9_999);
    expect(budget.take(frame)).toBe(false);
    time.advance(1);
    for (let index = 0; index < 50; index++) expect(budget.take(frame)).toBe(true);
    // Far beyond the old per-takeover total, a steady stream within the rate is never refused.
    time.advance(10_000);
    for (let second = 0; second < 600; second++) {
      time.advance(1000);
      for (let index = 0; index < 5; index++) expect(budget.take(frame)).toBe(true);
    }
    expect(LIVE_LIMITS.frames_per_second).toBe(10);
    const huge = new LiveFrameBudget(time.now, 1024);
    expect(huge.take(64 * 1024)).toBe(true);
    expect(huge.take(1)).toBe(false);
  });

  test('page network stops after two thousand requests or thirty-two megabytes', () => {
    const budget = new LiveNetworkBudget();
    for (let index = 0; index < 2000; index++) expect(budget.request()).toBe(true);
    expect(budget.request()).toBe(false);
    const bytes = new LiveNetworkBudget();
    expect(bytes.transfer(32 * 1024 * 1024)).toBe(true);
    expect(bytes.transfer(1)).toBe(false);
  });
});

test('the worker protocol mirrors the published contract exactly', () => {
  expect(LIVE_LIMITS).toEqual(contracts.LIVE_LIMITS);
  expect(LIVE_VIEWPORT).toEqual(contracts.LIVE_VIEWPORT);
  expect(z.toJSONSchema(liveInput)).toEqual(z.toJSONSchema(contracts.liveInput));
  expect(z.toJSONSchema(liveUp)).toEqual(z.toJSONSchema(contracts.liveUp));
});
