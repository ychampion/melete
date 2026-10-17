import { expect, test } from 'bun:test';
import { latestOnly } from './latest.ts';

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('an older answer that comes back after a newer one is dropped', async () => {
  const latest = latestOnly();
  const applied: string[] = [];
  const first = deferred<string>();
  const second = deferred<string>();
  latest(first.promise, (value) => applied.push(value));
  latest(second.promise, (value) => applied.push(value));
  second.resolve('newer');
  await second.promise;
  first.resolve('older');
  await first.promise;
  await Promise.resolve();
  expect(applied).toEqual(['newer']);
});

test('reads that answer in order are each applied', async () => {
  const latest = latestOnly();
  const applied: number[] = [];
  latest(Promise.resolve(1), (value) => applied.push(value));
  await Promise.resolve();
  await Promise.resolve();
  latest(Promise.resolve(2), (value) => applied.push(value));
  await Promise.resolve();
  await Promise.resolve();
  expect(applied).toEqual([1, 2]);
});

test('reads that each answer after the next is asked are still applied, oldest first', async () => {
  const latest = latestOnly();
  const applied: string[] = [];
  const first = deferred<string>();
  const second = deferred<string>();
  const third = deferred<string>();
  latest(first.promise, (value) => applied.push(value));
  latest(second.promise, (value) => applied.push(value));
  first.resolve('first');
  await first.promise;
  latest(third.promise, (value) => applied.push(value));
  second.resolve('second');
  await second.promise;
  await Promise.resolve();
  expect(applied).toEqual(['first', 'second']);
});
