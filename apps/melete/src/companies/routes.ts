/**
 * The company map's HTTP surface.
 *
 * Two shapes of route, and the difference is deliberate. The map is addressed
 * by space, because a person may have more than one and the scan belongs to
 * whichever one the mailbox is connected to. A ledger item is addressed by its
 * own id, because that is the link a person follows from a figure, and an id
 * that is not theirs is not found — never forbidden, which would confirm it
 * exists.
 *
 * Authority comes from the session and nothing else. The space in the path is
 * checked against the authenticated principal before any row is read, and every
 * query underneath carries both the space and the principal.
 */

import {
  companyMap as companyMapContract,
  ledgerItem as ledgerItemContract,
} from '@melete/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { experienceProfile } from '../db/schema.ts';
import { requestPrincipal, spaceAuthority } from '../principals/authority.ts';
import type { CompanyExtractor } from './extract.ts';
import { HandlerUnavailable, type LedgerItemHandler, stubLedgerItemHandler } from './handler.ts';
import type { ScanMailbox } from './mailbox.ts';
import type { CompanyStore, LedgerDetail, Owner } from './repository.ts';
import { runScan } from './scan.ts';

export const ledgerStatusChange = z.strictObject({ status: z.enum(['dropped', 'settled']) });

export type CompaniesDeps = {
  db: Database;
  store: CompanyStore;
  /** The mailbox for a space, or nothing when that space has no mail connected. */
  mailbox: (owner: Owner) => Promise<ScanMailbox | null> | ScanMailbox | null;
  extractor: CompanyExtractor;
  /** How an item is handled. The stub refuses when no job service was built. */
  handler?: LedgerItemHandler;
  /**
   * The mail connection a message for this space would go out on, when one is
   * connected. Absent, the job still runs and still drafts, but nothing leaves.
   */
  sendConnection?: (owner: Owner) => Promise<string | null> | string | null;
  /**
   * How the scan runs once the route has answered. The default detaches it, so
   * the person gets a scan id straight away; a test passes one that runs the
   * work to completion first.
   */
  schedule?: (work: () => Promise<void>) => void | Promise<void>;
  now?: () => Date;
  /** Model calls one person's scans may make in a day. Left out, there is no daily limit. */
  dailyCalls?: number;
};

/**
 * The space in the path, resolved to the principal who may speak for it.
 *
 * In the assembled service this rarely decides anything: `mountPrincipals`
 * installs one guard over every `/spaces/:id/...` path, and it has already
 * refused a space the caller cannot see with `scope_denied` and 403 before any
 * route here runs. That is the answer the whole API gives for a space, so the
 * map gives it too rather than inventing a second convention for one surface.
 *
 * This stays because a route should not depend for its authority on middleware
 * mounted somewhere else, and `createApp` can be assembled without that guard.
 *
 * A ledger item is deliberately different. It is addressed by its own id,
 * outside `/spaces`, so the guard never sees it and `findItem` answers 404: an
 * id that is not yours must not be distinguishable from one that never existed.
 */
async function ownerFor(db: Database, spaceId: string): Promise<Owner> {
  const access = await spaceAuthority(db, spaceId, requestPrincipal());
  if (!access.principalId) throw new ServiceError('not_found', 'No such space.', 404);
  return { spaceId, principalId: access.principalId };
}

/** The spaces a principal may speak for: personal ones they own, shared ones they joined. */
/** The time zone the person keeps in the space's profile; UTC until they set one. */
async function profileTimeZone(db: Database, spaceId: string): Promise<string> {
  const [row] = await db
    .select({ timeZone: experienceProfile.timeZone })
    .from(experienceProfile)
    .where(eq(experienceProfile.spaceId, spaceId));
  return row?.timeZone ?? 'UTC';
}

async function visibleSpaceIds(db: Database, principalId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`select s.id from space s
    where (s.kind = 'personal' and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
       or (s.kind = 'shared' and exists (select 1 from space_membership m
            where m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null))
    order by s.id`);
  return [...rows].map((row) => String(row.id));
}

/**
 * An item, looked up inside the caller's own rows only. A `space_id` query
 * narrows the search when a person has more than one space; without it the
 * spaces the caller can see are tried in turn, and nothing else is.
 */
async function findItem(
  deps: CompaniesDeps,
  id: string,
  spaceHint?: string,
  store: CompanyStore = deps.store,
): Promise<LedgerDetail & { owner: Owner }> {
  const owners: Owner[] = [];
  if (spaceHint) owners.push(await ownerFor(deps.db, spaceHint));
  else {
    const principalId = requestPrincipal();
    if (principalId)
      for (const spaceId of await visibleSpaceIds(deps.db, principalId))
        owners.push({ spaceId, principalId });
  }
  for (const owner of owners) {
    const found = await store.item(owner, id);
    if (found) return { ...found, owner };
  }
  throw new ServiceError('not_found', 'Not found.', 404);
}

/**
 * Work that must see the result of the last request for the same thing before
 * it decides anything. A check followed by a write is only as good as the gap
 * between them, and a doubled click lands in that gap.
 *
 * The store holds the key for the whole section, across every process that
 * shares its database. In front of that, a queue per key keeps a second request
 * in this process from holding a database connection while it waits, and at
 * most a few sections run at once, so the connections the work itself needs,
 * such as creating a job, are always there to be had.
 */
