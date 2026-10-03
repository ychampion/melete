import { expect, test } from 'bun:test';
import { startGuestExpiry } from './expiry.ts';

test('only the instance that holds the guest expiry lease sweeps', async () => {
  let swept = 0;
  const principals = {
    async expireGuests() {
      swept += 1;
      return [];
    },
  };
  let leading = false;
  const stop = startGuestExpiry(principals as never, 10, async () => leading);
  await Bun.sleep(40);
  expect(swept).toBe(0);
  leading = true;
  await Bun.sleep(40);
  stop();
  expect(swept).toBeGreaterThan(0);
});
