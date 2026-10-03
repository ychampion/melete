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
  type ActionStatus,
  awaitedReply as awaitedReplyContract,
  type CompanyMap,
  companyMap as companyMapContract,
  type LedgerItem,
  type LedgerItemAction,
  type LedgerSyncResult,
  ledgerHandleRequest,
  ledgerHandleResult,
  ledgerItem as ledgerItemContract,
  ledgerSyncResult,
  type WaitingOn,
  waitingOn as waitingOnContract,
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
import { publishedActionDigest } from './published.ts';
import type { CompanyStore, LedgerDetail, Owner, ScanRecord } from './repository.ts';
import { runScan } from './scan.ts';
import { waitingOnView } from './waiting-view.ts';

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
   * Cancel the job chasing an item. A job that has already finished has
   * nothing left to cancel, and that is not an error here.
   */
  cancelJob?: (jobId: string, reason: string) => Promise<void>;
  /**
   * How the scan runs once the route has answered. The default detaches it, so
   * the person gets a scan id straight away; a test passes one that runs the
   * work to completion first.
   */
  schedule?: (work: () => Promise<void>) => void | Promise<void>;
  now?: () => Date;
  /** Model calls one person's scans may make in a day. Left out, there is no daily limit. */
  dailyCalls?: number;
  /**
   * Connections that publish items into the ledger. Absent, reading a feed and
   * acting on a published item are not connected.
   */
  feeds?: {
    /** Read one connection's feed now, as `actor`, and write what it admits. */
    sync(connectionId: string, actor: string | null): Promise<LedgerSyncResult>;
    /** The action chosen on a published item, checked against its installation now. */
    action(
      item: LedgerItem,
      actionId: string,
    ): Promise<{ action: LedgerItemAction; toolName: string; label: string }>;
    /**
     * Taking that action: one call to the declared tool with the item's stored
     * input, proposed to the broker as an owner command. Absent, steps are not
     * connected.
     */
    step?: {
      /** Start the command's job. Nothing is proposed yet. */
      start(input: PublishedStep & { itemId: string }): Promise<string>;
      /** Propose the call under that job; answers where the call stands. */
      run(jobId: string, input: PublishedStep): Promise<ActionStatus>;
      /** End a job whose call will not be proposed. */
      abandon(jobId: string, reason: string): Promise<void>;
    };
  };
};

