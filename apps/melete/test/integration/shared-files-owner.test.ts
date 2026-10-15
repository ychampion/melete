/**
 * In a shared space, the agent working for a member adds new files to the
 * space's Files, and changes, moves or deletes only the ones that member's
 * own work added and nobody has changed since. Everything else there is the
 * owner's to change. The owner's agent is unrestricted, and a person's own
 * space is as it was.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CapabilityClaims, JsonObject } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { defaultBudget, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;
const SCOPES = [
  'files.write',
  'files.read',
  'files.list',
  'files.move',
  'files.delete',
  'files.restore',
];
const made: string[] = [];

afterAll(async () => {
  await fixture?.close();
  const base = await realpath(tmpdir());
  for (const root of made)
    if (path.dirname(root) === base) await rm(root, { recursive: true, force: true });
}, 30_000);

async function folders() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'melete-shared-files-'));
  made.push(root);
  return { workRoot: path.join(root, 'work'), spacesRoot: path.join(root, 'spaces') };
}

/** What became of one step: done, or refused with the words the agent hears. */
type Outcome = { status: string; refusal?: string };

function runner(
  broker: BrokerService,
  claims: CapabilityClaims,
  connectionId: string,
  decider?: string,
) {
  return async (kind: string, payload: JsonObject): Promise<Outcome> => {
    let proposal: Awaited<ReturnType<BrokerService['propose']>>;
    try {
      proposal = await broker.propose(claims, { kind, connection_id: connectionId, payload });
    } catch (error) {
      return { status: 'refused', refusal: (error as Error).message };
    }
    if (proposal.status !== 'needs_approval') return { status: proposal.status };
    // The person the request asks agrees, as they would on its card.
    await broker.decide(
      proposal.action_id,
      { decision: 'approved', payload_hash: proposal.payload_hash },
      undefined,
      decider,
    );
    try {
      await broker.admit(claims, proposal.action_id, proposal.payload_hash);
    } catch (error) {
      return { status: 'refused', refusal: (error as Error).message };
    }
    const dispatched = await broker.dispatch(proposal.action_id);
    if (dispatched.status === 'succeeded') return { status: 'succeeded' };
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const [row] = await fixture.sql`select status, receipt, reconciliation from action
      where id = ${proposal.action_id}`;
    return {
      status: String(row?.status ?? dispatched.status),
      refusal: JSON.stringify({ receipt: row?.receipt, reconciliation: row?.reconciliation }),
    };
  };
}

/**
 * A shared space with its owner, a member and the room's own principal, the
 * space's Files connection as a shared space gets it (for the room's
 * requests), and a way to make a request of the room's agent as one of them.
 */
