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
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { requestPrincipal, spaceAuthority } from '../principals/authority.ts';
import type { CompanyExtractor } from './extract.ts';
import { HandlerUnavailable, type LedgerItemHandler, stubLedgerItemHandler } from './handle.ts';
import type { ScanMailbox } from './mailbox.ts';
import { type CompanyStore, contractMap, type LedgerDetail, type Owner } from './repository.ts';
import { runScan } from './scan.ts';

export const ledgerStatusChange = z.strictObject({ status: z.enum(['dropped', 'settled']) });

export type CompaniesDeps = {
  db: Database;
  store: CompanyStore;
  /** The mailbox for a space, or nothing when that space has no mail connected. */
  mailbox: (owner: Owner) => Promise<ScanMailbox | null> | ScanMailbox | null;
  extractor: CompanyExtractor;
  /** The playbooks lane's implementation. The stub refuses until it is wired. */
  handler?: LedgerItemHandler;
  /**
   * How the scan runs once the route has answered. The default detaches it, so
   * the person gets a scan id straight away; a test passes one that runs the
   * work to completion first.
   */
  schedule?: (work: () => Promise<void>) => void | Promise<void>;
  now?: () => Date;
};

/** The space in the path, checked against the session. Anything else is not found. */
async function ownerFor(db: Database, spaceId: string): Promise<Owner> {
  try {
    const access = await spaceAuthority(db, spaceId, requestPrincipal());
    if (!access.principalId) throw new ServiceError('not_found', 'No such space.', 404);
    return { spaceId, principalId: access.principalId };
  } catch {
    // A space somebody cannot see is a space that is not there, as far as they know.
    throw new ServiceError('not_found', 'No such space.', 404);
  }
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
    return c.json(companyMapContract.parse(contractMap(map)));
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
    let result: Awaited<ReturnType<LedgerItemHandler['handleLedgerItem']>>;
    try {
      result = await handler.handleLedgerItem({
        item: found.item,
        company: found.company,
        messageText: found.message?.text ?? null,
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
