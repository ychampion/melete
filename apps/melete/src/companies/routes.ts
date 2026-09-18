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
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { mayUseSpaceConnections } from '../api/connections.ts';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
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

/**
 * Reading a space's mailbox takes the same authority as connecting it.
 *
 * A scan reads through a connection somebody installed with their own account,
 * and writes what it finds — companies, items, and the stored message bodies —
 * stamped with the principal who asked. In a shared space that meant any member
 * could scan a mailbox another member connected and end up holding their mail
 * as private rows. Space membership is the wrong question to ask about somebody
 * else's account; `mayUseSpaceConnections` is the question the installer had to
 * answer, so it is the one asked here.
 *
 * Reading a map that already exists is not this. That is ordinary row
 * ownership, and it is already exact.
 */
async function requireMailboxAuthority(db: Database, spaceId: string): Promise<void> {
  const access = await spaceAuthority(db, spaceId, requestPrincipal());
  if (!mayUseSpaceConnections(access))
    throw new ServiceError(
      'scope_denied',
      'Scanning this mailbox requires the owner of an owner-audience space.',
      403,
    );
}

/** The spaces a principal may speak for: personal ones they own, shared ones they joined. */
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
    const found = await deps.store.item(owner, id);
    if (found) return { ...found, owner };
  }
  throw new ServiceError('not_found', 'Not found.', 404);
}

export function mountCompanies(app: Hono, deps: CompaniesDeps) {
  const handler = deps.handler ?? stubLedgerItemHandler();
  const now = deps.now ?? (() => new Date());
  const schedule =
    deps.schedule ??
    ((work: () => Promise<void>) => {
      void work().catch(() => process.stderr.write('companies scan failed\n'));
    });

  app.post('/spaces/:spaceId/companies/scan', async (c) => {
    const owner = await ownerFor(deps.db, c.req.param('spaceId'));
    await requireMailboxAuthority(deps.db, owner.spaceId);
    // One scan at a time. Asking again while one runs hands back the one that is
    // running, so a doubled click does not read the mailbox twice.
    const running = await deps.store.runningScan(owner);
    if (running) return c.json({ scan_id: running.id, status: 'running' as const }, 200);
    const mailbox = await deps.mailbox(owner);
    if (!mailbox)
      throw new ServiceError('not_connected', 'No mailbox is connected to this space.', 409);
    const record = await deps.store.openScan(owner);
    await schedule(async () => {
      await runScan({
        store: deps.store,
        mailbox,
        extractor: deps.extractor,
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
    const map = await deps.store.map(owner, now());
    // A dropped item is one the person has said is not a thing. It stays in the
    // store, so a re-scan does not offer it again, but it is off the map.
    // A settled one stays: finishing with a company is worth seeing.
    //
    // The four fields are named rather than spread. `companyMap` and
    // `companyMapTotals` are both strict, so one extra key on whatever the
    // store returns would throw on every map request — and this shape has
    // carried extra fields before, when the promise totals lived beside the
    // contract rather than in it. Naming them means a field added to the store
    // cannot reach `parse` by accident; somebody has to add it here on purpose.
    return c.json(
      companyMapContract.parse({
        companies: map.companies,
        items: map.items.filter((item) => item.status !== 'dropped'),
        totals: map.totals,
        currency: map.currency,
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
    const found = await findItem(deps, c.req.param('id'), c.req.query('space_id'));
    // Handling an item twice would write to a company twice. An item that
    // already names a job is already being handled, so the job it names is the
    // answer and the playbook is not asked again — the same rule the rest of
    // the product follows about never saying the same thing twice.
    if (found.item.job_id) return c.json({ job_id: found.item.job_id }, 200);
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
    await deps.store.setJob(found.owner, found.item.id, result.job_id);
    return c.json({ job_id: result.job_id }, 201);
  });
}