async function sharedSpace() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const tag = recordId('x').slice(2).toLowerCase();
  const person = async (name: string, kind: 'person' | 'room') => {
    const id = recordId('prn');
    await sql`insert into principal (id, email, kind) values (${id}, ${`${name}-${tag}@example.test`}, ${kind})`;
    return id;
  };
  const owner = await person('owner', 'person');
  const member = await person('member', 'person');
  const room = await person('room', 'room');
  const spaceId = recordId('sp');
  await sql`insert into space (id, name, kind, owner_principal_id, audience, git_path)
    values (${spaceId}, 'Household', 'shared', ${owner}, 'space', ${`spaces/${spaceId}`})`;
  await sql`insert into space_membership (principal_id, space_id, role)
    values (${owner}, ${spaceId}, 'owner'), (${member}, ${spaceId}, 'member'),
      (${room}, ${spaceId}, 'agent')`;
  const connectionId = recordId('conn');
  await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
    values (${connectionId}, ${spaceId}, 'files', 'Files', ${JSON.stringify(SCOPES)}::jsonb, 'room')`;
  const { workRoot, spacesRoot } = await folders();
  await mkdir(path.join(spacesRoot, spaceId, 'artifacts'), { recursive: true });
  const registry = new ConnectorRegistry().register(
    connectionId,
    createFilesConnector({ workRoot, spacesRoot, sql }),
  );
  const broker = new BrokerService({ sql, connectors: registry });
  /** A new request of the room's agent, asked by `asker`. */
  const request = async (asker: string) => {
    const jobId = recordId('job');
    const attemptId = recordId('att');
    await sql`insert into job (id, space_id, principal_id, title, objective, state, lease_epoch,
        budget, constraints, audience, requested_by_principal_id)
      values (${jobId}, ${spaceId}, ${room}, 'Request', 'Tidy the shared files', 'running', 1,
        ${JSON.stringify(defaultBudget)}::jsonb,
        ${JSON.stringify({ public_compartment: false, allowed_domains: [] })}::jsonb, 'room', ${asker})`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model,
        principal_id, membership_generation)
      values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted', ${room}, 0)`;
    await mkdir(path.join(workRoot, jobId), { recursive: true });
    const claims: CapabilityClaims = {
      job_id: jobId,
      attempt_id: attemptId,
      space_id: spaceId,
      epoch: 1,
      revision: 0,
      scopes: SCOPES,
      principal_id: room,
      membership_generation: 0,
      budget: {
        max_actions: defaultBudget.max_actions,
        max_output_tokens: defaultBudget.max_output_tokens,
        max_usd_est: defaultBudget.max_usd_est,
      },
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    /** Proposed and agreed to now, run only when `go` is called. */
    const later = async (kind: string, payload: JsonObject) => {
      const proposal = await broker.propose(claims, { kind, connection_id: connectionId, payload });
      if (proposal.status === 'needs_approval')
        await broker.decide(
          proposal.action_id,
          { decision: 'approved', payload_hash: proposal.payload_hash },
          undefined,
          asker,
        );
      return {
        proposed: proposal.status,
        go: async (): Promise<string> => {
          try {
            await broker.admit(claims, proposal.action_id, proposal.payload_hash);
          } catch {
            return 'refused';
          }
          return (await broker.dispatch(proposal.action_id)).status;
        },
      };
    };
    return {
      jobId,
      later,
      run: runner(broker, claims, connectionId, asker),
      work: (name: string) => path.join(workRoot, jobId, name),
    };
  };
  const files = (...names: string[]) => path.join(spacesRoot, spaceId, 'artifacts', ...names);
  return { sql, owner, member, request, files };
}

const text = (file: string) => readFile(file, 'utf8');

databaseTest(
  "a member's agent cannot save over, move or delete a file someone else added",
  async () => {
    const space = await sharedSpace();
    const owners = await space.request(space.owner);
    // The owner's agent saves the house rules into the space's Files.
    expect(
      (
        await owners.run('files.write', {
          path: 'house/rules.md',
          area: 'artifacts',
          content: 'quiet after ten',
        })
      ).status,
    ).toBe('succeeded');
    // And one the owner put there themselves.
    await writeFile(space.files('budget.csv'), 'rent,1200');
    const members = await space.request(space.member);

    const overwrite = await members.run('files.write', {
      path: 'house/rules.md',
      area: 'artifacts',
      content: 'parties every night',
    });
    expect(overwrite.status).toBe('refused');
    expect(overwrite.refusal).toContain("only the space's owner");
    expect(overwrite.refusal).toContain('new file');
    expect(await text(space.files('house', 'rules.md'))).toBe('quiet after ten');

    const moved = await members.run('files.move', {
      from: 'budget.csv',
      to: 'old/budget.csv',
      area: 'artifacts',
    });
    expect(moved.status).toBe('refused');
    expect(moved.refusal).toContain("only the space's owner");
    const takenOut = await members.run('files.move', {
      from: 'house/rules.md',
      to: 'rules.md',
      area: 'artifacts',
      to_area: 'work',
    });
    expect(takenOut.status).toBe('refused');
    expect(await text(space.files('budget.csv'))).toBe('rent,1200');
    expect(await text(space.files('house', 'rules.md'))).toBe('quiet after ten');
    expect(existsSync(space.files('old', 'budget.csv'))).toBe(false);
    expect(existsSync(members.work('rules.md'))).toBe(false);

    const deleted = await members.run('files.delete', { path: 'budget.csv', area: 'artifacts' });
    expect(deleted.status).toBe('refused');
    expect(deleted.refusal).toContain("only the space's owner");
    const folder = await members.run('files.delete', { path: 'house', area: 'artifacts' });
    expect(folder.status).toBe('refused');
    expect(await text(space.files('budget.csv'))).toBe('rent,1200');
    expect(await text(space.files('house', 'rules.md'))).toBe('quiet after ten');
  },
  SLOW,
);