const SECTIONS_AT_ONCE = 4;
function sections(store: CompanyStore) {
  const tails = new Map<string, Promise<unknown>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= SECTIONS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
  return async <T>(key: string, work: (store: CompanyStore) => Promise<T>): Promise<T> => {
    const section = () => bounded(() => store.exclusive(key, work));
    const run = (tails.get(key) ?? Promise.resolve()).then(section, section);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function mountCompanies(app: Hono, deps: CompaniesDeps) {
  const exclusively = sections(deps.store);
  const handler = deps.handler ?? stubLedgerItemHandler();
  const now = deps.now ?? (() => new Date());
  const schedule =
    deps.schedule ??
    ((work: () => Promise<void>) => {
      void work().catch(() => process.stderr.write('companies scan failed\n'));
    });

  app.post('/spaces/:spaceId/companies/scan', async (c) => {
    const owner = await ownerFor(deps.db, c.req.param('spaceId'));
    // One scan at a time. Asking again while one runs hands back the one that is
    // running, so a doubled click does not read the mailbox twice. The check and
    // the opening happen in one turn, so a second click cannot land between them.
    const opened = await exclusively(
      `scan:${owner.spaceId}:${owner.principalId}`,
      async (store) => {
        const running = await store.runningScan(owner);
        if (running) return { running, started: null };
        const mailbox = await deps.mailbox(owner);
        if (!mailbox)
          throw new ServiceError('not_connected', 'No mailbox is connected to this space.', 409);
        return { running: null, started: { mailbox, record: await store.openScan(owner) } };
      },
    );
    if (!opened.started)
      return c.json({ scan_id: opened.running.id, status: 'running' as const }, 200);
    const { mailbox, record } = opened.started;
    await schedule(async () => {
      await runScan({
        store: deps.store,
        mailbox,
        extractor: deps.extractor,
        ...(deps.dailyCalls === undefined ? {} : { dailyCalls: deps.dailyCalls }),
        owner,
        now: now(),
        scan: record,
      });
    });
    return c.json({ scan_id: record.id, status: 'running' as const }, 202);
  });

  app.get('/spaces/:spaceId/companies/scan/:scanId', async (c) => {
    const owner = await ownerFor(deps.db, c.req.param('spaceId'));
    const record = await deps.store.scan(owner, c.req.param('scanId'));
    if (!record) throw new ServiceError('not_found', 'No such scan.', 404);
    return c.json({
      status: record.status,
      messages_seen: record.messagesSeen,
      items_found: record.itemsFound,
      ...(record.error ? { error: record.error } : {}),
    });
  });

  app.get('/spaces/:spaceId/companies', async (c) => {
    const owner = await ownerFor(deps.db, c.req.param('spaceId'));
    const map = await deps.store.map(owner, now(), await profileTimeZone(deps.db, owner.spaceId));
    // A dropped item is one the person has said is not a thing. It stays in the
    // store, so a re-scan does not offer it again, but it is off the map.
    // A settled one stays: finishing with a company is worth seeing.
    return c.json(
      companyMapContract.parse({
        ...map,
        items: map.items.filter((item) => item.status !== 'dropped'),
      }),
    );
  });

  app.get('/ledger/:id', async (c) => {
    const found = await findItem(deps, c.req.param('id'), c.req.query('space_id'));
    return c.json({
      item: ledgerItemContract.parse(found.item),
      company: found.company,
      message: found.message,
    });
  });

  app.patch('/ledger/:id', async (c) => {
    const change = ledgerStatusChange.parse(await c.req.json());
    const found = await findItem(deps, c.req.param('id'), c.req.query('space_id'));
    const updated = await deps.store.setStatus(found.owner, found.item.id, change.status);
    if (!updated) throw new ServiceError('not_found', 'Not found.', 404);
    return c.json(ledgerItemContract.parse(updated));
  });

  app.post('/ledger/:id/handle', async (c) => {
    const id = c.req.param('id');
    // A second press waits for the first, then reads the item it left behind.
    const answer = await exclusively(`ledger:${id}`, async (store) => {
      const found = await findItem(deps, id, c.req.query('space_id'), store);
      // Handling an item twice would write to a company twice. An item that
      // already names a job is already being handled, so the job it names is the
      // answer and the playbook is not asked again — the same rule the rest of
      // the product follows about never saying the same thing twice.
      if (found.item.job_id) return { job_id: found.item.job_id, status: 200 as const };
      // Which mailbox the message would leave from is the installation's to decide,
      // not the caller's: it is looked up from the space the item was found in.
      const connectionId = (await deps.sendConnection?.(found.owner)) ?? null;
      let result: Awaited<ReturnType<LedgerItemHandler['handleLedgerItem']>>;
      try {
        result = await handler.handleLedgerItem({
          item: found.item,
          company: found.company,
          messageText: found.message?.text ?? null,
          principalId: found.owner.principalId,
          spaceId: found.owner.spaceId,
          ...(connectionId ? { connectionId } : {}),
        });
      } catch (error) {
        if (error instanceof HandlerUnavailable)
          throw new ServiceError('not_connected', error.message, 503);
        throw error;
      }
      await store.setJob(found.owner, found.item.id, result.job_id);
      return { job_id: result.job_id, status: 201 as const };
    });
    return c.json({ job_id: answer.job_id }, answer.status);
  });
}
