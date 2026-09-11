import { afterAll } from 'bun:test';
import { shareTestServer } from './database.ts';

// Keeping server startup outside each suite leaves time for real crash tests.
// WAL/fsync settings stay at Postgres defaults, including in the durability tests.
afterAll(shareTestServer(), 15_000);
