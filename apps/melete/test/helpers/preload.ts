import { afterAll } from 'bun:test';
import { shareTestServer } from './database.ts';
import { gatherFacts, preflightReport } from './preflight.ts';
import { useTemporaryRoot } from './temp-root.ts';

// Messages are sent at once in tests that start the whole service; the undo
// send hold has tests of its own that set it.
process.env.MELETE_SEND_HOLD_SECONDS ??= '0';

const removeTemporaryRoot = useTemporaryRoot();
const stopTestServer = shareTestServer();

// Keeping server startup outside each suite leaves time for real crash tests.
// WAL/fsync settings stay at Postgres defaults, including in the durability tests.
// The embedded server keeps its data in the temporary root, so the root goes
// after the server has stopped, and also when stopping it fails.
afterAll(async () => {
  try {
    await stopTestServer();
  } finally {
    removeTemporaryRoot();
  }
}, 20_000);

// One named line per missing prerequisite, before the suite reports it fifty ways.
const report = preflightReport(gatherFacts());
if (!report.startsWith('doctor: every')) process.stdout.write(report);
