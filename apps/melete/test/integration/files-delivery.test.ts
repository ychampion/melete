/**
 * Putting a file the agent made into the person's own Files, through the
 * broker against a real database, as a hosted chat runs it: an agent that asks
 * before acting and auto-review at its defaults. A new file there is theirs to
 * keep or delete, so it goes without a question; saving over one of theirs
 * still asks.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonObject } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

databaseTest(
  "a file the agent made goes into the person's Files unasked; saving over theirs asks",
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { sql } = fixture;
    const seed = await seedJob(sql, {
      scopes: ['files.write', 'files.read', 'files.move'],
      provider: 'files',
    });
    const roots = await mkdtemp(path.join(tmpdir(), 'melete-files-delivery-'));
    const workRoot = path.join(roots, 'work');
    const spacesRoot = path.join(roots, 'spaces');
    await Bun.write(path.join(workRoot, seed.claims.job_id, '.keep'), '');
    await Bun.write(path.join(spacesRoot, seed.claims.space_id, 'artifacts', '.keep'), '');
    const registry = new ConnectorRegistry().register(
      seed.connectionId,
      createFilesConnector({ workRoot, spacesRoot, sql }),
    );
    const agent = recordId('agent');
    await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${agent}, ${seed.claims.space_id}, 'Agent', 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
    await sql`update job set kind = 'chat', agent_id = ${agent} where id = ${seed.claims.job_id}`;
    const broker = new BrokerService({ sql, connectors: registry, autoReview: { reviewer: null } });
    const propose = (kind: string, payload: JsonObject) =>
      broker.propose(seed.claims, { kind, connection_id: seed.connectionId, payload });
    const work = (name: string) => path.join(workRoot, seed.claims.job_id, name);
    const files = (name: string) => path.join(spacesRoot, seed.claims.space_id, 'artifacts', name);

    // A PDF a command made in the agent's workspace, moved into their Files.
    await writeFile(work('packing-list.pdf'), '%PDF-1.4 list');
    const moved = await propose('files.move', {
      from: 'packing-list.pdf',
      to: 'packing-list.pdf',
      to_area: 'artifacts',
    });
    expect(moved.status).toBe('succeeded');
    expect(await readFile(files('packing-list.pdf'), 'utf8')).toBe('%PDF-1.4 list');

    // Their own file at that name is not replaced without them.
    await writeFile(files('summary.pdf'), 'theirs');
    await writeFile(work('summary.pdf'), 'the agent’s');
    const over = await propose('files.move', {
      from: 'summary.pdf',
      to: 'summary.pdf',
      to_area: 'artifacts',
    });
    expect(over.status).toBe('needs_approval');
    expect(await readFile(files('summary.pdf'), 'utf8')).toBe('theirs');
  },
  30_000,
);
