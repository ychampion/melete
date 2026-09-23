import { startBrowserWorker } from '../../src/workers/browser/entry.ts';

// A separate fixture-only entry injects loopback access, and shorter live limits when a test asks.
// Production has no environment or HTTP bypass for either.
const args = process.argv.slice(2);
const limits = args.find((arg) => arg.startsWith('limits='));
const fixtureOrigins = args.filter((arg) => arg !== limits);
if (!fixtureOrigins.length) throw new Error('The browser fixture origin is required');
await startBrowserWorker({
  network: { fixtureOrigins },
  live: limits ? { limits: JSON.parse(limits.slice('limits='.length)) } : undefined,
});
