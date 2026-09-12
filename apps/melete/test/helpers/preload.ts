import { afterAll } from 'bun:test';
import { shareTestServer } from './database.ts';
import { gatherFacts, preflightReport } from './preflight.ts';

// Keeping server startup outside each suite leaves time for real crash tests.
// WAL/fsync settings stay at Postgres defaults, including in the durability tests.
afterAll(shareTestServer(), 15_000);

// One named line per missing prerequisite, before the suite reports it fifty ways.
const report = preflightReport(gatherFacts());
if (!report.startsWith('doctor: every')) process.stdout.write(report);