databaseTest(
  "a member's agent adds new files, and changes the ones the member's own chats added",
  async () => {
    const space = await sharedSpace();
    const first = await space.request(space.member);
    // A brand-new file: allowed.
    expect(
      (
        await first.run('files.write', {
          path: 'trip/plan.md',
          area: 'artifacts',
          content: 'day one',
        })
      ).status,
    ).toBe('succeeded');
    expect(await text(space.files('trip', 'plan.md'))).toBe('day one');
    // Moved in from the member's own workspace, as a new file: allowed.
    await writeFile(first.work('packing.md'), 'socks');
    expect(
      (
        await first.run('files.move', {
          from: 'packing.md',
          to: 'trip/packing.md',
          to_area: 'artifacts',
        })
      ).status,
    ).toBe('succeeded');

    // Another of the same member's chats changes, renames and deletes them.
    const later = await space.request(space.member);
    expect(
      (
        await later.run('files.write', {
          path: 'trip/plan.md',
          area: 'artifacts',
          content: 'day one, day two',
        })
      ).status,
    ).toBe('succeeded');
    expect(await text(space.files('trip', 'plan.md'))).toBe('day one, day two');
    // Saved over again: still the member's own.
    expect(
      (
        await later.run('files.write', {
          path: 'trip/plan.md',
          area: 'artifacts',
          content: 'day one, day two, day three',
        })
      ).status,
    ).toBe('succeeded');
    expect(
      (
        await later.run('files.move', {
          from: 'trip/plan.md',
          to: 'trip/itinerary.md',
          area: 'artifacts',
        })
      ).status,
    ).toBe('succeeded');
    expect(await text(space.files('trip', 'itinerary.md'))).toBe('day one, day two, day three');
    expect(
      (await later.run('files.delete', { path: 'trip/packing.md', area: 'artifacts' })).status,
    ).toBe('succeeded');
    expect(existsSync(space.files('trip', 'packing.md'))).toBe(false);

    // Once the owner has changed it, it is no longer the member's to change.
    await writeFile(space.files('trip', 'itinerary.md'), "the owner's version");
    const after = await later.run('files.write', {
      path: 'trip/itinerary.md',
      area: 'artifacts',
      content: 'mine again',
    });
    expect(after.status).toBe('refused');
    expect(await text(space.files('trip', 'itinerary.md'))).toBe("the owner's version");
    // Saving the owner's exact words over it does not make it the member's again.
    const copied = await later.run('files.write', {
      path: 'trip/itinerary.md',
      area: 'artifacts',
      content: "the owner's version",
    });
    expect(copied.status).not.toBe('succeeded');
    expect(
      (await later.run('files.delete', { path: 'trip/itinerary.md', area: 'artifacts' })).status,
    ).toBe('refused');
    expect(await text(space.files('trip', 'itinerary.md'))).toBe("the owner's version");
    // Another member's file is not theirs either.
    const second = await space.sql`insert into principal (id, email, kind)
      values (${recordId('prn')}, ${`second-${recordId('x').toLowerCase()}@example.test`}, 'person')
      returning id`;
    const other = String(second[0]?.id);
    const [{ space_id } = { space_id: '' }] = await space.sql`select space_id from job
      where id = ${later.jobId}`;
    await space.sql`insert into space_membership (principal_id, space_id, role)
      values (${other}, ${space_id}, 'member')`;
    const others = await space.request(other);
    expect(
      (await others.run('files.delete', { path: 'trip/itinerary.md', area: 'artifacts' })).status,
    ).toBe('refused');
    expect(await text(space.files('trip', 'itinerary.md'))).toBe("the owner's version");
  },
  SLOW,
);

