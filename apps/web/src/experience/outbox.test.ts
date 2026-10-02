/**
 * Retry on a message that failed to send: it resends that message with its
 * own key, once per press that lands while nothing is in flight.
 */
import { expect, test } from 'bun:test';
import { Outbox } from './outbox.ts';

/** A send endpoint that answers each request when told to, recording the keys it saw. */
function service() {
  const keys: string[] = [];
  const answers: ((ok: boolean) => void)[] = [];
  const post = (key: string) => () => {
    keys.push(key);
    return new Promise<boolean>((resolve) => answers.push(resolve));
  };
  return { keys, post, answer: (ok: boolean) => answers.shift()?.(ok) };
}

test('a failed message is resent with the key it was first sent with', async () => {
  const outbox = new Outbox();
  const api = service();
  const first = outbox.send('local_1', api.post('key-1'));
  api.answer(false);
  expect(await first).toBe(false);
  const again = outbox.retry('local_1');
  expect(again).not.toBeNull();
  api.answer(true);
  expect(await again).toBe(true);
  expect(api.keys).toEqual(['key-1', 'key-1']);
});

test('Retry pressed twice while the resend is in flight sends once', async () => {
  const outbox = new Outbox();
  const api = service();
  const first = outbox.send('local_1', api.post('key-1'));
  api.answer(false);
  await first;
  const again = outbox.retry('local_1');
  expect(outbox.retry('local_1')).toBeNull();
  expect(outbox.sending('local_1')).toBe(true);
  api.answer(true);
  await again;
  expect(api.keys).toEqual(['key-1', 'key-1']);
});

test('a message the service has is not sent again', async () => {
  const outbox = new Outbox();
  const api = service();
  const first = outbox.send('local_1', api.post('key-1'));
  expect(outbox.retry('local_1')).toBeNull();
  api.answer(true);
  expect(await first).toBe(true);
  expect(outbox.retry('local_1')).toBeNull();
  expect(api.keys).toEqual(['key-1']);
});

test('a retry for a message nobody sent does nothing', () => {
  expect(new Outbox().retry('local_unknown')).toBeNull();
});
