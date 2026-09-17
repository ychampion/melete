import { startBrowserWorker } from '../../src/workers/browser/entry.ts';

// A separate fixture-only entry injects loopback access. Production has no environment or HTTP bypass.
const fixtureOrigins = process.argv.slice(2);
if (!fixtureOrigins.length) throw new Error('The browser fixture origin is required');
await startBrowserWorker({ network: { fixtureOrigins } });
