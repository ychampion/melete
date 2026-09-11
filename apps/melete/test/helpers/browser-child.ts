import { startBrowserWorker } from '../../src/workers/browser/entry.ts';

// A separate fixture-only entry injects loopback access. Production has no environment or HTTP bypass.
await startBrowserWorker({ network: { fixtureOrigins: ['http://127.0.0.1:3130'] } });
