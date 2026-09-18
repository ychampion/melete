/**
 * The sites a space is signed in to. One Chromium profile holds the space's cookies, so a "site
 * profile" is a record over that one profile: a registrable domain and when it was last used,
 * never what the person did there. Signing out of a site removes its cookies and storage from
 * the profile and the record with them.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type BrowserSite, browserSiteForgotten, browserSiteList } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../../api/errors.ts';
import { siteOf } from './live-protocol.ts';
import type { BrowserWorkers } from './routes.ts';
import { BrowserFault } from './sessions.ts';

type SiteRow = { domain: string; label: string; last_used: string | Date };

export class BrowserSiteService {
  constructor(
    private readonly sql: Sql,
    private readonly workers: BrowserWorkers,
  ) {}

  /** Recorded when a takeover ends on a site whose cookies the profile now holds. */
  async record(spaceId: string, domain: string): Promise<void> {
    const site = siteOf(domain);
    await this.sql`insert into browser_site_profile (space_id, domain, label)
      values (${spaceId}, ${site}, ${site})
      on conflict (space_id, domain) do update set last_used = now()`;
  }

  async list(spaceId: string, principalId?: string): Promise<BrowserSite[]> {
    await this.owned(spaceId, principalId);
    const rows = await this.sql<SiteRow[]>`select domain, label, last_used
      from browser_site_profile where space_id = ${spaceId}
      order by last_used desc, domain limit 100`;
    return rows.map((row) => ({
      domain: row.domain,
      label: row.label,
      last_used: new Date(row.last_used).toISOString(),
    }));
  }

  /** The record goes only once the worker has cleared the profile, so nothing is lost silently. */
  async forget(spaceId: string, domain: string, principalId?: string) {
    await this.owned(spaceId, principalId);
    const site = siteOf(domain);
    // Only a registrable domain exactly as it was listed: not a sub-host, not a URL, not a port.
    let host: string;
    try {
      host = new URL(`http://${domain}/`).hostname;
    } catch {
      throw new BrowserFault('invalid_domain');
    }
    if (host !== domain.toLowerCase() || site !== host) throw new BrowserFault('invalid_domain');
    const worker = await this.workers.get(spaceId);
    await worker.forgetSite(site);
    await this.sql`delete from browser_site_profile
      where space_id = ${spaceId} and domain = ${site}`;
    return { domain: site, forgotten: true as const };
  }

  /**
   * Everything this space's browser holds, gone: its worker stopped, its Chromium profile removed
   * from the space directory, and its records deleted. Whoever deletes a space calls this before
   * deleting the space row, because a running worker holds the profile open and would write files
   * back under a root the caller believes is already gone. Deleting the space row alone takes the
   * records with it, since they reference the space, but never the profile on disk. Calling it
   * for a space with no worker running and no profile is silent and safe.
   */
  async forgetSpace(spaceId: string): Promise<{ space_id: string; profile: string | null }> {
    await this.workers.release?.(spaceId);
    const root = this.workers.spacesRoot;
    const profile = root === undefined ? null : join(root, spaceId, 'browser');
    if (profile) await rm(profile, { recursive: true, force: true });
    await this.sql`delete from browser_site_profile where space_id = ${spaceId}`;
    return { space_id: spaceId, profile };
  }

  /** Signed-in sites belong to whoever owns the space, even where others may work in it. */
  private async owned(spaceId: string, principalId?: string): Promise<void> {
    if (!principalId) return;
    const [owned] = await this.sql`select 1 from space s where s.id = ${spaceId}
      and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId}`;
    if (!owned) throw new BrowserFault('space_not_found');
  }
}

function refused(error: unknown): never {
  if (error instanceof BrowserFault)
    throw new ServiceError(
      error.reason,
      `The signed-in sites of this space could not be reached: ${error.reason}.`,
      error.reason === 'space_not_found' ? 404 : error.reason === 'invalid_domain' ? 400 : 409,
    );
  throw error;
}

/** Mounted after the existing owner session and same-origin middleware. */
export function mountBrowserSites(app: Hono, sites: BrowserSiteService) {
  app.get('/browser/sites', async (c) => {
    const listed = await sites
      .list(c.get('experienceSpaceId'), c.get('owner').id)
      .catch((error: unknown) => refused(error));
    return c.json(browserSiteList.parse({ sites: listed }));
  });
  app.delete('/browser/sites/:domain', async (c) => {
    const forgotten = await sites
      .forget(c.get('experienceSpaceId'), c.req.param('domain') ?? '', c.get('owner').id)
      .catch((error: unknown) => refused(error));
    return c.json(browserSiteForgotten.parse(forgotten));
  });
}
