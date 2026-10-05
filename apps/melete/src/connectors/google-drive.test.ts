import { afterAll, describe, expect, test } from 'bun:test';
import { ACCOUNT_CATALOG, evaluateWatch, watchPredicate } from '@melete/contracts';
import { documentFields, documentObservation } from '../signals/observations.ts';
import { type DocumentRead, SourceError } from '../signals/types.ts';
import { documentAtRisk } from '../situations/detectors.ts';
import { type AccountGrant, AccountSignIns } from './account-sign-in.ts';
import { type FakeGoogle, startFakeGoogle } from './fixtures/fake-google.ts';
import { GOOGLE_SCOPES, googleProvider } from './google.ts';
import { driveFileId, GoogleDriveConnector } from './google-drive.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';

const fakes: FakeGoogle[] = [];
afterAll(async () => {
  for (const fake of fakes) await fake.stop();
});

async function drive(grant?: string[]) {
  const google = await startFakeGoogle(grant ? { grant } : {});
  fakes.push(google);
  const token = google.accessToken();
  const connector = new GoogleDriveConnector({
    id: 'conn_drive',
    spaceId: 'spc_test',
    base: google.endpoints.drive,
    access: { token: async () => token, renew: async () => token },
  });
  const read = (cursor: string | null, limit = 500) =>
    (
      connector.signals as {
        changes(c: string | null, o: { limit: number }): Promise<DocumentRead>;
      }
    ).changes(cursor, { limit });
  return { google, connector, read };
}

const ID = (n: number) => `file${String(n).padStart(20, '0')}`;