/** One step on a published item, as the route hands it on. */
export type PublishedStep = {
  spaceId: string;
  principalId: string;
  connectionId: string;
  action: LedgerItemAction;
  toolName: string;
  /** The connection's label. */
  label: string;
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

/** What a scan that stopped at the day's allowance says about the messages it left. */
export const SCAN_ALLOWANCE_NOTE = 'Some messages will be read on your next scan tomorrow.';

/** One scan as its person sees it. The note is additive: a scan that read everything has none. */
export function scanView(record: ScanRecord) {
  return {
    status: record.status,
    messages_seen: record.messagesSeen,
    items_found: record.itemsFound,
    ...(record.error ? { error: record.error } : {}),
    ...((record.counts.daily_allowance_reached ?? 0) > 0 ? { note: SCAN_ALLOWANCE_NOTE } : {}),
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
        timeZone: await profileTimeZone(deps.db, owner.spaceId),
      });
    });
    return c.json({ scan_id: record.id, status: 'running' as const }, 202);
  });

  app.get('/spaces/:spaceId/companies/scan/:scanId', async (c) => {
    const owner = await ownerFor(deps.db, c.req.param('spaceId'));
    const record = await deps.store.scan(owner, c.req.param('scanId'));
    if (!record) throw new ServiceError('not_found', 'No such scan.', 404);
    return c.json(scanView(record));
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

  // Stopping hands the item back: the chase ends, and it can be handled again later.
  // It runs in the same section as Handle it, so a stop and a press never interleave.
  app.post('/ledger/:id/stop', async (c) => {
    const id = c.req.param('id');
    const released = await exclusively(`ledger:${id}`, async (store) => {
      const found = await findItem(deps, id, c.req.query('space_id'), store);
      if (found.item.status === 'settled' || found.item.status === 'dropped')
        throw new ServiceError('not_handling', 'This item is already closed.', 409);
      if (found.item.job_id) {
        if (!deps.cancelJob)
          throw new ServiceError('not_connected', 'Stopping is not connected yet.', 503);
        await deps.cancelJob(found.item.job_id, 'The owner stopped handling this item.');
      }
      return store.release(found.owner, found.item.id);
    });
    if (!released) throw new ServiceError('not_found', 'Not found.', 404);
    return c.json(ledgerItemContract.parse(released));
  });

  app.post('/ledger/:id/handle', async (c) => {
    const id = c.req.param('id');
    // The body names the step to take on an item a connection published, as
    // it was shown; a playbook item takes none.
    const text = await c.req.text();
    const request = ledgerHandleRequest.parse(text.trim() ? JSON.parse(text) : {});
    // A second press waits for the first, then reads the item it left behind.
    const answer = await exclusively(`ledger:${id}`, async (store) => {
      const found = await findItem(deps, id, c.req.query('space_id'), store);
      // Handling an item twice would write to a company twice. An item that
      // already names a job is already being handled, so the job it names is the
      // answer and the playbook is not asked again — the same rule the rest of
      // the product follows about never saying the same thing twice.
      if (found.item.job_id) return { job_id: found.item.job_id, status: 200 as const };
      if (found.item.source) {
        // A published item is acted on through one of the steps its connection
        // offers, the one the person was shown, and only while the
        // installation still declares and grants its tool. The step runs as
        // one brokered call with the stored input; no model is asked anything.
        const step = deps.feeds?.step;
        if (!deps.feeds || !step)
          throw new ServiceError('not_connected', 'Handling is not connected yet.', 503);
        if (found.item.status === 'settled' || found.item.status === 'dropped')
          throw new ServiceError('already_terminal', 'This one is already finished.', 409);
        if (!request.action || !request.digest)
          throw new ServiceError(
            'choose_action',
            'Choose one of the steps this item offers, as it was shown to you.',
            400,
          );
        const chosen = await deps.feeds.action(found.item, request.action);
        if (publishedActionDigest(chosen.action) !== request.digest)
          throw new ServiceError(
            'action_changed',
            'This step changed after it was shown. Look at it again before running it.',
            409,
          );
        const published: PublishedStep = {
          spaceId: found.owner.spaceId,
          principalId: found.owner.principalId,
          connectionId: found.item.source.connection_id,
          action: chosen.action,
          toolName: chosen.toolName,
          label: chosen.label,
        };
        const jobId = await step.start({ ...published, itemId: found.item.id });
        if (!(await store.setJob(found.owner, found.item.id, jobId))) {
          await step.abandon(jobId, 'The item closed before the step was taken.');
          throw new ServiceError('already_terminal', 'This one is already finished.', 409);
        }
        return { job_id: jobId, status: 201 as const, published };
      }
      if (request.action || request.digest)
        throw new ServiceError('invalid_request', 'This item offers no such step.', 400);
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
    // The step's call is proposed once the item names its job, outside the
    // section: a call may take as long as its connection does, and the item
    // is already marked as being handled, so a second press finds this job.
    if ('published' in answer && answer.published && deps.feeds?.step) {
      const status = await deps.feeds.step.run(answer.job_id, answer.published);
      return c.json(
        ledgerHandleResult.parse({ job_id: answer.job_id, action_status: status }),
        answer.status,
      );
    }
    return c.json({ job_id: answer.job_id }, answer.status);
  });

  // Read a connection's ledger feed now, rather than at the next scheduled read.
  // Only the owner of the connection's space may; anyone else is told it is not there.
  app.post('/connections/:id/ledger/sync', async (c) => {
    if (!deps.feeds)
      throw new ServiceError('not_connected', 'Ledger feeds are not connected.', 503);
    // Only a signed-in person asks for a read; the service's own reads never come through here.
    const actor = requestPrincipal();
    if (!actor) throw new ServiceError('not_found', 'Not found.', 404);
    const result = await deps.feeds.sync(c.req.param('id'), actor);
    return c.json(ledgerSyncResult.parse(result));
  });

  /**
   * The spaces a request speaks for: the one named, or every space the
   * principal can see. The first is the one whose mailbox and scan are reported.
   */
  const ownersOf = async (spaceHint?: string): Promise<Owner[]> => {
    if (spaceHint) return [await ownerFor(deps.db, spaceHint)];
    const principalId = requestPrincipal();
    if (!principalId) throw new ServiceError('not_found', 'No such space.', 404);
    return (await visibleSpaceIds(deps.db, principalId)).map((spaceId) => ({
      spaceId,
      principalId,
    }));
  };

  // What the person is waiting on: money companies owe them and replies nobody
  // has sent, with the few to chase first. Read-only; it never starts a scan.
  // The scan it reports is the first space's, and it names that space, so a
  // client that starts a scan starts it where this route will look for it.
  app.get('/waiting-on', async (c) => {
    const owners = await ownersOf(c.req.query('space_id'));
    const at = now();
    const maps: CompanyMap[] = [];
    const replies: Awaited<ReturnType<CompanyStore['awaitedReplies']>> = [];
    for (const owner of owners) {
      maps.push(await deps.store.map(owner, at, await profileTimeZone(deps.db, owner.spaceId)));
      replies.push(...(await deps.store.awaitedReplies(owner, at)));
    }
    const first = owners[0];
    const latest = first ? await deps.store.latestScan(first) : null;
    const mailbox = first ? await deps.mailbox(first) : null;
    const scan: WaitingOn['scan'] = {
      space_id: first?.spaceId ?? null,
      connected: mailbox !== null,
      status: latest?.status ?? 'none',
      finished_at: latest?.finishedAt ?? null,
      // A scan that finished without reading a Sent folder this mailbox can
      // read found no replies to wait on; one more scan finds them.
      stale:
        latest?.status === 'done' &&
        typeof mailbox?.sent === 'function' &&
        latest.counts.awaited_replies === undefined &&
        latest.counts.sent_unreadable === undefined,
    };
    return c.json(waitingOnContract.parse(waitingOnView({ maps, replies, scan })));
  });

  // Dismiss a reply: the person is not waiting on it any more. A chase that has
  // it is stopped first, and a later scan does not bring it back.
  app.post('/waiting-on/replies/:id/drop', async (c) => {
    const id = c.req.param('id');
    const owners = await ownersOf(c.req.query('space_id'));
    const dropped = await exclusively(`awaited:${id}`, async (store) => {
      for (const owner of owners) {
        const found = await store.awaitedReply(owner, id);
        if (!found) continue;
        const { reply } = found;
        if (reply.job_id && (reply.status === 'handling' || reply.status === 'waiting')) {
          if (!deps.cancelJob)
            throw new ServiceError('not_connected', 'Stopping is not connected yet.', 503);
          await deps.cancelJob(reply.job_id, 'The owner dismissed this reply.');
        }
        return store.dropAwaited(owner, id);
      }
      return null;
    });
    if (!dropped) throw new ServiceError('not_found', 'Not found.', 404);
    return c.json(awaitedReplyContract.parse(dropped));
  });

  // "Chase this" for a reply. Owed items are chased through `/ledger/:id/handle`.
  // Like that route it is idempotent: a reply already being chased answers with
  // its chase, and a second press waits for the first.
  app.post('/waiting-on/replies/:id/chase', async (c) => {
    const id = c.req.param('id');
    const owners = await ownersOf(c.req.query('space_id'));
    const answer = await exclusively(`awaited:${id}`, async (store) => {
      for (const owner of owners) {
        const found = await store.awaitedReply(owner, id);
        if (!found) continue;
        if (found.reply.job_id) return { job_id: found.reply.job_id, status: 200 as const };
        if (!handler.handleAwaitedReply)
          throw new ServiceError('not_connected', 'Chasing is not connected yet.', 503);
        const connectionId = (await deps.sendConnection?.(owner)) ?? null;
        let result: Awaited<ReturnType<NonNullable<LedgerItemHandler['handleAwaitedReply']>>>;
        try {
          result = await handler.handleAwaitedReply({
            reply: found.reply,
            messageText: found.text,
            principalId: owner.principalId,
            spaceId: owner.spaceId,
            ...(connectionId ? { connectionId } : {}),
          });
        } catch (error) {
          if (error instanceof HandlerUnavailable)
            throw new ServiceError('not_connected', error.message, 503);
          throw error;
        }
        await store.setAwaitedJob(owner, id, result.job_id);
        return { job_id: result.job_id, status: 201 as const };
      }
      throw new ServiceError('not_found', 'Not found.', 404);
    });
    return c.json({ job_id: answer.job_id }, answer.status);
  });
}