databaseTest(
  "what the owner does after a member's step was agreed to still stops it when it runs",
  async () => {
    const space = await sharedSpace();
    const members = await space.request(space.member);
    for (const name of ['a.md', 'b.md', 'c.md'])
      expect(
        (await members.run('files.write', { path: name, area: 'artifacts', content: name })).status,
      ).toBe('succeeded');
    // Each agreed to, in another of the member's requests, while the files were
    // the member's own or the name was free.
    const again = await space.request(space.member);
    const save = await again.later('files.write', {
      path: 'a.md',
      area: 'artifacts',
      content: 'member again',
    });
    const move = await again.later('files.move', { from: 'b.md', to: 'd.md', area: 'artifacts' });
    const remove = await again.later('files.delete', { path: 'c.md', area: 'artifacts' });
    const fresh = await again.later('files.write', {
      path: 'e.md',
      area: 'artifacts',
      content: 'member new',
    });
    // Then the owner saves their own versions, and a file at the free name.
    for (const name of ['a.md', 'b.md', 'c.md', 'e.md'])
      await writeFile(space.files(name), `owner ${name}`);
    for (const step of [save, move, remove, fresh]) {
      expect(step.proposed).toBe('needs_approval');
      expect(await step.go()).not.toBe('succeeded');
    }
    for (const name of ['a.md', 'b.md', 'c.md', 'e.md'])
      expect(await text(space.files(name))).toBe(`owner ${name}`);
    expect(existsSync(space.files('d.md'))).toBe(false);
  },
  SLOW,
);

databaseTest(
  "the owner's agent changes, moves and deletes any file in the space's Files",
  async () => {
    const space = await sharedSpace();
    const members = await space.request(space.member);
    expect(
      (
        await members.run('files.write', {
          path: 'notes.md',
          area: 'artifacts',
          content: "the member's notes",
        })
      ).status,
    ).toBe('succeeded');
    await writeFile(space.files('lease.pdf'), 'lease');
    const owners = await space.request(space.owner);
    expect(
      (
        await owners.run('files.write', {
          path: 'notes.md',
          area: 'artifacts',
          content: 'edited by the owner',
        })
      ).status,
    ).toBe('succeeded');
    expect(await text(space.files('notes.md'))).toBe('edited by the owner');
    expect(
      (
        await owners.run('files.move', {
          from: 'lease.pdf',
          to: 'papers/lease.pdf',
          area: 'artifacts',
        })
      ).status,
    ).toBe('succeeded');
    expect(await text(space.files('papers', 'lease.pdf'))).toBe('lease');
    expect((await owners.run('files.delete', { path: 'notes.md', area: 'artifacts' })).status).toBe(
      'succeeded',
    );
    expect(existsSync(space.files('notes.md'))).toBe(false);
  },
  SLOW,
);

databaseTest(
  "in a person's own space, saving over, moving and deleting their files is as before",
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { sql } = fixture;
    const seed = await seedJob(sql, { scopes: SCOPES, provider: 'files' });
    const { workRoot, spacesRoot } = await folders();
    const files = (name: string) => path.join(spacesRoot, seed.claims.space_id, 'artifacts', name);
    await mkdir(path.join(workRoot, seed.claims.job_id), { recursive: true });
    await mkdir(path.dirname(files('x')), { recursive: true });
    const registry = new ConnectorRegistry().register(
      seed.connectionId,
      createFilesConnector({ workRoot, spacesRoot, sql }),
    );
    const broker = new BrokerService({ sql, connectors: registry });
    const run = runner(broker, seed.claims, seed.connectionId);
    await writeFile(files('report.md'), 'theirs');
    await writeFile(files('photo.txt'), 'photo');
    expect(
      (await run('files.write', { path: 'report.md', area: 'artifacts', content: 'edited' }))
        .status,
    ).toBe('succeeded');
    expect(await text(files('report.md'))).toBe('edited');
    expect(
      (await run('files.move', { from: 'photo.txt', to: 'kept.txt', area: 'artifacts' })).status,
    ).toBe('succeeded');
    expect(await text(files('kept.txt'))).toBe('photo');
    expect((await run('files.delete', { path: 'report.md', area: 'artifacts' })).status).toBe(
      'succeeded',
    );
    expect(existsSync(files('report.md'))).toBe(false);
    // A new file saved unasked is still made only as a new file.
    expect(
      (await run('files.write', { path: 'fresh.md', area: 'artifacts', content: 'new' })).status,
    ).toBe('succeeded');
    expect(await text(files('fresh.md'))).toBe('new');
  },
  SLOW,
);
