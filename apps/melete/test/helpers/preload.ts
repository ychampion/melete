import { afterAll } from 'bun:test';
import { shareTestServer } from './database.ts';
import { gatherFacts, preflightReport } from './preflight.ts';

// Messages are sent at once in tests that start the whole service; the undo
// send hold has tests of its own that set it.
process.env.MELETE_SEND_HOLD_SECONDS ??= '0';

// Keeping server startup outside each suite leaves time for real crash tests.
// WAL/fsync settings stay at Postgres defaults, including in the durability tests.
afterAll(shareTestServer(), 15_000);

// One named line per missing prerequisite, before the suite reports it fifty ways.
const report = preflightReport(gatherFacts());
if (!report.startsWith('doctor: every')) process.stdout.write(report);
