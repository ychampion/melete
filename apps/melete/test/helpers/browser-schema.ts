import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator } from 'playwright';
import { BrowserController } from '../../src/workers/browser/controller.ts';

// The real worker runs in Node; measure its locator calls against a real Chromium page.
const controller = new BrowserController({
  spaceId: 'sp_large_schema',
  spaceRoot: await mkdtemp(join(tmpdir(), 'melete-browser-schema-')),
});
try {
  const session = await controller.sessions.lease('job_large_schema', {
    public_compartment: false,
    allowed_domains: [],
  });
  const page = controller.sessions.page;
  if (!page) throw new Error('Chromium page unavailable');
  await page.setContent(
    `<form method="post">${Array.from(
      { length: 3000 },
      (_, index) => `<button name="choice" value="${index}">Choice ${index}</button>`,
    ).join('')}</form>`,
  );
  const prototype = Object.getPrototypeOf(page.locator('body')) as Locator;
  const count = prototype.count;
  const evaluate = prototype.evaluate;
  const elementHandle = prototype.elementHandle;
  const ariaSnapshot = prototype.ariaSnapshot;
  const result = { reason: '', counts: 0, evaluations: 0, handles: 0, snapshots: 0 };
  prototype.count = function (this: Locator) {
    // Stop a regression promptly rather than waiting for thousands of round trips.
    if (++result.counts > 129) throw new Error('locator_round_trip_budget_exceeded');
    return count.call(this);
  };
  prototype.evaluate = function (this: Locator, ...args: Parameters<Locator['evaluate']>) {
    result.evaluations++;
    return evaluate.apply(this, args);
  } as Locator['evaluate'];
  prototype.elementHandle = function (...args) {
    result.handles++;
    return elementHandle.apply(this, args);
  };
  prototype.ariaSnapshot = function (...args) {
    result.snapshots++;
    return ariaSnapshot.apply(this, args);
  };
  try {
    await controller.command({
      session_id: session.id,
      job_id: session.job_id,
      control_epoch: session.control_epoch,
      operation: { kind: 'observe' },
    });
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  } finally {
    prototype.count = count;
    prototype.evaluate = evaluate;
    prototype.elementHandle = elementHandle;
    prototype.ariaSnapshot = ariaSnapshot;
  }
  process.stdout.write(JSON.stringify({ ...result, metrics: controller.metrics }));
} finally {
  await controller.sessions.close();
}