const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe('reading a Drive for what changed', () => {
  test('a first read starts from now; later reads list each changed file once, as it is now', async () => {
    const { google, read } = await drive();
    google.putFile({ id: ID(1), name: 'Old notes' });
    const first = await read(null);
    expect(first.changes).toEqual([]);

    google.putFile({
      id: ID(2),
      name: 'Lease',
      lastModifyingUser: { displayName: 'Sam', me: false },
    });
    google.putFile({ id: ID(2), name: 'Lease (signed)' });
    google.putFile({ id: ID(3), name: 'Budget' });
    google.removeFile(ID(3));
    const second = await read(first.cursor);
    expect(second.complete).toBe(true);
    expect(second.changes.map((c) => [c.file_id, c.removed, c.file?.name ?? null])).toEqual([
      [ID(2), false, 'Lease (signed)'],
      [ID(3), true, null],
    ]);
    // Nothing new since: nothing listed.
    expect((await read(second.cursor)).changes).toEqual([]);
    // Only metadata is asked for.
    const fields = google.driveRequests.map((url) => url.searchParams.get('fields') ?? '').join();
    expect(fields).not.toMatch(/webContentLink|exportLinks|content|description/);
  });

  test('shared drives are read only when asked for', async () => {
    const { google, connector, read } = await drive();
    const start = await read(null);
    const lastChanges = () =>
      google.driveRequests.filter((url) => url.pathname.endsWith('/changes')).at(-1);
    await read(start.cursor);
    expect(lastChanges()?.searchParams.has('includeItemsFromAllDrives')).toBe(false);
    await (
      connector.signals as {
        changes(c: string | null, o: { limit: number; allDrives?: boolean }): Promise<DocumentRead>;
      }
    ).changes(start.cursor, { limit: 10, allDrives: true });
    expect(lastChanges()?.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  test('the Google catalog entry says it covers documents', () => {
    const google = ACCOUNT_CATALOG.find((entry) => entry.id === 'google');
    expect(google?.covers).toContain('documents');
    expect(google?.scopes.map((scope) => scope.scope)).not.toContain(GOOGLE_SCOPES.documents);
  });

  test('a read stopped by its limit resumes where it stopped', async () => {
    const { google, read } = await drive();
    const start = await read(null);
    for (let n = 1; n <= 5; n++) google.putFile({ id: ID(n), name: `File ${n}` });
    const part = await read(start.cursor, 3);
    expect(part.complete).toBe(false);
    expect(part.changes).toHaveLength(3);
    const rest = await read(part.cursor, 3);
    expect(rest.complete).toBe(true);
    expect(rest.changes.map((c) => c.file_id)).toEqual([ID(4), ID(5)]);
  });

  test('a Drive asking for time says how long, and a refused grant is not read as one', async () => {
    const { google, read } = await drive();
    const start = await read(null);
    google.driveFault = { status: 429, retryAfter: 120, times: 1 };
    const slow = await thrown(read(start.cursor));
    expect(slow).toBeInstanceOf(SourceError);
    expect([(slow as SourceError).status, (slow as SourceError).retryAfter]).toEqual([429, 120]);
    // Google also says "slow down" as a 403 with a rate-limit reason.
    google.driveFault = { status: 403, reason: 'userRateLimitExceeded', times: 1 };
    expect(((await thrown(read(start.cursor))) as SourceError).status).toBe(429);
    google.driveFault = { status: 403, reason: 'insufficientPermissions', times: 1 };
    expect(((await thrown(read(start.cursor))) as SourceError).status).toBe(403);
  });

  test('a sign-in without the Drive scope cannot read it', async () => {
    const { read } = await drive(['openid', 'email', GOOGLE_SCOPES.calendar]);
    expect(((await thrown(read(null))) as SourceError).status).toBe(403);
  });

  test('a page token Drive no longer honours starts again from now', async () => {
    const { google, read } = await drive();
    google.putFile({ id: ID(1) });
    const again = await read('999999');
    expect(again.changes).toEqual([]);
    expect(again.cursor).toBe(String(google.driveChanges.length));
  });
});

describe("a deadline's fresh look and the status tool", () => {
  test('the file is read as it is now; a removed or binned file is gone', async () => {
    const { google, connector } = await drive();
    google.putFile({
      id: ID(7),
      name: 'Contract',
      modifiedTime: '2026-10-05T14:00:00.000Z',
      lastModifyingUser: { displayName: 'Ana', me: true },
    });
    const read = await connector.subjects.read({ key: 'document:x', ref: ID(7) });
    expect(read).toMatchObject({
      file_id: ID(7),
      modified_time: '2026-10-05T14:00:00.000Z',
      last_modifier_me: true,
      trashed: false,
    });
    // The fresh look carries no name.
    expect(JSON.stringify(read)).not.toContain('Contract');
    google.putFile({ id: ID(7), trashed: true });
    expect(await connector.subjects.read({ key: 'document:x', ref: ID(7) })).toBe('gone');
    google.removeFile(ID(7));
    expect(await connector.subjects.read({ key: 'document:x', ref: ID(7) })).toBe('gone');
  });

  test('the status tool takes an id or a link, and reads metadata only', async () => {
    const { google, connector } = await drive();
    google.putFile({ id: ID(8), name: 'Offer letter', shared: true });
    const link = `https://docs.google.com/document/d/${ID(8)}/edit?usp=sharing`;
    expect(driveFileId(link)).toBe(ID(8));
    expect(driveFileId(`https://drive.google.com/open?id=${ID(8)}`)).toBe(ID(8));
    expect(driveFileId(`https://example.test/document/d/${ID(8)}/edit`)).toBeNull();
    expect(driveFileId('not a file')).toBeNull();
    const action = {
      ...mailAction('documents.status', { file: link }, 'act_doc'),
      connection_id: 'conn_drive',
    };
    const answer = await connector.execute(action, {
      ...mailContext('act_doc'),
      space_id: 'spc_test',
    });
    expect(answer.outcome).toBe('succeeded');
    if (answer.outcome !== 'succeeded') return;
    expect(answer.receipt.detail).toMatchObject({
      found: true,
      name: 'Offer letter',
      shared: true,
    });
  });

  test('Drive is asked for on its own step, beside what the account already granted', async () => {
    const google = await startFakeGoogle();
    fakes.push(google);
    const grants: AccountGrant[] = [];
    const service = new AccountSignIns<string>('google', {
      publicUrl: 'http://localhost:3000',
      provider: googleProvider(google.client, google.endpoints),
      authorize: async () => 'spc_test',
      install: async (_actor, grant) => {
        grants.push(grant);
        return ['conn'];
      },
      connectionId: (id) => id,
    });
    const approve = async (url: string) =>
      new URL((await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '')
        .searchParams;
    // An ordinary sign-in never asks for Drive, and connects none.
    const first = await service.start('prn_owner', {});
    expect(new URL(first.authorize_url).searchParams.get('scope')).not.toContain('drive');
    await service.complete('prn_owner', await approve(first.authorize_url));
    expect(grants[0]?.documents).toBeUndefined();
    expect(grants[0]?.mail).toBeDefined();
    // The Drive step asks for Drive alone, keeps what was granted, and connects only Drive.
    const step = await service.start('prn_owner', { documents: true });
    const asked = new URL(step.authorize_url).searchParams;
    expect(asked.get('scope')?.split(' ')).toEqual(['openid', 'email', GOOGLE_SCOPES.documents]);
    expect(asked.get('include_granted_scopes')).toBe('true');
    await service.complete('prn_owner', await approve(step.authorize_url));
    expect(grants[1]?.documents?.scopes).toEqual(['documents.status']);
    expect([grants[1]?.mail, grants[1]?.calendar]).toEqual([undefined, undefined]);
  });

  test('a Google sign-in that grants Drive connects it with its one read tool', () => {
    const provider = googleProvider({ clientId: 'c', clientSecret: 's' });
    expect(provider.grants(`openid ${GOOGLE_SCOPES.documents}`).documents).toEqual([
      'documents.status',
    ]);
    expect(provider.grants(`openid ${GOOGLE_SCOPES.calendar}`).documents).toBeUndefined();
    expect(provider.labels('a@example.test').documents).toBe('Google Drive (a@example.test)');
  });
});

describe('a file change as an observation and as deadline state', () => {
  const file = {
    id: ID(9),
    name: 'Contract',
    mime_type: 'application/pdf',
    modified_time: '2026-10-05T14:00:00.000Z',
    modified_by_me_time: null,
    last_modifier_me: false,
    last_modifier: 'Sam',
    shared: true,
    trashed: false,
    version: '4',
    drive_id: null,
  };

  test('the same change read twice has one key; a later change has another', () => {
    const once = documentObservation('conn_d', { file_id: ID(9), removed: false, file }, 'x');
    const twice = documentObservation('conn_d', { file_id: ID(9), removed: false, file }, 'y');
    expect(once.dedup_key).toBe(twice.dedup_key);
    const later = documentObservation(
      'conn_d',
      { file_id: ID(9), removed: false, file: { ...file, version: '5' } },
      'x',
    );
    expect(later.dedup_key).not.toBe(once.dedup_key);
    expect(once.payload).toMatchObject({
      kind: 'document.changed',
      origin: 'external_content',
      name: 'Contract',
      removed: false,
    });
    // Deadline state keeps no name and no editor.
    expect(JSON.stringify(documentFields(file))).not.toMatch(/Contract|Sam/);
  });

  test('a file deadline ends only on the change it names: the person’s own, or a named other’s', () => {
    const since = '2026-10-05T13:00:00.000Z';
    const atRisk = (by: 'me' | 'others', fields: Record<string, unknown>) =>
      evaluateWatch(watchPredicate.parse(documentAtRisk(since, by)), fields, null, {
        now: Date.parse('2026-10-05T14:55:00.000Z'),
      });
    const later = '2026-10-05T14:00:00.000Z';
    const before = { modified_time: '2026-10-05T12:00:00.000Z', last_modifier_me: false };
    // A collaborator's edit after `since`.
    const theirs = { modified_time: later, last_modifier_me: false, modified_by_me_time: null };
    // The person's own edit after `since`.
    const mine = { modified_time: later, last_modifier_me: true, modified_by_me_time: later };
    expect(atRisk('me', theirs)).toBe(true);
    expect(atRisk('me', mine)).toBe(false);
    expect(atRisk('me', {})).toBe(true);
    expect(atRisk('others', before)).toBe(true);
    expect(atRisk('others', mine)).toBe(true);
    expect(atRisk('others', theirs)).toBe(false);
    // Drive did not name who changed it (an anonymous editor, an app): unknown stays at risk.
    expect(atRisk('others', { modified_time: later })).toBe(true);
    expect(atRisk('others', { modified_time: later, last_modifier_me: null })).toBe(true);
  });
});
