import { startBrowserWorker } from '../../src/workers/browser/entry.ts';

// A separate fixture-only entry injects loopback access. Production has no environment or HTTP bypass.
const fixtureOrigin = process.argv[2];
if (!fixtureOrigin) throw new Error('The browser fixture origin is required');
await startBrowserWorker({ network: { fixtureOrigins: [fixtureOrigin] } });
