/**
 * In a shared space, the agent working for a member adds new files to the
 * space's Files, and changes, moves or deletes only the ones that member's
 * own work added and nobody has changed since. Everything else there is the
 * owner's to change. The owner's agent is unrestricted, and a person's own
 * space is as it was.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CapabilityClaims, JsonObject } from '@melete/contracts';
import { createArtifactRecorder } from '../../src/artifact/record.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createArtifactsConnector } from '../../src/connectors/artifacts.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import {
  createTranscriptionConnector,
  fakeTranscriptionAdapter,
} from '../../src/connectors/transcribe.ts';
import { createCapabilityConnector, fakeSpeechAdapter } from '../../src/connectors/tts.ts';
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
  'artifact.publish',
  'audio.synthesize',
  'audio.transcribe',
];
const made: string[] = [];

/**
 * The publish, speech and transcription connections a space can have beside
 * its Files, registered on `registry` for `spaceId`, serving `sharedUse`.
 */
async function otherConnections(
  sql: NonNullable<typeof fixture>['sql'],
  registry: ConnectorRegistry,
  spaceId: string,
  roots: { workRoot: string; spacesRoot: string },
  sharedUse: 'owner' | 'room',
) {
  const ids = { publish: recordId('conn'), speech: recordId('conn'), transcribe: recordId('conn') };
  for (const [id, provider] of [
    [ids.publish, 'artifacts'],
    [ids.speech, 'generation'],
    [ids.transcribe, 'generation'],
  ] as const)
    await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
      values (${id}, ${spaceId}, ${provider}, 'Fixture', ${JSON.stringify(SCOPES)}::jsonb, ${sharedUse})`;
  registry
    .register(ids.publish, createArtifactsConnector({ sql, ...roots }))
    .register(
      ids.speech,
      createCapabilityConnector({
        sql,
        spacesRoot: roots.spacesRoot,
        adapter: fakeSpeechAdapter,
        provider: 'fake',
      }),
    )
    .register(
      ids.transcribe,
      createTranscriptionConnector({
        sql,
        ...roots,
        adapter: fakeTranscriptionAdapter,
        provider: 'fake',
      }),
    );
  return ids;
}

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
  return async (kind: string, payload: JsonObject, connection = connectionId): Promise<Outcome> => {
    let proposal: Awaited<ReturnType<BrokerService['propose']>>;
    try {
      proposal = await broker.propose(claims, { kind, connection_id: connection, payload });
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
  const others = await otherConnections(sql, registry, spaceId, { workRoot, spacesRoot }, 'room');
  const broker = new BrokerService({
    sql,
    connectors: registry,
    recordArtifact: createArtifactRecorder(undefined, { workRoot, spacesRoot }),
    estimateSpend: () => 0,
  });
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
    const later = async (kind: string, payload: JsonObject, connection = connectionId) => {
      const proposal = await broker.propose(claims, { kind, connection_id: connection, payload });
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
  return { sql, owner, member, request, files, others };
}

const text = (file: string) => readFile(file, 'utf8');

/**
 * The moment between a step's check of `file` and the change it makes: the
 * first time a handle on that file reaches `method` (just after a whole read,
 * or just before it is emptied to be written), `meanwhile` starts and is given
 * `ms` to finish before the step carries on. A step that holds the space's
 * Files for itself until it is done makes `meanwhile` wait instead.
 */
async function meanwhileAt(
  file: string,
  method: 'readFile' | 'truncate',
  meanwhile: () => Promise<unknown>,
  ms = 2500,
) {
  const { ino } = await stat(file);
  const probe = await open(file, 'r');
  const handles = Object.getPrototypeOf(probe) as Record<
    string,
    (this: FileHandle, ...args: unknown[]) => Promise<unknown>
  >;
  await probe.close();
  const original = handles[method] as (this: FileHandle, ...args: unknown[]) => Promise<unknown>;
  let started: Promise<unknown> | null = null;
  const pause = async (handle: FileHandle) => {
    if (started || (await handle.stat()).ino !== ino) return;
    started = meanwhile();
    await Promise.race([started.catch(() => {}), Bun.sleep(ms)]);
  };
  handles[method] = async function (this: FileHandle, ...args: unknown[]) {
    if (method === 'truncate') await pause(this);
    const result = await original.apply(this, args);
    if (method === 'readFile') await pause(this);
    return result;
  };
  return async () => {
    handles[method] = original;
    return started;
  };
}

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
  "a member's save over their own file never overwrites what the owner saved there while it ran",
  async () => {
    const space = await sharedSpace();
    const members = await space.request(space.member);
    expect(
      (await members.run('files.write', { path: 'notes.md', area: 'artifacts', content: 'mine' }))
        .status,
    ).toBe('succeeded');
    const again = await space.request(space.member);
    const save = await again.later('files.write', {
      path: 'notes.md',
      area: 'artifacts',
      content: 'mine again',
    });
    const owners = await space.request(space.owner);
    // Once the member's save has found the file still theirs, and before it
    // writes, the owner's agent saves over the same file.
    const done = await meanwhileAt(space.files('notes.md'), 'truncate', () =>
      owners.run('files.write', { path: 'notes.md', area: 'artifacts', content: "owner's" }),
    );
    let saved: string;
    let owner: Outcome | undefined;
    try {
      saved = await save.go();
    } finally {
      owner = (await await done()) as Outcome | undefined;
    }
    expect(owner?.status).toBe('succeeded');
    expect(saved).toBe('succeeded');
    // The member's save went over their own file, then the owner's over it:
    // the owner's is what the space keeps.
    expect(await text(space.files('notes.md'))).toBe("owner's");
  },
  SLOW,
);

databaseTest(
  "a member's move of their own file never takes what the owner saved at its name while it ran",
  async () => {
    const space = await sharedSpace();
    const members = await space.request(space.member);
    expect(
      (await members.run('files.write', { path: 'notes.md', area: 'artifacts', content: 'mine' }))
        .status,
    ).toBe('succeeded');
    const again = await space.request(space.member);
    const takeOut = await again.later('files.move', {
      from: 'notes.md',
      to: 'notes.md',
      area: 'artifacts',
      to_area: 'work',
    });
    const owners = await space.request(space.owner);
    // Once the member's move has read the file and found it theirs, and
    // before it moves it, the owner's agent saves over the same file.
    const done = await meanwhileAt(space.files('notes.md'), 'readFile', () =>
      owners.run('files.write', { path: 'notes.md', area: 'artifacts', content: "owner's" }),
    );
    let moved: string;
    let owner: Outcome | undefined;
    try {
      moved = await takeOut.go();
    } finally {
      owner = (await await done()) as Outcome | undefined;
    }
    expect(owner?.status).toBe('succeeded');
    expect(moved).toBe('succeeded');
    // The member took out their own file, and the owner's then went in at its
    // name: the owner's stays in the space's Files and never reaches the
    // member's workspace.
    expect(await text(again.work('notes.md'))).toBe('mine');
    expect(await text(space.files('notes.md'))).toBe("owner's");
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

    // An owner the room's maker added changes anything there too.
    const [added] = await space.sql`insert into principal (id, email, kind)
      values (${recordId('prn')}, ${`co-owner-${recordId('x').toLowerCase()}@example.test`}, 'person')
      returning id`;
    const coOwner = String(added?.id);
    const [{ space_id } = { space_id: '' }] = await space.sql`select space_id from job
      where id = ${owners.jobId}`;
    await space.sql`insert into space_membership (principal_id, space_id, role)
      values (${coOwner}, ${space_id}, 'owner')`;
    const coOwners = await space.request(coOwner);
    expect(
      (await coOwners.run('files.delete', { path: 'papers/lease.pdf', area: 'artifacts' })).status,
    ).toBe('succeeded');
    expect(existsSync(space.files('papers', 'lease.pdf'))).toBe(false);
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

const TEXT = { kind: 'text', render: false };

databaseTest(
  "a member's agent publishes, reads aloud and transcribes into the space's Files only under new names",
  async () => {
    const space = await sharedSpace();
    await writeFile(space.files('report.txt'), "the owner's report");
    await writeFile(space.files('notes.md'), "the owner's notes");
    await writeFile(space.files('song.wav'), "the owner's song");
    const members = await space.request(space.member);
    expect(
      (
        await members.run('files.write', {
          path: 'report.txt',
          content: "the member's draft",
          expect: TEXT,
        })
      ).status,
    ).toBe('succeeded');

    const destinations: JsonObject[] = [
      { kind: 'space_artifacts' },
      { kind: 'space_artifacts', path: 'report.txt' },
    ];
    for (const destination of destinations) {
      const published = await members.run(
        'artifact.publish',
        { path: 'report.txt', destination },
        space.others.publish,
      );
      expect(published.status).toBe('refused');
      expect(published.refusal).toContain("only the space's owner");
      expect(published.refusal).toContain('new name');
    }
    expect(await text(space.files('report.txt'))).toBe("the owner's report");
    const fresh = await members.run(
      'artifact.publish',
      { path: 'report.txt', destination: { kind: 'space_artifacts', path: 'member-report.txt' } },
      space.others.publish,
    );
    expect(fresh.status).toBe('succeeded');
    expect(await text(space.files('member-report.txt'))).toBe("the member's draft");

    const spoken = await members.run(
      'audio.synthesize',
      { script: 'parties every night', path: 'song' },
      space.others.speech,
    );
    expect(spoken.status).toBe('refused');
    expect(spoken.refusal).toContain("only the space's owner");
    expect(await text(space.files('song.wav'))).toBe("the owner's song");
    expect(
      (
        await members.run(
          'audio.synthesize',
          { script: 'A: quiet after ten', path: 'member-song' },
          space.others.speech,
        )
      ).status,
    ).toBe('succeeded');
    expect(existsSync(space.files('member-song.wav'))).toBe(true);

    const heard = await members.run(
      'audio.transcribe',
      { source: 'member-song.wav', area: 'artifacts', path: 'notes' },
      space.others.transcribe,
    );
    expect(heard.status).toBe('refused');
    expect(heard.refusal).toContain("only the space's owner");
    expect(await text(space.files('notes.md'))).toBe("the owner's notes");
    expect(
      (
        await members.run(
          'audio.transcribe',
          { source: 'member-song.wav', area: 'artifacts', path: 'member-notes' },
          space.others.transcribe,
        )
      ).status,
    ).toBe('succeeded');
    expect(await text(space.files('member-notes.md'))).toContain('quiet after ten');
  },
  SLOW,
);

databaseTest(
  "a file someone else puts at the name after a member's publish or audio was agreed to is never replaced",
  async () => {
    const space = await sharedSpace();
    const members = await space.request(space.member);
    await members.run('files.write', { path: 'draft.txt', content: 'member draft', expect: TEXT });
    await members.run('audio.synthesize', { script: 'hello', path: 'source' }, space.others.speech);
    const steps = [
      await members.later(
        'artifact.publish',
        { path: 'draft.txt', destination: { kind: 'space_artifacts', path: 'late.txt' } },
        space.others.publish,
      ),
      await members.later(
        'audio.synthesize',
        { script: 'late', path: 'late-song' },
        space.others.speech,
      ),
      await members.later(
        'audio.transcribe',
        { source: 'source.wav', area: 'artifacts', path: 'late-notes' },
        space.others.transcribe,
      ),
    ];
    for (const name of ['late.txt', 'late-song.wav', 'late-notes.md'])
      await writeFile(space.files(name), `owner ${name}`);
    for (const step of steps) expect(await step.go()).not.toBe('succeeded');
    for (const name of ['late.txt', 'late-song.wav', 'late-notes.md'])
      expect(await text(space.files(name))).toBe(`owner ${name}`);
  },
  SLOW,
);

databaseTest(
  "a member's agent deletes a folder only when every folder in it holds files the member's work added",
  async () => {
    const space = await sharedSpace();
    // An empty folder the owner made, and an empty one the owner made inside the member's.
    await mkdir(space.files('empty'), { recursive: true });
    const members = await space.request(space.member);
    for (const name of ['mixed/a.md', 'mine/b.md', 'mine/deep/c.md'])
      expect(
        (await members.run('files.write', { path: name, area: 'artifacts', content: name })).status,
      ).toBe('succeeded');
    await mkdir(space.files('mixed', 'owners'), { recursive: true });

    const empty = await members.run('files.delete', { path: 'empty', area: 'artifacts' });
    expect(empty.status).toBe('refused');
    expect(empty.refusal).toContain("only the space's owner");
    expect(existsSync(space.files('empty'))).toBe(true);
    const mixed = await members.run('files.delete', { path: 'mixed', area: 'artifacts' });
    expect(mixed.status).toBe('refused');
    expect(existsSync(space.files('mixed', 'owners'))).toBe(true);
    expect(await text(space.files('mixed', 'a.md'))).toBe('mixed/a.md');
    // The member's own, every folder in it holding their files.
    expect((await members.run('files.delete', { path: 'mine', area: 'artifacts' })).status).toBe(
      'succeeded',
    );
    expect(existsSync(space.files('mine'))).toBe(false);
    // The owner's agent deletes any of them.
    const owners = await space.request(space.owner);
    expect((await owners.run('files.delete', { path: 'empty', area: 'artifacts' })).status).toBe(
      'succeeded',
    );
  },
  SLOW,
);

databaseTest(
  "in a person's own space, an approved publish and audio save over a file as before",
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { sql } = fixture;
    const seed = await seedJob(sql, { scopes: SCOPES, provider: 'files' });
    const roots = await folders();
    const files = (name: string) =>
      path.join(roots.spacesRoot, seed.claims.space_id, 'artifacts', name);
    await mkdir(path.join(roots.workRoot, seed.claims.job_id), { recursive: true });
    await mkdir(path.dirname(files('x')), { recursive: true });
    const registry = new ConnectorRegistry().register(
      seed.connectionId,
      createFilesConnector({ ...roots, sql }),
    );
    const others = await otherConnections(sql, registry, seed.claims.space_id, roots, 'owner');
    const broker = new BrokerService({
      sql,
      connectors: registry,
      recordArtifact: createArtifactRecorder(undefined, roots),
      estimateSpend: () => 0,
    });
    const run = runner(broker, seed.claims, seed.connectionId);
    await writeFile(files('letter.txt'), 'their letter');
    await writeFile(files('hello.wav'), 'their recording');
    await run('files.write', { path: 'letter.txt', content: 'the new letter', expect: TEXT });
    const published = await run(
      'artifact.publish',
      { path: 'letter.txt', destination: { kind: 'space_artifacts' } },
      others.publish,
    );
    expect(published.status).toBe('succeeded');
    expect(await text(files('letter.txt'))).toBe('the new letter');
    expect(
      (await run('audio.synthesize', { script: 'hello', path: 'hello' }, others.speech)).status,
    ).toBe('succeeded');
    expect(await text(files('hello.wav'))).not.toBe('their recording');
  },
  SLOW,
);
